const fs = require('fs').promises; // Usa la versione basata su Promise
const path = require('path');

/**
 * Funzione per ottenere tutti i file .mp3 da una directory
 * @param {string} dirPath - Il percorso della directory da leggere
 * @returns {Promise<string[]>} - Una promessa che risolve con un array di nomi di file .mp3
 */
async function getMp3Files(dirPath) {
    try {
        const files = await fs.readdir(dirPath);
        // Filtra i file per ottenere solo quelli con estensione .mp3
        const mp3Files = files.filter(file => path.extname(file).toLowerCase() === '.mp3');        
        return [...mp3Files.sort()];
    } catch (err) {
        console.error('Errore nella lettura della directory:', err);
        throw err; // Rilancia l'errore per gestirlo a livello superiore
    }
}

// Esporta la funzione
module.exports = { getMp3Files };
