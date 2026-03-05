'use strict';

// ─── Dipendenze ────────────────────────────────────────────────────────────────
const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const { Readable } = require('stream');

const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const ID3          = require('node-id3');
const ffmpeg       = require('fluent-ffmpeg');
const archiver     = require('archiver');
const multer       = require('multer');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const he           = require('he'); // Sostituisce decodeHtmlEntities
const { doubleCsrf } = require('csrf-csrf');

const { getMp3Files }    = require('./songs/songArray.js');
const { processMp3File } = require('./audioNormalizer.js');

require('dotenv').config({ path: path.join(__dirname, 'env', 'hidden.env') });

const app  = express();
const PORT = process.env.PORT;

// ─── Costanti ─────────────────────────────────────────────────────────────────
const RESULTS_DIR  = path.resolve(__dirname, 'results');
const SONGS_DIR    = path.resolve(__dirname, 'songs');
const PRIVATE_DIR  = path.resolve(__dirname, '_private');
const UPLOAD_DIR   = path.resolve(__dirname, 'upload');
const ALLOWED_ORIGIN = process.env.NODE_ENV === 'production'
    ? 'https://ivr.up.railway.app'
    : 'http://127.0.0.1:3000';

// ─── Sicurezza: Helmet (CSP + tutti gli altri header) ─────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc:  ["'self'"],
            scriptSrc:   ["'self'", 'https://cdn.jsdelivr.net'],
            styleSrc:    ["'self'", 'https://cdn.jsdelivr.net'],
            imgSrc:      ["'self'", 'data:'],
            frameAncestors: ["'none'"],
            formAction:  ["'self'"],
        },
    },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
}));

// ─── Body parsing & cookie ────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// ─── Blocca accesso a .git ────────────────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path.startsWith('/.git')) return res.status(403).send('Access Denied');
    next();
});

// ─── File statici ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── CSRF ─────────────────────────────────────────────────────────────────────
const { doubleCsrfProtection, generateToken } = doubleCsrf({
    getSecret: () => process.env.CSRF_KEY,
    getTokenFromRequest: req => req.body?._csrf || req.headers['x-csrf-token'],
    cookieName: process.env.NODE_ENV === 'production' ? '__Host-prod.x-csrf-token' : '_csrf',
    cookieOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    },
});

app.use(doubleCsrfProtection);

app.use((req, res, next) => {
    res.locals.csrfToken = generateToken(req, res);
    next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Troppe richieste, riprova tra poco.' },
});

const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    message: { error: 'Limite upload raggiunto.' },
});

// ─── Helper: validazione nome cartella ────────────────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeName(name, label = 'name') {
    if (!name || !SAFE_NAME_RE.test(name)) {
        const err = new Error(`${label} non valido`);
        err.status = 400;
        throw err;
    }
}

// ─── Helper: verifica che il percorso resti dentro una base dir ───────────────
function safeJoin(base, ...parts) {
    const resolved = path.resolve(base, ...parts);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        const err = new Error('Path traversal rilevato');
        err.status = 403;
        throw err;
    }
    return resolved;
}

// ─── Route: pagina principale ─────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// ─── Route: CSRF token ────────────────────────────────────────────────────────
app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
});

// ─── Route: lista canzoni ─────────────────────────────────────────────────────
app.get('/api/canzoni', async (req, res, next) => {
    try {
        const mp3Files = await getMp3Files(SONGS_DIR);
        res.json(mp3Files);
    } catch (err) {
        next(err);
    }
});

// ─── Route: sintesi vocale ────────────────────────────────────────────────────
app.post('/api/synthesize', apiLimiter, async (req, res, next) => {
    const dataArray = req.body;

    try {
        assertSafeName(dataArray.companyName, 'companyName');

        const folderName = `_temp_${dataArray.companyName}`;
        const dirPath    = path.resolve(__dirname, folderName);

        // Rimuove ed ricrea la cartella temporanea
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        await fs.promises.mkdir(dirPath, { recursive: true });

        // Trascrizione testuale
        const lines = dataArray.data.map(item => {
            let line = `${item.fileName}:\n`;
            line += `IT -> ${he.decode(item.messageText)}\n`;
            if (item.engMessageText) line += `ENG -> ${he.decode(item.engMessageText)}\n`;
            return line;
        });
        await fs.promises.writeFile(path.join(dirPath, 'Trascrizione.txt'), lines.join('\n'));

        const polly = new PollyClient({
            region: 'eu-central-1',
            credentials: {
                accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });

        await synthesizeMessages(dataArray.data, polly, dirPath);
        res.json({ message: 'Audio generato con successo!' });
    } catch (err) {
        next(err);
    }
});

// ─── Route: salvataggio e download ZIP ───────────────────────────────────────
app.post('/api/save', apiLimiter, async (req, res, next) => {
    const { folderName, backgroundSong } = req.body;

    try {
        assertSafeName(folderName, 'folderName');

        const tempFolderPath    = path.resolve(__dirname, `_temp_${folderName}`);
        const resultsFolderPath = safeJoin(RESULTS_DIR, folderName);

        // Verifica che la cartella temporanea esista
        await fs.promises.access(tempFolderPath, fs.constants.F_OK);

        await fs.promises.rm(resultsFolderPath, { recursive: true, force: true });
        await fs.promises.mkdir(resultsFolderPath, { recursive: true });

        await fs.promises.rename(
            path.join(tempFolderPath, 'Trascrizione.txt'),
            path.join(resultsFolderPath, 'Trascrizione.txt')
        );

        if (backgroundSong) {
            assertSafeName(path.basename(backgroundSong, '.mp3'), 'backgroundSong');
            const src  = safeJoin(SONGS_DIR, backgroundSong);
            const dest = path.join(resultsFolderPath, path.basename(backgroundSong));
            await copyBackgroundSong(src, dest);
        }

        const inputData = categorizeFiles(tempFolderPath, resultsFolderPath);
        await mergeAudioFiles(inputData, resultsFolderPath, tempFolderPath);

        const zipFilePath = path.resolve(__dirname, 'results', `${folderName}.zip`);
        if (!fs.existsSync(zipFilePath)) {
            return res.status(404).json({ error: 'ZIP non trovato' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.download(zipFilePath, `${folderName}.zip`, err => {
            if (err) next(err);
        });
    } catch (err) {
        next(err);
    }
});

// ─── Route: riproduzione audio temporaneo ────────────────────────────────────
app.get('/play/:folder/:controllerName', async (req, res, next) => {
    try {
        const { folder, controllerName } = req.params;

        if (!folder.startsWith('_temp_') || !SAFE_NAME_RE.test(folder.slice(6))) {
            return res.status(400).send('Forbidden');
        }

        const songsDir = path.resolve(__dirname, folder);
        const files    = await fs.promises.readdir(songsDir);
        let   songPath = null;

        for (const file of files) {
            const filePath = path.join(songsDir, file);
            try {
                const meta = ID3.read(filePath);
                if (meta?.title?.toLowerCase() === controllerName.toLowerCase()) {
                    songPath = filePath;
                    break;
                }
            } catch { /* file senza tag ID3, skip */ }
        }

        if (!songPath) return res.status(404).send('Canzone non trovata.');
        res.json({ audioUrl: `/songs/${folder}/${path.basename(songPath)}` });
    } catch (err) {
        next(err);
    }
});

// ─── Route: serve file audio (solo da results/ o songs/) ─────────────────────
app.get('/audio/:folder/:filename', (req, res, next) => {
    try {
        const { folder, filename } = req.params;
        assertSafeName(folder,   'folder');
        assertSafeName(path.basename(filename, path.extname(filename)), 'filename');

        const allowedBases = [RESULTS_DIR, SONGS_DIR];
        let   filePath     = null;

        for (const base of allowedBases) {
            const candidate = path.resolve(base, folder, filename);
            if (candidate.startsWith(base + path.sep)) {
                filePath = candidate;
                break;
            }
        }

        if (!filePath) return res.status(403).send('Forbidden');
        res.sendFile(filePath);
    } catch (err) {
        next(err);
    }
});

// ─── Route: elimina audio ─────────────────────────────────────────────────────
app.post('/delete-audio', (req, res, next) => {
    try {
        const { files, folder } = req.body;

        if (!files?.length || files[0] === '.mp3' || !folder) {
            return res.status(400).send('Dati mancanti.');
        }

        assertSafeName(folder, 'folder');

        const deletedFiles = [];
        const failedFiles  = [];
        let   pending      = files.length;

        files.forEach(fileName => {
            // Ogni fileName deve essere sicuro
            if (!SAFE_NAME_RE.test(path.basename(fileName, '.mp3'))) {
                failedFiles.push(fileName);
                if (--pending === 0) sendResult();
                return;
            }

            const filePath = safeJoin(path.resolve(__dirname, folder), fileName);
            fs.unlink(filePath, err => {
                if (err) failedFiles.push(fileName);
                else     deletedFiles.push(fileName);
                if (--pending === 0) sendResult();
            });
        });

        function sendResult() {
            if (failedFiles.length) {
                return res.status(500).json({ message: 'Alcuni file non eliminati.', deletedFiles, failedFiles });
            }
            res.status(200).json({ message: 'Eliminazione completata.', deletedFiles });
        }
    } catch (err) {
        next(err);
    }
});

// ─── Route: upload e normalizzazione audio ────────────────────────────────────
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
            // Svuota la cartella prima di ogni upload
            const existing = await fs.promises.readdir(UPLOAD_DIR);
            await Promise.all(existing.map(f => fs.promises.unlink(path.join(UPLOAD_DIR, f))));
            cb(null, UPLOAD_DIR);
        } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
        const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safe);
    },
});

const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/mp4']);
const ALLOWED_EXTENSIONS  = new Set(['.mp3', '.wav']);

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_AUDIO_TYPES.has(file.mimetype)) {
            return cb(new Error('Tipo MIME non supportato.'));
        }
        if (!ALLOWED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
            return cb(new Error('Estensione non supportata.'));
        }
        cb(null, true);
    },
});

app.post('/upload', uploadLimiter, upload.single('audioFile'), async (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato.' });
    try {
        const outputFilePath = await processMp3File(req.file.path);
        res.json({ message: `${req.file.originalname} elaborato con successo!`, outputFilePath });
    } catch (err) {
        next(err);
    }
});

// ─── Error handler centralizzato ──────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status  = err.status || 500;
    const message = status < 500 ? err.message : 'Errore interno del server';
    if (status >= 500) console.error('[ERROR]', err);
    res.status(status).json({ error: message });
});

// ─── Pulizia cartelle temporanee all'avvio ────────────────────────────────────
(async () => {
    const entries = await fs.promises.readdir(__dirname);
    const temps   = entries.filter(e => e.startsWith('_temp_'));
    await Promise.all(temps.map(t =>
        fs.promises.rm(path.join(__dirname, t), { recursive: true, force: true })
    ));
    console.log('Cartelle temporanee ripulite.');
})();

// ─── Avvio server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`Server attivo su http://localhost:${PORT}`);
});


// ════════════════════════════════════════════════════════════════════════════════
// FUNZIONI DI BUSINESS LOGIC (invariate nella logica, migliorate nello stile)
// ════════════════════════════════════════════════════════════════════════════════

async function synthesizeMessages(messages, polly, dirPath) {
    for (const item of messages) {
        const { fileName, messageText, engMessageText, playButtonId } = item;
        await synthesizeSpeech(polly, `<speak>${messageText}</speak>`, 'it-IT',
            path.join(dirPath, `${fileName}.mp3`), playButtonId);
        if (engMessageText) {
            await synthesizeSpeech(polly, `<speak>${engMessageText}</speak>`, 'en-US',
                path.join(dirPath, `eng_${fileName}.mp3`), `ENG${playButtonId}`);
        }
    }
}

async function synthesizeSpeech(polly, text, languageCode, outputPath, playButtonId) {
    const params = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: languageCode === 'it-IT' ? 'Bianca' : 'Ruth',
        LanguageCode: languageCode,
        TextType: 'ssml',
        Engine: 'neural',
    };

    const { AudioStream } = await polly.send(new SynthesizeSpeechCommand(params));

    if (!(AudioStream instanceof Readable)) throw new Error('AudioStream non è un flusso');

    return new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(outputPath);
        AudioStream.pipe(ws);
        ws.on('finish', () => {
            ID3.write({ title: playButtonId }, outputPath, err =>
                err ? reject(err) : resolve()
            );
        });
        ws.on('error', reject);
    });
}

async function copyBackgroundSong(src, dest) {
    try {
        await fs.promises.access(src, fs.constants.F_OK);
        await fs.promises.copyFile(src, dest);
    } catch (err) {
        if (err.code === 'ENOENT') console.warn(`Background non trovato: ${src}`);
        else throw err;
    }
}

function categorizeFiles(tempFolderPath, resultsFolderPath) {
    const files      = fs.readdirSync(tempFolderPath);
    const bgFile     = fs.readdirSync(resultsFolderPath).find(f => f.endsWith('.mp3')) || null;
    const result     = [];
    const checked    = new Set();

    for (const file of files) {
        if (file.startsWith('eng_') || checked.has(file) || !file.endsWith('.mp3')) continue;
        const related = `eng_${file}`;
        result.push({
            files: files.includes(related) ? [file, related] : [file],
            outputName: file,
            backgroundSong: bgFile,
        });
        checked.add(file);
        checked.add(related);
    }
    return result;
}

async function mergeAudioFiles(inputData, resultsFolderPath, tempFolderPath) {
    // Elaborazione sequenziale per non saturare la CPU
    for (const obj of inputData) {
        await processSingleMerge(obj, resultsFolderPath, tempFolderPath);
    }
    const zipPath = await zipFolder(resultsFolderPath);
    await cleanupFolders(tempFolderPath, resultsFolderPath);
    return zipPath;
}

async function processSingleMerge(obj, resultsFolderPath, tempFolderPath) {
    const silencePath     = path.join(PRIVATE_DIR, 'mixSilence.mp3');
    const outputName      = obj.outputName.replace(/\.(mp3|wav)$/, '') + '.wav';
    const bgPath          = obj.backgroundSong ? path.join(resultsFolderPath, obj.backgroundSong) : null;
    const songPaths       = obj.files.map(s => path.join(tempFolderPath, s));
    const TTSduration     = await getTotalDuration(songPaths);
    const bgDuration      = bgPath ? await getDuration(bgPath) : 0;
    const bgRepeat        = bgDuration ? Math.ceil(TTSduration / bgDuration) : 0;

    if (songPaths.length === 1 && !bgPath) {
        await convertToWav(songPaths[0], path.join(resultsFolderPath, outputName));
    } else {
        const cmd = ffmpeg();
        songPaths.forEach(f => { cmd.input(f); cmd.input(silencePath); });
        await new Promise((resolve, reject) => {
            cmd
                .outputOptions('-b:a', '192k', '-ar', '44100', '-ac', '1')
                .toFormat('wav')
                .mergeToFile(path.join(resultsFolderPath, outputName), tempFolderPath)
                .on('end', resolve)
                .on('error', reject);
        });
    }

    await addSilenceAtStart(tempFolderPath, resultsFolderPath, outputName);
    if (bgPath) await mergeWithBackgroundSong(outputName, bgPath, resultsFolderPath, tempFolderPath, bgRepeat);
    await saveFinal(TTSduration, bgDuration, bgRepeat, resultsFolderPath, outputName, tempFolderPath);
}

function convertToWav(input, output) {
    return new Promise((resolve, reject) => {
        ffmpeg(input)
            .outputOptions('-b:a', '192k', '-ar', '44100', '-ac', '1')
            .toFormat('wav')
            .save(output)
            .on('end', resolve)
            .on('error', reject);
    });
}

async function saveFinal(TTSduration, bgDuration, bgRepeat, resultsFolderPath, outputName, tempFolderPath) {
    const inputPath  = path.join(resultsFolderPath, outputName);
    const tempOutput = path.join(tempFolderPath, `temp_${outputName}`);

    if (!fs.existsSync(inputPath)) throw new Error(`File non trovato: ${inputPath}`);

    const cmd = ffmpeg(inputPath);
    if (bgDuration && bgDuration * bgRepeat > TTSduration) cmd.outputOptions('-t', TTSduration + 20);

    await new Promise((resolve, reject) => {
        cmd.mergeToFile(tempOutput, tempFolderPath).on('end', resolve).on('error', reject);
    });

    fs.renameSync(tempOutput, inputPath);
}

async function cleanupFolders(...folders) {
    for (const folder of folders) {
        if (fs.existsSync(folder)) {
            await fs.promises.rm(folder, { recursive: true, force: true });
        }
    }
}

async function zipFolder(folderPath) {
    const zipPath = path.join(path.dirname(folderPath), `${path.basename(folderPath)}.zip`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    return new Promise((resolve, reject) => {
        const output  = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve(zipPath));
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

function addSilenceAtStart(tempDir, resultsDir, outputName) {
    const tempOut = path.join(tempDir, `longer_${outputName}`);
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(path.join(PRIVATE_DIR, 'startSilence.mp3'))
            .input(path.join(resultsDir, outputName))
            .complexFilter(['[0:a][1:a]concat=n=2:v=0:a=1[out]'])
            .outputOptions('-map', '[out]')
            .save(tempOut)
            .on('end', () => fs.rename(tempOut, path.join(resultsDir, outputName), err => err ? reject(err) : resolve()))
            .on('error', reject);
    });
}

function mergeWithBackgroundSong(outputName, bgPath, resultsDir, tempDir, bgRepeat) {
    const primaryPath = path.join(resultsDir, outputName);
    const tempOut     = path.join(tempDir, `merged_${outputName}`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(bgPath).inputOption(`-stream_loop ${bgRepeat - 1}`)
            .input(primaryPath)
            .complexFilter('[0:a]anull[a0];[1:a]volume=3.0[a1];[a0][a1]amix=inputs=2:duration=longest[a]')
            .outputOptions('-map', '[a]')
            .save(tempOut)
            .on('end', () => fs.rename(tempOut, path.join(resultsDir, outputName), err => err ? reject(err) : resolve()))
            .on('error', reject);
    });
}

async function getTotalDuration(files) {
    let total = 0;
    for (const file of files) {
        total += 2.5;
        const meta = await ffprobeAsync(file);
        total += meta.format.duration;
    }
    return Math.ceil(total + 3);
}

async function getDuration(file) {
    const meta = await ffprobeAsync(file);
    return Math.ceil(meta.format.duration + 3);
}

function ffprobeAsync(file) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(data));
    });
}
