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
            
            // 1. Click attach button natively to trigger the React DOM tree creation
            const attachMenuBtn = document.querySelector('span[data-icon="plus"]') || document.querySelector('span[data-icon="clip"]');
            if (!attachMenuBtn) return reject(new Error("Attach button not found."));
            
            const btnWrap = attachMenuBtn.closest('button') || attachMenuBtn.closest('div[role="button"]') || attachMenuBtn;
            btnWrap.click();
            console.log("WhatsApp Bulk Sender: Opened attach menu.");

            let fileAttempts = 0;
            const checkFile = () => {
                fileAttempts++;
                // 2. Find file input
                const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
                const targetInput = inputs.find(i => i.accept && i.accept.includes('*')) || inputs[0];

                if (targetInput) {
                    console.log("WhatsApp Bulk Sender: Injecting file into input...");
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    targetInput.files = dt.files;
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));

                    // 3. Wait for preview modal send button
                    let previewAttempts = 0;
                    const checkPreview = () => {
                        previewAttempts++;
                        let sendIcon = document.querySelector('div[aria-label="Send"] span[data-icon="send"]') ||
                                       document.querySelector('div[data-animate-modal-body="true"] span[data-icon="send"]');
                        if (!sendIcon) {
                            const all = Array.from(document.querySelectorAll('span[data-icon="send"]'));
                            if (all.length > 0) sendIcon = all[all.length - 1]; 
                        }

                        let finalSend = sendIcon ? (sendIcon.closest('button') || sendIcon.closest('div[role="button"]')) : document.querySelector('span[data-icon="send-light"]');
                        
                        if (finalSend) {
                            setTimeout(() => {
                                finalSend.click();
                                setTimeout(() => resolve(), 2000);
                            }, 1000);
                        } else {
                            if (previewAttempts < 30) setTimeout(checkPreview, 1000);
                            else reject(new Error("Preview send button not found."));
                        }
                    };
                    setTimeout(checkPreview, 1000);
                } else {
                    if (fileAttempts < 20) setTimeout(checkFile, 500);
                    else reject(new Error("File input not found."));
                }
            };
            setTimeout(checkFile, 500);
        } catch (e) {
            reject(new Error("Attachment err: " + e.message));
        }
    });
}
