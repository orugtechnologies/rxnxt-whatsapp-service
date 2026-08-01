const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        session_data BYTEA NOT NULL
    )
`).catch(console.error);

class PostgresStore {
    constructor(pool) {
        this.pool = pool;
    }

    async sessionExists({ session }) {
        const res = await this.pool.query('SELECT session_id FROM whatsapp_sessions WHERE session_id = $1', [session]);
        return res.rows.length > 0;
    }

    async save({ session, path }) {
        try {
            const data = fs.readFileSync(path);
            await this.pool.query(
                `INSERT INTO whatsapp_sessions (session_id, session_data) VALUES ($1, $2)
                 ON CONFLICT (session_id) DO UPDATE SET session_data = EXCLUDED.session_data`,
                [session, data]
            );
        } catch (error) {
            console.error('PostgresStore save error:', error);
        }
    }

    async extract({ session, path }) {
        try {
            const res = await this.pool.query('SELECT session_data FROM whatsapp_sessions WHERE session_id = $1', [session]);
            if (res.rows.length > 0) {
                fs.writeFileSync(path, res.rows[0].session_data);
            }
        } catch (error) {
            console.error('PostgresStore extract error:', error);
        }
    }

    async delete({ session }) {
        try {
            await this.pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [session]);
        } catch (error) {
            console.error('PostgresStore delete error:', error);
        }
    }
}

const app = express();
app.use(cors());
app.use(express.json());

let latestQR = null;
let isConnected = false;

// Initialize WhatsApp Client with RemoteAuth to persist session in PostgreSQL
const client = new Client({
    authStrategy: new RemoteAuth({
        store: new PostgresStore(pool),
        backupSyncIntervalMs: 300000
    }),
    puppeteer: {
        executablePath: '/usr/bin/chromium',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--single-process',
            '--js-flags="--max-old-space-size=250"'
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
        const { phone, message, pdfBase64 } = req.body;

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

        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(400).json({ error: `Phone number ${cleanPhone} is not registered on WhatsApp` });
        }

        let response;
        if (pdfBase64) {
            // Send as a document attachment with the message as a caption
            const media = new MessageMedia('application/pdf', pdfBase64, 'Prescription.pdf');
            response = await client.sendMessage(chatId, media, { caption: message });
        } else {
            // Send plain text message
            response = await client.sendMessage(chatId, message);
        }
        console.log(`Message sent to ${chatId}: ${response.id.id}`);

        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`WhatsApp Microservice running on http://localhost:${PORT}`);
    console.log(`Waiting for WhatsApp client to initialize...`);
});
