'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const ID3 = require('node-id3');
const multer = require('multer');
const archiver = require('archiver');
const ffmpeg = require('fluent-ffmpeg');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const { getMp3Files } = require('./songs/songArray.js');
const { processMp3File } = require('./audioNormalizer.js');

require('dotenv').config({ path: path.join(__dirname, 'env', 'hidden.env') });

// ─────────────────────────────────────────────
// Constants & Config
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SONGS_DIR = path.join(__dirname, 'songs');
const RESULTS_DIR = path.join(__dirname, 'results');
const PRIVATE_DIR = path.join(__dirname, '_private');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_AUDIO_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/mp4']);
const ALLOWED_AUDIO_EXT = new Set(['.mp3', '.wav']);

// ─────────────────────────────────────────────
// App Setup
// ─────────────────────────────────────────────
const app = express();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────
// Security Headers
// ─────────────────────────────────────────────
app.use((req, res, next) => {
    if (req.path.startsWith('/.git')) return res.status(403).send('Access Denied');
    next();
});

app.use((req, res, next) => {
    const origin = IS_PROD ? 'https://ivr.up.railway.app' : 'http://127.0.0.1:3000';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; frame-ancestors 'none'; form-action 'self';"
    );
    next();
});

// ─────────────────────────────────────────────
// CSRF Protection
// ─────────────────────────────────────────────
const csrf = doubleCsrf({
    getSecret: () => process.env.CSRF_KEY,
    getTokenFromRequest: req => req.body?._csrf || req.headers['x-csrf-token'],
    cookieName: IS_PROD ? '__Host-prod.x-csrf-token' : '_csrf',
    cookieOptions: {
        httpOnly: true,
        secure: IS_PROD
    }
});

app.use(csrf.doubleCsrfProtection);
app.use((req, res, next) => {
    res.locals.csrfToken = csrf.generateToken(req, res);
    next();
});

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

/** Decode common HTML entities from a string. */
function decodeHtmlEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

/** Sanitize a file name to contain only safe characters. */
function sanitizeFileName(fileName) {
    return path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Return true if the mimetype is an allowed audio type. */
function isAudioFile(file) {
    return ALLOWED_AUDIO_MIME.has(file.mimetype);
}

/** Clear all files inside a directory without removing the directory itself. */
function clearDir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    for (const file of fs.readdirSync(dirPath)) {
        const fp = path.join(dirPath, file);
        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
    }
}

/** Delete a directory and all its contents. */
async function removeDir(dirPath) {
    if (fs.existsSync(dirPath)) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
}

/** Cleanup all _temp_* folders at startup and on demand. */
function cleanupTempFolders() {
    fs.readdir(__dirname, (err, files) => {
        if (err) return console.error('[cleanup] Error reading root dir:', err);
        const temps = files.filter(f => f.startsWith('_temp_'));
        Promise.all(temps.map(f => removeDir(path.join(__dirname, f))))
            .then(() => console.log('[cleanup] Temporary folders cleaned.'))
            .catch(e => console.error('[cleanup] Error:', e));
    });
}

/** Get duration (in seconds) of a single audio file via ffprobe. */
function getDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) return reject(err);
            resolve(Math.ceil(data.format.duration + 3));
        });
    });
}

/** Get total duration of an array of audio files plus inter-clip silence gaps. */
async function getTotalDuration(filePaths) {
    let total = 0;
    for (const fp of filePaths) {
        total += 2.5; // inter-clip silence
        const dur = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(fp, (err, data) => {
                if (err) return reject(err);
                resolve(data.format.duration);
            });
        });
        total += dur;
    }
    return Math.ceil(total + 3);
}

// ─────────────────────────────────────────────
// Routes: CSRF & Static
// ─────────────────────────────────────────────

app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// ─────────────────────────────────────────────
// Route: GET /api/canzoni
// ─────────────────────────────────────────────
app.get('/api/canzoni', async (req, res) => {
    try {
        const mp3Files = await getMp3Files(SONGS_DIR);
        res.json(mp3Files);
    } catch (error) {
        console.error('[/api/canzoni] Error:', error);
        res.status(500).json({ error: 'Errore nel recupero delle canzoni' });
    }
});

// ─────────────────────────────────────────────
// AWS Polly – Speech Synthesis
// ─────────────────────────────────────────────

function createPollyClient() {
    return new PollyClient({
        region: 'eu-central-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });
}

/**
 * Synthesize speech with Amazon Polly and write the MP3 to disk.
 * Adds the playButtonId as ID3 title tag for later lookup.
 */
async function synthesizeSpeech(polly, text, languageCode, outputPath, playButtonId) {
    const params = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: languageCode === 'it-IT' ? 'Bianca' : 'Ruth',
        LanguageCode: languageCode,
        TextType: 'ssml',
        Engine: 'neural'
    };

    const data = await polly.send(new SynthesizeSpeechCommand(params));

    if (!(data.AudioStream instanceof Readable)) {
        throw new Error('AudioStream is not a Readable stream');
    }

    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(outputPath);
        data.AudioStream.pipe(ws);
        ws.on('finish', () => {
            ID3.write({ title: playButtonId }, outputPath, err => {
                if (err) return reject(err);
                resolve();
            });
        });
        ws.on('error', reject);
    });

    console.log(`[polly] Saved: ${outputPath}`);
}

/** Synthesize all messages in the data array (IT + optional EN). */
async function synthesizeMessages(messages, polly, dirPath) {
    for (const { fileName, messageText, engMessageText, playButtonId } of messages) {
        await synthesizeSpeech(
            polly,
            `<speak>${messageText}</speak>`,
            'it-IT',
            path.join(dirPath, `${fileName}.mp3`),
            playButtonId
        );

        if (engMessageText !== null) {
            await synthesizeSpeech(
                polly,
                `<speak>${engMessageText}</speak>`,
                'en-US',
                path.join(dirPath, `eng_${fileName}.mp3`),
                `ENG${playButtonId}`
            );
        }
    }
}

// ─────────────────────────────────────────────
// Route: POST /api/synthesize
// ─────────────────────────────────────────────
app.post('/api/synthesize', async (req, res) => {
    const dataArray = req.body;
    const rawName = dataArray.companyName;

    if (!rawName || typeof rawName !== 'string') {
        return res.status(400).json({ error: 'companyName is required' });
    }

    const safeName = sanitizeFileName(rawName);
    const dirPath = path.join(__dirname, `_temp_${safeName}`);

    try {
        await removeDir(dirPath);
        await fs.promises.mkdir(dirPath, { recursive: true });

        // Write transcription file
        const lines = dataArray.data.map(item => {
            let entry = `${item.fileName}:\nIT -> ${decodeHtmlEntities(item.messageText)}\n`;
            if (item.engMessageText) entry += `ENG -> ${decodeHtmlEntities(item.engMessageText)}\n`;
            return entry;
        });
        await fs.promises.writeFile(path.join(dirPath, 'Trascrizione.txt'), lines.join('\n'));

        const polly = createPollyClient();
        await synthesizeMessages(dataArray.data, polly, dirPath);

        res.json({ message: 'Audio generato con successo!' });
    } catch (error) {
        console.error('[/api/synthesize] Error:', error);
        res.status(500).json({ message: 'Errore durante la sintesi vocale' });
    }
});

// ─────────────────────────────────────────────
// Route: GET /play/:folder/:controllerName
// ─────────────────────────────────────────────
app.get('/play/:folder/:controllerName', async (req, res) => {
    const { folder, controllerName } = req.params;

    if (!folder.startsWith('_temp_')) {
        return res.status(400).json({ error: 'Invalid folder' });
    }

    const songsDir = path.normalize(path.join(__dirname, folder));

    try {
        const files = await fs.promises.readdir(songsDir);
        let songPath = null;

        for (const file of files) {
            const fp = path.join(songsDir, file);
            try {
                const meta = ID3.read(fp);
                if (meta?.title?.toLowerCase() === controllerName.toLowerCase()) {
                    songPath = fp;
                    break;
                }
            } catch {/* skip unreadable files */}
        }

        if (!songPath) return res.status(404).json({ error: 'Audio not found' });

        res.json({ audioUrl: `/${folder}/${path.basename(songPath)}` });
    } catch (error) {
        console.error('[/play] Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────────
// Route: GET /:folder/:filename  (audio file serving)
// ─────────────────────────────────────────────
app.get('/:folder/:filename', (req, res) => {
    const { folder, filename } = req.params;
    const safePath = path.normalize(path.join(__dirname, folder, filename));
    // Prevent path traversal
    if (!safePath.startsWith(__dirname)) return res.status(403).send('Forbidden');
    res.sendFile(safePath);
});

// ─────────────────────────────────────────────
// Route: POST /delete-audio
// ─────────────────────────────────────────────
app.post('/delete-audio', async (req, res) => {
    const { files, folder } = req.body;

    if (!files?.length || files[0] === '.mp3' || !folder) {
        return res.status(400).json({ error: 'Missing files or folder' });
    }

    const deleted = [];
    const failed = [];

    await Promise.all(
        files.map(async fileName => {
            const fp = path.join(__dirname, folder, fileName);
            try {
                await fs.promises.unlink(fp);
                deleted.push(fileName);
            } catch {
                failed.push(fileName);
            }
        })
    );

    if (failed.length > 0) {
        return res.status(500).json({ message: 'Some files could not be deleted', deleted, failed });
    }
    res.json({ message: 'Files deleted successfully', deleted });
});

// ─────────────────────────────────────────────
// Audio Processing – Merge / Save Pipeline
// ─────────────────────────────────────────────

/** Copy a file only if it exists; silently skip if missing. */
async function copyIfExists(src, dest) {
    try {
        await fs.promises.access(src, fs.constants.F_OK);
        await fs.promises.copyFile(src, dest);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        console.warn(`[copyIfExists] File not found, skipping: ${src}`);
    }
}

/**
 * Group temp files into objects: { files[], outputName, backgroundSong }.
 * Italian + optional English versions are paired under the same output.
 */
function categorizeFiles(tempFolderPath, resultsFolderPath) {
    const files = fs.readdirSync(tempFolderPath).filter(f => f.endsWith('.mp3'));
    const result = [];
    const handled = new Set();
    const bgFile = fs.readdirSync(resultsFolderPath).find(f => f.endsWith('.mp3')) || null;

    for (const file of files) {
        if (file.startsWith('eng_') || handled.has(file)) continue;
        const eng = `eng_${file}`;
        const entry = {
            files: files.includes(eng) ? [file, eng] : [file],
            outputName: file,
            backgroundSong: bgFile
        };
        result.push(entry);
        handled.add(file);
        handled.add(eng);
    }

    // Orphan eng_ files (no matching IT version)
    for (const file of files) {
        if (file.startsWith('eng_') && !handled.has(file)) {
            result.push({ files: [file], outputName: file.slice(4), backgroundSong: bgFile });
            handled.add(file);
        }
    }

    return result;
}

/** Prepend a short silence to the beginning of an audio file. */
function addSilenceAtStart(tempDir, resultsDir, outputName) {
    const silenceFile = path.join(PRIVATE_DIR, 'startSilence.mp3');
    const primary = path.join(resultsDir, outputName);
    const temp = path.join(tempDir, `longer_${outputName}`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(silenceFile)
            .input(primary)
            .complexFilter(['[0:a][1:a]concat=n=2:v=0:a=1[out]'])
            .outputOptions('-map', '[out]')
            .save(temp)
            .on('end', () => {
                fs.rename(temp, primary, err => {
                    if (err) return reject(err);
                    resolve();
                });
            })
            .on('error', reject);
    });
}

/** Mix primary voice audio with a looping background music track. */
function mergeWithBackgroundSong(outputName, bgPath, resultsDir, tempDir, repeatTimes) {
    const primary = path.join(resultsDir, outputName);
    const temp = path.join(tempDir, `merged_${outputName}`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(bgPath).inputOption(`-stream_loop ${repeatTimes - 1}`)
            .input(primary)
            .complexFilter('[0:a]anull[a0];[1:a]volume=3.0[a1];[a0][a1]amix=inputs=2:duration=longest[a]')
            .outputOptions('-map', '[a]')
            .save(temp)
            .on('end', () => {
                fs.rename(temp, primary, err => {
                    if (err) return reject(err);
                    resolve();
                });
            })
            .on('error', reject);
    });
}

/** Trim the final file so it matches the TTS duration + small buffer. */
function saveFinal(TTSduration, bgLength, bgRepeat, resultsDir, outputName, tempDir) {
    const input = path.join(resultsDir, outputName);
    const temp = path.join(tempDir, `temp_${outputName}`);

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(input);
        if (bgLength && bgLength * bgRepeat > TTSduration) {
            cmd.outputOptions('-t', TTSduration + 20);
        }
        cmd.mergeToFile(temp, tempDir)
            .on('end', () => {
                fs.renameSync(temp, path.join(resultsDir, outputName));
                resolve(path.join(resultsDir, outputName));
            })
            .on('error', reject);
    });
}

/** Merge all audio files for one entry, apply silence and optional BG music. */
async function mergeEntry(obj, resultsDir, tempDir) {
    const silencePath = path.join(PRIVATE_DIR, 'mixSilence.mp3');
    const outputName = obj.outputName.replace(/\.(mp3|wav)$/i, '') + '.wav';
    const bgPath = obj.backgroundSong ? path.join(resultsDir, obj.backgroundSong) : null;
    const songPaths = obj.files.map(f => path.join(tempDir, f));

    if (songPaths.length === 0) return null;

    const TTSduration = await getTotalDuration(songPaths);
    const bgLength = bgPath ? await getDuration(bgPath) : 0;
    const bgRepeat = bgLength ? Math.ceil(TTSduration / bgLength) : 0;

    const outPath = path.join(resultsDir, outputName);

    if (songPaths.length === 1 && !bgPath) {
        // Single track, no background – just convert to WAV
        await new Promise((resolve, reject) => {
            ffmpeg(songPaths[0])
                .outputOptions('-b:a', '192k', '-ar', '44100', '-ac', '1')
                .toFormat('wav')
                .save(outPath)
                .on('end', resolve)
                .on('error', reject);
        });
    } else {
        const cmd = ffmpeg();
        for (const fp of songPaths) {
            cmd.input(fp).input(silencePath);
        }
        await new Promise((resolve, reject) => {
            cmd
                .outputOptions('-b:a', '192k', '-ar', '44100', '-ac', '1')
                .toFormat('wav')
                .mergeToFile(outPath, tempDir)
                .on('end', resolve)
                .on('error', reject);
        });
    }

    await addSilenceAtStart(tempDir, resultsDir, outputName);

    if (bgPath) {
        await mergeWithBackgroundSong(outputName, bgPath, resultsDir, tempDir, bgRepeat);
    }

    return { TTSduration, bgLength, bgRepeat, outputName, bgPath };
}

/** Run the full merge pipeline for all entries, then zip results. */
async function mergeAudioFiles(inputData, resultsDir, tempDir) {
    const results = await Promise.all(inputData.map(obj => mergeEntry(obj, resultsDir, tempDir)));
    const valid = results.filter(Boolean);

    await Promise.all(
        valid.map(({ TTSduration, bgLength, bgRepeat, outputName }) =>
            saveFinal(TTSduration, bgLength, bgRepeat, resultsDir, outputName, tempDir)
        )
    );

    const zipPath = await zipFolder(resultsDir);
    await removeDir(tempDir);
    await removeDir(resultsDir);
    return zipPath;
}

/** Zip a folder and return the output zip path. */
function zipFolder(folderPath) {
    const zipPath = path.join(path.dirname(folderPath), `${path.basename(folderPath)}.zip`);

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        out.on('close', () => resolve(zipPath));
        archive.on('error', reject);
        archive.pipe(out);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

// ─────────────────────────────────────────────
// Route: POST /api/save
// ─────────────────────────────────────────────
app.post('/api/save', async (req, res) => {
    const { folderName, backgroundSong } = req.body;

    if (!folderName || typeof folderName !== 'string') {
        return res.status(400).json({ error: 'folderName is required' });
    }

    const safeName = sanitizeFileName(folderName);
    const tempDir = path.join(__dirname, `_temp_${safeName}`);
    const resultsDir = path.join(RESULTS_DIR, safeName);

    try {
        await fs.promises.access(tempDir, fs.constants.F_OK);

        await removeDir(resultsDir);
        await fs.promises.mkdir(resultsDir, { recursive: true });

        // Move transcription
        await fs.promises.rename(
            path.join(tempDir, 'Trascrizione.txt'),
            path.join(resultsDir, 'Trascrizione.txt')
        );

        // Copy background song if selected
        if (backgroundSong) {
            await copyIfExists(
                path.join(SONGS_DIR, backgroundSong),
                path.join(resultsDir, backgroundSong)
            );
        }

        const inputData = categorizeFiles(tempDir, resultsDir);
        await mergeAudioFiles(inputData, resultsDir, tempDir);

        const zipPath = path.normalize(path.join(RESULTS_DIR, `${safeName}.zip`));
        if (!fs.existsSync(zipPath)) {
            return res.status(404).json({ error: 'ZIP file not found after processing' });
        }

        res.setHeader('Content-Type', 'application/zip');
        res.download(zipPath, `${safeName}.zip`, err => {
            if (err) console.error('[/api/save] Download error:', err);
        });
    } catch (err) {
        console.error('[/api/save] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// File Upload – Multer Configuration
// ─────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'upload');
        clearDir(uploadDir);
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, sanitizeFileName(file.originalname))
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        if (!isAudioFile(file)) {
            return cb(new Error('Tipo di file non supportato. Carica un file audio standard (MP3, WAV, ecc.)'));
        }
        if (!ALLOWED_AUDIO_EXT.has(path.extname(file.originalname).toLowerCase())) {
            return cb(new Error('Estensione non supportata. Usa MP3 o WAV.'));
        }
        cb(null, true);
    }
});

// ─────────────────────────────────────────────
// Route: POST /upload
// ─────────────────────────────────────────────
app.post('/upload', upload.single('audioFile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

    try {
        const outputPath = await processMp3File(req.file.path);
        res.json({ message: `${req.file.originalname} caricato e processato con successo!`, outputPath });
    } catch (error) {
        console.error('[/upload] Processing error:', error);
        res.status(500).json({ error: 'Errore durante il processamento del file' });
    }
}, (error, req, res, next) => {
    if (error instanceof multer.MulterError || error) {
        return res.status(400).json({ error: error.message });
    }
    next();
});

// ─────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────
cleanupTempFolders();

app.listen(PORT, () => {
    console.log(`[server] Running on http://localhost:${PORT} (${IS_PROD ? 'production' : 'development'})`);
});
