/**
 * @file background.js
 * @description Main background Service Worker.
 * Orchestrates menus, network requests, and offscreen image processing.
 */

import { getPrefs, SUPPORTED_FORMATS, PATHS, CONSTANTS, sanitizeSubfolder } from '../shared/prefs.js';
const { NET, UI, FILE } = CONSTANTS;

const STATE = {
    badgeTimeoutId: null,
    creatingOffscreen: null,
    menuBuildPromise: Promise.resolve(),
};

function openOptionsPage() {
    chrome.runtime.openOptionsPage();
}

/**
 * Triggers a native download for direct (no-conversion) paths only.
 *
 * @param {string}  url      - Data URL of the payload.
 * @param {string}  filename - Target filename (may include a relative sub-path).
 * @param {boolean} saveAs   - Whether to show the native Save As dialog.
 */
function download(url, filename, saveAs) {
    chrome.downloads.download({ url, filename, saveAs }, (id) => {
        if (!id) {
            let msg = chrome.i18n.getMessage('errorOnSaving') || 'Download failed';
            if (chrome.runtime.lastError) msg += `:\n${chrome.runtime.lastError.message}`;
            notify(msg);
        }
    });
}

/**
 * Fetches an image from a URL and returns it as a base64 Data URL.
 * @param {string} src
 * @returns {Promise<string>}
 */
async function fetchAsDataURL(src) {
    if (src.startsWith('data:')) return src;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NET.FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(src, {
            headers: { Accept: 'image/jpeg, image/png, image/gif, image/*;q=0.8' },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const blob = await res.blob();
        if (!blob.size) throw new Error('Fetch failed: empty response');

        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = NET.CHUNK_SIZE;

        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }

        return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error(`Fetch timed out after ${NET.FETCH_TIMEOUT_MS / 1000} seconds`);
        throw err;
    }
}

// ─── Filename ─────────────────────────────────────────────────────────────────

/**
 * Constructs a filesystem-compliant download path from the source URL.
 *
 * @param {string}            src   - Original image URL.
 * @param {string}            type  - Target file extension.
 * @param {typeof DEFAULT_PREFS} prefs - Already-fetched prefs.
 * @returns {string}
 */
function buildFilename(src, type, prefs) {
    const rawPrefix = (prefs.defaultFilename ?? '')
        .replace(/[/\\]/g, '')
        .replace(/\.\./g, '')
        .trim();
    const prefix = rawPrefix ? rawPrefix + '_' : '';

    let base = FILE.DEFAULT_NAME;

    if (/googleusercontent\.com\/[0-9a-zA-Z]{30,}/.test(src)) {
        base = FILE.SCREENSHOT_NAME;
    } else if (src.startsWith('blob:') || src.startsWith('data:')) {
        base = FILE.UNTITLED_NAME;
    } else {
        let parsed = src
            .replace(/[?#].*/, '')
            .replace(/.*\//, '')
            .replace(/\+/g, ' ');

        try { parsed = decodeURIComponent(parsed); } catch (_) { /* keep raw */ }

        parsed = parsed.replace(/[\x00-\x7f]+/g, s => s.replace(/[^\w\-.,@ ]+/g, ''));

        while (/\.[^0-9a-z]*\./.test(parsed)) {
            parsed = parsed.replace(/\.[^0-9a-z]*\./g, '.');
        }

        parsed = parsed
            .replace(/\s{2,}/g, ' ')
            .trim()
            .replace(/\.(jpe?g|png|gif|webp|svg)$/gi, '')
            .replace(/[^0-9a-z]+$/i, '')
            .trim();

        if (parsed) base = parsed;
    }

    let name = prefix + base;
    const ext = '.' + type;

    if (prefs.enableMaxLength) {
        let maxLen = parseInt(prefs.maxLength, 10);
        if (isNaN(maxLen) || maxLen < 1) maxLen = FILE.MAX_LEN_FALLBACK;

        if (name.length + ext.length > maxLen) {
            const available = maxLen - ext.length;
            name = available > 0 ? name.substring(0, available).trim() : 'img';
        }
    }

    name = name.replace(/[^0-9a-zA-Z]+$/i, '').trim() || 'image';

    const filename = name + ext;
    const subfolder = sanitizeSubfolder(prefs.subfolder ?? '');

    return subfolder ? `${subfolder}/${filename}` : filename;
}

// ─── Notification / Badge ─────────────────────────────────────────────────────

/**
 * Flashes an error badge and logs to the console.
 * @param {string|{error:string, srcUrl?:string}} msg
 */
function notify(msg) {
    if (msg !== null && typeof msg === 'object') {
        const errorText = msg.error
            ? (chrome.i18n.getMessage(msg.error) || msg.error)
            : 'Unknown error';
        console.error('[Save Image Extension]', errorText, msg.srcUrl ?? '');
    } else {
        console.error('[Save Image Extension]', msg);
    }

    chrome.action.setBadgeBackgroundColor({ color: UI.COLOR_ERROR }).catch(() => { });
    chrome.action.setBadgeText({ text: '!' }).catch(() => { });

    if (STATE.badgeTimeoutId) clearTimeout(STATE.badgeTimeoutId);
    STATE.badgeTimeoutId = setTimeout(() => {
        chrome.action.setBadgeText({ text: '' }).catch(() => { });
    }, UI.BADGE_DURATION_MS);
}

/**
 * Updates the action badge to show GIF encoding progress.
 * @param {number} percent - 0–100
 */
function setProgressBadge(percent) {
    if (percent >= 100) {
        chrome.action.setBadgeText({ text: '' }).catch(() => { });
        return;
    }
    chrome.action.setBadgeBackgroundColor({ color: UI.COLOR_SUCCESS }).catch(() => { });
    chrome.action.setBadgeText({ text: `${percent}%` }).catch(() => { });
}

// ─── Offscreen Document ───────────────────────────────────────────────────────

/**
 * Ensures the offscreen document exists and prevents multiple concurrent creation attempts.
 * @param {string} path - Extension-relative path to the offscreen HTML.
 */
async function setupOffscreenDocument(path) {
    const offscreenUrl = chrome.runtime.getURL(path);

    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl],
        });
        if (contexts.length > 0) return;
    } else {
        const matched = await clients.matchAll({ includeUncontrolled: true });
        if (matched.some(c => c.url === offscreenUrl)) return;
    }

    if (STATE.creatingOffscreen) {
        await Promise.race([
            STATE.creatingOffscreen,
            new Promise(resolve => setTimeout(resolve, UI.OFFSCREEN_WAIT_MS)),
        ]);
        return;
    }

    try {
        STATE.creatingOffscreen = chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ['BLOBS', 'WORKERS'],
            justification: 'Encode image to target format using Canvas API and Web Workers',
        });
        await STATE.creatingOffscreen;
    } catch (err) {
        if (!err.message.includes('Only a single offscreen document may be created')) {
            throw err;
        }
    } finally {
        STATE.creatingOffscreen = null;
    }
}

// ─── Offscreen Job Queue ──────────────────────────────────────────────────────

/**
 * Serial queue for the single offscreen document slot.
 */
const OFFSCREEN_QUEUE = {
    jobs: [],
    running: false,
    /**
     * Resolve / reject callbacks for the job currently in flight.
     * Null when the queue is idle.
     * @type {{ resolve: () => void, reject: (err: Error) => void } | null}
     */
    current: null,
};

/**
 * Adds a job to the queue and starts the drain loop if it is not already running.
 * @param {object} params - Forwarded verbatim as the body of the `convertType` message.
 */
function enqueueOffscreenJob(params) {
    OFFSCREEN_QUEUE.jobs.push(params);
    if (!OFFSCREEN_QUEUE.running) _drainOffscreenQueue();
}


const OFFSCREEN_JOB_TIMEOUT_MS = 120_000;

/**
 * Processes the job queue one entry at a time.
 *
 * Re-entry is blocked by `running`; callers may call this freely.
 * When the queue is empty the offscreen document is closed.
 */
async function _drainOffscreenQueue() {
    if (OFFSCREEN_QUEUE.running) return;
    OFFSCREEN_QUEUE.running = true;

    while (OFFSCREEN_QUEUE.jobs.length > 0) {
        const job = OFFSCREEN_QUEUE.jobs.shift();
        try {
            await setupOffscreenDocument(PATHS.OFFSCREEN_HTML);

            const jobDone = new Promise((resolve, reject) => {
                OFFSCREEN_QUEUE.current = { resolve, reject };
            });
            const timeoutGuard = new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error('Offscreen conversion timed out')),
                    OFFSCREEN_JOB_TIMEOUT_MS,
                )
            );

            // The offscreen listener returns false (no async response), so
            // sendMessage always rejects with "port closed" which is expected.
            chrome.runtime.sendMessage({ op: 'convertType', target: 'offscreen', ...job })
                .catch(() => { });

            await Promise.race([jobDone, timeoutGuard]);

        } catch (err) {
            console.error('[background] Offscreen job failed:', err.message);
        }

        OFFSCREEN_QUEUE.current = null;
    }

    OFFSCREEN_QUEUE.running = false;

    chrome.offscreen.closeDocument().catch(() => { });
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

/**
 * Rebuilds the right-click context menu from current preferences.
 */
function buildContextMenu() {
    STATE.menuBuildPromise = STATE.menuBuildPromise
        .then(async () => {
            await chrome.contextMenus.removeAll();
            const prefs = await getPrefs();

            for (const type of prefs.contextMenuLabels) {
                chrome.contextMenus.create({
                    id: 'save_as_' + type.toLowerCase(),
                    title: chrome.i18n.getMessage('saveAs', [type]) || `Save as ${type}`,
                    type: 'normal',
                    contexts: ['image'],
                });
            }

            if (prefs.contextMenuLabels.length > 0) {
                chrome.contextMenus.create({
                    id: 'sep_1',
                    type: 'separator',
                    contexts: ['image'],
                });
            }

            chrome.contextMenus.create({
                id: 'options',
                title: chrome.i18n.getMessage('openOpt') || 'Options',
                type: 'normal',
                contexts: ['image'],
            });
        })
        .catch(err => {
            console.error('[Save Image Extension] Failed to build context menu:', err);
            STATE.menuBuildPromise = Promise.resolve();
        });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(buildContextMenu);

chrome.storage.onChanged.addListener((changes) => {
    if (changes.contextMenuLabels) {
        buildContextMenu();
    }
});

// ─── Message Broker ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    const { target, op } = message ?? {};
    if (target !== 'background' || !op) return;

    switch (op) {
        case 'download': {
            const { url, filename, saveAs } = message;

            setProgressBadge(100);

            chrome.downloads.download({ url, filename, saveAs }, (id) => {
                if (url.startsWith('blob:')) {
                    chrome.runtime.sendMessage({ op: 'revokeBlob', target: 'offscreen', url })
                        .catch(() => { });
                }

                if (!id) {
                    let msg = chrome.i18n.getMessage('errorOnSaving') || 'Download failed';
                    if (chrome.runtime.lastError) msg += `:\n${chrome.runtime.lastError.message}`;
                    notify(msg);
                }

                OFFSCREEN_QUEUE.current?.resolve();
            });
            break;
        }

        case 'progress': {
            setProgressBadge(message.percent ?? 0);
            break;
        }

        case 'notify': {
            const msg = message.message;
            if (msg?.error) {
                let text = chrome.i18n.getMessage(msg.error) || msg.error;
                if (msg.src) text += '\n' + msg.src;
                notify(text);
            } else {
                notify(msg);
            }

            if (OFFSCREEN_QUEUE.current) {
                OFFSCREEN_QUEUE.current.reject(
                    new Error(typeof msg === 'string' ? msg : (msg?.error ?? 'Conversion failed'))
                );
            } else {
                chrome.offscreen.closeDocument().catch(() => { });
            }
            break;
        }

        default:
            console.warn('[Save Image Extension] Unknown op:', op);
    }
});

// ─── Menu Click Handler ───────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info) => {
    const { menuItemId, mediaType, srcUrl } = info;

    if (menuItemId === 'options') {
        openOptionsPage();
        return;
    }
    if (!menuItemId.startsWith('save_as_')) return;

    if (mediaType !== 'image' || !srcUrl) {
        notify(chrome.i18n.getMessage('errorIsNotImage') || 'Selected item is not an image.');
        return;
    }

    const type = menuItemId.replace('save_as_', '');
    const format = SUPPORTED_FORMATS.find(
        f => f.value.toLowerCase() === type.toLowerCase()
    );
    if (!format) return;

    const prefs = await getPrefs();
    const filename = buildFilename(srcUrl, type, prefs);
    const saveAs = !prefs.downloadInstantly;

    try {
        const dataurl = await fetchAsDataURL(srcUrl);
        const fetchedMime = dataurl.slice(dataurl.indexOf(':') + 1, dataurl.indexOf(';'));

        if (fetchedMime === format.mimeType) {
            download(dataurl, filename, saveAs);
            return;
        }

        enqueueOffscreenJob({
            src: dataurl,
            type,
            filename,
            saveAs,
            maxAnimationSizeMb: prefs.maxAnimationSizeMb,
        });

    } catch (error) {
        notify({ error: error.message, srcUrl });
    }
});
