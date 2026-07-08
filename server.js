const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

let latestQR = null;
let isConnected = false;

// Initialize WhatsApp Client with LocalAuth to persist session across restarts
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: process.env.RENDER ? '/usr/bin/google-chrome' : undefined,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

// Generate QR Code
client.on('qr', (qr) => {
    console.log('QR Code received, waiting for scan...');
    // Convert raw QR string to base64 Data URL so the frontend can easily display it in an <img> tag
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR Data URL', err);
            return;
        }
        latestQR = url;
    });
});

// Client is ready and connected
client.on('ready', () => {
    console.log('Client is ready!');
    isConnected = true;
    latestQR = null; // Clear QR once connected
});

// Client is disconnected
client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    isConnected = false;
    // Destroy and re-initialize client to generate a new QR code
    client.destroy();
    client.initialize();
});

// Initialize the client on startup
client.initialize();

// API ROUTES

// 1. Get the current QR Code or Status
app.get('/api/whatsapp/status', (req, res) => {
    if (isConnected) {
        return res.json({ status: 'connected', qr: null });
    } else if (latestQR) {
        return res.json({ status: 'waiting_for_scan', qr: latestQR });
    } else {
        return res.json({ status: 'initializing', qr: null });
    }
});

// 2. Send a WhatsApp Message
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }

        if (!isConnected) {
            return res.status(503).json({ error: 'WhatsApp is not connected yet' });
        }

        // Format phone number to WhatsApp format (e.g., 919876543210@c.us)
        // Strip everything except digits
        let cleanPhone = phone.replace(/[^\d]/g, '');
        // Default to India (+91) if 10 digits
        if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
        
        const chatId = `${cleanPhone}@c.us`;

        const response = await client.sendMessage(chatId, message);
        console.log(`Message sent to ${chatId}: ${response.id.id}`);

        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`WhatsApp Microservice running on http://localhost:${PORT}`);
    console.log(`Waiting for WhatsApp client to initialize...`);
});
