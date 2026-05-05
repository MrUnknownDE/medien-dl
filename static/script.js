document.addEventListener('DOMContentLoaded', () => {
    const dom = {
        form:           document.getElementById('upload-form'),
        urlInput:       document.getElementById('url'),
        platformInput:  document.getElementById('input-platform'),
        detectionArea:  document.getElementById('detection-area'),
        detectedText:   document.getElementById('detected-text'),
        detectedIcon:   document.getElementById('detected-icon'),
        platformPulse:  document.getElementById('platform-pulse'),
        platformBadge:  document.getElementById('platform-badge'),
        urlIcon:        document.getElementById('url-icon'),
        inputWrapper:   document.getElementById('input-wrapper'),
        ytOptions:      document.getElementById('youtube-options'),
        codecSection:   document.getElementById('codec-options-section'),
        ytRadios:       document.querySelectorAll('input[name="yt_format"]'),
        mp3Select:      document.getElementById('mp3_bitrate'),
        mp4Select:      document.getElementById('mp4_quality'),
        codecSwitch:    document.getElementById('codec-switch'),
        codecPref:      document.getElementById('codec_preference'),
        processView:    document.getElementById('process-view'),
        resultView:     document.getElementById('result-view'),
        formContainer:  document.querySelector('.form-container'),
        statusMsg:      document.getElementById('status-message'),
        progressBar:    document.getElementById('progress-bar'),
        progressPct:    document.getElementById('progress-pct'),
        logContent:     document.getElementById('pseudo-log-content'),
        resultUrl:      document.getElementById('result-url'),
        errorMsg:       document.getElementById('error-message'),
        historyTbody:   document.querySelector('#history-table tbody'),
        clearHistoryBtn:document.getElementById('clear-history-button'),
    };

    let jobId          = null;
    let pollTimer      = null;
    let pseudoTimer    = null;
    let lastLogIndex   = 0;
    let realLogsActive = false;

    // ---- Platform definitions ----
    const PLATFORMS = [
        { name:'SoundCloud', pattern:/soundcloud\.com/,        icon:'fa-soundcloud', color:'#ff5500', rgb:'255,85,0' },
        { name:'YouTube',    pattern:/(youtube\.com|youtu\.be)/,icon:'fa-youtube',   color:'#ff0000', rgb:'255,0,0' },
        { name:'TikTok',     pattern:/tiktok\.com/,            icon:'fa-tiktok',     color:'#fe2c55', rgb:'254,44,85' },
        { name:'Instagram',  pattern:/instagram\.com/,         icon:'fa-instagram',  color:'#E1306C', rgb:'225,48,108' },
        { name:'Twitter',    pattern:/(twitter\.com|x\.com)/,  icon:'fa-x-twitter',  color:'#1d9bf0', rgb:'29,155,240' },
    ];

    const PSEUDO_LOGS = [
        'Connecting to media node...',
        'Handshaking with API endpoint...',
        'Resolving stream metadata...',
        'Allocating download buffer...',
        'Starting download stream...',
        'Processing data chunks...',
        'Verifying file integrity...',
        'Optimizing audio/video container...',
        'Preparing upload to storage...',
        'Syncing with remote bucket...',
    ];

    // ---- Init ----
    function init() {
        bindEvents();
        renderHistory();
    }

    function bindEvents() {
        dom.urlInput.addEventListener('input', onUrlChange);
        dom.form.addEventListener('submit', onSubmit);
        dom.ytRadios.forEach(r => r.addEventListener('change', updateQualitySelect));
        if (dom.codecSwitch) {
            dom.codecSwitch.addEventListener('change', e => {
                dom.codecPref.value = e.target.checked ? 'h264' : 'original';
            });
        }
        if (dom.clearHistoryBtn) {
            dom.clearHistoryBtn.addEventListener('click', clearHistory);
        }
    }

    // ---- URL detection ----
    function onUrlChange() {
        const val = dom.urlInput.value.trim();
        const match = PLATFORMS.find(p => p.pattern.test(val));

        if (match) {
            applyPlatform(match);
        } else if (!val) {
            resetPlatform();
        }
    }

    function applyPlatform(p) {
        dom.platformInput.value = p.name;
        dom.detectedText.textContent = p.name + ' detected';
        dom.detectedIcon.className = 'fab ' + p.icon;
        dom.urlIcon.innerHTML = `<i class="fab ${p.icon}"></i>`;
        dom.urlIcon.style.color = p.color;

        // CSS vars for color theming
        document.documentElement.style.setProperty('--platform-color', p.color);
        document.documentElement.style.setProperty('--platform-rgb', p.rgb);

        // Badge colors
        dom.platformBadge.style.borderColor = `rgba(${p.rgb}, 0.3)`;
        dom.platformBadge.style.background  = `rgba(${p.rgb}, 0.1)`;
        dom.platformBadge.style.color       = p.color;
        if (dom.platformPulse) {
            dom.platformPulse.style.background = p.color;
            dom.platformPulse.style.boxShadow  = `0 0 8px ${p.color}`;
        }

        // Input glow tint
        dom.inputWrapper.style.setProperty('--platform-glow', `rgba(${p.rgb}, 0.15)`);

        dom.detectionArea.classList.add('visible');
        showOptions(p.name);
    }

    function resetPlatform() {
        document.documentElement.style.setProperty('--platform-color', '#8b5cf6');
        dom.urlIcon.innerHTML = '<i class="fas fa-link"></i>';
        dom.urlIcon.style.color = '';
        dom.detectionArea.classList.remove('visible');
    }

    function showOptions(name) {
        dom.ytOptions.classList.add('d-none');
        dom.codecSection.classList.add('d-none');
        if (name === 'YouTube') {
            dom.ytOptions.classList.remove('d-none');
            updateQualitySelect();
        } else if (['TikTok','Instagram','Twitter'].includes(name)) {
            dom.codecSection.classList.remove('d-none');
        }
    }

    function updateQualitySelect() {
        const fmt = document.querySelector('input[name="yt_format"]:checked')?.value;
        dom.mp3Select.classList.toggle('d-none', fmt !== 'mp3');
        dom.mp4Select.classList.toggle('d-none', fmt === 'mp3');
    }

    // ---- Submit ----
    async function onSubmit(e) {
        e.preventDefault();

        dom.formContainer.classList.add('d-none');
        dom.processView.classList.remove('d-none');
        dom.resultView.classList.add('d-none');
        dom.errorMsg.classList.add('d-none');
        dom.logContent.innerHTML = '';

        lastLogIndex   = 0;
        realLogsActive = false;
        setProgress(0);
        dom.statusMsg.textContent = 'INITIALIZING...';

        startPseudoLogs();

        try {
            const res  = await fetch('/start_download', { method:'POST', body: new FormData(dom.form) });
            const data = await res.json();
            if (res.ok && data.job_id) {
                jobId = data.job_id;
                startPolling();
            } else {
                throw new Error(data.error || 'Failed to start job');
            }
        } catch (err) {
            showError(err.message);
        }
    }

    // ---- Polling ----
    function startPolling() {
        pollTimer = setInterval(async () => {
            if (!jobId) return;
            try {
                const res = await fetch(`/status?job_id=${jobId}`);
                if (res.status === 404) { showError('Job not found'); return; }
                const s = await res.json();

                setProgress(s.progress || 0);
                if (s.message) dom.statusMsg.textContent = s.message.toUpperCase();

                // Show real server logs as they arrive
                if (Array.isArray(s.logs) && s.logs.length > lastLogIndex) {
                    if (!realLogsActive) {
                        realLogsActive = true;
                        clearInterval(pseudoTimer);
                        removeCursor();
                    }
                    s.logs.slice(lastLogIndex).forEach(line => addLine(line, 'is-real'));
                    lastLogIndex = s.logs.length;
                }

                if (s.status === 'completed') {
                    onJobDone(s.result_url);
                } else if (s.status === 'error' || s.error) {
                    showError(s.error || s.message);
                }
            } catch {
                // network blip — keep polling
            }
        }, 1000);
    }

    // ---- Terminal ----
    function addLine(text, cls = '') {
        removeCursor();

        const el = document.createElement('div');
        el.className = 'terminal-line' + (cls ? ' ' + cls : '');
        el.textContent = (cls === 'is-real' ? '» ' : '> ') + text;

        const cur = document.createElement('span');
        cur.className = 'term-cursor';
        el.appendChild(cur);

        dom.logContent.appendChild(el);
        dom.logContent.scrollTop = dom.logContent.scrollHeight;
    }

    function removeCursor() {
        dom.logContent.querySelectorAll('.term-cursor').forEach(c => c.remove());
    }

    function startPseudoLogs() {
        let idx = 0;
        addLine(PSEUDO_LOGS[idx++]);
        pseudoTimer = setInterval(() => {
            if (realLogsActive) { clearInterval(pseudoTimer); return; }
            if (idx < PSEUDO_LOGS.length) addLine(PSEUDO_LOGS[idx++]);
        }, 2400);
    }

    // ---- Progress ----
    function setProgress(val) {
        const pct = Math.min(100, Math.max(0, Math.round(val)));
        dom.progressBar.style.width = pct + '%';
        if (dom.progressPct) dom.progressPct.textContent = pct + '%';
    }

    // ---- Finish ----
    function onJobDone(url) {
        clearInterval(pollTimer);
        clearInterval(pseudoTimer);
        removeCursor();

        const done = document.createElement('div');
        done.className = 'terminal-line is-success';
        done.textContent = '✓ Upload complete. Your file is ready.';
        dom.logContent.appendChild(done);
        dom.logContent.scrollTop = dom.logContent.scrollHeight;

        setProgress(100);

        setTimeout(() => {
            dom.processView.classList.add('d-none');
            dom.resultView.classList.remove('d-none');
            if (url) dom.resultUrl.href = url;
        }, 700);

        persistHistory(url);
    }

    // ---- Error ----
    function showError(msg) {
        clearInterval(pollTimer);
        clearInterval(pseudoTimer);
        dom.processView.classList.add('d-none');
        dom.formContainer.classList.remove('d-none');
        dom.errorMsg.textContent = msg;
        dom.errorMsg.classList.remove('d-none');
    }

    // ---- LocalStorage History ----
    const LS_KEY = 'mdl_history';
    const TTL    = 7 * 24 * 60 * 60 * 1000; // 7 days

    function persistHistory(resultUrl) {
        const entry = {
            url:      resultUrl,
            source:   dom.urlInput.value.trim(),
            platform: dom.platformInput.value,
            title:    dom.platformInput.value + ' Download',
            ts:       Date.now(),
        };
        let data = readHistory();
        data.unshift(entry);
        if (data.length > 30) data.length = 30;
        localStorage.setItem(LS_KEY, JSON.stringify(data));
        renderHistory();
    }

    function readHistory() {
        try {
            const raw  = localStorage.getItem(LS_KEY);
            if (!raw) return [];
            const data = JSON.parse(raw).filter(i => Date.now() - i.ts < TTL);
            localStorage.setItem(LS_KEY, JSON.stringify(data));
            return data;
        } catch { return []; }
    }

    function renderHistory() {
        const data = readHistory();
        if (!dom.historyTbody) return;

        if (!data.length) {
            dom.historyTbody.innerHTML =
                '<tr><td colspan="5" style="text-align:center;padding:2rem;color:rgba(255,255,255,0.25);font-size:0.82rem">No downloads yet</td></tr>';
            return;
        }

        dom.historyTbody.innerHTML = '';
        data.forEach((item, i) => {
            const d    = new Date(item.ts);
            const date = d.toLocaleDateString([], { month:'short', day:'numeric' });
            const time = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

            const tr = document.createElement('tr');
            tr.className = 'history-row-enter';
            tr.style.animationDelay = (i * 0.04) + 's';
            tr.innerHTML = `
                <td class="ps-4" style="font-family:var(--mono);font-size:0.72rem;color:rgba(255,255,255,0.35);white-space:nowrap">${date} ${time}</td>
                <td><span style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.2);color:var(--accent);padding:2px 10px;border-radius:100px;font-size:0.7rem">${escHtml(item.platform)}</span></td>
                <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.title || 'Download')}</td>
                <td style="text-align:center">
                    ${item.source
                        ? `<a href="${escHtml(item.source)}" target="_blank" rel="noopener" title="${escHtml(item.source)}"><i class="fas fa-arrow-up-right-from-square fa-sm"></i></a>`
                        : '<span style="color:rgba(255,255,255,0.2)">—</span>'}
                </td>
                <td class="text-end pe-4">
                    <a href="${escHtml(item.url)}" target="_blank" rel="noopener"
                       style="background:rgba(139,92,246,0.12);border:1px solid rgba(139,92,246,0.2);color:var(--accent);padding:3px 12px;border-radius:100px;font-size:0.72rem;text-decoration:none;white-space:nowrap">
                        <i class="fas fa-download me-1"></i>Get
                    </a>
                </td>`;
            dom.historyTbody.appendChild(tr);
        });
    }

    function clearHistory() {
        if (!confirm('Clear all download history?')) return;
        localStorage.removeItem(LS_KEY);
        renderHistory();
    }

    function escHtml(s) {
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    init();
});
