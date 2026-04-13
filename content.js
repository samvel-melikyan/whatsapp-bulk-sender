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
                console.log("WhatsApp Bulk Sender: Text Send button found. Executing physical clicks...");
                
                const composer = document.querySelector('div[contenteditable="true"]');
                if (composer) composer.focus();
                
                // Emulate true physical mouse sequence
                sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                
                // Fallback
                try { sendBtn.click(); } catch(e){}
                
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
            
            const composer = document.querySelector('div[contenteditable="true"]');
            if (!composer) return reject(new Error("Composer not found to paste attachment."));
            
            composer.focus();

            const dt = new DataTransfer();
            dt.items.add(file);
            
            // Bypass React blocks by emulating a strict physical Ctrl+V Paste event
            const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            composer.dispatchEvent(pasteEvent);

            console.log("WhatsApp Bulk Sender: Dispatched synthetic paste event for attachment.");

            // Wait for WhatsApp's Image/Document Preview Modal to pop up
            let previewAttempts = 0;
            const checkPreview = () => {
                previewAttempts++;
                
                const sends = Array.from(document.querySelectorAll('span[data-icon="send"]'));
                const finalSendIcon = sends[sends.length - 1];

                if (finalSendIcon) {
                    console.log("WhatsApp Bulk Sender: Found preview send button. Executing clicks...");
                    
                    setTimeout(() => {
                        const wrapper = finalSendIcon.closest('div[role="button"], button') || finalSendIcon;
                        
                        wrapper.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        wrapper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        wrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        
                        try { finalSendIcon.click(); } catch(e){}
                        
                        setTimeout(() => resolve(), 2500); 
                    }, 1000);
                } else {
                    if (previewAttempts < 30) {
                        setTimeout(checkPreview, 1000);
                    } else {
                        reject(new Error("Attachment preview send button not found."));
                    }
                }
            };
            setTimeout(checkPreview, 1000);
        } catch (e) {
            reject(new Error("Attachment err: " + e.message));
        }
    });
}
