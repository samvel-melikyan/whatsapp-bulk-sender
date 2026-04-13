/**
 * Content script for WhatsApp Web button automation.
 */

console.log("WhatsApp Bulk Sender: Content script injected.");

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SEND_MESSAGE") {
        console.log("WhatsApp Bulk Sender: Attempting to send message...");
        
        processMessaging(request.hasAttachment)
            .then(() => {
                try { sendResponse({ status: "SUCCESS" }); } catch(e) {}
            })
            .catch((err) => {
                console.error("WhatsApp Bulk Sender Error:", err);
                try { sendResponse({ status: "ERROR", message: err.message }); } catch(e) {}
            });
            
        return true; // Keep channel open for async response
    }
});

async function processMessaging(hasAttachment) {
    const urlParams = new URLSearchParams(window.location.search);
    const hasText = urlParams.has('text') && urlParams.get('text').trim() !== "";

    if (hasText) {
        await processTextSegment();
        // Brief pause between text and attachment to ensure React propagation
        if (hasAttachment) await new Promise(r => setTimeout(r, 1000));
    } else {
        await verifyChatLoaded();
    }

    if (hasAttachment) {
        console.log("WhatsApp Bulk Sender: Fetching attachment payload from local storage...");
        let attachData = await new Promise(r => chrome.storage.local.get('attachmentData', res => r(res.attachmentData)));
        if (attachData && attachData.dataUrl) {
            console.log("WhatsApp Bulk Sender: Processing attachment injection...");
            await sendAttachment(attachData);
        }
    }
}

function processTextSegment(retries = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        
        const check = () => {
            attempts++;
            
            let sendIcon = document.querySelector('span[data-icon="send"]');
            let sendBtn = null;
            
            if (sendIcon) {
                sendBtn = sendIcon.closest('button') || sendIcon.closest('div[role="button"]') || sendIcon;
            } else {
                sendBtn = document.querySelector('button[aria-label="Send"]') || 
                          document.querySelector('button[data-testid="compose-btn-send"]') ||
                          document.querySelector('[data-testid="send"]');
            }

            if (sendBtn && !sendBtn.disabled) {
                console.log("WhatsApp Bulk Sender: Text Send button found. Dispatching Enter...");
                
                const composer = document.querySelector('div[contenteditable="true"]');
                if (composer) {
                    composer.focus();
                    const enterDown = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: 13, key: 'Enter', code: 'Enter' });
                    composer.dispatchEvent(enterDown);
                } else {
                    sendBtn.click();
                }
                
                setTimeout(() => resolve(), 1500);
            } else {
                const errPopup = document.querySelector('[data-testid="popup-controls"]');
                if (errPopup && document.body.innerText.toLowerCase().includes('invalid')) {
                    const okButton = errPopup.querySelector('button');
                    if (okButton) okButton.click();
                    return reject(new Error("Invalid number."));
                }
            
                if (attempts < retries) {
                    setTimeout(check, 1000);
                } else {
                    // Resolve anyway to fallback to attachment attempt if text somehow failed to populate
                    resolve();
                }
            }
        };
        
        check();
    });
}

function verifyChatLoaded(retries = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const checkValid = () => {
            attempts++;
            const errPopup = document.querySelector('[data-testid="popup-controls"]');
            if (errPopup && document.body.innerText.toLowerCase().includes('invalid')) {
                const okButton = errPopup.querySelector('button');
                if (okButton) okButton.click();
                return reject(new Error("Invalid number."));
            }
            
            const chatPanel = document.querySelector('#main');
            if (chatPanel) {
                return resolve();
            }
            
            if (attempts < retries) setTimeout(checkValid, 1000);
            else reject(new Error("Chat did not load within expected timeframe."));
        };
        checkValid();
    });
}

function base64ToFile(base64, filename, mimeType) {
    const arr = base64.split(',');
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, {type: mimeType});
}

function sendAttachment(attachData) {
    return new Promise((resolve, reject) => {
        try {
            const file = base64ToFile(attachData.dataUrl, attachData.filename, attachData.type);
            
            const dt = new DataTransfer();
            dt.items.add(file);

            // Chrome's DragEvent constructor has a known bug where it strips the dataTransfer property.
            // We forcefully inject it onto the event prototype to ensure React's Tracker captures the dropped file.
            function createDragEvent(type) {
                const event = new DragEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
                Object.defineProperty(event, 'dataTransfer', { value: dt });
                return event;
            }

            const dropZone = document.querySelector('#main') || document.body;
            dropZone.dispatchEvent(createDragEvent('dragenter'));
            dropZone.dispatchEvent(createDragEvent('dragover'));
            dropZone.dispatchEvent(createDragEvent('drop'));

            console.log("WhatsApp Bulk Sender: Dispatched hardened Drag&Drop events.");

            // Wait for WhatsApp's Image/Document Preview Modal to pop up
            let previewAttempts = 0;
            const checkPreview = () => {
                previewAttempts++;
                
                // Grab all send icons. The preview modal is layered on top, meaning its button is generated securely last in the DOM.
                const sends = Array.from(document.querySelectorAll('span[data-icon="send"]'));
                const finalSendIcon = sends[sends.length - 1];

                if (finalSendIcon) {
                    console.log("WhatsApp Bulk Sender: Found preview send button. Firing synthetics...");
                    
                    setTimeout(() => {
                        const wrapper = finalSendIcon.closest('div[role="button"], button') || finalSendIcon;
                        
                        wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        wrapper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        wrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        
                        // Fallback purely for redundancy
                        try { finalSendIcon.click(); } catch(e){}
                        
                        // Wait for WhatsApp to physically process the animated send transition
                        setTimeout(() => resolve(), 2500); 
                    }, 1000);
                } else {
                    if (previewAttempts < 30) {
                        setTimeout(checkPreview, 1000);
                    } else {
                        reject(new Error("Attachment preview send button not found. Layout might have shifted."));
                    }
                }
            };
            setTimeout(checkPreview, 1000);
        } catch (e) {
            reject(new Error("Attachment err: " + e.message));
        }
    });
}
