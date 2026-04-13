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
            
            // Text send button is always in the main generic footer or main area
            let sendBtn = document.querySelector('footer button[aria-label="Send"]') || 
                          document.querySelector('footer [data-testid="compose-btn-send"]') || 
                          document.querySelector('footer span[data-icon="send"]');
            
            if (sendBtn) {
                // Determine true clickable node
                const clickTarget = sendBtn.closest('button') || sendBtn.closest('div[role="button"]') || sendBtn;
                
                if (!clickTarget.disabled) {
                    console.log("WhatsApp Bulk Sender: Force-clicking text send button...");
                    
                    setTimeout(() => {
                        // Force strong Enter dispatch
                        const composer = document.querySelector('div[contenteditable="true"]');
                        if (composer) {
                            composer.focus();
                            const enterEvent = new KeyboardEvent('keydown', {
                                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13
                            });
                            composer.dispatchEvent(enterEvent);
                        }
                        
                        // Force DOM click
                        clickTarget.click();
                        
                        setTimeout(() => resolve(), 1500);
                    }, 500); // 500ms stabilization delay for React states
                } else {
                    if (attempts < retries) setTimeout(check, 1000);
                    else resolve();
                }
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
                
                // The attachment preview modal ALWAYS exists outside or detached from the main footer.
                // We filter out any send buttons inside 'footer' to guarantee we target the modal icon.
                const modalBtns = Array.from(document.querySelectorAll('span[data-icon="send"]'))
                                       .map(icon => icon.closest('div[role="button"], button') || icon)
                                       .filter(btn => !btn.closest('footer'));

                if (modalBtns.length > 0) {
                    const finalModalBtn = modalBtns[0];
                    console.log("WhatsApp Bulk Sender: Found isolated preview send button. Firing native click...");
                    
                    setTimeout(() => {
                        finalModalBtn.click();
                        
                        setTimeout(() => resolve(), 2500); 
                    }, 1500); // Wait 1.5s for any thumbnail generation processing visually
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
