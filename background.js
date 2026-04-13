let queue = [];
let currentIndex = 0;
let isPaused = false;
let isStopped = true;
let logs = [];
let template = "";
let attachmentData = null;

function log(msg, type = 'system') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    logs.unshift(entry);
    if (logs.length > 200) logs.pop();
    console.log(`[${type}] ${msg}`);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'START_CAMPAIGN') {
            queue = request.queue;
            template = request.template;
            attachmentData = request.attachmentData;
            currentIndex = 0;
            isPaused = false;
            isStopped = false;
            logs = [];
            log(`Campaign started. Targets: ${queue.length}`, 'system');
            processNext();
            sendResponse({status: "ok"});
        } else if (request.action === 'PAUSE_CAMPAIGN') {
            isPaused = !isPaused;
            log(isPaused ? "Campaign paused." : "Campaign resumed.", 'system');
            if (!isPaused) processNext();
            sendResponse({status: "ok"});
        } else if (request.action === 'STOP_CAMPAIGN') {
            isStopped = true;
            log("Campaign stopped by user.", 'error');
            sendResponse({status: "ok"});
        } else if (request.action === 'ADD_LOG') {
            log(request.msg, request.type);
            sendResponse({status: "ok"});
        } else if (request.action === 'GET_STATE') {
            sendResponse({
                queueLength: queue.length,
                currentIndex,
                isPaused,
                isStopped,
                logs
            });
        }
    } catch(e) {
        console.error(e);
        sendResponse({status: "error"});
    }
    return true;
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function processNext() {
    if (isStopped || currentIndex >= queue.length) {
        if (!isStopped && currentIndex >= queue.length && queue.length > 0) {
            log("All tasks completed.", 'success');
        }
        isStopped = true;
        return;
    }

    if (isPaused) return;

    const contact = queue[currentIndex];
    const finalMsg = template.replace(/{name}/gi, contact.name).replace(/{phone}/gi, contact.phone);

    log(`Sending to ${contact.name} (${contact.phone})...`, 'system');

    try {
        const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const currentTabId = currentTabs.length > 0 ? currentTabs[0].id : null;

        const allWaTabs = await chrome.tabs.query({ url: "*://web.whatsapp.com/*" });
        let waTab = allWaTabs.find(t => t.id !== currentTabId);
        
        const waUrl = `https://web.whatsapp.com/send?phone=${contact.phone}` + (finalMsg.trim() ? `&text=${encodeURIComponent(finalMsg)}` : "");
        
        if (waTab) {
            await chrome.tabs.update(waTab.id, { url: waUrl, active: false });
        } else {
            waTab = await chrome.tabs.create({ url: waUrl, active: false });
        }

        await sleep(5000); 

        const payload = { 
            action: "SEND_MESSAGE",
            attachment: attachmentData
        };

        const response = await chrome.tabs.sendMessage(waTab.id, payload);
        
        if (response && response.status === "SUCCESS") {
            log(`Success: Sent to ${contact.name}`, 'success');
            currentIndex++;
            
            if (currentIndex < queue.length) {
                const delay = Math.floor(Math.random() * 10000) + 5000;
                log(`Waiting ${Math.round(delay/1000)}s...`, 'wait');
                setTimeout(processNext, delay);
            } else {
                processNext();
            }
        } else {
            throw new Error(response?.message || "Failed to click send button.");
        }

    } catch (err) {
        log(`Error with ${contact.name}: ${err.message}`, 'error');
        currentIndex++;
        setTimeout(processNext, 5000);
    }
}
