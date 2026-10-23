const express = require('express'), fs = require('fs'), path = require('path'), QR = require('qrcode');
const DATA = process.env.DATA_DIR || '/data', PORT = process.env.PORT || 3000;
const MOCK = process.env.WA_MOCK === '1', SETUP_CODE = process.env.ADMIN_PASSWORD || '';
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'schedules.json');
const ACCOUNT_FILE = path.join(DATA, 'account.json');
let schedules = (() => { try { return JSON.parse(fs.readFileSync(FILE)); } catch { return []; } })();
let account = (() => { try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE)); } catch { return null; } })();
schedules.forEach(s => { if (!s.groupIds) { s.groupIds = [s.groupId]; s.groupNames = [s.groupName]; s.name = s.name || s.groupName; } });
const save = () => fs.writeFileSync(FILE, JSON.stringify(schedules, null, 2));
const saveAccount = () => {
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(ACCOUNT_FILE, 0o600);
};
const { promisify } = require('util');
const scrypt = promisify(require('crypto').scrypt);
const crypto = require('crypto');
const sessions = new Map(), loginAttempts = new Map();
const SESSION_COOKIE = 'relais_session';
let registrationInProgress = false;
const hashPassword = (password, salt) => scrypt(password, salt, 64);
function getSession(req) {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.username;
}
function setSession(req, res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const oldToken = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (oldToken) sessions.delete(oldToken);
  sessions.set(token, { username, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
}
function clearSession(req, res) {
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (token) sessions.delete(token);
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  try {
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origine de requête invalide.' });
  } catch { return res.status(403).json({ error: 'Origine de requête invalide.' }); }
  next();
}
function requireLogin(req, res, next) {
  if (getSession(req)) return next();
  res.status(401).json({ error: 'Connexion requise.' });
}
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
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/auth/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = getSession(req);
  res.json({ configured: Boolean(account), authenticated: Boolean(username), username: username || null });
});
app.post('/api/auth/setup', sameOrigin, async (req, res) => {
  if (account || registrationInProgress) return res.status(409).json({ error: 'La création du compte a déjà été effectuée. Connecte-toi.' });
  if (state !== 'ready') return res.status(409).json({ error: 'Connecte WhatsApp avec le QR code avant de créer le compte.' });
  if (SETUP_CODE.length < 20) return res.status(503).json({ error: 'Configure dans Sealos un ADMIN_PASSWORD de vérification d’au moins 20 caractères avant de créer le compte.' });
  const ip = req.ip, attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (attempt.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
  const { verificationCode, username, password } = req.body || {};
  const provided = Buffer.from(String(verificationCode || ''));
  const expected = Buffer.from(SETUP_CODE);
  const validCode = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!validCode) {
    attempt.count++;
    if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 15 * 60 * 1000; }
    loginAttempts.set(ip, attempt);
    return res.status(403).json({ error: 'Code de vérification incorrect.' });
  }
  const cleanUsername = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(cleanUsername)) return res.status(400).json({ error: 'Le nom d’utilisateur doit contenir 3 à 32 caractères (lettres, chiffres, point, tiret ou soulignement).' });
  if (typeof password !== 'string' || password.length < 12) return res.status(400).json({ error: 'Choisis un mot de passe de 12 caractères minimum.' });
  registrationInProgress = true;
  const salt = crypto.randomBytes(16);
  try {
    account = { username: cleanUsername, salt: salt.toString('hex'), passwordHash: (await hashPassword(password, salt)).toString('hex') };
    saveAccount();
  } catch (e) {
    account = null;
    console.error('Échec de sauvegarde du compte:', e);
    return res.status(500).json({ error: 'Impossible de sauvegarder le compte. Vérifie le volume /data.' });
  } finally {
    registrationInProgress = false;
  }
  loginAttempts.delete(ip);
  setSession(req, res, account.username);
  res.json({ ok: true });
});
app.post('/api/auth/login', sameOrigin, async (req, res) => {
  const ip = req.ip, attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (attempt.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
  attempt.count++;
  if (attempt.count >= 5) { attempt.count = 0; attempt.until = Date.now() + 15 * 60 * 1000; }
  loginAttempts.set(ip, attempt);
  if (attempt.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
  if (!account) return res.status(409).json({ error: 'Crée d’abord ton compte après avoir connecté WhatsApp.' });
  const { username, password } = req.body || {};
  const salt = Buffer.from(account.salt, 'hex');
  const candidate = await hashPassword(typeof password === 'string' ? password : '', salt);
  const expected = Buffer.from(account.passwordHash, 'hex');
  const validPassword = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  if (String(username || '') !== account.username || !validPassword) {
    return res.status(401).json({ error: 'Nom d’utilisateur ou mot de passe incorrect.' });
  }
  loginAttempts.delete(ip);
  setSession(req, res, account.username);
  res.json({ ok: true });
});
app.post('/api/auth/logout', sameOrigin, (req, res) => { clearSession(req, res); res.json({ ok: true }); });
app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const authenticated = Boolean(getSession(req));
  res.json({ state, qr: !account || authenticated ? qr : null, mock: MOCK, err, authenticated,
    groupsLoading: authenticated && groupsLoading, groupsError: authenticated ? groupsError : null,
    groupCount: authenticated ? groups.length : 0 });
});
app.use('/api', requireLogin);
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
