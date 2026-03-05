'use strict';

const fs    = require('fs');
const path  = require('path');
const ffmpeg = require('fluent-ffmpeg');

// ─── Costanti ──────────────────────────────────────────────────────────────────
const NORMALIZED_DIR  = path.resolve(__dirname, 'songs');
const TARGET_LUFS     = -16;   // Standard broadcast (EBU R128) invece di un dB arbitrario
const MAX_NAME_LENGTH = 50;
const OUTPUT_BITRATE  = '56k';
const OUTPUT_FREQ     = 8000;

// ─── Helper: ffprobe come Promise ─────────────────────────────────────────────
function ffprobeAsync(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => err ? reject(err) : resolve(data));
    });
}

// ─── Helper: genera un percorso output senza sovrascrivere file esistenti ─────
function resolveOutputPath(baseName) {
    const safe = baseName
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, MAX_NAME_LENGTH);

    let outputPath = path.join(NORMALIZED_DIR, `${safe}.mp3`);
    let counter    = 1;

    while (fs.existsSync(outputPath)) {
        outputPath = path.join(NORMALIZED_DIR, `${safe}(${counter++}).mp3`);
    }

    return outputPath;
}

// ─── Helper: misura il loudness reale con loudnorm (EBU R128) ─────────────────
// ffmpeg's loudnorm in modalità "analysis only" restituisce i metadati
// del file senza riscriverlo — molto più preciso del calcolo RMS manuale.
function measureLoudness(filePath) {
    return new Promise((resolve, reject) => {
        let stderr = '';
        ffmpeg(filePath)
            .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json')
            .format('null')
            .output('/dev/null') // Non scrive nessun file
            .on('stderr', line => { stderr += line; })
            .on('end', () => {
                // Estrai il blocco JSON emesso da loudnorm
                const match = stderr.match(/\{[\s\S]*?\}/);
                if (!match) return reject(new Error('loudnorm non ha restituito dati JSON'));
                try {
                    resolve(JSON.parse(match[0]));
                } catch (e) {
                    reject(new Error('Errore nel parsing dei dati loudnorm: ' + e.message));
                }
            })
            .on('error', reject)
            .run();
    });
}

// ─── Funzione principale ───────────────────────────────────────────────────────
async function processMp3File(filePath) {
    console.log(`[audioNormalizer] Analisi: ${filePath}`);

    // 1. Verifica che il file esista e sia accessibile
    await fs.promises.access(filePath, fs.constants.R_OK);

    // 2. Verifica che sia effettivamente un file audio tramite ffprobe
    const probe = await ffprobeAsync(filePath);
    const hasAudio = probe.streams.some(s => s.codec_type === 'audio');
    if (!hasAudio) throw new Error(`Nessun flusso audio trovato in: ${filePath}`);

    // 3. Misura il loudness reale del file con EBU R128
    let loudnessData;
    try {
        loudnessData = await measureLoudness(filePath);
        console.log(`[audioNormalizer] Loudness misurato: ${loudnessData.input_i} LUFS`);
    } catch (err) {
        // Fallback: se loudnorm fallisce (es. file troppo corto), usa volume=0dB
        console.warn(`[audioNormalizer] Analisi loudness fallita, uso gain neutro. Errore: ${err.message}`);
        loudnessData = null;
    }

    // 4. Costruisci i filtri audio
    const filters = [];

    if (loudnessData) {
        // Normalizzazione lineare precisa a due passaggi (measured → target)
        filters.push(
            `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11` +
            `:measured_I=${loudnessData.input_i}` +
            `:measured_LRA=${loudnessData.input_lra}` +
            `:measured_TP=${loudnessData.input_tp}` +
            `:measured_thresh=${loudnessData.input_thresh}` +
            `:offset=${loudnessData.target_offset}` +
            `:linear=true:print_format=none`
        );
    }

    // Downmix stereo → mono (media pesata L+R)
    filters.push('pan=mono|c0=0.5*c0+0.5*c1');

    // 5. Risolvi il percorso di output
    const baseName     = path.basename(filePath, path.extname(filePath));
    const outputPath   = resolveOutputPath(baseName);

    // 6. Applica i filtri e salva
    console.log(`[audioNormalizer] Salvataggio in: ${outputPath}`);
    await new Promise((resolve, reject) => {
        ffmpeg(filePath)
            .audioFilters(filters)
            .audioCodec('libmp3lame')
            .audioBitrate(OUTPUT_BITRATE)
            .audioFrequency(OUTPUT_FREQ)
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject);
    });

    // 7. Rimuovi il file originale (upload temporaneo)
    await fs.promises.unlink(filePath);
    console.log(`[audioNormalizer] File originale rimosso: ${filePath}`);

    return outputPath;
}

module.exports = { processMp3File };
