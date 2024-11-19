const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const normalizedDirectory = 'songs/'; // Cartella per i file audio normalizzati
const targetVolumeDB = 50; // Volume target in dB

function calculateVolumeInDB(channelData) {
    const rms = Math.sqrt(channelData.reduce((sum, value) => sum + value * value, 0) / channelData.length);
    const db = 20 * Math.log10(rms);
    return db;
}

function calculateGain(currentVolumeDB) {
    return targetVolumeDB - currentVolumeDB; // Calcola il guadagno necessario
}

function processMp3File(filePath) {
    console.log('Processing file before upload..')
    return new Promise((resolve, reject) => {
        const command = ffmpeg(filePath)
            .audioCodec('pcm_s16le') // Imposta il codec audio su PCM per la lettura
            .format('s16le') // Imposta il formato su PCM a 16 bit
            .on('error', (err) => {
                console.error(`Errore durante la conversione di ${filePath}:`, err);
                reject(err);
            });

        // Crea un flusso di dati per il file WAV
        const audioData = [];
        command.pipe()
            .on('data', (chunk) => {
                audioData.push(chunk);
            })
            .on('end', () => {
                const buffer = Buffer.concat(audioData);
                const channelData = new Int16Array(buffer.buffer); // Crea un array di Int16 dal buffer
                const currentVolumeDB = calculateVolumeInDB(channelData);
                const gain = calculateGain(currentVolumeDB);
                console.log(`Volume attuale per ${filePath}: ${currentVolumeDB.toFixed(2)} dB, Guadagno necessario: ${gain.toFixed(2)} dB`);

                // Applica il guadagno e salva il file audio modificato
                // Crea il nome del file di output
                let baseName = path.basename(filePath, path.extname(filePath));
                baseName = baseName.length > 50 ? baseName.substring(0, 50) : baseName; // Limita a 50 caratteri
                let outputFilePath = path.join(normalizedDirectory, `${baseName}.mp3`);
                // Gestisci conflitti di nomi
                let counter = 1;
                while (fs.existsSync(outputFilePath)) {
                    outputFilePath = path.join(normalizedDirectory, `${baseName}(${counter}).mp3`);
                    counter++;
                }
                ffmpeg(filePath)
                    .audioFilters(`volume=${gain}dB,pan=mono|c0=0.5*c0+0.5*c1`) // Applica il guadagno e converte in mono
                    .audioCodec('libmp3lame') // Imposta il codec audio su libmp3lame per l'output MP3
                    .audioBitrate('56k') // Imposta il bitrate a 56 kbps
                    .audioFrequency(8000) // Imposta la frequenza a 8000 Hz
                    .save(outputFilePath)
                    .on('end', () => {
                        // Rimuovi il file originale
                        fs.unlink(filePath, (err) => {
                            if (err) {
                                console.error(`Errore durante la rimozione di ${filePath}:`, err);
                                reject(err);
                            } else {
                                resolve(outputFilePath);
                            }
                        });
                    })
                    .on('error', (err) => {
                        console.error(`Errore durante il salvataggio di ${outputFilePath}:`, err);
                        reject(err);
                    });
            });
    });
}

module.exports = { processMp3File };
