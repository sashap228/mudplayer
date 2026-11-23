// MudPlayer — main process
const { app, BrowserWindow, ipcMain, screen, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const UA = 'MudPlayer/0.1 (desktop; github.com/muderSSS)';
const APP_NAME = 'MudPlayer';

/* ───────────── logging ───────────── */
const LOG_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'logs') : path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, 'main.log');
try { fs.writeFileSync(LOG_FILE, ''); } catch {}
function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
process.on('uncaughtException', (e) => log('UNCAUGHT', e));
process.on('unhandledRejection', (e) => log('UNHANDLED', e));

if (!app.requestSingleInstanceLock()) app.quit();

let main = null, island = null, port = 0;
let islandMode = 'background';   // 'always' | 'background' (когда окно плеера свёрнуто/не в фокусе) | 'off'
let hasTrack = false;

/* простое JSON-хранилище главного процесса (кэш, совпадения, client_id) */
const store = (() => {
  let file = null, data = {}, timer = null;
  const load = () => { if (file) return; file = path.join(app.getPath('userData'), 'mudplayer-store.json'); try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; } };
  return {
    get: (k, d) => { load(); return data[k] ?? d; },
    set: (k, v) => { load(); data[k] = v; clearTimeout(timer); timer = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { log('store write', e.message); } }, 400); },
  };
})();
const sc = require('./soundcloud')({ log: (...a) => log(...a), store });
const { importSpotify, importCsv } = require('./spotify');
const send = (ch, ...a) => { if (main && !main.isDestroyed()) main.webContents.send(ch, ...a); };

/* ───────────── yt-dlp ───────────── */
const BIN_DIR = () => path.join(app.getPath('userData'), 'bin');
const YTDLP_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
const YTDLP = () => path.join(BIN_DIR(), YTDLP_NAME);
let ytdlpReady = null;
let ytdlpStatus = { state: 'checking', progress: 0, version: '' };
const setStatus = (s) => { ytdlpStatus = { ...ytdlpStatus, ...s }; send('boot', ytdlpStatus); };

function ensureYtdlp() {
  if (ytdlpReady) return ytdlpReady;
  ytdlpReady = (async () => {
    fs.mkdirSync(BIN_DIR(), { recursive: true });
    if (!fs.existsSync(YTDLP()) || fs.statSync(YTDLP()).size < 1e6) {
      setStatus({ state: 'downloading', progress: 0 });
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_NAME}`;
      log('downloading yt-dlp', url);
      const r = await net.fetch(url);
      if (!r.ok) throw new Error(`yt-dlp download HTTP ${r.status}`);
      const total = +r.headers.get('content-length') || 0;
      const reader = r.body.getReader(); const chunks = []; let got = 0, lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(Buffer.from(value)); got += value.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; setStatus({ progress: pct }); }
      }
      fs.writeFileSync(YTDLP() + '.part', Buffer.concat(chunks));
      fs.renameSync(YTDLP() + '.part', YTDLP());
      if (process.platform !== 'win32') fs.chmodSync(YTDLP(), 0o755);
      log('yt-dlp downloaded', got, 'bytes');
    }
    const v = (await runYtdlp(['--version'], { timeout: 20000, base: false })).trim();
    setStatus({ state: 'ready', version: v, progress: 100 });
    log('yt-dlp version', v);
  })().catch((e) => { log('yt-dlp setup failed', e); setStatus({ state: 'error', error: e.message }); ytdlpReady = null; throw e; });
  return ytdlpReady;
}

// node есть в PATH (раз приложение запущено через npm) — отдаём его yt-dlp как JS-рантайм для YouTube
const BASE_ARGS = ['--no-warnings', '--js-runtimes', 'node'];
function runYtdlp(args, { timeout = 45000, base = true } = {}) {
  return new Promise((res, rej) => {
    const full = base ? [...BASE_ARGS, ...args] : args;
    const p = spawn(YTDLP(), full, { windowsHide: true });
    let out = '', err = '';
    const to = setTimeout(() => { p.kill(); rej(new Error('yt-dlp timeout')); }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(to); rej(e); });
    p.on('close', (code) => {
      clearTimeout(to);
      if (code === 0) return res(out);
      // старый yt-dlp без --js-runtimes → повторяем без флага
      if (base && /no such option.*js-runtimes/i.test(err)) {
        BASE_ARGS.splice(1, 2);
        return runYtdlp(args, { timeout, base }).then(res, rej);
      }
      rej(new Error(err.trim().split('\n').slice(-3).join(' | ') || `yt-dlp exit ${code}`));
    });
  });
}

/* ───────────── helpers ───────────── */
const str = (x) => {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  if (typeof x.text === 'string') return x.text;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text).join('');
  const s = typeof x.toString === 'function' ? x.toString() : '';
  return s === '[object Object]' ? '' : s;
};
const hiYT = (u) => (u || '').replace(/=w\d+-h\d+(-[a-z0-9-]+)?$/i, '=w600-h600-l90-rj').replace(/\/(default|mqdefault|sddefault)\.jpg/, '/hqdefault.jpg');
const parseDur = (s) => { if (typeof s === 'number') return s; if (!s) return 0; return String(s).split(':').reduce((a, b) => a * 60 + (+b || 0), 0); };
function bestThumb(list) {
  const arr = Array.isArray(list) ? list : list?.contents || list?.thumbnails || [];
  if (!arr.length) return '';
  return [...arr].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}
function splitArtistTitle(title, artist) {
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m && (!artist || /topic|vevo|official|records|music$/i.test(artist) || m[1].toLowerCase().includes(artist.toLowerCase().slice(0, 4)))) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: (artist || '').replace(/\s*-\s*Topic$/i, ''), title };
}
const cleanTitle = (t) => t
  .replace(/\s*[([【][^)\]】]*(official|video|audio|lyric|клип|visuali[sz]er|remaster|mv|hd|4k|премьера|текст)[^)\]】]*[)\]】]/gi, '')
  .replace(/\s*[([](feat|ft)\.?[^)\]]*[)\]]/gi, '').replace(/\s+(feat|ft)\.?\s.+$/i, '').trim();

/* ───────────── providers ───────────── */
let ytPromise = null;
function getYT() {
  if (!ytPromise) ytPromise = (async () => {
    const mod = await import('youtubei.js');
    const Innertube = mod.Innertube || mod.default?.Innertube;
    const yt = await Innertube.create({ retrieve_player: false, lang: 'ru', location: 'BY' });
    log('youtubei.js ready');
    return yt;
  })().catch((e) => { ytPromise = null; throw e; });
  return ytPromise;
}

function mapYTM(i) {
  const vid = i.id || i.video_id || i.videoId;
  if (!vid) return null;
  const artists = i.artists || i.authors || (i.author ? [i.author] : []);
  let artist = artists.map((a) => str(a.name)).filter(Boolean).join(', ');
  const t = splitArtistTitle(str(i.title), artist);
  return {
    id: 'yt:' + vid, src: 'yt', vid, title: t.title, artist: t.artist || artist,
    artistId: artists[0]?.channel_id || artists[0]?.id, album: str(i.album?.name),
    duration: i.duration?.seconds ?? parseDur(str(i.duration?.text ?? i.duration)),
    cover: hiYT(bestThumb(i.thumbnails ?? i.thumbnail)) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
  };
}

async function ytmSearch(q, limit = 20) {
  try {
    const yt = await getYT();
    const r = await yt.music.search(q, { type: 'song' });
    let items = r.songs?.contents || [];
    if (!items.length) items = (r.contents || []).flatMap((s) => s.contents || []);
    const out = items.map(mapYTM).filter((x) => x && x.title).slice(0, limit);
    if (out.length) return out;
    throw new Error('empty youtubei result');
  } catch (e) {
    log('ytm search via youtubei failed → yt-dlp:', e.message);
    await ensureYtdlp();
    const j = JSON.parse(await runYtdlp(['--flat-playlist', '-J', `ytsearch${limit}:${q}`]));
    return (j.entries || []).map((e) => {
      const t = splitArtistTitle(e.title || '', e.channel || e.uploader);
      return { id: 'yt:' + e.id, src: 'yt', vid: e.id, title: t.title, artist: t.artist, duration: e.duration || 0,
        cover: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` };
    });
  }
}

const scSearch = (q, limit = 14) => sc.search(q, limit);

let auHost = null;
async function audiusHost() {
  if (auHost) return auHost;
  try {
    const r = await net.fetch('https://api.audius.co'); const j = await r.json();
    auHost = j.data[Math.floor(Math.random() * j.data.length)];
  } catch { auHost = 'https://discoveryprovider.audius.co'; }
  return auHost;
}
const mapAu = (t) => ({ id: 'au:' + t.id, src: 'au', aid: t.id, title: t.title, artist: t.user?.name || '', artistId: t.user?.id,
  duration: t.duration || 0, cover: t.artwork?.['1000x1000'] || t.artwork?.['480x480'] || t.artwork?.['150x150'] || '' });
async function auGet(p) {
  const h = await audiusHost();
  const r = await net.fetch(`${h}/v1${p}${p.includes('?') ? '&' : '?'}app_name=${APP_NAME}`);
  if (!r.ok) throw new Error('audius ' + r.status);
  return (await r.json()).data || [];
}
const auSearch = async (q, limit = 12) => (await auGet(`/tracks/search?query=${encodeURIComponent(q)}`)).slice(0, limit).map(mapAu);
const auTrending = async () => (await auGet('/tracks/trending?time=week')).slice(0, 20).map(mapAu);

/* метаданные треков, прошедших через главный процесс (поток получает от плеера только id) */
const ytMeta = new Map(), scByUrl = new Map();
function remember(list) {
  for (const t of list || []) {
    if (!t) continue;
    if (t.src === 'yt' && t.vid) ytMeta.set(t.vid, { title: t.title, artist: t.artist, duration: t.duration });
    if (t.src === 'sc' && t.url && t.scid) scByUrl.set(t.url, t.scid);
  }
  return list;
}
async function ytBasic(vid) {
  try {
    const yt = await getYT(); const i = await yt.getBasicInfo(vid); const b = i.basic_info || {};
    return { title: b.title || '', artist: (b.author || b.channel?.name || '').replace(/\s*-\s*Topic$/i, ''), duration: b.duration || 0 };
  } catch (e) { log('ytBasic failed', e.message); return {}; }
}
const settle = async (label, p) => { try { return await p; } catch (e) { log(label, 'failed:', e.message); return []; } };

async function searchAll(q, sources) {
  const t0 = Date.now();
  const [yt, sc, au] = await Promise.all([
    sources.yt ? settle('yt', ytmSearch(q)) : [],
    sources.sc ? settle('sc', scSearch(q)) : [],
    sources.au ? settle('au', auSearch(q)) : [],
  ]);
  log(`search "${q}" yt=${yt.length} sc=${sc.length} au=${au.length} ${Date.now() - t0}ms`);
  remember(yt); remember(sc);
  return { yt, sc, au };
}

/* Моя волна: радио YouTube Music от последних треков + жанры по всем источникам */
const GENRE_Q = { 'рэп': 'русский рэп', 'поп': 'pop hits', 'электроника': 'electronic', 'инди': 'indie', 'рок': 'rock', 'lo-fi': 'lofi beats',
  'фонк': 'phonk', 'r&b': 'rnb', 'джаз': 'jazz', 'хаус': 'deep house', 'альтернатива': 'alternative', 'гиперпоп': 'hyperpop' };
async function ytRadio(vid) {
  const yt = await getYT();
  const up = await yt.music.getUpNext(vid, true);
  return (up.contents || []).map(mapYTM).filter(Boolean).filter((t) => t.vid !== vid);
}
const MOOD_Q = { 'бодрое': ['energetic', 'бодрый', 'workout'], 'спокойное': ['chill', 'calm', 'спокойный'], 'весёлое': ['happy', 'feel good', 'весёлый'], 'грустное': ['sad', 'грустный', 'melancholy'] };
const LANG_Q = { 'русский': 'русский', 'иностранный': 'english', 'без слов': 'instrumental' };
async function wave({ seeds = [], genres = [], sources, mood = '', character = 'любимое', lang = '', exclude = [] }) {
  const jobs = [];
  const fav = character === 'любимое', fresh = character === 'незнакомое', pop = character === 'популярное';
  // 1) радио от твоих треков: «похожие» SoundCloud
  const seedN = fav ? 5 : fresh ? 2 : 1;
  for (const sd of seeds.slice(0, seedN)) {
    if (sources.sc !== false) jobs.push(settle('sc related', (async () => {
      const base = sd.src === 'sc' ? sd : await matchTrack({ title: sd.title, artist: sd.artist, duration: sd.duration }, { only: 'sc' });
      return base?.scid ? sc.related(base.scid) : [];
    })()));
    if (sources.yt && !ytBlocked && sd.src === 'yt') jobs.push(settle('radio', ytRadio(sd.vid)));
  }
  // 2) настроение / язык / жанры
  const moodWords = MOOD_Q[mood] || [''];
  const langWord = LANG_Q[lang] || '';
  const gs = genres.length ? genres : (seeds.length && !fresh && !mood && !lang ? [] : ['']);
  for (const g of gs.slice(0, 4)) {
    for (const mw of moodWords.slice(0, mood ? 2 : 1)) {
      const q = [langWord, GENRE_Q[g] || g, mw].filter(Boolean).join(' ') || 'хиты';
      if (sources.sc) jobs.push(settle('wave sc', sc.search(q, 20).then((l) => l.filter((t) => t.duration > 70 && t.duration < 480))));
      if (sources.yt) jobs.push(settle('wave yt', ytmSearch(q, 12)));
      if (sources.au && (lang !== 'русский')) jobs.push(settle('wave au', auSearch(q, 8)));
    }
  }
  // 3) популярное: чарты
  if (pop || (!seeds.length && !genres.length)) {
    if (sources.sc) jobs.push(settle('charts', sc.charts('trending')), settle('charts top', sc.charts('top')));
    if (sources.yt) jobs.push(settle('hits', ytmSearch(lang === 'иностранный' ? 'top hits 2026' : 'хиты 2026', 20)));
  }
  const lists = (await Promise.all(jobs)).map((l) => l.sort(() => Math.random() - 0.5));
  const seen = new Set([...seeds.map((s) => norm(s.artist + ' ' + s.title)), ...exclude]);
  const knownArtists = fresh ? new Set(seeds.map((s) => norm((s.artist || '').split(',')[0]))) : null;
  const out = [];
  for (let i = 0; out.length < 50 && lists.some((l) => l[i]); i++) {
    for (const l of lists) {
      const t = l[i]; if (!t) continue;
      const k = norm(t.artist + ' ' + t.title); if (seen.has(k)) continue;
      if (knownArtists && knownArtists.has(norm((t.artist || '').split(',')[0]))) continue;
      seen.add(k); out.push(t);
    }
  }
  log('wave', character, mood, lang, out.length, 'tracks', lists.map((l) => l.length).join('/'));
  return remember(out);
}

async function artistPage({ name, src, artistId }, sources) {
  const res = await searchAll(name, sources);
  const n = name.toLowerCase().split(',')[0].trim();
  const own = [...res.yt, ...res.sc, ...res.au].filter((t) => t.artist.toLowerCase().includes(n));
  let au = [];
  if (src === 'au' && artistId) au = await settle('au artist', auGet(`/users/${artistId}/tracks`).then((l) => l.map(mapAu)));
  if (src === 'sc' && artistId) au = au.concat(await settle('sc artist', sc.userTracks(artistId)));
  const all = [...own, ...au];
  const seen = new Set();
  return all.filter((t) => { const k = t.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ───────────── lyrics (LRCLIB) ───────────── */
// LRC и «расширенный» LRC с таймингом слов: [00:12.34] <00:12.34>слово <00:12.80>слово
function parseLRC(lrc) {
  const out = [];
  let offset = 0;
  const om = lrc.match(/\[offset:\s*([+-]?\d+)\]/i); if (om) offset = +om[1] / 1000;
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '');
    let words = null;
    if (/<\d+:\d+(?:[.:]\d+)?>/.test(body)) {
      words = [];
      const re = /<(\d+):(\d+(?:[.:]\d+)?)>([^<]*)/g; let m;
      while ((m = re.exec(body))) { const w = m[3]; if (w.trim()) words.push([+m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, w]); }
      if (!words.length) words = null;
    }
    const text = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || '♪';
    for (const m of tags) out.push(words ? [+m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, text, words] : [+m[1] * 60 + parseFloat(m[2].replace(':', '.')) - offset, text]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
const lyrCache = new Map();
// Возвращаем несколько синхронных версий (разные издания трека различаются вступлением):
// плеер выберет ту, чья длительность ближе к реально играющему файлу.
async function lyrics(t) {
  const title = cleanTitle(t.title).replace(/\s*[([](prod|при уч)[^)\]]*[)\]]/gi, '').trim();
  const artist = (t.artist || '').split(/,|&| x | feat/i)[0].trim();
  const key = (artist + '|' + title).toLowerCase();
  if (lyrCache.has(key)) return lyrCache.get(key);
  const get = async (p) => { try { const r = await net.fetch('https://lrclib.net/api' + p, { headers: { 'User-Agent': UA } }); return r.ok ? r.json() : null; } catch { return null; } };
  const [exact, byFields, byQ] = await Promise.all([
    t.duration ? get(`/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${Math.round(t.duration)}`) : null,
    get(`/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`),
    get(`/search?q=${encodeURIComponent(artist + ' ' + title)}`),
  ]);
  const all = [exact, ...(byFields || []), ...(byQ || [])].filter(Boolean);
  const nt = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const relevant = all.filter((x) => (x.trackName || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes(nt.slice(0, 12)) || x === exact);
  const seenIds = new Set();
  const versions = relevant.filter((x) => x.syncedLyrics && !seenIds.has(x.id) && seenIds.add(x.id))
    .sort((a, b) => Math.abs((a.duration || 0) - (t.duration || 0)) - Math.abs((b.duration || 0) - (t.duration || 0)))
    .slice(0, 5).map((x) => ({ id: x.id, duration: x.duration || 0, synced: parseLRC(x.syncedLyrics), words: /<\d+:\d+/.test(x.syncedLyrics) }));
  const plain = relevant.find((x) => x.plainLyrics)?.plainLyrics || null;
  const res = versions.length || plain || relevant.some((x) => x.instrumental)
    ? { synced: versions[0]?.synced || null, versions, plain, instrumental: relevant.some((x) => x.instrumental) && !versions.length && !plain }
    : null;
  log('lyrics', key, res ? `${versions.length} synced versions (${versions.map((v) => Math.round(v.duration)).join('/')}s)${versions.some((v) => v.words) ? ' +words' : ''}` : 'none');
  lyrCache.set(key, res);
  return res;
}

/* ───────────── streaming ─────────────
   YouTube: yt-dlp качает файл ЦЕЛИКОМ в кэш (сам разбивает на чанки и обходит троттлинг googlevideo),
   а мы отдаём плееру файл по мере роста. Так нет обрыва на 15-й секунде, а повторное прослушивание мгновенное.
   SoundCloud: прямой mp3 (Range-прокси) или HLS, собранный в один буфер.  Audius: прокси. */
const MIME = { webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg' };
const CACHE_DIR = () => path.join(app.getPath('userData'), 'audio-cache');
const CACHE_LIMIT = 1.5e9;
const dls = new Map();
let ytBlocked = false;           // YouTube требует вход (бот-проверка) → такие треки играем через SoundCloud
let ytCookies = '';              // браузер для --cookies-from-browser (по желанию)
const isBotErr = (m) => /confirm you.?re not a bot|sign in to confirm|cookies-from-browser|HTTP Error 429/i.test(m || '');

function cacheIndex() { return store.get('cache', {}); }
function cacheTouch(vid, rec) { const c = cacheIndex(); c[vid] = { ...(c[vid] || {}), ...rec, at: Date.now() }; store.set('cache', c); }
function cachePurge() {
  const c = cacheIndex(); let total = Object.values(c).reduce((s, r) => s + (r.total || 0), 0);
  total = Object.values(c).filter((r) => !r.pinned).reduce((s, r) => s + (r.total || 0), 0);
  for (const [vid, r] of Object.entries(c).sort((a, b) => a[1].at - b[1].at)) {
    if (total < CACHE_LIMIT) break;
    if (dls.has(vid) || r.pinned) continue;
    try { fs.unlinkSync(path.join(CACHE_DIR(), r.file)); } catch {}
    total -= r.total || 0; delete c[vid];
  }
  store.set('cache', c);
}

function ytDownload(vid) { return dlFile(vid, `https://music.youtube.com/watch?v=${vid}`, 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio'); }
function dlFile(vid, pageUrl, fmt) {
  if (dls.has(vid)) return dls.get(vid);
  const rec = cacheIndex()[vid];
  if (rec?.done && fs.existsSync(path.join(CACHE_DIR(), rec.file))) {
    const e = { vid, file: path.join(CACHE_DIR(), rec.file), mime: rec.mime, total: rec.total, size: rec.total, done: true, err: null, waiters: new Set() };
    e.ready = Promise.resolve(); cacheTouch(vid, {});
    return e;
  }
  const e = { vid, file: null, mime: 'audio/webm', total: 0, size: 0, done: false, err: null, waiters: new Set() };
  const wake = () => { e.waiters.forEach((f) => f()); e.waiters.clear(); };
  let readyRes, readyRej;
  e.ready = new Promise((a, b) => { readyRes = a; readyRej = b; });
  e.ready.catch(() => {});
  dls.set(vid, e);
  (async () => {
    await ensureYtdlp();
    fs.mkdirSync(CACHE_DIR(), { recursive: true });
    const t0 = Date.now();
    const isYt = /youtube\.com/.test(pageUrl);
    const args = [...BASE_ARGS, ...(ytCookies && isYt ? ['--cookies-from-browser', ytCookies] : []), '-f', fmt, '--no-playlist', '--no-part', '--no-mtime',
      '--print', 'before_dl:MPINFO %(ext)s %(filesize,filesize_approx|0)s', '--no-simulate', '--progress', '--newline',
      '--progress-template', 'download:MPPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
      '-o', path.join(CACHE_DIR(), `${vid}.%(ext)s`), pageUrl];
    const p = spawn(YTDLP(), args, { windowsHide: true });
    e.proc = p;
    let errTail = '';
    const onLine = (line) => {
      let m;
      if ((m = line.match(/MPINFO (\w+) (\d+)/))) {
        e.file = path.join(CACHE_DIR(), `${vid}.${m[1]}`); e.mime = MIME[m[1]] || 'audio/webm';
        if (+m[2]) e.total = +m[2];
        log(`yt ${vid} start ${m[1]} ~${Math.round(+m[2] / 1024)}KB after ${Date.now() - t0}ms`);
      } else if ((m = line.match(/MPPROG (\d+) (\S+) (\S+)/))) {
        e.size = +m[1];
        if (/^\d+$/.test(m[2])) e.total = +m[2];
        if (e.file && e.size > 0) readyRes();
        wake();
      } else if (line.trim()) errTail = (errTail + '\n' + line).slice(-600);
    };
    for (const s of [p.stdout, p.stderr]) {
      let buf = '';
      s.on('data', (d) => { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); parts.forEach(onLine); });
    }
    p.on('close', (code) => {
      dls.delete(vid);
      if (code === 0 && e.file && fs.existsSync(e.file)) {
        e.size = e.total = fs.statSync(e.file).size; e.done = true;
        cacheTouch(vid, { file: path.basename(e.file), mime: e.mime, total: e.total, done: true });
        log(`yt ${vid} done ${Math.round(e.total / 1024)}KB in ${Date.now() - t0}ms`);
        readyRes(); cachePurge();
      } else {
        e.err = new Error(errTail.trim().split('\n').slice(-2).join(' | ') || `yt-dlp exit ${code}`);
        log(`yt ${vid} failed:`, e.err.message);
        if (isYt && isBotErr(e.err.message) && !ytBlocked) { ytBlocked = true; send('notice', 'yt-blocked'); log('YouTube bot-check → fallback to SoundCloud for YouTube tracks'); }
        readyRej(e.err);
        if (e.file) try { fs.unlinkSync(e.file); } catch {}
      }
      wake();
    });
  })().catch((err) => { e.err = err; dls.delete(vid); readyRej(err); wake(); });
  return e;
}

const waitData = (e, ms = 15000) => new Promise((res) => { const t = setTimeout(res, ms); e.waiters.add(() => { clearTimeout(t); res(); }); });
const writeAsync = (res, buf) => new Promise((ok) => (res.write(buf) ? ok() : res.once('drain', ok)));

async function serveGrowing(req, res, e) {
  try { await e.ready; } catch (err) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end(err.message); }
  // ждём размер файла (обычно уже известен) — без него не будет перемотки
  for (let i = 0; !e.total && !e.done && !e.err && i < 20; i++) await waitData(e, 250);
  const total = e.total;
  const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  let start = m && m[1] ? +m[1] : 0;
  let end = m && m[2] ? +m[2] : (total ? total - 1 : Infinity);
  const h = { 'Content-Type': e.mime, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
  if (total) {
    if (start >= total) { res.writeHead(416, { ...h, 'Content-Range': `bytes */${total}` }); return res.end(); }
    end = Math.min(end, total - 1);
    h['Content-Length'] = end - start + 1;
    if (m) h['Content-Range'] = `bytes ${start}-${end}/${total}`;
  }
  res.writeHead(m && total ? 206 : 200, h);
  let closed = false; req.on('close', () => (closed = true));
  const fh = await fs.promises.open(e.file, 'r');
  try {
    const buf = Buffer.allocUnsafe(256 * 1024);
    let pos = start;
    while (!closed && pos <= end) {
      const avail = e.done ? e.total : e.size;
      if (pos >= avail) {
        if (e.err) break;
        if (e.done) break;
        await waitData(e); continue;
      }
      const len = Math.min(buf.length, avail - pos, end - pos + 1);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) { await waitData(e, 200); continue; }
      await writeAsync(res, buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
  } finally { await fh.close(); res.end(); }
}

function serveBuffer(req, res, buf, mime) {
  const total = buf.length;
  const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  const start = m && m[1] ? +m[1] : 0, end = Math.min(m && m[2] ? +m[2] : total - 1, total - 1);
  const h = { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(m ? 206 : 200, h);
  res.end(buf.subarray(start, end + 1));
}

async function proxy(req, res, url, mime, headers = {}) {
  const hh = { ...headers }; if (req.headers.range) hh.Range = req.headers.range;
  const r = await net.fetch(url, { headers: hh });
  const h = { 'Content-Type': r.headers.get('content-type')?.startsWith('audio') ? r.headers.get('content-type') : mime, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  for (const k of ['content-length', 'content-range']) { const v = r.headers.get(k); if (v) h[k] = v; }
  res.writeHead(r.status, h);
  const body = Readable.fromWeb(r.body);
  body.on('error', () => res.end()); req.on('close', () => body.destroy());
  body.pipe(res);
  return r.status;
}

// SoundCloud: кэш ссылок и собранных HLS-буферов
const scInfo = new Map();      // scid → {promise, exp}
const scBufs = new Map();
const scNativeFailed = new Set();      // scid → Promise<{buf,mime}> (LRU 8)
function scStream(scid) {
  const c = scInfo.get(scid);
  if (c && c.exp > Date.now()) return c.promise;
  const promise = sc.trackStreamInfo(scid);
  scInfo.set(scid, { promise, exp: Date.now() + 8 * 60e3 });
  promise.catch(() => scInfo.delete(scid));
  return promise;
}
const EXT = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/aac': 'aac' };
function writeCache(key, buf, mime) {
  try {
    fs.mkdirSync(CACHE_DIR(), { recursive: true });
    const file = `${key}.${EXT[mime] || 'bin'}`;
    fs.writeFileSync(path.join(CACHE_DIR(), file), buf);
    cacheTouch(key, { file, mime, total: buf.length, done: true });
    cachePurge();
  } catch (e) { log('cache write failed', key, e.message); }
}
function cachedEntry(key) {
  const rec = cacheIndex()[key];
  if (!rec?.done) return null;
  const file = path.join(CACHE_DIR(), rec.file);
  if (!fs.existsSync(file)) return null;
  cacheTouch(key, {});
  return { vid: key, file, mime: rec.mime, total: rec.total, size: rec.total, done: true, err: null, waiters: new Set(), ready: Promise.resolve() };
}
const cacheKeysFor = (t) => t.src === 'yt' ? [t.vid] : t.src === 'sc' ? ['scn' + t.scid, 'sc' + t.scid] : t.src === 'au' ? ['au' + t.aid] : [];
const findCached = (t) => { for (const k of cacheKeysFor(t)) { const e = cachedEntry(k); if (e) return e; } return null; };
// прямой файл (progressive mp3 SoundCloud, Audius) → целиком в кэш
const progJobs = new Map();
function cacheProgressive(key, url, mime) {
  if (progJobs.has(key)) return progJobs.get(key);
  const p = (async () => {
    const r = await net.fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    writeCache(key, buf, (r.headers.get('content-type') || '').startsWith('audio') ? r.headers.get('content-type').split(';')[0] : mime);
    return key;
  })().finally(() => progJobs.delete(key));
  progJobs.set(key, p); p.catch(() => {});
  return p;
}
const waitDone = async (e) => { while (!e.done) { if (e.err) throw e.err; await waitData(e, 2000); } if (e.err) throw e.err; return e; };

// гарантирует, что трек целиком лежит на диске; возвращает ключ кэша
async function ensureCached(t) {
  const hit = findCached(t); if (hit) return hit.vid;
  if (t.src === 'yt') {
    if (!ytBlocked) {
      try { const e = ytDownload(t.vid); await e.ready; await waitDone(e); return t.vid; }
      catch (err) { if (!isBotErr(err.message)) throw err; }
    }
    if (!t.title) Object.assign(t, ytMeta.get(t.vid) || await ytBasic(t.vid));
    const alt = await ytAlternative(t); if (!alt) throw new Error('нет замены на SoundCloud');
    return ensureCached(alt);
  }
  if (t.src === 'sc') {
    if (!t.scid) t.scid = scByUrl.get(t.url) || (await sc.resolveId(t.url));
    try {
      const info = await scStream(t.scid);
      if (info.protocol === 'progressive') return await cacheProgressive('scn' + t.scid, info.url, info.mime);
      const e = scBuffer(t.scid); await e.ready; return 'scn' + t.scid;
    } catch (err) {
      if (err.drm || /^DRM/.test(err.message)) {
        const alt = t.title ? await matchTrack({ title: t.title, artist: t.artist, duration: t.duration }, { only: 'sc', exclude: t.scid }) : null;
        if (!alt || alt.scid === t.scid) throw new Error('трек защищён DRM, замены нет');
        return ensureCached(alt);
      }
      log(`sc ${t.scid} cache via yt-dlp:`, err.message);
      const e = dlFile('sc' + t.scid, t.url || `https://api.soundcloud.com/tracks/${t.scid}`, 'bestaudio[protocol=http]/bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[ext=opus]/bestaudio');
      await e.ready; await waitDone(e); return 'sc' + t.scid;
    }
  }
  if (t.src === 'au') return cacheProgressive('au' + t.aid, `${await audiusHost()}/v1/tracks/${t.aid}/stream?app_name=${APP_NAME}`, 'audio/mpeg');
  if (t.src === 'sp') { const m = await matchTrack(t); if (!m) throw new Error('не найдена полная версия'); return ensureCached(m); }
  throw new Error('unknown source');
}

/* ───────────── загрузки (офлайн) ───────────── */
const dkey = (t) => (t.src === 'sp' ? t.id : t.src + ':' + (t.vid || t.scid || t.url || t.aid));
const dlQueue = []; let dlActive = 0;
function queueDownloads(tracks) {
  const have = store.get('downloads', {});
  for (const t of tracks) {
    const k = dkey(t);
    if (have[k]?.key && cachedEntry(have[k].key)) { send('dl', { id: k, state: 'done' }); continue; }
    if (dlQueue.some((x) => dkey(x) === k)) continue;
    dlQueue.push(t); send('dl', { id: k, state: 'queued' });
  }
  pumpDownloads();
}
function pumpDownloads() {
  while (dlActive < 3 && dlQueue.length) {
    const t = dlQueue.shift(); const k = dkey(t); dlActive++;
    send('dl', { id: k, state: 'loading' });
    ensureCached({ ...t }).then((key) => {
      cacheTouch(key, { pinned: true });
      const d = store.get('downloads', {}); d[k] = { key, track: t, at: Date.now() }; store.set('downloads', d);
      send('dl', { id: k, state: 'done' }); log('downloaded', k, '→', key);
    }).catch((e) => { send('dl', { id: k, state: 'error', error: e.message }); log('download failed', k, e.message); })
      .finally(() => { dlActive--; pumpDownloads(); });
  }
}

function scBuffer(scid) {
  if (scBufs.has(scid)) { const v = scBufs.get(scid); scBufs.delete(scid); scBufs.set(scid, v); return v; }
  const e = { parts: [], size: 0, done: false, err: null, buf: null, mime: 'audio/mpeg', waiters: new Set() };
  const wake = () => { e.waiters.forEach((f) => f()); e.waiters.clear(); };
  e.ready = (async () => {
    const info = await scStream(scid);
    e.mime = info.mime;
    const t0 = Date.now(); let first = true;
    await sc.assembleHls(info.url, (part) => {
      e.parts.push(part); e.size += part.length;
      if (first) { first = false; log(`sc ${scid} first segment in ${Date.now() - t0}ms`); }
      wake();
    });
    e.buf = Buffer.concat(e.parts); e.done = true; wake();
    writeCache('scn' + scid, e.buf, e.mime);
    log(`sc ${scid} hls complete ${Math.round(e.buf.length / 1024)}KB in ${Date.now() - t0}ms`);
  })().catch((err) => { e.err = err; wake(); scBufs.delete(scid); throw err; });
  e.ready.catch(() => {});
  scBufs.set(scid, e);
  while (scBufs.size > 10) scBufs.delete(scBufs.keys().next().value);
  return e;
}
// HLS отдаём сразу по мере прихода сегментов; перемотка за пределы — после полной загрузки (обычно 1–3 с)
async function serveHls(req, res, e) {
  const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  const start = m && m[1] ? +m[1] : 0;
  if (e.done || start > 0) { await e.ready; return serveBuffer(req, res, e.buf, e.mime); }
  for (let i = 0; !e.parts.length && !e.err && !e.done && i < 80; i++) await waitData(e, 250);
  if (e.err) throw e.err;
  if (e.done) return serveBuffer(req, res, e.buf, e.mime);
  res.writeHead(200, { 'Content-Type': e.mime, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' });
  let closed = false; req.on('close', () => (closed = true));
  let i = 0;
  while (!closed) {
    if (i < e.parts.length) { await writeAsync(res, e.parts[i++]); continue; }
    if (e.done || e.err) break;
    await waitData(e, 5000);
  }
  res.end();
}

// YouTube не отдаёт (бот-проверка) → тот же трек на SoundCloud
const altCache = new Map();
function ytAlternative(t) {
  const k = t.vid;
  if (!altCache.has(k)) {
    const p = matchTrack({ title: t.title, artist: t.artist, duration: t.duration }, { only: 'sc' });
    altCache.set(k, p); p.then((r) => !r && altCache.delete(k), () => altCache.delete(k));
  }
  return altCache.get(k);
}
// трек SoundCloud под DRM → другая загрузка того же трека на SoundCloud
const drmAlt = new Map();
async function serveAlternative(req, res, t, opt, why) {
  if (!t.title) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end(why); }
  if (!drmAlt.has(t.scid)) drmAlt.set(t.scid, matchTrack({ title: t.title, artist: t.artist, duration: t.duration }, { only: 'sc', exclude: t.scid }).catch(() => null));
  const alt = await drmAlt.get(t.scid);
  if (!alt || alt.scid === t.scid) { log(`sc ${t.scid} ${why}, замены нет`); res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end(why); }
  log(`sc ${t.scid} ${why} → sc ${alt.scid} "${alt.artist} - ${alt.title}"`);
  return handleStream(req, res, alt, opt);
}
async function handleStream(req, res, t, opt = {}) {
  if (!opt.dl) { const hit = findCached(t); if (hit) return serveGrowing(req, res, hit); }
  if (t.src === 'sc' && !t.scid) t.scid = scByUrl.get(t.url) || (await sc.resolveId(t.url));
  if (t.src === 'yt' && !t.title) Object.assign(t, ytMeta.get(t.vid) || await ytBasic(t.vid));
  if (t.src === 'yt') {
    if (!ytBlocked) {
      const e = ytDownload(t.vid);
      try { await e.ready; return serveGrowing(req, res, e); }
      catch (err) { if (!isBotErr(err.message)) throw err; }
    }
    const alt = t.title ? await ytAlternative(t) : null;
    if (!alt) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end('no alternative'); }
    log(`yt ${t.vid} → sc ${alt.scid} "${alt.artist} - ${alt.title}"`);
    return handleStream(req, res, alt, opt);
  }
  if (t.src === 'sc') {
    if (opt.dl) log(`sc ${t.scid} forced yt-dlp (player could not decode native stream)`);
    if (!opt.dl && !scNativeFailed.has(t.scid)) {
      try {
        const info = await scStream(t.scid);
        if (info.protocol === 'progressive') {
          cacheProgressive('scn' + t.scid, info.url, info.mime).catch(() => {});
          const st = await proxy(req, res, info.url, info.mime);
          if (st === 403) scInfo.delete(t.scid);
          return;
        }
        return await serveHls(req, res, scBuffer(t.scid));
      } catch (e) {
        if (e.drm || /^DRM/.test(e.message)) return serveAlternative(req, res, t, opt, 'DRM');
        log(`sc ${t.scid} native failed → yt-dlp:`, e.message); scNativeFailed.add(t.scid);
      }
    }
    // запасной путь: yt-dlp умеет все форматы SoundCloud
    const page = t.url || `https://api.soundcloud.com/tracks/${t.scid}`;
    return serveGrowing(req, res, dlFile('sc' + t.scid, page, 'bestaudio[protocol=http]/bestaudio[ext=mp3]/bestaudio[ext=m4a]/bestaudio[ext=opus]/bestaudio'));
  }
  if (t.src === 'au') { cacheProgressive('au' + t.aid, `${await audiusHost()}/v1/tracks/${t.aid}/stream?app_name=${APP_NAME}`, 'audio/mpeg').catch(() => {}); }
  if (t.src === 'au') return proxy(req, res, `${await audiusHost()}/v1/tracks/${t.aid}/stream?app_name=${APP_NAME}`, 'audio/mpeg');
  res.writeHead(400); res.end('unknown source');
}

function prefetch(t) {
  if (!t) return;
  ensureCached({ ...t }).then((k) => log('prefetched', k)).catch((e) => log('prefetch failed', e.message));
}

/* ───────────── сопоставление треков из Spotify/CSV с полными версиями ───────────── */
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е')
  .replace(/\((?:feat|ft|with|prod)[^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s(feat|ft)\.?\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1 || /\d/.test(w)));
const BAD = /\b(remix|live|cover|sped|slowed|nightcore|reverb|8d|karaoke|instrumental|минус|ремикс|кавер|speed up|bass boosted)\b/i;
function score(c, t) {
  const a = toks(t.title), b = toks(c.title + ' ' + (c.src === 'yt' ? '' : c.artist));
  let inter = 0; a.forEach((w) => b.has(w) && inter++);
  const titleSim = a.size ? inter / a.size : 0;
  const art = norm((t.artist || '').split(',')[0]);
  const artistHit = art && norm(c.artist + ' ' + c.title).includes(art) ? 1 : 0;
  const dd = t.duration && c.duration ? Math.abs(t.duration - c.duration) : 8;
  let s = titleSim * 2 + artistHit * 1.4 - (dd > 20 ? 1.6 : dd / 12);
  if (BAD.test(c.title) && !BAD.test(t.title)) s -= 1.3;
  return s;
}
async function matchTrack(t, { only, exclude } = {}) {
  const key = (only ? only + ':' : 'm:') + (exclude ? 'x' + exclude + ':' : '') + norm(t.artist) + '|' + norm(t.title);
  const cached = store.get('match', {})[key];
  if (cached) return remember([cached])[0];
  const q = `${(t.artist || '').split(/,|&| x /)[0]} ${cleanTitle(t.title).replace(/\s*[([](prod|при уч|feat|ft)[^)\]]*[)\]]/gi, '')}`.trim();
  const t0 = Date.now();
  const useYt = !only && !ytBlocked;
  const [scL, ytL] = await Promise.all([settle('match sc', sc.search(q, 10)), useYt ? settle('match yt', ytmSearch(q, 8)) : []]);
  const cands = [...scL.filter((c) => c.scid !== exclude).map((c) => ({ c, s: score(c, t) + 0.15 })), ...ytL.map((c) => ({ c, s: score(c, t) + 0.1 }))].sort((x, y) => y.s - x.s);
  const best = cands[0];
  log(`match "${q}" → ${best ? `${best.c.src} "${best.c.artist} - ${best.c.title}" s=${best.s.toFixed(2)}` : 'none'} ${Date.now() - t0}ms`);
  if (!best || best.s < 1.2) return null;
  const res = { ...best.c, cover: best.c.cover || t.cover, origin: t.id };
  remember([res]);
  const m = store.get('match', {}); m[key] = res; store.set('match', m);
  return res;
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      try {
        if (u.pathname === '/img') {
          const r = await net.fetch(u.searchParams.get('u'));
          res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'max-age=604800', 'Access-Control-Allow-Origin': '*' });
          return res.end(Buffer.from(await r.arrayBuffer()));
        }
        if (u.pathname === '/stream') {
          const t = JSON.parse(Buffer.from(u.searchParams.get('t'), 'base64url').toString());
          return await handleStream(req, res, t, { dl: u.searchParams.get('dl') === '1' });
        }
        res.writeHead(404); res.end();
      } catch (e) { log('server error', e); try { res.writeHead(500); res.end(); } catch {} }
    });
    srv.listen(0, '127.0.0.1', () => { port = srv.address().port; log('local server on', port); resolve(); });
  });
}

/* ───────────── windows ───────────── */
const PRELOAD = path.join(__dirname, 'preload.js');
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

function createMain() {
  main = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1040, minHeight: 660, show: false,
    backgroundColor: '#0E0E10', title: 'MudPlayer', icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#0C0C0E', symbolColor: '#8A8A90', height: 44 } : undefined,
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  main.loadFile(INDEX);
  main.once('ready-to-show', () => main.show());
  for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) main.on(ev, () => setTimeout(syncIsland, 120));
  main.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) log('[renderer]', msg); });
  main.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d));
  main.on('closed', () => { main = null; if (island && !island.isDestroyed()) island.destroy(); app.quit(); });
}

const ISL_W = 460, ISL_H = 240;
let islandReady = false;
function syncIsland() {
  if (!island || island.isDestroyed() || !islandReady) return;
  const mainActive = main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused();
  const want = islandMode === 'always' || (islandMode === 'background' && hasTrack && !mainActive);
  if (want && !island.isVisible()) island.showInactive();
  else if (!want && island.isVisible()) { island.hide(); island.setIgnoreMouseEvents(true, { forward: true }); }
}
function createIsland() {
  const { workArea } = screen.getPrimaryDisplay();
  island = new BrowserWindow({
    width: ISL_W, height: ISL_H,
    x: Math.round(workArea.x + (workArea.width - ISL_W) / 2), y: workArea.y + 6,
    transparent: true, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    hasShadow: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000', title: 'MudPlayer Island',
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  island.setAlwaysOnTop(true, 'screen-saver');
  island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  island.setIgnoreMouseEvents(true, { forward: true });
  island.loadFile(INDEX, { hash: 'island' });
  island.once('ready-to-show', () => { islandReady = true; syncIsland(); });
  island.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) log('[island]', msg); });
}

/* ───────────── IPC ───────────── */
ipcMain.handle('app:info', () => ({ port, version: app.getVersion(), ytdlp: ytdlpStatus, logFile: LOG_FILE, platform: process.platform }));
ipcMain.handle('search', (_e, q, sources) => searchAll(q, sources));
ipcMain.handle('search:src', async (_e, q, src) => {
  const t0 = Date.now();
  const r = src === 'yt' ? await settle('yt', ytmSearch(q)) : src === 'sc' ? await settle('sc', sc.search(q, 20)) : await settle('au', auSearch(q));
  log(`search ${src} "${q}" ${r.length} ${Date.now() - t0}ms`);
  return remember(r);
});
ipcMain.handle('wave', (_e, opts) => wave(opts));
ipcMain.handle('artist', async (_e, a, sources) => remember(await artistPage(a, sources)));
ipcMain.handle('lyrics', (_e, t) => lyrics(t));
ipcMain.handle('trending', async (_e, sources) => {
  const [hits, au] = await Promise.all([
    sources.yt ? settle('hits', ytmSearch('хиты 2026', 14)) : [],
    sources.au ? settle('au trending', auTrending()) : [],
  ]);
  remember(hits);
  return { hits, au };
});
ipcMain.handle('prefetch', (_e, t) => { prefetch(t); return true; });
ipcMain.handle('match', (_e, t) => matchTrack(t));
ipcMain.handle('yt:config', (_e, cfg) => {
  if (cfg && 'cookies' in cfg && cfg.cookies !== ytCookies) { ytCookies = cfg.cookies || ''; ytBlocked = false; log('yt cookies from', ytCookies || 'none'); }
  return { blocked: ytBlocked };
});
ipcMain.handle('import:url', async (_e, url) => {
  if (/spotify\.com|^spotify:/.test(url)) return importSpotify(url, log);
  if (/soundcloud\.com/.test(url)) { const pls = await sc.importUrl(url); pls.forEach((p) => remember(p.tracks)); return pls; }
  throw new Error('Поддерживаются ссылки Spotify (плейлист, альбом, трек) и SoundCloud (профиль, лайки, плейлист)');
});
ipcMain.handle('import:csv', (_e, name, text) => importCsv(name, text, log));
ipcMain.handle('cache:clear', () => {
  const c = store.get('cache', {});
  for (const [k, r] of Object.entries(c)) { if (r.pinned) continue; try { fs.unlinkSync(path.join(CACHE_DIR(), r.file)); } catch {} delete c[k]; }
  store.set('cache', c); return true;
});
ipcMain.handle('cache:size', () => Object.values(store.get('cache', {})).reduce((s, r) => s + (r.total || 0), 0));
ipcMain.handle('dl:tracks', (_e, tracks) => { queueDownloads(tracks); return true; });
ipcMain.handle('dl:list', () => {
  const d = store.get('downloads', {});
  return Object.entries(d).filter(([, v]) => cachedEntry(v.key)).map(([id, v]) => ({ id, track: v.track, at: v.at }));
});
ipcMain.handle('dl:remove', (_e, ids) => {
  const d = store.get('downloads', {}); const c = cacheIndex();
  for (const id of ids) { const v = d[id]; if (v && c[v.key]) c[v.key].pinned = false; delete d[id]; }
  store.set('downloads', d); store.set('cache', c); return true;
});
ipcMain.handle('ytdlp:update', async () => {
  await ensureYtdlp();
  const out = await runYtdlp(['-U'], { timeout: 120000, base: false }).catch((e) => e.message);
  const v = (await runYtdlp(['--version'], { base: false })).trim();
  setStatus({ version: v }); log('yt-dlp update:', out.trim()); return v;
});
ipcMain.handle('open:log', () => shell.openPath(LOG_FILE));
ipcMain.on('log', (_e, ...a) => log('[ui]', ...a));

// main window → island
ipcMain.on('island:state', (_e, s) => {
  if (s && 'track' in s) { const h = !!s.track; if (h !== hasTrack) { hasTrack = h; syncIsland(); } }
  island && !island.isDestroyed() && island.webContents.send('island:state', s);
});
ipcMain.on('island:levels', (_e, l) => island && !island.isDestroyed() && island.webContents.send('island:levels', l));
ipcMain.on('island:visible', (_e, v) => { islandMode = v === true ? 'background' : v === false ? 'off' : v; log('island mode', islandMode); syncIsland(); });
// island → main window
ipcMain.on('island:cmd', (_e, c, arg) => {
  if (c === 'hide') { islandMode = 'off'; syncIsland(); send('island-mode', 'off'); return; }
  send('cmd', c, arg); if (c === 'focus' && main) { main.show(); main.restore(); main.focus(); }
});
ipcMain.on('island:hit', (_e, inside) => island && !island.isDestroyed() && island.setIgnoreMouseEvents(!inside, { forward: true }));

if (process.platform === 'win32') app.setAppUserModelId('com.muderSSS.mudplayer');

/* ───────────── автообновление (GitHub Releases) ───────────── */
let updater = null, updateState = { state: 'idle' };
function setUpdate(s) { updateState = { ...updateState, ...s }; send('update', updateState); }
function initUpdater() {
  if (!app.isPackaged) { updateState = { state: 'dev' }; return; }
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { log('electron-updater missing', e.message); return; }
  updater.logger = { info: (m) => log('[upd]', m), warn: (m) => log('[upd warn]', m), error: (m) => log('[upd err]', m), debug: () => {} };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  updater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, progress: 0 }));
  updater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  updater.on('download-progress', (p) => setUpdate({ state: 'downloading', progress: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => setUpdate({ state: 'ready', version: i.version }));
  updater.on('error', (e) => setUpdate({ state: 'error', error: String(e?.message || e).slice(0, 200) }));
  const check = () => updater.checkForUpdates().catch((e) => log('update check failed', e.message));
  setTimeout(check, 4000);
  setInterval(check, 30 * 60e3);
}
ipcMain.handle('update:state', () => ({ ...updateState, current: app.getVersion() }));
ipcMain.handle('update:check', async () => { if (!updater) return updateState; await updater.checkForUpdates().catch(() => {}); return updateState; });
ipcMain.handle('update:install', () => { if (updater && updateState.state === 'ready') { log('installing update', updateState.version); updater.quitAndInstall(true, true); } });
app.whenReady().then(async () => {
  log('MudPlayer start', process.versions.electron, process.platform);
  await startServer();
  createMain();
  createIsland();
  ensureYtdlp().catch(() => {});
  sc.warm();
  initUpdater();
  getYT().catch((e) => log('youtubei init failed', e.message));
});
app.on('second-instance', () => { if (main) { main.show(); main.focus(); } });
app.on('window-all-closed', () => app.quit());
