let queue = [];
let isPaused = false;
let isStopped = false;
let currentIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`${tab.dataset.tab}-tab`).classList.add('active');
        });
    });

    // Placeholder insertion
    const phBtns = document.querySelectorAll('.ph-btn');
    const msgArea = document.getElementById('message');
    phBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const pos = msgArea.selectionStart;
            const text = msgArea.value;
            msgArea.value = text.slice(0, pos) + btn.dataset.ph + text.slice(pos);
            msgArea.focus();
        });
    });

    // CSV Handling
    const fileInput = document.getElementById('csv-file');
    const dropZone = document.getElementById('drop-zone');
    dropZone.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', handleFile);
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--primary)';
    });
    dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = 'var(--glass)');
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = 'var(--glass)';
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFile({ target: fileInput });
        }
    });

    // Control Buttons
    document.getElementById('start-btn').addEventListener('click', startCampaign);
    document.getElementById('pause-btn').addEventListener('click', togglePause);
    document.getElementById('stop-btn').addEventListener('click', stopCampaign);
});

function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const text = event.target.result;
        try {
            queue = parseCSV(text);
            log(`Loaded ${queue.length} contacts from CSV.`, 'success');
            updateProgress();
        } catch (err) {
            log(`CSV Error: ${err.message}`, 'error');
        }
    };
    reader.readAsText(file);
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('number'));
    const nameIdx = headers.findIndex(h => h.includes('name'));

    if (phoneIdx === -1) throw new Error("Could not find 'phone' or 'number' column in CSV.");

    return lines.slice(1).map(line => {
        const parts = line.split(',').map(p => p.trim());
        let cleanedPhone = parts[phoneIdx].replace(/[^\d+]/g, ''); // Keep digits and +
        if (cleanedPhone.startsWith('0')) {
            cleanedPhone = '374' + cleanedPhone.substring(1);
        } else if (cleanedPhone.startsWith('+')) {
            cleanedPhone = cleanedPhone.substring(1); // WhatsApp API usually expects without +
        }
        
        return {
            phone: cleanedPhone,
            name: nameIdx !== -1 ? parts[nameIdx] : parts[phoneIdx],
            rawData: parts
        };
    }).filter(contact => contact.phone);
}

async function startCampaign() {
    const currentTab = document.querySelector('.tab-btn.active').dataset.tab;
    
    if (currentTab === 'manual') {
        const rawNumbers = document.getElementById('numbers').value.split(/\n/).filter(n => n.trim());
        queue = rawNumbers.map(n => {
            let cleanedPhone = n.trim().replace(/[^\d+]/g, '');
            if (cleanedPhone.startsWith('0')) {
                cleanedPhone = '374' + cleanedPhone.substring(1);
            } else if (cleanedPhone.startsWith('+')) {
                cleanedPhone = cleanedPhone.substring(1);
            }
            return { 
                phone: cleanedPhone, 
                name: 'Contact' 
            };
        });
    }

    if (queue.length === 0) {
        log("No numbers found to process.", "error");
        return;
    }

    const template = document.getElementById('message').value;
    if (!template) {
        log("Please enter a message.", "error");
        return;
    }

    isStopped = false;
    isPaused = false;
    currentIndex = 0;
    
    toggleUI(true);
    log(`Campaign started. Targets: ${queue.length}`, 'system');
    
    processNext();
}

async function processNext() {
    if (isStopped || currentIndex >= queue.length) {
        finishCampaign();
        return;
    }

    if (isPaused) return;

    const contact = queue[currentIndex];
    const template = document.getElementById('message').value;
    const finalMsg = template.replace(/{name}/gi, contact.name).replace(/{phone}/gi, contact.phone);

    log(`Sending to ${contact.name} (${contact.phone})...`, 'system');

    try {
        // Step 1: Open/Update WhatsApp Tab
        // We look for an existing WhatsApp Web tab or open a new one
        const tabs = await chrome.tabs.query({ url: "*://web.whatsapp.com/*" });
        let waTab;
        
        const waUrl = `https://web.whatsapp.com/send?phone=${contact.phone}&text=${encodeURIComponent(finalMsg)}`;
        
        if (tabs.length > 0) {
            waTab = tabs[0];
            await chrome.tabs.update(waTab.id, { url: waUrl, active: false });
        } else {
            waTab = await chrome.tabs.create({ url: waUrl, active: false });
        }

        // Step 2: Wait for tab to load and message the content script
        // We'll wait a few seconds for redirect to finish
        await sleep(5000); 

        const response = await chrome.tabs.sendMessage(waTab.id, { action: "SEND_MESSAGE" });
        
        if (response && response.status === "SUCCESS") {
            log(`Success: Sent to ${contact.name}`, 'success');
            currentIndex++;
            updateProgress();
            
            if (currentIndex < queue.length) {
                const delay = Math.floor(Math.random() * 10000) + 5000; // 5-15s delay
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
        // Optionally skip and continue
        currentIndex++;
        updateProgress();
        setTimeout(processNext, 5000);
    }
}

function updateProgress() {
    const percent = (currentIndex / queue.length) * 100;
    document.getElementById('progress-fill').style.width = `${percent}%`;
    document.getElementById('progress-text').innerText = `${currentIndex}/${queue.length} Sent`;
}

function log(msg, type = 'system') {
    const logContainer = document.getElementById('log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logContainer.prepend(entry);
}

function togglePause() {
    isPaused = !isPaused;
    document.getElementById('pause-btn').innerText = isPaused ? "Resume" : "Pause";
    if (!isPaused) {
        log("Campaign resumed.", 'system');
        processNext();
    } else {
        log("Campaign paused.", 'system');
    }
}

function stopCampaign() {
    isStopped = true;
    log("Campaign stopped by user.", 'error');
    finishCampaign();
}

function finishCampaign() {
    toggleUI(false);
    log("All tasks completed.", 'success');
}

function toggleUI(running) {
    document.getElementById('start-btn').disabled = running;
    document.getElementById('pause-btn').disabled = !running;
    document.getElementById('stop-btn').disabled = !running;
    document.getElementById('numbers').disabled = running;
    document.getElementById('message').disabled = running;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
