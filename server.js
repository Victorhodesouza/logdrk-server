require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SERVER_SECRET || 'logdrk_secret';
const JWT_SECRET = process.env.JWT_SECRET || 'logdrk_jwt_secret_mude_isso';
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const DB_PATH = path.join(__dirname, 'logdrk.db');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ═══════════════════════════════════════
// BANCO DE DADOS SQLite
// ═══════════════════════════════════════
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'driver',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver TEXT NOT NULL,
    username TEXT,
    type TEXT,
    status TEXT,
    mode TEXT DEFAULT 'entrega',
    cliente TEXT,
    placa TEXT,
    nfs TEXT,
    atraso TEXT,
    hr_prog TEXT,
    diff_atraso TEXT,
    motivo TEXT,
    prog_date TEXT,
    prog_msg TEXT,
    date TEXT,
    time TEXT,
    ts TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS programacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    username TEXT NOT NULL,
    tipo TEXT,
    placa TEXT,
    local TEXT,
    hr_chegada TEXT,
    hr_saida TEXT,
    cliente TEXT,
    hr_agendamento TEXT,
    obs TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, username)
  );

  CREATE TABLE IF NOT EXISTS journey (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    date TEXT NOT NULL,
    steps TEXT DEFAULT '[]',
    UNIQUE(username, date)
  );
`);

// Criar ADM padrão se não existir
const admExists = db.prepare('SELECT id FROM users WHERE username = ?').get('adm');
if (!admExists) {
  const hash = bcrypt.hashSync(process.env.ADM_PASSWORD || 'admin123', 10);
  db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run('Administrador', 'adm', hash, 'admin');
  console.log('✅ Usuário ADM criado com senha padrão');
}

// ═══════════════════════════════════════
// MIDDLEWARES
// ═══════════════════════════════════════

// Rate limit para login — máx 5 tentativas por IP em 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit geral — 200 req/min por IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { ok: false, error: 'Limite de requisições excedido.' },
});

app.use(generalLimiter);

// Verificar JWT
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Token não fornecido' });
  }
  try {
    const token = auth.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado' });
  }
}

// Verificar se é ADM
function admMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'Acesso restrito ao administrador' });
  }
  next();
}

// Verificar secret do servidor (retrocompatibilidade com WhatsApp)
function secretMiddleware(req, res, next) {
  const secret = req.headers['x-secret'] || req.body?.secret;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  next();
}

// ═══════════════════════════════════════
// WHATSAPP (sem mudanças)
// ═══════════════════════════════════════
let sock = null;
let isConnected = false;
let qrCode = null;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrCode = qr; console.log('\n📱 QR CODE — escaneie pelo WhatsApp!'); }
    if (connection === 'close') {
      isConnected = false; qrCode = null;
      const should = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (should) setTimeout(connectWhatsApp, 3000);
      else {
        if (fs.existsSync(AUTH_FOLDER)) fs.rmSync(AUTH_FOLDER, { recursive: true });
        setTimeout(connectWhatsApp, 3000);
      }
    }
    if (connection === 'open') {
      isConnected = true; qrCode = null;
      console.log('✅ WhatsApp conectado!');
    }
  });
}

async function sendToGroup(message) {
  if (!isConnected || !sock) throw new Error('WhatsApp não conectado');
  if (!GROUP_ID) throw new Error('WHATSAPP_GROUP_ID não configurado');
  await sock.sendMessage(GROUP_ID, { text: message });
}

connectWhatsApp().catch(console.error);

// ═══════════════════════════════════════
// ROTAS PÚBLICAS
// ═══════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'online', app: 'Log DRK Server', version: '3.0.0',
    whatsapp: isConnected ? 'conectado' : (qrCode ? 'aguardando_qr' : 'desconectado'),
    timestamp: new Date().toISOString()
  });
});

// LOGIN — driver e adm usam a mesma rota
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Usuário e senha são obrigatórios' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user) return res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Usuário ou senha incorretos' });

  const token = jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  console.log(`[${new Date().toISOString()}] ✅ Login | ${user.username} (${user.role})`);
  res.json({ ok: true, token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
});

// ═══════════════════════════════════════
// ROTAS PROTEGIDAS — MOTORISTA
// ═══════════════════════════════════════

// Buscar programação do dia (ou amanhã)
app.get('/programacao/:username', authMiddleware, (req, res) => {
  const { username } = req.params;
  // Motorista só pode ver a própria programação
  if (req.user.role !== 'admin' && req.user.username !== username) {
    return res.status(403).json({ ok: false, error: 'Acesso negado' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const tmw = new Date(); tmw.setDate(tmw.getDate() + 1);
  const tomorrow = tmw.toISOString().slice(0, 10);

  const todayProg = db.prepare('SELECT * FROM programacao WHERE date = ? AND username = ?').get(today, username);
  const tmwProg = db.prepare('SELECT * FROM programacao WHERE date = ? AND username = ?').get(tomorrow, username);

  res.json({ ok: true, today: todayProg || null, tomorrow: tmwProg || null });
});

// Salvar status da jornada
app.post('/status', authMiddleware, async (req, res) => {
  const { message, record } = req.body;
  if (!message || !record) return res.status(400).json({ ok: false, error: 'message e record são obrigatórios' });

  try {
    // Salvar no banco
    db.prepare(`INSERT INTO history
      (driver, username, type, status, mode, cliente, placa, nfs, atraso, hr_prog, diff_atraso, motivo, date, time, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.driver, req.user.username, record.type, record.status,
      record.mode || 'entrega', record.cliente || null, record.placa || null,
      record.nfs || null, record.atraso || null, record.hrProg || null,
      record.diffAtraso || null, record.motivo || null,
      record.date, record.time, record.ts
    );

    // Enviar WhatsApp
    await sendToGroup(message);
    console.log(`[${new Date().toISOString()}] ✅ Status | ${req.user.username} | ${record.status}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Erro /status:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Buscar histórico do motorista
app.get('/history', authMiddleware, (req, res) => {
  const { username, role } = req.user;
  let rows;
  if (role === 'admin') {
    rows = db.prepare('SELECT * FROM history ORDER BY created_at DESC LIMIT 500').all();
  } else {
    rows = db.prepare('SELECT * FROM history WHERE username = ? ORDER BY created_at DESC LIMIT 200').all(username);
  }
  res.json({ ok: true, history: rows });
});

// Salvar/atualizar progresso da jornada
app.post('/journey', authMiddleware, (req, res) => {
  const { date, steps } = req.body;
  const { username } = req.user;
  db.prepare(`INSERT INTO journey (username, date, steps) VALUES (?, ?, ?)
    ON CONFLICT(username, date) DO UPDATE SET steps = excluded.steps`
  ).run(username, date, JSON.stringify(steps));
  res.json({ ok: true });
});

// Buscar progresso da jornada
app.get('/journey/:date', authMiddleware, (req, res) => {
  const { username } = req.user;
  const row = db.prepare('SELECT * FROM journey WHERE username = ? AND date = ?').get(username, req.params.date);
  res.json({ ok: true, steps: row ? JSON.parse(row.steps) : [] });
});

// Alterar própria senha
app.post('/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Campos obrigatórios' });
  if (newPassword.length < 4) return res.status(400).json({ ok: false, error: 'Senha muito curta (mínimo 4 caracteres)' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user.username);
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Senha atual incorreta' });

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, req.user.username);
  res.json({ ok: true, message: 'Senha alterada com sucesso' });
});

// ═══════════════════════════════════════
// ROTAS ADM
// ═══════════════════════════════════════

// Listar motoristas
app.get('/admin/users', authMiddleware, admMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, username, role, created_at FROM users WHERE role != ?').all('admin');
  res.json({ ok: true, users });
});

// Criar motorista
app.post('/admin/users', authMiddleware, admMiddleware, async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ ok: false, error: 'Campos obrigatórios' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (exists) return res.status(400).json({ ok: false, error: 'Usuário já existe' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)').run(name, username.toLowerCase().trim(), hash, 'driver');
  res.json({ ok: true, message: 'Motorista criado com sucesso' });
});

// Atualizar motorista
app.put('/admin/users/:username', authMiddleware, admMiddleware, async (req, res) => {
  const { name, password } = req.body;
  const { username } = req.params;
  if (name) db.prepare('UPDATE users SET name = ? WHERE username = ?').run(name, username);
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  }
  res.json({ ok: true, message: 'Motorista atualizado' });
});

// Remover motorista
app.delete('/admin/users/:username', authMiddleware, admMiddleware, (req, res) => {
  db.prepare('DELETE FROM users WHERE username = ? AND role != ?').run(req.params.username, 'admin');
  res.json({ ok: true, message: 'Motorista removido' });
});

// Salvar programação (ADM)
app.post('/admin/programacao', authMiddleware, admMiddleware, async (req, res) => {
  const { date, username, ...fields } = req.body;
  if (!date || !username) return res.status(400).json({ ok: false, error: 'date e username obrigatórios' });
  db.prepare(`INSERT INTO programacao (date, username, tipo, placa, local, hr_chegada, hr_saida, cliente, hr_agendamento, obs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, username) DO UPDATE SET
      tipo=excluded.tipo, placa=excluded.placa, local=excluded.local,
      hr_chegada=excluded.hr_chegada, hr_saida=excluded.hr_saida,
      cliente=excluded.cliente, hr_agendamento=excluded.hr_agendamento,
      obs=excluded.obs, updated_at=datetime('now')`
  ).run(date, username, fields.tipo||null, fields.placa||null, fields.local||null,
    fields.hrChegada||null, fields.hrSaida||null, fields.cliente||null,
    fields.hrAgendamento||null, fields.obs||null);
  res.json({ ok: true });
});

// Buscar programação de uma data (ADM)
app.get('/admin/programacao/:date', authMiddleware, admMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM programacao WHERE date = ?').all(req.params.date);
  const result = {};
  rows.forEach(r => { result[r.username] = r; });
  res.json({ ok: true, programacao: result });
});

// Remover programação de um motorista numa data
app.delete('/admin/programacao/:date/:username', authMiddleware, admMiddleware, (req, res) => {
  db.prepare('DELETE FROM programacao WHERE date = ? AND username = ?').run(req.params.date, req.params.username);
  res.json({ ok: true });
});

// Histórico completo (ADM)
app.get('/admin/history', authMiddleware, admMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM history ORDER BY created_at DESC LIMIT 1000').all();
  res.json({ ok: true, history: rows });
});

// Enviar programação no WhatsApp (ADM)
app.post('/admin/send-programacao', authMiddleware, admMiddleware, async (req, res) => {
  const { message, progDate } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message obrigatória' });
  try {
    await sendToGroup(message);
    // Salvar no histórico
    const now = new Date();
    db.prepare(`INSERT INTO history (driver, username, type, status, mode, prog_date, prog_msg, date, time, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ADM', 'adm', 'programacao', '📅 Programação Enviada', 'adm',
      progDate || '', message,
      now.toLocaleDateString('pt-BR'), now.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}),
      now.toISOString());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// ROTAS RETROCOMPATÍVEIS (Baileys antigo)
// ═══════════════════════════════════════
app.post('/send-status', secretMiddleware, async (req, res) => {
  const { username, message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message obrigatória' });
  try {
    await sendToGroup(message);
    console.log(`[${new Date().toISOString()}] ✅ send-status | ${username}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-programacao', secretMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'message obrigatória' });
  try {
    await sendToGroup(message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/qr', (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (isConnected) return res.json({ ok: true, status: 'conectado' });
  if (!qrCode) return res.json({ ok: false, status: 'aguardando' });
  res.json({ ok: true, status: 'qr_disponivel', qr: qrCode });
});

app.get('/status-wa', (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  res.json({ ok: true, connected: isConnected, qrPending: !!qrCode, groupId: GROUP_ID || 'não configurado' });
});

app.get('/instances', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  res.json({ ok: true, instances: [{ username: 'adm', connected: isConnected }], groupId: GROUP_ID || 'não configurado' });
});

app.listen(PORT, () => {
  console.log(`\n🚛 Log DRK Server v3.0 rodando na porta ${PORT}`);
  console.log(`📦 Banco de dados: ${DB_PATH}`);
});
