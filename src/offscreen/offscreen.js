const ALLOWED_TYPES = ['jpg', 'png', 'webp', 'gif'];

init();

function init() {
    chrome.runtime.onMessage.addListener(async (message) => {
        let { op, target, filename, src, type } = message;
        if (target !== 'offscreen') {
            return false;
        }
        switch (op) {
            case 'convertType': {
                if (!src || !src.startsWith('data:')) {
                    notify('Unexpected src');
                    return false;
                }
                if (!ALLOWED_TYPES.includes(type)) {
                    notify('Invalid type');
                    return false;
                }
                convertImageAsType(src, filename, type);
                break;
            }
            default: {
                console.warn(`Unexpected message type received: '${op}'.`);
                return false;
            }
        }
    });
}

function notify(message) {
    chrome.runtime.sendMessage({ op: 'notify', target: 'background', message });
}

function download(url, filename) {
    chrome.runtime.sendMessage({ op: 'download', target: 'background', url, filename });
}

function convertImageAsType(src, filename, type) {
    function getDataURLOfType(img, type) {
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var context = canvas.getContext('2d');
        var mimeType = 'image/' + (type == 'jpg' ? 'jpeg' : type);
        context.drawImage(img, 0, 0);
        var dataurl = canvas.toDataURL(mimeType);
        canvas = null;
        return dataurl;
    }

    function encodeToGIF(img, callback) {
        var canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        var gif = new GIF({
            workers: 2,
            quality: 10,
            workerScript: '../../vendor/gif.worker.js'
        });

        gif.addFrame(canvas, { delay: 200 });

        gif.on('finished', function (blob) {
            var reader = new FileReader();
            reader.onload = function (e) {
                callback(e.target.result);
            }
            reader.readAsDataURL(blob);
        });

        gif.render();
    }

    function imageLoad(src, type, callback) {
        var img = new Image();
        img.onload = function () {
            if (type === 'gif') {
                encodeToGIF(this, callback);
            } else {
                var dataurl = getDataURLOfType(this, type);
                callback(dataurl);
            }
        };
        img.onerror = function () {
            notify({ error: 'errorOnLoading', src });
        };
        img.src = src;
    }

    function callback(dataurl) {
        download(dataurl, filename);
    }

    if (!src.startsWith('data:')) {
        // handle non-data urls?
    } else {
        imageLoad(src, type, callback);
    }
}
