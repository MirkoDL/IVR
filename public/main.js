'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CSRF TOKEN
// ─────────────────────────────────────────────────────────────────────────────

/** Token CSRF aggiornato prima di ogni richiesta POST */
let csrfToken = '';

/**
 * Recupera un token CSRF fresco dal server.
 * Deve essere chiamata prima di ogni richiesta POST per garantire
 * che il token sia sempre valido (non scaduto).
 *
 * @returns {Promise<string>} Il token CSRF
 */
async function fetchCsrfToken() {
    const response = await fetch('/api/csrf-token');
    if (!response.ok) throw new Error('Impossibile recuperare il token CSRF.');
    const data = await response.json();
    csrfToken = data.csrfToken;
    return csrfToken;
}

// Carica il token all'avvio della pagina
fetchCsrfToken();

// ─────────────────────────────────────────────────────────────────────────────
// CACHE SINTESI VOCALE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot dell'ultima sintesi riuscita.
 * Struttura: Map<playButtonId, { fileName, messageText, engMessageText }>
 * Usata per confrontare i valori attuali e saltare le chiamate a Polly
 * per i messaggi che non sono cambiati dall'ultima generazione.
 */
const synthesisCache = new Map();

/**
 * Aggiorna la cache con i dati dell'ultima sintesi riuscita.
 * @param {Array} data - Array di oggetti messaggio già inviati con successo a Polly
 */
function updateSynthesisCache(data) {
    data.forEach(item => {
        synthesisCache.set(item.playButtonId, {
            fileName:       item.fileName,
            messageText:    item.messageText,
            engMessageText: item.engMessageText,
        });
    });
}

/**
 * Invalida la cache per una specifica riga (es. quando viene eliminata).
 * @param {string} playButtonId
 */
function invalidateCacheEntry(playButtonId) {
    synthesisCache.delete(playButtonId);
}

/**
 * Controlla se un messaggio è identico all'ultima sintesi in cache.
 * @param {{ playButtonId: string, fileName: string, messageText: string, engMessageText: string|null }} item
 * @returns {boolean}
 */
function isCached(item) {
    const cached = synthesisCache.get(item.playButtonId);
    if (!cached) return false;
    return (
        cached.fileName       === item.fileName &&
        cached.messageText    === item.messageText &&
        cached.engMessageText === item.engMessageText
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY DI SICUREZZA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Esegue l'escape dei caratteri HTML speciali in una stringa.
 * IMPORTANTE: usare sempre questa funzione prima di inserire
 * contenuto utente nel DOM tramite innerHTML.
 *
 * @param {string} str - Stringa da sanificare
 * @returns {string} Stringa con caratteri HTML escapati
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#039;');
}

/**
 * Esegue l'escape di una stringa per uso in SSML/XML.
 * Preserva i tag SSML tra parentesi quadre (es. [<say-as>]).
 * Tutto il resto viene escapato per evitare injection nell'XML inviato a Polly.
 *
 * @param {string} str - Testo del messaggio IVR
 * @returns {string} Testo con entità XML escapate (tranne i tag SSML)
 */
function escapeXmlPreserveSSML(str) {
    const parts = str.split('');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '[') {
            // Salta il contenuto del tag SSML fino alla parentesi chiusa
            while (i < parts.length && parts[i] !== ']') i++;
            continue;
        }
        switch (parts[i]) {
            case '&':  parts[i] = '&amp;';  break;
            case '<':  parts[i] = '&lt;';   break;
            case '>':  parts[i] = '&gt;';   break;
            case '"':  parts[i] = '&quot;'; break;
            case "'":  parts[i] = '&apos;'; break;
        }
    }
    return parts.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADER UI
// ─────────────────────────────────────────────────────────────────────────────

/** Stato originale dei pulsanti prima di disabilitarli con il loader */
let originalButtonStates = [];

/**
 * Attiva il loader: aggiunge la classe CSS .container--loading e disabilita
 * tutti i pulsanti. Evita di impostare style.opacity direttamente per
 * rispettare la Content Security Policy (no unsafe-inline).
 */
function showLoader() {
    document.querySelector('.container').classList.add('container--loading');
    const buttons = document.querySelectorAll('button');
    originalButtonStates = Array.from(buttons).map(btn => btn.disabled);
    buttons.forEach(btn => { btn.disabled = true; });
}

/**
 * Disattiva il loader: rimuove la classe CSS .container--loading e ripristina
 * lo stato dei pulsanti.
 */
function hideLoader() {
    document.querySelector('.container').classList.remove('container--loading');
    document.querySelectorAll('button').forEach((btn, i) => {
        btn.disabled = originalButtonStates[i] ?? false;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODALE ERRORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mostra un messaggio di errore in un modal Bootstrap.
 * Il testo viene escapato per prevenire XSS.
 *
 * @param {string} message - Messaggio da visualizzare
 */
function showError(message) {
    // Usa textContent per prevenire XSS — mai innerHTML con dati non fidati
    document.getElementById('errorMessage').textContent = message;
    const modal = new bootstrap.Modal(document.getElementById('errorModal'));
    modal.show();
}

// ─────────────────────────────────────────────────────────────────────────────
// SELEZIONE MUSICA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carica le opzioni musicali dal server e le inserisce nel <select>.
 * I valori vengono inseriti come attributi, non come innerHTML,
 * per prevenire injection da nomi file malevoli.
 *
 * @param {string} apiUrl         - URL dell'API che restituisce la lista MP3
 * @param {string} selectElementId - ID dell'elemento <select> da popolare
 */
function loadMusicOptions(apiUrl, selectElementId) {
    fetch(apiUrl)
        .then(res => {
            if (!res.ok) throw new Error('Errore nel recupero delle canzoni.');
            return res.json();
        })
        .then(data => {
            const select = document.getElementById(selectElementId);
            select.innerHTML = '';

            // Opzione predefinita (nessuna canzone)
            const defaultOpt = document.createElement('option');
            defaultOpt.value       = 'blank';
            defaultOpt.textContent = 'Nessuna canzone';
            select.appendChild(defaultOpt);

            data.forEach(value => {
                // Usa textContent (non innerHTML) per prevenire XSS da nomi file malevoli
                const songName    = value.replace('.mp3', '');
                const displayText = songName.length > 30
                    ? songName.substring(0, 30).trim() + '...'
                    : songName;

                const option = document.createElement('option');
                option.value       = value;       // attributo value: sicuro
                option.textContent = displayText; // textContent: sicuro
                select.appendChild(option);
            });
        })
        .catch(err => console.error('[loadMusicOptions]', err));
}

// ─────────────────────────────────────────────────────────────────────────────
// INIZIALIZZAZIONE PAGINA
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('load', () => {
    // Pulisce le textarea e i checkbox al caricamento (evita dati fantasma dopo reload)
    document.querySelectorAll('textarea').forEach(ta => { ta.value = ''; });
    document.querySelectorAll('input[type="checkbox"][id^="translateCheck"]')
            .forEach(cb => { cb.checked = false; });

    loadMusicOptions('/api/canzoni', 'music');
});

// ─────────────────────────────────────────────────────────────────────────────
// GESTIONE RIGHE FORM (aggiungi / rimuovi)
// ─────────────────────────────────────────────────────────────────────────────

/** Contatore progressivo per l'ID delle righe dinamiche */
let inputCounter = 1;

/**
 * Genera l'HTML di una nuova riga del form IVR.
 * NOTA SICUREZZA: inputCounter è sempre un intero controllato lato client,
 * NON proviene dall'utente. Tutti gli altri valori sono attributi, mai innerHTML.
 *
 * @param {number} n - Indice della riga
 * @returns {string} HTML della riga
 */
function buildRowHtml(n) {
    return `
    <div class="col-md-3">
        <div class="row d-flex ms-md-1 d-md-align-items-start justify-content-md-start justify-content-center">
            <button type="button" class="btn-close custom-btn-close" id="deleteRow${n}"></button>
        </div>
        <div class="row m-1 mt-3">
            <textarea class="form-control" id="fileName${n}" rows="1" placeholder="Tipo(Benvenuto, Notte...)"></textarea>
        </div>
        <div class="row nameShortcut">
            <div class="col-2 m-1"><button type="button" id="Benvenuto_fileName${n}" class="btn btn-sm btn-primary">Ben.</button></div>
            <div class="col-2 m-1"><button type="button" id="Notte_fileName${n}"     class="btn btn-sm btn-primary">Not.</button></div>
            <div class="col-2 m-1"><button type="button" id="Attesa_fileName${n}"    class="btn btn-sm btn-primary">Att.</button></div>
            <div class="col-2 m-1"><button type="button" id="Occupato_fileName${n}"  class="btn btn-sm btn-primary">Occ.</button></div>
        </div>
        <div class="row m-1">
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="translateCheck${n}" />
                <label class="form-check-label" for="translateCheck${n}">Aggiungi traduzione</label>
            </div>
        </div>
    </div>
    <div class="col-md-8">
        <div class="row">
            <textarea class="form-control m-1" id="messageText${n}" rows="5"></textarea>
        </div>
    </div>
    <div class="col-md-1 text-center d-flex flex-column align-items-center justify-content-center">
        <button class="btn btn-danger mt-3 mb-3" id="controller${n}" disabled>Play</button>
    </div>
    <div class="row mt-1 rowLine"><hr></div>
    `;
}

/** Aggiunge una nuova riga al form */
document.getElementById('addInput').addEventListener('click', () => {
    const mainForm = document.getElementById('main');
    const newRow   = document.createElement('div');
    newRow.className = 'row';
    newRow.id        = `formRow${inputCounter}`;
    newRow.innerHTML = buildRowHtml(inputCounter); // inputCounter è un intero sicuro
    mainForm.appendChild(newRow);

    // Auto-scroll se la pagina supera l'altezza della finestra
    if (window.innerHeight < document.documentElement.scrollHeight) {
        window.scrollBy(0, document.documentElement.scrollHeight);
    }

    inputCounter++;
});

// ─────────────────────────────────────────────────────────────────────────────
// TRADUZIONE (checkbox)
// ─────────────────────────────────────────────────────────────────────────────

const container = document.getElementById('main');

/**
 * Gestisce il toggle della checkbox "Aggiungi traduzione".
 * Mostra/nasconde la textarea inglese e il pulsante Play ENG.
 * Invalida la cache per la riga modificata.
 */
container.addEventListener('change', (event) => {
    if (!event.target.matches('input[type="checkbox"]') || !event.target.id.startsWith('translateCheck')) return;

    const number = event.target.id.replace('translateCheck', '');

    // Invalida la cache per questa riga: il layout è cambiato
    invalidateCacheEntry(`controller${number}`);

    if (event.target.checked) {
        const existingEl  = document.getElementById(`messageText${number}`);
        const existingRow = document.querySelector(`.col-md-8 .row:has(textarea#messageText${number})`);
        if (!existingEl || !existingRow) return;

        existingEl.setAttribute('rows', '2');

        // Crea la textarea ENG senza innerHTML con contenuto utente
        const newDiv      = document.createElement('div');
        newDiv.className  = 'row';
        const engTextarea = document.createElement('textarea');
        engTextarea.className = 'form-control m-1';
        engTextarea.id        = `ENGmessageText${number}`;
        engTextarea.rows      = 2;
        newDiv.appendChild(engTextarea);
        existingRow.insertAdjacentElement('afterend', newDiv);

        // Crea il pulsante Play ENG
        const newButton   = document.createElement('button');
        newButton.className  = 'btn btn-danger mt-3 mb-3';
        newButton.id         = `ENGcontroller${number}`;
        newButton.disabled   = true;
        newButton.textContent = 'Play';
        const existingButton = document.getElementById(`controller${number}`);
        existingButton.parentNode.insertBefore(newButton, existingButton.nextSibling);

    } else {
        const engController = document.getElementById(`ENGcontroller${number}`);
        if (engController) engController.remove();

        const existingEl = document.getElementById(`messageText${number}`);
        if (existingEl) {
            existingEl.setAttribute('rows', '5');
            const textarea = document.getElementById(`ENGmessageText${number}`);
            if (textarea?.parentElement) textarea.parentElement.remove();
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ELIMINAZIONE RIGA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gestisce il click sul pulsante "X" per eliminare una riga.
 * Invia al server la richiesta di eliminare i file audio già generati.
 * Invalida la voce di cache corrispondente alla riga rimossa.
 */
document.addEventListener('click', async (event) => {
    if (!event.target.matches('[id^="deleteRow"]')) return;
    if (document.querySelectorAll('[id^="formRow"]').length <= 1) return;

    const id         = event.target.id.match(/\d+/)?.[0];
    const row        = document.getElementById(`formRow${id}`);
    const fileName   = document.getElementById(`fileName${id}`)?.value;
    const folderPath = `_temp_${document.getElementById('ragioneSociale_input').value}`;

    if (row) {
        row.remove();
        // Rimuove la voce di cache per questa riga
        invalidateCacheEntry(`controller${id}`);

        if (fileName) {
            const filesToDelete = [`${fileName}.mp3`];
            if (document.getElementById(`ENGmessageText${id}`)) {
                filesToDelete.push(`eng_${fileName}.mp3`);
            }

            try {
                const token = await fetchCsrfToken();
                await fetch('/delete-audio', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                    body:    JSON.stringify({ files: filesToDelete, folder: folderPath, _csrf: token }),
                });
            } catch { /* errore silenzioso: la riga è già rimossa dal DOM */ }
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// SINTESI VOCALE (Genera e ascolta)
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('sendQuery').addEventListener('click', async () => {
    if (!audioPlayer.paused) {
        audioPlayer.pause();
        const ctrl = document.getElementById(lastAudioController);
        if (ctrl) ctrl.textContent = 'Play';
    }

    showLoader();
    document.getElementById('saveAll').disabled = true;
    const controllers = document.querySelectorAll('[id^="ENGcontroller"], [id^="controller"]');
    controllers.forEach(el => { el.disabled = true; });

    // Validazione nome azienda
    const companyName = document.getElementById('ragioneSociale_input').value.trim();
    if (!companyName) {
        showError('Ragione sociale richiesta, compila il campo per procedere.');
        hideLoader();
        return;
    }

    // Raccolta dati dalle righe del form
    const rows = document.querySelectorAll('[id^="formRow"]');
    const data = [];

    try {
        rows.forEach(row => {
            const fileName      = row.querySelector('[id^="fileName"]').value.trim();
            const messageText   = row.querySelector('[id^="messageText"]').value.trim();
            const engTextarea   = row.querySelector('[id^="ENGmessageText"]');
            const playButtonId  = row.querySelector('[id^="controller"]').id;

            if (!fileName || !messageText) {
                throw new Error('validation');
            }
            if (engTextarea && !engTextarea.value.trim()) {
                throw new Error('validation');
            }

            data.push({
                fileName,
                messageText:    escapeXmlPreserveSSML(messageText),
                engMessageText: engTextarea ? escapeXmlPreserveSSML(engTextarea.value.trim()) : null,
                playButtonId,
            });
        });
    } catch {
        showError('Compila tutti i campi per procedere.');
        hideLoader();
        return;
    }

    // ── Filtra i messaggi già in cache (non cambiati dall'ultima sintesi) ─────
    const dataToSynthesize = data.filter(item => !isCached(item));
    const cachedCount      = data.length - dataToSynthesize.length;

    if (cachedCount > 0) {
        console.log(`[Cache] ${cachedCount} messaggio/i invariato/i — chiamata Polly saltata.`);
    }

    // Se tutti i messaggi sono in cache, abilita subito i controller senza
    // chiamare il server e mostra un feedback visivo leggero.
    if (dataToSynthesize.length === 0) {
        console.log('[Cache] Tutti i messaggi sono invariati — nessuna chiamata a Polly.');
        hideLoader();
        controllers.forEach(el => { el.disabled = false; });
        document.getElementById('saveAll').disabled = false;
        return;
    }

    try {
        const token = await fetchCsrfToken();
        const response = await fetch('/api/synthesize', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body:    JSON.stringify({ companyName, data: dataToSynthesize, _csrf: token }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Errore del server.');
        }

        // Aggiorna la cache solo con i messaggi appena sintetizzati con successo
        updateSynthesisCache(dataToSynthesize);

        hideLoader();
        controllers.forEach(el => { el.disabled = false; });
        document.getElementById('saveAll').disabled = false;

    } catch (err) {
        console.error('[sendQuery]', err);
        showError('Si è verificato un errore di rete, controlla la connessione e riprova.');
        hideLoader();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO PLAYER (Play / Pausa)
// ─────────────────────────────────────────────────────────────────────────────

const audioPlayer      = document.getElementById('audioPlayer');
let   lastAudioController = 'controller0';

/**
 * Gestisce il click sui pulsanti Play/Pausa.
 * Recupera l'URL dell'audio dal server e avvia la riproduzione.
 */
container.addEventListener('click', async (e) => {
    if (!e.target.matches('[id^="ENGcontroller"], [id^="controller"]')) return;

    e.preventDefault();
    const folderName     = `_temp_${document.getElementById('ragioneSociale_input').value}`;
    const controllerName = e.target.id;

    if (!audioPlayer.paused && lastAudioController === controllerName) {
        audioPlayer.pause();
        e.target.textContent = 'Play';
        return;
    }

    try {
        const response = await fetch(
            `/play/${encodeURIComponent(folderName)}/${encodeURIComponent(controllerName)}`
        );

        if (!response.ok) {
            showError('Audio non trovato, riprova o ricrealo.');
            return;
        }

        const data = await response.json();

        if (!audioPlayer.paused) audioPlayer.pause();

        const prevCtrl = document.getElementById(lastAudioController);
        if (prevCtrl) prevCtrl.textContent = 'Play';

        // Costruisce l'URL dell'audio sanificando folder e filename
        const audioFileName = encodeURIComponent(data.audioUrl.split('/').pop());
        audioPlayer.src     = `/${encodeURIComponent(folderName)}/${audioFileName}`;
        audioPlayer.load();
        e.target.textContent = 'Pausa';
        audioPlayer.play();
        lastAudioController = controllerName;

    } catch (err) {
        console.error('[audioPlayer]', err);
        showError('Errore di rete, controlla la connessione e riprova.');
    }
});

audioPlayer.addEventListener('ended', () => {
    const ctrl = document.getElementById(lastAudioController);
    if (ctrl) ctrl.textContent = 'Play';
});

// ─────────────────────────────────────────────────────────────────────────────
// DISABILITA CONTROLLER AL CAMBIO TESTO / NOME AZIENDA
// ─────────────────────────────────────────────────────────────────────────────

container.addEventListener('input', e => {
    const match = e.target.id?.match(/\d+/);
    if (!match) return;
    const n = match[0];

    if (e.target.matches('[id^="ENGmessageText"]')) {
        const ctrl = document.getElementById(`ENGcontroller${n}`);
        if (ctrl) ctrl.disabled = true;
    } else if (e.target.matches('[id^="messageText"]')) {
        const ctrl = document.getElementById(`controller${n}`);
        if (ctrl) ctrl.disabled = true;
    }
});

/**
 * Al cambio del nome azienda invalida l'intera cache:
 * i file sul server appartengono alla cartella _temp_<nomeAzienda>
 * e non sono più validi per un nome diverso.
 */
document.getElementById('ragioneSociale_input').addEventListener('input', () => {
    document.querySelectorAll('[id^="controller"], [id^="ENGcontroller"]')
            .forEach(el => { el.disabled = true; });
    synthesisCache.clear();
});

document.getElementById('ragioneSociale_input').addEventListener('keypress', e => {
    if (e.key === 'Enter') e.preventDefault();
});

document.addEventListener('change', () => {
    document.getElementById('saveAll').disabled = true;
});

// ─────────────────────────────────────────────────────────────────────────────
// SALVA COME ZIP
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('saveAll').addEventListener('click', async (e) => {
    e.preventDefault();

    if (!audioPlayer.paused) {
        audioPlayer.pause();
        const ctrl = document.getElementById(lastAudioController);
        if (ctrl) ctrl.textContent = 'Play';
    }

    showLoader();
    const folderName      = document.getElementById('ragioneSociale_input').value.trim();
    const backgroundSong  = document.getElementById('music').value !== 'blank'
        ? document.getElementById('music').value
        : null;

    if (!folderName) {
        showError('Salvataggio non trovato, genera nuovamente i messaggi per proseguire.');
        hideLoader();
        return;
    }

    try {
        const token    = await fetchCsrfToken();
        const response = await fetch('/api/save', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            body:    JSON.stringify({ folderName, backgroundSong, _csrf: token }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || 'Errore nella richiesta.');
        }

        const blob = await response.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${folderName}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setTimeout(() => window.location.reload(true), 2000);
        setTimeout(hideLoader, 2000);

    } catch (err) {
        showError('Errore di rete, controlla la connessione e/o genera nuovamente i messaggi per proseguire.');
        hideLoader();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDAZIONE NOME FILE (no duplicati)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Controlla e risolve i nomi file duplicati nelle textarea fileName.
 * Se un valore esiste già, aggiunge un suffisso numerico progressivo.
 *
 * @param {Event} event - Evento focusout sulla textarea
 */
function checkTextareaValue(event) {
    const currentValue = event.target.value;
    const textareas    = document.querySelectorAll('textarea[id^="fileName"]');
    let duplicateFound = false;
    let suffix         = 1;
    let newValue       = currentValue;

    textareas.forEach(ta => {
        if (ta !== event.target && ta.value === currentValue) duplicateFound = true;
    });

    while (duplicateFound) {
        newValue       = `${currentValue}(${suffix++})`;
        duplicateFound = false;
        textareas.forEach(ta => {
            if (ta !== event.target && ta.value === newValue) duplicateFound = true;
        });
    }

    event.target.value = newValue;
}

container.addEventListener('focusout', (event) => {
    if (!event.target.matches('textarea[id^="fileName"]') || !event.target.value) return;
    // Capitalizza la prima lettera
    event.target.value = event.target.value.charAt(0).toUpperCase() + event.target.value.slice(1);
    checkTextareaValue(event);
});

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGAZIONE CON TAB TRA TEXTAREA
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();

    const textareas = document.querySelectorAll('textarea');
    const index     = Array.from(textareas).indexOf(document.activeElement);
    textareas[(index + 1) % textareas.length].focus();
});

// ─────────────────────────────────────────────────────────────────────────────
// SHORTCUT NOMI FILE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gestisce i pulsanti di scorciatoia (Ben., Not., Att., Occ.)
 * che precompilano la textarea del tipo di messaggio.
 */
document.getElementById('main').addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON' || !e.target.closest('.nameShortcut')) return;

    const buttonId    = e.target.id;
    const fileName    = buttonId.split('_').shift();
    const extractedId = buttonId.split('_').pop();
    const targetEl    = document.getElementById(extractedId);
    // Usa value (non innerHTML) per prevenire injection
    if (targetEl) targetEl.value = fileName;
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRETTORE TESTO AL PASTE
// ─────────────────────────────────────────────────────────────────────────────

const DAYS_MAP = {
    lunedi:    'lunedì',
    martedi:   'martedì',
    mercoledi: 'mercoledì',
    giovedi:   'giovedì',
    venerdi:   'venerdì',
};

/**
 * Corregge e normalizza il testo incollato:
 * - Lowercase
 * - Giorni della settimana con accento
 * - Orari: "13.30" → "13:30"
 * - Rimuove parentesi e contenuto
 * - Normalizza punteggiatura e spazi
 *
 * @param {string} text - Testo grezzo incollato
 * @returns {string} Testo normalizzato
 */
function correctText(text) {
    text = text.toLowerCase();
    text = text.replace(/\b(lunedi|martedi|mercoledi|giovedi|venerdi)\b/g,
        match => DAYS_MAP[match] || match);
    text = text.replace(/(\d{1,2})[.,](\d{2})/g, '$1:$2');
    text = text.replace(/\s*\([^)]+\)/g, ' ');
    text = text.replace(/\n+/g, '. ');
    text = text.replace(/\.{2,}/g, '.');
    text = text.replace(/,{2,}/g, ',');
    text = text.replace(/\s+/g, ' ').trim();
    text = text.replace(/\s*([.,])\s*/g, '$1 ').trim();
    return text;
}

document.getElementById('main').addEventListener('paste', e => {
    if (!e.target.matches('textarea[id^="messageText"]') || e.target.dataset.pasted) return;
    setTimeout(() => {
        if (e.target.value) {
            e.target.value           = correctText(e.target.value);
            e.target.dataset.pasted  = 'true';
        }
    }, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD FILE AUDIO
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('uploadButton').addEventListener('click', () => {
    document.getElementById('audioUpload').click();
});

document.getElementById('audioUpload').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    // Validazione lato client (doppio controllo: il server valida comunque)
    const allowedExts  = ['.mp3', '.wav'];
    const fileExt      = file.name.lastIndexOf('.') !== -1
        ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
        : '';
    const MAX_SIZE_MB  = 10;

    if (!allowedExts.includes(fileExt)) {
        showError('Formato non supportato. Carica un file MP3 o WAV.');
        return;
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        showError(`Il file supera il limite di ${MAX_SIZE_MB} MB.`);
        return;
    }

    const formData = new FormData();
    formData.append('audioFile', file);

    showLoader();

    try {
        const token = await fetchCsrfToken();
        formData.append('_csrf', token);

        const response = await fetch('/upload', {
            method:  'POST',
            headers: { 'X-CSRF-Token': token },
            body:    formData,
        });

        if (!response.ok) throw new Error('Caricamento fallito.');

        loadMusicOptions('/api/canzoni', 'music');
        hideLoader();

        const toastEl = document.getElementById('successToast');
        new bootstrap.Toast(toastEl).show();

    } catch {
        showError("Errore nel caricamento del file, controlla la dimensione (max 10 MB) e/o l'estensione (mp3 o wav).");
        hideLoader();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// COPIA TAG SSML
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('copyButton1').addEventListener('click', () => {
    navigator.clipboard.writeText('[<say-as interpret-as="telephone">XX</say-as>]')
        .then(() => {
            const modalEl = document.getElementById('infoModal');
            bootstrap.Modal.getInstance(modalEl)?.hide();
        })
        .catch(() => {});
});
