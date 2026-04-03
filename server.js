'use strict';

// ─── Dipendenze core ──────────────────────────────────────────────────────────
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { Readable } = require('stream');

// ─── AWS SDK ──────────────────────────────────────────────────────────────────
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');

// ─── Utility audio ────────────────────────────────────────────────────────────
const ffmpeg   = require('fluent-ffmpeg');
const ID3      = require('node-id3');
const archiver = require('archiver');

// ─── Upload / middleware ──────────────────────────────────────────────────────
const multer       = require('multer');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

// ─── Sicurezza aggiuntiva ─────────────────────────────────────────────────────
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');

// ─── Variabili d'ambiente ─────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, 'env', 'hidden.env') });

// ─── Moduli interni ───────────────────────────────────────────────────────────
const { getMp3Files }    = require('./songs/songArray.js');
const { processMp3File } = require('./audioNormalizer.js');

// ─────────────────────────────────────────────────────────────────────────────
// COSTANTI
// ─────────────────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT || 3000;
const IS_PRODUCTION  = process.env.NODE_ENV === 'production';
const SONGS_DIR      = path.join(__dirname, 'songs');
const PRIVATE_DIR    = path.join(__dirname, '_private');
const RESULTS_DIR    = path.join(__dirname, 'results');
const UPLOAD_DIR     = path.join(__dirname, 'upload');
const MAX_UPLOAD_MB  = 10;
const SILENCE_MIX    = path.join(PRIVATE_DIR, 'mixSilence.mp3');
const SILENCE_START  = path.join(PRIVATE_DIR, 'startSilence.mp3');

/** Lunghezza massima ammessa per il nome azienda/cartella */
const MAX_COMPANY_NAME_LEN = 80;

/** Caratteri ammessi nel nome azienda (alfanumerico + spazio trattino underscore punto) */
const COMPANY_NAME_REGEX = /^[a-zA-Z0-9 \-_.àáèéìíòóùúÀÁÈÉÌÍÒÓÙÚ]+$/;

/** Mappa delle entità HTML da decodificare */
const HTML_ENTITIES = {
    '&amp;':  '&',
    '&lt;':   '<',
    '&gt;':   '>',
    '&quot;': '"',
    '&apos;': "'",
};

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// ─── Trust proxy: necessario su Render (e ambienti con reverse proxy) ─────────
/**
 * Imposta il numero di hop del proxy da cui ci si fida.
 * Su Render il traffico passa attraverso un singolo reverse proxy,
 * quindi il valore 1 è sufficiente e sicuro: Express leggerà l'IP reale
 * dall'ultimo elemento di X-Forwarded-For, prevenendo IP spoofing.
 * Senza questa impostazione express-rate-limit lancia
 * ERR_ERL_UNEXPECTED_X_FORWARDED_FOR e non funziona correttamente.
 */
app.set('trust proxy', 1);

// ─── Helmet: imposta sicuri la maggior parte degli header HTTP ────────────────
/**
 * Helmet configura automaticamente header di sicurezza come:
 * - Strict-Transport-Security (HSTS)
 * - X-Content-Type-Options: nosniff
 * - X-DNS-Prefetch-Control
 * - Referrer-Policy
 * - Permissions-Policy
 * La CSP viene configurata manualmente sotto per maggiore controllo.
 */
app.use(helmet({
    contentSecurityPolicy: false, // gestita manualmente
}));

// ─── Rimuove l'header X-Powered-By ───────────────────────────────────────────
app.disable('x-powered-by');

// ─── Blocca accesso diretto a .git ───────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path.startsWith('/.git')) return res.status(403).send('Access Denied');
    next();
});

// ─── X-Frame-Options ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// ─── Content Security Policy ─────────────────────────────────────────────────
/**
 * CSP restrittiva:
 * - Solo risorse da 'self' e jsdelivr.net
 * - Vieta inline script (sicurezza XSS)
 * - 'unsafe-inline' in style-src è necessario perché Bootstrap 5 JS inietta
 *   stili inline dinamici sul <body> quando apre modal/offcanvas
 *   (es. overflow:hidden; padding-right:Xpx dove X dipende dalla scrollbar
 *   del browser e non è predicibile a compile-time). Non è possibile usare
 *   hash statici né nonce per questi stili generati a runtime da Bootstrap.
 * - Vieta frame e form verso origini esterne
 */
app.use((_req, res, next) => {
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' https://cdn.jsdelivr.net",
            "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
            "img-src 'self' data:",
            "media-src 'self'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "base-uri 'self'",
            "object-src 'none'",
        ].join('; ')
    );
    next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
/**
 * Accetta richieste solo dall'origine configurata.
 * In sviluppo: localhost. In produzione: valore da .env (ALLOWED_ORIGIN).
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ─── Rate Limiter globale ─────────────────────────────────────────────────────
/**
 * Limita le richieste per IP a 100 ogni 15 minuti.
 * Protegge contro brute force e flooding.
 */
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppe richieste, riprova tra qualche minuto.' },
});
app.use(globalLimiter);

// ─── Rate Limiter per la sintesi vocale (endpoint costoso) ───────────────────
/**
 * La sintesi Polly è costosa (tempo + costo AWS).
 * Limitata a 5 chiamate ogni 10 minuti per IP.
 */
const synthesisLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Limite di sintesi raggiunto. Riprova tra 10 minuti.' },
});

// ─── Middleware generali ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: IS_PRODUCTION ? '1d' : 0,
    etag: true,
}));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' })); // ridotto da 10mb: i payload IVR sono piccoli

// ─── CSRF (Double-Submit Cookie pattern) ─────────────────────────────────────
const csrf = doubleCsrf({
    getSecret: () => process.env.CSRF_KEY,
    /**
     * Il token viene letto prima dal body (form HTML),
     * poi dall'header X-CSRF-Token (fetch/AJAX).
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

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decodifica le entità HTML più comuni in una stringa.
 * Usato per pulire i testi prima di inviarli ad Amazon Polly.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
    return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (match) => HTML_ENTITIES[match] ?? match);
}

/**
 * Sanifica e valida il nome azienda/cartella.
 * - Rimuove sequenze di path traversal (../ o ../)
 * - Rifiuta nomi troppo lunghi
 * - Accetta solo caratteri alfanumerici, spazio, trattino, underscore, punto e lettere accentate italiane
 *
 * @param {string} name
 * @returns {{ valid: boolean, sanitized: string }}
 */
function validateCompanyName(name) {
    if (typeof name !== 'string') return { valid: false, sanitized: '' };
    const sanitized = name.trim().replace(/\.{2,}/g, '').replace(/[\/\\]/g, '');
    if (!sanitized || sanitized.length > MAX_COMPANY_NAME_LEN) return { valid: false, sanitized };
    if (!COMPANY_NAME_REGEX.test(sanitized)) return { valid: false, sanitized };
    return { valid: true, sanitized };
}

/**
 * Verifica che un percorso di file sia contenuto all'interno di una
 * directory base (prevenzione path traversal).
 *
 * @param {string} base    - Directory base (assoluta)
 * @param {string} target  - Percorso da verificare (assoluto)
 * @returns {boolean}
 */
function isPathSafe(base, target) {
    const resolved = path.resolve(target);
    return resolved.startsWith(path.resolve(base) + path.sep) ||
           resolved === path.resolve(base);
}

/**
 * Ottiene la durata in secondi di un file audio tramite ffprobe.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
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
 * Le probe vengono eseguite in parallelo con Promise.all per ridurre
 * il tempo complessivo proporzionalmente al numero di file.
 *
 * @param {string[]} audioPaths
 * @returns {Promise<number>}
 */
async function getTotalDuration(audioPaths) {
    const durations = await Promise.all(
        audioPaths.map(
            filePath => new Promise((resolve, reject) => {
                ffmpeg.ffprobe(filePath, (err, data) => (err ? reject(err) : resolve(data.format.duration)));
            })
        )
    );
    const total = durations.reduce((sum, dur) => sum + dur + 2.5, 0);
    return Math.ceil(total + 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// AMAZON POLLY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea un'istanza configurata di PollyClient.
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
 *
 * @param {PollyClient} polly
 * @param {string}      ssmlText
 * @param {string}      langCode
 * @param {string}      outputPath
 * @param {string}      trackId
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

    await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(outputPath);
        AudioStream.pipe(writeStream);
        writeStream.on('error', reject);
        writeStream.on('finish', () => {
            ID3.write({ title: trackId }, outputPath, (err) => {
                if (err) return reject(err);
                console.log(`[Polly] Salvato: ${path.basename(outputPath)}`);
                resolve();
            });
        });
    });
}

/**
 * Sintetizza tutti i messaggi di un IVR in parallelo.
 *
 * I messaggi diversi vengono processati contemporaneamente con Promise.all,
 * riducendo il tempo totale da O(n) a O(1) rispetto al numero di messaggi.
 * Per ciascun messaggio, IT ed ENG rimangono sequenziali (IT prima, poi ENG)
 * poiché i file potrebbero avere lo stesso nome base e scrivere in parallelo
 * sullo stesso path causerebbe race conditions.
 *
 * @param {Array} messages
 * @param {PollyClient} polly
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function synthesizeMessages(messages, polly, outputDir) {
    await Promise.all(
        messages.map(async ({ fileName, messageText, engMessageText, playButtonId }) => {
            const itPath  = path.join(outputDir, `${fileName}.mp3`);
            const engPath = path.join(outputDir, `eng_${fileName}.mp3`);

            await synthesizeSpeech(polly, `<speak>${messageText}</speak>`, 'it-IT', itPath, playButtonId);

            if (engMessageText !== null) {
                await synthesizeSpeech(polly, `<speak>${engMessageText}</speak>`, 'en-US', engPath, `ENG${playButtonId}`);
            }
        })
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO PROCESSING (FFMPEG)
// ─────────────────────────────────────────────────────────────────────────────

/** Opzioni di output audio standard per tutte le conversioni */
const FFMPEG_AUDIO_OPTIONS = ['-b:a', '192k', '-ar', '44100', '-ac', '1'];

/**
 * Aggiunge un file di silenzio iniziale prima dell'audio principale.
 *
 * @param {string} tempDir
 * @param {string} resultsDir
 * @param {string} fileName
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
 * Il volume della voce è amplificato (3.0x) per garantire la comprensibilità.
 *
 * @param {string} fileName
 * @param {string} backgroundSongPath
 * @param {string} resultsDir
 * @param {string} tempDir
 * @param {number} repeatTimes
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
 * Taglia il file audio finale alla durata corretta.
 *
 * @param {number} ttsDuration
 * @param {number} bgLength
 * @param {number} bgRepeatTimes
 * @param {string} resultsDir
 * @param {string} fileName
 * @param {string} tempDir
 * @returns {Promise<string>}
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
 * Elimina le cartelle temporanea e risultati.
 *
 * @param {string} tempDir
 * @param {string} resultsDir
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
 *
 * @param {string} folderPath
 * @returns {Promise<string>}
 */
async function zipFolder(folderPath) {
    const folderName = path.basename(folderPath);
    const outputZip  = path.join(path.dirname(folderPath), `${folderName}.zip`);

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
 * Copia una canzone dalla directory songs/ alla cartella risultati.
 *
 * @param {string} src
 * @param {string} dest
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
 * La lista dei file di resultsDir viene letta una sola volta e riutilizzata
 * per tutte le iterazioni, evitando chiamate readdirSync ripetute nel loop.
 *
 * @param {string} tempDir
 * @param {string} resultsDir
 * @returns {Array}
 */
function categorizeFiles(tempDir, resultsDir) {
    const files          = fs.readdirSync(tempDir);
    const resultsDirFiles = fs.readdirSync(resultsDir); // letto una sola volta
    const bgFile         = resultsDirFiles.find(f => f.endsWith('.mp3')) || null;
    const result         = [];
    const processed      = new Set();

    for (const file of files) {
        if (file.startsWith('eng_') || processed.has(file)) continue;

        const engFile = `eng_${file}`;
        const fileObj = { files: [file], outputName: file, backgroundSong: bgFile };

        if (files.includes(engFile)) fileObj.files.push(engFile);

        result.push(fileObj);
        processed.add(file);
        processed.add(engFile);
    }

    for (const file of files) {
        if (!file.startsWith('eng_') || processed.has(file)) continue;

        const originalFile = file.slice(4);
        const existing     = result.find(obj => obj.files.includes(originalFile));

        if (existing) {
            existing.files.push(file);
        } else {
            result.push({ files: [file], outputName: originalFile, backgroundSong: bgFile });
        }
        processed.add(file);
    }

    return result;
}

/**
 * Orchestra il processo completo di mixaggio audio.
 *
 * @param {Array}  inputData
 * @param {string} resultsDir
 * @param {string} tempDir
 * @returns {Promise<void>}
 */
async function mergeAudioFiles(inputData, resultsDir, tempDir) {
    const processFile = async (obj) => {
        if (obj.files.length === 0) return null;

        const outputName    = obj.outputName.replace(/\.(mp3|wav)$/, '') + '.wav';
        const bgPath        = obj.backgroundSong ? path.join(resultsDir, obj.backgroundSong) : null;
        const songPaths     = obj.files.map(f => path.join(tempDir, f));
        const ttsDuration   = await getTotalDuration(songPaths);
        const bgDuration    = bgPath ? await getAudioDuration(bgPath) : 0;
        const bgRepeatTimes = bgDuration ? Math.ceil(ttsDuration / bgDuration) : 0;

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

    const results = (await Promise.all(inputData.map(processFile))).filter(Boolean);

    await Promise.all(
        results.map(({ ttsDuration, bgDuration, bgRepeatTimes, outputName }) =>
            saveFinal(ttsDuration, bgDuration, bgRepeatTimes, resultsDir, outputName, tempDir)
        )
    );

    await zipFolder(resultsDir);
    await cleanupFolders(tempDir, resultsDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// PULIZIA CARTELLE TEMPORANEE ALL'AVVIO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Elimina tutte le cartelle _temp_* rimaste da sessioni precedenti.
 */
async function cleanupTempFolders() {
    try {
        const entries  = await fs.promises.readdir(__dirname);
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

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD / MULTER
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/mp4']);
const ALLOWED_AUDIO_EXT  = new Set(['.mp3', '.wav']);

/**
 * Svuota la directory di upload prima di ogni nuovo caricamento.
 * Usa l'API async di fs per non bloccare l'event loop.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function clearUploadDir(dir) {
    try {
        const files = await fs.promises.readdir(dir);
        await Promise.all(
            files
                .filter(async f => (await fs.promises.stat(path.join(dir, f))).isFile())
                .map(f => fs.promises.unlink(path.join(dir, f)))
        );
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
}

/**
 * Sanifica il nome file rimuovendo caratteri non sicuri.
 *
 * @param {string} fileName
 * @returns {string}
 */
function sanitizeFileName(fileName) {
    return path.basename(fileName).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

/** Configurazione di Multer per il caricamento di file audio */
const upload = multer({
    storage: multer.diskStorage({
        destination: async (req, file, cb) => {
            try {
                await clearUploadDir(UPLOAD_DIR);
                if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
                cb(null, UPLOAD_DIR);
            } catch (err) {
                cb(err);
            }
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

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/** Fornisce il token CSRF al frontend */
app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
});

/** Pagina principale */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

/** Lista tutti i file MP3 disponibili */
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
 * Riceve i dati IVR, crea la cartella temporanea e avvia la sintesi Polly.
 * Rate limited a 5 richieste / 10 min per IP.
 */
app.post('/api/synthesize', synthesisLimiter, async (req, res) => {
    const { companyName, data } = req.body;

    // Validazione e sanificazione del nome azienda
    const nameCheck = validateCompanyName(companyName);
    if (!nameCheck.valid) {
        return res.status(400).json({ error: 'Nome azienda non valido. Usa solo lettere, numeri, spazi e trattini.' });
    }
    const safeName = nameCheck.sanitized;

    if (!Array.isArray(data) || data.length === 0) {
        return res.status(400).json({ error: 'Array dati vuoto o non valido.' });
    }

    // Limita il numero massimo di messaggi per prevenire abusi
    if (data.length > 30) {
        return res.status(400).json({ error: 'Troppi messaggi (massimo 30).' });
    }

    // Costruisce il percorso e verifica che sia dentro __dirname (path traversal guard)
    const folderName = `_temp_${safeName}`;
    const dirPath    = path.join(__dirname, folderName);

    if (!isPathSafe(__dirname, dirPath)) {
        return res.status(400).json({ error: 'Percorso non autorizzato.' });
    }

    try {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        await fs.promises.mkdir(dirPath, { recursive: true });
        console.log(`[Synthesize] Cartella creata: ${folderName}`);

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
 * Cerca nella cartella temporanea il file audio che corrisponde al controllerName.
 * Protetto da path traversal check su entrambi i parametri.
 */
app.get('/play/:folder/:controllerName', async (req, res) => {
    const { folder, controllerName } = req.params;

    // Sicurezza: accetta solo cartelle che iniziano con '_temp_'
    if (!folder.startsWith('_temp_')) {
        return res.status(400).json({ error: 'Cartella non autorizzata.' });
    }

    // Previeni path traversal nei parametri
    const safeFolder         = path.basename(folder);
    const safeControllerName = path.basename(controllerName);

    const folderPath = path.join(__dirname, safeFolder);

    // Verifica che la cartella sia dentro __dirname
    if (!isPathSafe(__dirname, folderPath)) {
        return res.status(400).json({ error: 'Percorso non autorizzato.' });
    }

    try {
        const files = await fs.promises.readdir(folderPath);
        let audioPath = null;

        for (const file of files) {
            const filePath = path.join(folderPath, file);

            // Verifica che ogni file sia dentro la cartella
            if (!isPathSafe(folderPath, filePath)) continue;

            const meta = ID3.read(filePath);
            if (meta?.title?.toLowerCase() === safeControllerName.toLowerCase()) {
                audioPath = filePath;
                break;
            }
        }

        if (!audioPath) {
            return res.status(404).json({ error: 'File audio non trovato.' });
        }

        res.json({ audioUrl: `/${safeFolder}/${path.basename(audioPath)}` });
    } catch (err) {
        console.error('[GET /play] Errore:', err);
        res.status(500).json({ error: 'Errore nella ricerca del file audio.' });
    }
});

/**
 * GET /:folder/:filename
 * Serve file audio dalle cartelle del progetto.
 * Path traversal guard: il file deve essere dentro __dirname.
 */
app.get('/:folder/:filename', (req, res) => {
    const safeFolder   = path.basename(req.params.folder);
    const safeFilename = path.basename(req.params.filename);
    const filePath     = path.join(__dirname, safeFolder, safeFilename);

    if (!isPathSafe(__dirname, filePath)) {
        return res.status(403).send('Access Denied');
    }

    res.sendFile(filePath);
});

/**
 * POST /delete-audio
 * Elimina file audio dalla cartella temporanea.
 * Path traversal guard su ogni nome file.
 */
app.post('/delete-audio', async (req, res) => {
    const { files, folder } = req.body;

    if (!files?.length || files[0] === '.mp3' || !folder) {
        return res.status(400).json({ error: 'Parametri mancanti o non validi.' });
    }

    // Sanifica il nome della cartella
    const safeFolder = path.basename(folder);
    if (!safeFolder.startsWith('_temp_')) {
        return res.status(400).json({ error: 'Cartella non autorizzata.' });
    }

    const baseDir = path.join(__dirname, safeFolder);

    if (!isPathSafe(__dirname, baseDir)) {
        return res.status(400).json({ error: 'Percorso non autorizzato.' });
    }

    const deleted = [];
    const failed  = [];

    await Promise.allSettled(
        files.map(async (fileName) => {
            // Sanifica ogni nome file individuale
            const safeFile = path.basename(String(fileName));
            const filePath = path.join(baseDir, safeFile);

            // Verifica path traversal per ogni file
            if (!isPathSafe(baseDir, filePath)) {
                failed.push(fileName);
                return;
            }

            try {
                await fs.promises.unlink(filePath);
                deleted.push(safeFile);
                console.log(`[Delete] Eliminato: ${safeFile}`);
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
 * Carica un file audio, lo normalizza e lo salva in songs/.
 */
app.post(
    '/upload',
    upload.single('audioFile'),
    async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'Nessun file caricato.' });

        // Verifica path traversal sul file salvato da multer
        if (!isPathSafe(UPLOAD_DIR, req.file.path)) {
            return res.status(400).json({ error: 'Percorso file non autorizzato.' });
        }

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
    (err, req, res, _next) => {
        const message = err instanceof multer.MulterError
            ? err.message
            : 'Errore sconosciuto durante il caricamento.';
        res.status(500).json({ error: message });
    }
);

/**
 * POST /api/save
 * Avvia il pipeline completo di mixaggio e invia il file ZIP al client.
 */
app.post('/api/save', async (req, res) => {
    const { folderName, backgroundSong } = req.body;

    // Validazione e sanificazione del nome cartella
    const nameCheck = validateCompanyName(folderName);
    if (!nameCheck.valid) {
        return res.status(400).json({ error: 'Nome cartella non valido.' });
    }
    const safeName = nameCheck.sanitized;

    // Validazione canzone di sfondo (solo nome file, nessun path traversal)
    if (backgroundSong) {
        const safeSong = path.basename(String(backgroundSong));
        if (safeSong !== backgroundSong || !safeSong.endsWith('.mp3')) {
            return res.status(400).json({ error: 'Nome canzone non valido.' });
        }
    }

    const tempDir    = path.join(__dirname, `_temp_${safeName}`);
    const resultsDir = path.join(RESULTS_DIR, safeName);

    // Path traversal guard su entrambe le cartelle
    if (!isPathSafe(__dirname, tempDir) || !isPathSafe(RESULTS_DIR, resultsDir)) {
        return res.status(400).json({ error: 'Percorso non autorizzato.' });
    }

    try {
        await fs.promises.access(tempDir, fs.constants.F_OK);

        await fs.promises.rm(resultsDir, { recursive: true, force: true });
        await fs.promises.mkdir(resultsDir, { recursive: true });

        await fs.promises.rename(
            path.join(tempDir, 'Trascrizione.txt'),
            path.join(resultsDir, 'Trascrizione.txt')
        );

        if (backgroundSong) {
            const safeSong = path.basename(backgroundSong);
            await copyBackgroundSong(
                path.join(SONGS_DIR, safeSong),
                path.join(resultsDir, safeSong)
            );
        }

        const inputData = categorizeFiles(tempDir, resultsDir);
        await mergeAudioFiles(inputData, resultsDir, tempDir);

        const zipPath = path.join(RESULTS_DIR, `${safeName}.zip`);
        if (!fs.existsSync(zipPath)) {
            return res.status(404).json({ error: 'File ZIP non trovato dopo il processo.' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.download(zipPath, `${safeName}.zip`, (err) => {
            if (err) console.error('[Save] Errore invio ZIP:', err);
        });
    } catch (err) {
        console.error('[POST /api/save] Errore:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Gestore errori globale ───────────────────────────────────────────────────
/**
 * Intercetta tutti gli errori non gestiti dalle route.
 * In produzione non rivela dettagli dell'errore al client.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
    console.error('[Error]', err);
    const message = IS_PRODUCTION ? 'Si è verificato un errore interno.' : err.message;
    res.status(err.status || 500).json({ error: message });
});

// ─────────────────────────────────────────────────────────────────────────────
// AVVIO SERVER
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[Server] In esecuzione su http://localhost:${PORT}`);
    console.log(`[Server] Ambiente: ${IS_PRODUCTION ? 'production' : 'development'}`);
});
