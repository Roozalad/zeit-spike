'use strict';
/* Wegwerf-Spike: Halten-Sprechen-Loslassen -> OpenAI-Transkription.
   Kein Key im Code: er liegt nur in localStorage des Browsers. */

// ---------------------------------------------------------------- Konfig
const CONFIG = {
  endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'gpt-transcribe',      // laut OpenAI-Doku empfohlen; Vorgaenger (gpt-4o-transcribe, whisper-1) deprecated
  languages: ['de'],            // gpt-transcribe: "languages[]" statt "language"
  minRecordingMs: 700,          // kuerzer = versehentliches Antippen -> verwerfen
  requestTimeoutMs: 60000,
  streamIdleMs: 30000,          // Mikrofon nach Loslassen so lange offen halten (schnellere Folgeaufnahmen)
  keyStorage: 'spike.openaiKey',
};

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), detail: $('detail'), rec: $('rec'), results: $('results'),
  pending: $('pending'), key: $('key'), keysave: $('keysave'), keyinfo: $('keyinfo'),
  log: $('log'), settings: $('settings'),
};

function log(msg) {
  const t = new Date().toLocaleTimeString('de-DE');
  ui.log.textContent = `${t} ${msg}\n` + ui.log.textContent.slice(0, 4000);
  try { console.log(msg); } catch (_) {}
}

// ---------------------------------------------------------------- Key (nur localStorage)
function getKey() { try { return localStorage.getItem(CONFIG.keyStorage) || ''; } catch (_) { return ''; } }
function setKey(v) { try { localStorage.setItem(CONFIG.keyStorage, v); return true; } catch (_) { return false; } }

// ---------------------------------------------------------------- Audioformat
// iOS Safari: audio/mp4 (AAC). Chrome/Android: audio/webm;codecs=opus. Zur Laufzeit erkennen.
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac',
  'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus',
];
function pickMimeType(isSupported) {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of MIME_CANDIDATES) {
    try { if (isSupported(m)) return m; } catch (_) {}
  }
  return ''; // Browser-Default
}
function extensionFor(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'm4a';
}

// ---------------------------------------------------------------- Transkription: Audio rein, Text raus
// Austauschbar: Blob -> Promise<string>. Wirft TranscribeError (.retryable, .status).
class TranscribeError extends Error {
  constructor(message, { retryable = true, status = 0 } = {}) {
    super(message); this.name = 'TranscribeError'; this.retryable = retryable; this.status = status;
  }
}
async function transcribe(blob) {
  const key = getKey();
  if (!key) throw new TranscribeError('Kein API-Key eingetragen', { retryable: true });
  const form = new FormData();
  form.append('model', CONFIG.model);
  for (const l of CONFIG.languages) form.append('languages[]', l);
  form.append('file', blob, `aufnahme.${extensionFor(blob.type)}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
  let res;
  try {
    res = await fetch(CONFIG.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: ctrl.signal,
    });
  } catch (e) {
    throw new TranscribeError(e.name === 'AbortError' ? 'Zeitüberschreitung' : 'Netzwerkfehler', { retryable: true });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j && j.error && j.error.message) msg += `: ${j.error.message}`; } catch (_) {}
    const retryable = res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
    throw new TranscribeError(msg, { retryable, status: res.status });
  }
  let data;
  try { data = await res.json(); } catch (_) { throw new TranscribeError('Antwort nicht lesbar', { retryable: true }); }
  if (typeof data.text !== 'string') throw new TranscribeError('Antwort ohne Text', { retryable: false });
  return data.text.trim();
}

// ---------------------------------------------------------------- IndexedDB (Zwischenspeicher)
const DB_NAME = 'spike-audio', STORE = 'pending';
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
// ArrayBuffer statt Blob speichern: robuster in iOS-IndexedDB.
async function saveRecording(blob, durationMs) {
  const buf = await blob.arrayBuffer();
  return tx('readwrite', (s) => s.add({ buf, type: blob.type, createdAt: Date.now(), durationMs, attempts: 0, lastError: '' }));
}
const listRecordings = () => tx('readonly', (s) => s.getAll());
const deleteRecording = (id) => tx('readwrite', (s) => { s.delete(id); });
async function markFailed(id, err) {
  const rec = await tx('readonly', (s) => s.get(id));
  if (!rec) return;
  rec.attempts = (rec.attempts || 0) + 1; rec.lastError = err;
  await tx('readwrite', (s) => { s.put(rec); });
}

// ---------------------------------------------------------------- Ergebnisse / Status
const results = []; // nur diese Sitzung
function addResult(text, ms, note) {
  results.unshift({ text, ms, note });
  ui.results.textContent = '';
  for (const r of results) {
    const li = document.createElement('li');
    const p = document.createElement('div'); p.textContent = r.text || '(leer)';
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = `${(r.ms / 1000).toFixed(1)} s Loslassen bis Ergebnis` + (r.note ? ` · ${r.note}` : '');
    li.append(p, m); ui.results.append(li);
  }
}

let recording = false;        // Aufnahme laeuft oder startet
let inFlight = 0;             // laufende Transkriptionen
let lastOutcome = { kind: 'ready', text: 'Bereit', detail: '' };
function setOutcome(kind, text, detail = '') { lastOutcome = { kind, text, detail }; render(); }
function render() {
  let o;
  if (recording) o = { kind: recording === 'starting' ? 'starting' : 'recording', text: recording === 'starting' ? 'Mikrofon startet …' : 'Nimmt auf …', detail: lastOutcome.detail };
  else if (inFlight > 0) o = { kind: 'processing', text: 'Verarbeitet …', detail: '' };
  else o = lastOutcome;
  ui.status.className = `status s-${o.kind}`;
  ui.status.textContent = o.text;
  ui.detail.textContent = o.detail || '';
}

async function renderPending() {
  let items = [];
  try { items = await listRecordings(); } catch (_) {}
  const idle = items.filter((i) => !activeIds.has(i.id));
  ui.pending.hidden = items.length === 0;
  if (!items.length) return;
  ui.pending.textContent = `${items.length} Aufnahme(n) zwischengespeichert` + (idle[0] && idle[0].lastError ? ` (${idle[0].lastError})` : '');
  const b = document.createElement('button'); b.textContent = 'Erneut senden';
  b.onclick = () => retryPending('manuell'); ui.pending.append(b);
}

// ---------------------------------------------------------------- Verarbeitung (gespeichert -> senden -> loeschen)
const activeIds = new Set();
async function processRecording(id, t0, note) {
  if (activeIds.has(id)) return;
  activeIds.add(id); inFlight++; render();
  try {
    const rec = await tx('readonly', (s) => s.get(id));
    if (!rec) return;
    const blob = new Blob([rec.buf], { type: rec.type });
    const text = await transcribe(blob);
    await deleteRecording(id); // Audio erst nach Erfolg loeschen
    const ms = performance.now() - t0;
    addResult(text, ms, note);
    inFlight--; activeIds.delete(id); // vor setOutcome, damit render korrekt ist
    setOutcome('done', 'Fertig', `${(ms / 1000).toFixed(1)} s`);
    log(`ok id=${id} ${ms.toFixed(0)}ms`);
    return;
  } catch (e) {
    const msg = e instanceof TranscribeError ? e.message : `Fehler: ${e && e.message}`;
    log(`fehler id=${id}: ${msg}`);
    try { await markFailed(id, msg); } catch (_) {}
    inFlight--; activeIds.delete(id);
    setOutcome('error', 'Fehler', `${msg} – Aufnahme bleibt gespeichert`);
    return;
  } finally {
    if (activeIds.delete(id)) inFlight--; // nur falls ein Pfad oben nicht aufgeraeumt hat
    renderPending(); render();
  }
}

let retrying = false;
async function retryPending(reason) {
  if (retrying) return;
  retrying = true;
  try {
    const items = await listRecordings();
    if (items.length) log(`sende ${items.length} gespeicherte Aufnahme(n) erneut (${reason})`);
    for (const it of items) {
      if (!navigator.onLine) break;
      await processRecording(it.id, performance.now(), 'nachgesendet');
    }
  } catch (e) { log(`retry-Fehler: ${e && e.message}`); }
  finally { retrying = false; renderPending(); }
}

// ---------------------------------------------------------------- Aufnahme (Halten / Loslassen)
let stream = null, idleTimer = null, mime = '';
let pressed = false;          // Finger liegt gerade auf dem Button
let recorder = null, chunks = [], startedAt = 0;

async function ensureStream() {
  clearTimeout(idleTimer);
  if (stream && stream.getTracks().every((t) => t.readyState === 'live')) return stream;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  return stream;
}
function releaseStreamSoon(immediate) {
  clearTimeout(idleTimer);
  const stop = () => { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } };
  if (immediate) stop(); else idleTimer = setTimeout(stop, CONFIG.streamIdleMs);
}

async function onPress() {
  if (recording) return;
  pressed = true; recording = 'starting'; ui.rec.classList.add('active'); render();
  let s;
  try {
    if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('Aufnahme wird von diesem Browser nicht unterstützt');
    s = await ensureStream();
  } catch (e) {
    pressed = false; recording = false; ui.rec.classList.remove('active');
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setOutcome('error', 'Fehler', denied ? 'Mikrofon nicht erlaubt (Einstellungen > Safari/Web-App prüfen)' : `Mikrofon: ${e && e.message}`);
    log(`getUserMedia: ${e && e.name} ${e && e.message}`);
    return;
  }
  if (!pressed) { // vor Mikrofon-Start losgelassen (z. B. Erlaubnis-Dialog) -> verwerfen
    recording = false; ui.rec.classList.remove('active');
    releaseStreamSoon(false);
    setOutcome('error', 'Zu kurz – verworfen', 'Loslassen, bevor das Mikrofon bereit war. Nochmal halten.');
    return;
  }
  mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m));
  chunks = [];
  try { recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); }
  catch (e) { recording = false; pressed = false; ui.rec.classList.remove('active'); setOutcome('error', 'Fehler', `Recorder: ${e.message}`); return; }
  const rec = recorder;
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  rec.onerror = (ev) => log(`recorder error: ${ev.error && ev.error.name}`);
  rec.onstop = () => finishRecording(rec);
  rec.start();
  startedAt = performance.now();
  recording = true; render();
  log(`start mime=${rec.mimeType || mime || '(default)'}`);
}

function onRelease() {
  const wasPressed = pressed;
  pressed = false; ui.rec.classList.remove('active');
  if (!wasPressed) return;
  if (recording === true && recorder && recorder.state === 'recording') {
    releaseTime = performance.now();
    try { recorder.stop(); } catch (e) { log(`stop: ${e.message}`); }
  }
  // recording === 'starting': onPress erkennt pressed=false selbst
}
let releaseTime = 0;

async function finishRecording(rec) {
  const t0 = releaseTime || performance.now();
  const durationMs = t0 - startedAt;
  const type = rec.mimeType || mime || (chunks[0] && chunks[0].type) || '';
  const blob = new Blob(chunks, { type });
  chunks = []; recorder = null; recording = false; releaseTime = 0;
  releaseStreamSoon(document.hidden);
  log(`ende ${durationMs.toFixed(0)}ms ${blob.size}B ${type}`);
  if (durationMs < CONFIG.minRecordingMs || blob.size === 0) {
    setOutcome('error', 'Zu kurz – verworfen', `${(durationMs / 1000).toFixed(1)} s (min. ${CONFIG.minRecordingMs / 1000} s)`);
    return;
  }
  let id;
  try { id = await saveRecording(blob, durationMs); }
  catch (e) {
    log(`IndexedDB: ${e && e.message}`);
    setOutcome('error', 'Fehler', 'Zwischenspeichern fehlgeschlagen – wird trotzdem direkt gesendet');
    // Notfall: ohne Speicher direkt senden
    inFlight++; render();
    try { const text = await transcribe(blob); const ms = performance.now() - t0; addResult(text, ms, 'ohne Zwischenspeicher'); inFlight--; setOutcome('done', 'Fertig', `${(ms / 1000).toFixed(1)} s`); }
    catch (err) { inFlight--; setOutcome('error', 'Fehler', `${err.message} – Aufnahme verloren (kein Speicher)`); }
    return;
  }
  renderPending();
  processRecording(id, t0, '');
}

// Seite geht waehrend der Aufnahme in den Hintergrund: sauber beenden (Audio bleibt erhalten)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (recording === true && recorder && recorder.state === 'recording') { pressed = false; ui.rec.classList.remove('active'); releaseTime = performance.now(); try { recorder.stop(); } catch (_) {} }
    releaseStreamSoon(true);
  } else {
    retryPending('sichtbar');
  }
});
window.addEventListener('online', () => retryPending('online'));
window.addEventListener('pageshow', () => retryPending('pageshow'));

// ---------------------------------------------------------------- Eingabe-Handling (iOS-fest)
const btn = ui.rec;
btn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) {} onPress(); });
btn.addEventListener('pointerup', (e) => { e.preventDefault(); onRelease(); });
btn.addEventListener('pointercancel', onRelease);
btn.addEventListener('lostpointercapture', onRelease);
btn.addEventListener('contextmenu', (e) => e.preventDefault());
btn.addEventListener('selectstart', (e) => e.preventDefault());
btn.addEventListener('dragstart', (e) => e.preventDefault());
btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
btn.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
// Doppeltipp-Zoom unterbinden
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 350 && e.target === btn) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
// Seite selbst nicht scrollen lassen (Liste scrollt in .bottom)
document.addEventListener('touchmove', (e) => { if (!e.target.closest || !e.target.closest('.bottom')) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- Key-UI
function renderKeyInfo() {
  const k = getKey();
  ui.keyinfo.textContent = k ? `Key gespeichert (…${k.slice(-4)}), nur in diesem Browser.` : 'Kein Key. Eintragen und speichern.';
  if (!k) ui.settings.open = true;
}
ui.keysave.addEventListener('click', () => {
  const v = ui.key.value.trim();
  if (!v) return;
  if (!setKey(v)) { ui.keyinfo.textContent = 'Speichern fehlgeschlagen (localStorage gesperrt?)'; return; }
  ui.key.value = ''; renderKeyInfo(); retryPending('key');
});

// ---------------------------------------------------------------- Start
(async function init() {
  render(); renderKeyInfo();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  log(`standalone=${window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches} mime=${typeof MediaRecorder !== 'undefined' ? pickMimeType((m) => MediaRecorder.isTypeSupported(m)) || '(default)' : 'kein MediaRecorder'}`);
  await renderPending();
  retryPending('start');
})();
