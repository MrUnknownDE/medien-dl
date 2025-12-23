document.addEventListener('DOMContentLoaded', () => {
    // --- Selektoren ---
    const dom = {
        form: document.getElementById('upload-form'),
        urlInput: document.getElementById('url'),
        platformInput: document.getElementById('input-platform'),
        submitBtn: document.getElementById('submit-button'),
        
        // Detection Feedback
        badgeContainer: document.getElementById('platform-badge-container'),
        detectedIcon: document.getElementById('detected-icon'),
        detectedText: document.getElementById('detected-text'),
        urlIcon: document.getElementById('url-icon'),

        // Options
        optionsContainer: document.getElementById('options-container'),
        ytOptions: document.getElementById('youtube-options'),
        codecSection: document.getElementById('codec-options-section'),
        
        // YouTube Specifics
        ytFormatRadios: document.querySelectorAll('input[name="yt_format"]'),
        qualityWrapper: document.getElementById('quality-wrapper'),
        mp3Select: document.getElementById('mp3_bitrate'),
        mp4Select: document.getElementById('mp4_quality'),
        
        // Codec Switch
        codecSwitch: document.getElementById('codec-switch'),
        codecPreference: document.getElementById('codec_preference'),

        // Progress & Result
        progressContainer: document.getElementById('progress-container'),
        progressBar: document.getElementById('progress-bar'),
        statusMessage: document.getElementById('status-message'),
        logContent: document.getElementById('log-content'),
        resultContainer: document.getElementById('result-container'),
        resultUrl: document.getElementById('result-url'),
        errorMessage: document.getElementById('error-message'),

        // History
        historyTableBody: document.querySelector('#history-table tbody'),
        clearHistoryBtn: document.getElementById('clear-history-button'),
        contextMenu: document.getElementById('context-menu')
    };

    let currentJobId = null;
    let pollingInterval = null;

    // --- Plattform Definitionen (Regex & Farben) ---
    const platforms = [
        { name: 'SoundCloud', pattern: /soundcloud\.com/, icon: 'fa-soundcloud', color: '#ff5500' },
        { name: 'YouTube', pattern: /(youtube\.com|youtu\.be)/, icon: 'fa-youtube', color: '#ff0000' },
        { name: 'TikTok', pattern: /tiktok\.com/, icon: 'fa-tiktok', color: '#000000' },
        { name: 'Instagram', pattern: /instagram\.com/, icon: 'fa-instagram', color: '#E1306C' },
        { name: 'Twitter', pattern: /(twitter\.com|x\.com)/, icon: 'fa-x-twitter', color: '#000000' }
    ];

    // --- Init ---
    function init() {
        setupEventListeners();
        loadHistory();
    }

    function setupEventListeners() {
        // Auto-Detect bei Eingabe
        dom.urlInput.addEventListener('input', handleUrlInput);
        
        // Form Submit
        dom.form.addEventListener('submit', handleFormSubmit);

        // YouTube Format Toggle (MP3/MP4)
        dom.ytFormatRadios.forEach(radio => {
            radio.addEventListener('change', updateYtQualityVisibility);
        });

        // Codec Switch Toggle
        if(dom.codecSwitch) {
            dom.codecSwitch.addEventListener('change', (e) => {
                dom.codecPreference.value = e.target.checked ? 'h264' : 'original';
            });
        }

        // History
        if(dom.clearHistoryBtn) dom.clearHistoryBtn.addEventListener('click', clearHistory);
        document.addEventListener('click', hideContextMenu);
        if(dom.historyTableBody) {
             dom.historyTableBody.addEventListener('contextmenu', handleHistoryRightClick);
             dom.contextMenu.addEventListener('click', handleContextMenuClick);
        }
    }

    // --- Logik: URL Erkennung ---
    function handleUrlInput() {
        const url = dom.urlInput.value.trim();
        const detected = platforms.find(p => p.pattern.test(url));

        if (detected) {
            // UI Feedback
            dom.platformInput.value = detected.name;
            dom.detectedText.textContent = `${detected.name} erkannt`;
            dom.detectedIcon.className = `fab ${detected.icon}`;
            dom.detectedIcon.style.color = detected.color;
            dom.badgeContainer.style.opacity = '1';
            
            // Icon im Input Feld färben
            dom.urlIcon.className = `fab ${detected.icon}`;
            dom.urlIcon.style.color = detected.color;

            // Optionen anzeigen
            showOptionsForPlatform(detected.name);
        } else {
            // Reset wenn unbekannt oder leer
            dom.badgeContainer.style.opacity = '0';
            dom.urlIcon.className = 'fas fa-link text-muted';
            dom.urlIcon.style.color = '';
            hideAllOptions();
        }
    }

    function showOptionsForPlatform(platformName) {
        dom.optionsContainer.classList.add('show');
        
        // Reset specific sections
        dom.ytOptions.classList.add('d-none');
        dom.codecSection.classList.add('d-none');

        if (platformName === 'YouTube') {
            dom.ytOptions.classList.remove('d-none');
        } else if (['TikTok', 'Instagram', 'Twitter'].includes(platformName)) {
            dom.codecSection.classList.remove('d-none');
        } else {
            // SoundCloud braucht keine extra Optionen in diesem Design (Default ist MP3 Best)
            dom.optionsContainer.classList.remove('show');
        }
    }

    function hideAllOptions() {
        dom.optionsContainer.classList.remove('show');
        setTimeout(() => {
            dom.ytOptions.classList.add('d-none');
            dom.codecSection.classList.add('d-none');
        }, 500); // Warten bis Animation fertig
    }

    function updateYtQualityVisibility() {
        const format = document.querySelector('input[name="yt_format"]:checked').value;
        if (format === 'mp3') {
            dom.mp3Select.classList.remove('d-none');
            dom.mp4Select.classList.add('d-none');
            dom.codecSection.classList.add('d-none');
        } else {
            dom.mp3Select.classList.add('d-none');
            dom.mp4Select.classList.remove('d-none');
            dom.codecSection.classList.remove('d-none');
        }
    }

    // --- Logik: Submit & Polling ---
    async function handleFormSubmit(e) {
        e.preventDefault();
        
        // Validierung
        if(dom.badgeContainer.style.opacity === '0' && dom.urlInput.value.length > 0) {
            // Fallback für unbekannte URLs -> Standard SoundCloud probieren oder Warnen
            dom.platformInput.value = "SoundCloud"; 
        }

        // UI Transition
        dom.form.classList.add('d-none');
        dom.progressContainer.classList.remove('d-none');
        dom.resultContainer.classList.add('d-none');
        dom.errorMessage.classList.add('d-none');
        dom.logContent.textContent = "Verbindung wird hergestellt...";
        dom.progressBar.style.width = "5%";

        const formData = new FormData(dom.form);

        try {
            const response = await fetch('/start_download', { method: 'POST', body: formData });
            const result = await response.json();
            
            if (response.ok && result.job_id) {
                currentJobId = result.job_id;
                startPolling();
            } else {
                showError(result.error || "Serverfehler beim Starten.");
            }
        } catch (err) {
            showError(`Verbindungsfehler: ${err.message}`);
        }
    }

    function startPolling() {
        pollingInterval = setInterval(async () => {
            try {
                const res = await fetch(`/status?job_id=${currentJobId}`);
                if (res.status === 404) { stopPolling(); showError("Job verloren gegangen."); return; }
                
                const status = await res.json();
                updateProgressUI(status);

                if (status.status === 'completed') {
                    stopPolling();
                    showResult(status.result_url);
                } else if (status.status === 'error' || status.error) {
                    stopPolling();
                    showError(status.error || status.message);
                }
            } catch (err) {
                console.error(err);
            }
        }, 1500);
    }

    function stopPolling() {
        clearInterval(pollingInterval);
    }

    function updateProgressUI(status) {
        const pct = status.progress || 0;
        dom.progressBar.style.width = `${pct}%`;
        
        if(status.message) dom.statusMessage.textContent = status.message;
        
        if(status.logs && status.logs.length > 0) {
            dom.logContent.textContent = status.logs[status.logs.length - 1];
        }
    }

    function showResult(url) {
        dom.progressContainer.classList.add('d-none');
        dom.resultContainer.classList.remove('d-none');
        dom.resultUrl.href = url;
        loadHistory(); // Verlauf aktualisieren
    }

    function showError(msg) {
        dom.progressContainer.classList.add('d-none');
        dom.form.classList.remove('d-none'); // Form wieder zeigen
        dom.errorMessage.textContent = msg;
        dom.errorMessage.classList.remove('d-none');
    }

    // --- History Logic (Minimal) ---
    async function loadHistory() {
        if(!dom.historyTableBody) return;
        try {
            const res = await fetch('/history');
            const data = await res.json();
            renderHistory(data);
        } catch(e) { console.error("History Error", e); }
    }

    function renderHistory(data) {
        dom.historyTableBody.innerHTML = '';
        if(!data || !data.length) {
            dom.historyTableBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Kein Verlauf vorhanden.</td></tr>';
            return;
        }
        data.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td class="small text-muted">${item.timestamp.split(' ')[1]}</td>
                <td class="text-center"><i class="fab fa-${getIconForPlatform(item.platform)}"></i></td>
                <td class="text-truncate" style="max-width: 150px;" title="${item.title}">${item.title}</td>
                <td class="text-end"><a href="${item.s3_url}" target="_blank" class="btn btn-sm btn-light border" data-url="${item.s3_url}"><i class="fas fa-download"></i></a></td>
            `;
            dom.historyTableBody.appendChild(row);
        });
    }

    function getIconForPlatform(p) {
        if(p === 'SoundCloud') return 'soundcloud text-warning';
        if(p === 'YouTube') return 'youtube text-danger';
        if(p === 'TikTok') return 'tiktok';
        if(p === 'Instagram') return 'instagram text-danger';
        if(p === 'Twitter') return 'x-twitter';
        return 'question';
    }

    async function clearHistory() {
        if(confirm("Verlauf wirklich löschen?")) {
            await fetch('/clear_history', {method: 'POST'});
            loadHistory();
        }
    }

    // Context Menu Logic
    let contextUrl = null;
    function handleHistoryRightClick(e) {
        const linkBtn = e.target.closest('a[data-url]');
        if(linkBtn) {
            e.preventDefault();
            contextUrl = linkBtn.dataset.url;
            dom.contextMenu.style.top = `${e.pageY}px`;
            dom.contextMenu.style.left = `${e.pageX}px`;
            dom.contextMenu.classList.remove('d-none');
        }
    }
    
    function handleContextMenuClick(e) {
        if(e.target.closest('[data-action="copy"]') && contextUrl) {
            navigator.clipboard.writeText(contextUrl);
            dom.contextMenu.classList.add('d-none');
        }
    }
    
    function hideContextMenu() {
        if(dom.contextMenu) dom.contextMenu.classList.add('d-none');
    }

    init();
});