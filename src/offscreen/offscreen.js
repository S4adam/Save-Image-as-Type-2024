/**
 * @file offscreen.js
 * @description Offscreen DOM environment required by Manifest V3 to access the Canvas
 * API and Web Workers for image encoding. Handles Canvas API and GIF encoding (Web Workers).
 */

import { PATHS, SUPPORTED_FORMATS, CONSTANTS } from '../shared/prefs.js';
const { FILE, GIF: GIF_CONFIG } = CONSTANTS;


// ─── Messaging ────────────────────────────────────────────────────────────────

function notify(message) {
    chrome.runtime.sendMessage({ op: 'notify', target: 'background', message });
}

function download(url, filename, saveAs) {
    chrome.runtime.sendMessage({ op: 'download', target: 'background', url, filename, saveAs });
}

/**
 * Sends a progress update to background.js, to update the action badge.
 * @param {number} percent - 0–100
 */
function reportProgress(percent) {
    chrome.runtime.sendMessage({ op: 'progress', target: 'background', percent });
}

chrome.runtime.onMessage.addListener((message) => {
    const { op, target, filename, src, type, saveAs, maxAnimationSizeMb } = message;

    if (target !== 'offscreen') return false;

    if (op === 'convertType') {
        if (!src?.startsWith('data:')) {
            notify('Unexpected src payload.');
            return false;
        }
        processImage(src, filename, type, saveAs, maxAnimationSizeMb);

    } else if (op === 'revokeBlob') {
        if (message.url?.startsWith('blob:')) {
            URL.revokeObjectURL(message.url);
        }

    } else {
        console.warn(`[offscreen] Unexpected op: '${op}'.`);
    }

    return false;
});


// ─── Image Processing Logic ────────────────────────────────────────────────

/**
 * Routes the image to the correct encoder.
 * @param {string}  src
 * @param {string}  filename
 * @param {string}  type
 * @param {boolean} saveAs
 * @param {number}  maxAnimationSizeMb
 */
async function processImage(src, filename, type, saveAs, maxAnimationSizeMb) {
    const format = SUPPORTED_FORMATS.find(f => f.value.toLowerCase() === type.toLowerCase());

    try {
        if (format?.requiresAnimation) {
            return encodeAnimatedToGIF(src, maxAnimationSizeMb, (dataUrl) =>
                download(dataUrl, filename, saveAs)
            );
        }
        const img = await loadImage(src);
        let resultData;

        switch (format?.value) {
            case 'BMP':
                resultData = await encodeToBMP(img);
                break;
            default:
                // Fallback for native formats (JPG, PNG, WebP)
                resultData = encodeToCanvasFormat(img, format);
        }
        download(resultData, filename, saveAs);

    } catch (error) {
        notify(error.message);
        console.error(error);
    }
}
const loadImage = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for conversion.'));
    img.src = src;
});

/**
 * Renders a static image onto a canvas and returns it as a data URL.
 * @param {HTMLImageElement} img
 * @param {object}           format - Entry from SUPPORTED_FORMATS.
 * @returns {string} Data URL
 */
function encodeToCanvasFormat(img, format) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    const ctx = canvas.getContext('2d');

    if (format?.needsWhiteBackground) {
        ctx.fillStyle = FILE.DEFAULT_BACKGROUND;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL(format?.mimeType ?? 'image/png', 1.0);
}

/**
 * Encodes an image into a 32-bit BMP (BGRA).
 * @param {HTMLImageElement} img
 * @returns {string} Data URL
 */
async function encodeToBMP(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;

    // Using BITMAPV4HEADER (108 bytes) for Alpha support 
    const fileHeaderSize = 14;
    const infoHeaderSize = 108;
    const headerSize = fileHeaderSize + infoHeaderSize;
    const pixelDataSize = data.length;
    const fileSize = headerSize + pixelDataSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // File Header
    view.setUint16(0, 0x4D42, true);
    view.setUint32(2, fileSize, true);
    view.setUint32(10, headerSize, true);

    // BITMAPV4HEADER
    view.setUint32(14, infoHeaderSize, true);
    view.setInt32(18, canvas.width, true);
    view.setInt32(22, -canvas.height, true); // Top-Down
    view.setUint16(26, 1, true);
    view.setUint16(28, 32, true);            // 32 bpp
    view.setUint32(30, 3, true);             // BI_BITFIELDS
    view.setUint32(34, pixelDataSize, true);

    // RGB + Alpha Masks
    view.setUint32(54, 0x00FF0000, true);    // Red mask
    view.setUint32(58, 0x0000FF00, true);    // Green mask
    view.setUint32(62, 0x000000FF, true);    // Blue mask
    view.setUint32(66, 0xFF000000, true);    // Alpha mask
    view.setUint32(70, 0x73524742, true);    // sRGB "BGRs" color space

    // Pixel Data (Top-Down, BGRA)
    let offset = headerSize;
    for (let i = 0; i < data.length; i += 4) {
        view.setUint8(offset++, data[i + 2]); // B
        view.setUint8(offset++, data[i + 1]); // G
        view.setUint8(offset++, data[i]);     // R
        view.setUint8(offset++, data[i + 3]); // A
    }

    const blob = new Blob([buffer], { type: 'image/bmp' });
    return URL.createObjectURL(blob);
}

/**
 * Decodes an animated WebP/APNG via the native ImageDecoder API and
 * re-encodes it as a GIF.
 *
 * @param {string}   src               - base64 Data URL of the source animation.
 * @param {number}   maxAnimationSizeMb - Memory guard passed from background.
 * @param {Function} callback           - Called with the finished GIF blob URL.
 */
async function encodeAnimatedToGIF(src, maxAnimationSizeMb, callback) {
    if (typeof GIF === 'undefined') {
        notify('GIF encoding library failed to load.');
        return;
    }

    try {
        const response = await fetch(src);
        const mimeType = src.slice(src.indexOf(':') + 1, src.indexOf(';'));

        const decoder = new ImageDecoder({ data: response.body, type: mimeType });
        await decoder.tracks.ready;

        const track = decoder.tracks.selectedTrack;
        const firstResult = await decoder.decode({ frameIndex: 0 });
        const firstFrame = firstResult.image;

        const width = firstFrame.displayWidth || firstFrame.codedWidth;
        const height = firstFrame.displayHeight || firstFrame.codedHeight;
        const frameCount = track.frameCount;

        const estimatedMb = Math.round((width * height * 4 * frameCount) / (1024 * 1024));
        const maxMb = (Number.isFinite(maxAnimationSizeMb) && maxAnimationSizeMb > 0)
            ? maxAnimationSizeMb
            : 512;

        if (estimatedMb > maxMb) {
            firstFrame.close();
            decoder.close();
            notify(
                `Animation is too large to convert safely (estimated ${estimatedMb} MB). ` +
                `You can raise the limit in the extension options.`
            );
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const gif = new GIF({
            workers: GIF_CONFIG.WORKERS,
            quality: GIF_CONFIG.QUALITY,
            width: canvas.width,
            height: canvas.height,
            transparent: GIF_CONFIG.TRANSPARENT_INDEX,
            workerScript: chrome.runtime.getURL(PATHS.GIF_WORKER),
        });

        for (let i = 0; i < frameCount; i++) {
            const { image: frame } = await decoder.decode({ frameIndex: i });

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(frame, 0, 0);

            gif.addFrame(ctx.getImageData(0, 0, canvas.width, canvas.height), {
                delay: frame.duration ? Math.round(frame.duration / GIF_CONFIG.UNIT_CONVERSION) : GIF_CONFIG.FALLBACK_DELAY,
                dispose: GIF_CONFIG.DISPOSE_MODE
            });

            frame.close();
        }

        // Progress: only report at 5 % increments to avoid spamming messages.
        let lastReportedPercent = -1;
        gif.on('progress', (p) => {
            const percent = Math.round(p * 100);
            if (percent >= lastReportedPercent + 5) {
                lastReportedPercent = percent;
                reportProgress(percent);
            }
        });

        gif.on('error', (err) => {
            notify(err?.message || 'GIF encoding failed.');
        });

        gif.on('finished', (blob) => {
            const url = URL.createObjectURL(blob);
            callback(url);
        });

        gif.render();

    } catch (error) {
        console.error('[offscreen] Animation decode error:', error);
        notify('Failed to decode image for GIF conversion.');
    }
}
