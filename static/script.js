document.addEventListener('DOMContentLoaded', () => {
    // --- Selektoren & Globale Variablen ---
    const selectors = {
        form: '#upload-form',
        submitButton: '#submit-button',
        platformRadios: 'input[name="platform"]',
        ytOptionsDiv: '#youtube-options',
        ytQualityDiv: '#youtube-quality',
        ytFormatRadios: 'input[name="yt_format"]',
        mp3QualitySection: '#mp3-quality-section',
        mp4QualitySection: '#mp4-quality-section',
        codecOptionsSection: '#codec-options-section',
        progressBar: '#progress-bar',
        statusMessage: '#status-message',
        logContent: '#log-content',
        logOutput: '#log-output',
        resultUrlArea: '#result-url-area',
        resultUrlLink: '#result-url',
        copyResultUrlLink: '#copy-result-url',
        errorMessage: '#error-message',
        historyTableBody: '#history-table tbody',
        clearHistoryButton: '#clear-history-button',
        contextMenu: '#context-menu',
        queueInfo: '#queue-info',
        statsTotalJobs: '#stats-total-jobs',
        statsAvgDuration: '#stats-avg-duration',
        statsTotalSize: '#stats-total-size',
        urlHelpText: '#urlHelp',
        // Selektoren für das Overlay
        processingOverlay: '#processing-overlay',
        overlayMessage: '#overlay-message',
        // NEU: Selektoren für Status im Overlay
        overlayStatusText: '#overlay-status-text',
        overlayProgressBar: '#overlay-progress-bar',
    };

    const dom = {};
    let pollingInterval = null;
    let currentJobId = null;
    let isPolling = false;
    const historyEnabled = !!document.querySelector(selectors.clearHistoryButton);
    const videoPlatforms = ['YouTube', 'TikTok', 'Instagram', 'Twitter'];

    const memeMessages = [
        "Hacking the mainframe...",
        "Route Gibson durch die Firewall...",
        "Einen Moment, ich Binge gerade das Internet durch...",
        "Lade 1.21 Gigawatt herunter...",
        "Komprimiere die Daten... mit purer Willenskraft.",
        "Die Bits und Bytes tanzen Cha-Cha-Cha.",
        "Frage die NSA nach dem schnellsten Weg...",
        "Polishing the pixels...",
        "Die Leitung glüht, alles nach Plan!",
        "Füttere den Hamster im Serverraum...",
        "Kalibriere den Fluxkompensator...",
        "Optimiere den Warp-Antrieb...",
    ];

    // --- Initialisierung ---
    function init() {
        for (const key in selectors) {
            dom[key] = document.querySelector(selectors[key]);
            if (!dom[key] && !['copyResultUrlLink', 'clearHistoryButton', 'historyTableBody', 'contextMenu'].includes(key)) {
                 console.warn(`DOM-Element nicht gefunden: ${selectors[key]}`);
            }
        }
        dom.platformRadios = document.querySelectorAll(selectors.platformRadios);
        dom.ytFormatRadios = document.querySelectorAll(selectors.ytFormatRadios);

        setupEventListeners();
        updateDynamicOptionsVisibility();
        if (historyEnabled) {
             fetchHistory();
        } else {
            if(dom.historyTableBody) {
                dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">- Verlauf deaktiviert -</td></tr>';
            }
        }
        resetUIState();
        fetchStats();
        console.log("Uploader UI initialisiert.");
    }

    // --- Event Listener Setup ---
    function setupEventListeners() {
        if (dom.form) dom.form.addEventListener('submit', handleFormSubmit);
        dom.platformRadios.forEach(radio => radio.addEventListener('change', updateDynamicOptionsVisibility));
        dom.ytFormatRadios.forEach(radio => radio.addEventListener('change', updateYoutubeQualityVisibility));
        if (dom.clearHistoryButton) dom.clearHistoryButton.addEventListener('click', handleClearHistory);
        document.addEventListener('click', hideContextMenu);
        if (dom.contextMenu) dom.contextMenu.addEventListener('click', handleContextMenuClick);
        if (dom.historyTableBody && historyEnabled) {
            dom.historyTableBody.addEventListener('contextmenu', (event) => {
                const targetLink = event.target.closest('a[data-url]');
                if (targetLink) showContextMenu(event, targetLink.dataset.url);
            });
        }
    }

    // --- UI Update Funktionen ---
    function resetUIState() {
        if (dom.submitButton) {
            dom.submitButton.disabled = false;
            dom.submitButton.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Download starten';
        }
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');
        if (dom.resultUrlArea) dom.resultUrlArea.classList.add('d-none');
        if (dom.logContent) dom.logContent.textContent = '';
        if (dom.queueInfo) dom.queueInfo.classList.add('d-none');
        
        updateAllStatusMessages('Bereit.');
        updateAllProgressBars(0, false, false, false);

        currentJobId = null;
        isPolling = false;
        hideProcessingOverlay();
        stopPolling();
        console.log("UI State reset.");
    }

    function setUIProcessing(isStarting = false) {
        if (dom.submitButton) dom.submitButton.disabled = true;
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');
        
        updateAllStatusMessages('Sende Auftrag...');

        if (isStarting) {
            if (dom.resultUrlArea) dom.resultUrlArea.classList.add('d-none');
            if (dom.logContent) dom.logContent.textContent = '';
            updateAllProgressBars(0, false, false, false);
        }
    }

    // NEU: Funktion, die BEIDE Fortschrittsbalken aktualisiert
    function updateAllProgressBars(value, isError = false, isRunning = false, isQueued = false) {
        const percentage = Math.max(0, Math.min(100, Math.round(value)));
        
        // Funktion zur Aktualisierung eines einzelnen Balkens
        const updateSingleBar = (barElement) => {
            if (!barElement) return;
            barElement.style.width = `${percentage}%`;
            barElement.textContent = `${percentage}%`;
            
            // Spezifische Klassen für den Haupt-Balken
            if (barElement.id === 'progress-bar') {
                barElement.setAttribute('aria-valuenow', percentage);
                barElement.classList.remove('bg-success', 'bg-danger', 'bg-info', 'bg-secondary', 'progress-bar-animated', 'progress-bar-striped');
                if (isError) barElement.classList.add('bg-danger');
                else if (isQueued) barElement.classList.add('bg-secondary');
                else if (percentage === 100 && !isRunning) barElement.classList.add('bg-success');
                else if (isRunning) barElement.classList.add('bg-info', 'progress-bar-striped', 'progress-bar-animated');
                else barElement.classList.add('bg-info');
            }

            // Spezifische Klassen für den Overlay-Balken (hat eigene CSS-Stile)
            if (barElement.id === 'overlay-progress-bar') {
                barElement.classList.remove('progress-bar-striped', 'progress-bar-animated');
                if (isRunning) {
                     barElement.classList.add('progress-bar-striped', 'progress-bar-animated');
                }
            }
        };

        updateSingleBar(dom.progressBar);
        updateSingleBar(dom.overlayProgressBar);
    }

    // NEU: Funktion, die BEIDE Status-Nachrichten aktualisiert
    function updateAllStatusMessages(message, position = null, totalQueued = null) {
        let displayMessage = message || '...';
        if (position !== null && totalQueued !== null) {
            displayMessage = `${message} (Position ${position} von ${totalQueued})`;
        }
        if (dom.statusMessage) dom.statusMessage.textContent = displayMessage;
        if (dom.overlayStatusText) dom.overlayStatusText.textContent = displayMessage;
    }

    function appendLog(message, type = 'log') {
         if (!dom.logContent || !message) return;
         const timestamp = new Date().toLocaleTimeString();
         const logLine = `${timestamp} - ${message.trim()}\n`;
         dom.logContent.textContent += logLine;
         if (dom.logOutput) dom.logOutput.scrollTop = dom.logOutput.scrollHeight;
         if (type === 'error') console.error(message);
         else if (type === 'warn') console.warn(message);
    }

    function showError(message) {
        if (!dom.errorMessage) return;
        let displayMessage = message || "Unbekannter Fehler.";
        // ... (Fehlertext-Logik bleibt unverändert)
        const lowerCaseMessage = message ? message.toLowerCase() : "";
        if (lowerCaseMessage.includes("login is required") || lowerCaseMessage.includes("age-restricted") || lowerCaseMessage.includes("instagramloginrequired") || lowerCaseMessage.includes("twitterloginrequired")) {
             displayMessage = "Dieser Inhalt erfordert eine Anmeldung oder ist altersbeschränkt und kann nicht direkt heruntergeladen werden.";
        } else if (lowerCaseMessage.includes("video unavailable")) {
             displayMessage = "Fehler: Dieses Video ist nicht (mehr) verfügbar.";
        } else if (lowerCaseMessage.includes("unsupported url")) {
             displayMessage = "Fehler: Die eingegebene URL wird nicht unterstützt oder ist kein gültiger Link für die gewählte Plattform.";
        } else if (lowerCaseMessage.includes("403") || lowerCaseMessage.includes("access denied")) {
             displayMessage = "Fehler: Zugriff auf den Inhalt verweigert (403).";
        } else if (lowerCaseMessage.includes("404") || lowerCaseMessage.includes("not found")) {
             displayMessage = "Fehler: Inhalt nicht gefunden (404).";
        } else if (lowerCaseMessage.includes("already processed")) {
             displayMessage = message; 
        } else if (lowerCaseMessage.includes("worker-fehler") || lowerCaseMessage.includes("schwerer worker-fehler")) {
             displayMessage = `Interner Serverfehler: ${message}`;
        } else if (lowerCaseMessage.includes("job nicht gefunden")) {
             displayMessage = message; 
        } else if (lowerCaseMessage.includes("ungültige url für instagram")) {
             displayMessage = "Fehler: Ungültige URL für Instagram. Es werden nur Reel-Links unterstützt (z.B. .../reel/...).";
        } else if (lowerCaseMessage.includes("ungültige url für twitter")) {
             displayMessage = "Fehler: Ungültige URL für Twitter/X. Es werden nur Tweet-Links unterstützt (z.B. .../status/...).";
        }

        dom.errorMessage.textContent = displayMessage;
        dom.errorMessage.classList.remove('d-none');
        updateAllStatusMessages('Fehler!'); 
        const currentProgress = dom.progressBar ? parseInt(dom.progressBar.getAttribute('aria-valuenow')) : 0;
        updateAllProgressBars(currentProgress, true, false, false);
        appendLog(`Fehler angezeigt: ${displayMessage}`, 'error');
    }

    function showResult(url) {
        if (!dom.resultUrlArea || !dom.resultUrlLink || !url) return;
        dom.resultUrlLink.href = url;
        dom.resultUrlLink.textContent = url;
        dom.resultUrlArea.classList.remove('d-none');
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');
    }

    // --- Overlay Funktionen ---
    function showProcessingOverlay() {
        if (!dom.processingOverlay || !dom.overlayMessage) return;
        const randomIndex = Math.floor(Math.random() * memeMessages.length);
        dom.overlayMessage.textContent = memeMessages[randomIndex];
        dom.processingOverlay.classList.add('visible');
    }

    function hideProcessingOverlay() {
        if (!dom.processingOverlay) return;
        dom.processingOverlay.classList.remove('visible');
    }

    // --- Dynamische Optionen (unverändert) ---
    function updateDynamicOptionsVisibility() {
        const selectedPlatform = document.querySelector('input[name="platform"]:checked')?.value;
        if (!dom.ytOptionsDiv || !dom.codecOptionsSection || !dom.urlHelpText) return;
        dom.ytOptionsDiv.classList.add('d-none');
        dom.codecOptionsSection.classList.add('d-none');
        if(dom.mp3QualitySection) dom.mp3QualitySection.classList.add('d-none');
        if(dom.mp4QualitySection) dom.mp4QualitySection.classList.add('d-none');
        if (selectedPlatform === 'Instagram' || selectedPlatform === 'Twitter') {
            dom.urlHelpText.classList.remove('d-none');
        } else {
            dom.urlHelpText.classList.add('d-none');
        }
        if (selectedPlatform === 'YouTube') {
            dom.ytOptionsDiv.classList.remove('d-none');
            updateYoutubeQualityVisibility();
        }
        else if (videoPlatforms.includes(selectedPlatform) && selectedPlatform !== 'YouTube') {
             dom.codecOptionsSection.classList.remove('d-none');
        }
    }
    function updateYoutubeQualityVisibility() {
        const selectedFormat = document.querySelector('input[name="yt_format"]:checked')?.value;
        if (!dom.mp3QualitySection || !dom.mp4QualitySection || !dom.ytQualityDiv || !dom.codecOptionsSection) return;
        dom.ytQualityDiv.classList.remove('d-none');
        dom.mp3QualitySection.classList.add('d-none');
        dom.mp4QualitySection.classList.add('d-none');
        dom.codecOptionsSection.classList.add('d-none');
        if (selectedFormat === 'mp3') {
            dom.mp3QualitySection.classList.remove('d-none');
        } else if (selectedFormat === 'mp4') {
             dom.mp4QualitySection.classList.remove('d-none');
             dom.codecOptionsSection.classList.remove('d-none');
        }
    }

    // --- Event Handler ---
    async function handleFormSubmit(event) {
        event.preventDefault();
        if (isPolling) {
            alert("Bitte warte, bis der aktuelle Auftrag abgeschlossen ist, bevor du einen neuen startest.");
            return;
        }
        resetUIState();
        setUIProcessing(true);
        showProcessingOverlay();
        const formData = new FormData(dom.form);
        try {
            const response = await fetch('/start_download', { method: 'POST', body: formData });
            const result = await response.json();
            if (response.ok && result.job_id) {
                currentJobId = result.job_id;
                updateAllStatusMessages(result.message || 'Auftrag gesendet...');
                appendLog(`Auftrag ${currentJobId} gestartet: ${result.message || ''}`, 'info');
                startPolling();
            } else {
                throw new Error(result.error || `Serverfehler: ${response.status}`);
            }
        } catch (error) {
            console.error('Fehler beim Starten des Downloads:', error);
            showError(`Fehler beim Start: ${error.message}`);
            resetUIState();
        }
    }
    async function handleClearHistory() {
        if (!dom.clearHistoryButton || !dom.historyTableBody) return;
        if (confirm('Möchtest du wirklich den gesamten Verlauf löschen?')) {
            dom.clearHistoryButton.disabled = true;
            try {
                const response = await fetch('/clear_history', { method: 'POST' });
                if (response.ok) {
                    appendLog('Verlauf erfolgreich gelöscht.', 'info');
                    dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Verlauf wurde gelöscht.</td></tr>';
                } else {
                    const result = await response.json(); throw new Error(result.error || 'Unbekannter Fehler.');
                }
            } catch (error) {
                console.error('Fehler beim Löschen des Verlaufs:', error); showError(`Fehler beim Löschen: ${error.message}`);
            } finally {
                dom.clearHistoryButton.disabled = false;
            }
        }
    }

    // --- Polling ---
    function startPolling() {
        if (!currentJobId) return;
        stopPolling();
        isPolling = true;
        if (dom.submitButton) {
             dom.submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verarbeite...';
             dom.submitButton.disabled = true;
        }
        pollingInterval = setInterval(fetchStatus, 2000);
        fetchStatus();
        console.log(`Polling gestartet für Job ${currentJobId}.`);
    }

    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            isPolling = false;
            console.log("Polling gestoppt.");
        }
    }

    async function fetchStatus() {
        if (!currentJobId || !isPolling) {
            stopPolling();
            return;
        }
        try {
            const response = await fetch(`/status?job_id=${currentJobId}`);
            if (response.status === 404) {
                const status = await response.json();
                showError(status.error || "Auftrag nicht gefunden (möglicherweise zu alt).");
                stopPolling();
                hideProcessingOverlay();
                resetSubmitButton();
                return;
            }
            if (!response.ok) throw new Error(`Status-Serverfehler: ${response.status}`);
            
            const status = await response.json();
            
            if (dom.logContent && Array.isArray(status.logs)) {
                 dom.logContent.textContent = status.logs.join('\n') + '\n';
                 if (dom.logOutput) dom.logOutput.scrollTop = dom.logOutput.scrollHeight;
            }

            const isRunning = status.running === true;
            const isQueued = status.status === 'queued';
            const isCompleted = status.status === 'completed';
            const isError = !!status.error || status.status === 'error';
            const isNotFound = status.status === 'not_found';

            // Status und Fortschritt an beide UI-Teile senden
            updateAllProgressBars(status.progress || 0, isError, isRunning, isQueued);
            if (isQueued && status.position !== undefined && status.total_queued !== undefined) {
                updateAllStatusMessages(status.message || 'In Warteschlange...', status.position, status.total_queued);
            } else {
                updateAllStatusMessages(status.message || '...');
            }

            if (isCompleted || isError || isNotFound) {
                stopPolling();
                hideProcessingOverlay();

                if (isError) {
                    showError(status.error || status.message);
                } else if (isCompleted) {
                    updateAllStatusMessages('Abgeschlossen!');
                    updateAllProgressBars(100, false, false, false);
                    if (status.result_url) showResult(status.result_url);
                    if (historyEnabled) fetchHistory();
                    fetchStats();
                } else {
                     showError(status.error || status.message || "Auftrag beendet, aber Status unklar.");
                }
                resetSubmitButton();
            } else if (isRunning || isQueued) { 
                 if (dom.submitButton && !dom.submitButton.disabled) {
                     dom.submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verarbeite...';
                     dom.submitButton.disabled = true;
                 }
            }
        } catch (error) {
            console.error('Polling-Fehler:', error);
            appendLog(`Polling fehlgeschlagen: ${error.message}`, 'error');
            showError(`Polling-Fehler: ${error.message}.`);
            stopPolling();
            resetUIState();
        }
    }

    function resetSubmitButton() {
        if (dom.submitButton) {
             dom.submitButton.disabled = false;
             dom.submitButton.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Download starten';
        }
    }

    // --- History (unverändert) ---
    async function fetchHistory() {
        if (!dom.historyTableBody || !historyEnabled) return;
        dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted"><i class="fas fa-spinner fa-spin"></i> Lade Verlauf...</td></tr>';
        try {
            const response = await fetch('/history');
            if (!response.ok) throw new Error(`Serverfehler History: ${response.status}`);
            const history = await response.json();
            renderHistory(history);
        } catch (error) {
            console.error('Fehler Laden Verlauf:', error);
            dom.historyTableBody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Fehler Laden Verlauf: ${error.message}</td></tr>`;
        }
    }
    function renderHistory(historyData) {
        if (!dom.historyTableBody || !historyEnabled) return;
        dom.historyTableBody.innerHTML = '';
        if (!historyData || !Array.isArray(historyData) || historyData.length === 0) {
            dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Keine Einträge im Verlauf.</td></tr>'; return;
        }
        historyData.forEach(entry => {
            const row = dom.historyTableBody.insertRow();
            row.insertCell().textContent = entry.timestamp || '';
            const platformCell = row.insertCell(); platformCell.classList.add('text-center');
            let platformIcon = '<i class="fas fa-question-circle text-muted" title="Unbekannt"></i>';
            const platform = entry.platform || 'Unbekannt';
            if (platform === 'SoundCloud') platformIcon = '<i class="fab fa-soundcloud text-warning" title="SoundCloud"></i>';
            else if (platform === 'YouTube') platformIcon = '<i class="fab fa-youtube text-danger" title="YouTube"></i>';
            else if (platform === 'TikTok') platformIcon = '<i class="fab fa-tiktok" title="TikTok"></i>';
            else if (platform === 'Instagram') platformIcon = '<i class="fab fa-instagram" title="Instagram Reel"></i>';
            else if (platform === 'Twitter') platformIcon = '<i class="fab fa-x-twitter" title="Twitter/X"></i>';
            platformCell.innerHTML = platformIcon;
            const titleCell = row.insertCell(); titleCell.textContent = entry.title || 'N/A'; titleCell.title = entry.title || '';
            createLinkCell(row.insertCell(), entry['source_url']);
            createLinkCell(row.insertCell(), entry['s3_url']);
        });
    }
    function createLinkCell(cell, url) {
        if (!cell || !url) { cell.textContent = url || 'N/A'; return; }
        const link = document.createElement('a'); link.href = url;
        link.textContent = url.length > 50 ? url.substring(0, 47) + '...' : url;
        link.title = url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.dataset.url = url;
        cell.appendChild(link);
    }

    // --- Kontextmenü (unverändert) ---
    let currentContextMenuUrl = null;
    function showContextMenu(event, url) {
        event.preventDefault();
        if (!dom.contextMenu || !url) return;
        currentContextMenuUrl = url;
        dom.contextMenu.style.top = `${event.clientY}px`;
        dom.contextMenu.style.left = `${event.clientX}px`;
        dom.contextMenu.classList.remove('d-none');
    }
    function hideContextMenu() {
        if (dom.contextMenu) dom.contextMenu.classList.add('d-none');
        currentContextMenuUrl = null;
    }
    function handleContextMenuClick(event) {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action && currentContextMenuUrl) {
            if (action === 'open') window.open(currentContextMenuUrl, '_blank');
            else if (action === 'copy') { copyToClipboard(currentContextMenuUrl); appendLog("URL aus History kopiert.", "info"); }
        }
        hideContextMenu();
    }

    // --- Statistik (unverändert) ---
    async function fetchStats() {
        if (!dom.statsTotalJobs || !dom.statsAvgDuration || !dom.statsTotalSize) return;
        try {
            const response = await fetch('/stats');
            if (!response.ok) throw new Error(`Statistik-Serverfehler: ${response.status}`);
            const stats = await response.json();
            dom.statsTotalJobs.textContent = stats.total_jobs ?? 'N/A';
            dom.statsAvgDuration.textContent = stats.average_duration_seconds ?? 'N/A';
            dom.statsTotalSize.textContent = stats.total_size_formatted ?? 'N/A';
        } catch (error) {
            console.error('Fehler Laden Statistiken:', error);
        }
    }

    // --- Hilfsfunktionen (unverändert) ---
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => appendLog("Link kopiert.", "info"))
            .catch(err => { console.error('Async Copy failed:', err); alert("Kopieren fehlgeschlagen."); });
    }

    // --- Start ---
    init();

}); // Ende DOMContentLoaded