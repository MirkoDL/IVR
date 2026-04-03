'use strict';

/**
 * audioNormalizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Modulo per la normalizzazione del volume dei file audio caricati dall'utente.
 *
 * Il flusso di lavoro è:
 *   1. Legge i campioni PCM grezzi del file sorgente tramite ffmpeg
 *   2. Calcola il volume RMS (Root Mean Square) in decibel
 *   3. Calcola il guadagno necessario per raggiungere TARGET_VOLUME_DB
 *   4. Applica il guadagno, converte in mono e riduce a 8000 Hz / 56 kbps
 *      (qualità telefonica standard per IVR)
 *   5. Salva il risultato nella directory songs/ con nome sanitizzato
 *   6. Elimina il file temporaneo di upload
 */

const fs     = require('fs');
const path   = require('path');
const ffmpeg = require('fluent-ffmpeg');

// ─── Costanti ─────────────────────────────────────────────────────────────────

/** Directory dove vengono salvati i file normalizzati */
const OUTPUT_DIR = path.resolve('songs');

/** Volume target in dB per i file di sottofondo IVR */
const TARGET_VOLUME_DB = 50;

/** Lunghezza massima del nome file (senza estensione) */
const MAX_FILENAME_LENGTH = 50;

// ──────────────────────────────────────────────────────────────────────────────
// UTILITY
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Calcola il volume RMS (Root Mean Square) di un segnale audio in decibel.
 * Il valore viene ricavato dai campioni PCM grezzi a 16 bit.
 *
 * Formula: dB = 20 × log₁₀(RMS)
 * Dove RMS = √(Σ(s²) / N)
 *
 * @param {Int16Array} samples - Array di campioni PCM a 16 bit
 * @returns {number} Volume in dB (valore negativo = segnale debole)
 */
function calculateVolumeDB(samples) {
    const sumSquares = samples.reduce((acc, s) => acc + s * s, 0);
    const rms        = Math.sqrt(sumSquares / samples.length);
    return 20 * Math.log10(rms);
}

/**
 * Calcola il guadagno (in dB) necessario per portare il volume corrente
 * al volume target definito da TARGET_VOLUME_DB.
 *
 * @param {number} currentDB - Volume corrente in dB
 * @returns {number} Guadagno da applicare in dB
 */
function calculateGain(currentDB) {
    return TARGET_VOLUME_DB - currentDB;
}

/**
 * Legge i campioni PCM grezzi di un file audio tramite ffmpeg.
 * Il file viene decodificato come PCM signed 16-bit little-endian (s16le).
 *
 * @param {string} filePath - Percorso del file audio sorgente
 * @returns {Promise<Int16Array>} Array di campioni PCM
 */
function readPcmSamples(filePath) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        ffmpeg(filePath)
            .audioCodec('pcm_s16le')
            .format('s16le')
            .on('error', reject)
            .pipe()
            .on('data',  (chunk) => chunks.push(chunk))
            .on('error', reject)
            .on('end', () => {
                const buffer  = Buffer.concat(chunks);
                // Interpreta il buffer come array di interi a 16 bit con segno
                const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
                resolve(samples);
            });
    });
}

/**
 * Genera un percorso di output univoco nella directory songs/.
 * Se esiste già un file con lo stesso nome, aggiunge un suffisso numerico
 * (es. "canzone(1).mp3", "canzone(2).mp3", ...).
 *
 * @param {string} baseName - Nome base del file (senza estensione)
 * @returns {string} Percorso di output univoco
 */
function resolveOutputPath(baseName) {
    // Tronca il nome se supera il limite
    const safeName = baseName.length > MAX_FILENAME_LENGTH
        ? baseName.substring(0, MAX_FILENAME_LENGTH)
        : baseName;

    let outputPath = path.join(OUTPUT_DIR, `${safeName}.mp3`);
    let counter    = 1;

    while (fs.existsSync(outputPath)) {
        outputPath = path.join(OUTPUT_DIR, `${safeName}(${counter}).mp3`);
        counter++;
    }

    return outputPath;
}

// ──────────────────────────────────────────────────────────────────────────────
// FUNZIONE PRINCIPALE
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Normalizza un file MP3/WAV caricato dall'utente e lo salva in songs/.
 *
 * Processo:
 *   1. Legge i campioni PCM grezzi per calcolare il volume attuale
 *   2. Calcola il guadagno correttivo
 *   3. Applica il guadagno + converte in mono + riduce la qualità (IVR)
 *   4. Salva nella directory songs/ con nome univoco
 *   5. Elimina il file originale dall'upload temporaneo
 *
 * Le impostazioni di output (8000 Hz, mono, 56 kbps) sono ottimizzate
 * per sistemi IVR telefonici, dove la banda è limitata.
 *
 * @param {string} filePath - Percorso assoluto del file da processare
 * @returns {Promise<string>} Percorso del file normalizzato salvato
 */
async function processMp3File(filePath) {
    console.log(`[Normalizer] Analisi del file: ${path.basename(filePath)}`);

    // Step 1: leggi i campioni PCM per misurare il volume
    const samples   = await readPcmSamples(filePath);
    const currentDB = calculateVolumeDB(samples);
    const gain      = calculateGain(currentDB);

    console.log(`[Normalizer] Volume rilevato: ${currentDB.toFixed(2)} dB → Guadagno applicato: ${gain.toFixed(2)} dB`);

    // Step 2: determina il percorso di output univoco
    const baseName   = path.basename(filePath, path.extname(filePath));
    const outputPath = resolveOutputPath(baseName);

    // Step 3: applica guadagno, converte in mono e salva come MP3 per IVR
    await new Promise((resolve, reject) => {
        ffmpeg(filePath)
            .audioFilters(`volume=${gain}dB,pan=mono|c0=0.5*c0+0.5*c1`) // gain + downmix stereo→mono
            .audioCodec('libmp3lame')   // encoder MP3
            .audioBitrate('56k')        // bitrate telefonico
            .audioFrequency(8000)       // frequenza di campionamento IVR standard
            .save(outputPath)
            .on('end',   resolve)
            .on('error', reject);
    });

    // Step 4: elimina il file originale dopo la conversione
    await fs.promises.unlink(filePath);

    console.log(`[Normalizer] File salvato: ${outputPath}`);
    return outputPath;
}

// ─── Esportazioni ─────────────────────────────────────────────────────────────
module.exports = { processMp3File };
