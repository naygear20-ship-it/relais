const express = require('express'), fs = require('fs'), path = require('path'), QR = require('qrcode');
const DATA = process.env.DATA_DIR || '/data', PORT = process.env.PORT || 3000;
const MOCK = process.env.WA_MOCK === '1', PASS = process.env.ADMIN_PASSWORD || '';
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'schedules.json');
let schedules = (() => { try { return JSON.parse(fs.readFileSync(FILE)); } catch { return []; } })();
schedules.forEach(s => { if (!s.groupIds) { s.groupIds = [s.groupId]; s.groupNames = [s.groupName]; s.name = s.name || s.groupName; } });
const save = () => fs.writeFileSync(FILE, JSON.stringify(schedules, null, 2));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));
let err = null, state = 'starting', qr = null, groups = [], client = null, logs = [];
let groupsLoading = false, groupsError = null, groupsRetryTimer = null, groupsRetryCount = 0, groupsRefreshPromise = null, groupsGeneration = 0;
const log = (msg, ok = true) => { logs.unshift({ t: new Date().toISOString(), msg, ok }); logs.length = Math.min(logs.length, 100); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- WhatsApp ----------
function scheduleGroupRefresh(delay) {
  clearTimeout(groupsRetryTimer);
  groupsRetryTimer = setTimeout(() => {
    groupsRetryTimer = null;
    if (state === 'ready') refreshGroups();
  }, delay);
}
async function refreshGroups() {
  if (MOCK) return true;
  if (state !== 'ready' || !client) return false;
  if (groupsRefreshPromise) return groupsRefreshPromise;
  const generation = ++groupsGeneration, activeClient = client;
  groupsLoading = true; groupsError = null;
  groupsRefreshPromise = (async () => {
    try {
      let timeout;
      const chats = await Promise.race([
        activeClient.getChats(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Délai dépassé lors du chargement des discussions WhatsApp')), 30000); })
      ]).finally(() => clearTimeout(timeout));
      if (generation !== groupsGeneration || state !== 'ready' || client !== activeClient) return false;
      groups = chats.filter(c => c.isGroup)
        .map(c => ({ id: c.id._serialized, name: c.name, size: (c.participants || []).length }))
        .sort((a, b) => a.name.localeCompare(b.name));
      groupsError = groups.length ? null : 'WhatsApp est connecté, mais les discussions ne sont pas encore synchronisées.';
      groupsRetryCount = groups.length ? 0 : groupsRetryCount + 1;
      if (groups.length) {
        clearTimeout(groupsRetryTimer);
        groupsRetryTimer = null;
        log(`${groups.length} groupe(s) chargé(s)`);
        scheduleGroupRefresh(5 * 60 * 1000);
      } else {
        log(groupsError, false);
        scheduleGroupRefresh(Math.min(5000 * 2 ** Math.min(groupsRetryCount - 1, 4), 60000));
      }
      return groups.length > 0;
    } catch (e) {
      if (generation !== groupsGeneration || state !== 'ready' || client !== activeClient) return false;
      groupsError = `Impossible de charger les groupes : ${e.message}`;
      groupsRetryCount++;
      log(groupsError, false);
      scheduleGroupRefresh(Math.min(5000 * 2 ** Math.min(groupsRetryCount - 1, 4), 60000));
      return false;
    } finally {
      if (generation === groupsGeneration) {
        groupsLoading = false;
        groupsRefreshPromise = null;
      }
    }
  })();
  return groupsRefreshPromise;
}
async function startWA() {
  if (MOCK) {
    state = 'qr'; qr = await QR.toDataURL('relais-demo', { width: 320, margin: 1 });
    setTimeout(() => {
      state = 'ready'; qr = null; log('Mode démo : connecté');
      groups = ['Famille', 'Promo INPHB', 'Équipe projet', 'Voisins'].map((name, i) => ({ id: `demo${i}@g.us`, name, size: 8 + i * 13 }));
    }, 6000);
    return;
  }
  console.log('Démarrage de WhatsApp (Chromium)…');
  const { Client, LocalAuth } = require('whatsapp-web.js');
  fs.rmSync(path.join(DATA, 'auth/session/SingletonLock'), { force: true });
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA, 'auth') }),
    puppeteer: { headless: true, defaultViewport: { width: 1280, height: 800 }, timeout: 0, protocolTimeout: 300000, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-zygote', '--disable-extensions'] }
  });
  client.on('loading_screen', (p, m) => console.log('Chargement WhatsApp', p + '%', m));
  client.on('auth_failure', m => { err = String(m); console.error('auth_failure:', m); });
  client.on('qr', async q => { console.log('QR code prêt'); err = null; state = 'qr'; qr = await QR.toDataURL(q, { width: 320, margin: 1 }); });
  client.on('ready', () => {
    console.log('WhatsApp prêt'); err = null; state = 'ready'; qr = null;
    log('WhatsApp connecté'); refreshGroups();
  });
  client.on('disconnected', r => {
    state = 'disconnected'; log('Déconnecté : ' + r, false);
    clearTimeout(groupsRetryTimer); groupsRetryTimer = null;
    groupsGeneration++; groupsRefreshPromise = null; groupsLoading = false;
    groups = []; groupsError = 'WhatsApp est déconnecté.'; groupsRetryCount = 0;
    client.destroy().catch(() => {}); setTimeout(startWA, 5000);
  });
  client.initialize().catch(e => {
    state = 'disconnected'; err = e.message; console.error('ERREUR DÉMARRAGE:', e); log('Erreur démarrage : ' + e.message, false);
    client.destroy().catch(() => {}); setTimeout(startWA, 15000);
  });
}
async function send(s) {
  let ok = 0;
  for (const [i, id] of s.groupIds.entries()) {
    try { if (MOCK) await sleep(300); else await client.sendMessage(id, s.message); ok++; }
    catch (e) { log(`Échec « ${s.groupNames[i]} » : ${e.message}`, false); }
    if (i < s.groupIds.length - 1) await sleep(MOCK ? 300 : 3000 + Math.random() * 5000);
  }
  save(); log(`« ${s.name} » : envoyé à ${ok}/${s.groupIds.length} groupe(s)`, ok > 0);
}
// Les ensembles dus passent dans une file : un seul envoi à la fois, jamais de doublon.
const queue = []; let working = false;
async function enqueue(s) {
  queue.push(s); if (working) return; working = true;
  while (queue.length) await send(queue.shift());
  working = false;
}

// ---------- Planificateur (vérifie toutes les 20 s) ----------
const pad = n => String(n).padStart(2, '0');
setInterval(async () => {
  if (state !== 'ready') return;
  const d = new Date(), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`, key = `${d.toDateString()} ${hm}`;
  for (const s of schedules.filter(x => x.enabled)) {
    let due = false;
    if (s.mode === 'daily') due = s.time === hm && s.days.includes(d.getDay()) && s.lastKey !== key;
    else due = Date.now() - (s.lastRun || 0) >= s.everyMin * 60000;
    if (!due) continue;
    s.lastKey = key; s.lastRun = Date.now(); enqueue(s);
  }
}, 20000);

// ---------- API ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (!PASS) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  if (b64 && Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') === PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Relais"').status(401).send('Authentification requise');
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/status', (_, res) => res.json({ state, qr, mock: MOCK, err, groupsLoading, groupsError, groupCount: groups.length }));
app.get('/api/groups', async (req, res) => {
  if (req.query.refresh) {
    if (state !== 'ready') return res.status(503).json({ error: 'WhatsApp n’est pas connecté.' });
    if (!await refreshGroups()) return res.status(503).json({ error: groupsError, groups });
  }
  res.json(groups);
});
app.get('/api/screenshot', async (_, res) => {
  try {
    if (MOCK) return res.type('svg').send('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="#e9edef"/><text x="640" y="400" font-size="34" text-anchor="middle" font-family="sans-serif" fill="#41525d">Mode démo : pas de navigateur interne</text></svg>');
    const page = client && client.pupPage;
    if (!page || page.isClosed()) return res.status(503).json({ error: `Navigateur WhatsApp non disponible (état : ${state})${err ? ' : ' + err : ''}` });
    const png = await page.screenshot({ type: 'png' });
    res.set('Cache-Control', 'no-store').type('png').send(Buffer.from(png));
  } catch (e) { res.status(500).json({ error: `Capture du navigateur WhatsApp impossible : ${e.message}` }); }
});
app.get('/api/logs', (_, res) => res.json(logs));
app.get('/api/schedules', (_, res) => res.json(schedules));
const clean = b => {
  const gs = (Array.isArray(b.groupIds) ? b.groupIds : []).map(id => groups.find(x => x.id === id)).filter(Boolean);
  if (!gs.length || !String(b.message || '').trim()) return null;
  const mode = b.mode === 'interval' ? 'interval' : 'daily';
  return { name: String(b.name || '').trim() || gs.map(g => g.name).slice(0, 2).join(', '),
    groupIds: gs.map(g => g.id), groupNames: gs.map(g => g.name),
    message: String(b.message).trim(), mode, enabled: b.enabled !== false,
    time: /^\d{2}:\d{2}$/.test(b.time) ? b.time : '09:00',
    days: Array.isArray(b.days) && b.days.length ? b.days.map(Number).filter(n => n >= 0 && n <= 6) : [0, 1, 2, 3, 4, 5, 6],
    everyMin: Math.max(5, parseInt(b.everyMin) || 60) };
};
app.post('/api/schedules', (req, res) => {
  const s = clean(req.body); if (!s) return res.status(400).json({ error: 'Groupe ou message invalide' });
  schedules.push({ id: Date.now().toString(36), lastRun: Date.now(), ...s }); save(); res.json({ ok: true });
});
app.put('/api/schedules/:id', (req, res) => {
  const i = schedules.findIndex(x => x.id === req.params.id), s = clean({ ...schedules[i], ...req.body });
  if (i < 0 || !s) return res.status(400).json({ error: 'Invalide' });
  schedules[i] = { ...schedules[i], ...s }; save(); res.json({ ok: true });
});
app.delete('/api/schedules/:id', (req, res) => { schedules = schedules.filter(x => x.id !== req.params.id); save(); res.json({ ok: true }); });
app.post('/api/schedules/:id/run', async (req, res) => {
  const s = schedules.find(x => x.id === req.params.id);
  if (!s || state !== 'ready') return res.status(400).json({ error: 'WhatsApp non connecté' });
  enqueue(s); res.json({ ok: true });
});
app.listen(PORT, () => { console.log(`Relais sur :${PORT}${MOCK ? ' (démo)' : ''}`); startWA(); });
