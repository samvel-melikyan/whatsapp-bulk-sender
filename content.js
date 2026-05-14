/**
 * Content script for WhatsApp Web automation.
 * Uses multiple layered strategies to trigger send:
 *   1. React fiber state manipulation (set nativeInputValueSetter on contenteditable)
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

    if (request.action === "TRIGGER_SEND") {
        // Called by background after debugger key injection attempt as a fallback
        const btn = getSendBtn(false);
        if (btn) {
            simulateRealClick(btn);
            try { sendResponse({ status: "clicked" }); } catch(e) {}
        } else {
            try { sendResponse({ status: "no_btn" }); } catch(e) {}
        }
        return true;
    }
});

// ─── Utility: sleep ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Utility: find main chat composer ────────────────────────────────────────
function getComposer() {
    // Primary selector used by WhatsApp Web
    const footer = document.querySelector('footer');
    if (footer) {
        const el = footer.querySelector('div[contenteditable="true"]');
        if (el) return el;
    }
    // Fallback: any contenteditable that's not in a modal
    const all = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
    // Prefer elements with data-tab (WhatsApp adds this to the main composer)
    const withTab = all.find(el => el.hasAttribute('data-tab'));
    return withTab || all[all.length - 1] || null;
}

// ─── Utility: find send button ───────────────────────────────────────────────
function getSendBtn(isModal) {
    const allBtns = Array.from(document.querySelectorAll(
        '[aria-label="Send"], [data-testid="compose-btn-send"], [data-testid="send"], span[data-icon="send"]'
    ));

    const candidates = allBtns.map(el => {
        // Walk up to the actual clickable element
        return el.closest('button') || el.closest('div[role="button"]') || el;
    });

    if (isModal) {
        // Attachment preview modal buttons are NOT in footer
        const modalBtns = candidates.filter(el => !el.closest('footer'));
        return modalBtns[modalBtns.length - 1] || null;
    } else {
        // Footer send button
        const footerBtns = candidates.filter(el => el.closest('footer'));
        return footerBtns[0] || candidates[0] || null;
    }
}

// ─── Strategy A: Simulate Enter via keyboard events ──────────────────────────
function simulateEnterKey(target) {
    const opts = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown',  { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keypress', { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keyup',    { ...opts }));
}

// ─── Strategy B: Mutate React fiber state to trigger onChange ─────────────────
function triggerReactInputChange(el, value) {
    try {
        // Find React's internal instance
        const key = Object.keys(el).find(k =>
            k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        if (!key) return false;

        // Use the native input value setter to bypass React's synthetic event system
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLElement.prototype, 'textContent'
        );
        // For contenteditable, we set innerText then dispatch 'input'
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

// ─── Strategy C: Full pointer/mouse/click simulation ─────────────────────────
function simulateRealClick(el) {
    try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 };

        el.dispatchEvent(new PointerEvent('pointerover',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseover',      base));
        el.dispatchEvent(new PointerEvent('pointermove',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousemove',      base));
        el.dispatchEvent(new PointerEvent('pointerdown',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousedown',      base));
        el.dispatchEvent(new PointerEvent('pointerup',    { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseup',        base));
        el.dispatchEvent(new MouseEvent('click',          base));
        el.click(); // native click as final fallback
        console.log("WhatsApp Bulk Sender: Simulated full click on", el.tagName, el.getAttribute('aria-label') || '');
    } catch(e) {
        console.warn("simulateRealClick failed:", e);
    }
}

// ─── Error popup detection ────────────────────────────────────────────────────
function checkErrorPopup() {
    const popup = document.querySelector('[data-testid="popup-controls"]');
    if (popup && document.body.innerText.toLowerCase().includes('invalid')) {
        const ok = popup.querySelector('button');
        if (ok) ok.click();
        return true;
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

// ─── Text sending with layered strategies ────────────────────────────────────
function processTextSegment(maxAttempts = 40) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let stage = 'waiting'; // waiting -> enter_sent -> click_sent -> done

        const tick = async () => {
            attempts++;

            if (checkErrorPopup()) return reject(new Error("Invalid number."));

            const composer = getComposer();

            if (!composer) {
                if (attempts < maxAttempts) return setTimeout(tick, 1000);
                return resolve(); // timeout fallback
            }

            const text = (composer.innerText || composer.textContent || '').trim();

            // ── SUCCESS check: composer is empty after a send attempt ──────
            if (stage !== 'waiting' && text === '') {
                console.log("WhatsApp Bulk Sender: Composer cleared — message sent!");
                return resolve();
            }

            // ── WAITING: text is in the composer, try to send ─────────────
            if (text !== '') {
                composer.focus();
                await sleep(300);

                if (stage === 'waiting') {
                    // Strategy 1: Simulate Enter key events
                    console.log(`[Attempt ${attempts}] Strategy: Enter key simulation`);
                    simulateEnterKey(composer);
                    stage = 'enter_sent';
                    return setTimeout(tick, 2000);
                }

                if (stage === 'enter_sent' && attempts > 3) {
                    // Strategy 2: Click the send button with full event simulation
                    const btn = getSendBtn(false);
                    if (btn) {
                        console.log(`[Attempt ${attempts}] Strategy: Real click on send button`);
                        simulateRealClick(btn);
                        stage = 'click_sent';
                        return setTimeout(tick, 2000);
                    }
                }

                if (stage === 'click_sent' && attempts > 6) {
                    // Strategy 3: Ask background to use debugger API to inject key
                    console.log(`[Attempt ${attempts}] Strategy: Requesting debugger key injection from background`);
                    chrome.runtime.sendMessage({ action: 'INJECT_ENTER_KEY' });
                    stage = 'debugger_sent';
                    return setTimeout(tick, 2500);
                }

                // Keep retrying clicks every few ticks
                if (attempts % 4 === 0) {
                    const btn = getSendBtn(false);
                    if (btn) {
                        console.log(`[Attempt ${attempts}] Retry: clicking send btn`);
                        simulateRealClick(btn);
                    }
                }

                if (attempts % 3 === 0) {
                    console.log(`[Attempt ${attempts}] Retry: Enter key`);
                    simulateEnterKey(composer);
                }
            }

            if (attempts < maxAttempts) return setTimeout(tick, 1000);
            console.log("WhatsApp Bulk Sender: Text send timed out, moving on...");
            resolve();
        };

        setTimeout(tick, 2500); // initial load wait
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
            reject(new Error("Chat did not load in time."));
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
            if (!composer) return reject(new Error("Composer not found for attachment."));

            composer.focus();
            const dt = new DataTransfer();
            dt.items.add(file);
            composer.dispatchEvent(new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: dt
            }));
            console.log("WhatsApp Bulk Sender: Dispatched paste event for attachment.");

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
                            console.log(`[Modal ${attempts}] Strategy: Enter on active element`);
                            const focused = document.activeElement || document.body;
                            simulateEnterKey(focused);
                            const captionInput = document.querySelector('div[contenteditable="true"][data-lexical-editor]')
                                || document.querySelector('div[contenteditable="true"]:not([data-tab])');
                            if (captionInput) simulateEnterKey(captionInput);
                            enterSent = true;
                            return setTimeout(tick, 2000);
                        }
                        if (!clickSent) {
                            console.log(`[Modal ${attempts}] Strategy: Real click on modal send button`);
                            simulateRealClick(btn);
                            clickSent = true;
                            return setTimeout(tick, 2000);
                        }
                        // Keep retrying
                        if (attempts % 3 === 0) simulateRealClick(btn);
                    } else {
                        console.log("Modal send button disabled, waiting for preview...");
                    }
                    if (attempts < maxAttempts) return setTimeout(tick, 1000);
                    reject(new Error("Attachment modal send button never became clickable."));
                } else {
                    if (modalSeen) {
                        console.log("WhatsApp Bulk Sender: Attachment modal closed — sent!");
                        return setTimeout(resolve, 1000);
                    }
                    if (attempts < maxAttempts) return setTimeout(tick, 1000);
                    reject(new Error("Attachment preview modal never appeared."));
                }
            };

            setTimeout(tick, 2500);
        } catch(e) {
            reject(new Error("Attachment error: " + e.message));
        }
    });
}
