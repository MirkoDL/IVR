# 📠 IVR Generator

Web application for automating IVR (Interactive Voice Response) message production using **Amazon Polly** neural TTS. Generate, preview, and download production-ready audio files — Italian + optional English — mixed with background music, directly from the browser.

## ✨ Features

- 🎙️ **Neural TTS** via Amazon Polly (voices: Bianca IT, Ruth EN)
- 🎵 **Background music mixing** — upload your own track or pick from the library
- 🌐 **Bilingual output** — Italian + English per message, in one ZIP
- 📝 **Auto-transcription** — `Trascrizione.txt` included in every export
- 🔊 **In-browser preview** — play/pause each generated clip before saving
- 📦 **ZIP download** — all WAV files + transcription in one click
- 🔒 **CSRF protection**, security headers, path traversal prevention
- 🐳 **Docker-ready** — Alpine-based image with non-root user

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20 |
| Framework | Express.js |
| TTS | Amazon Polly (AWS SDK v3) |
| Audio | ffmpeg / fluent-ffmpeg |
| Frontend | Bootstrap 5, Vanilla JS |
| Container | Docker (Alpine) |

## 🚀 Getting Started

### Prerequisites

- Node.js ≥ 20
- ffmpeg installed and in PATH
- AWS credentials with Polly access

### Environment Variables

Create `env/hidden.env`:

```
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
CSRF_KEY=a_random_secret_string
NODE_ENV=production
PORT=3000
```

### Local Development

```bash
npm install
node server.js
```

### Docker

```bash
docker build -t ivr-generator .
docker run -p 3000:3000 --env-file env/hidden.env ivr-generator
```

## 📁 Project Structure

```
├── server.js          # Express app + all API routes
├── audioNormalizer.js # Volume normalisation + telephony conversion
├── songs/             # Background music library
├── _private/          # Silence padding files (startSilence.mp3, mixSilence.mp3)
├── results/           # Temporary output before ZIP (auto-cleaned)
├── public/
│   ├── main.html
│   ├── main.js
│   └── main.css
├── dockerfile
└── package.json
```

## 🗺️ Roadmap

- [ ] Auto-translation (DeepL / LibreTranslate)
- [ ] Multi-language support beyond IT/EN
- [ ] Download previously generated files
- [x] Song upload
- [x] Transcription file in export
- [x] In-browser audio preview
- [x] Docker support with non-root user

## 👤 Author

[@MirkoDL](https://github.com/MirkoDL)

## 📄 License

[![GPLv3 License](https://img.shields.io/badge/GPL_v3-yellow)](https://opensource.org/licenses/GPL-3.0)
