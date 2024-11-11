# Usa un'immagine di base
FROM node:20

# Imposta la directory di lavoro
WORKDIR /app

# Copia i file di configurazione delle dipendenze
COPY package*.json ./

# Installa le dipendenze
RUN npm install

# Copia il resto dei file dell'applicazione, inclusa la cartella public
COPY . .

# Espone la porta su cui l'applicazione ascolta
EXPOSE 3000

# Comando per avviare l'applicazione
CMD ["node", "server.js"]
