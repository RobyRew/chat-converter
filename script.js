document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed.');

    const chatFileInput = document.getElementById('chatFile');
    const sourcePlatformSelect = document.getElementById('sourcePlatform');
    const destPlatformSelect = document.getElementById('destPlatform');
    const convertBtn = document.getElementById('convertBtn');
    const status = document.getElementById('status');

    console.log('Elements initialized:', {
        chatFileInput: chatFileInput,
        sourcePlatformSelect: sourcePlatformSelect,
        destPlatformSelect: destPlatformSelect,
        convertBtn: convertBtn,
        status: status
    });

    chatFileInput.addEventListener('change', () => {
        console.log('File input changed. Files:', chatFileInput.files);
        convertBtn.disabled = !chatFileInput.files.length;
        console.log('Convert button disabled:', convertBtn.disabled);
        status.textContent = '';
        console.log('Status cleared.');
    });

    convertBtn.addEventListener('click', async () => {
        console.log('Convert button clicked.');

        const file = chatFileInput.files[0];
        console.log('Selected file:', file);

        if (!file) {
            console.error('No file selected.');
            status.textContent = 'Please upload a .zip file.';
            status.className = 'status error';
            return;
        }

        const sourcePlatform = sourcePlatformSelect.value;
        const destPlatform = destPlatformSelect.value;
        console.log('Source platform:', sourcePlatform, 'Destination platform:', destPlatform);

        if (sourcePlatform === destPlatform) {
            console.error('Source and destination platforms are the same:', sourcePlatform);
            status.textContent = 'Source and destination platforms must be different.';
            status.className = 'status error';
            return;
        }

        status.textContent = 'Processing...';
        status.className = 'status';
        console.log('Processing started.');

        try {
            console.log('Loading ZIP file...');
            const zip = await JSZip.loadAsync(file);
            console.log('ZIP file loaded. Files in ZIP:', Object.keys(zip.files));

            const convertedZip = new JSZip();
            console.log('Created new JSZip instance for output.');

            let chatFileContent;
            let chatFileName;
            console.log('Searching for chat file in ZIP...');
            for (const fileName in zip.files) {
                console.log('Checking file:', fileName);
                if (fileName.endsWith('_chat.txt') && sourcePlatform === 'whatsapp') {
                    console.log('Found WhatsApp chat file:', fileName);
                    chatFileContent = await zip.files[fileName].async('string');
                    chatFileName = fileName;
                    break;
                } else if (fileName.endsWith('result.json') && sourcePlatform === 'telegram') {
                    console.log('Found Telegram chat file:', fileName);
                    chatFileContent = await zip.files[fileName].async('string');
                    chatFileName = fileName;
                    break;
                }
            }

            if (!chatFileContent) {
                console.error('Chat file not found in the ZIP. Expected _chat.txt for WhatsApp or result.json for Telegram.');
                throw new Error('Chat file not found in the .zip.');
            }

            console.log('Chat file content loaded:', chatFileContent.slice(0, 200), '...');

            let convertedContent;
            if (sourcePlatform === 'whatsapp' && destPlatform === 'telegram') {
                console.log('Starting WhatsApp to Telegram conversion...');
                console.log('Parsing WhatsApp chat...');
                const messages = parseWhatsAppChat(chatFileContent);
                console.log('Parsed messages from WhatsApp:', messages);
                console.log('Converting to Telegram format...');
                convertedContent = convertToTelegramFormat(messages);
                console.log('Converted content for Telegram:', convertedContent);
                console.log('Adding converted content to new ZIP as result.json...');
                convertedZip.file('result.json', JSON.stringify(convertedContent, null, 2));
                console.log('result.json added to ZIP.');
            } else if (sourcePlatform === 'telegram' && destPlatform === 'whatsapp') {
                console.log('Starting Telegram to WhatsApp conversion...');
                console.log('Parsing Telegram chat...');
                const messages = parseTelegramChat(chatFileContent);
                console.log('Parsed messages from Telegram:', messages);
                console.log('Converting to WhatsApp format...');
                convertedContent = convertToWhatsAppFormat(messages);
                console.log('Converted content for WhatsApp:', convertedContent.slice(0, 200), '...');
                console.log('Adding converted content to new ZIP as _chat.txt...');
                convertedZip.file('_chat.txt', convertedContent);
                console.log('_chat.txt added to ZIP.');
            } else {
                console.error('Unsupported conversion:', sourcePlatform, 'to', destPlatform);
                throw new Error('Unsupported conversion.');
            }

            console.log('Copying other files to new ZIP...');
            for (const fileName in zip.files) {
                if (fileName !== chatFileName) {
                    console.log('Copying file:', fileName);
                    const fileContent = await zip.files[fileName].async('uint8array');
                    convertedZip.file(fileName, fileContent);
                    console.log('File copied:', fileName);
                }
            }

            console.log('Generating new ZIP file...');
            const zipBlob = await convertedZip.generateAsync({ type: 'blob' });
            console.log('ZIP blob generated:', zipBlob);
            console.log('Triggering download...');
            saveAs(zipBlob, `converted_chat_${destPlatform}.zip`);
            console.log('Download triggered.');

            status.textContent = 'Conversion successful! File downloaded.';
            status.className = 'status success';
            console.log('Conversion successful.');
        } catch (error) {
            console.error('Error during conversion:', error);
            status.textContent = `Error: ${error.message}`;
            status.className = 'status error';
        }
    });

    function parseWhatsAppChat(content) {
        console.log('parseWhatsAppChat called. Content length:', content.length);
        const messages = [];
        const lines = content.split('\n');
        console.log('Split content into lines:', lines.length, 'lines');
        let currentMessage = null;

        const messageRegex = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}:\d{2})\] (.*?): (.*)$/;
        console.log('Message regex:', messageRegex);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            console.log(`Processing line ${i + 1}:`, line);

            const match = line.match(messageRegex);
            if (match) {
                console.log('Line matches message regex:', match);
                if (currentMessage) {
                    console.log('Pushing previous message to array:', currentMessage);
                    messages.push(currentMessage);
                }
                const [, date, time, from, text] = match;
                console.log('Extracted message parts - Date:', date, 'Time:', time, 'From:', from, 'Text:', text);
                const dateTime = parseWhatsAppDateTime(date, time);
                console.log('Parsed dateTime:', dateTime);
                currentMessage = {
                    date: dateTime.toISOString(),
                    from,
                    text,
                    attachments: []
                };
                console.log('Created new currentMessage:', currentMessage);
            } else if (line.includes('‎<attached: ')) {
                console.log('Line contains attachment:', line);
                if (currentMessage) {
                    const attachmentMatch = line.match(/‎<attached: (.*?)>/);
                    if (attachmentMatch) {
                        console.log('Attachment found:', attachmentMatch[1]);
                        currentMessage.attachments.push(attachmentMatch[1]);
                        console.log('Updated currentMessage with attachment:', currentMessage);
                    } else {
                        console.warn('Attachment line did not match regex:', line);
                    }
                } else {
                    console.warn('Attachment found but no current message:', line);
                }
            } else if (currentMessage) {
                console.log('Appending line to current message text:', line);
                currentMessage.text += '\n' + line.trim();
                console.log('Updated currentMessage:', currentMessage);
            } else {
                console.log('Line does not match message or attachment, and no current message:', line);
            }
        }

        if (currentMessage) {
            console.log('Pushing final message to array:', currentMessage);
            messages.push(currentMessage);
        }

        console.log('Parsed messages:', messages);
        return messages;
    }

    function parseWhatsAppDateTime(date, time) {
        console.log('parseWhatsAppDateTime called. Date:', date, 'Time:', time);
        const [day, month, year] = date.split('/');
        console.log('Split date - Day:', day, 'Month:', month, 'Year:', year);
        const fullYear = year.length === 2 ? `20${year}` : year;
        console.log('Full year:', fullYear);

        // Pad month and day with leading zeros if single digits
        const paddedMonth = month.padStart(2, '0');
        const paddedDay = day.padStart(2, '0');
        console.log('Padded month:', paddedMonth, 'Padded day:', paddedDay);

        const dateString = `${fullYear}-${paddedMonth}-${paddedDay}T${time}Z`;
        console.log('Constructed date string:', dateString);
        const parsedDate = new Date(dateString);
        console.log('Parsed date:', parsedDate);
        if (isNaN(parsedDate.getTime())) {
            console.error('Invalid date parsed:', dateString);
            throw new Error('Invalid date format in WhatsApp chat.');
        }
        return parsedDate;
    }

    function parseTelegramChat(content) {
        console.log('parseTelegramChat called. Content length:', content.length);
        const data = JSON.parse(content);
        console.log('Parsed JSON data:', data);
        const messages = data.messages.map((msg, index) => {
            console.log(`Processing Telegram message ${index + 1}:`, msg);
            const message = {
                date: msg.date,
                from: msg.from || 'Unknown',
                text: msg.text_entities ? msg.text_entities.map(entity => entity.text).join('') : msg.text || '',
                attachments: msg.photo ? [msg.photo] : (msg.file ? [msg.file] : [])
            };
            console.log('Parsed Telegram message:', message);
            return message;
        });
        console.log('All parsed Telegram messages:', messages);
        return messages;
    }

    function convertToTelegramFormat(messages) {
        console.log('convertToTelegramFormat called. Messages:', messages);
        const telegramMessages = messages.map((msg, index) => {
            console.log(`Converting message ${index + 1}:`, msg);
            const date = new Date(msg.date);
            console.log('Message date:', date);
            if (isNaN(date.getTime())) {
                console.error('Invalid date in message:', msg);
                throw new Error('Invalid date in message during conversion to Telegram format.');
            }
            const unixTime = Math.floor(date.getTime() / 1000).toString();
            console.log('Unix time:', unixTime);
            const textEntities = msg.text ? [{ type: 'plain', text: msg.text }] : [];

            const telegramMsg = {
                id: index + 1,
                type: 'message',
                date: date.toISOString(),
                date_unixtime: unixTime,
                from: msg.from,
                from_id: `user${Math.floor(Math.random() * 1000000000)}`,
                text: msg.text || '',
                text_entities: textEntities
            };
            console.log('Constructed Telegram message:', telegramMsg);

            if (msg.attachments.length > 0) {
                console.log('Processing attachments for message:', msg.attachments);
                msg.attachments.forEach(attachment => {
                    console.log('Attachment:', attachment);
                    if (attachment.endsWith('.jpg') || attachment.endsWith('.jpeg')) {
                        telegramMsg.photo = attachment;
                        console.log('Added photo to Telegram message:', telegramMsg.photo);
                    } else if (attachment.endsWith('.mp4')) {
                        telegramMsg.file = attachment;
                        telegramMsg.media_type = 'video_file';
                        console.log('Added video file to Telegram message:', telegramMsg.file);
                    } else {
                        console.warn('Unsupported attachment type:', attachment);
                    }
                });
            }

            console.log('Final Telegram message:', telegramMsg);
            return telegramMsg;
        });

        const telegramOutput = {
            name: null,
            type: 'personal_chat',
            id: Math.floor(Math.random() * 1000000000),
            messages: telegramMessages
        };
        console.log('Final Telegram output:', telegramOutput);
        return telegramOutput;
    }

    function convertToWhatsAppFormat(messages) {
        console.log('convertToWhatsAppFormat called. Messages:', messages);
        let output = '';
        messages.forEach((msg, index) => {
            console.log(`Converting message ${index + 1}:`, msg);
            const date = new Date(msg.date);
            console.log('Message date:', date);
            const formattedDate = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear().toString().slice(-2)}`;
            const formattedTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
            console.log('Formatted date:', formattedDate, 'Formatted time:', formattedTime);
            output += `[${formattedDate}, ${formattedTime}] ${msg.from}: ${msg.text}\n`;
            console.log('Added message to output:', output.slice(-100));

            if (msg.attachments.length > 0) {
                console.log('Processing attachments:', msg.attachments);
                msg.attachments.forEach(attachment => {
                    console.log('Attachment:', attachment);
                    output += `‎<attached: ${attachment}>\n`;
                    console.log('Added attachment to output:', output.slice(-100));
                });
            }
        });
        console.log('Final WhatsApp output:', output.slice(0, 200), '...');
        return output;
    }
});