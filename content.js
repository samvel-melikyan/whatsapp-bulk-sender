/**
 * Content script for WhatsApp Web button automation.
 * Uses Enter key simulation instead of button clicking for reliable sends.
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
        if (hasAttachment) await new Promise(r => setTimeout(r, 1500));
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

/**
 * Simulates a full Enter keypress on a target element.
 * Dispatches keydown, keypress, and keyup in sequence — this is what
 * WhatsApp Web's React event listeners actually respond to.
 */
function simulateEnter(target) {
    const opts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    console.log("WhatsApp Bulk Sender: Simulated Enter key on", target.tagName || target);
}

/**
 * Full pointer + mouse + click event sequence for fallback button clicking.
 * Mimics a real user click more closely than just .click().
 */
function simulateRealClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const commonOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };

    el.dispatchEvent(new PointerEvent('pointerdown', { ...commonOpts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', commonOpts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...commonOpts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', commonOpts));
    el.dispatchEvent(new MouseEvent('click', commonOpts));
    console.log("WhatsApp Bulk Sender: Simulated full click on", el.tagName, el.getAttribute('aria-label') || '');
}

/**
 * Finds the footer composer (the main message input area).
 */
function getComposer() {
    // WhatsApp Web's main message input
    const footerComposer = document.querySelector('footer div[contenteditable="true"][data-tab]');
    if (footerComposer) return footerComposer;

    // Broader fallback
    const allEditable = document.querySelectorAll('div[contenteditable="true"]');
    for (const el of allEditable) {
        if (el.closest('footer')) return el;
    }
    // Last resort: any contenteditable
    return allEditable.length > 0 ? allEditable[allEditable.length - 1] : null;
}

/**
 * Finds the send button. Used as a fallback strategy.
 */
function getSendBtn(isModal) {
    if (isModal) {
        // For the attachment preview modal, look for send buttons NOT in the footer
        let btns = Array.from(document.querySelectorAll(
            'div[aria-label="Send"], button[aria-label="Send"], span[data-icon="send"], ' +
            '[data-testid="send"], [data-testid="compose-btn-send"]'
        ))
            .map(el => el.closest('button') || el.closest('div[role="button"]') || el)
            .filter(el => !el.closest('footer'));
        return btns[btns.length - 1] || null;
    } else {
        // For the main chat footer send button
        let btn = document.querySelector('footer button[aria-label="Send"]') || 
                  document.querySelector('footer [data-testid="compose-btn-send"]') ||
                  document.querySelector('footer div[role="button"][aria-label="Send"]');
        if (btn) return btn;
        
        let span = document.querySelector('footer span[data-icon="send"]');
        if (span) return span.closest('button') || span.closest('div[role="button"]') || span;
        
        return null;
    }
}

/**
 * STRATEGY: Sending text messages.
 * 
 * 1. Wait for the composer to have text (populated via URL ?text= param)
 * 2. Focus the composer
 * 3. Simulate pressing Enter
 * 4. If Enter didn't work, fall back to clicking the send button with full event simulation
 * 5. Verify the composer is empty (message was sent)
 */
function processTextSegment(retries = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let enterSent = false;
        let clickSent = false;
        
        const tick = () => {
            attempts++;
            
            // 1. Check for Invalid Number Popups
            const errPopup = document.querySelector('[data-testid="popup-controls"]');
            if (errPopup && document.body.innerText.toLowerCase().includes('invalid')) {
                const okButton = errPopup.querySelector('button');
                if (okButton) okButton.click();
                return reject(new Error("Invalid number."));
            }
            
            // 2. Find the composer
            const composer = getComposer();
            
            if (!composer) {
                // Chat hasn't loaded yet
                if (attempts < retries) {
                    setTimeout(tick, 1000);
                } else {
                    resolve(); // Timeout fallback
                }
                return;
            }
            
            const composerText = (composer.innerText || composer.textContent || '').trim();
            
            // 3. Check if the composer is empty (message already sent successfully)
            if (enterSent && composerText === '') {
                console.log("WhatsApp Bulk Sender: Text sent successfully! Composer is empty.");
                return resolve();
            }
            
            // Also check: send button is gone AND composer is empty
            if ((enterSent || clickSent) && !getSendBtn(false) && composerText === '') {
                console.log("WhatsApp Bulk Sender: Text sent successfully! No send button and composer is clear.");
                return resolve();
            }
            
            // 4. Composer has text — try sending
            if (composerText !== '') {
                composer.focus();
                
                if (!enterSent) {
                    // Strategy A: Simulate Enter key
                    console.log(`WhatsApp Bulk Sender: Composer has text, pressing Enter... (Attempt ${attempts})`);
                    simulateEnter(composer);
                    enterSent = true;
                    setTimeout(tick, 1500); // Give it time to process
                    return;
                }
                
                if (!clickSent) {
                    // Strategy B: Try clicking the send button with full event simulation
                    const btn = getSendBtn(false);
                    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                        console.log(`WhatsApp Bulk Sender: Enter didn't work, clicking send button... (Attempt ${attempts})`);
                        simulateRealClick(btn);
                        clickSent = true;
                        setTimeout(tick, 1500);
                        return;
                    }
                }
                
                // Strategy C: Keep retrying Enter (sometimes it needs the composer to settle first)
                if (attempts % 3 === 0) {
                    console.log(`WhatsApp Bulk Sender: Retrying Enter key... (Attempt ${attempts})`);
                    composer.focus();
                    simulateEnter(composer);
                }
                
                // Also retry clicking every few attempts
                if (attempts % 4 === 0) {
                    const btn = getSendBtn(false);
                    if (btn && !btn.disabled) {
                        console.log(`WhatsApp Bulk Sender: Retrying click... (Attempt ${attempts})`);
                        simulateRealClick(btn);
                    }
                }
            }
            
            if (attempts < retries) {
                setTimeout(tick, 1000);
            } else {
                console.log("WhatsApp Bulk Sender: Text send timed out, proceeding...");
                resolve(); // Timeout fallback
            }
        };
        
        // Initial delay to let the chat and composer load
        setTimeout(tick, 1500);
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

/**
 * STRATEGY: Sending attachments.
 * 
 * 1. Convert base64 to File and paste into the composer
 * 2. Wait for the attachment preview modal to appear
 * 3. Try Enter key on the modal / focused element first
 * 4. Fall back to full click simulation on the modal send button
 * 5. Verify the modal closed (attachment was sent)
 */
function sendAttachment(attachData) {
    return new Promise((resolve, reject) => {
        try {
            const file = base64ToFile(attachData.dataUrl, attachData.filename, attachData.type);
            
            const composer = getComposer();
            if (!composer) return reject(new Error("Composer not found to paste attachment."));
            
            composer.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            
            const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
            composer.dispatchEvent(pasteEvent);
            console.log("WhatsApp Bulk Sender: Dispatched paste event for attachment.");

            let attempts = 0;
            const retries = 25;
            let modalFound = false;
            let enterSent = false;
            let clickSent = false;
            
            const tickPreview = () => {
                attempts++;
                
                let modalBtn = getSendBtn(true);
                
                if (modalBtn) {
                    modalFound = true;
                    
                    if (!modalBtn.disabled && modalBtn.getAttribute('aria-disabled') !== 'true') {
                        if (!enterSent) {
                            // Strategy A: Press Enter on the active element / document
                            console.log(`WhatsApp Bulk Sender: Modal found, pressing Enter... (Attempt ${attempts})`);
                            const focused = document.activeElement || document.body;
                            simulateEnter(focused);
                            // Also try on the modal caption input if it exists
                            const captionInput = document.querySelector('div[contenteditable="true"]:not([data-tab])');
                            if (captionInput) {
                                simulateEnter(captionInput);
                            }
                            enterSent = true;
                            setTimeout(tickPreview, 1500);
                            return;
                        }
                        
                        if (!clickSent) {
                            // Strategy B: Full click simulation on the button
                            console.log(`WhatsApp Bulk Sender: Enter didn't close modal, clicking button... (Attempt ${attempts})`);
                            simulateRealClick(modalBtn);
                            clickSent = true;
                            setTimeout(tickPreview, 1500);
                            return;
                        }
                        
                        // Keep retrying both strategies
                        if (attempts % 3 === 0) {
                            console.log(`WhatsApp Bulk Sender: Retrying Enter on modal... (Attempt ${attempts})`);
                            const focused = document.activeElement || document.body;
                            simulateEnter(focused);
                        }
                        if (attempts % 4 === 0) {
                            console.log(`WhatsApp Bulk Sender: Retrying click on modal btn... (Attempt ${attempts})`);
                            simulateRealClick(modalBtn);
                        }
                    } else {
                        console.log("WhatsApp Bulk Sender: Attachment preview rendering (disabled). Waiting...");
                    }
                    setTimeout(tickPreview, 1000);
                } else {
                    // Modal Send Button is gone
                    if (modalFound) { 
                        // We saw the modal before and now it's gone — success!
                        console.log("WhatsApp Bulk Sender: Attachment modal closed. Send successful!");
                        setTimeout(() => resolve(), 1000);
                    } else {
                        // Modal hasn't appeared yet
                        if (attempts < retries) {
                            setTimeout(tickPreview, 1000);
                        } else {
                            reject(new Error("Attachment preview send button never appeared or timed out."));
                        }
                    }
                }
            };
            
            // Initial delay to let the paste event trigger the modal
            setTimeout(tickPreview, 2000);
        } catch (e) {
            reject(new Error("Attachment err: " + e.message));
        }
    });
}
