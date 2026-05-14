let queue = [];
let hasAttachmentFlag = false;
const MAX_NUMBERS = 200;

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

    // Live number counter for manual tab
    const numbersArea = document.getElementById('numbers');
    const numCount = document.getElementById('num-count');
    const updateCounter = () => {
        const count = numbersArea.value.split(/\n/).filter(n => n.trim()).length;
        numCount.textContent = `${Math.min(count, MAX_NUMBERS)} / ${MAX_NUMBERS}`;
        numCount.style.color = count > MAX_NUMBERS ? '#ff4d4d' : '#25D366';
        if (count > MAX_NUMBERS) {
            numCount.textContent = `${count} / ${MAX_NUMBERS} ⚠️ Limit: ${MAX_NUMBERS}`;
        }
    };
    numbersArea.addEventListener('input', updateCounter);
    numbersArea.addEventListener('paste', () => setTimeout(updateCounter, 10));

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
    document.getElementById('pause-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'PAUSE_CAMPAIGN' });
        setTimeout(pollState, 100);
    });
    document.getElementById('stop-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'STOP_CAMPAIGN' });
        setTimeout(pollState, 100);
    });
    document.getElementById('reset-btn').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'RESET_STATE' }, () => pollState());
    });

    // Attachment Input Handling
    const attachInput = document.getElementById('attachment-file');
    const attachBtn = document.getElementById('attach-btn');
    const clearAttachBtn = document.getElementById('clear-attach-btn');
    const attachName = document.getElementById('attachment-name');

    attachBtn.addEventListener('click', () => attachInput.click());

    attachInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 15 * 1024 * 1024) {
            localLog("File too large. Please use files under 15MB.", "error");
            attachInput.value = "";
            return;
        }

        localLog(`Reading attachment: ${file.name}...`, 'system');
        const reader = new FileReader();
        reader.onload = (event) => {
            const data = {
                dataUrl: event.target.result,
                filename: file.name,
                type: file.type
            };
            chrome.storage.local.set({ attachmentData: data }, () => {
                hasAttachmentFlag = true;
                attachName.innerText = file.name;
                clearAttachBtn.style.display = "inline-block";
                localLog(`Attachment ready.`, 'success');
            });
        };
        reader.readAsDataURL(file);
    });

    clearAttachBtn.addEventListener('click', () => {
        chrome.storage.local.remove('attachmentData', () => {
            hasAttachmentFlag = false;
            attachInput.value = "";
            attachName.innerText = "";
            clearAttachBtn.style.display = "none";
            localLog("Attachment removed.", "system");
        });
    });

    // Start State Polling
    setInterval(pollState, 1000);
    pollState(); // Fetch initially without waiting
});

function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const text = event.target.result;
        try {
            queue = parseCSV(text);
            localLog(`Loaded ${queue.length} contacts from CSV.`, 'success');
        } catch (err) {
            localLog(`CSV Error: ${err.message}`, 'error');
        }
    };
    reader.readAsText(file);
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('number'));
    const nameIdx  = headers.findIndex(h => h.includes('name'));
    const priceIdx = headers.findIndex(h => h.includes('price') || h.includes('amount'));

    if (phoneIdx === -1) throw new Error("Could not find 'phone' or 'number' column in CSV.");

    const contacts = lines.slice(1).map(line => {
        const parts = line.split(',').map(p => p.trim());
        let cleanedPhone = (parts[phoneIdx] || '').replace(/[^\d+]/g, '');
        if (cleanedPhone.startsWith('0')) {
            cleanedPhone = '374' + cleanedPhone.substring(1);
        } else if (cleanedPhone.startsWith('+')) {
            cleanedPhone = cleanedPhone.substring(1);
        } else if (cleanedPhone.length === 8 && !cleanedPhone.startsWith('374')) {
            cleanedPhone = '374' + cleanedPhone;
        }

        return {
            phone: cleanedPhone,
            name:  nameIdx  !== -1 ? parts[nameIdx]  : parts[phoneIdx],
            price: priceIdx !== -1 ? parts[priceIdx] : '',
            rawData: parts
        };
    }).filter(c => c.phone);

    if (contacts.length > MAX_NUMBERS) {
        localLog(`⚠️ CSV has ${contacts.length} rows. Only first ${MAX_NUMBERS} will be sent.`, 'error');
        return contacts.slice(0, MAX_NUMBERS);
    }
    return contacts;
}

function startCampaign() {
    const currentTab = document.querySelector('.tab-btn.active').dataset.tab;

    if (currentTab === 'manual') {
        const rawNumbers = document.getElementById('numbers').value
            .split(/\n/)
            .map(n => n.trim())
            .filter(n => n);

        if (rawNumbers.length > MAX_NUMBERS) {
            localLog(`⚠️ ${rawNumbers.length} numbers entered. Only first ${MAX_NUMBERS} will be sent.`, 'error');
        }

        queue = rawNumbers.slice(0, MAX_NUMBERS).map(n => {
            let cleanedPhone = n.replace(/[^\d+]/g, '');
            if (cleanedPhone.startsWith('0')) {
                cleanedPhone = '374' + cleanedPhone.substring(1);
            } else if (cleanedPhone.startsWith('+')) {
                cleanedPhone = cleanedPhone.substring(1);
            } else if (cleanedPhone.length === 8 && !cleanedPhone.startsWith('374')) {
                cleanedPhone = '374' + cleanedPhone;
            }
            return { phone: cleanedPhone, name: 'Contact', price: '' };
        });
    }

    if (queue.length === 0) {
        localLog("No numbers found to process.", "error");
        return;
    }

    const template = document.getElementById('message').value;
    if (!template.trim() && !hasAttachmentFlag) {
        localLog("Please enter a message or select an attachment.", "error");
        return;
    }

    chrome.runtime.sendMessage({
        action: 'START_CAMPAIGN',
        queue: queue,
        template: template,
        hasAttachment: hasAttachmentFlag
    }, () => {
        localLog("Sent to background tracker...", "system");
        setTimeout(pollState, 300);
    });
}

function pollState() {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
        if (chrome.runtime.lastError || !state) return;

        toggleUI(state);

        if (state.queueLength > 0) {
            const percent = (state.currentIndex / state.queueLength) * 100;
            document.getElementById('progress-fill').style.width = `${percent}%`;
            document.getElementById('progress-text').innerText = `${state.currentIndex} / ${state.queueLength} Sent`;
        }

        renderLogs(state.logs);
    });
}

function localLog(msg, type = 'system') {
    chrome.runtime.sendMessage({ action: 'ADD_LOG', msg, type });
}

function renderLogs(logArray) {
    if (!logArray || logArray.length === 0) return;

    const logContainer = document.getElementById('log');
    logContainer.innerHTML = '';
    logArray.forEach(entry => {
        const div = document.createElement('div');
        div.className = `log-entry ${entry.type}`;
        div.innerText = `[${entry.time}] ${entry.msg}`;
        logContainer.appendChild(div);
    });
}

function toggleUI(state) {
    const setupView = document.getElementById('setup-view');
    const progressView = document.getElementById('progress-view');
    const reportView = document.getElementById('report-view');

    if (!state || state.queueLength === 0) {
        setupView.style.display = 'block';
        progressView.style.display = 'none';
        reportView.style.display = 'none';
    } else if (state.queueLength > 0 && !state.isStopped) {
        setupView.style.display = 'none';
        progressView.style.display = 'block';
        reportView.style.display = 'none';

        document.getElementById('pause-btn').innerText = state.isPaused ? "Resume" : "Pause";
    } else if (state.queueLength > 0 && state.isStopped) {
        setupView.style.display = 'none';
        progressView.style.display = 'none';
        reportView.style.display = 'block';

        document.getElementById('report-sent').innerText = state.currentIndex;
    }
}
