/**
 * Content script for WhatsApp Web button automation.
 */

console.log("WhatsApp Bulk Sender: Content script injected.");

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SEND_MESSAGE") {
        console.log("WhatsApp Bulk Sender: Attempting to send message...");
        
        processMessaging(request.attachment)
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

async function processMessaging(attachment) {
    const urlParams = new URLSearchParams(window.location.search);
    const hasText = urlParams.has('text') && urlParams.get('text').trim() !== "";

    if (hasText) {
        await processTextSegment();
        // Brief pause between text and attachment to ensure React propagation
        if (attachment) await new Promise(r => setTimeout(r, 1000));
    } else {
        await verifyChatLoaded();
    }

    if (attachment && attachment.dataUrl) {
        console.log("WhatsApp Bulk Sender: Processing attachment...");
        await sendAttachment(attachment);
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
                console.log("WhatsApp Bulk Sender: Text Send button found. Clicking...");
                
                const composer = document.querySelector('div[contenteditable="true"]');
                if (composer) composer.focus();
                
                sendBtn.click();
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

function sendAttachment(attachment) {
    return new Promise((resolve, reject) => {
        try {
            const file = base64ToFile(attachment.dataUrl, attachment.filename, attachment.type);
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);

            const dropZone = document.querySelector('#main') || document.body;
            
            // Emulate a complete drag and drop lifecycle exactly how a user dragging a file would
            dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer, clientX: 100, clientY: 100 }));
            dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: 100, clientY: 100 }));
            dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: 100, clientY: 100 }));

            console.log("WhatsApp Bulk Sender: Drag/Drop events dispatched for attachment.");

            let attempts = 0;
            const checkPreview = () => {
                attempts++;
                
                let sendIcon = document.querySelector('div[aria-label="Send"] span[data-icon="send"]') ||
                               document.querySelector('div[data-animate-modal-body="true"] span[data-icon="send"]');
                
                if (!sendIcon) {
                    const allSends = Array.from(document.querySelectorAll('span[data-icon="send"]'));
                    if (allSends.length > 0) {
                        sendIcon = allSends[allSends.length - 1]; // Often the last one in DOM is the modal's over-top layer
                    }
                }

                let sendBtn = null;
                if (sendIcon) {
                    sendBtn = sendIcon.closest('button') || sendIcon.closest('div[role="button"]') || sendIcon;
                } else {
                    sendBtn = document.querySelector('span[data-icon="send-light"]') || document.querySelector('[data-testid="send"]');
                }

                if (sendBtn) {
                    console.log("WhatsApp Bulk Sender: Attachment Send button found. Clicking...");
                    setTimeout(() => {
                        sendBtn.click();
                        setTimeout(() => resolve(), 2000); 
                    }, 1000); 
                } else {
                    if (attempts < 30) {
                        setTimeout(checkPreview, 1000);
                    } else {
                        reject(new Error("Attachment preview not found."));
                    }
                }
            };
            
            setTimeout(checkPreview, 1000);
        } catch (e) {
            reject(new Error("Attachment injection failed: " + e.message));
        }
    });
}
