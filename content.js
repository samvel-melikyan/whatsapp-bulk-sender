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

function getSendBtn(isModal) {
    if (isModal) {
        let btns = Array.from(document.querySelectorAll('div[aria-label="Send"], button[aria-label="Send"], span[data-icon="send"]'))
                        .map(el => el.closest('button') || el.closest('div[role="button"]') || el)
                        .filter(el => !el.closest('footer'));
        return btns[btns.length - 1]; // Return the topmost modal button
    } else {
        let btn = document.querySelector('footer button[aria-label="Send"]') || 
                  document.querySelector('footer [data-testid="compose-btn-send"]') ||
                  document.querySelector('footer div[role="button"][aria-label="Send"]');
        if (btn) return btn;
        
        let span = document.querySelector('footer span[data-icon="send"]');
        if (span) return span.closest('button') || span.closest('div[role="button"]') || span;
        
        return null;
    }
}

function processTextSegment(retries = 20) { // 20 attempts * 1000ms = 20 seconds maximum blocking
    return new Promise((resolve, reject) => {
        let attempts = 0;
        
        const tick = () => {
            attempts++;
            
            // 1. Check for Invalid Number Popups
            const errPopup = document.querySelector('[data-testid="popup-controls"]');
            if (errPopup && document.body.innerText.toLowerCase().includes('invalid')) {
                const okButton = errPopup.querySelector('button');
                if (okButton) okButton.click();
                return reject(new Error("Invalid number."));
            }
            
            // 2. Fetch the text send button
            let btn = getSendBtn(false);
            
            if (btn) {
                // If it is found, it means text is currently in the composer but hasn't fully sent yet.
                if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                    console.log(`WhatsApp Bulk Sender: Firing text click... (Attempt ${attempts})`);
                    try { btn.click(); } catch(e) {}
                    try { btn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); } catch(e) {}
                    try { btn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); } catch(e) {}
                } else {
                    console.log("WhatsApp Bulk Sender: Text Send button is buffering (aria-disabled). Waiting...");
                }
                
                // Retry in 500ms to see if it vanished (meaning send was successful)
                setTimeout(tick, 1000);
            } else {
                // 3. Button does NOT exist!
                const composer = document.querySelector('div[contenteditable="true"]');
                if (composer && composer.innerText.trim() === '') {
                    // Send button is gone BECAUSE the composer is completely empty! (Successful send)
                    console.log("WhatsApp Bulk Sender: Text sent and cleared successfully!");
                    return resolve();
                }
                
                // If the composer isn't empty, or doesn't exist, we are still loading the chat.
                if (attempts < retries) {
                    setTimeout(tick, 1000);
                } else {
                    resolve(); // Timeout fallback, move to attachment stage
                }
            }
        };
        
        tick();
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
            
            const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            composer.dispatchEvent(pasteEvent);
            console.log("WhatsApp Bulk Sender: Dispatched paste event for attachment.");

            // Wait for Modal to open and Hammer the Modals Send Button until it closes
            let attempts = 0;
            const retries = 20; // Maximum 20 seconds waiting for preview modal validation
            
            const tickPreview = () => {
                attempts++;
                
                let modalBtn = getSendBtn(true);
                
                if (modalBtn) {
                    if (!modalBtn.disabled && modalBtn.getAttribute('aria-disabled') !== 'true') {
                        console.log(`WhatsApp Bulk Sender: Firing attachment click... (Attempt ${attempts})`);
                        try { modalBtn.click(); } catch(e) {}
                        try { modalBtn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); } catch(e) {}
                        try { modalBtn.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); } catch(e) {}
                    } else {
                        console.log("WhatsApp Bulk Sender: Attachment preview rendering (aria-disabled). Waiting...");
                    }
                    setTimeout(tickPreview, 1000);
                } else {
                    // Modal Send Button is completely gone.
                    // Did it successfully close or was it never opened?
                    if (attempts > 2) { 
                        // It existed for at least some cycles, meaning we clicked it and it vanished!
                        console.log("WhatsApp Bulk Sender: Attachment modal detected as closed. Send successful!");
                        setTimeout(() => resolve(), 1000); // Buffer delay before next contact
                    } else {
                        // Modal hasn't spawned yet
                        if (attempts < retries) {
                            setTimeout(tickPreview, 1000);
                        } else {
                            reject(new Error("Attachment preview send button never spawned or timed out."));
                        }
                    }
                }
            };
            
            setTimeout(tickPreview, 1500); // Initial 1.5s delay to let `paste` actually trigger the modal opening securely
        } catch (e) {
            reject(new Error("Attachment err: " + e.message));
        }
    });
}
