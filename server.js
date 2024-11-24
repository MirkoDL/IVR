const express = require('express');
const path = require('path');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const fs = require('fs');
const { Readable } = require('stream');
const ID3 = require('node-id3'); //audio metadata
const cron = require('node-cron');
const { exec } = require('child_process');
const fileUpload = require('express-fileupload');
const multer = require('multer');

const { getMp3Files } = require('./songs/songArray.js'); // Importa la funzione dal file songArray.js
const { processMp3File } = require('./audioNormalizer.js'); // 

require('dotenv').config({ path: __dirname + '/env/hidden.env' });

const ffmpeg = require('fluent-ffmpeg');

const archiver = require('archiver');

const { doubleCsrf } = require('csrf-csrf');
const cookieParser = require('cookie-parser');


const app = express();

// Middleware per il parsing del JSON
app.use(express.static(path.join(__dirname, 'public')));


// Middleware per negare l'accesso alla directory .git
app.use((req, res, next) => {
    if (req.path.startsWith('/.git')) {
        return res.status(403).send('Access Denied');
    }
    next();
});


// Middleware to handle CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://ivr.up.railway.app'); // Replace with your frontend domain
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3000'); // Replace with your frontend domain
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST'); // Specify allowed methods
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Specify allowed headers

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200); // Respond with 200 OK for OPTIONS requests
    }

    next(); // Pass to the next middleware
});

// Disable the X-Powered-By header
app.disable('x-powered-by');

// Set the X-Frame-Options header
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// Configure Content Security Policy
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; frame-ancestors 'none'; form-action 'self';");
    next();
});


const PORT = process.env.PORT;


app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));

/// Configurazione del middleware double-csrf
const csrf = doubleCsrf({
    getSecret: () => process.env.CSRF_KEY,
    getTokenFromRequest: req => {
        // Controlla prima nel corpo della richiesta
        let token = req.body._csrf;
        // Se non trovato, controlla negli headers
        if (!token) {
            token = req.headers['x-csrf-token'];
        }
        return token;
    },
    cookieName: process.env.NODE_ENV === 'production' ? '__Host-prod.x-csrf-token' : '_csrf',
    cookieOptions: {
        httpOnly: true, // Assicurati che il cookie sia solo HTTP
        secure: process.env.NODE_ENV === 'production' // Abilita per HTTPS in produzione
    }
});

// Aggiungi il middleware double-csrf e generazione del token
app.use(csrf.doubleCsrfProtection);
app.use((req, res, next) => {
    res.locals.csrfToken = csrf.generateToken(req, res);
    next();
});


// Rotta per ottenere il token CSRF 
app.get('/api/csrf-token', (req, res) => {
    res.json({
        csrfToken: res.locals.csrfToken
    });
});

// Rotta principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});


// Percorso della directory da cui leggere i file
const directoryPath = path.join(__dirname, '/songs'); // Cambia 'filesList' con il percorso della tua directory

app.get('/api/canzoni', async (req, res) => {
    try {
        const mp3Files = await getMp3Files(directoryPath); // Aspetta che l'array di file MP3 sia popolato
        res.setHeader('Content-Type', 'application/json');
        res.json(mp3Files); // Restituisce l'array di file MP3 come JSON
    } catch (error) {
        console.error('Errore nel recupero delle canzoni:', error);
        res.status(500).json({ error: 'Errore nel recupero delle canzoni' });
    }
});



// Rotta per sintetizzare i messaggi
app.post('/api/synthesize', (req, res) => {
    // Verifica il token CSRF
    if (!req.csrfToken() || req.csrfToken() !== req.body._csrf) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    const dataArray = req.body; // Ottieni i dati inviati

    // Crea la cartella per memorizzare i messaggi temporanei
    const folderName = '_temp_' + dataArray.companyName;
    const dirPath = path.normalize(path.join(__dirname, folderName));

    fs.rm(dirPath, { recursive: true, force: true }, async (err) => {
        if (err) {
            console.error('Errore nella rimozione della cartella:', err);
            return res.status(500).json({ message: 'Errore durante la rimozione della cartella' });
        }

        try {
            // Crea la nuova cartella
            await fs.promises.mkdir(dirPath, { recursive: true });
            console.log(`Cartella _temp_"${folderName}" creata con successo`);

            // Crea il contenuto del file di testo
            let fileContent = '';
            dataArray.data.forEach(item => {
                fileContent += `${item.fileName}:\n`;
                fileContent += `IT -> ${item.messageText}\n`;
                if (item.engMessageText) {
                    fileContent += `ENG -> ${item.engMessageText}\n`;
                }
                fileContent += `\n`; // linea vuota
            });

            // Scrittura del file di testo
            const transcriptionFilePath = path.join(dirPath, 'Trascrizione.txt');
            await fs.promises.writeFile(transcriptionFilePath, fileContent);
            console.log('File Trascrizione.txt creato/sovrascritto con successo');

            const polly = new PollyClient({
                region: 'eu-central-1',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
            });

            // Sintetizza i messaggi
            await synthesizeMessages(dataArray.data, polly, dirPath);
            res.json({ message: 'Dati ricevuti con successo e audio generato!' });
        } catch (error) {
            console.error('Errore durante la sintesi:', error);
            res.status(500).json({ message: 'Errore durante la sintesi vocale' });
        }
    });
});

// Funzione per sintetizzare i messaggi
async function synthesizeMessages(messages, polly, dirPath) {
    for (const item of messages) {
        const { fileName, messageText, engMessageText, playButtonId } = item;

        // Genera audio in italiano
        await synthesizeSpeech(polly, `<speak>${messageText}</speak>`, 'it-IT', path.join(dirPath, `${fileName}.mp3`), playButtonId);

        // Genera audio in inglese se non è null
        if (engMessageText !== null) {
            await synthesizeSpeech(polly, `<speak>${engMessageText}</speak>`, 'en-US', path.join(dirPath, `eng_${fileName}.mp3`), "ENG" + playButtonId);
        }
    }
}

// Funzione per la sintesi vocale
async function synthesizeSpeech(polly, text, languageCode, outputPath, playButtonId) {
    const params = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: languageCode === 'it-IT' ? 'Bianca' : 'Ruth',
        LanguageCode: languageCode,
        TextType: 'ssml',
        Engine: 'neural'
    };

    try {
        const command = new SynthesizeSpeechCommand(params);
        //console.log(command)
        const data = await polly.send(command);
        // Controlla se AudioStream è un flusso
        if (data.AudioStream instanceof Readable) {
            const writeStream = fs.createWriteStream(outputPath);
            data.AudioStream.pipe(writeStream);

            // Restituisci una Promise che si risolve quando il flusso di scrittura è completato
            return new Promise((resolve, reject) => {
                writeStream.on('finish', () => {
                    console.log(`File salvato: ${outputPath}`);
                    const tags = {
                        title: playButtonId
                    };

                    ID3.write(tags, outputPath, (err) => {
                        if (err) {
                            console.error('Errore durante la scrittura dei metadati:', err);
                            reject(err); // Rifiuta la Promise in caso di errore
                        } else {
                            console.log('Metadati aggiunti con successo! - Audio salvato');
                            resolve(); // Risolvi la Promise
                        }
                    });
                });

                writeStream.on('error', (err) => {
                    console.error('Errore durante la scrittura del file:', err);
                    reject(err); // Rifiuta la Promise in caso di errore
                });
            });
        } else {
            console.error('AudioStream non è un flusso:', data);
            throw new Error('AudioStream non è un flusso');
        }
    } catch (error) {
        console.error('Errore nella sintesi vocale:', error);
        throw error; // Propaga l'errore
    }
}

app.get('/play/:folder/:controllerName', async (req, res) => {
    const folderName = req.params.folder;
    const controllerName = req.params.controllerName;

    // Controllo se il nome della cartella inizia con "_temp_"
    
    if (!folderName.startsWith('_temp_')) {
        return res.status(400).send('Forbidden');
    }
    const songsDir = path.normalize(path.join(__dirname, folderName));
    //console.log(songsDir);
    let songPath = null;

    // Leggi i file nella cartella specificata
    fs.readdir(songsDir, async (err, files) => {
        if (err) {
            return res.status(500).send('Errore nella lettura della cartella.');
        }

        // Trova la canzone con il titolo specificato
        for (const file of files) {
            const filePath = path.join(songsDir, file);
            try {
                const metadata = ID3.read(filePath);
                if (metadata && metadata.title && metadata.title.toLowerCase() === controllerName.toLowerCase()) {
                    songPath = filePath;
                    break;
                }
            } catch (error) {
                console.error(`Errore nella lettura dei metadati per ${file}:`, error);
            }
        }

        if (!songPath) {
            return res.status(404).send('Canzone non trovata.');
        }

        // Invia l'URL della canzone al client per la riproduzione
        res.json({ audioUrl: `/songs/${folderName}/${path.basename(songPath)}` });
    });
});


// Endpoint per servire file audio
app.get('/:folder/:filename', (req, res) => {
    const { folder, filename } = req.params;
    const filePath = path.normalize(path.join(__dirname, folder, filename));
    res.sendFile(filePath);
});

app.post('/delete-audio', (req, res) => {
    // Verifica il token CSRF
    if (!req.csrfToken() || req.csrfToken() !== req.body._csrf) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    const { files, folder } = req.body; // Ottieni i file e la cartella
    if (!files || files.length === 0 || files[0] === ".mp3" || !folder) {
        return res.status(400).send('Nessun file specificato o cartella mancante.');
    }

    const deletedFiles = [];
    const failedFiles = [];
    let pendingOperations = files.length;

    files.forEach(fileName => {
        const filePath = path.join(__dirname, folder, fileName); // Usa il percorso della cartella

        fs.unlink(filePath, (err) => {
            if (err) {
                //console.error(`Errore durante l'eliminazione di ${fileName}:`, err);
                failedFiles.push(fileName);
            } else {
                console.log(`File ${fileName} eliminato con successo.`);
                deletedFiles.push(fileName);
            }

            pendingOperations--;

            if (pendingOperations === 0) {
                // Tutte le operazioni di eliminazione sono state completate
                if (failedFiles.length > 0) {
                    return res.status(500).send({
                        message: 'Alcuni file non sono stati eliminati.',
                        deletedFiles,
                        failedFiles
                    });
                } else {
                    return res.status(200).send({
                        message: 'Richiesta di eliminazione completata.',
                        deletedFiles
                    });
                }
            }
        });
    });
});




// Funzione per pulire le cartelle temporanee
const cleanupTempFolders = () => {
    const tempFolderPath = path.join(__dirname); // Modifica se necessario

    fs.readdir(tempFolderPath, (err, files) => {
        if (err) {
            console.error('Errore nella lettura della cartella:', err);
            return;
        }

        const tempFolders = files.filter(file => file.startsWith('_temp_'));

        const deletePromises = tempFolders.map(folder => {
            return new Promise((resolve, reject) => {
                const folderPath = path.join(tempFolderPath, folder);
                fs.rm(folderPath, { recursive: true, force: true }, (err) => {
                    if (err) {
                        console.error(`Errore durante l'eliminazione della cartella ${folder}:`, err);
                        reject(err);
                    } else {
                        //console.log(`Cartella ${folder} eliminata con successo.`);
                        resolve();
                    }
                });
            });
        });

        Promise.all(deletePromises)
            .then(() => console.log('Pulizia delle cartelle temporanee completata.'))
            .catch(() => console.error('Errore durante la pulizia delle cartelle temporanee.'));
    });
};
cleanupTempFolders();


// Pianifica il riavvio del server ogni giorno a mezzogiorno
/*cron.schedule('0 0 * * *', () => {
    console.log('Riavvio del server programmato...');
    exec('pm2 restart IVR_server', (err, stdout, stderr) => {
        if (err) {
            console.error(`Errore: ${err}`);
            return;
        }
        console.log(`Stdout: ${stdout}`);
        console.error(`Stderr: ${stderr}`);
    });
});
*/

// Endpoint per ricevere folderName e backgroundSong
async function copyBackgroundSong(sourceFilePath, destFilePath) {
    try {
        // Verifica se il file esiste prima di copiarlo
        await fs.promises.access(sourceFilePath, fs.constants.F_OK);

        // Copia il file
        await fs.promises.copyFile(sourceFilePath, destFilePath);
        //console.log(`File copiato con successo da ${sourceFilePath} a ${destFilePath}`);
    } catch (err) {
        // Se il file non esiste, non bloccare l'esecuzione
        if (err.code === 'ENOENT') {
            console.warn(`Il file ${sourceFilePath} non esiste. Copia non eseguita.`);
        } else {
            console.error(`Errore nella copia del file: ${err.message}`);
        }
    }
}

function categorizeFiles(tempFolderPath, resultsFolderPath) {
    const files = fs.readdirSync(tempFolderPath);
    const resultArray = [];
    const checkedFiles = new Set();

    for (const file of files) {
        if (!file.startsWith('eng_') && !checkedFiles.has(file)) {
            const relatedFile = `eng_${file}`;
            const fileObject = { files: [file], outputName: file, backgroundSong: null };

            if (files.includes(relatedFile)) {
                fileObject.files.push(relatedFile);
                fileObject.outputName = fileObject.outputName;
            }

            // Controlla se esiste un file .mp3 nella cartella resultsFolderPath
            const backgroundFile = fs.readdirSync(resultsFolderPath).find(f => f.endsWith('.mp3'));
            if (backgroundFile) {
                fileObject.backgroundSong = backgroundFile;
            }

            resultArray.push(fileObject);
            checkedFiles.add(file);
            checkedFiles.add(relatedFile);
        }
    }

    for (const file of files) {
        if (file.startsWith('eng_') && !checkedFiles.has(file)) {
            const originalFile = file.slice(4);
            const existingObject = resultArray.find(obj => obj.files.includes(originalFile));

            if (existingObject) {
                existingObject.files.push(file);
            } else {
                const fileObject = { files: [file], outputName: originalFile, backgroundSong: null };

                // Controlla se esiste un file .mp3 nella cartella resultsFolderPath
                const backgroundFile = fs.readdirSync(resultsFolderPath).find(f => f.endsWith('.mp3'));
                if (backgroundFile) {
                    fileObject.backgroundSong = backgroundFile;
                }

                resultArray.push(fileObject);
            }

            checkedFiles.add(file);
        }
    }

    return resultArray;
}





async function mergeAudioFiles(inputData, resultsFolderPath, tempFolderPath) {
    const silencePath = path.join('_private', 'mixSilence.mp3'); // Path to silence file

    const promises = inputData.map(async (obj) => {
        let outputName = obj.outputName.replace(/\.(mp3|wav)$/, '') + '.wav';
        let backgroundSongPath = obj.backgroundSong ? path.join(resultsFolderPath, obj.backgroundSong) : null;
        let songsArray = obj.files;

        if (songsArray.length === 0) {
            console.log('No audio files to process for:', obj.outputName);
            return null; // Skip if no audio files
        }

        const songPaths = songsArray.map(song => path.join(tempFolderPath, song));
        const TTSduration = await getTotalDuration(songPaths);
        let backgroundLength = backgroundSongPath ? await getDuration(backgroundSongPath) : 0;
        let backgroundRepeatTimes = Math.ceil(TTSduration / backgroundLength);

        // Function to handle single audio file
        const handleSingleAudioFile = async (originalFilePath) => {
            const newFilePath = path.join(resultsFolderPath, outputName);
            return new Promise((resolve, reject) => {
                ffmpeg(originalFilePath)
                    .outputOptions('-b:a', '192k')
                    .outputOptions('-ar', '44100')
                    .outputOptions('-ac', '1')
                    .toFormat('wav')
                    .save(newFilePath)
                    .on('end', async () => {
                        console.log('File converted to WAV and moved successfully:', newFilePath);
                        await addSilenceAtStart(tempFolderPath, resultsFolderPath, outputName);
                        resolve({ TTSduration, backgroundLength, backgroundRepeatTimes, outputName, backgroundSongPath });
                    })
                    .on('error', (err) => {
                        console.error('Error converting file:', err);
                        reject(err);
                    });
            });
        };

        // If a single audio file without background, handle it
        if (songsArray.length === 1 && !backgroundSongPath) {
            return handleSingleAudioFile(path.join(tempFolderPath, songsArray[0]));
        }

        try {
            // Create a command to merge audio files
            const command = ffmpeg();
            songPaths.forEach(file => {
                command.input(file).input(silencePath);
            });

            return new Promise((resolve, reject) => {
                command
                    .on('end', async () => {
                        await addSilenceAtStart(tempFolderPath, resultsFolderPath, outputName);
                        if (backgroundSongPath) {
                            await mergeWithBackgroundSong(outputName, backgroundSongPath, resultsFolderPath, tempFolderPath, backgroundRepeatTimes);
                        }
                        resolve({ TTSduration, backgroundLength, backgroundRepeatTimes, outputName, backgroundSongPath });
                    })
                    .on('error', (err) => {
                        console.error('Error during merging:', err);
                        reject(err);
                    })
                    .outputOptions('-b:a', '192k')
                    .outputOptions('-ar', '44100')
                    .outputOptions('-ac', '1')
                    .toFormat('wav')
                    .mergeToFile(path.join(resultsFolderPath, outputName), tempFolderPath);

                console.log('Audio files merging initiated:', path.join(resultsFolderPath, outputName));
            });
        } catch (error) {
            console.error('Error during the merging process:', error);
            throw error;
        }
    });

    // Await all promises and gather results
    // Await all promises and gather results
    try {
        const results = await Promise.all(promises);

        // Filter out null results (for cases where there were no audio files)
        const validResults = results.filter(result => result !== null);

        // Call saveFinal for each valid result and collect the promises
        const saveFinalPromises = validResults.map(({ TTSduration, backgroundLength, backgroundRepeatTimes, outputName, backgroundSongPath }) => {
            return saveFinal(TTSduration, backgroundLength, backgroundRepeatTimes, resultsFolderPath, outputName, tempFolderPath);
        });

        // Wait for all saveFinal calls to complete
        await Promise.all(saveFinalPromises);

        // Now call zipFolder after all saveFinal calls have finished
        const zipOutputPath = await zipFolder(resultsFolderPath);

        // Clean up temporary folders after zipping
        await cleanupFolders(tempFolderPath, resultsFolderPath);

    } catch (error) {
        console.error('One or more merging processes failed:', error);
    }
}
// Function to trim audioFile and save all files in a .zip archive
async function saveFinal(TTSduration, backgroundLength, backgroundRepeatTimes, resultsFolderPath, outputName, tempFolderPath) {
    const inputFilePath = path.join(resultsFolderPath, outputName);

    // Check if the input file exists
    if (!fs.existsSync(inputFilePath)) {
        throw new Error(`Input file does not exist: ${inputFilePath}`);
    }

    let command = ffmpeg();
    const tempOutputName = `temp_${outputName}`;

    command.input(inputFilePath);

    if (backgroundLength && backgroundLength * backgroundRepeatTimes > TTSduration) {
        command.outputOptions('-t', TTSduration + 20); // Set trim duration
    }

    command.mergeToFile(path.join(tempFolderPath, tempOutputName), tempFolderPath);

    return new Promise((resolve, reject) => {
        command
            .on('end', async () => {
                const finalOutputPath = path.join(resultsFolderPath, outputName);
                fs.renameSync(path.join(tempFolderPath, tempOutputName), finalOutputPath);
                resolve(finalOutputPath); // Resolve with the final output path
            })
            .on('error', (err) => {
                console.error('Error during saving final:', err);
                reject(err);
            });
    });
}


async function cleanupFolders(tempFolderPath, resultsFolderPath) {
    if (fs.existsSync(tempFolderPath)) {
        await fs.promises.rm(tempFolderPath, { recursive: true, force: true });
        console.log(`Deleted temporary folder: ${tempFolderPath}`);
    }

    if (fs.existsSync(resultsFolderPath)) {
        await fs.promises.rm(resultsFolderPath, { recursive: true, force: true });
        console.log(`Deleted results folder: ${resultsFolderPath}`);
    }
}




async function zipFolder(folderPath) {
    const folderName = path.basename(folderPath);
    const outputZipPath = path.join(path.dirname(folderPath), `${folderName}.zip`);

    console.log(`Attempting to zip folder: ${folderPath}`);

    if (fs.existsSync(outputZipPath)) {
        console.log(`Deleting existing zip file: ${outputZipPath}`);
        fs.unlinkSync(outputZipPath);
    }

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputZipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            console.log(`Zipped ${archive.pointer()} total bytes`);
            console.log(`Zip file created at: ${outputZipPath}`);
            resolve(outputZipPath);
        });

        archive.on('error', (err) => {
            console.error('Archive error:', err);
            reject(err);
        });

        archive.pipe(output);
        archive.directory(folderPath, false);

        console.log('Finalizing the archive...');
        archive.finalize();
    });
}



function addSilenceAtStart(tempFolderPath, resultsFolderPath, outputName) {
    const tempOutputPath = path.join(tempFolderPath, `longer_${outputName}`); // Usa un nome diverso per l'output
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input('_private/startSilence.mp3') // Il file audio da aggiungere
            .input(path.join(resultsFolderPath, outputName)) // Il file audio principale
            .complexFilter([
                '[0:a][1:a]concat=n=2:v=0:a=1[out]' // Concatenazione delle tracce audio
            ])
            .outputOptions('-map', '[out]') // Mappatura dell'output
            .save(tempOutputPath, tempFolderPath) // Merge to a temporary file
            .on('end', () => {
                //console.log('Elaborazione completata!');

                // Move the merged file to the results folder with the original output name
                fs.rename(tempOutputPath, path.join(resultsFolderPath, outputName), (err) => {
                    if (err) {
                        console.error('Error moving the merged file:', err);
                        reject(err);
                    } else {
                        //console.log('Merged file moved successfully to results folder.');
                        resolve();
                    }
                });
            })
            .on('error', (err) => {
                console.error('Si è verificato un errore: ' + err.message);
                reject(err);
            });
    });
}


function mergeWithBackgroundSong(outputName, backgroundSongPath, resultsFolderPath, tempFolderPath, backgroundRepeatTimes) {
    const command = ffmpeg();
    const primaryAudioPath = path.join(resultsFolderPath, outputName);
    const tempOutputPath = path.join(tempFolderPath, `merged_${outputName}`);

    // Preparare il brano di sottofondo in modo che venga ripetuto
    command.input(backgroundSongPath).inputOption(`-stream_loop ${backgroundRepeatTimes - 1}`);

    return new Promise((resolve, reject) => {
        command
            .input(primaryAudioPath)
            .complexFilter(`[0:a]anull[a0];[1:a]volume=3.0[a1];[a0][a1]amix=inputs=2:duration=longest[a]`) // Assicurati che il numero di input sia corretto
            .outputOptions('-map', '[a]')
            .save(tempOutputPath)
            .on('end', () => {
                fs.rename(tempOutputPath, path.join(resultsFolderPath, outputName), (err) => {
                    if (err) {
                        console.error('Error moving the merged file:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            })
            .on('error', (err) => {
                console.error('Si è verificato un errore: ' + err.message);
                reject(err);
            });
    });
}




async function getTotalDuration(audioFiles) {
    let totalDuration = 0;

    for (const file of audioFiles) {
        totalDuration += 2.5;
        const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(`${file}`, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });

        totalDuration += metadata.format.duration;
    }

    return Math.ceil(totalDuration + 3);

}

async function getDuration(file) {
    let duration = 0;
    const metadata = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(`${file}`, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });

    duration = metadata.format.duration;


    return Math.ceil(duration + 3);


}






app.post('/api/save', async (req, res) => {
    // Verifica il token CSRF
    if (!req.csrfToken() || req.csrfToken() !== req.body._csrf) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    const { folderName, backgroundSong } = req.body;

    if (!folderName) {
        return res.status(400).json({ error: 'folderName is required' });
    }


    const tempFolderPath = path.join(__dirname, `_temp_${folderName}`);
    const resultsFolderPath = path.join(__dirname, 'results', folderName);


    try {
        // Verify if the temporary folder exists
        await fs.promises.access(tempFolderPath, fs.constants.F_OK);

        // If the results folder exists, remove it
        await fs.promises.rm(resultsFolderPath, { recursive: true, force: true });

        // Create the results folder
        await fs.promises.mkdir(resultsFolderPath);

        //move trascrizione.txt
        await fs.promises.rename(path.join(tempFolderPath, 'Trascrizione.txt'), path.join(resultsFolderPath, 'Trascrizione.txt'));

        // If backgroundSong is not null, copy the file
        if (backgroundSong) {
            const sourceFilePath = path.join('./songs', backgroundSong);
            const destFilePath = path.join(resultsFolderPath, backgroundSong);
            await copyBackgroundSong(sourceFilePath, destFilePath);
        }

        // Merge audio files in the temporary folder
        const inputData = categorizeFiles(tempFolderPath, resultsFolderPath);
        await mergeAudioFiles(inputData, resultsFolderPath, tempFolderPath);

        // Check for the ZIP file
        const zipFilePath = path.normalize(path.join(__dirname, 'results', `${folderName}.zip`));
        if (!fs.existsSync(zipFilePath)) {
            return res.status(404).json({ error: 'ZIP file not found' });
        }

        // Send the ZIP file as a response
        res.setHeader('Content-Type', 'application/zip');
        res.download(zipFilePath, `${folderName}.zip`, (err) => {
            if (err) {
                console.error('Error sending the file:', err);
                return res.status(500).json({ error: 'Error sending the file' });
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});


// Funzione per svuotare la cartella di upload
function clearUploadDir(uploadDir) {
    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(file => {
            const filePath = path.join(uploadDir, file);
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
            }
        });
    }
}

// Funzione per controllare se il file è un audio
const isAudioFile = (file) => {
    const audioMimeTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3', 'audio/mp4'];
    return audioMimeTypes.includes(file.mimetype);
};

// Funzione per sanificare il nome del file
const sanitizeFileName = (fileName) => {
    return path.basename(fileName).replace(/[^a-zA-Z0-9.-]/g, '_'); // Sostituisce caratteri non sicuri
};

// Configura multer per il caricamento dei file
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'upload/';
        clearUploadDir(uploadDir);
        // Crea la cartella se non esiste
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const sanitizedFileName = sanitizeFileName(file.originalname);
        cb(null, sanitizedFileName); // Usa il nome sanificato del file
    }
});

// Limite di dimensione del file
const maxFileSize = 10 * 1024 * 1024; // 10 MB

const upload = multer({
    storage: storage,
    limits: { fileSize: maxFileSize }, // Limita la dimensione del file
    fileFilter: (req, file, cb) => {
        if (!isAudioFile(file)) {
            return cb(new Error('Tipo di file non supportato. Carica un file audio standard (MP3, WAV, ecc.).'));
        }
        const allowedExtensions = ['.mp3', '.wav'];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(fileExtension)) {
            return cb(new Error('Estensione del file non supportata. Carica un file audio standard (MP3, WAV, ecc.).'));
        }
        cb(null, true);
    }
});

// Rotta per il caricamento del file
app.post('/upload', upload.single('audioFile'), (req, res) => {
    // Verifica che un file sia stato caricato
    if (!req.file) {
        return res.status(400).send('Nessun file caricato.');
    }

    console.log(`File caricato: ${req.file.originalname}`);
    console.log(`Percorso del file: ${req.file.path}`);

    console.log('File verificato correttamente, iniziando il processamento...');

    // Chiama la funzione processAudioFile
    processMp3File(req.file.path)
        .then(outputFilePath => {
            console.log(`File processato e salvato come: ${outputFilePath}`);
            res.json({ message: `File ${req.file.originalname} caricato e processato con successo!`, outputFilePath });
        })
        .catch(error => {
            console.error('Errore durante il processamento del file:', error);
            res.status(500).json('Errore durante il processamento del file.');
        });
}, (error, req, res, next) => {
    // Gestione degli errori di multer
    if (error instanceof multer.MulterError) {
        return res.status(500).json(error.message);
    } else {
        return res.status(500).json('Errore sconosciuto durante il caricamento del file.');
    }
});


















app.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${process.env.PORT}`);
});
