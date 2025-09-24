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
        codecOptionsSection: '#codec-options-section', // Für Video Codec
        progressBar: '#progress-bar',
        statusMessage: '#status-message',
        logContent: '#log-content',
        logOutput: '#log-output',
        resultUrlArea: '#result-url-area',
        resultUrlLink: '#result-url',
        copyResultUrlLink: '#copy-result-url', // Nicht mehr im HTML, aber lassen wir es hier
        errorMessage: '#error-message',
        historyTableBody: '#history-table tbody',
        clearHistoryButton: '#clear-history-button',
        contextMenu: '#context-menu',
        queueInfo: '#queue-info', // Behalten wir für evtl. spätere Nutzung
        statsTotalJobs: '#stats-total-jobs',
        statsAvgDuration: '#stats-avg-duration',
        statsTotalSize: '#stats-total-size',
        urlHelpText: '#urlHelp',
    };

    const dom = {}; // Objekt für DOM-Elemente
    let pollingInterval = null;
    let currentJobId = null; // Aktuelle Job-ID speichern
    let isPolling = false;   // Separater State für aktives Polling
    const historyEnabled = !!document.querySelector(selectors.clearHistoryButton);
    const videoPlatforms = ['YouTube', 'TikTok', 'Instagram', 'Twitter'];

    // --- Initialisierung ---
    // (Unverändert)
    function init() {
        for (const key in selectors) {
            dom[key] = document.querySelector(selectors[key]);
            if (!dom[key] && ['form', 'submitButton', 'statusMessage', 'progressBar', 'logContent', 'errorMessage', 'queueInfo', 'statsTotalJobs', 'statsAvgDuration', 'statsTotalSize', 'codecOptionsSection', 'urlHelpText'].includes(key)) {
                console.warn(`Optionales DOM-Element nicht gefunden: ${selectors[key]}`);
            } else if (!dom[key] && !['copyResultUrlLink', 'clearHistoryButton', 'historyTableBody', 'contextMenu'].includes(key)) {
                 console.error(`Kritisches DOM-Element nicht gefunden: ${selectors[key]}`);
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
        console.log("History aktiviert (Frontend):", historyEnabled);
    }

    // --- Event Listener Setup ---
    // (Unverändert)
    function setupEventListeners() {
        if (dom.form) dom.form.addEventListener('submit', handleFormSubmit);
        dom.platformRadios.forEach(radio => radio.addEventListener('change', updateDynamicOptionsVisibility));
        dom.ytFormatRadios.forEach(radio => radio.addEventListener('change', updateYoutubeQualityVisibility));
        if (dom.clearHistoryButton) dom.clearHistoryButton.addEventListener('click', handleClearHistory);

        if (dom.copyResultUrlLink) {
            dom.copyResultUrlLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (dom.resultUrlLink && dom.resultUrlLink.href) {
                    copyToClipboard(dom.resultUrlLink.href);
                    appendLog("Ergebnis-URL kopiert.", "info");
                }
            });
        }

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
    // (Unverändert)
    function resetUIState() {
        if (dom.submitButton) {
            dom.submitButton.disabled = false;
            dom.submitButton.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Download starten';
        }
        if (dom.statusMessage) dom.statusMessage.textContent = 'Bereit.';
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');
        if (dom.resultUrlArea) dom.resultUrlArea.classList.add('d-none');
        updateProgressBar(0, false, false, false); // Reset progress bar
        if (dom.logContent) dom.logContent.textContent = '';
        // updateQueueInfo(0); // Nicht mehr direkt hier benötigt
        if (dom.queueInfo) dom.queueInfo.classList.add('d-none'); // Queue Info Badge ausblenden
        currentJobId = null;
        isPolling = false;
        stopPolling();
        console.log("UI State reset.");
    }

    // (Unverändert)
    function setUIProcessing(isStarting = false) {
        if (dom.submitButton) {
            dom.submitButton.disabled = true;
        }
        if (dom.statusMessage) dom.statusMessage.textContent = 'Sende Auftrag...';
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');

        if (isStarting) {
            if (dom.resultUrlArea) dom.resultUrlArea.classList.add('d-none');
            if (dom.logContent) dom.logContent.textContent = '';
            updateProgressBar(0, false, false, false);
        }
    }

    // (Unverändert - von vorheriger Lösung)
    function updateProgressBar(value, isError = false, isRunning = false, isQueued = false) {
        if (!dom.progressBar) return;
        const percentage = Math.max(0, Math.min(100, Math.round(value)));
        dom.progressBar.style.width = `${percentage}%`;
        dom.progressBar.textContent = `${percentage}%`;
        dom.progressBar.setAttribute('aria-valuenow', percentage);

        dom.progressBar.classList.remove('bg-success', 'bg-danger', 'bg-info', 'bg-secondary', 'progress-bar-animated', 'progress-bar-striped');

        if (isError) {
            dom.progressBar.classList.add('bg-danger');
            dom.progressBar.textContent = 'Fehler';
        } else if (isQueued) {
            dom.progressBar.classList.add('bg-secondary');
            dom.progressBar.textContent = 'Wartet...';
        } else if (percentage === 100 && !isRunning) {
             dom.progressBar.classList.add('bg-success');
        } else if (isRunning) {
            dom.progressBar.classList.add('bg-info', 'progress-bar-striped', 'progress-bar-animated');
        } else {
             dom.progressBar.classList.add('bg-info');
        }
    }

    // --- NEU: updateStatusMessage wird jetzt die Queue-Position anzeigen ---
    function updateStatusMessage(message, position = null, totalQueued = null) {
        if (!dom.statusMessage) return;
        let displayMessage = message || '...';
        // Wenn Positionsdaten vorhanden sind, füge sie hinzu
        if (position !== null && totalQueued !== null) {
            displayMessage = `${message} (Position ${position} von ${totalQueued})`;
        }
        dom.statusMessage.textContent = displayMessage;
    }

    // updateQueueInfo wird nicht mehr für die Position verwendet
    // function updateQueueInfo(queueSize) { ... }

    // (Unverändert)
    function appendLog(message, type = 'log') {
         if (!dom.logContent || !message) return;
         const timestamp = new Date().toLocaleTimeString();
         const logLine = `${timestamp} - ${message.trim()}\n`;
         dom.logContent.textContent += logLine;
         if (dom.logOutput) dom.logOutput.scrollTop = dom.logOutput.scrollHeight;
         if (type === 'error') console.error(message);
         else if (type === 'warn') console.warn(message);
    }

    // (Unverändert)
    function showError(message) {
        if (!dom.errorMessage) return;
        let displayMessage = message || "Unbekannter Fehler.";
        // Spezifische Fehlertexte verbessern (unverändert)
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
             displayMessage = message; // Behalte Servernachricht
        } else if (lowerCaseMessage.includes("worker-fehler") || lowerCaseMessage.includes("schwerer worker-fehler")) {
             displayMessage = `Interner Serverfehler: ${message}`;
        } else if (lowerCaseMessage.includes("job nicht gefunden")) {
             displayMessage = message; // Behalte Servernachricht
        } else if (lowerCaseMessage.includes("ungültige url für instagram")) {
             displayMessage = "Fehler: Ungültige URL für Instagram. Es werden nur Reel-Links unterstützt (z.B. .../reel/...).";
        } else if (lowerCaseMessage.includes("ungültige url für twitter")) {
             displayMessage = "Fehler: Ungültige URL für Twitter/X. Es werden nur Tweet-Links unterstützt (z.B. .../status/...).";
        }


        dom.errorMessage.textContent = displayMessage;
        dom.errorMessage.classList.remove('d-none');
        updateStatusMessage('Fehler!'); // Fehlerstatus ohne Position anzeigen
        updateProgressBar(dom.progressBar ? parseInt(dom.progressBar.getAttribute('aria-valuenow')) : 0, true, false, false);
        appendLog(`Fehler angezeigt: ${displayMessage}`, 'error');
    }

    // (Unverändert)
    function showResult(url) {
        if (!dom.resultUrlArea || !dom.resultUrlLink || !url) return;
        dom.resultUrlLink.href = url;
        dom.resultUrlLink.textContent = url;
        dom.resultUrlArea.classList.remove('d-none');
        if (dom.errorMessage) dom.errorMessage.classList.add('d-none');
    }

    // --- Dynamische Optionen ---
    // (Unverändert)
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

    // (Unverändert)
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
    // (Unverändert)
    async function handleFormSubmit(event) {
        event.preventDefault();
        if (isPolling) {
            alert("Bitte warte, bis der aktuelle Auftrag abgeschlossen ist, bevor du einen neuen startest.");
            return;
        }
        resetUIState();
        setUIProcessing(true);
        const formData = new FormData(dom.form);
        try {
            const response = await fetch('/start_download', { method: 'POST', body: formData });
            const result = await response.json();
            if (response.ok && result.job_id) {
                currentJobId = result.job_id;
                updateStatusMessage(result.message || 'Auftrag gesendet...'); // Initiale Meldung ohne Position
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

    // (Unverändert)
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
    // (Unverändert)
    function startPolling() {
        if (!currentJobId) {
            console.warn("StartPolling ohne Job ID aufgerufen.");
            return;
        }
        stopPolling();
        isPolling = true;
        if (dom.submitButton) {
             dom.submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verarbeite...';
             dom.submitButton.disabled = true;
        }
        pollingInterval = setInterval(fetchStatus, 2000);
        fetchStatus(); // Fetch immediately once
        console.log(`Polling gestartet für Job ${currentJobId}.`);
    }

    // (Unverändert)
    function stopPolling() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            isPolling = false;
            console.log("Polling gestoppt.");
        }
    }

    // --- fetchStatus: CORE CHANGE HERE ---
    async function fetchStatus() {
        if (!currentJobId || !isPolling) {
            console.log("FetchStatus abgebrochen (keine JobID oder Polling inaktiv).");
            stopPolling();
            return;
        }

        console.log(`Fetching status for job ${currentJobId}...`);

        try {
            const response = await fetch(`/status?job_id=${currentJobId}`);

            if (response.status === 404) {
                const status = await response.json();
                console.warn(`Job ${currentJobId} nicht gefunden (Status 404). Status:`, status);
                showError(status.error || "Auftrag nicht gefunden (möglicherweise zu alt).");
                stopPolling();
                resetSubmitButton();
                return;
            }

            if (!response.ok) {
                throw new Error(`Status-Serverfehler: ${response.status}`);
            }
            const status = await response.json();
            console.log("Received status:", status);

            // --- UI Updates basierend auf dem Job-Status ---
            try {
                 if (dom.logContent && Array.isArray(status.logs)) {
                     dom.logContent.textContent = status.logs.join('\n') + '\n';
                     if (dom.logOutput) dom.logOutput.scrollTop = dom.logOutput.scrollHeight;
                 }
            } catch (logError) {
                 console.error("Fehler beim Aktualisieren der Logs:", logError);
            }

            const isRunning = status.running === true;
            const isQueued = status.status === 'queued';
            const isCompleted = status.status === 'completed';
            const isError = !!status.error || status.status === 'error';
            const isNotFound = status.status === 'not_found';

            // Update Progress Bar mit allen Zuständen
            updateProgressBar(status.progress || 0, isError, isRunning, isQueued);

            // --- NEU: Update Status Message mit Positionsinfo ---
            if (isQueued && status.position !== undefined && status.total_queued !== undefined) {
                updateStatusMessage(status.message || 'In Warteschlange...', status.position, status.total_queued);
            } else {
                updateStatusMessage(status.message || '...'); // Normale Nachricht ohne Position
            }
            // --- ENDE NEU ---

            // Queue Info Badge nicht mehr verwenden
            // updateQueueInfo(status.queue_size || 0);
            if (dom.queueInfo) dom.queueInfo.classList.add('d-none');


            // --- Logik zum Stoppen des Pollings ---
            if (isCompleted || isError || isNotFound) {
                console.log(`Job ${currentJobId} ist beendet. Status: ${status.status}`);
                stopPolling();

                if (isError) {
                    console.error(`Backend meldet Fehler für Job ${currentJobId}:`, status.error || status.message);
                    showError(status.error || status.message);
                } else if (isCompleted) {
                    updateStatusMessage('Abgeschlossen!'); // Finale Meldung ohne Position
                    updateProgressBar(100, false, false, false);
                    if (status.result_url) {
                        showResult(status.result_url);
                    }
                    if (historyEnabled) fetchHistory();
                    fetchStats();
                } else {
                     showError(status.error || status.message || "Auftrag beendet, aber Status unklar.");
                }
                resetSubmitButton();

            } else if (isRunning || isQueued) { // Polling weiterführen wenn running ODER queued
                 if (dom.submitButton && !dom.submitButton.disabled) {
                     dom.submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verarbeite...';
                     dom.submitButton.disabled = true;
                 }
            } else {
                console.warn(`Unerwarteter Job-Status für ${currentJobId}:`, status);
            }

        } catch (error) {
            console.error('Polling-Fehler:', error);
            appendLog(`Polling fehlgeschlagen für Job ${currentJobId}: ${error.message}`, 'error');
            showError(`Polling-Fehler: ${error.message}. Prozess möglicherweise unterbrochen.`);
            stopPolling();
            resetUIState();
        }
    }

    // (Unverändert)
    function resetSubmitButton() {
        if (dom.submitButton) {
             dom.submitButton.disabled = false;
             dom.submitButton.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Download starten';
             console.log("Submit button reset.");
        }
    }

    // --- History ---
    // (Unverändert)
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

    // (Unverändert)
    function renderHistory(historyData) {
        if (!dom.historyTableBody || !historyEnabled) return;
        dom.historyTableBody.innerHTML = '';
        if (!historyData || !Array.isArray(historyData) || historyData.length === 0) {
            dom.historyTableBody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Keine Einträge im Verlauf.</td></tr>'; return;
        }
        historyData.forEach(entry => {
            try {
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
            } catch (renderError) {
                 console.error("Fehler Rendern History-Eintrag:", entry, renderError);
                 const errorRow = dom.historyTableBody.insertRow();
                 const cell = errorRow.insertCell(); cell.colSpan = 5; cell.textContent = "Fehler Anzeige Eintrag."; cell.style.color = 'red';
            }
        });
    }

    // (Unverändert)
    function createLinkCell(cell, url) {
        if (!cell || typeof cell.appendChild !== 'function') return;
        cell.innerHTML = '';
        const urlString = (url === null || typeof url === 'undefined') ? '' : String(url).trim();
        if (urlString && (urlString.startsWith('http://') || urlString.startsWith('https://'))) {
            try {
                const link = document.createElement('a'); link.href = urlString;
                link.textContent = urlString.length > 50 ? urlString.substring(0, 47) + '...' : urlString;
                link.title = urlString; link.target = "_blank"; link.rel = "noopener noreferrer";
                link.dataset.url = urlString; // Für Kontextmenü
                cell.appendChild(link);
            } catch (e) { console.error(`Fehler Link Erstellung für '${urlString}':`, e); cell.textContent = urlString || 'Fehler'; }
        } else { cell.textContent = urlString || 'N/A'; cell.title = urlString; }
    }

    // --- Kontextmenü ---
    // (Unverändert)
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

    // --- Statistik ---
    // (Unverändert)
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
            dom.statsTotalJobs.textContent = 'Fehler'; dom.statsAvgDuration.textContent = 'Fehler'; dom.statsTotalSize.textContent = 'Fehler';
        }
    }

    // --- Hilfsfunktionen ---
    // (Unverändert)
    function copyToClipboard(text) {
        if (!navigator.clipboard) { /* Fallback */
            try {
                const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed";
                document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy');
                document.body.removeChild(ta); appendLog("Link kopiert (Fallback).", "info");
            } catch (err) { console.error('Fallback Copy failed:', err); alert("Kopieren fehlgeschlagen."); } return;
        }
        navigator.clipboard.writeText(text).then(() => appendLog("Link kopiert.", "info"))
            .catch(err => { console.error('Async Copy failed:', err); alert("Kopieren fehlgeschlagen."); });
    }

    // --- Start ---
    init();

}); // Ende DOMContentLoaded