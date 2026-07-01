'use strict';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let csrfToken = '';
let inputCounter = 1;
let lastAudioControllerId = 'controller0';
let savedButtonStates = [];

// ─────────────────────────────────────────────
// CSRF
// ─────────────────────────────────────────────
async function fetchCsrfToken() {
    try {
        const res = await fetch('/api/csrf-token');
        const data = await res.json();
        csrfToken = data.csrfToken;
    } catch (e) {
        console.error('[csrf] Failed to fetch token:', e);
    }
}

fetchCsrfToken();

// ─────────────────────────────────────────────
// UI Helpers
// ─────────────────────────────────────────────
function showLoader() {
    document.querySelector('.container').classList.add('loading-overlay');
    savedButtonStates = [];
    document.querySelectorAll('button').forEach(btn => {
        savedButtonStates.push(btn.disabled);
        btn.disabled = true;
    });
}

function hideLoader() {
    document.querySelector('.container').classList.remove('loading-overlay');
    document.querySelectorAll('button').forEach((btn, i) => {
        btn.disabled = savedButtonStates[i] ?? false;
    });
}

function showError(msg) {
    document.getElementById('errorMessage').textContent = msg;
    const modal = new bootstrap.Modal(document.getElementById('errorModal'));
    modal.show();
}

// ─────────────────────────────────────────────
// Music selector
// ─────────────────────────────────────────────
async function loadMusicOptions(apiUrl, selectId) {
    try {
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error('Network error');
        const songs = await res.json();

        const select = document.getElementById(selectId);
        select.innerHTML = '';

        const defaultOpt = new Option('Nessuna canzone', 'blank');
        select.appendChild(defaultOpt);

        for (const song of songs) {
            const name = song.replace('.mp3', '');
            const label = name.length > 30 ? name.substring(0, 30).trim() + '…' : name;
            select.appendChild(new Option(label, song));
        }
    } catch (e) {
        console.error('[music] Failed to load options:', e);
    }
}

// ─────────────────────────────────────────────
// Row Template
// ─────────────────────────────────────────────
function buildRowHTML(n) {
    return `
<div class="col-md-3">
    <div class="d-flex justify-content-end">
        <button type="button" class="btn-close custom-btn-close" id="deleteRow${n}" aria-label="Elimina riga"></button>
    </div>
    <div class="mb-2">
        <textarea class="form-control" id="fileName${n}" rows="1" placeholder="Tipo (Benvenuto, Notte…)"></textarea>
    </div>
    <div class="name-shortcuts mb-2">
        <button type="button" class="btn btn-sm btn-outline-primary" data-shortcut="Benvenuto" data-target="fileName${n}">Ben.</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-shortcut="Notte"     data-target="fileName${n}">Not.</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-shortcut="Attesa"    data-target="fileName${n}">Att.</button>
        <button type="button" class="btn btn-sm btn-outline-primary" data-shortcut="Occupato"  data-target="fileName${n}">Occ.</button>
    </div>
    <div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" id="translateCheck${n}" />
        <label class="form-check-label" for="translateCheck${n}">Aggiungi traduzione EN</label>
    </div>
</div>
<div class="col-md-8">
    <textarea class="form-control" id="messageText${n}" rows="5" placeholder="Testo del messaggio IVR…"></textarea>
</div>
<div class="col-md-1 d-flex flex-column align-items-center justify-content-center">
    <button class="btn btn-sm btn-danger play-btn" id="controller${n}" disabled aria-label="Play/Pausa">&#9654;</button>
</div>
<div class="col-12 mt-2"><hr /></div>
`;
}

// ─────────────────────────────────────────────
// Add Row
// ─────────────────────────────────────────────
document.getElementById('addInput').addEventListener('click', () => {
    const form = document.getElementById('main');
    const row = document.createElement('div');
    row.className = 'row gx-2';
    row.id = `formRow${inputCounter}`;
    row.innerHTML = buildRowHTML(inputCounter);
    form.appendChild(row);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    inputCounter++;
});

// ─────────────────────────────────────────────
// Translate Toggle
// ─────────────────────────────────────────────
document.getElementById('main').addEventListener('change', e => {
    if (!e.target.matches('input[type="checkbox"][id^="translateCheck"]')) return;
    const n = e.target.id.replace('translateCheck', '');
    const msgTA = document.getElementById(`messageText${n}`);
    const controllerEl = document.getElementById(`controller${n}`);

    if (e.target.checked) {
        msgTA.setAttribute('rows', '2');

        // Add EN textarea
        const enDiv = document.createElement('div');
        enDiv.className = 'row mt-1';
        enDiv.innerHTML = `<textarea class="form-control" id="ENGmessageText${n}" rows="2" placeholder="English translation…"></textarea>`;
        msgTA.closest('.col-md-8').appendChild(enDiv);

        // Add EN play button
        const enBtn = document.createElement('button');
        enBtn.className = 'btn btn-sm btn-danger play-btn mt-1';
        enBtn.id = `ENGcontroller${n}`;
        enBtn.disabled = true;
        enBtn.innerHTML = '&#9654;';
        controllerEl.parentNode.appendChild(enBtn);
    } else {
        msgTA.setAttribute('rows', '5');
        document.getElementById(`ENGmessageText${n}`)?.closest('.row')?.remove();
        document.getElementById(`ENGcontroller${n}`)?.remove();
    }
});

// ─────────────────────────────────────────────
// Delete Row
// ─────────────────────────────────────────────
document.addEventListener('click', async e => {
    if (!e.target.matches('[id^="deleteRow"]')) return;
    if (document.querySelectorAll('[id^="formRow"]').length <= 1) return;

    const n = e.target.id.replace('deleteRow', '');
    const row = document.getElementById(`formRow${n}`);
    const fileName = document.getElementById(`fileName${n}`)?.value?.trim();
    const folder = `_temp_${document.getElementById('ragioneSociale_input').value}`;

    row?.remove();

    if (fileName) {
        const toDelete = [`${fileName}.mp3`];
        if (document.getElementById(`ENGmessageText${n}`)) toDelete.push(`eng_${fileName}.mp3`);

        try {
            await fetch('/delete-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                body: JSON.stringify({ files: toDelete, folder, _csrf: csrfToken })
            });
        } catch { /* non-critical */ }
    }
});

// ─────────────────────────────────────────────
// Shortcut Buttons (data-shortcut / data-target)
// ─────────────────────────────────────────────
document.getElementById('main').addEventListener('click', e => {
    const { shortcut, target } = e.target.dataset;
    if (shortcut && target) {
        const el = document.getElementById(target);
        if (el) el.value = shortcut;
    }
});

// ─────────────────────────────────────────────
// Disable play buttons on text change
// ─────────────────────────────────────────────
document.getElementById('main').addEventListener('input', e => {
    if (e.target.matches('[id^="ENGmessageText"]')) {
        const n = e.target.id.match(/\d+/)?.[0];
        if (n) document.getElementById(`ENGcontroller${n}`)?.setAttribute('disabled', true);
    }
    if (e.target.matches('[id^="messageText"]')) {
        const n = e.target.id.match(/\d+/)?.[0];
        if (n) document.getElementById(`controller${n}`)?.setAttribute('disabled', true);
    }
});

// Disable saveAll on any form change
document.addEventListener('change', () => {
    document.getElementById('saveAll').disabled = true;
});

// ─────────────────────────────────────────────
// Company name: reset controllers + prevent enter
// ─────────────────────────────────────────────
document.getElementById('ragioneSociale_input').addEventListener('input', () => {
    document.querySelectorAll('[id^="controller"],[id^="ENGcontroller"]')
        .forEach(el => el.setAttribute('disabled', true));
});

document.getElementById('ragioneSociale_input').addEventListener('keypress', e => {
    if (e.key === 'Enter') e.preventDefault();
});

// ─────────────────────────────────────────────
// fileName: capitalise + dedup on blur
// ─────────────────────────────────────────────
document.getElementById('main').addEventListener('focusout', e => {
    if (!e.target.matches('textarea[id^="fileName"]') || !e.target.value) return;
    e.target.value = e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1);
    deduplicateFileName(e.target);
});

function deduplicateFileName(el) {
    const current = el.value;
    const all = [...document.querySelectorAll('textarea[id^="fileName"]')].filter(t => t !== el);
    let candidate = current;
    let i = 1;
    while (all.some(t => t.value === candidate)) {
        candidate = `${current}(${i++})`;
    }
    el.value = candidate;
}

// ─────────────────────────────────────────────
// TAB navigation between textareas
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const textareas = [...document.querySelectorAll('textarea')];
    const idx = textareas.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    textareas[(idx + 1) % textareas.length].focus();
});

// ─────────────────────────────────────────────
// Text sanitisation
// ─────────────────────────────────────────────
function escapeString(str) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
    const parts = str.split('');
    let inside = false;
    return parts.map(ch => {
        if (ch === '[') { inside = true; return ch; }
        if (ch === ']') { inside = false; return ch; }
        return inside ? ch : (map[ch] || ch);
    }).join('');
}

function correctText(text) {
    const days = {
        lunedi: 'lunedì', martedi: 'martedì', mercoledi: 'mercoledì',
        giovedi: 'giovedì', venerdi: 'venerdì'
    };
    return text
        .toLowerCase()
        .replace(/\b(lunedi|martedi|mercoledi|giovedi|venerdi)\b/g, m => days[m] || m)
        .replace(/(\d{1,2})[.,](\d{2})/g, '$1:$2')
        .replace(/\s*\([^)]+\)/g, ' ')
        .replace(/\n+/g, '. ')
        .replace(/\.{2,}/g, '.')
        .replace(/,{2,}/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/\s*([.,])\s*/g, '$1 ')
        .trim();
}

document.getElementById('main').addEventListener('paste', e => {
    if (!e.target.matches('textarea[id^="messageText"]')) return;
    setTimeout(() => {
        if (e.target.value) e.target.value = correctText(e.target.value);
    }, 0);
});

// ─────────────────────────────────────────────
// Audio Player
// ─────────────────────────────────────────────
const audioPlayer = document.getElementById('audioPlayer');

function stopAudio() {
    if (!audioPlayer.paused) {
        audioPlayer.pause();
        const btn = document.getElementById(lastAudioControllerId);
        if (btn) btn.innerHTML = '&#9654;';
    }
}

audioPlayer.addEventListener('ended', () => {
    const btn = document.getElementById(lastAudioControllerId);
    if (btn) btn.innerHTML = '&#9654;';
});

document.getElementById('main').addEventListener('click', async e => {
    if (!e.target.matches('[id^="ENGcontroller"],[id^="controller"]')) return;
    e.preventDefault();

    const controllerId = e.target.id;
    const folder = `_temp_${document.getElementById('ragioneSociale_input').value}`;

    if (!audioPlayer.paused && lastAudioControllerId === controllerId) {
        stopAudio();
        return;
    }

    try {
        const res = await fetch(`/play/${encodeURIComponent(folder)}/${encodeURIComponent(controllerId)}`);
        if (!res.ok) {
            showError('Audio non trovato. Rigenera i messaggi e riprova.');
            return;
        }
        const { audioUrl } = await res.json();

        stopAudio();
        audioPlayer.src = `/${folder}/${audioUrl.split('/').pop()}`;
        audioPlayer.load();
        await audioPlayer.play();

        e.target.innerHTML = '&#9646;&#9646;';
        lastAudioControllerId = controllerId;
    } catch (err) {
        console.error('[audio]', err);
        showError('Errore di rete durante la riproduzione.');
    }
});

// ─────────────────────────────────────────────
// Synthesize (Genera e ascolta)
// ─────────────────────────────────────────────
document.getElementById('sendQuery').addEventListener('click', async () => {
    stopAudio();
    showLoader();
    document.getElementById('saveAll').disabled = true;

    const companyName = document.getElementById('ragioneSociale_input').value.trim();
    if (!companyName) {
        hideLoader();
        showError('Ragione sociale richiesta. Compila il campo per procedere.');
        return;
    }

    const song = document.getElementById('music').value;
    const backgroundSong = song !== 'blank' ? song : null;
    const rows = document.querySelectorAll('[id^="formRow"]');
    const data = [];

    try {
        for (const row of rows) {
            const fileName = row.querySelector('[id^="fileName"]').value.trim();
            const messageText = row.querySelector('[id^="messageText"]').value.trim();
            const engEl = row.querySelector('[id^="ENGmessageText"]');
            const engText = engEl ? engEl.value.trim() : null;
            const playButtonId = row.querySelector('[id^="controller"]').id;

            if (!fileName || !messageText || (engEl && !engText)) {
                hideLoader();
                showError('Compila tutti i campi prima di procedere.');
                return;
            }

            data.push({
                fileName,
                messageText: escapeString(messageText),
                engMessageText: engText ? escapeString(engText) : null,
                playButtonId
            });
        }

        await fetchCsrfToken();

        const res = await fetch('/api/synthesize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ companyName, backgroundSong, data, _csrf: csrfToken })
        });

        if (!res.ok) throw new Error(res.statusText);

        hideLoader();
        document.querySelectorAll('[id^="controller"],[id^="ENGcontroller"]')
            .forEach(el => el.removeAttribute('disabled'));
        document.getElementById('saveAll').disabled = false;
    } catch (err) {
        console.error('[synthesize]', err);
        hideLoader();
        showError('Errore di rete. Controlla la connessione e riprova.');
    }
});

// ─────────────────────────────────────────────
// Save ZIP
// ─────────────────────────────────────────────
document.getElementById('saveAll').addEventListener('click', async () => {
    stopAudio();
    showLoader();

    const folderName = document.getElementById('ragioneSociale_input').value.trim();
    const backgroundSong = document.getElementById('music').value;
    const bg = backgroundSong !== 'blank' ? backgroundSong : null;

    if (!folderName) {
        hideLoader();
        showError('Genera prima i messaggi prima di salvare.');
        return;
    }

    try {
        await fetchCsrfToken();
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ folderName, backgroundSong: bg, _csrf: csrfToken })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || 'Errore nella richiesta');
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), { href: url, download: `${folderName}.zip` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setTimeout(() => {
            hideLoader();
            window.location.reload(true);
        }, 1500);
    } catch (err) {
        console.error('[save]', err);
        hideLoader();
        showError('Errore durante il salvataggio. Rigenera i messaggi e riprova.');
    }
});

// ─────────────────────────────────────────────
// File Upload
// ─────────────────────────────────────────────
document.getElementById('uploadButton').addEventListener('click', () => {
    document.getElementById('audioUpload').click();
});

document.getElementById('audioUpload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('audioFile', file);
    formData.append('_csrf', csrfToken);

    showLoader();
    try {
        const res = await fetch('/upload', {
            method: 'POST',
            headers: { 'X-CSRF-Token': csrfToken },
            body: formData
        });
        if (!res.ok) throw new Error('Upload failed');

        await loadMusicOptions('/api/canzoni', 'music');
        hideLoader();

        const toast = new bootstrap.Toast(document.getElementById('successToast'));
        toast.show();
    } catch {
        hideLoader();
        showError("Errore nel caricamento. Verifica dimensione (max 10 MB) ed estensione (MP3/WAV).");
    }
});

// ─────────────────────────────────────────────
// Copy SSML snippet
// ─────────────────────────────────────────────
document.getElementById('copyButton1').addEventListener('click', async () => {
    const snippet = document.getElementById('ssmlPhoneSnippet').textContent;
    try {
        await navigator.clipboard.writeText(snippet);
        bootstrap.Modal.getInstance(document.getElementById('infoModal'))?.hide();
    } catch { /* clipboard not available */ }
});

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
window.addEventListener('load', () => {
    document.querySelectorAll('textarea').forEach(ta => ta.value = '');
    document.querySelectorAll('input[type="checkbox"][id^="translateCheck"]')
        .forEach(cb => cb.checked = false);
    loadMusicOptions('/api/canzoni', 'music');
});
