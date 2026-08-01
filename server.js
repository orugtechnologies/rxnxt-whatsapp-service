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
app.use(express.json({ limit: '10mb' }));

// Multi-Tenant state tracking
const clients = new Map();
const clientStatus = new Map(); // clinicId -> { isConnected: boolean, latestQR: string | null }

function getClientStatus(clinicId) {
    if (!clientStatus.has(clinicId)) {
        clientStatus.set(clinicId, { isConnected: false, latestQR: null });
    }
    return clientStatus.get(clinicId);
}

function getOrCreateClient(clinicId = 'default') {
    if (clients.has(clinicId)) {
        return clients.get(clinicId);
    }

    console.log(`[Multi-Tenant] Initializing WhatsApp Client for clinic: ${clinicId}`);
    const status = getClientStatus(clinicId);

    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: clinicId,
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

    client.on('qr', (qr) => {
        console.log(`[Clinic: ${clinicId}] QR Code received, waiting for scan...`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[Clinic: ${clinicId}] Error generating QR Data URL`, err);
                return;
            }
            status.latestQR = url;
            status.isConnected = false;
        });
    });

    client.on('ready', () => {
        console.log(`[Clinic: ${clinicId}] Client is ready!`);
        status.isConnected = true;
        status.latestQR = null;
    });

    client.on('disconnected', (reason) => {
        console.log(`[Clinic: ${clinicId}] Client logged out:`, reason);
        status.isConnected = false;
        status.latestQR = null;
        clients.delete(clinicId);
        client.destroy().catch(console.error);
    });

    clients.set(clinicId, client);
    client.initialize().catch(err => {
        console.error(`[Clinic: ${clinicId}] Failed to initialize:`, err);
    });

    return client;
}

// API ROUTES

// 1. Get current QR Code or Status for a specific clinic
app.get('/api/whatsapp/status', (req, res) => {
    const clinicId = req.query.clinicId || 'default';
    
    // Ensure client instance exists
    getOrCreateClient(clinicId);
    const status = getClientStatus(clinicId);

    if (status.isConnected) {
        return res.json({ status: 'connected', qr: null, clinicId });
    } else if (status.latestQR) {
        return res.json({ status: 'waiting_for_scan', qr: status.latestQR, clinicId });
    } else {
        return res.json({ status: 'initializing', qr: null, clinicId });
    }
});

// 2. Send a WhatsApp Message for a specific clinic
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { phone, message, pdfBase64, clinicId = 'default' } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }

        const client = getOrCreateClient(clinicId);
        const status = getClientStatus(clinicId);

        if (!status.isConnected) {
            return res.status(503).json({ error: `WhatsApp is not connected yet for clinic ${clinicId}` });
        }

        let cleanPhone = phone.replace(/[^\d]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
        
        const chatId = `${cleanPhone}@c.us`;

        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(400).json({ error: `Phone number ${cleanPhone} is not registered on WhatsApp` });
        }

        let response;
        if (pdfBase64) {
            const media = new MessageMedia('application/pdf', pdfBase64, 'Prescription.pdf');
            response = await client.sendMessage(chatId, media, { caption: message });
        } else {
            response = await client.sendMessage(chatId, message);
        }

        const messageId = (response && response.id) ? (response.id._serialized || response.id.id) : 'unknown';
        console.log(`[Clinic: ${clinicId}] Message sent to ${chatId}: ${messageId}`);

        res.json({ success: true, messageId, clinicId });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Multi-Tenant WhatsApp Microservice running on port ${PORT}`);
});
