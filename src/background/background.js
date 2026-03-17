import { getPrefs } from '../shared/prefs.js';

const ALLOWED_TYPES = ['jpg', 'png', 'webp', 'gif'];

let messages;

function openOptionsPage() {
    chrome.runtime.openOptionsPage();
}

async function ensureHostPermission(srcUrl) {
    if (srcUrl.startsWith('data:') || srcUrl.startsWith('blob:')) return true;
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (granted) return true;
    await chrome.tabs.create({
        url: chrome.runtime.getURL('src/permissions/permissions.html')
    });
    return false;
}

async function download(url, filename) {
    notify({ srcUrl: url });
    const prefs = await getPrefs();

    const showSaveDialog = !prefs.downloadInstantly;

    chrome.downloads.download(
        { url, filename: filename, saveAs: showSaveDialog },
        function (downloadId) {
            if (!downloadId) {
                let msg = chrome.i18n.getMessage('errorOnSaving');
                if (chrome.runtime.lastError) {
                    msg += ': \n' + chrome.runtime.lastError.message;
                }
                notify(msg);
            }
        }
    );
}

async function fetchAsDataURL(src) {
    if (src.startsWith('data:')) return src;
    const res = await fetch(src);
    const blob = await res.blob();
    if (!blob.size) throw new Error('Fetch failed: 0 size');
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });
}

async function getSuggestedFilename(src, type) {
    const prefs = await getPrefs();
    let prefix = prefs.defaultFilename ? prefs.defaultFilename.trim() + "_" : "";

    if (src.match(/googleusercontent\.com\/[0-9a-zA-Z]{30,}/)) {
        return prefix + 'screenshot.' + type;
    }
    if (src.startsWith('blob:') || src.startsWith('data:')) {
        return prefix + 'Untitled.' + type;
    }

    let filename = src.replace(/[?#].*/, '').replace(/.*[\/]/, '').replace(/\+/g, ' ');
    try {
        filename = decodeURIComponent(filename);
    } catch (e) {
        // Keep raw filename if percent-encoding is malformed
    }

    filename = filename.replace(/[\x00-\x7f]+/g, function (s) {
        return s.replace(/[^\w\-\.\,@ ]+/g, '');
    });
    while (filename.match(/\.[^0-9a-z]*\./)) {
        filename = filename.replace(/\.[^0-9a-z]*\./g, '.');
    }
    filename = filename.replace(/\s\s+/g, ' ').trim();
    filename = filename.replace(/\.(jpe?g|png|gif|webp|svg)$/gi, '').trim();

    if (prefs.enableMaxLength) {
        let maxLen = parseInt(prefs.maxLength, 10);

        if (isNaN(maxLen) || maxLen < 1) maxLen = 255;

        if (filename.length > maxLen) {
            filename = filename.substr(0, maxLen);
        }
    }
    
    filename = filename.replace(/[^0-9a-z]+$/i, '').trim();
    if (!filename) {
        filename = 'image';
    }

    return prefix + filename + '.' + type;
}

function notify(msg) {
    if (msg.error) {
        msg = (chrome.i18n.getMessage(msg.error) || msg.error) + '\n' + (msg.srcUrl || msg.src);
        console.error(msg);
    }
}

function loadMessages() {
    if (!messages) {
        messages = {};
        ['errorOnSaving', 'errorOnLoading'].forEach(key => {
            messages[key] = chrome.i18n.getMessage(key);
        });
    }
    return messages;
}

async function hasOffscreenDocument(path) {
    const offscreenUrl = chrome.runtime.getURL(path);
    const matchedClients = await clients.matchAll();
    for (const client of matchedClients) {
        if (client.url === offscreenUrl) return true;
    }
    return false;
}

async function buildContextMenu() {
    await chrome.contextMenus.removeAll();
    const prefs = await getPrefs();
    loadMessages();

    prefs.contextMenuLabels.forEach(function (type) {
        chrome.contextMenus.create({
            "id": "save_as_" + type.toLowerCase(),
            "title": chrome.i18n.getMessage("Save_as", [type]),
            "type": "normal",
            "contexts": ["image"],
        });
    });

    chrome.contextMenus.create({ "id": "sep_1", "type": "separator", "contexts": ["image"] });
    chrome.contextMenus.create({
        "id": "options",
        "title": chrome.i18n.getMessage("Open_options"),
        "type": "normal",
        "contexts": ["image"],
    });
}

// Rebuild context menu when extension installs/updates OR when settings change
chrome.runtime.onInstalled.addListener(async (details) => {
    await buildContextMenu();
    if (details.reason === 'install') {
        chrome.tabs.create({
            url: chrome.runtime.getURL('src/permissions/permissions.html')
        });
    }
});
chrome.storage.onChanged.addListener(buildContextMenu);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    let { target, op } = message || {};
    if (target == 'background' && op) {
        if (op == 'download') {
            let { url, filename } = message;
            download(url, filename);
        } else if (op == 'notify') {
            let msg = message.message;
            if (msg && msg.error) {
                let msg2 = chrome.i18n.getMessage(msg.error) || msg.error;
                if (msg.src) msg2 += '\n' + msg.src;
                notify(msg2);
            } else {
                notify(message);
            }
        } else {
            console.warn('unknown op: ' + op);
        }
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    let { menuItemId, mediaType, srcUrl } = info;

    if (menuItemId.startsWith('save_as_')) {
        if (mediaType == 'image' && srcUrl) {
            let type = menuItemId.replace('save_as_', '');

            if (!ALLOWED_TYPES.includes(type)) return;

            let filename = await getSuggestedFilename(srcUrl, type);

            loadMessages();

            const permitted = await ensureHostPermission(srcUrl);
            if (!permitted) return;

            try {
                const dataurl = await fetchAsDataURL(srcUrl);

                let fetchedMime = dataurl.substring(dataurl.indexOf(':') + 1, dataurl.indexOf(';'));
                let targetMime = 'image/' + (type === 'jpg' ? 'jpeg' : type);

                if (fetchedMime === targetMime) {
                    download(dataurl, filename);
                    return;
                }

                const offscreenSrc = 'src/offscreen/offscreen.html';
                if (!(await hasOffscreenDocument(offscreenSrc))) {
                    await chrome.offscreen.createDocument({
                        url: chrome.runtime.getURL(offscreenSrc),
                        reasons: ['DOM_SCRAPING'],
                        justification: 'Download a image for user',
                    });
                }
                await chrome.runtime.sendMessage({ op: 'convertType', target: 'offscreen', src: dataurl, type, filename });
            } catch (error) {
                notify({ error: error.message || String(error), srcUrl });
            }
            return;
        } else {
            notify(chrome.i18n.getMessage("errorIsNotImage"));
        }
        return;
    }
    if (menuItemId == 'options') {
        openOptionsPage();
        return;
    }
});
