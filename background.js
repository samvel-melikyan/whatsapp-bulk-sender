let queue = [];
let currentIndex = 0;
let isPaused = false;
let isStopped = true;
let logs = [];
let template = "";
let hasAttachmentFlag = false;
let activeTabId = null;

// Per-contact result tracking
let results = {
    sent: [],       // { phone, name }
    failed: [],     // { phone, name, reason }
    invalid: []     // { phone, name }
};

const MAX_NUMBERS = 200;

function log(msg, type = 'system') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    logs.unshift(entry);
    if (logs.length > 300) logs.pop();
    console.log(`[${type}] ${msg}`);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'START_CAMPAIGN') {
            queue = request.queue.slice(0, MAX_NUMBERS);
            template = request.template;
            hasAttachmentFlag = request.hasAttachment;
            currentIndex = 0;
            isPaused = false;
            isStopped = false;
            logs = [];
            results = { sent: [], failed: [], invalid: [] };
            log(`Campaign started. Targets: ${queue.length} (max ${MAX_NUMBERS})`, 'system');
            processNext();
            sendResponse({ status: "ok" });

        } else if (request.action === 'PAUSE_CAMPAIGN') {
            isPaused = !isPaused;
            log(isPaused ? "Campaign paused." : "Campaign resumed.", 'system');
            if (!isPaused) processNext();
            sendResponse({ status: "ok" });

        } else if (request.action === 'STOP_CAMPAIGN') {
            isStopped = true;
            detachDebugger();
            log("Campaign stopped by user.", 'error');
            sendResponse({ status: "ok" });

        } else if (request.action === 'RESET_STATE') {
            queue = [];
            currentIndex = 0;
            isStopped = true;
            isPaused = false;
            logs = [];
            results = { sent: [], failed: [], invalid: [] };
            detachDebugger();
            sendResponse({ status: "ok" });

        } else if (request.action === 'ADD_LOG') {
            log(request.msg, request.type);
            sendResponse({ status: "ok" });

        } else if (request.action === 'GET_STATE') {
            sendResponse({
                queueLength: queue.length,
                currentIndex,
                isPaused,
                isStopped,
                logs,
                results
            });

        } else if (request.action === 'INJECT_ENTER_KEY') {
            if (activeTabId) {
                injectEnterViaDebugger(activeTabId)
                    .then(() => { try { sendResponse({ status: "ok" }); } catch(e) {} })
                    .catch(e => { try { sendResponse({ status: "error", message: e.message }); } catch(_) {} });
            } else {
                sendResponse({ status: "no_tab" });
            }
            return true;
        }
    } catch(e) {
        console.error("Background error:", e);
        try { sendResponse({ status: "error" }); } catch(_) {}
    }
    return true;
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Debugger API: inject real Enter keypress ─────────────────────────────────
async function injectEnterViaDebugger(tabId) {
    const target = { tabId };
    try {
        await chrome.debugger.attach(target, "1.3");
    } catch(e) {
        if (!e.message.includes('already attached')) throw e;
    }

    const keyParams = {
        key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        unmodifiedText: "\r", text: "\r"
    };

    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...keyParams, type: "rawKeyDown" });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...keyParams, type: "char", text: "\r", unmodifiedText: "\r" });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...keyParams, type: "keyUp" });

    console.log("Debugger: Enter key injected into tab", tabId);
}

async function detachDebugger() {
    if (activeTabId) {
        try { await chrome.debugger.detach({ tabId: activeTabId }); } catch(e) {}
    }
}

// ─── Main processing loop ─────────────────────────────────────────────────────
async function processNext() {
    if (isStopped || currentIndex >= queue.length) {
        if (!isStopped && currentIndex >= queue.length && queue.length > 0) {
            log(`✅ Campaign complete! Sent: ${results.sent.length} | Failed: ${results.failed.length} | Invalid: ${results.invalid.length}`, 'success');
            await detachDebugger();
        }
        isStopped = true;
        return;
    }

    if (isPaused) return;

    const contact = queue[currentIndex];
    let finalMsg = template
        .replace(/{name}/gi, contact.name || '')
        .replace(/{phone}/gi, contact.phone || '');

    if (contact.price) {
        finalMsg = finalMsg.replace(/{price}/gi, contact.price);
    }

    log(`📤 [${currentIndex + 1}/${queue.length}] Sending to ${contact.name} (${contact.phone})...`, 'system');

    try {
        const allWaTabs = await chrome.tabs.query({ url: "*://web.whatsapp.com/*" });
        let waTab = allWaTabs.length > 0 ? allWaTabs[0] : null;

        const waUrl = `https://web.whatsapp.com/send?phone=${contact.phone}` +
            (finalMsg.trim() ? `&text=${encodeURIComponent(finalMsg)}` : '');

        if (waTab) {
            await chrome.tabs.update(waTab.id, { url: waUrl, active: true });
            activeTabId = waTab.id;
        } else {
            waTab = await chrome.tabs.create({ url: waUrl, active: true });
            activeTabId = waTab.id;
        }

        await sleep(6000);

        const payload = { action: "SEND_MESSAGE", hasAttachment: hasAttachmentFlag };
        let response;
        try {
            response = await chrome.tabs.sendMessage(activeTabId, payload);
        } catch(e) {
            log(`Content script not ready, retrying...`, 'system');
            await sleep(4000);
            response = await chrome.tabs.sendMessage(activeTabId, payload);
        }

        if (response && response.status === "SUCCESS") {
            log(`✅ Sent to ${contact.name} (${contact.phone})`, 'success');
            results.sent.push({ phone: contact.phone, name: contact.name });
            currentIndex++;

            if (currentIndex < queue.length) {
                const delay = Math.floor(Math.random() * 12000) + 8000;
                log(`⏳ Next in ${Math.round(delay / 1000)}s...`, 'wait');
                setTimeout(processNext, delay);
            } else {
                processNext();
            }
        } else {
            const errMsg = response?.message || "Send failed (no success response).";
            throw new Error(errMsg);
        }

    } catch(err) {
        const reason = err.message || "Unknown error";
        const isInvalid = reason.toLowerCase().includes('invalid');

        if (isInvalid) {
            log(`🚫 Invalid WA number: ${contact.phone}`, 'error');
            results.invalid.push({ phone: contact.phone, name: contact.name });
        } else {
            log(`❌ Failed – ${contact.name} (${contact.phone}): ${reason}`, 'error');
            results.failed.push({ phone: contact.phone, name: contact.name, reason });
        }

        currentIndex++;
        setTimeout(processNext, 7000);
    }
}
