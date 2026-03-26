/**
 * @file options.js
 * @description Logic handler for the Options UI.
 * Manages settings persistence and dirty-state tracking.
 */

import { getPrefs, DEFAULT_PREFS, SUPPORTED_FORMATS, CONSTANTS, sanitizeSubfolder } from '../shared/prefs.js';
const { UI: UI_CONST } = CONSTANTS;


// ─── DOM References ──────────────────────────────────────────────────────────

const UI = Object.freeze({
    form: document.getElementById('options-form'),
    btnSave: document.getElementById('btn-save'),
    btnReset: document.getElementById('btn-reset'),
    status: document.getElementById('status'),
    formatGrid: document.getElementById('format-grid'),

    downloadInstantly: document.getElementById('download-instantly'),
    enableMaxLength: document.getElementById('enable-max-length'),
    maxLengthContainer: document.getElementById('max-length-container'),
    maxLength: document.getElementById('max-length'),
    maxLengthDisplay: document.getElementById('max-length-display'),
    maxAnimationSize: document.getElementById('max-animation-size'),
    maxAnimationSizeDisplay: document.getElementById('max-animation-size-display'),

    defaultFilename: document.getElementById('default-filename'),
    subfolder: document.getElementById('subfolder'),
    subfolderHint: document.getElementById('subfolder-hint'),

    /** @returns {NodeListOf<HTMLInputElement>} */
    get contextMenuLabels() {
        return document.querySelectorAll('input[name="context-menu-labels"]');
    },
});

// ─── State Management ──────────────────────────────────────────────────────────

let savedStateSnapshot = '';

/**
 * Serializes the current UI state into a stable, comparable string.
 * @returns {string}
 */
function serializeCurrentState() {
    const selectedFormats = Array.from(UI.contextMenuLabels)
        .filter(cb => cb.checked)
        .map(cb => cb.value)
        .sort()
        .join(',');

    return JSON.stringify({
        downloadInstantly: UI.downloadInstantly.checked,
        contextMenuLabels: selectedFormats,
        defaultFilename: UI.defaultFilename.value.trim(),
        subfolder: UI.subfolder.value.trim(),
        enableMaxLength: UI.enableMaxLength.checked,
        maxLength: parseInt(UI.maxLength.value, 10),
        maxAnimationSizeMb: parseInt(UI.maxAnimationSize.value, 10),
    });
}

/**
 * Serializes a prefs object from storage (same format as serializeCurrentState).
 * @param {object} prefs
 * @returns {string}
 */
function serializePrefs(prefs) {
    const sortedLabels = [...(prefs.contextMenuLabels ?? [])].sort().join(',');
    return JSON.stringify({
        downloadInstantly: prefs.downloadInstantly,
        contextMenuLabels: sortedLabels,
        defaultFilename: (prefs.defaultFilename ?? '').trim(),
        subfolder: (prefs.subfolder ?? '').trim(),
        enableMaxLength: prefs.enableMaxLength,
        maxLength: prefs.maxLength,
        maxAnimationSizeMb: prefs.maxAnimationSizeMb,
    });
}

/**
 * Toggles the Save button based on UI state changes.
 */
function syncSaveButton() {
    const isDirty = serializeCurrentState() !== savedStateSnapshot;
    UI.btnSave.disabled = !isDirty;
}

// ─── Localisation ─────────────────────────────────────────────────────────────

/**
 * Replaces all [data-i18n] element text content with the browser-locale translation.
 */
function localizeHtmlPage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = chrome.i18n.getMessage(key);
        if (msg) el.textContent = msg;
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        const msg = chrome.i18n.getMessage(key);
        if (msg) el.setAttribute('aria-label', msg);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const msg = chrome.i18n.getMessage(key);
        if (msg) el.setAttribute('placeholder', msg);
    });
}

// ─── Status Banner ────────────────────────────────────────────────────────────

let statusTimer = null;

/**
 * Briefly displays a status message in the footer.
 * @param {string}  text
 * @param {'success'|'error'} [type='success']
 */
function showStatus(text, type = 'success') {
    clearTimeout(statusTimer);

    UI.status.textContent = text;
    UI.status.className = `status show${type === 'error' ? ' error' : ''}`;

    statusTimer = setTimeout(() => {
        UI.status.classList.remove('show', 'error');
    }, UI_CONST.BADGE_DURATION_MS);
}

// ─── Max-length Sub-section ───────────────────────────────────────────────────

/**
 * Syncs the enabled/disabled visual state of the slider sub-section
 * to the "Limit filename length" toggle.
 */
function syncMaxLengthSubsection() {
    const enabled = UI.enableMaxLength.checked;
    UI.maxLengthContainer.classList.toggle('disabled', !enabled);
    UI.maxLengthContainer.setAttribute('aria-hidden', String(!enabled));
}

// ─── Subfolder Hint ───────────────────────────────────────────────────────────

/**
 * Updates the hint beneath the subfolder input to preview the resolved path.
 */
function updateSubfolderHint() {
    const sanitized = sanitizeSubfolder(UI.subfolder.value);
    UI.subfolderHint.textContent = sanitized
        ? `Result: ./${sanitized}/<filename>.ext`
        : 'Result: ./<filename>.ext';
}

// ─── Hydrate UI ───────────────────────────────────────────────────────────────

/**
 * Populates every UI control from a prefs object.
 * @param {object} prefs
 */
function hydrateUI(prefs) {
    renderFormatChips(prefs.contextMenuLabels ?? []);
    UI.downloadInstantly.checked = prefs.downloadInstantly;
    UI.defaultFilename.value = prefs.defaultFilename ?? '';
    UI.subfolder.value = prefs.subfolder ?? '';
    UI.enableMaxLength.checked = prefs.enableMaxLength;
    UI.maxLength.value = prefs.maxLength;
    UI.maxLengthDisplay.textContent = prefs.maxLength;
    UI.maxAnimationSize.value = prefs.maxAnimationSizeMb;
    UI.maxAnimationSizeDisplay.textContent = prefs.maxAnimationSizeMb;

    syncMaxLengthSubsection();
    updateSubfolderHint();
}

// ─── Core Actions ─────────────────────────────────────────────────────────────

/**
 * Loads saved preferences from storage, hydrates the UI, 
 * and captures a snapshot of the base state for dirty checking.
 */
async function restoreOptions() {
    localizeHtmlPage();

    const prefs = await getPrefs();
    hydrateUI(prefs);

    savedStateSnapshot = serializePrefs(prefs);
    syncSaveButton();
}

/**
 * Validates the form, persists the current UI state to sync storage, and
 * refreshes the dirty-state base.
 * @param {SubmitEvent} e
 */
async function saveOptions(e) {
    e.preventDefault();

    const selectedLabels = Array.from(UI.contextMenuLabels)
        .filter(cb => cb.checked)
        .map(cb => cb.value);

    if (selectedLabels.length === 0) {
        const msg = chrome.i18n.getMessage('errorNoFormats') || 'Select at least one format.';
        showStatus(msg, 'error');
        return;
    }

    const sanitizedSubfolder = sanitizeSubfolder(UI.subfolder.value);
    UI.subfolder.value = sanitizedSubfolder;
    updateSubfolderHint();

    const prefs = {
        ...DEFAULT_PREFS,
        downloadInstantly: UI.downloadInstantly.checked,
        contextMenuLabels: selectedLabels,
        defaultFilename: UI.defaultFilename.value.trim(),
        subfolder: sanitizedSubfolder,
        enableMaxLength: UI.enableMaxLength.checked,
        maxLength: parseInt(UI.maxLength.value, 10),
        maxAnimationSizeMb: parseInt(UI.maxAnimationSize.value, 10),
    };

    await chrome.storage.sync.set(prefs);

    savedStateSnapshot = serializePrefs(prefs);
    syncSaveButton();

    const msg = chrome.i18n.getMessage('optSavedSuccess') || 'Options saved.';
    showStatus(msg, 'success');
}

/**
 * Resets all UI controls to DEFAULT_PREFS without persisting.
 * User must click SAVE to commit the reset values to storage.
 */
function resetToDefaults() {
    hydrateUI(DEFAULT_PREFS);
    syncSaveButton();
}

/**
 * Renders format chip elements into the grid from SUPPORTED_FORMATS.
 * @param {string[]} savedLabels
 */
function renderFormatChips(savedLabels) {
    const grid = UI.formatGrid;
    if (!grid) return;

    grid.innerHTML = SUPPORTED_FORMATS.map(fmt => {
        const id = `fmt-${fmt.value.toLowerCase()}`;
        const isChecked = savedLabels.includes(fmt.value) ? 'checked' : '';

        return `
            <div class="format-chip">
                <input type="checkbox"
                       name="context-menu-labels"
                       value="${fmt.value}"
                       id="${id}"
                       ${isChecked} />
                <label for="${id}">
                    <span class="chip-icon">${fmt.icon}</span>
                    <span class="chip-name">${fmt.label}</span>
                </label>
            </div>`;
    }).join('');

    // Re-query the NEWLY rendered elements instead of relying on stale references.
    grid.querySelectorAll('input[name="context-menu-labels"]').forEach(cb => {
        cb.addEventListener('change', syncSaveButton);
    });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

UI.form.addEventListener('submit', saveOptions);
UI.btnReset.addEventListener('click', resetToDefaults);

// Sync slider display values
UI.maxLength.addEventListener('input', () => {
    UI.maxLengthDisplay.textContent = UI.maxLength.value;
    syncSaveButton();
});

UI.maxAnimationSize.addEventListener('input', () => {
    UI.maxAnimationSizeDisplay.textContent = UI.maxAnimationSize.value;
    syncSaveButton();
});

// Enable/disable slider sub-section
UI.enableMaxLength.addEventListener('change', () => {
    syncMaxLengthSubsection();
    syncSaveButton();
});

// All other inputs trigger dirty check
[UI.downloadInstantly, UI.defaultFilename].forEach(el => {
    el.addEventListener('change', syncSaveButton);
});

UI.defaultFilename.addEventListener('input', syncSaveButton);

UI.subfolder.addEventListener('input', () => {
    updateSubfolderHint();
    syncSaveButton();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

restoreOptions();
