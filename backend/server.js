/*
 * Backend del Sistema de Deteccion de Intrusos IoT
 * ------------------------------------------------
 * - Consulta al ESP32 (/status y /capture) de forma periodica
 * - Detecta movimiento: PIR del ESP32 + diferencia de fotogramas
 * - Guarda horarios y estado de armado (data.json)
 * - Si el sistema esta ARMADO y hay movimiento -> correo con foto adjunta
 * - Expone la API que consume la app movil
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const jpeg = require('jpeg-js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ_NAME || 'America/Bogota';
const POLL_MS = 1000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------------- Configuracion persistente ----------------
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
const cfg = {
  manualArmed: false,
  scheduleEnabled: false,
  slots: [],                                   // [{days:[0..6], start:"22:00", end:"06:00"}]
  emailTo: process.env.EMAIL_TO || '',
  cooldownSec: 60,
  espHost: process.env.ESP_HOST || '192.168.43.100',
  sensitivity: 3,                              // % de celdas que deben cambiar
  usePir: true,
  ...loadData(),
};
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(cfg, null, 2)); }

// ---------------- Estado en memoria ----------------
const state = {
  motion: false, espOnline: false, rssi: null,
  lastEvent: 0, emailsSent: 0, lastEmailOk: null, lastError: null,
  lastAlertAt: 0, lastPhoto: null, events: [],
};

// ---------------- Horarios ----------------
function nowParts() {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { day, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function inSchedule() {
  if (!cfg.scheduleEnabled) return false;
  const { day, minutes } = nowParts();
  const prev = (day + 6) % 7;
  return cfg.slots.some(s => {
    const st = toMin(s.start), en = toMin(s.end);
    if (st <= en) return s.days.includes(day) && minutes >= st && minutes < en;
    // franja nocturna que cruza medianoche
    return (s.days.includes(day) && minutes >= st) || (s.days.includes(prev) && minutes < en);
  });
}
const isArmed = () => cfg.manualArmed || inSchedule();

function validSchedule(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.slots)) return null;
  const re = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const slots = [];
  for (const s of b.slots.slice(0, 8)) {
    if (!re.test(s.start) || !re.test(s.end)) return null;
    const days = (s.days || []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
    slots.push({ days, start: s.start, end: s.end });
  }
  return { enabled: !!b.enabled, slots };
}

// ---------------- Acceso al ESP32 ----------------
const espApi = () => `http://${cfg.espHost}`;
// ESP real: video en puerto 81. Si el host trae puerto (simulador), todo va en el mismo.
const streamUrl = () => cfg.espHost.includes(':') ? `http://${cfg.espHost}/stream` : `http://${cfg.espHost}:81/stream`;

async function espFetch(pathname, ms = 2500) {
  const r = await fetch(espApi() + pathname, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

// ---------------- Deteccion por diferencia de fotogramas ----------------
const GW = 64, GH = 48;
function signature(buf) {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
  const out = new Uint8Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const sx = Math.min(img.width - 2, Math.floor(x * img.width / GW));
      const sy = Math.min(img.height - 2, Math.floor(y * img.height / GH));
      let acc = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((sy + dy) * img.width + (sx + dx)) * 4;
        acc += (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8;  // gris
      }
      out[y * GW + x] = acc >> 2;
    }
  }
  return out;
}
function changedPct(a, b) {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 30) c++;
  return (c * 100) / a.length;
}

let prevSig = null, overCount = 0, prevMotion = false;
let lastEspErr = '';   // para avisar en consola solo cuando cambia la situacion con el ESP32

async function pollOnce() {
  let pir = false;
  try {
    const s = await (await espFetch('/status', 2000)).json();
    pir = !!s.motion;
    state.rssi = s.rssi ?? null;
    state.espOnline = true;
    if (lastEspErr) { console.log(`ESP32 conectado en ${espApi()}`); lastEspErr = ''; }
  } catch (e) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    if (why !== lastEspErr) { console.log(`ESP32 NO responde en ${espApi()}/status -> ${why}`); lastEspErr = why; }
    state.espOnline = false; state.motion = false; prevSig = null; overCount = 0; prevMotion = false;
    return;
  }

  // Solo pedimos fotos a la placa cuando el sistema esta ARMADO (desarmado = menos carga y menos calor)
  let buf = null, frameMotion = false;
  if (isArmed()) {
    try {
      buf = Buffer.from(await (await espFetch('/capture', 3000)).arrayBuffer());
      const sig = signature(buf);
      if (prevSig) {
        overCount = changedPct(prevSig, sig) > cfg.sensitivity ? overCount + 1 : 0;
        frameMotion = overCount >= 2;           // 2 lecturas seguidas: filtra ruido
      }
      prevSig = sig;
    } catch { /* si falla una captura, seguimos solo con el PIR */ }
  } else {
    prevSig = null; overCount = 0;
  }

  const motion = (cfg.usePir && pir) || frameMotion;
  state.motion = motion;
  if (motion && !prevMotion) await onMotion(buf, (cfg.usePir && pir) ? 'PIR' : 'imagen');   // flanco ascendente
  prevMotion = motion;
}

async function pollLoop() {
  try { await pollOnce(); } catch (e) { console.error('poll:', e.message); }
  setTimeout(pollLoop, POLL_MS);
}

// ---------------- Eventos y alertas ----------------
async function onMotion(buf, source) {
  const armed = isArmed();
  const t = Math.floor(Date.now() / 1000);
  state.events.unshift({ t, source, armed });
  state.events.length = Math.min(state.events.length, 30);
  console.log(`[${new Date().toLocaleTimeString()}] Movimiento (${source}) armado=${armed}`);
  if (!armed) return;
  if (Date.now() - state.lastAlertAt < cfg.cooldownSec * 1000) return;   // antispam
  state.lastAlertAt = Date.now();
  state.lastEvent = t;
  await sendAlert(buf, source);
}

// Limpiamos espacios: la contrasena de aplicacion se copia a veces como "xxxx xxxx xxxx xxxx"
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '');
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function sendAlert(buf, source) {
  try {
    if (!cfg.emailTo) throw new Error('Sin correo destino configurado');
    if (!buf) { try { buf = Buffer.from(await (await espFetch('/capture', 3000)).arrayBuffer()); } catch {} }
    if (buf) state.lastPhoto = buf;
    const ts = new Date().toLocaleString('es-CO', { timeZone: TZ });
    await transporter.sendMail({
      from: `"Sistema Anti-Intrusos" <${SMTP_USER}>`,
      to: cfg.emailTo,
      subject: 'ALERTA: movimiento detectado',
      text: `Se detecto movimiento sospechoso.\n\nFecha y hora: ${ts}\nDetectado por: ${source}\nCamara: ${cfg.espHost}`,
      attachments: buf ? [{ filename: 'intruso.jpg', content: buf, contentType: 'image/jpeg' }] : [],
    });
    state.emailsSent++; state.lastEmailOk = true; state.lastError = null;
    console.log('Correo enviado a', cfg.emailTo);
  } catch (e) {
    state.lastEmailOk = false; state.lastError = e.message;
    console.error('Correo fallo:', e.message);
  }
}

// ---------------- API HTTP ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '50kb' }));

app.get('/status', (req, res) => {
  res.json({
    armed: isArmed(),
    manualArmed: cfg.manualArmed,
    scheduleEnabled: cfg.scheduleEnabled,
    inSchedule: inSchedule(),
    motion: state.motion,
    lastEvent: state.lastEvent,
    emailsSent: state.emailsSent,
    lastEmailOk: state.lastEmailOk,
    lastError: state.lastError,
    espOnline: state.espOnline,
    rssi: state.rssi,
    streamUrl: streamUrl(),
    time: Math.floor(Date.now() / 1000),
  });
});

app.post('/arm', (req, res) => { cfg.manualArmed = true; save(); res.json({ ok: true, manualArmed: true }); });
app.post('/disarm', (req, res) => { cfg.manualArmed = false; save(); res.json({ ok: true, manualArmed: false }); });

app.get('/schedule', (req, res) => res.json({ enabled: cfg.scheduleEnabled, slots: cfg.slots }));
app.post('/schedule', (req, res) => {
  const v = validSchedule(req.body);
  if (!v) return res.status(400).json({ ok: false, error: 'Horario invalido' });
  cfg.scheduleEnabled = v.enabled; cfg.slots = v.slots; save();
  res.json({ ok: true });
});

app.get('/config', (req, res) => res.json({
  emailTo: cfg.emailTo, cooldownSec: cfg.cooldownSec, espHost: cfg.espHost,
  sensitivity: cfg.sensitivity, usePir: cfg.usePir,
}));
app.post('/config', (req, res) => {
  const b = req.body || {};
  if (typeof b.emailTo === 'string') {
    if (!/^\S+@\S+\.\S+$/.test(b.emailTo)) return res.status(400).json({ ok: false, error: 'Correo invalido' });
    cfg.emailTo = b.emailTo;
  }
  if (Number.isFinite(b.cooldownSec)) cfg.cooldownSec = Math.min(3600, Math.max(10, b.cooldownSec));
  if (Number.isFinite(b.sensitivity)) cfg.sensitivity = Math.min(30, Math.max(0.5, b.sensitivity));
  if (typeof b.usePir === 'boolean') cfg.usePir = b.usePir;
  if (typeof b.espHost === 'string' && b.espHost.trim()) {
    cfg.espHost = b.espHost.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    prevSig = null;
  }
  save();
  res.json({ ok: true });
});

app.post('/testmail', async (req, res) => {
  await sendAlert(null, 'prueba manual');
  res.status(state.lastEmailOk ? 200 : 500).json({ ok: !!state.lastEmailOk, error: state.lastError });
});

app.get('/events', (req, res) => res.json(state.events));
app.get('/lastphoto', (req, res) => {
  if (!state.lastPhoto) return res.status(404).end();
  res.type('image/jpeg').send(state.lastPhoto);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend escuchando en el puerto ${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  -> http://${i.address}:${PORT}`);
  console.log(`ESP32 configurado en: ${cfg.espHost}`);
  // Verificacion del correo al arrancar (no muestra la clave, solo su largo: debe ser 16)
  console.log(`Correo remitente: ${SMTP_USER || '(VACIO)'} | clave cargada: ${SMTP_PASS ? SMTP_PASS.length + ' caracteres (deben ser 16)' : 'NO (vacia)'}`);
  transporter.verify()
    .then(() => console.log('Gmail: inicio de sesion OK'))
    .catch((e) => console.log('Gmail: ERROR ->', e.message));
  pollLoop();
});