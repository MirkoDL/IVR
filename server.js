'use strict';

// ─── Dipendenze core ────────────────────────────────────────────────────────
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { Readable } = require('stream');

// ─── AWS SDK ─────────────────────────────────────────────────────────────────
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

// ─── Utility audio ────────────────────────────────────────────────────────────
const ffmpeg   = require('fluent-ffmpeg');
const ID3      = require('node-id3');
const archiver = require('archiver');

// ─── Upload / middleware ──────────────────────────────────────────────────────
const multer       = require('multer');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

// ─── Moduli interni ───────────────────────────────────────────────────────────
const { getMp3Files }    = require('./songs/songArray.js');
const { processMp3File } = require('./audioNormalizer.js');

// ─── Variabili d'ambiente ─────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, 'env', 'hidden.env') });

// ─── Costanti ─────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const IS_PRODUCTION  = process.env.NODE_ENV === 'production';
const SONGS_DIR      = path.join(__dirname, 'songs');
const PRIVATE_DIR    = path.join(__dirname, '_private');
const RESULTS_DIR    = path.join(__dirname, 'results');
const UPLOAD_DIR     = path.join(__dirname, 'upload');
const MAX_UPLOAD_MB  = 10;
const SILENCE_MIX    = path.join(PRIVATE_DIR, 'mixSilence.mp3');
const SILENCE_START  = path.join(PRIVATE_DIR, 'startSilence.mp3');

// Mappa delle entità HTML da decodificare
const HTML_ENTITIES = {
    '&amp;':  '&',
    '&lt;':   '<',
    '&gt;':   '>',
    '&quot;': '"',
    '&apos;': "'",
};

// ──────────────────────────────────────────────────────────────────────────────
// APP
// ──────────────────────────────────────────────────────────────────────────────

const app = express();

// ─── Middleware di sicurezza ───────────────────────────────────────────────────

/** Blocca l'accesso diretto alla directory .git */
app.use((req, res, next) => {
    if (req.path.startsWith('/.git')) return res.status(403).send('Access Denied');
    next();
});

/** Rimuove l'header X-Powered-By per non rivelare il framework */
app.disable('x-powered-by');

/** Impedisce l'embedding della pagina in iframe */
app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

/** Content Security Policy: permette solo risorse da sé stessi e jsdelivr */
app.use((_req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' https://cdn.jsdelivr.net",
            "style-src 'self' https://cdn.jsdelivr.net",
            "img-src 'self' data:",
            "frame-ancestors 'none'",
            "form-action 'self'",
        ].join('; ')
    );
    next();
});

/**
 * CORS: accetta richieste solo dall'origine di produzione o da localhost in sviluppo.
 * NOTA: impostare correttamente ALLOWED_ORIGIN in .env in produzione.
 */
const ALLOWED_ORIGINS = IS_PRODUCTION
    ? [process.env.ALLOWED_ORIGIN || 'https://ivr.up.railway.app']
    : ['http://127.0.0.1:3000', 'http://localhost:3000'];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ─── Middleware generali ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// ─── CSRF (Double-Submit Cookie pattern) ──────────────────────────────────────
const csrf = doubleCsrf({
    getSecret: () => process.env.CSRF_KEY,
    /**
     * Estrae il token CSRF prima dal body, poi dagli header.
     * Questo supporta sia form HTML che chiamate fetch/AJAX.
     */
    getTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
    cookieName: IS_PRODUCTION ? '__Host-prod.x-csrf-token' : '_csrf',
    cookieOptions: {
        httpOnly: true,
        secure: IS_PRODUCTION,
    },
});

app.use(csrf.doubleCsrfProtection);

/** Rende il token CSRF disponibile come variabile locale in ogni risposta */
app.use((req, res, next) => {
    res.locals.csrfToken = csrf.generateToken(req, res);
    next();
});

// ──────────────────────────────────────────────────────────────────────────────
// UTILITY
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Decodifica le entità HTML più comuni in una stringa.
 * Usato per pulire i testi prima di inviarli ad Amazon Polly.
 *
 * @param {string} text - Testo con eventuali entità HTML
 * @returns {string} Testo con entità decodificate
 */
function decodeHtmlEntities(text) {
    return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (match) => HTML_ENTITIES[match] ?? match);
}

/**
 * Verifica il token CSRF dalla richiesta.
 * Lancia un errore HTTP 403 se il token non è valido.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} true se valido, false se non valido (con risposta già inviata)
 */
function verifyCsrf(req, res) {
    const token = req.body?._csrf;
    if (!token || req.csrfToken() !== token) {
        res.status(403).json({ error: 'Invalid CSRF token' });
        return false;
    }
    return true;
}

/**
 * Ottiene la durata in secondi di un singolo file audio tramite ffprobe.
 *
 * @param {string} filePath - Percorso assoluto del file audio
 * @returns {Promise<number>} Durata in secondi (arrotondata per eccesso + 3s di margine)
 */
async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) return reject(err);
            resolve(Math.ceil(data.format.duration + 3));
        });
    });
}

/**
 * Calcola la durata totale di un array di file audio.
 * Aggiunge 2.5 secondi di pausa stimata tra ogni traccia.
 *
 * @param {string[]} audioPaths - Array di percorsi ai file audio
 * @returns {Promise<number>} Durata totale in secondi
 */
async function getTotalDuration(audioPaths) {
    let total = 0;
    for (const file of audioPaths) {
        total += 2.5; // pausa stimata tra i messaggi
        const meta = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
        });
        total += meta.format.duration;
    }
    return Math.ceil(total + 3);
}

// ──────────────────────────────────────────────────────────────────────────────
// AMAZON POLLY
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Crea un'istanza configurata di PollyClient usando le credenziali dall'env.
 *
 * @returns {PollyClient}
 */
function createPollyClient() {
    return new PollyClient({
        region: 'eu-central-1',
        credentials: {
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
    });
}

/**
 * Sintetizza un testo SSML con Amazon Polly e salva l'audio come MP3.
 * Aggiunge il titolo (playButtonId) nei metadati ID3 del file generato.
 *
 * @param {PollyClient} polly      - Client Polly già istanziato
 * @param {string}      ssmlText   - Testo SSML da sintetizzare
 * @param {string}      langCode   - Codice lingua (es. 'it-IT', 'en-US')
 * @param {string}      outputPath - Percorso di destinazione del file MP3
 * @param {string}      trackId    - ID da salvare nel tag ID3 title
 * @returns {Promise<void>}
 */
async function synthesizeSpeech(polly, ssmlText, langCode, outputPath, trackId) {
    const params = {
        Text:         ssmlText,
        OutputFormat: 'mp3',
        VoiceId:      langCode === 'it-IT' ? 'Bianca' : 'Ruth',
        LanguageCode: langCode,
        TextType:     'ssml',
        Engine:       'neural',
    };

    const { AudioStream } = await polly.send(new SynthesizeSpeechCommand(params));

    if (!(AudioStream instanceof Readable)) {
        throw new Error('AudioStream non è un flusso leggibile.');
    }

    // Scrivi lo stream audio su disco
    await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        AudioStream.pipe(writeStream);
        writeStream.on('error', reject);
        writeStream.on('finish', () => {
            // Aggiunge i metadati ID3 dopo la scrittura
            ID3.write({ title: trackId }, outputPath, (err) => {
                if (err) return reject(err);
                console.log(`[Polly] Salvato: ${path.basename(outputPath)}`);
                resolve();
            });
        });
    });
}

/**
 * Sintetizza tutti i messaggi di un IVR (italiano + inglese se presente).
 *
 * @param {Array<{fileName:string, messageText:string, engMessageText:string|null, playButtonId:string}>} messages
 * @param {PollyClient} polly
 * @param {string}      outputDir - Cartella temporanea dove salvare i file
 * @returns {Promise<void>}
 */
async function synthesizeMessages(messages, polly, outputDir) {
    for (const { fileName, messageText, engMessageText, playButtonId } of messages) {
        const itPath  = path.join(outputDir, `${fileName}.mp3`);
        const engPath = path.join(outputDir, `eng_${fileName}.mp3`);

        await synthesizeSpeech(polly, `<speak>${messageText}</speak>`,    'it-IT', itPath,  playButtonId);

        if (engMessageText !== null) {
            await synthesizeSpeech(polly, `<speak>${engMessageText}</speak>`, 'en-US', engPath, `ENG${playButtonId}`);
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AUDIO PROCESSING (FFMPEG)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Opzioni di output audio standard usate in tutte le conversioni ffmpeg.
 * Mono, 44100 Hz, 192 kbps — qualità ottimale per IVR.
 */
const FFMPEG_AUDIO_OPTIONS = ['-b:a', '192k', '-ar', '44100', '-ac', '1'];

/**
 * Aggiunge un file di silenzio iniziale (startSilence.mp3) prima dell'audio principale.
 * Il file risultante sovrascrive l'originale nella cartella risultati.
 *
 * @param {string} tempDir    - Cartella temporanea (per il file intermedio)
 * @param {string} resultsDir - Cartella risultati (dove si trova il file di input)
 * @param {string} fileName   - Nome del file da processare
 * @returns {Promise<void>}
 */
function addSilenceAtStart(tempDir, resultsDir, fileName) {
    const inputPath  = path.join(resultsDir, fileName);
    const tempOutput = path.join(tempDir, `longer_${fileName}`);
    const finalPath  = path.join(resultsDir, fileName);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(SILENCE_START)
            .input(inputPath)
            .complexFilter(['[0:a][1:a]concat=n=2:v=0:a=1[out]'])
            .outputOptions('-map', '[out]')
            .save(tempOutput)
            .on('end', () => {
                fs.rename(tempOutput, finalPath, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            })
            .on('error', reject);
    });
}

/**
 * Mixa la traccia vocale TTS con una canzone di sottofondo.
 * La canzone viene ripetuta N volte per coprire tutta la durata del TTS.
 * Il volume della voce è amplificato (3.0x) per garantire la comprensibilità.
 *
 * @param {string} fileName            - Nome file di output
 * @param {string} backgroundSongPath  - Percorso della canzone di sfondo
 * @param {string} resultsDir          - Cartella risultati
 * @param {string} tempDir             - Cartella temporanea
 * @param {number} repeatTimes         - Numero di volte che il brano deve essere ripetuto
 * @returns {Promise<void>}
 */
function mergeWithBackgroundSong(fileName, backgroundSongPath, resultsDir, tempDir, repeatTimes) {
    const primaryAudio = path.join(resultsDir, fileName);
    const tempOutput   = path.join(tempDir, `merged_${fileName}`);
    const finalPath    = path.join(resultsDir, fileName);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(backgroundSongPath).inputOption(`-stream_loop ${repeatTimes - 1}`)
            .input(primaryAudio)
            .complexFilter('[0:a]anull[a0];[1:a]volume=3.0[a1];[a0][a1]amix=inputs=2:duration=longest[a]')
            .outputOptions('-map', '[a]')
            .save(tempOutput)
            .on('end', () => {
                fs.rename(tempOutput, finalPath, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            })
            .on('error', reject);
    });
}

/**
 * Taglia il file audio finale alla durata corretta (TTS + 20s di coda).
 * Rimuove eccesso dal brano di sfondo che potrebbe estendersi oltre il messaggio.
 *
 * @param {number} ttsDuration          - Durata totale del TTS in secondi
 * @param {number} bgLength             - Durata del brano di sfondo in secondi
 * @param {number} bgRepeatTimes        - Numero di ripetizioni del brano
 * @param {string} resultsDir           - Cartella risultati
 * @param {string} fileName             - Nome del file da processare
 * @param {string} tempDir              - Cartella temporanea
 * @returns {Promise<string>}           - Percorso del file finale
 */
function saveFinal(ttsDuration, bgLength, bgRepeatTimes, resultsDir, fileName, tempDir) {
    const inputPath  = path.join(resultsDir, fileName);
    const tempOutput = path.join(tempDir, `temp_${fileName}`);
    const finalPath  = path.join(resultsDir, fileName);

    if (!fs.existsSync(inputPath)) {
        return Promise.reject(new Error(`File non trovato: ${inputPath}`));
    }

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(inputPath);

        // Taglia solo se il fondo supera la durata del TTS
        if (bgLength && bgLength * bgRepeatTimes > ttsDuration) {
            cmd.outputOptions('-t', String(ttsDuration + 20));
        }

        cmd
            .mergeToFile(tempOutput, tempDir)
            .on('end', () => {
                fs.renameSync(tempOutput, finalPath);
                resolve(finalPath);
            })
            .on('error', reject);
    });
}

/**
 * Elimina le cartelle temporanea e risultati dopo il completamento del job.
 *
 * @param {string} tempDir    - Percorso cartella temporanea
 * @param {string} resultsDir - Percorso cartella risultati
 * @returns {Promise<void>}
 */
async function cleanupFolders(tempDir, resultsDir) {
    for (const dir of [tempDir, resultsDir]) {
        if (fs.existsSync(dir)) {
            await fs.promises.rm(dir, { recursive: true, force: true });
            console.log(`[Cleanup] Cartella eliminata: ${dir}`);
        }
    }
}

/**
 * Comprime tutti i file nella cartella in un archivio ZIP.
 * Se esiste già un file .zip con lo stesso nome, viene sovrascritto.
 *
 * @param {string} folderPath - Percorso della cartella da comprimere
 * @returns {Promise<string>} - Percorso del file ZIP creato
 */
async function zipFolder(folderPath) {
    const folderName   = path.basename(folderPath);
    const outputZip    = path.join(path.dirname(folderPath), `${folderName}.zip`);

    // Rimuovi ZIP esistente per evitare file corrotti
    if (fs.existsSync(outputZip)) fs.unlinkSync(outputZip);

    return new Promise((resolve, reject) => {
        const output  = fs.createWriteStream(outputZip);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`[ZIP] Creato: ${outputZip} (${archive.pointer()} bytes)`);
            resolve(outputZip);
        });
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

/**
 * Copia un file di canzone dalla directory songs/ alla cartella risultati.
 * Se il file sorgente non esiste, il processo continua senza errori.
 *
 * @param {string} src  - Percorso sorgente
 * @param {string} dest - Percorso destinazione
 * @returns {Promise<void>}
 */
async function copyBackgroundSong(src, dest) {
    try {
        await fs.promises.access(src, fs.constants.F_OK);
        await fs.promises.copyFile(src, dest);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`[Song] File non trovato, copia saltata: ${src}`);
        } else {
            throw err;
        }
    }
}

/**
 * Raggruppa i file nella cartella temporanea in oggetti da processare.
 * Ogni oggetto contiene la traccia italiana e (se presente) quella inglese,
 * oltre al nome del file di sfondo trovato nella cartella risultati.
 *
 * @param {string} tempDir    - Cartella temporanea con i file MP3 sintetizzati
 * @param {string} resultsDir - Cartella risultati (per trovare la canzone di sfondo)
 * @returns {Array<{files: string[], outputName: string, backgroundSong: string|null}>}
 */
function categorizeFiles(tempDir, resultsDir) {
    const files     = fs.readdirSync(tempDir);
    const result    = [];
    const processed = new Set();

    // Prima passata: file italiani (senza prefisso 'eng_')
    for (const file of files) {
        if (file.startsWith('eng_') || processed.has(file)) continue;

        const engFile  = `eng_${file}`;
        const fileObj  = { files: [file], outputName: file, backgroundSong: null };

        if (files.includes(engFile)) fileObj.files.push(engFile);

        const bgFile = fs.readdirSync(resultsDir).find(f => f.endsWith('.mp3'));
        if (bgFile) fileObj.backgroundSong = bgFile;

        result.push(fileObj);
        processed.add(file);
        processed.add(engFile);
    }

    // Seconda passata: file inglesi non ancora abbinati
    for (const file of files) {
        if (!file.startsWith('eng_') || processed.has(file)) continue;

        const originalFile = file.slice(4);
        const existing     = result.find(obj => obj.files.includes(originalFile));

        if (existing) {
            existing.files.push(file);
        } else {
            const bgFile  = fs.readdirSync(resultsDir).find(f => f.endsWith('.mp3'));
            result.push({
                files:           [file],
                outputName:      originalFile,
                backgroundSong:  bgFile || null,
            });
        }
        processed.add(file);
    }

    return result;
}

/**
 * Orchestra il processo completo di mixaggio audio:
 * 1. Converte/merge le tracce TTS in WAV
 * 2. Aggiunge silenzio iniziale
 * 3. Mixa con la canzone di sfondo
 * 4. Taglia il file finale
 * 5. Crea lo ZIP
 * 6. Pulisce le cartelle temporanee
 *
 * @param {Array} inputData     - Array di oggetti categorizzati da categorizeFiles()
 * @param {string} resultsDir   - Cartella risultati
 * @param {string} tempDir      - Cartella temporanea
 * @returns {Promise<void>}
 */
async function mergeAudioFiles(inputData, resultsDir, tempDir) {
    const processFile = async (obj) => {
        if (obj.files.length === 0) return null;

        const outputName       = obj.outputName.replace(/\.(mp3|wav)$/, '') + '.wav';
        const bgPath           = obj.backgroundSong ? path.join(resultsDir, obj.backgroundSong) : null;
        const songPaths        = obj.files.map(f => path.join(tempDir, f));
        const ttsDuration      = await getTotalDuration(songPaths);
        const bgDuration       = bgPath ? await getAudioDuration(bgPath) : 0;
        const bgRepeatTimes    = bgDuration ? Math.ceil(ttsDuration / bgDuration) : 0;

        /**
         * Gestisce un singolo file audio senza background:
         * converte in WAV e aggiunge il silenzio iniziale.
         */
        const handleSingle = () =>
            new Promise((resolve, reject) => {
                ffmpeg(songPaths[0])
                    .outputOptions(...FFMPEG_AUDIO_OPTIONS)
                    .toFormat('wav')
                    .save(path.join(resultsDir, outputName))
                    .on('end', async () => {
                        await addSilenceAtStart(tempDir, resultsDir, outputName);
                        resolve({ ttsDuration, bgDuration, bgRepeatTimes, outputName, bgPath });
                    })
                    .on('error', reject);
            });

        if (songPaths.length === 1 && !bgPath) return handleSingle();

        // Merge di più tracce (IT + ENG) con silenzio tra i file
        return new Promise((resolve, reject) => {
            const cmd = ffmpeg();
            songPaths.forEach(f => cmd.input(f).input(SILENCE_MIX));

            cmd
                .outputOptions(...FFMPEG_AUDIO_OPTIONS)
                .toFormat('wav')
                .mergeToFile(path.join(resultsDir, outputName), tempDir)
                .on('end', async () => {
                    await addSilenceAtStart(tempDir, resultsDir, outputName);
                    if (bgPath) {
                        await mergeWithBackgroundSong(outputName, bgPath, resultsDir, tempDir, bgRepeatTimes);
                    }
                    resolve({ ttsDuration, bgDuration, bgRepeatTimes, outputName, bgPath });
                })
                .on('error', reject);
        });
    };

    // Processa tutti i file in parallelo
    const results = (await Promise.all(inputData.map(processFile))).filter(Boolean);

    // Finalizza ogni file (trim) e poi crea lo ZIP
    await Promise.all(
        results.map(({ ttsDuration, bgDuration, bgRepeatTimes, outputName }) =>
            saveFinal(ttsDuration, bgDuration, bgRepeatTimes, resultsDir, outputName, tempDir)
        )
    );

    await zipFolder(resultsDir);
    await cleanupFolders(tempDir, resultsDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// PULIZIA CARTELLE TEMPORANEE ALL'AVVIO
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Elimina tutte le cartelle _temp_* rimaste da sessioni precedenti.
 * Viene eseguita all'avvio del server per garantire uno stato pulito.
 */
async function cleanupTempFolders() {
    try {
        const entries = await fs.promises.readdir(__dirname);
        const tempDirs = entries.filter(e => e.startsWith('_temp_'));
        await Promise.all(
            tempDirs.map(dir =>
                fs.promises.rm(path.join(__dirname, dir), { recursive: true, force: true })
            )
        );
        if (tempDirs.length > 0) {
            console.log(`[Startup] Rimosse ${tempDirs.length} cartelle temporanee.`);
        }
    } catch (err) {
        console.error('[Startup] Errore pulizia cartelle temporanee:', err);
    }
}

cleanupTempFolders();

// ──────────────────────────────────────────────────────────────────────────────
// UPLOAD / MULTER
// ──────────────────────────────────────────────────────────────────────────────

/** Tipi MIME audio accettati */
const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/mp4']);
/** Estensioni audio accettate */
const ALLOWED_AUDIO_EXT  = new Set(['.mp3', '.wav']);

/**
 * Svuota la directory di upload prima di ogni nuovo caricamento.
 * Previene l'accumulo di file e potenziali conflitti di nomi.
 *
 * @param {string} dir - Percorso della cartella da svuotare
 */
function clearUploadDir(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir)
        .filter(f => fs.statSync(path.join(dir, f)).isFile())
        .forEach(f => fs.unlinkSync(path.join(dir, f)));
}

/**
 * Sanifica il nome file rimuovendo caratteri non sicuri.
 * Usa solo lettere, cifre, punti e trattini.
 *
 * @param {string} fileName
 * @returns {string}
 */
function sanitizeFileName(fileName) {
    return path.basename(fileName).replace(/[^a-zA-Z0-9.-]/g, '_');
}

/** Configurazione di Multer per il caricamento di file audio */
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            clearUploadDir(UPLOAD_DIR);
            if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
            cb(null, UPLOAD_DIR);
        },
        filename: (req, file, cb) => cb(null, sanitizeFileName(file.originalname)),
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_AUDIO_MIME.has(file.mimetype) || !ALLOWED_AUDIO_EXT.has(ext)) {
            return cb(new Error('Formato non supportato. Carica un file MP3 o WAV.'));
        }
        cb(null, true);
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────────────────────────

/** Fornisce il token CSRF al frontend per includerlo nelle richieste POST */
app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
});

/** Pagina principale */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

/** Lista tutti i file MP3 disponibili nella directory songs/ */
app.get('/api/canzoni', async (req, res) => {
    try {
        const files = await getMp3Files(SONGS_DIR);
        res.json(files);
    } catch (err) {
        console.error('[GET /api/canzoni] Errore:', err);
        res.status(500).json({ error: 'Errore nel recupero delle canzoni.' });
    }
});

/**
 * POST /api/synthesize
 * Riceve i dati IVR dal frontend, crea la cartella temporanea,
 * salva la trascrizione e avvia la sintesi vocale con Amazon Polly.
 */
app.post('/api/synthesize', async (req, res) => {
    if (!verifyCsrf(req, res)) return;

    const { companyName, data } = req.body;
    if (!companyName || !Array.isArray(data) || data.length === 0) {
        return res.status(400).json({ error: 'Dati mancanti o non validi.' });
    }

    const folderName = `_temp_${companyName}`;
    const dirPath    = path.normalize(path.join(__dirname, folderName));

    try {
        // Rimuovi ed ricrea la cartella temporanea
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        await fs.promises.mkdir(dirPath, { recursive: true });
        console.log(`[Synthesize] Cartella creata: ${folderName}`);

        // Costruisce e salva il file di trascrizione
        const transcription = data.map(({ fileName, messageText, engMessageText }) => [
            `${fileName}:`,
            `IT -> ${decodeHtmlEntities(messageText)}`,
            engMessageText ? `ENG -> ${decodeHtmlEntities(engMessageText)}` : null,
            '',
        ].filter(Boolean).join('\n')).join('\n');

        await fs.promises.writeFile(path.join(dirPath, 'Trascrizione.txt'), transcription);
        console.log('[Synthesize] Trascrizione.txt salvata.');

        const polly = createPollyClient();
        await synthesizeMessages(data, polly, dirPath);

        res.json({ message: 'Sintesi vocale completata con successo!' });
    } catch (err) {
        console.error('[POST /api/synthesize] Errore:', err);
        res.status(500).json({ error: 'Errore durante la sintesi vocale.' });
    }
});

/**
 * GET /play/:folder/:controllerName
 * Cerca nella cartella temporanea il file audio che corrisponde
 * al controllerName nel tag ID3 title e restituisce il suo URL.
 */
app.get('/play/:folder/:controllerName', async (req, res) => {
    const { folder, controllerName } = req.params;

    // Sicurezza: accetta solo cartelle che iniziano con '_temp_'
    if (!folder.startsWith('_temp_')) {
        return res.status(400).json({ error: 'Cartella non autorizzata.' });
    }

    const folderPath = path.normalize(path.join(__dirname, folder));

    try {
        const files = await fs.promises.readdir(folderPath);
        let audioPath = null;

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const meta     = ID3.read(filePath);
            if (meta?.title?.toLowerCase() === controllerName.toLowerCase()) {
                audioPath = filePath;
                break;
            }
        }

        if (!audioPath) {
            return res.status(404).json({ error: 'File audio non trovato.' });
        }

        res.json({ audioUrl: `/${folder}/${path.basename(audioPath)}` });
    } catch (err) {
        console.error('[GET /play] Errore:', err);
        res.status(500).json({ error: 'Errore nella ricerca del file audio.' });
    }
});

/**
 * GET /:folder/:filename
 * Endpoint generico per servire file audio dalle cartelle del progetto.
 * NOTA: in produzione considera di limitare le cartelle accessibili.
 */
app.get('/:folder/:filename', (req, res) => {
    const { folder, filename } = req.params;
    const filePath = path.normalize(path.join(__dirname, folder, filename));
    res.sendFile(filePath);
});

/**
 * POST /delete-audio
 * Elimina uno o più file audio dalla cartella temporanea.
 * Richiede token CSRF valido.
 */
app.post('/delete-audio', async (req, res) => {
    if (!verifyCsrf(req, res)) return;

    const { files, folder } = req.body;

    if (!files?.length || files[0] === '.mp3' || !folder) {
        return res.status(400).json({ error: 'Parametri mancanti o non validi.' });
    }

    const deleted = [];
    const failed  = [];

    await Promise.allSettled(
        files.map(async (fileName) => {
            const filePath = path.join(__dirname, folder, fileName);
            try {
                await fs.promises.unlink(filePath);
                deleted.push(fileName);
                console.log(`[Delete] Eliminato: ${fileName}`);
            } catch {
                failed.push(fileName);
            }
        })
    );

    const status = failed.length > 0 ? 500 : 200;
    res.status(status).json({
        message:      failed.length > 0 ? 'Alcuni file non sono stati eliminati.' : 'Eliminazione completata.',
        deletedFiles: deleted,
        failedFiles:  failed,
    });
});

/**
 * POST /upload
 * Carica un file audio, lo normalizza tramite audioNormalizer,
 * e lo salva nella directory songs/ pronto per essere usato come sottofondo.
 */
app.post(
    '/upload',
    upload.single('audioFile'),
    async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'Nessun file caricato.' });

        console.log(`[Upload] Ricevuto: ${req.file.originalname}`);

        try {
            const outputPath = await processMp3File(req.file.path);
            console.log(`[Upload] Processato: ${outputPath}`);
            res.json({ message: `File "${req.file.originalname}" caricato con successo!`, outputPath });
        } catch (err) {
            console.error('[POST /upload] Errore:', err);
            res.status(500).json({ error: 'Errore durante il processamento del file.' });
        }
    },
    // Gestione errori Multer (dimensione, formato, ecc.)
    (err, req, res, _next) => {
        const message = err instanceof multer.MulterError
            ? err.message
            : 'Errore sconosciuto durante il caricamento.';
        res.status(500).json({ error: message });
    }
);

/**
 * POST /api/save
 * Avvia il pipeline completo di mixaggio:
 * 1. Verifica l'esistenza della cartella temporanea
 * 2. Crea la cartella risultati
 * 3. Copia la canzone di sfondo (se selezionata)
 * 4. Mixaggio audio → ZIP
 * 5. Scarica il file ZIP al client
 */
app.post('/api/save', async (req, res) => {
    if (!verifyCsrf(req, res)) return;

    const { folderName, backgroundSong } = req.body;

    if (!folderName) {
        return res.status(400).json({ error: 'folderName è obbligatorio.' });
    }

    const tempDir    = path.join(__dirname, `_temp_${folderName}`);
    const resultsDir = path.join(RESULTS_DIR, folderName);

    try {
        // Verifica che la cartella temporanea esista
        await fs.promises.access(tempDir, fs.constants.F_OK);

        // Ricrea la cartella risultati da zero
        await fs.promises.rm(resultsDir, { recursive: true, force: true });
        await fs.promises.mkdir(resultsDir, { recursive: true });

        // Sposta la trascrizione nella cartella risultati
        await fs.promises.rename(
            path.join(tempDir, 'Trascrizione.txt'),
            path.join(resultsDir, 'Trascrizione.txt')
        );

        // Copia la canzone di sfondo se selezionata
        if (backgroundSong) {
            await copyBackgroundSong(
                path.join(SONGS_DIR, backgroundSong),
                path.join(resultsDir, backgroundSong)
            );
        }

        // Avvia il processo di mixaggio
        const inputData = categorizeFiles(tempDir, resultsDir);
        await mergeAudioFiles(inputData, resultsDir, tempDir);

        // Verifica l'esistenza dello ZIP generato
        const zipPath = path.normalize(path.join(RESULTS_DIR, `${folderName}.zip`));
        if (!fs.existsSync(zipPath)) {
            return res.status(404).json({ error: 'File ZIP non trovato dopo il processo.' });
        }

        // Invia il file ZIP al client
        res.setHeader('Content-Type', 'application/zip');
        res.download(zipPath, `${folderName}.zip`, (err) => {
            if (err) console.error('[Save] Errore invio ZIP:', err);
        });
    } catch (err) {
        console.error('[POST /api/save] Errore:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// AVVIO SERVER
// ──────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[Server] In esecuzione su http://localhost:${PORT}`);
    console.log(`[Server] Ambiente: ${IS_PRODUCTION ? 'production' : 'development'}`);
});
