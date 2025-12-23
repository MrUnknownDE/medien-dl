document.addEventListener('DOMContentLoaded', () => {
    const dom = {
        form: document.getElementById('upload-form'),
        urlInput: document.getElementById('url'),
        platformInput: document.getElementById('input-platform'),
        submitBtn: document.getElementById('submit-button'),
        
        badgeContainer: document.getElementById('platform-badge-container'),
        detectedIcon: document.getElementById('detected-icon'),
        detectedText: document.getElementById('detected-text'),
        urlIcon: document.getElementById('url-icon'),

        optionsContainer: document.getElementById('options-container'),
        ytOptions: document.getElementById('youtube-options'),
        codecSection: document.getElementById('codec-options-section'),
        
        ytFormatRadios: document.querySelectorAll('input[name="yt_format"]'),
        qualityWrapper: document.getElementById('quality-wrapper'),
        mp3Select: document.getElementById('mp3_bitrate'),
        mp4Select: document.getElementById('mp4_quality'),
        
        codecSwitch: document.getElementById('codec-switch'),
        codecPreference: document.getElementById('codec_preference'),

        progressContainer: document.getElementById('progress-container'),
        progressBar: document.getElementById('progress-bar'),
        statusMessage: document.getElementById('status-message'),
        logContent: document.getElementById('log-content'), // Für den letzten Log-Eintrag
        
        resultContainer: document.getElementById('result-container'),
        resultUrl: document.getElementById('result-url'),
        errorMessage: document.getElementById('error-message'),

        // History Elements
        historyTableBody: document.querySelector('#history-table tbody'),
        clearHistoryBtn: document.getElementById('clear-history-button'),
        contextMenu: document.getElementById('context-menu'),
        
        // Pseudo Log Elements
        pseudoLogArea: document.getElementById('pseudo-log-area'),
        pseudoLogContent: document.getElementById('pseudo-log-content'),
        terminalLines: document.querySelectorAll('.terminal-line')
    };

    let currentJobId = null;
    let pollingInterval = null;
    let pseudoLogInterval = null;
    let pseudoLogLines = [];
    const LOG_ENTRY_DELAY = 80; // Millisekunden zwischen Buchstaben
    const PSEUDO_LOG_MAX_LINES = 10;
    const HISTORY_EXPIRY_DAYS = 7;

    const platforms = [
        { name: 'SoundCloud', pattern: /soundcloud\.com/, icon: 'fa-soundcloud', color: '#ff5500' },
        { name: 'YouTube', pattern: /(youtube\.com|youtu\.be)/, icon: 'fa-youtube', color: '#ff0000' },
        { name: 'TikTok', pattern: /tiktok\.com/, icon: 'fa-tiktok', color: '#000000' },
        { name: 'Instagram', pattern: /instagram\.com/, icon: 'fa-instagram', color: '#E1306C' },
        { name: 'Twitter', pattern: /(twitter\.com|x\.com)/, icon: 'fa-x-twitter', color: '#000000' }
    ];

    const pseudoLogCommands = [
        "Initializing environment...",
        "Connecting to media servers...",
        "Authenticating with unknownMedien.dl API...",
        "Scanning URL for media info...",
        "Detecting stream type...",
        "Negotiating download protocol...",
        "Allocating buffer space...",
        "Pre-compiling conversion modules...",
        "Establishing S3 connection...",
        "Generating secure download token...",
        "Preparing download stream...",
        "Initiating download sequence...",
        "Syncing metadata...",
        "Finalizing file handles...",
    ];

    // --- Initialisierung ---
    function init() {
        setupEventListeners();
        loadClientHistory();
        startPseudoLogging();
    }

    // --- Event Listeners ---
    function setupEventListeners() {
        dom.urlInput.addEventListener('input', handleUrlInput);
        dom.form.addEventListener('submit', handleFormSubmit);
        dom.ytFormatRadios.forEach(radio => radio.addEventListener('change', updateYtQualityVisibility));
        if(dom.codecSwitch) {
            dom.codecSwitch.addEventListener('change', (e) => {
                dom.codecPreference.value = e.target.checked ? 'h264' : 'original';
            });
        }
        if(dom.clearHistoryBtn) dom.clearHistoryBtn.addEventListener('click', clearClientHistory);
        document.addEventListener('click', hideContextMenu);
        if(dom.historyTableBody) {
             dom.historyTableBody.addEventListener('contextmenu', handleHistoryRightClick);
             dom.contextMenu.addEventListener('click', handleContextMenuClick);
        }
    }

    // --- URL Erkennung & Optionen ---
    function handleUrlInput() {
        const url = dom.urlInput.value.trim();
        const detected = platforms.find(p => p.pattern.test(url));

        if (detected) {
            dom.platformInput.value = detected.name;
            dom.detectedText.textContent = `${detected.name} DETECTED`;
            dom.detectedIcon.className = `fas ${detected.icon}`;
            dom.detectedIcon.style.color = detected.color;
            dom.badgeContainer.style.opacity = '1';
            dom.urlIcon.className = `fas ${detected.icon}`;
            dom.urlIcon.style.color = detected.color;
            showOptionsForPlatform(detected.name);
        } else {
            dom.badgeContainer.style.opacity = '0';
            dom.urlIcon.className = 'fas fa-keyboard'; // Default CLI icon
            dom.urlIcon.style.color = '';
            hideAllOptions();
        }
    }

    function showOptionsForPlatform(platformName) {
        dom.optionsContainer.classList.add('show');
        dom.ytOptions.classList.add('d-none');
        dom.codecSection.classList.add('d-none');

        if (platformName === 'YouTube') {
            dom.ytOptions.classList.remove('d-none');
            updateYtQualityVisibility(); // Initial call
        } else if (['TikTok', 'Instagram', 'Twitter'].includes(platformName)) {
            dom.codecSection.classList.remove('d-none');
        } else {
            dom.optionsContainer.classList.remove('show');
        }
    }

    function hideAllOptions() {
        dom.optionsContainer.classList.remove('show');
        setTimeout(() => {
            dom.ytOptions.classList.add('d-none');
            dom.codecSection.classList.add('d-none');
        }, 500);
    }

    function updateYtQualityVisibility() {
        const format = document.querySelector('input[name="yt_format"]:checked')?.value;
        if (!format) return;
        
        if (format === 'mp3') {
            dom.mp3Select.classList.remove('d-none');
            dom.mp4Select.classList.add('d-none');
            dom.codecSection.classList.add('d-none');
        } else { // mp4
            dom.mp3Select.classList.add('d-none');
            dom.mp4Select.classList.remove('d-none');
            dom.codecSection.classList.remove('d-none');
        }
    }

    // --- Pseudo Logging Animation ---
    function startPseudoLogging() {
        let currentLine = 0;
        let charIndex = 0;
        let commandIndex = 0;
        
        function displayNextLogLine() {
            if (pseudoLogInterval) clearInterval(pseudoLogInterval);
            if (commandIndex >= pseudoLogCommands.length) {
                pseudoLogInterval = setTimeout(startPseudoLogging, 15000); // Restart after delay
                return;
            }
            
            const command = pseudoLogCommands[commandIndex];
            const lineElement = document.createElement('div');
            lineElement.classList.add('cli-output-line');
            lineElement.style.opacity = '0'; // Start hidden
            dom.pseudoLogContent.appendChild(lineElement);

            charIndex = 0;
            function typeWriter() {
                if (charIndex < command.length) {
                    lineElement.textContent += command.charAt(charIndex);
                    charIndex++;
                    setTimeout(typeWriter, LOG_ENTRY_DELAY);
                } else {
                    // Fade in effect for the completed line
                    let fadeEffect = setInterval(() => {
                        if (parseFloat(lineElement.style.opacity) < 1) {
                            lineElement.style.opacity = (parseFloat(lineElement.style.opacity) + 0.1).toString();
                        } else {
                            clearInterval(fadeEffect);
                            // Add new line after a short pause
                            commandIndex++;
                            setTimeout(displayNextLogLine, 300); 
                        }
                    }, 50);
                    
                    // Scroll to bottom
                    dom.pseudoLogArea.scrollTop = dom.pseudoLogArea.scrollHeight;
                }
            }
            typeWriter();
        }
        
        // Start the logging process
        dom.pseudoLogArea.style.opacity = '1'; // Make log area visible
        displayNextLogLine();
    }

    // --- Form Submit & Progress ---
    async function handleFormSubmit(e) {
        e.preventDefault();
        stopPseudoLogging(); // Stop the fake logs

        // Transition to Progress State
        dom.form.classList.add('d-none');
        dom.progressContainer.classList.remove('d-none');
        dom.resultContainer.classList.add('d-none');
        dom.errorMessage.classList.add('d-none');
        dom.logContent.textContent = "INITIALIZING...";
        dom.progressBar.style.width = "5%";

        const formData = new FormData(dom.form);

        try {
            const response = await fetch('/start_download', { method: 'POST', body: formData });
            const result = await response.json();
            
            if (response.ok && result.job_id) {
                currentJobId = result.job_id;
                startPolling();
            } else {
                showError(result.error || "Server error during submission.");
            }
        } catch (err) {
            showError(`Connection Error: ${err.message}`);
        }
    }

    function startPolling() {
        pollingInterval = setInterval(async () => {
            try {
                if (!currentJobId) { stopPolling(); return; }
                const res = await fetch(`/status?job_id=${currentJobId}`);
                
                if (res.status === 404) { stopPolling(); showError("Job not found (expired or invalid)."); return; }
                if (!res.ok) { throw new Error(`HTTP error! status: ${res.status}`); }
                
                const status = await res.json();
                updateProgressUI(status);

                if (status.status === 'completed') {
                    stopPolling();
                    showResult(status.result_url);
                } else if (status.status === 'error' || status.error) {
                    stopPolling();
                    showError(status.error || status.message || "An unknown error occurred.");
                }
            } catch (err) {
                console.error("Polling Error:", err);
                showError(`Polling failed: ${err.message}`);
                stopPolling();
            }
        }, 1500);
    }

    function stopPolling() {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    function updateProgressUI(status) {
        const pct = status.progress || 0;
        dom.progressBar.style.width = `${pct}%`;
        
        // Display the latest log message
        if(status.logs && status.logs.length > 0) {
            dom.logContent.textContent = status.logs[status.logs.length - 1];
        } else {
            dom.logContent.textContent = status.message || "...";
        }

        if(status.message) {
            dom.statusMessage.textContent = status.message.toUpperCase();
        }
    }

    // --- Result & Error Display ---
    function showResult(url) {
        dom.progressContainer.classList.add('d-none');
        dom.resultContainer.classList.remove('d-none');
        dom.resultUrl.href = url;
        dom.resultUrl.textContent = "DOWNLOAD LINK"; // Button text
        saveToClientHistory(url); // Save to client-side history
    }

    function showError(msg) {
        dom.progressContainer.classList.add('d-none');
        dom.form.classList.remove('d-none'); // Show form again for retry
        dom.errorMessage.textContent = msg.toUpperCase();
        dom.errorMessage.classList.remove('d-none');
        dom.submitBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> RETRY';
    }

    // --- Client-Side History ---
    function getHistory() {
        const history = localStorage.getItem('mediaDlHistory');
        if (!history) return [];
        try {
            const parsed = JSON.parse(history);
            // Filter out expired entries
            const now = new Date();
            return parsed.filter(item => {
                const expiryDate = new Date(item.expiry);
                return expiryDate > now;
            });
        } catch (e) {
            console.error("Error parsing history:", e);
            return [];
        }
    }

    function saveToClientHistory(url, title = "Unknown Title", platform = "Unknown") {
        const history = getHistory();
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + HISTORY_EXPIRY_DAYS);

        const newItem = {
            url: url,
            title: title,
            platform: platform,
            timestamp: new Date().toISOString(),
            expiry: expiryDate.toISOString()
        };
        
        // Add new item and limit history size (e.g., last 50)
        history.unshift(newItem); 
        if (history.length > 50) history.pop();

        localStorage.setItem('mediaDlHistory', JSON.stringify(history));
        renderHistory(history); // Update UI immediately
    }

    function loadClientHistory() {
        const history = getHistory();
        renderHistory(history);
    }

    function renderHistory(data) {
        if (!dom.historyTableBody) return;
        dom.historyTableBody.innerHTML = '';
        if (!data || data.length === 0) {
            dom.historyTableBody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">NO HISTORY YET.</td></tr>';
            return;
        }
        data.forEach(item => {
            const row = document.createElement('tr');
            const itemDate = new Date(item.timestamp);
            const expiryDate = new Date(item.expiry);
            const timeStr = `${itemDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            const platformIcon = getPlatformIcon(item.platform);

            row.innerHTML = `
                <td class="text-muted small">${timeStr}</td>
                <td class="text-center"><i class="${platformIcon.class}" style="color: ${platformIcon.color};"></i></td>
                <td class="text-truncate" style="max-width: 180px;" title="${item.title}">${item.title.substring(0, 25)}...</td>
                <td class="text-end"><a href="${item.url}" target="_blank" data-url="${item.url}" class="btn btn-sm btn-link text-success hover-underline"><i class="fas fa-link"></i></a></td>
            `;
            dom.historyTableBody.appendChild(row);
        });
    }
    
    function getPlatformIcon(p) {
        const platformData = platforms.find(pl => pl.name === p);
        if (platformData) return { class: `fas ${platformData.icon}`, color: platformData.color };
        return { class: `fas fa-question-circle`, color: '#808080' };
    }

    async function clearClientHistory() {
        if(confirm("Clear ALL history? This cannot be undone.")) {
            localStorage.removeItem('mediaDlHistory');
            renderHistory([]); // Clear the table
        }
    }

    // --- Context Menu ---
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
            // Temporary notification for copy action
            const notification = document.createElement('div');
            notification.textContent = 'Link Copied!';
            notification.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #39ff14; color: #0a0a0a; padding: 10px 20px; border-radius: 5px; z-index: 10000; font-weight: bold; opacity: 0; transition: opacity 0.5s; font-family: 'Consolas', monospace;`;
            document.body.appendChild(notification);
            setTimeout(() => notification.style.opacity = '1', 10);
            setTimeout(() => {
                notification.style.opacity = '0';
                setTimeout(() => notification.remove(), 500);
            }, 1500);
        }
        hideContextMenu();
    }
    function hideContextMenu() {
        if(dom.contextMenu) dom.contextMenu.classList.add('d-none');
        contextUrl = null;
    }
    
    // --- Stop Pseudo Logging ---
    function stopPseudoLogging() {
        if (pseudoLogInterval) clearInterval(pseudoLogInterval);
        // Keep logs visible until progress starts
        // Optionally hide it after transition: setTimeout(() => dom.pseudoLogArea.style.display = 'none', 800);
    }

    init();
});