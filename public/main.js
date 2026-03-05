'use strict';

// ─── Stato globale ─────────────────────────────────────────────────────────────
const State = {
    csrfToken:           '',
    inputCounter:        1,
    lastAudioController: 'controller0',
    originalButtonStates: [],
};

// ─── Riferimenti DOM frequenti ────────────────────────────────────────────────
const DOM = {
    main:            () => document.getElementById('main'),
    audioPlayer:     () => document.getElementById('audioPlayer'),
    saveAll:         () => document.getElementById('saveAll'),
    companyInput:    () => document.getElementById('ragioneSociale_input'),
    musicSelect:     () => document.getElementById('music'),
    errorMessage:    () => document.getElementById('errorMessage'),
    errorModal:      () => new bootstrap.Modal(document.getElementById('errorModal')),
};

// ─── Utilità ──────────────────────────────────────────────────────────────────

function showError(message) {
    DOM.errorMessage().innerText = message;
    DOM.errorModal().show();
}

function showLoader() {
    document.querySelector('.container').style.opacity = '0.5';
    const buttons = document.querySelectorAll('button');
    State.originalButtonStates = Array.from(buttons).map(b => b.disabled);
    buttons.forEach(b => b.disabled = true);
}

function hideLoader() {
    document.querySelector('.container').style.opacity = '1';
    const buttons = document.querySelectorAll('button');
    buttons.forEach((b, i) => { b.disabled = State.originalButtonStates[i]; });
}

// Escape HTML per SSML — salta il contenuto tra parentesi quadre (tag SSML)
function escapeForSSML(str) {
    const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
    let result = '';
    let i = 0;
    while (i < str.length) {
        if (str[i] === '[') {
            const end = str.indexOf(']', i);
            if (end === -1) { result += str.slice(i); break; }
            result += str.slice(i, end + 1); // copia il blocco SSML intatto
            i = end + 1;
        } else {
            result += MAP[str[i]] ?? str[i];
            i++;
        }
    }
    return result;
}

// Risolvi nomi duplicati nei fileName
function deduplicateFileName(textarea) {
    const current = textarea.value;
    if (!current) return;

    const others = Array.from(document.querySelectorAll('textarea[id^="fileName"]'))
        .filter(t => t !== textarea)
        .map(t => t.value);

    let candidate = current;
    let suffix    = 1;
    while (others.includes(candidate)) {
        candidate = `${current}(${suffix++})`;
    }
    textarea.value = candidate;
}

// Correzione automatica testo incollato
function correctText(raw) {
    const DAYS = {
        lunedi: 'lunedì', martedi: 'martedì', mercoledi: 'mercoledì',
        giovedi: 'giovedì', venerdi: 'venerdì',
    };

    return raw
        .toLowerCase()
        .replace(/\b(lunedi|martedi|mercoledi|giovedi|venerdi)\b/g, m => DAYS[m] ?? m)
        .replace(/(\d{1,2})[.,](\d{2})/g, '$1:$2')   // 13.30 → 13:30
        .replace(/\s*\([^)]+\)/g, ' ')                // rimuovi parentesi
        .replace(/\n+/g, '. ')                         // newline → punto
        .replace(/\.{2,}/g, '.')                       // punti multipli → uno
        .replace(/,{2,}/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/\s*([.,])\s*/g, '$1 ')
        .trim();
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────

async function fetchCsrfToken() {
    const res  = await fetch('/api/csrf-token');
    const data = await res.json();
    State.csrfToken = data.csrfToken;
}

// Sempre fresco prima di ogni POST sensibile
async function getFreshCsrfToken() {
    await fetchCsrfToken();
    return State.csrfToken;
}

// ─── Fetch helper con CSRF ────────────────────────────────────────────────────

async function postJSON(url, body) {
    const token = await getFreshCsrfToken();
    const res   = await fetch(url, {
        method:  'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        },
        body: JSON.stringify({ ...body, _csrf: token }),
    });
    if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
    }
    return res;
}

// ─── Lista canzoni ────────────────────────────────────────────────────────────

async function loadMusicOptions(apiUrl, selectId) {
    try {
        const res  = await fetch(apiUrl);
        if (!res.ok) throw new Error('Errore nel caricamento canzoni');
        const data = await res.json();

        const select = document.getElementById(selectId);
        select.innerHTML = '';

        const blank = new Option('Nessuna canzone', 'blank');
        select.appendChild(blank);

        data.forEach(fileName => {
            const label = fileName.replace(/\.mp3$/i, '');
            const text  = label.length > 30 ? label.substring(0, 30).trim() + '…' : label;
            select.appendChild(new Option(text, fileName));
        });
    } catch (err) {
        console.error('[loadMusicOptions]', err);
    }
}

// ─── Costruzione righe dinamiche ──────────────────────────────────────────────

function buildRow(id) {
    const div = document.createElement('div');
    div.className = 'row';
    div.id        = `formRow${id}`;
    div.innerHTML = `
      <div class="col-md-3">
        <div class="row d-flex ms-md-1 d-md-align-items-start justify-content-md-start justify-content-center">
          <button type="button" class="btn-close custom-btn-close" id="deleteRow${id}"></button>
        </div>
        <div class="row m-1 mt-3">
          <textarea class="form-control" id="fileName${id}" rows="1"
            placeholder="Tipo (Benvenuto, Notte…)"></textarea>
        </div>
        <div class="row nameShortcut">
          ${['Benvenuto','Notte','Attesa','Occupato'].map(n =>
            `<div class="col-2 m-1">
               <button type="button" id="${n}_fileName${id}" class="btn btn-sm btn-primary">
                 ${n.substring(0,3)}.
               </button>
             </div>`
          ).join('')}
        </div>
        <div class="row m-1">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="translateCheck${id}" />
            <label class="form-check-label" for="translateCheck${id}">Aggiungi traduzione</label>
          </div>
        </div>
      </div>
      <div class="col-md-8">
        <div class="row">
          <textarea class="form-control m-1" id="messageText${id}" rows="5"></textarea>
        </div>
      </div>
      <div class="col-md-1 text-center d-flex flex-column align-items-center justify-content-center">
        <button class="btn btn-danger mt-3 mb-3" id="controller${id}" disabled>Play</button>
      </div>
      <div class="row mt-1 rowLine"><hr></div>`;
    return div;
}

document.getElementById('addInput').addEventListener('click', () => {
    const id = State.inputCounter++;
    DOM.main().appendChild(buildRow(id));
    // Scroll solo se la pagina ha già overflow
    if (window.innerHeight < document.documentElement.scrollHeight) {
        window.scrollBy(0, document.documentElement.scrollHeight);
    }
});

// ─── Toggle traduzione (checkbox) ─────────────────────────────────────────────

DOM.main().addEventListener('change', e => {
    if (!e.target.matches('input[type="checkbox"][id^="translateCheck"]')) return;

    const num      = e.target.id.replace('translateCheck', '');
    const msgEl    = document.getElementById(`messageText${num}`);
    const ctrlEl   = document.getElementById(`controller${num}`);
    const isChecked = e.target.checked;

    if (isChecked) {
        msgEl?.setAttribute('rows', '2');

        // Aggiunge textarea ENG
        const engDiv = document.createElement('div');
        engDiv.className = 'row';
        engDiv.innerHTML = `<textarea class="form-control m-1" id="ENGmessageText${num}" rows="2"></textarea>`;
        msgEl?.closest('.row')?.insertAdjacentElement('afterend', engDiv);

        // Aggiunge pulsante ENG Play
        const engBtn  = document.createElement('button');
        engBtn.className = 'btn btn-danger mt-3 mb-3';
        engBtn.id        = `ENGcontroller${num}`;
        engBtn.disabled  = true;
        engBtn.innerText = 'Play';
        ctrlEl?.insertAdjacentElement('afterend', engBtn);
    } else {
        msgEl?.setAttribute('rows', '5');
        document.getElementById(`ENGmessageText${num}`)?.closest('.row')?.remove();
        document.getElementById(`ENGcontroller${num}`)?.remove();
    }
});

// ─── Eliminazione riga + file audio dal server ────────────────────────────────

DOM.main().addEventListener('click', async e => {
    if (!e.target.matches('[id^="deleteRow"]')) return;
    if (document.querySelectorAll('[id^="formRow"]').length <= 1) return;

    const num        = e.target.id.replace('deleteRow', '');
    const row        = document.getElementById(`formRow${num}`);
    const fileName   = document.getElementById(`fileName${num}`)?.value?.trim();
    const folderPath = `_temp_${DOM.companyInput().value}`;

    row?.remove();

    if (!fileName) return;

    const filesToDelete = [`${fileName}.mp3`];
    if (document.getElementById(`ENGmessageText${num}`)) {
        filesToDelete.push(`ENG_${fileName}.mp3`);
    }

    try {
        await postJSON('/delete-audio', { files: filesToDelete, folder: folderPath });
    } catch {
        // Eliminazione silente: la riga è già rimossa dal DOM
    }
});

// ─── Disabilita controller su modifica testo ──────────────────────────────────

DOM.main().addEventListener('input', e => {
    const num = (e.target.id.match(/\d+/) ?? [])[0];
    if (!num) return;

    if (e.target.matches('[id^="ENGmessageText"]')) {
        const btn = document.getElementById(`ENGcontroller${num}`);
        if (btn) btn.disabled = true;
    } else if (e.target.matches('[id^="messageText"]')) {
        const btn = document.getElementById(`controller${num}`);
        if (btn) btn.disabled = true;
    }
});

// ─── Cambio ragione sociale → invalida tutti i controller ────────────────────

DOM.companyInput().addEventListener('input', () => {
    document.querySelectorAll('[id^="controller"], [id^="ENGcontroller"]')
        .forEach(el => { el.disabled = true; });
});

DOM.companyInput().addEventListener('keypress', e => {
    if (e.key === 'Enter') e.preventDefault();
});

// ─── Shortcut nome file (Ben. / Not. / Att. / Occ.) ──────────────────────────

DOM.main().addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON' || !e.target.closest('.nameShortcut')) return;
    const [name, , targetId] = e.target.id.split('_'); // "Benvenuto_fileName3" → ["Benvenuto","fileName3"]
    const fullId = e.target.id.split('_').slice(1).join('_'); // gestisce underscore nel nome
    const el = document.getElementById(fullId);
    if (el) el.value = name;
});

// ─── Deduplicazione e capitalizzazione fileName ───────────────────────────────

DOM.main().addEventListener('focusout', e => {
    if (!e.target.matches('textarea[id^="fileName"]') || !e.target.value) return;
    e.target.value = e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1);
    deduplicateFileName(e.target);
});

// ─── Navigazione con TAB tra textarea ────────────────────────────────────────

document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const idx       = textareas.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    textareas[(idx + 1) % textareas.length].focus();
});

// ─── Correzione automatica al paste ──────────────────────────────────────────

DOM.main().addEventListener('paste', e => {
    if (!e.target.matches('textarea[id^="messageText"]')) return;
    setTimeout(() => {
        if (e.target.value) e.target.value = correctText(e.target.value);
    }, 0);
});

// ─── Disabilita saveAll su qualsiasi cambiamento ──────────────────────────────

document.addEventListener('change', () => {
    DOM.saveAll().disabled = true;
});

// ─── Audio player ─────────────────────────────────────────────────────────────

DOM.main().addEventListener('click', async e => {
    if (!e.target.matches('[id^="ENGcontroller"], [id^="controller"]')) return;
    e.preventDefault();

    const player       = DOM.audioPlayer();
    const controllerName = e.target.id;
    const folderName   = `_temp_${DOM.companyInput().value}`;

    // Toggle pausa se stesso pulsante
    if (!player.paused && State.lastAudioController === controllerName) {
        player.pause();
        e.target.innerText = 'Play';
        return;
    }

    try {
        const res = await fetch(`/play/${encodeURIComponent(folderName)}/${encodeURIComponent(controllerName)}`);
        if (!res.ok) { showError('Canzone non trovata'); return; }

        const { audioUrl } = await res.json();

        if (!player.paused) player.pause();

        const prevBtn = document.getElementById(State.lastAudioController);
        if (prevBtn) prevBtn.innerText = 'Play';

        player.src = `/${folderName}/${audioUrl.split('/').pop()}`;
        player.load();
        player.play();
        e.target.innerText          = 'Pausa';
        State.lastAudioController   = controllerName;
    } catch {
        showError('Si è verificato un errore durante la riproduzione');
    }
});

DOM.audioPlayer().addEventListener('ended', () => {
    const btn = document.getElementById(State.lastAudioController);
    if (btn) btn.innerText = 'Play';
});

// ─── Sintesi vocale (sendQuery) ───────────────────────────────────────────────

document.getElementById('sendQuery').addEventListener('click', async () => {
    const player = DOM.audioPlayer();
    if (!player.paused) {
        player.pause();
        const btn = document.getElementById(State.lastAudioController);
        if (btn) btn.innerText = 'Play';
    }

    const companyName = DOM.companyInput().value.trim();
    if (!companyName) {
        showError('Ragione sociale richiesta');
        return;
    }

    const controllers = document.querySelectorAll('[id^="ENGcontroller"], [id^="controller"]');
    showLoader();
    DOM.saveAll().disabled = true;
    controllers.forEach(el => el.disabled = true);

    // Raccolta dati dai form row
    const data = [];
    for (const row of document.querySelectorAll('[id^="formRow"]')) {
        const fileNameEl  = row.querySelector('[id^="fileName"]');
        const msgEl       = row.querySelector('[id^="messageText"]');
        const engMsgEl    = row.querySelector('[id^="ENGmessageText"]');
        const ctrlEl      = row.querySelector('[id^="controller"]');

        const fileName    = fileNameEl?.value.trim()  ?? '';
        const messageText = msgEl?.value.trim()        ?? '';
        const engText     = engMsgEl?.value.trim()     ?? '';

        const isValid = fileName && messageText && (!engMsgEl || engText);
        if (!isValid) {
            showError('Compila tutti i campi, poi premi Invia');
            hideLoader();
            return;
        }

        data.push({
            fileName,
            messageText:    escapeForSSML(messageText),
            engMessageText: engMsgEl ? escapeForSSML(engText) : null,
            playButtonId:   ctrlEl?.id ?? '',
        });
    }

    try {
        await postJSON('/api/synthesize', { companyName, data });
        hideLoader();
        controllers.forEach(el => el.disabled = false);
        DOM.saveAll().disabled = false;
    } catch (err) {
        console.error('[sendQuery]', err);
        showError('Si è verificato un errore, riprova');
        hideLoader();
    }
});

// ─── Salvataggio ZIP (saveAll) ────────────────────────────────────────────────

DOM.saveAll().addEventListener('click', async e => {
    e.preventDefault();

    const player = DOM.audioPlayer();
    if (!player.paused) {
        player.pause();
        const btn = document.getElementById(State.lastAudioController);
        if (btn) btn.innerText = 'Play';
    }

    const folderName    = DOM.companyInput().value.trim();
    const backgroundSong = DOM.musicSelect().value !== 'blank' ? DOM.musicSelect().value : null;

    if (!folderName) {
        showError('Genera nuovamente i messaggi per proseguire');
        return;
    }

    showLoader();

    try {
        const res = await postJSON('/api/save', { folderName, backgroundSong });
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: `${folderName}.zip` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setTimeout(() => window.location.reload(true), 2000);
    } catch (err) {
        console.error('[saveAll]', err);
        showError('Genera nuovamente i messaggi per proseguire');
        hideLoader();
    }
});

// ─── Upload canzone di sottofondo ─────────────────────────────────────────────

document.getElementById('uploadButton').addEventListener('click', () => {
    document.getElementById('audioUpload').click();
});

document.getElementById('audioUpload').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    const token    = await getFreshCsrfToken();
    const formData = new FormData();
    formData.append('audioFile', file);
    formData.append('_csrf', token);

    showLoader();
    try {
        const res = await fetch('/upload', {
            method:  'POST',
            headers: { 'X-CSRF-Token': token },
            body:    formData,
        });
        if (!res.ok) throw new Error();
        await loadMusicOptions('/api/canzoni', 'music');
        hideLoader();
        new bootstrap.Toast(document.getElementById('successToast')).show();
    } catch {
        showError('Errore nel caricamento del file (max 10 MB, solo MP3/WAV)');
        hideLoader();
    }
});

// ─── Copia tag SSML telefono ──────────────────────────────────────────────────

document.getElementById('copyButton1').addEventListener('click', () => {
    navigator.clipboard.writeText('[<say-as interpret-as="telephone">XX</say-as>]')
        .then(() => {
            const modal = bootstrap.Modal.getInstance(document.getElementById('infoModal'));
            modal?.hide();
        });
});

// ─── Inizializzazione al caricamento pagina ───────────────────────────────────

window.addEventListener('load', async () => {
    // Reset form
    document.querySelectorAll('textarea').forEach(t => t.value = '');
    document.querySelectorAll('input[type="checkbox"][id^="translateCheck"]')
        .forEach(cb => { cb.checked = false; });

    await fetchCsrfToken();
    await loadMusicOptions('/api/canzoni', 'music');
});
