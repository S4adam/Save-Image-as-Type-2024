function localizeHtmlPage() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const messageKey = element.getAttribute('data-i18n');
        const translatedMessage = chrome.i18n.getMessage(messageKey);
        if (translatedMessage) {
            element.textContent = translatedMessage;
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    localizeHtmlPage();

    // If permission is already granted, close immediately
    const alreadyGranted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    if (alreadyGranted) {
        window.close();
        return;
    }

    document.getElementById('grant-btn').addEventListener('click', async () => {
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
        if (granted) {
            window.close();
        } else {
            document.getElementById('status').textContent =
                chrome.i18n.getMessage('permissionDenied');
        }
    });
});
