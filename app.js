'use strict';
/* Wegwerf-Spike: Halten-Sprechen-Loslassen -> OpenAI-Transkription.
   Kein Key im Code: er liegt nur in localStorage des Browsers. */

// ---------------------------------------------------------------- Konfig
const CONFIG = {
  endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  model: 'gpt-transcribe',      // laut OpenAI-Doku empfohlen; Vorgaenger (gpt-4o-transcribe, whisper-1) deprecated
  languages: ['de'],            // gpt-transcribe: "languages[]" statt "language"
  version: 'v2',
  timesliceMs: 1000,            // WebKit liefert bei <=100 ms leere Blobs (Bug 301507); 1000 ms ist sicher
  finishGraceMs: 1200,          // so lange auf ein spaetes dataavailable nach onstop warten, wenn noch nichts da ist
  stopTimeoutMs: 3000,          // falls onstop nie kommt
  pcmFallback: true,            // paralleler WAV-Mitschnitt, nur genutzt wenn MediaRecorder 0 Bytes liefert
  pcmRate: 16000,
  minRecordingMs: 700,          // kuerzer = versehentliches Antippen -> verwerfen
  requestTimeoutMs: 60000,
  streamIdleMs: 30000,          // Mikrofon nach Loslassen so lange offen halten (schnellere Folgeaufnahmen)
  keyStorage: 'spike.openaiKey',
};

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), detail: $('detail'), rec: $('rec'), results: $('results'),
  pending: $('pending'), key: $('key'), keysave: $('keysave'), keyinfo: $('keyinfo'),
  log: $('log'), jsver: $('jsver'), settings: $('settings'),
};

function log(msg) {
  const t = new Date().toLocaleTimeString('de-DE');
  ui.log.textContent = `${t} ${msg}\n` + ui.log.textContent.slice(0, 20000);
  try { console.log(msg); } catch (_) {}
}

// ---------------------------------------------------------------- Key (nur localStorage)
function getKey() { try { return localStorage.getItem(CONFIG.keyStorage) || ''; } catch (_) { return ''; } }
function setKey(v) { try { localStorage.setItem(CONFIG.keyStorage, v); return true; } catch (_) { return false; } }

// ---------------------------------------------------------------- Audioformat
// iOS Safari: audio/mp4 (AAC). Chrome/Android: audio/webm;codecs=opus. Zur Laufzeit erkennen.
const MIME_CANDIDATES = [
  'audio/mp4', 'audio/aac', // ohne codecs-Zusatz (Vermutung c)
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
  if (recording === 'stopping') o = { kind: 'processing', text: 'Beende Aufnahme …', detail: '' };
  else if (recording) o = { kind: recording === 'starting' ? 'starting' : 'recording', text: recording === 'starting' ? 'Mikrofon startet …' : 'Nimmt auf …', detail: lastOutcome.detail };
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
let cur = null;               // aktuelle Aufnahme-Sitzung (siehe onPress)
let pcmCtx = null;            // AudioContext fuer den WAV-Notfall-Mitschnitt (einmal pro Seite)

function trackState(t) {
  t = t || (stream && stream.getAudioTracks()[0]);
  if (!t) return 'kein Track';
  let rate = '';
  try { const st = t.getSettings(); rate = ` rate=${st.sampleRate || '?'} ch=${st.channelCount || '?'}`; } catch (_) {}
  return `muted=${t.muted} readyState=${t.readyState} enabled=${t.enabled}${rate}`;
}
function watchTrack(t) {
  for (const n of ['mute', 'unmute', 'ended']) t.addEventListener(n, () => log(`TRACK-EVENT ${n} (${trackState(t)})`));
}

async function ensureStream() {
  clearTimeout(idleTimer);
  if (stream && stream.getTracks().every((t) => t.readyState === 'live')) return stream;
  // bewusst ohne Constraints-Spielereien (Vermutung: echoCancellation & Co. koennen auf iOS stoeren)
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const t = stream.getAudioTracks()[0];
  if (t) watchTrack(t);
  log(`stream neu: ${trackState()}`);
  return stream;
}
function releaseStreamSoon(immediate) {
  clearTimeout(idleTimer);
  const stop = () => { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } };
  if (immediate) stop(); else idleTimer = setTimeout(stop, CONFIG.streamIdleMs);
}

// --- WAV-Notfall-Mitschnitt: unabhaengig von MediaRecorder, nur genutzt wenn MediaRecorder 0 Bytes liefert
function primePcmContext() { // muss synchron in der Nutzergeste laufen (iOS)
  if (!CONFIG.pcmFallback) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!pcmCtx) pcmCtx = new AC();
    if (pcmCtx.state !== 'running') pcmCtx.resume().catch(() => {});
  } catch (e) { log(`pcm ctx: ${e && e.message}`); }
}
function startPcm(s) {
  if (!CONFIG.pcmFallback || !pcmCtx) return null;
  try {
    if (!pcmCtx.createScriptProcessor) return null;
    const p = { src: pcmCtx.createMediaStreamSource(s), proc: pcmCtx.createScriptProcessor(4096, 1, 1), chunks: [], frames: 0, peak: 0, rate: pcmCtx.sampleRate, on: true };
    p.proc.onaudioprocess = (e) => {
      if (!p.on) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0)); // Kopie, Puffer wird wiederverwendet
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p.peak) p.peak = a; }
      p.chunks.push(d); p.frames += d.length;
    };
    p.src.connect(p.proc); p.proc.connect(pcmCtx.destination); // Ausgabe bleibt still (Nullpuffer)
    return p;
  } catch (e) { log(`pcm start: ${e && e.message}`); return null; }
}
function stopPcm(p) {
  if (!p) return null;
  p.on = false;
  try { p.src.disconnect(); p.proc.disconnect(); p.proc.onaudioprocess = null; } catch (_) {}
  log(`pcm: ${p.frames} Samples @${p.rate}Hz, Spitzenpegel=${p.peak.toFixed(4)}`);
  return p;
}
function encodeWav(p, outRate) {
  const total = p.frames, ratio = p.rate / outRate, outLen = Math.floor(total / ratio);
  const flat = new Float32Array(total); let o = 0;
  for (const c of p.chunks) { flat.set(c, o); o += c.length; }
  const buf = new ArrayBuffer(44 + outLen * 2), v = new DataView(buf);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + outLen * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.min(total, Math.floor((i + 1) * ratio)));
    let sum = 0; for (let k = a; k < b; k++) sum += flat[k];
    const s = Math.max(-1, Math.min(1, sum / (b - a)));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function onPress() {
  if (recording) return;
  pressed = true; recording = 'starting'; ui.rec.classList.add('active'); render();
  primePcmContext();
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
  const sess = { rec: null, chunks: [], nEvents: 0, bytes: 0, stopCalled: false, stopped: false, finished: false,
                 timer: null, startedAt: 0, releaseTime: 0, pcm: null };
  try { sess.rec = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); }
  catch (e) { recording = false; pressed = false; ui.rec.classList.remove('active'); setOutcome('error', 'Fehler', `Recorder: ${e.message}`); return; }
  const rec = sess.rec;
  const since = () => Math.round(performance.now() - sess.startedAt);
  rec.onstart = () => log(`onstart t=${since()}ms state=${rec.state}`);
  rec.ondataavailable = (ev) => {
    const size = ev.data ? ev.data.size : -1;
    sess.nEvents++;
    const rel = sess.stopped ? 'NACH onstop' : sess.stopCalled ? 'nach stop(), vor onstop' : 'vor stop()';
    log(`dataavailable #${sess.nEvents} ${size}B type="${ev.data && ev.data.type}" ${rel} t=${since()}ms state=${rec.state}`);
    if (size > 0) {
      sess.chunks.push(ev.data); sess.bytes += size;
      if (sess.stopped) scheduleFinish(sess, 200); // Nachzuegler nach onstop: kurz auf weitere warten
    }
  };
  rec.onerror = (ev) => log(`recorder error: ${ev.error && ev.error.name} ${ev.error && ev.error.message}`);
  rec.onstop = () => {
    sess.stopped = true;
    log(`onstop t=${since()}ms state=${rec.state} events=${sess.nEvents} bytes=${sess.bytes} track=${trackState()}`);
    // Schonfrist: mit Daten kurz, ohne Daten laenger auf ein spaetes dataavailable warten
    scheduleFinish(sess, sess.bytes > 0 ? 300 : CONFIG.finishGraceMs);
  };
  sess.pcm = startPcm(s);
  log(`start-Versuch mime=${mime || '(default)'} timeslice=${CONFIG.timesliceMs} track=${trackState()} pcm=${sess.pcm ? 'an' : 'aus'}`);
  rec.start(CONFIG.timesliceMs);
  sess.startedAt = performance.now();
  cur = sess; recording = true; render();
  log(`gestartet: rec.mimeType=${rec.mimeType} state=${rec.state}`);
}

function scheduleFinish(sess, delay) {
  if (sess.finished) return;
  clearTimeout(sess.timer);
  sess.timer = setTimeout(() => finishRecording(sess), delay);
}

function stopRecording(why) {
  const sess = cur;
  if (!sess || sess.stopCalled) return;
  sess.stopCalled = true; sess.releaseTime = performance.now();
  recording = 'stopping'; render();
  log(`stop() (${why}) t=${Math.round(sess.releaseTime - sess.startedAt)}ms state=${sess.rec.state} track=${trackState()}`);
  try { sess.rec.stop(); } catch (e) { log(`stop() Fehler: ${e.message}`); scheduleFinish(sess, 100); return; }
  scheduleFinish(sess, CONFIG.stopTimeoutMs); // falls onstop nie kommt (bekannter iOS-Fehler)
}

function onRelease() {
  const wasPressed = pressed;
  pressed = false; ui.rec.classList.remove('active');
  if (!wasPressed) return;
  if (recording === true) stopRecording('losgelassen');
  // recording === 'starting': onPress erkennt pressed=false selbst
}

async function finishRecording(sess) {
  if (sess.finished) return;
  sess.finished = true; clearTimeout(sess.timer);
  const t0 = sess.releaseTime || performance.now();
  const durationMs = t0 - sess.startedAt;
  const rawType = sess.rec.mimeType || mime || (sess.chunks[0] && sess.chunks[0].type) || '';
  const type = rawType.split(';')[0].trim(); // "audio/mp4; codecs=..." -> "audio/mp4"
  let blob = new Blob(sess.chunks, { type });
  const pcm = stopPcm(sess.pcm);
  cur = null; recording = false;
  releaseStreamSoon(document.hidden);
  log(`ENDE ${durationMs.toFixed(0)}ms MediaRecorder: ${blob.size}B in ${sess.nEvents} Event(s), onstop=${sess.stopped} track=${trackState()}`);

  if (durationMs < CONFIG.minRecordingMs) {
    setOutcome('error', 'Zu kurz – verworfen', `${(durationMs / 1000).toFixed(1)} s (min. ${CONFIG.minRecordingMs / 1000} s)`);
    return;
  }
  let note = '';
  if (blob.size === 0) {
    if (pcm && pcm.frames > 0 && pcm.peak > 0) {
      blob = encodeWav(pcm, CONFIG.pcmRate); note = 'WAV-Notfallpfad (MediaRecorder leer)';
      log(`MediaRecorder leer -> WAV-Fallback ${blob.size}B`);
    } else {
      setOutcome('error', 'Keine Audiodaten erhalten', `MediaRecorder lieferte 0 Bytes (${sess.nEvents} Events, onstop=${sess.stopped}); Details im Log`);
      return;
    }
  }
  let id;
  try { id = await saveRecording(blob, durationMs); }
  catch (e) {
    log(`IndexedDB: ${e && e.message}`);
    setOutcome('error', 'Fehler', 'Zwischenspeichern fehlgeschlagen – wird trotzdem direkt gesendet');
    inFlight++; render();
    try { const text = await transcribe(blob); const ms = performance.now() - t0; addResult(text, ms, 'ohne Zwischenspeicher'); inFlight--; setOutcome('done', 'Fertig', `${(ms / 1000).toFixed(1)} s`); }
    catch (err) { inFlight--; setOutcome('error', 'Fehler', `${err.message} – Aufnahme verloren (kein Speicher)`); }
    return;
  }
  renderPending();
  processRecording(id, t0, note);
}

// Seite geht waehrend der Aufnahme in den Hintergrund: sauber beenden (Audio bleibt erhalten)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    log('visibilitychange: hidden');
    if (recording === true) { pressed = false; ui.rec.classList.remove('active'); stopRecording('hidden'); }
    if (!recording) releaseStreamSoon(true); // sonst beendet finishRecording den Stream
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
  ui.jsver.textContent = `js ${CONFIG.version}`;
  log(`${CONFIG.version} ${navigator.userAgent}`);
  log(`standalone=${window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches} mime=${typeof MediaRecorder !== 'undefined' ? pickMimeType((m) => MediaRecorder.isTypeSupported(m)) || '(default)' : 'kein MediaRecorder'}`);
  await renderPending();
  retryPending('start');
})();
