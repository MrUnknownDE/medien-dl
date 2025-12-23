document.addEventListener('DOMContentLoaded', () => {
    const dom = {
        // Form & Main
        form: document.getElementById('upload-form'),
        urlInput: document.getElementById('url'),
        submitBtn: document.getElementById('submit-button'),
        platformInput: document.getElementById('input-platform'),
        
        // Detection UI
        detectionArea: document.getElementById('detection-area'),
        detectedText: document.getElementById('detected-text'),
        detectedIcon: document.getElementById('detected-icon'),
        urlIcon: document.getElementById('url-icon'),
        
        // Options
        optionsContainer: document.getElementById('options-container'),
        ytOptions: document.getElementById('youtube-options'),
        codecSection: document.getElementById('codec-options-section'),
        ytRadios: document.querySelectorAll('input[name="yt_format"]'),
        mp3Select: document.getElementById('mp3_bitrate'),
        mp4Select: document.getElementById('mp4_quality'),
        codecSwitch: document.getElementById('codec-switch'),
        codecPref: document.getElementById('codec_preference'),
        
        // Views
        processView: document.getElementById('process-view'),
        resultView: document.getElementById('result-view'),
        formContainer: document.querySelector('.form-container'),
        
        // Progress & Logs
        statusMsg: document.getElementById('status-message'),
        progressBar: document.getElementById('progress-bar'),
        logContent: document.getElementById('pseudo-log-content'),
        
        // Result
        resultUrl: document.getElementById('result-url'),
        errorMsg: document.getElementById('error-message'),
        
        // History
        historyTableBody: document.querySelector('#history-table tbody'),
        clearHistoryBtn: document.getElementById('clear-history-button')
    };

    let currentJobId = null;
    let pollingInterval = null;
    let pseudoLogInterval = null;

    const platforms = [
        { name: 'SoundCloud', pattern: /soundcloud\.com/, icon: 'fa-soundcloud', color: '#ff5500' },
        { name: 'YouTube', pattern: /(youtube\.com|youtu\.be)/, icon: 'fa-youtube', color: '#ff0000' },
        { name: 'TikTok', pattern: /tiktok\.com/, icon: 'fa-tiktok', color: '#fe2c55' },
        { name: 'Instagram', pattern: /instagram\.com/, icon: 'fa-instagram', color: '#E1306C' },
        { name: 'Twitter', pattern: /(twitter\.com|x\.com)/, icon: 'fa-x-twitter', color: '#fff' }
    ];

    const pseudoLogs = [
        "Connecting to media node...",
        "Handshaking with API...",
        "Resolving stream URL...",
        "Allocating buffer...",
        "Starting download stream...",
        "Processing data chunks...",
        "Verifying integrity...",
        "Optimizing container...",
        "Finalizing upload..."
    ];

    function init() {
        setupEvents();
        loadHistory();
    }

    function setupEvents() {
        dom.urlInput.addEventListener('input', handleUrlInput);
        dom.form.addEventListener('submit', handleSubmit);
        
        dom.ytRadios.forEach(r => r.addEventListener('change', updateYtOptions));
        if(dom.codecSwitch) {
            dom.codecSwitch.addEventListener('change', e => {
                dom.codecPref.value = e.target.checked ? 'h264' : 'original';
            });
        }
        
        if(dom.clearHistoryBtn) dom.clearHistoryBtn.addEventListener('click', clearHistory);
    }

    // --- Detection ---
    function handleUrlInput() {
        const url = dom.urlInput.value.trim();
        const detected = platforms.find(p => p.pattern.test(url));
        
        if (detected) {
            dom.platformInput.value = detected.name;
            dom.detectedText.textContent = detected.name + " detected";
            dom.detectedIcon.className = `fab ${detected.icon}`;
            dom.detectionArea.style.opacity = '1';
            dom.detectionArea.style.transform = 'translateY(0)';
            
            // Icon in Input
            dom.urlIcon.className = `fab ${detected.icon}`;
            dom.urlIcon.style.color = detected.color;
            
            showOptions(detected.name);
        } else {
            if(url.length === 0) {
                dom.detectionArea.style.opacity = '0';
                dom.detectionArea.style.transform = 'translateY(-10px)';
                dom.urlIcon.className = 'fas fa-link';
                dom.urlIcon.style.color = '';
            }
            // Keep options hidden if no match
        }
    }

    function showOptions(platform) {
        dom.ytOptions.classList.add('d-none');
        dom.codecSection.classList.add('d-none');
        
        if (platform === 'YouTube') {
            dom.ytOptions.classList.remove('d-none');
            updateYtOptions();
        } else if (['TikTok', 'Instagram', 'Twitter'].includes(platform)) {
            dom.codecSection.classList.remove('d-none');
        }
    }

    function updateYtOptions() {
        const format = document.querySelector('input[name="yt_format"]:checked').value;
        if (format === 'mp3') {
            dom.mp3Select.classList.remove('d-none');
            dom.mp4Select.classList.add('d-none');
        } else {
            dom.mp3Select.classList.add('d-none');
            dom.mp4Select.classList.remove('d-none');
        }
    }

    // --- Processing ---
    async function handleSubmit(e) {
        e.preventDefault();
        
        // UI Switch
        dom.formContainer.classList.add('d-none');
        dom.processView.classList.remove('d-none');
        dom.resultView.classList.add('d-none');
        dom.errorMsg.classList.add('d-none');
        
        startPseudoLogs();

        const formData = new FormData(dom.form);
        try {
            const res = await fetch('/start_download', { method: 'POST', body: formData });
            const data = await res.json();
            
            if (res.ok && data.job_id) {
                currentJobId = data.job_id;
                startPolling();
            } else {
                throw new Error(data.error || "Start failed");
            }
        } catch (err) {
            showError(err.message);
        }
    }

    function startPolling() {
        pollingInterval = setInterval(async () => {
            try {
                if(!currentJobId) return;
                const res = await fetch(`/status?job_id=${currentJobId}`);
                if (res.status === 404) { showError("Job not found"); return; }
                
                const status = await res.json();
                
                // Update UI
                dom.progressBar.style.width = (status.progress || 0) + "%";
                if(status.message) dom.statusMsg.textContent = status.message.toUpperCase();

                if (status.status === 'completed') {
                    finishJob(status.result_url);
                } else if (status.status === 'error' || status.error) {
                    showError(status.error || status.message);
                }
            } catch (e) {
                console.error(e);
            }
        }, 1000);
    }

    function finishJob(url) {
        clearInterval(pollingInterval);
        clearInterval(pseudoLogInterval);
        
        dom.processView.classList.add('d-none');
        dom.resultView.classList.remove('d-none');
        dom.resultUrl.href = url;
        
        saveHistory(url);
    }

    function showError(msg) {
        clearInterval(pollingInterval);
        clearInterval(pseudoLogInterval);
        
        dom.processView.classList.add('d-none');
        dom.formContainer.classList.remove('d-none'); // Back to form
        dom.errorMsg.textContent = msg;
        dom.errorMsg.classList.remove('d-none');
    }

    // --- Pseudo Logs (CLI Effect) ---
    function startPseudoLogs() {
        dom.logContent.innerHTML = '';
        let index = 0;
        
        function addLine() {
            if (index >= pseudoLogs.length) index = 0; // Loop or stop
            const div = document.createElement('div');
            div.className = 'terminal-line';
            div.textContent = "> " + pseudoLogs[index];
            dom.logContent.appendChild(div);
            
            // Auto scroll
            const win = document.querySelector('.terminal-window .terminal-body');
            win.scrollTop = win.scrollHeight;
            
            index++;
        }
        
        addLine(); // First one immediate
        pseudoLogInterval = setInterval(addLine, 2000);
    }

    // --- Local History ---
    function loadHistory() {
        const raw = localStorage.getItem('mdl_history');
        if(!raw) {
            dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-white-50 py-3">No history available</td></tr>';
            return;
        }
        
        let data = JSON.parse(raw);
        // Clean expired (>7 days)
        const now = Date.now();
        data = data.filter(i => (now - i.ts) < (7 * 24 * 60 * 60 * 1000));
        localStorage.setItem('mdl_history', JSON.stringify(data));
        
        renderHistory(data);
    }

    function renderHistory(data) {
        dom.historyTableBody.innerHTML = '';
        data.forEach(item => {
            const date = new Date(item.ts);
            const time = date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="ps-4 text-white-50 small font-monospace">${time}</td>
                <td class="text-center text-primary-light small">${item.platform}</td>
                <td class="text-truncate" style="max-width: 150px;">${item.title || 'Unknown'}</td>
                <td class="text-center">
                    <a href="${item.source}" target="_blank" class="text-white-50" title="Open source: ${item.source}">
                        <i class="fas fa-link"></i>
                    </a>
                </td>
                <td class="text-end pe-4">
                    <a href="${item.url}" target="_blank" class="text-primary-light" title="Download">
                        <i class="fas fa-download"></i>
                    </a>
                </td>
            `;
            dom.historyTableBody.appendChild(tr);
        });
    }

    function saveHistory(resultUrl) {
        const pf = dom.platformInput.value;
        const sourceUrl = dom.urlInput.value; // Capture source URL
        
        const entry = {
            url: resultUrl,       
            source: sourceUrl,    
            platform: pf,
            title: pf + " Download", 
            ts: Date.now()
        };
        
        let data = JSON.parse(localStorage.getItem('mdl_history') || '[]');
        data.unshift(entry);
        if(data.length > 20) data.pop(); // Max 20 entries
        localStorage.setItem('mdl_history', JSON.stringify(data));
        loadHistory();
    }

    function clearHistory() {
        if(confirm("Really clear history?")) {
            localStorage.removeItem('mdl_history');
            loadHistory();
        }
    }

    init();
});