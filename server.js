require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SERVER_SECRET || 'logdrk_secret';
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || '';

app.use(cors());
app.use(express.json());

function getZapiConfig(username) {
  const key = `ZAPI_${username.toLowerCase()}`;
  const val = process.env[key];
  if (!val) return null;
  const [instanceId, token] = val.split(':');
  if (!instanceId || !token) return null;
  return { url: `https://api.z-api.io/instances/${instanceId}/token/${token}`, instanceId, token };
}

async function sendToGroup(zapiConfig, message) {
  const response = await axios.post(`${zapiConfig.url}/send-text`, {
    phone: GROUP_ID,
    message: message,
  }, { headers: { 'Content-Type': 'application/json', 'Client-Token': CLIENT_TOKEN }, timeout: 10000 });
  return response.data;
}

app.get('/', (req, res) => {
  res.json({ status: 'online', app: 'Log DRK Server', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.post('/send-status', async (req, res) => {
  const { secret, username, message } = req.body;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (!username || !message) return res.status(400).json({ ok: false, error: 'username e message são obrigatórios' });
  if (!GROUP_ID) return res.status(500).json({ ok: false, error: 'WHATSAPP_GROUP_ID não configurado' });
  const zapiConfig = getZapiConfig(username);
  if (!zapiConfig) return res.status(404).json({ ok: false, error: `Instância Z-API não encontrada para "${username}". Configure ZAPI_${username.toLowerCase()} no servidor.` });
  try {
    const result = await sendToGroup(zapiConfig, message);
    console.log(`[${new Date().toISOString()}] ✅ Mensagem enviada | Motorista: ${username}`);
    return res.json({ ok: true, result });
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error(`[${new Date().toISOString()}] ❌ Erro | Motorista: ${username} |`, errMsg);
    return res.status(500).json({ ok: false, error: errMsg });
  }
});

app.post('/send-programacao', async (req, res) => {
  const { secret, message } = req.body;
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  if (!message) return res.status(400).json({ ok: false, error: 'message é obrigatória' });
  if (!GROUP_ID) return res.status(500).json({ ok: false, error: 'WHATSAPP_GROUP_ID não configurado' });
  const zapiConfig = getZapiConfig('adm');
  if (!zapiConfig) return res.status(404).json({ ok: false, error: 'Instância ADM não configurada. Configure ZAPI_adm.' });
  try {
    const result = await sendToGroup(zapiConfig, message);
    console.log(`[${new Date().toISOString()}] ✅ Programação enviada`);
    return res.json({ ok: true, result });
  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error(`[${new Date().toISOString()}] ❌ Erro programação |`, errMsg);
    return res.status(500).json({ ok: false, error: errMsg });
  }
});

app.get('/check-instance/:username', async (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  const { username } = req.params;
  const zapiConfig = getZapiConfig(username);
  if (!zapiConfig) return res.json({ ok: false, connected: false, error: `ZAPI_${username.toLowerCase()} não configurado` });
  try {
    const response = await axios.get(`${zapiConfig.url}/status`, { timeout: 8000 });
    const connected = response.data?.connected === true || response.data?.status === 'connected';
    return res.json({ ok: true, connected, data: response.data });
  } catch (err) {
    return res.json({ ok: false, connected: false, error: err.message });
  }
});

app.get('/instances', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== SECRET) return res.status(401).json({ ok: false, error: 'Não autorizado' });
  const instances = [];
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('ZAPI_')) {
      const username = key.replace('ZAPI_', '').toLowerCase();
      const [instanceId] = (process.env[key] || '').split(':');
      instances.push({ username, instanceId: instanceId || '?' });
    }
  });
  res.json({ ok: true, instances, groupId: GROUP_ID || 'não configurado' });
});

app.listen(PORT, () => {
  console.log(`\n🚛 Log DRK Server rodando na porta ${PORT}`);
  console.log(`📋 Grupo: ${GROUP_ID || '⚠️ não configurado'}`);
  const zapiKeys = Object.keys(process.env).filter(k => k.startsWith('ZAPI_'));
  zapiKeys.forEach(k => {
    const user = k.replace('ZAPI_', '');
    const [id] = (process.env[k] || '').split(':');
    console.log(`   📱 ${user}: ${id}`);
  });
});
