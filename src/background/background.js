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
        if (id) {
            setProgressBadge(100);
        } else {
            let msg = chrome.i18n.getMessage('errorOnSaving') || 'Download failed';
            if (chrome.runtime.lastError) msg += `:\n${chrome.runtime.lastError.message}`;
            notify(msg);
        }
    });
}

/**
 * Fetches an image from a URL and returns it as a base64 Data URL.
 * @param {string} src - The image URL or existing data URL
 * @returns {Promise<string>} A promise that resolves to the base64 Data URL
 */
async function fetchAsDataURL(src) {
    if (src.startsWith('data:')) return src;
    if (src.startsWith('blob:')) {
        throw new Error('"blob" links are not supported. Try standard saving.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), NET.FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(src, {
            headers: { Accept: 'image/jpeg, image/png, image/gif, image/webp, image/*;q=0.8' },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        const blob = await res.blob();
        if (!blob.size) throw new Error('Fetch failed: empty response');

        if (blob.size > FILE.MAX_SAFE_MB * 1024 * 1024) {
            throw new Error(`Image is too large to convert safely (Max ${FILE.MAX_SAFE_MB}MB).`);
        }

        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        const mimeType = sniffMimeType(bytes) || blob.type || 'image/octet-stream';

        let binary = '';
        const chunk = NET.CHUNK_SIZE;

        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }

        return `data:${mimeType};base64,${btoa(binary)}`;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error(`Fetch timed out after ${NET.FETCH_TIMEOUT_MS / 1000} seconds`);
        throw err;
    }
}

/**
 * Detects image MIME type from magic bytes.
 * Returns null if the signature is unrecognised.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
function sniffMimeType(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';

    return null;
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

        parsed = parsed.replace(/[^\w\u0080-\uffff\-.,@ ]+/g, '');

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

    if (STATE.badgeTimeoutId)
        clearTimeout(STATE.badgeTimeoutId);

    chrome.action.setBadgeBackgroundColor({ color: UI.COLOR_ERROR }).catch(() => { });
    chrome.action.setBadgeText({ text: '!' }).catch(() => { });

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
    if (percent === 0)
        return;

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

    if ('getContexts' in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl],
        });
        if (contexts.length > 0) return;
    } else {
        // fallback for Chrome 109-115
        const matchedClients = await clients.matchAll({ includeUncontrolled: true });
        const exists = matchedClients.some(client => client.url === offscreenUrl);
        if (exists) return;
    }

    if (STATE.creatingOffscreen) {
        await Promise.race([
            STATE.creatingOffscreen,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Offscreen creation timed out')), UI.OFFSCREEN_WAIT_MS)
            )
        ]);
        return;
    }

    try {
        STATE.creatingOffscreen = chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ['BLOBS'],
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
        });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => buildContextMenu());

let menuDebounce = null;
chrome.storage.onChanged.addListener((changes) => {
    if (changes.contextMenuLabels) {
        // Wait before rebuilding
        clearTimeout(menuDebounce);
        menuDebounce = setTimeout(() => {
            buildContextMenu();
        }, 300);
    }
});

// ─── Message Broker ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    const { target, op } = message ?? {};
    if (target !== 'background' || !op) return;

    switch (op) {
        case 'download': {
            const { url, filename, saveAs } = message;

            chrome.downloads.download({ url, filename, saveAs }, (id) => {
                if (url.startsWith('blob:')) {
                    chrome.runtime.sendMessage({ op: 'revokeBlob', target: 'offscreen', url }).catch(() => { });
                }

                OFFSCREEN_QUEUE.current?.resolve();

                if (id) {
                    setProgressBadge(100);
                } else {
                    const lastErr = chrome.runtime.lastError?.message || '';
                    if (!lastErr.toLowerCase().includes('user canceled')) {
                        let msg = chrome.i18n.getMessage('errorOnSaving') || 'Download failed';
                        notify(`${msg}:\n${lastErr}`);
                    }
                }
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

    if (STATE.badgeTimeoutId)
        clearTimeout(STATE.badgeTimeoutId);
    chrome.action.setBadgeBackgroundColor({ color: '#FFC107' }).catch(() => { });
    chrome.action.setBadgeText({ text: '...' }).catch(() => { });

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