'use strict';

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const NORMALIZED_DIR = 'songs/';
const TARGET_VOLUME_DB = 50;
const OUTPUT_BITRATE = '56k';
const OUTPUT_FREQUENCY = 8000;
const MAX_NAME_LENGTH = 50;

/**
 * Calculate the RMS volume in dB from raw PCM channel data.
 * @param {Int16Array} channelData
 * @returns {number} volume in dB
 */
function calculateVolumeInDB(channelData) {
    const sumSquares = channelData.reduce((sum, v) => sum + v * v, 0);
    const rms = Math.sqrt(sumSquares / channelData.length);
    return 20 * Math.log10(rms);
}

/**
 * Calculate how many dB of gain to apply to reach the target volume.
 * @param {number} currentVolumeDB
 * @returns {number} gain in dB
 */
function calculateGain(currentVolumeDB) {
    return TARGET_VOLUME_DB - currentVolumeDB;
}

/**
 * Generate a unique output path in the songs directory.
 * Appends (1), (2), ... if the filename already exists.
 * @param {string} baseName
 * @returns {string} unique file path
 */
function getUniqueOutputPath(baseName) {
    const truncated = baseName.length > MAX_NAME_LENGTH
        ? baseName.substring(0, MAX_NAME_LENGTH)
        : baseName;

    let outputPath = path.join(NORMALIZED_DIR, `${truncated}.mp3`);
    let counter = 1;

    while (fs.existsSync(outputPath)) {
        outputPath = path.join(NORMALIZED_DIR, `${truncated}(${counter}).mp3`);
        counter++;
    }

    return outputPath;
}

/**
 * Process an MP3/WAV file: normalize its volume and convert it to
 * mono 8kHz 56kbps MP3 suitable for telephony IVR playback.
 * The original upload file is deleted after successful processing.
 *
 * @param {string} filePath - Path to the uploaded audio file
 * @returns {Promise<string>} Resolves with the path of the normalized output file
 */
function processMp3File(filePath) {
    console.log(`[normalizer] Processing: ${filePath}`);

    return new Promise((resolve, reject) => {
        const audioData = [];

        // Step 1: read raw PCM to compute current loudness
        ffmpeg(filePath)
            .audioCodec('pcm_s16le')
            .format('s16le')
            .on('error', err => {
                console.error(`[normalizer] PCM read error for ${filePath}:`, err);
                reject(err);
            })
            .pipe()
            .on('data', chunk => audioData.push(chunk))
            .on('end', () => {
                const buffer = Buffer.concat(audioData);
                const channelData = new Int16Array(buffer.buffer);
                const currentDB = calculateVolumeInDB(channelData);
                const gain = calculateGain(currentDB);

                console.log(
                    `[normalizer] ${path.basename(filePath)} — ` +
                    `current: ${currentDB.toFixed(2)} dB, gain applied: ${gain.toFixed(2)} dB`
                );

                const baseName = path.basename(filePath, path.extname(filePath));
                const outputPath = getUniqueOutputPath(baseName);

                // Step 2: apply gain, convert to mono telephony-grade MP3
                ffmpeg(filePath)
                    .audioFilters(`volume=${gain}dB,pan=mono|c0=0.5*c0+0.5*c1`)
                    .audioCodec('libmp3lame')
                    .audioBitrate(OUTPUT_BITRATE)
                    .audioFrequency(OUTPUT_FREQUENCY)
                    .save(outputPath)
                    .on('end', () => {
                        fs.unlink(filePath, err => {
                            if (err) {
                                console.error(`[normalizer] Could not delete temp file ${filePath}:`, err);
                                return reject(err);
                            }
                            console.log(`[normalizer] Done: ${outputPath}`);
                            resolve(outputPath);
                        });
                    })
                    .on('error', err => {
                        console.error(`[normalizer] Save error for ${outputPath}:`, err);
                        reject(err);
                    });
            });
    });
}

module.exports = { processMp3File };
