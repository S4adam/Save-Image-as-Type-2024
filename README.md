# ![icon](assets/icons/icon-32.png) *Save Image as Type* v2
Fork of [src](https://github.com/image4tools/Save-Image-as-Type) (*authored by image4tools which has since been removed, read more below*).

<div align="center">  
  <a href="https://chromewebstore.google.com/detail/save-image-as-type-v2/pmmiflmbmncomecklllfjplelelcdflf">
    <img src="assets/chrome-badge.png" alt="Available in the Chrome Web Store" height="90">
  </a>  
</div>

## About
Tired of having saved images as _.webp_ type? **Save Image as Type v2** is a Chrome extension which adds an option _"Save as PNG/JPG/WebP/GIF/BMP"_ to the context menu on right-clicking any image. 

The original extension was removed from the Chrome Web Store for [containing spyware](https://www.xda-developers.com/google-featuring-chrome-extension-months-malicious/) (thanks **@Adam Conway** for the detailed write-up!). This fork is the successor that's 100% local, with zero tracking, zero analytics, and no external servers or injection scripts. All processing happens locally in your browser. The extension is extremely lightweight at roughly 220 KB!

<p align="center">
  <img src="assets/context-menu.png" alt="Save-Image-as-Type-Screenshot">
</p>

## Supported Formats
* **PNG, JPG, WebP:** native HTML5 Canvas conversion.
* **BMP:** 32-bit BMPs with transparency support.
* **GIF:** convert animated WebP & APNG files.
* *Note: AVIF support is excluded as it would require bundling a WebAssembly encoder.*

<p align="center">
  <img src="assets/action-loading.gif" alt="Action-loading"
  width="48">
</p>

## Extension Options
There are various options you can customize via the options page:
* Toggle which formats appear in the right-click menu.
* Enable instant downloading (skips the "Save As" dialog).
* Set default filename prefixes.
* Define download sub-folders.
* Limit maximum filename lengths.
* Set a memory limit for GIF conversions.

![Options-page](assets/options-page.png)


## "Access to all" permission
This extension requires the `<all_urls>` permission, which Chrome displays as _"Read and change all your data on all websites"_. 

Sadly, it has to be used to bypass CORS restrictions, otherwise the extension would fail reading pixel data from images hosted on some popular CDNs (like _Google User Content_).

## Installation

### Option 1: Chrome Web Store
The easiest way to use the extension is to install it directly from the official store:
1. Visit the [Chrome Web Store page](https://chromewebstore.google.com/detail/save-image-as-type-v2/pmmiflmbmncomecklllfjplelelcdflf).
2. Click the **Add to Chrome** button.

### Option 2: Manual Installation (via Developer Mode)
If you want to run the extension from source code:
1. Download and extract the ZIP file from [github releases](https://github.com/S4adam/Save-Image-as-Type-2024/releases).
2. Open Chrome and navigate to [`chrome://extensions/`](chrome://extensions/).
3. Enable **Developer mode** (toggle in the upper right corner).
4. Click **Load unpacked** in the upper left corner.
5. Select the extracted extension folder from your computer.

The extension should now be installed successfully.

<p align="center">
  <img src="assets/extensions-view.png" alt="Extensions View" width="490">
</p>

## Acknowledgments
* Rob Wu: https://github.com/Rob--W
* Cuixiping: https://github.com/cuixiping
* jnordberg: https://github.com/jnordberg/gif.js

## License
This project is licensed under the GNU General Public License v2.0.