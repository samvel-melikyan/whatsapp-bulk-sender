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
                try { sendResponse({ status: "SUCCESS" }); } catch (e) { }
            })
            .catch((err) => {
                console.error("WhatsApp Bulk Sender Error:", err);
                try { sendResponse({ status: "ERROR", message: err.message }); } catch (e) { }
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
        '[class="html-button xdj266r x14z9mp xat24cr x1lziwak xexx8yu xyri2b x18d9i69 x1c1uobl x178xt8z x1lun4ml xso031l xpilrb4 x1n2onr6 x1ejq31n x18oe1m7 x1sy0etr xstzfhl x1so62im x1ja2u2z x1ypdohk x1s928wv x1j6awrg x4eaejv x1wsn0xg x1r0yslu x2q1x1w xapdjt xr6f91l x5rv0tg x1akc3lz xikp0eg x1xl5mkn x1mfml39 x1l5mzlr xgmdoj8 x1f1wgk5 x1x3ic1u xfn3atn x1pse0pq x1yxkqql xtnn1bt x9v5kkp xmw7ebm xrdum7p x3oybdh x6nhntm x2lah0s x1lliihq xk8lq53 x9f619 xt8t1vi x1xc408v x129tdwq x15urzxu x1vqgdyp x100vrsf"]',
        '[data-tab="11"]',
        '[aria-label="Send"]',


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
    target.dispatchEvent(new KeyboardEvent('keydown', { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keypress', { ...opts }));
    target.dispatchEvent(new KeyboardEvent('keyup', { ...opts }));
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
    } catch (e) {
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

        el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousedown', base));
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseup', base));
        el.dispatchEvent(new MouseEvent('click', base));

        setTimeout(() => {
            if (document.body.contains(el)) el.click();
        }, 50);
    } catch (e) {
        console.warn("simulateRealClick failed:", e);
    }
}

// ─── Error popup detection (Invalid Numbers) ──────────────────────────────────
function checkErrorPopup() {
    const popup = document.querySelector('[data-testid="popup-controls"]') ||
        document.querySelector('div[role="dialog"]') ||
        document.querySelector('.x1n2onr6');

    if (popup) {
        const text = popup.innerText.toLowerCase();
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
        let stage = 'waiting';

        const tick = async () => {
            attempts++;

            if (checkErrorPopup()) {
                console.log("WhatsApp Bulk Sender: Detected invalid number popup.");
                return reject(new Error("Invalid number."));
            }

            const composer = getComposer();

            if (!composer) {
                if (attempts < maxAttempts) return setTimeout(tick, 1000);
                return resolve();
            }

            const text = (composer.innerText || composer.textContent || '').trim();

            if (stage !== 'waiting' && text === '') {
                console.log("WhatsApp Bulk Sender: Message sent!");
                return resolve();
            }

            if (text !== '') {
                composer.focus();

                if (stage === 'waiting') {
                    triggerReactInputChange(composer, text);
                    await sleep(500);

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

    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }

    try {
        return new File([u8arr], filename, { type: mimeType });
    } catch (e) {
        return new Blob([u8arr], { type: mimeType });
    }
}

// ─── SEND ATTACHMENT ─────────────────────────────────────────────────────────
async function sendAttachment(attachData) {
    console.log("WhatsApp Bulk Sender: Sending attachment...");

    const attachBtn = document.querySelector('[data-testid="clip"]');
    if (!attachBtn) throw new Error("Attachment button not found.");

    attachBtn.click();
    await sleep(500);

    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("Attachment file input not found.");

    const file = base64ToFile(attachData.dataUrl, attachData.filename, attachData.mimeType);

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1000);

    const sendBtn = getSendBtn(true);
    if (!sendBtn) throw new Error("Could not find modal send button.");

    simulateRealClick(sendBtn);

    await sleep(1500);
    console.log("WhatsApp Bulk Sender: Attachment sent.");
}