require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SERVER_SECRET || 'logdrk_secret';
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';

app.use(cors());
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCode = null;

const AUTH_FOLDER = path.join(__dirname, 'auth_info');

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      console.log('\n📱 QR CODE GERADO — escaneie pelo WhatsApp no celular!');
    }

    if (connection === 'close') {
      isConnected = false;
      qrCode = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('⚠️ Conexão encerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      } else {
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true });
        }
        setTimeout(connectWhatsApp, 3000);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      qrCode = null;
      console.log('✅ WhatsApp conectado com sucesso!');
      console.log(`📋 Grupo configurado: ${GROUP_ID || '⚠️ não configurado'}`);
    }
  });
}

async function sendToGroup(message) {
  if (!isConnected || !sock) throw new Error('WhatsApp não conectado');
  if (!GROUP_ID) throw new Error('WHATSAPP_GROUP_ID não configurado');
  await sock.sendMessage(GROUP_ID, { text: message });
}

connectWhatsApp().catch(console.error);

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Log DRK Server',
    version: '2.0.0',
    whatsapp: isConnected ? 'conectado' : (qrCode ? 'aguardando_qr' : 'desconectado'),
    timestamp: new Date().toISOString()
  });
});

app.get('/qr', (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (isConnected) return res.json({ ok: true, status: 'conectado', message: 'WhatsApp já está conectado!' });
  if (!qrCode) return res.json({ ok: false, status: 'aguardando', message: 'QR Code ainda não gerado. Aguarde e tente novamente.' });
  res.json({ ok: true, status: 'qr_disponivel', qr: qrCode });
});

app.get('/status', (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  res.json({ ok: true, connected: isConnected, qrPending: !!qrCode, groupId: GROUP_ID || 'não configurado' });
});

app.post('/send-status', async (req, res) => {
  const { secret, username, message } = req.body;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (!username || !message) return res.status(400).json({ ok: false, error: 'username e message são obrigatórios' });
  try {
    await sendToGroup(message);
    console.log(`[${new Date().toISOString()}] ✅ Status enviado | Motorista: ${username}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Erro | Motorista: ${username} |`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-programacao', async (req, res) => {
  const { secret, message } = req.body;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (!message) return res.status(400).json({ ok: false, error: 'message é obrigatória' });
  try {
    await sendToGroup(message);
    console.log(`[${new Date().toISOString()}] ✅ Programação enviada`);
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Erro programação |`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/instances', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  res.json({ ok: true, instances: [{ username: 'adm', connected: isConnected }], groupId: GROUP_ID || 'não configurado' });
});

app.get('/check-instance/:username', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  res.json({ ok: true, connected: isConnected });
});

app.listen(PORT, () => {
  console.log(`\n🚛 Log DRK Server v2.0 rodando na porta ${PORT}`);
});
