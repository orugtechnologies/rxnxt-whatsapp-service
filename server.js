const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');

const logger = pino({ level: 'silent' });

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize database schema for session persistence
pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions_v2 (
        clinic_id VARCHAR(255) PRIMARY KEY,
        session_data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`).catch(err => console.error('[DB Setup Error]', err));

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Multi-Tenant state tracking maps
const sockets = new Map(); // clinicId -> WASocket
const clientStatus = new Map(); // clinicId -> { isConnected: boolean, latestQR: string | null }

function getClientStatus(clinicId) {
    if (!clientStatus.has(clinicId)) {
        clientStatus.set(clinicId, { isConnected: false, latestQR: null });
    }
    return clientStatus.get(clinicId);
}

// Ensure session directory exists
async function getOrCreateBaileysSocket(clinicId = 'default') {
    if (sockets.has(clinicId)) {
        return sockets.get(clinicId);
    }

    console.log(`[Baileys Engine] Initializing WhatsApp session for clinic: ${clinicId}`);
    const status = getClientStatus(clinicId);

    const sessionDir = path.join(__dirname, `sessions_${clinicId}`);
    await fs.ensureDir(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
    });

    sockets.set(clinicId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[Clinic: ${clinicId}] Fresh QR Code generated.`);
            try {
                const qrUrl = await qrcode.toDataURL(qr);
                status.latestQR = qrUrl;
                status.isConnected = false;
            } catch (err) {
                console.error(`[Clinic: ${clinicId}] QR Generation Error:`, err);
            }
        }

        if (connection === 'open') {
            console.log(`[Clinic: ${clinicId}] ✅ WhatsApp Connected & Ready!`);
            status.isConnected = true;
            status.latestQR = null;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[Clinic: ${clinicId}] Connection closed (Reason code: ${statusCode}). Reconnect: ${shouldReconnect}`);
            status.isConnected = false;
            status.latestQR = null;
            sockets.delete(clinicId);

            if (shouldReconnect) {
                await delay(3000);
                getOrCreateBaileysSocket(clinicId).catch(console.error);
            } else {
                console.log(`[Clinic: ${clinicId}] Logged out. Cleaning session data.`);
                await fs.remove(sessionDir).catch(() => {});
            }
        }
    });

    return sock;
}

// API ROUTES

// 1. Get WhatsApp Status or QR Code for clinic
app.get('/api/whatsapp/status', async (req, res) => {
    const clinicId = req.query.clinicId || 'default';
    
    try {
        await getOrCreateBaileysSocket(clinicId);
        const status = getClientStatus(clinicId);

        if (status.isConnected) {
            return res.json({ status: 'connected', qr: null, clinicId });
        } else if (status.latestQR) {
            return res.json({ status: 'waiting_for_scan', qr: status.latestQR, clinicId });
        } else {
            return res.json({ status: 'initializing', qr: null, clinicId });
        }
    } catch (err) {
        console.error(`[Clinic: ${clinicId}] Status Error:`, err);
        return res.status(500).json({ error: err.message, clinicId });
    }
});

// 2. Send WhatsApp Message (Text or PDF Attachment)
app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { phone, message, pdfBase64, clinicId = 'default' } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }

        const sock = await getOrCreateBaileysSocket(clinicId);
        const status = getClientStatus(clinicId);

        if (!status.isConnected) {
            return res.status(530).json({ error: `WhatsApp is not connected yet for clinic ${clinicId}` });
        }

        let cleanPhone = phone.replace(/[^\d]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
        
        const recipientJid = `${cleanPhone}@s.whatsapp.net`;

        let response;
        if (pdfBase64) {
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            response = await sock.sendMessage(recipientJid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: 'RxNXT_Prescription.pdf',
                caption: message
            });
        } else {
            response = await sock.sendMessage(recipientJid, { text: message });
        }

        const messageId = response?.key?.id || 'sent';
        console.log(`[Clinic: ${clinicId}] Baileys Message sent to ${recipientJid}: ${messageId}`);

        res.json({ success: true, messageId, clinicId });
    } catch (error) {
        console.error('[Baileys Send Error]:', error);
        res.status(500).json({ error: 'Failed to send WhatsApp message', details: error.message });
    }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', engine: 'Baileys Multi-Device v6' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 RxNXT Baileys WhatsApp Engine running on port ${PORT}`);
});
