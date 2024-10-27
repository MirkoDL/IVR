const express = require('express');
const path = require('path');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const fs = require('fs');
const { Readable } = require('stream');
const ID3 = require('node-id3'); //audio metadata

const cron = require('node-cron');
const { exec } = require('child_process');

const { getMp3Files } = require('./songs/songArray.js'); // Importa la funzione dal file songArray.js

require('dotenv').config({ path: __dirname + '/env/hidden.env' });

const ffmpeg = require('fluent-ffmpeg');

const archiver = require('archiver');


const app = express();
const PORT = process.env.PORT;

// Middleware per il parsing del JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve i file statici dalla cartella 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Rotta principale
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// Rotta per gestire la richiesta POST
app.post('/submit', (req, res) => {
    //console.log('Testo ricevuto:', req.body.text); // Stampa il testo nel terminale
    res.json({ message: 'Testo ricevuto con successo!' }); // Risposta al client
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



app.post('/api/synthesize', (req, res) => {
    const dataArray = req.body; // Ottieni i dati inviati
    //console.log(dataArray);

    //create folder to store _temp messages
    const folderName = '_temp_' + dataArray.companyName;
    const dirPath = path.join(__dirname, folderName);

    fs.rm(dirPath, { recursive: true, force: true }, async (err) => {
        if (err) {
            console.error('Errore nella rimozione della cartella:', err);
            return res.status(500).json({ message: 'Errore durante la rimozione della cartella' });
        }

        // Crea la nuova cartella
        fs.mkdir(dirPath, { recursive: true }, (err) => {
            if (err) {
                console.error('Errore nella creazione della cartella:', err);
                return res.status(500).json({ message: 'Errore nella creazione della cartella' });
            } else {
                console.log(`Cartella _temp_"${folderName}" creata con successo`);
            }
        });

        const polly = new PollyClient({
            region: 'eu-central-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            }
        });

        // Sintetizza i messaggi
        try {
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
    const songsDir = path.join(__dirname, folderName);
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
    const filePath = path.join(__dirname, folder, filename);
    res.sendFile(filePath);
});

app.post('/delete-audio', (req, res) => {
    const { files, folder } = req.body; // Ottieni i file e la cartella

    if (!files || files.length === 0 || !folder) {
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
cron.schedule('0 0 * * *', () => {
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
    const silencePath = path.join('_private', 'silence.mp3'); // Path to silence file

    const promises = inputData.map(async (obj) => {
        let outputName = obj.outputName.replace(/\.(mp3|wav)$/, '') + '.wav';
        let backgroundSongPath = obj.backgroundSong ? path.join(resultsFolderPath, obj.backgroundSong) : null;
        let songsArray = obj.files;

        if (songsArray.length === 0) {
            return; // Skip if no audio files
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
                        await saveFinal(TTSduration, backgroundLength, backgroundRepeatTimes, resultsFolderPath, outputName, tempFolderPath);
                        resolve();
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
                        // Await saveFinal to ensure it runs last
                        await saveFinal(TTSduration, backgroundLength, backgroundRepeatTimes, resultsFolderPath, outputName, tempFolderPath);
                        resolve();
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

    // Await all promises
    try {
        await Promise.all(promises);
    } catch (error) {
        console.error('One or more merging processes failed:', error);
    }
}


//trim audioFile and save all files in a .zip archive, Finally download client side
async function saveFinal(TTSduration, backgroundLength, backgroundRepeatTimes, resultsFolderPath, outputName, tempFolderPath) {
    let command = ffmpeg();
    
    // Use a temporary output name to avoid conflicts
    const tempOutputName = `temp_${outputName}`;
    
    command.input(path.join(resultsFolderPath, outputName));
    
    if (backgroundLength && backgroundLength * backgroundRepeatTimes > TTSduration) {
        command.outputOptions('-t', TTSduration + 20); // Set trim duration
    }
    
    // Merge to the temporary file
    command.mergeToFile(path.join(tempFolderPath, tempOutputName), tempFolderPath);
    
    // Wait for the command to finish
    return new Promise(async (resolve, reject) => {
        command
            .on('end', async () => {
                // Rename the temporary file to the final name
                fs.renameSync(path.join(tempFolderPath, tempOutputName), path.join(resultsFolderPath, outputName));
                
                // Zip the results folder
                try {
                    const zipOutputPath = await zipFolder(resultsFolderPath);
                    
                    // Delete tempFolderPath and resultsFolderPath if they exist
                    if (fs.existsSync(tempFolderPath)) {
                        await fs.promises.rm(tempFolderPath, { recursive: true, force: true });
                        console.log(`Deleted temporary folder: ${tempFolderPath}`);
                    }
                    
                    if (fs.existsSync(resultsFolderPath)) {
                        await fs.promises.rm(resultsFolderPath, { recursive: true, force: true });
                        console.log(`Deleted results folder: ${resultsFolderPath}`);
                    }
                    
                    resolve(zipOutputPath); // Return the path of the zip file
                } catch (err) {
                    console.error('Error during zipping folder:', err);
                    reject(err);
                }
            })
            .on('error', (err) => {
                console.error('Error during saving final:', err);
                reject(err);
            });
    });
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
            .input('_private/silence.mp3') // Il file audio da aggiungere
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
            .complexFilter(`amix=inputs=2:duration=longest[a]`) // Assicurati che il numero di input sia corretto
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
        const zipFilePath = path.join(__dirname, 'results', `${folderName}.zip`);
        if (!fs.existsSync(zipFilePath)) {
            return res.status(404).json({ error: 'ZIP file not found' });
        }

        // Send the ZIP file as a response
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





























app.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${process.env.PORT}`);
});
