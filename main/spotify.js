// Импорт из Spotify без OAuth: публичные плейлисты/альбомы через embed-страницу + CSV из Exportify (любые, включая «Любимые треки»).
const { net } = require('electron');
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function parseSpotifyUrl(u) {
  const m = String(u).match(/(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?|spotify:)(playlist|album|track)[/:]([A-Za-z0-9]{22})/);
  return m ? { type: m[1], id: m[2] } : null;
}

async function importSpotify(url, log) {
  const p = parseSpotifyUrl(url);
  if (!p) throw new Error('Не похоже на ссылку Spotify (нужен плейлист, альбом или трек)');
  const r = await net.fetch(`https://open.spotify.com/embed/${p.type}/${p.id}`, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ru,en;q=0.8' } });
  if (!r.ok) throw new Error(`Spotify HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Spotify не отдал данные плейлиста (он приватный?)');
  const data = JSON.parse(m[1]);
  const e = data?.props?.pageProps?.state?.data?.entity;
  if (!e) throw new Error('Пустой ответ Spotify');
  const cover = e.coverArt?.sources?.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || e.visualIdentity?.image?.[0]?.url || '';
  let list = e.trackList || [];
  if (p.type === 'track') list = [{ title: e.name || e.title, subtitle: (e.artists || []).map((a) => a.name).join(', '), duration: e.duration, uri: e.uri }];
  const tracks = list.map((t, i) => ({
    id: 'sp:' + (t.uri || `${p.id}:${i}`), src: 'sp', title: t.title, artist: (t.subtitle || '').replace(/ /g, ' '),
    duration: Math.round((t.duration || 0) / 1000), cover: t.image?.[0]?.url || cover,
  })).filter((t) => t.title);
  log('spotify import', p.type, e.name || e.title, tracks.length);
  return [{ id: `sp${p.type}:${p.id}`, name: e.name || e.title || 'Spotify', cover, source: 'sp', tracks, partial: p.type === 'playlist' && tracks.length >= 100 }];
}

// CSV (Exportify и похожие): ищем колонки по названию
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
function importCsv(name, text, log) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const h = rows.shift().map((x) => x.toLowerCase().trim());
  const col = (...names) => h.findIndex((x) => names.some((n) => x === n || x.includes(n)));
  const ti = col('track name', 'title', 'название', 'name'), ai = col('artist name', 'artist', 'исполнитель'), di = col('duration (ms)', 'duration'), ui = col('track uri', 'uri', 'spotify id');
  if (ti < 0) throw new Error('В CSV нет колонки с названием трека');
  const tracks = rows.map((r, i) => {
    let d = di >= 0 ? +r[di] || 0 : 0; if (d > 10000) d = d / 1000;
    return { id: 'sp:' + (ui >= 0 && r[ui] ? r[ui] : `csv:${name}:${i}`), src: 'sp', title: r[ti], artist: ai >= 0 ? (r[ai] || '').replace(/\\,/g, ',') : '', duration: Math.round(d), cover: '' };
  }).filter((t) => t.title);
  log('csv import', name, tracks.length);
  return [{ id: 'csv:' + name + ':' + tracks.length, name: name.replace(/\.csv$/i, '').replace(/_/g, ' '), cover: '', source: 'sp', tracks }];
}

module.exports = { importSpotify, importCsv, parseSpotifyUrl };
