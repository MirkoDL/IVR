'use strict';

/**
 * songArray.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Utility per leggere l'elenco dei file MP3 disponibili nella directory songs/.
 * I file vengono restituiti ordinati alfabeticamente.
 */

const fs   = require('fs').promises;
const path = require('path');

/**
 * Restituisce la lista ordinata dei file MP3 presenti in una directory.
 *
 * @param {string} dirPath - Percorso assoluto della directory da leggere
 * @returns {Promise<string[]>} Array di nomi file .mp3 ordinati alfabeticamente
 * @throws {Error} Se la directory non è accessibile
 */
async function getMp3Files(dirPath) {
    const files = await fs.readdir(dirPath);
    return files
        .filter(file => path.extname(file).toLowerCase() === '.mp3')
        .sort();
}

module.exports = { getMp3Files };
