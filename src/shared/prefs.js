/**
 * @file prefs.js
 * @description Single source of truth for various configuration values.
 */

export const PATHS = {
    OFFSCREEN_HTML: 'src/offscreen/offscreen.html',
    GIF_WORKER: 'vendor/gif.worker.js',
};

// System-level (not user-configurable)
export const CONSTANTS = {
    NET: {
        FETCH_TIMEOUT_MS: 15_000,
        CHUNK_SIZE: 8192,
    },
    UI: {
        BADGE_DURATION_MS: 3000,
        OFFSCREEN_WAIT_MS: 5000,
        COLOR_ERROR: '#F44336',
        COLOR_SUCCESS: '#4CAF50',
    },
    FILE: {
        MAX_LEN_FALLBACK: 255,
        DEFAULT_NAME: 'image',
        SCREENSHOT_NAME: 'screenshot',
        UNTITLED_NAME: 'Untitled',
        DEFAULT_BACKGROUND: '#FFFFFF',
    },
    GIF: {
        WORKERS: 2,
        QUALITY: 10,
        DISPOSE_MODE: 2,
        FALLBACK_DELAY: 100,
        UNIT_CONVERSION: 1000,
        TRANSPARENT_INDEX: 'rgba(0,0,0,0)',

    }
};

/**
 * The canonical list of supported output formats.
 *
 * @property {string}  value                  - Internal identifier. Used as the context-menu
 *                                              id suffix and the output file extension.
 * @property {string}  icon                   - Short label shown inside the format chip badge.
 * @property {string}  label                  - Human-readable name shown beneath the chip.
 * @property {string}  mimeType               - MIME type produced when encoding to this format.
 * @property {boolean} [requiresAnimation]    - Route to the frame-by-frame animation encoder
 *                                              (animated WebP / APNG → GIF) instead of the
 *                                              static canvas path.
 * @property {boolean} [needsWhiteBackground] - Pre-fill the canvas white before drawing.
 *                                              Required for formats that don't support alpha
 *                                              (e.g. JPEG).
 */
export const SUPPORTED_FORMATS = [
    { value: 'JPG', icon: 'JPG', label: 'JPEG', mimeType: 'image/jpeg', needsWhiteBackground: true },
    { value: 'PNG', icon: 'PNG', label: 'PNG', mimeType: 'image/png' },
    { value: 'WebP', icon: 'WP', label: 'WebP', mimeType: 'image/webp' },
    { value: 'GIF', icon: 'GIF', label: 'GIF', mimeType: 'image/gif', requiresAnimation: true },
    { value: 'BMP', icon: 'BMP', label: 'BMP', mimeType: 'image/bmp' }
];

export const DEFAULT_PREFS = {
    downloadInstantly: false,
    contextMenuLabels: SUPPORTED_FORMATS.map(f => f.value),
    defaultFilename: '',
    enableMaxLength: false,
    maxLength: CONSTANTS.FILE.MAX_LEN_FALLBACK,
    maxAnimationSizeMb: 512,
    subfolder: '',
};

/**
 * Returns user preferences merged with defaults from chrome.storage.sync.
 * @returns {Promise<typeof DEFAULT_PREFS>}
 */
export async function getPrefs() {
    return chrome.storage.sync.get(DEFAULT_PREFS);
}

/**
 * Sanitizes a user-provided subfolder path for chrome.downloads.download().
 * Chrome API allows only paths relative to the browser's default Downloads directory.
 * @param  {string} raw - The raw value from the text input.
 * @returns {string}     Relative path ("my-photos/2024") or "".
 */
export function sanitizeSubfolder(raw) {
    return (raw ?? '')
        .replace(/\\/g, '/')
        .split('/')
        .map(seg => seg
            .replace(/\.\./g, '')
            .replace(/[<>:"|?*\x00-\x1f]/g, '')
            .trim()
        )
        .filter(Boolean)
        .join('/');
}
