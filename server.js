const express = require('express');
const path = require('path');
//const bodyParser = require('body-parser');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const fs = require('fs');
const { Readable } = require('stream');
const ID3 = require('node-id3'); //audio metadata

const cron = require('node-cron');
const { exec } = require('child_process');

const { getMp3Files } = require('./songs/songArray.js'); // Importa la funzione dal file songArray.js

require('dotenv').config({ path: __dirname + '/env/hidden.env' });

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
    console.log('Testo ricevuto:', req.body.text); // Stampa il testo nel terminale
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
    console.log(dataArray);

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
        //readMeta(dirPath);
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

            writeStream.on('finish', () => {
                console.log(`File salvato: ${outputPath}`);
                const tags = {
                    title: playButtonId
                };

                ID3.write(tags, outputPath, (err) => {
                    if (err) {
                        console.error('Errore durante la scrittura dei metadati:', err);
                    } else {
                        console.log('Metadati aggiunti con successo!');
                    }
                });

            });
        } else {
            console.error('AudioStream non è un flusso:', data);
        }
    } catch (error) {
        console.error('Errore nella sintesi vocale:', error);
    }
}

app.get('/play/:folder/:controllerName', async (req, res) => {
    const folderName = req.params.folder;
    const controllerName = req.params.controllerName;
    const songsDir = path.join(__dirname, folderName);
    console.log(songsDir);
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

    files.forEach(fileName => {
        const filePath = path.join(__dirname, folder, fileName); // Usa il percorso della cartella

        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Errore durante l'eliminazione di ${fileName}:`, err);
                return res.status(500).send(`Errore durante l'eliminazione di ${fileName}`);
            }
            console.log(`File ${fileName} eliminato con successo.`);
        });
    });

    res.status(200).send('Richiesta di eliminazione completata.');
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
                        console.log(`Cartella ${folder} eliminata con successo.`);
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

app.listen(PORT, () => {
    console.log(`Server in esecuzione su http://localhost:${process.env.PORT}`);
});
