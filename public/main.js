let csrfToken = ''; // Variabile per memorizzare il token CSRF

async function fetchCsrfToken() {
    const response = await fetch('/api/csrf-token');
    const data = await response.json();
    csrfToken = data.csrfToken; // Memorizza il token CSRF
    //console.log(csrfToken)
}

// Chiama la funzione per ottenere il token CSRF all'avvio
fetchCsrfToken();

// Variabile per tenere traccia dello stato dei pulsanti
let originalButtonStates = [];

// Funzione per attivare il loader
function showLoader() {
    // Imposta l'opacità di .container a 0.5
    document.querySelector('.container').style.opacity = '0.5';

    // Disabilita tutti i pulsanti nella pagina
    const buttons = document.querySelectorAll('button');
    originalButtonStates = Array.from(buttons).map(button => button.disabled);
    buttons.forEach(button => button.disabled = true);
}

// Funzione per disattivare il loader
function hideLoader() {

    // Ripristina l'opacità di .container a 1
    document.querySelector('.container').style.opacity = '1';

    // Abilita i pulsanti precedentemente disabilitati
    const buttons = document.querySelectorAll('button');
    buttons.forEach((button, index) => {
        button.disabled = originalButtonStates[index];
    });
}


window.addEventListener('load', function () {
    const textareas = document.querySelectorAll('textarea');
    textareas.forEach(textarea => {
        textarea.value = ''; // Imposta il valore a una stringa vuota
    });
    const checkboxes = document.querySelectorAll('input[type="checkbox"][id^="translateCheck"]');
    checkboxes.forEach(checkbox => {
        checkbox.checked = false; // Imposta il checkbox come non selezionato
    });

    fetch('/api/canzoni')
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json(); // Supponiamo che il server restituisca un JSON
        })
        .then(data => {
            const musicSelect = document.getElementById('music'); // Ottieni il riferimento al <select>
            musicSelect.innerHTML = ""; // Pulisci le opzioni esistenti

            // Aggiungi un'opzione predefinita
            let defaultOption = document.createElement('option');
            defaultOption.value = "blank";
            defaultOption.textContent = "Nessuna canzone";
            defaultOption.classList.add("self-align-center");
            musicSelect.appendChild(defaultOption);

            data.forEach(function (value) {
                // Rimuovi l'estensione .mp3
                let songName = value.replace('.mp3', '');
                // Limita il testo a 30 caratteri
                let displayText = songName.length > 30 ? songName.substring(0, 30).trim() + '...' : songName;

                let option = document.createElement('option');
                option.value = value; // Imposta il valore dell'opzione
                option.textContent = displayText; // Imposta il testo visualizzato
                musicSelect.appendChild(option); // Aggiungi l'elemento <option> al <select>
            });
        })
        .catch(error => {
            console.error('C\'è stato un problema con la richiesta:', error);
        });
});


// Initialize a counter for dynamically added input fields
let inputCounter = 1;

// Add an event listener to the 'addInput' button to handle clicks
document.getElementById('addInput').addEventListener('click', e => {
    // Select the main form where new input fields will be added
    const mainForm = document.getElementById('main');
    // Create a new div element for the new input row
    const newRow = document.createElement('div');
    newRow.className = 'row'; // Set the class for styling
    newRow.id = 'formRow' + inputCounter; // Set a unique ID for the new row

    // Set the inner HTML of the new row with input fields and a button
    newRow.innerHTML = `
    <div class="col-md-3">
        <div class="row d-flex ms-md-1 d-md-align-items-start justify-content-md-start justify-content-center">
            <button type="button" class="btn-close custom-btn-close" id="deleteRow${inputCounter}"></button>
        </div>
        <div class="row m-1 mt-3">
            <textarea class="form-control" id="fileName${inputCounter}" rows="1" placeholder="Tipo(Benvenuto, Notte...)"></textarea>
        </div>
        <div class="row m-1">
            <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="translateCheck${inputCounter}" />
                <label class="form-check-label" for="translateCheck${inputCounter}">Aggiungi traduzione</label>
            </div>
        </div>
    </div>
    <div class="col-md-8">
        <div class="row">
            <textarea class="form-control m-1" id="messageText${inputCounter}" rows="5"></textarea>
        </div>    
    </div>
    <div class="col-md-1 text-center d-flex flex-column align-items-center justify-content-center">
        <button class="btn btn-danger mt-3 mb-3" id="controller${inputCounter}" disabled>Play</button>
    </div>
    <div class="row mt-1">
        <hr style="width: 100%;">
    </div>
`;

    // Append the new row to the main form
    mainForm.appendChild(newRow);

    inputCounter++; // Increment the counter for the next input field
});

// Select the main container for input fields
const container = document.getElementById('main');

// Add an event listener to the container to handle changes in input fields
container.addEventListener('change', function (event) {
    // Check if the changed element is a checkbox for translation
    if (event.target.matches('input[type="checkbox"]') && event.target.id.startsWith('translateCheck')) {
        if (event.target.checked) { // If the checkbox is checked
            //console.log(event.target.id + ' è stato selezionato'); // Log selection
            const number = event.target.id.replace('translateCheck', ''); // Extract the number from the ID
            const existingEl = document.getElementById('messageText' + number); // Get the corresponding message textarea
            if (existingEl) {
                // Set the rows attributef of the textarea to 2 for translation
                existingEl.setAttribute('rows', '2');
                const existingRow = document.querySelector('.col-md-8 .row:has(textarea#messageText' + number + ')');

                // Create a new div for the translation textarea
                const newDiv = document.createElement('div');
                newDiv.className = 'row';
                newDiv.innerHTML = '<textarea class="form-control m-1" id="ENGmessageText' + number + '" rows="2"></textarea>';

                // Insert the new translation textarea after the existing message textarea
                existingRow.insertAdjacentElement('afterend', newDiv);
            }

            const newButton = document.createElement('button');
            newButton.className = 'btn btn-danger mt-3 mb-3';
            newButton.id = 'ENGcontroller' + number;
            newButton.disabled = true
            newButton.innerText = 'Play';
            const existingButton = document.getElementById('controller' + number);
            existingButton.parentNode.insertBefore(newButton, existingButton.nextSibling);

        } else { // If the checkbox is unchecked
            //console.log(event.target.id + ' è stato deselezionato'); // Log deselection
            const number = event.target.id.replace('translateCheck', ''); // Extract the number
            const existingEl = document.getElementById('messageText' + number); // Get the corresponding message textarea
            document.getElementById('ENGcontroller' + number).remove();
            if (existingEl) {
                // Restore the rows attribute of the textarea to 5
                existingEl.setAttribute('rows', '5');
                const textarea = document.getElementById('ENGmessageText' + number); // Get the translation textarea
                if (textarea) {
                    const div = textarea.parentElement; // Get the parent div of the translation textarea
                    if (div) {
                        div.remove(); // Remove the translation textarea div
                    }
                }
            }
        }
    }
});

document.addEventListener('click', async function (event) {
    const extractNumbers = (str) => {
        const match = str.match(/\d+/);
        return match ? match[0] : null;
    };

    if (event.target.matches('[id^="deleteRow"]') && document.querySelectorAll('[id^="formRow"]').length > 1) {
        const id = extractNumbers(event.target.id);
        const row = document.getElementById('formRow' + id);
        const fileName = document.getElementById('fileName' + id)?.value; // Assicurati di ottenere il valore corretto

        const folderPath = '_temp_' + document.getElementById('ragioneSociale_input').value; // Specifica il percorso della cartella

        if (row) {
            row.remove();

            // Controlla se l'elemento engMessageText esiste
            const engMessageTextElement = document.getElementById('engMessageText' + id);
            const filesToDelete = [fileName + '.mp3'];

            if (engMessageTextElement) {
                // Se l'elemento esiste, aggiungi il file ENG_${fileName}.mp3
                filesToDelete.push('ENG_' + fileName + '.mp3');
            }

            // Invia una richiesta al server per eliminare i file
            try {
                const response = await fetch('/delete-audio', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ files: filesToDelete, folder: folderPath, csrfToken }),
                });

                if (!response.ok) {
                    throw new Error('Errore durante l\'eliminazione dei file');
                }
                //console.log('File audio eliminati con successo.');
            } catch (error) {
                //console.error('Errore:', error);
            }
        }
    }
});



document.getElementById("music").addEventListener('click', function (event) {
    const dropdownItems = document.querySelectorAll('#dropdownMenu .dropdown-item');
    dropdownItems.forEach(item => {
        item.addEventListener('click', function (event) {
            // Ottieni il valore completo dall'attributo 'value'
            const selectedValue = event.target.getAttribute('value');

            // Imposta il valore del bottone con il valore completo
            document.getElementById("music").value = selectedValue;

            // Aggiorna il testo del bottone
            document.getElementById("music").textContent = event.target.textContent;;
        });
    });
});



// Listen for the 'click' event on the 'sendQuery' button
document.getElementById('sendQuery').addEventListener('click', e => {
    showLoader();
    document.getElementById('saveAll').disabled = true;
    const controllers = document.querySelectorAll('[id^="ENGcontroller"], [id^="controller"]');
    controllers.forEach(el => el.disabled = true);
    // Initialize company name variable
    let companyName = "";

    // Check if the company name input is empty
    if (document.getElementById('ragioneSociale_input').value.length > 0) {
        companyName = document.getElementById('ragioneSociale_input').value;
    } else {
        document.getElementById('errorMessage').innerText = 'Ragione sociale richiesta';
        let modal = new bootstrap.Modal(document.getElementById('errorModal'));
        hideLoader();
        modal.show(); // Mostra il modale
        return; // Stop execution if company name is not provided
    }

    // Get the song value, or null if "blank" is selected
    let song = document.getElementById('music').value !== "blank" ? document.getElementById('music').value : null;

    // Select all rows that start with 'formRow'
    const rows = document.querySelectorAll('[id^="formRow"]');
    const data = []; // Array to hold message objects

    // Iterate through each row to collect data
    rows.forEach(row => {
        const fileName = row.querySelector('[id^="fileName"]').value.trim(); // Trim whitespace
        const messageText = row.querySelector('[id^="messageText"]').value.trim(); // Trim whitespace
        const engMessageText = row.querySelector('[id^="ENGmessageText"]'); // Get the English message text
        const playButtonId = row.querySelector('[id^="controller"]').id;
        // Check if fileName and messageText are valid before pushing to data array
        if (fileName && messageText && (!engMessageText || engMessageText.value.trim() !== '')) {
            const rowData = {
                fileName: fileName,
                messageText: messageText,
                engMessageText: engMessageText ? engMessageText.value.trim() : null, // Trim if it exists
                playButtonId: playButtonId
            };

            data.push(rowData); // Add the object to the data array
        } else {
            document.getElementById('errorMessage').innerText = 'Compila tutti i campi poi premi invio';
            let modal = new bootstrap.Modal(document.getElementById('errorModal'));
            hideLoader();
            modal.show(); // Mostra il modale
            throw new Error('Validation error: File name or message text is missing in a row.'); // Throw an error
        }
    });

    // Construct the query object to send to the server
    const query = {
        companyName,
        song,
        data
    };

    // Send the query object to the server using fetch
    fetch('/api/synthesize', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...query, csrfToken })
    })
        .then(response => {
            if (!response.ok) {
                const controllers = document.querySelectorAll('[id^="ENGcontroller"], [id^="controller"]');
                controllers.forEach(el => el.disabled = true);
                throw new Error('Network response was not ok ' + response.statusText); // Throw an error for bad responses

            }
            return response.json(); // Parse JSON response
        })
        .then(data => {
            //console.log(data.message); // Handle successful response
            hideLoader();
            const controllers = document.querySelectorAll('[id^="ENGcontroller"], [id^="controller"]');
            controllers.forEach(el => el.disabled = false);
            document.getElementById('saveAll').disabled = false;

        })
        .catch(error => {
            console.error('Error:', error); // Handle any errors during fetch
            document.getElementById('errorMessage').innerText = 'Si è verificato un errore, riprova'; // Imposta il messaggio di errore
            let modal = new bootstrap.Modal(document.getElementById('errorModal'));
            hideLoader();
            modal.show(); // Mostra il modale
        });
});

const audioPlayer = document.getElementById('audioPlayer');

container.addEventListener('click', async (e) => {
    // Check if the clicked element matches your controllers
    if (e.target.matches('[id^="ENGcontroller"], [id^="controller"]')) {
        e.preventDefault();
        const folderName = '_temp_' + document.getElementById('ragioneSociale_input').value;
        const controllerName = e.target.id;

        try {
            //console.log(`Fetching from: /play/${encodeURIComponent(folderName)}/${encodeURIComponent(controllerName)}`);

            const response = await fetch(`/play/${encodeURIComponent(folderName)}/${encodeURIComponent(controllerName)}`);
            if (response.ok) {
                const data = await response.json();
                // If audio is already playing, stop it first
                if (!audioPlayer.paused) {
                    audioPlayer.pause();
                }
                // Set the new audio source and start playing
                audioPlayer.src = `/${folderName}/${data.audioUrl.split('/').pop()}`; // Ensure the URL is correct
                audioPlayer.load(); // Load the new file
                audioPlayer.play();
            } else {
                document.getElementById('errorMessage').innerText = 'Canzone non trovata'; // Imposta il messaggio di errore
                let modal = new bootstrap.Modal(document.getElementById('errorModal'));
                hideLoader();
                modal.show(); // Mostra il modale
            }
        } catch (error) {
            console.error('Errore durante la richiesta:', error);
            document.getElementById('errorMessage').innerText = 'Si è verificato un errore'; // Imposta il messaggio di errore
            let modal = new bootstrap.Modal(document.getElementById('errorModal'));
            hideLoader();
            modal.show(); // Mostra il modale
        }
    }
});

container.addEventListener('input', e => {

    if (e.target.matches('[id^="ENGmessageText"]')) {
        let selector = e.target.id.match(/\d+/);
        document.getElementById('ENGcontroller' + selector).disabled = true;

    } if (e.target.matches('[id^="messageText"]')) {
        let selector = e.target.id.match(/\d+/);
        document.getElementById('controller' + selector).disabled = true;
    }
});

document.getElementById('ragioneSociale_input').addEventListener('input', e => {
    document.querySelectorAll('[id^="controller"], [id^="ENGcontroller"]').forEach(el => {
        el.disabled = true; // Disabilita gli elementi
    });
});


document.getElementById('ragioneSociale_input').addEventListener('keypress', function (event) {
    if (event.key === 'Enter') {
        event.preventDefault(); // Impedisce il ritorno a capo
    }
});

// Aggiungi un event listener per ogni textarea
document.addEventListener('change', (event) => {
    document.getElementById('saveAll').disabled = true;
});


document.getElementById('saveAll').addEventListener('click', async (e) => {
    e.preventDefault(); // Prevenire il comportamento predefinito del pulsante (se necessario)
    showLoader();
    const folderName = document.getElementById('ragioneSociale_input').value.trim();
    const backgroundSong = document.getElementById('music').value !== "blank" ? document.getElementById('music').value : null;

    if (!folderName) {
        document.getElementById('errorMessage').innerText = 'Genera nuovamente i messaggi per proseguire';
        let modal = new bootstrap.Modal(document.getElementById('errorModal'));
        hideLoader();
        modal.show(); // Mostra il modale
        return;
    }

    try {
        const response = await fetch('/api/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ folderName, backgroundSong, csrfToken }), // Send data as JSON
        });

        if (!response.ok) {
            const errorData = await response.text(); // Get the error response as text
            throw new Error(errorData || 'Errore nella richiesta.'); // Handle errors
        }

        // Create a blob from the response
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        // Create a link element
        const a = document.createElement('a');
        a.href = url;
        a.download = `${folderName}.zip`; // Set the file name for download
        document.body.appendChild(a); // Append to the body
        a.click(); // Programmatically click the link to trigger the download
        a.remove(); // Remove the link after downloading
        window.URL.revokeObjectURL(url); // Clean up the URL object 
        hideLoader();

    } catch (error) {
        document.getElementById('errorMessage').innerText = `Genera nuovamente i messaggi per proseguire`;
        let modal = new bootstrap.Modal(document.getElementById('errorModal'));
        hideLoader();
        modal.show(); // Mostra il modale
    }
});


//no duplicate fileName
function checkTextareaValue(event) {
    const currentValue = event.target.value;
    const textareas = document.querySelectorAll('textarea[id^="fileName"]');
    let duplicateFound = false;
    let suffix = 1;
    let newValue = currentValue;

    textareas.forEach(textarea => {
        if (textarea !== event.target && textarea.value === currentValue) {
            duplicateFound = true;
        }
    });

    while (duplicateFound) {
        newValue = `${currentValue}(${suffix})`;
        suffix++;
        duplicateFound = false;
        textareas.forEach(textarea => {
            if (textarea !== event.target && textarea.value === newValue) {
                duplicateFound = true;
            }
        });
    }

    event.target.value = newValue;
}


// Aggiungi un event listener all'elemento genitore
container.addEventListener('focusout', function (event) {
    if (event.target.matches('textarea[id^="fileName"]') && event.target.value != "") {
        event.target.value = event.target.value.charAt(0).toUpperCase() + event.target.value.slice(1);
        checkTextareaValue(event);
    }
});


//chage focus with TAB
document.addEventListener('keydown', function (event) {
    const textareas = document.querySelectorAll('textarea');
    if (event.key === 'Tab') {
        event.preventDefault(); // Previene il comportamento predefinito del tasto TAB

        // Trova l'indice dell'elemento attualmente a fuoco
        const focusedElement = document.activeElement;
        const index = Array.prototype.indexOf.call(textareas, focusedElement);

        // Calcola il prossimo indice
        let nextIndex = (index + 1) % textareas.length; // Torna all'inizio se siamo all'ultimo

        // Imposta il focus sul prossimo textarea
        textareas[nextIndex].focus();
    }
});


function handleKeyDown(event) {
    const key = event.key.toLowerCase();
    const items = document.getElementById('dropdownMenu').getElementsByTagName('li');
    console.log(items)
    for (let i = 0; i < items.length; i++) {
        if (items[i].innerText.toLowerCase().startsWith(key)) {
            ; // Imposta il focus sull'elemento corrispondente
            document.getElementById('music').innerText = items[i].innerText;
            document.getElementById('dropdownMenu').scrollIntoView({ behavior: "instant", block: "start" });
            break; // Esci dal ciclo dopo aver trovato il primo elemento corrispondente
        }
    }

}

document.getElementById('music').addEventListener('focus', function () {
    document.addEventListener('keydown', handleKeyDown);

});

document.getElementById('music').addEventListener('blur', function () {
    document.removeEventListener('keydown', handleKeyDown);
});

function checkTextareaInput(element) {
    const alertToastBody = document.getElementById('alertToastBody');
    const alertToast = document.getElementById('alertToast');
    const toast = new bootstrap.Toast(alertToast, {
        delay: 3000 // Imposta il tempo di visualizzazione a 2000 millisecondi (2 secondi)
    });

    // Seleziona tutte le textarea con nome che corrisponde al pattern
    const invalidChars = /[<>&]/; // Caratteri non validi
    let hasInvalidChars = false;

    // Controlla se l'elemento corrente ha caratteri non validi
    if (invalidChars.test(element.value)) {
        hasInvalidChars = true;
        // Evidenzia il textarea in rosso
        element.style.borderColor = 'red';
        alertToastBody.innerHTML = "<p>I caratteri <b>&<></b> non sono ammessi</p>";

        // Controlla se il toast è già visibile
        if (!alertToast.classList.contains('show')) {
            toast.show();
        }
    } else {
        // Ripristina il colore del bordo se non ci sono caratteri non validi
        element.style.borderColor = '';
    }

    // Disabilita o abilita il bottone #sendQuery
    const sendButton = document.getElementById('sendQuery');
    
    // Verifica tutti i campi textarea per caratteri non validi
    const textareas = document.querySelectorAll('textarea[id^="ENGmessageText"], textarea[id^="messageText"]');
    hasInvalidChars = Array.from(textareas).some(textarea => invalidChars.test(textarea.value));

    sendButton.disabled = hasInvalidChars;
}

// Aggiungi l'event listener per il container
container.addEventListener('input', e => {
    if (e.target.matches('[id^="ENGmessageText"]') || e.target.matches('[id^="messageText"]')) {
        checkTextareaInput(e.target);
    }
});
