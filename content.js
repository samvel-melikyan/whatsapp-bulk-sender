/**
 * Content script for WhatsApp Web automation.
 * Uses multiple layered strategies to trigger send:
 *   1. React fiber state manipulation (sync DOM with React state)
 *   2. Debugger-injected real key events (via background relay)
 *   3. Full pointer/mouse click simulation on send button
 */

console.log("WhatsApp Bulk Sender: Content script injected.");

// Listen for messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SEND_MESSAGE") {
        console.log("WhatsApp Bulk Sender: Received SEND_MESSAGE");
        processMessaging(request.hasAttachment)
            .then(() => {
                try { sendResponse({ status: "SUCCESS" }); } catch(e) {}
            })
            .catch((err) => {
                console.error("WhatsApp Bulk Sender Error:", err);
                try { sendResponse({ status: "ERROR", message: err.message }); } catch(e) {}
            });
        return true;
    }
});

// ─── Utility: sleep ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Utility: find main chat composer ────────────────────────────────────────
function getComposer() {
    const footer = document.querySelector('footer');
    if (footer) {
        const el = footer.querySelector('div[contenteditable="true"]');
        if (el) return el;
    }
    const all = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
    const withTab = all.find(el => el.hasAttribute('data-tab'));
    return withTab || all[all.length - 1] || null;
}

// ─── Utility: find send button ───────────────────────────────────────────────
function getSendBtn(isModal) {
    const selectors = [
        'button[aria-label="Send"]',
        'div[role="button"][aria-label="Send"]',
        '[data-testid="compose-btn-send"]',
        '[data-testid="send"]',
        'span[data-icon="send"]',
        'span[data-icon="send-light"]'
    ];
    
    let candidates = [];
    selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
            const clickable = el.closest('button') || el.closest('div[role="button"]') || el;
            if (!candidates.includes(clickable)) candidates.push(clickable);
        });
    });

    if (isModal) {
        const modalBtns = candidates.filter(el => !el.closest('footer'));
        return modalBtns.find(el => el.offsetWidth > 0 || el.offsetHeight > 0) || modalBtns[modalBtns.length - 1] || null;
    } else {
        const footerBtns = candidates.filter(el => el.closest('footer'));
        if (footerBtns.length > 0) {
            return footerBtns.find(el => el.offsetWidth > 0 || el.offsetHeight > 0) || footerBtns[0];
        }
        return candidates.find(el => (el.offsetWidth > 0 || el.offsetHeight > 0) && !el.closest('footer') === false) || null;
    }
}

// ─── Strategy: Simulate Enter via keyboard events ────────────────────────────
function simulateEnterKey(target) {
    const opts = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown',  { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keypress', { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keyup',    { ...opts }));
}

// ─── Strategy: Mutate React state + simulate Input ────────────────────────────
function triggerReactInputChange(el, value) {
    try {
        const key = Object.keys(el).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!key) return false;

        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    } catch(e) {
        console.warn("React fiber mutation failed:", e);
        return false;
    }
}

// ─── Strategy: Full pointer/mouse/click simulation ───────────────────────────
function simulateRealClick(el) {
    try {
        if (!el) return;
        el.focus();
        
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, view: window };

        el.dispatchEvent(new PointerEvent('pointerover',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseover',      base));
        el.dispatchEvent(new PointerEvent('pointerdown',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousedown',      base));
        el.dispatchEvent(new PointerEvent('pointerup',    { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseup',        base));
        el.dispatchEvent(new MouseEvent('click',          base));
        
        setTimeout(() => {
            if (document.body.contains(el)) el.click();
        }, 50);
    } catch(e) {
        console.warn("simulateRealClick failed:", e);
    }
}

// ─── Error popup detection (Invalid Numbers) ──────────────────────────────────
function checkErrorPopup() {
    const popup = document.querySelector('[data-testid="popup-controls"]') || 
                  document.querySelector('div[role="dialog"]') ||
                  document.querySelector('.x1n2onr6'); // common WA modal class
    
    if (popup) {
        const text = popup.innerText.toLowerCase();
        // Detect "invalid", "not registered", "invalid number", etc.
        if (text.includes('invalid') || text.includes('not on whatsapp') || text.includes('not registered')) {
            const buttons = Array.from(popup.querySelectorAll('button, [role="button"]'));
            const okBtn = buttons.find(b => b.innerText.toLowerCase().includes('ok') || b.innerText.toLowerCase().includes('close'));
            if (okBtn) okBtn.click();
            return true;
        }
    }
    return false;
}

// ─── Main flow ────────────────────────────────────────────────────────────────
async function processMessaging(hasAttachment) {
    const urlParams = new URLSearchParams(window.location.search);
    const hasText = urlParams.has('text') && urlParams.get('text').trim() !== '';

    if (hasText) {
        await processTextSegment();
        if (hasAttachment) await sleep(2000);
    } else {
        await verifyChatLoaded();
    }

    if (hasAttachment) {
        const attachData = await new Promise(r =>
            chrome.storage.local.get('attachmentData', res => r(res.attachmentData))
        );
        if (attachData && attachData.dataUrl) {
            await sendAttachment(attachData);
        }
    }
}

// ─── Text sending loop ────────────────────────────────────────────────────────
function processTextSegment(maxAttempts = 40) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let stage = 'waiting'; // waiting -> enter_sent -> click_sent -> done

        const tick = async () => {
            attempts++;

            // 1. Check for Invalid Number Popups
            if (checkErrorPopup()) {
                console.log("WhatsApp Bulk Sender: Detected invalid number popup.");
                return reject(new Error("Invalid number."));
            }

            const composer = getComposer();

            if (!composer) {
                // If composer not found but chat panel is there, maybe it's still loading
                if (attempts < maxAttempts) return setTimeout(tick, 1000);
                return resolve(); 
            }

            const text = (composer.innerText || composer.textContent || '').trim();

            // 2. SUCCESS check: composer cleared
            if (stage !== 'waiting' && text === '') {
                console.log("WhatsApp Bulk Sender: Message sent!");
                return resolve();
            }

            // 3. WAITING: Try strategies
            if (text !== '') {
                composer.focus();
                
                if (stage === 'waiting') {
                    // Sync React state
                    triggerReactInputChange(composer, text);
                    await sleep(500);
                    
                    // Simulate Enter
                    simulateEnterKey(composer);
                    stage = 'enter_sent';
                    return setTimeout(tick, 2000);
                }

                if (stage === 'enter_sent' && attempts > 4) {
                    const btn = getSendBtn(false);
                    if (btn) {
                        simulateRealClick(btn);
                        stage = 'click_sent';
                        return setTimeout(tick, 2000);
                    }
                }

                if (stage === 'click_sent' && attempts > 8) {
                    chrome.runtime.sendMessage({ action: 'INJECT_ENTER_KEY' });
                    stage = 'debugger_sent';
                    return setTimeout(tick, 2500);
                }

                // Retries
                if (attempts % 4 === 0) {
                    const btn = getSendBtn(false);
                    if (btn) simulateRealClick(btn);
                }
                if (attempts % 3 === 0) simulateEnterKey(composer);
            }

            if (attempts < maxAttempts) return setTimeout(tick, 1000);
            resolve();
        };

        setTimeout(tick, 2500);
    });
}

// ─── Chat loaded verification ─────────────────────────────────────────────────
function verifyChatLoaded(maxAttempts = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            attempts++;
            if (checkErrorPopup()) return reject(new Error("Invalid number."));
            if (document.querySelector('#main')) return resolve();
            if (attempts < maxAttempts) return setTimeout(check, 1000);
            reject(new Error("Chat panel not found."));
        };
        check();
    });
}

// ─── Base64 → File ────────────────────────────────────────────────────────────
function base64ToFile(base64, filename, mimeType) {
    const arr = base64.split(',');
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mimeType });
}

// ─── Attachment sending ───────────────────────────────────────────────────────
function sendAttachment(attachData) {
    return new Promise((resolve, reject) => {
        try {
            const file = base64ToFile(attachData.dataUrl, attachData.filename, attachData.type);
            const composer = getComposer();
            if (!composer) return reject(new Error("Composer not found."));

            composer.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            composer.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));

            let attempts = 0;
            const maxAttempts = 30;
            let modalSeen = false;
            let enterSent = false;
            let clickSent = false;

            const tick = () => {
                attempts++;
                const btn = getSendBtn(true);

                if (btn) {
                    modalSeen = true;
                    if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
                        if (!enterSent) {
                            const focused = document.activeElement || document.body;
                            simulateEnterKey(focused);
                            const cap = document.querySelector('div[contenteditable="true"][data-lexical-editor]') || document.querySelector('div[contenteditable="true"]:not([data-tab])');
                            if (cap) simulateEnterKey(cap);
                            enterSent = true;
                            return setTimeout(tick, 2000);
                        }
                        if (!clickSent) {
                            simulateRealClick(btn);
                            clickSent = true;
                            return setTimeout(tick, 2000);
                        }
                        if (attempts % 3 === 0) simulateRealClick(btn);
                    }
                    if (attempts < maxAttempts) return setTimeout(tick, 1000);
                    reject(new Error("Modal send button timeout."));
                } else {
                    if (modalSeen) return setTimeout(resolve, 1000);
                    if (attempts < maxAttempts) return setTimeout(tick, 1000);
                    reject(new Error("Attachment modal timeout."));
                }
            };
            setTimeout(tick, 2500);
        } catch(e) {
            reject(new Error("Attachment error: " + e.message));
        }
    });
}
