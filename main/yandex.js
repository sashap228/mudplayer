// Импорт из Яндекс Музыки по ссылке (без входа): плейлисты, «Мне нравится», альбомы, треки, артисты.
// Нужен публичный доступ к фонотеке у владельца: Яндекс Музыка → Настройки → Прочее → «Публичный доступ к моей фонотеке».
const { net } = require('electron');
const API = 'https://api.music.yandex.net';
const HEADERS = { 'User-Agent': 'Yandex-Music-API', 'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621', Accept: 'application/json' };

async function call(path, opts = {}) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await net.fetch(API + path, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) }, signal: ac.signal });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok || j?.error) {
      const msg = j?.error?.message || j?.error?.name || j?.error || `HTTP ${r.status}`;
      const e = new Error(String(msg)); e.status = r.status; throw e;
    }
    return j.result;
  } finally { clearTimeout(tm); }
}

const cover = (uri) => (uri ? 'https://' + uri.replace('%%', '400x400') : '');
function mapTrack(t, fallbackCover = '') {
  if (!t || !t.title) return null;
  const title = t.version ? `${t.title} (${t.version})` : t.title;
  return {
    id: 'ym:' + t.id, src: 'ym', ymid: String(t.id), title,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    duration: Math.round((t.durationMs || 0) / 1000),
    cover: cover(t.coverUri || t.albums?.[0]?.coverUri) || fallbackCover,
  };
}

// большие плейлисты отдают только id — дотягиваем треки пачками
async function hydrate(items) {
  const full = new Map(); const missing = [];
  for (const it of items) {
    const tr = it.track || (it.title ? it : null);
    const id = String(it.id || tr?.id || '').split(':')[0];
    if (tr?.title) full.set(id, tr); else if (id) missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const part = await call('/tracks', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'track-ids=' + missing.slice(i, i + 200).join(',') }).catch(() => []);
    for (const t of part || []) full.set(String(t.id), t);
  }
  return items.map((it) => full.get(String(it.id || it.track?.id || '').split(':')[0])).filter(Boolean);
}

function parse(url) {
  const u = String(url).trim();
  if (!/music\.yandex\.(ru|by|kz|com|uz)/.test(u)) return null;
  let m;
  if ((m = u.match(/\/users\/([^/?#]+)\/playlists\/(\d+)/))) return { type: 'playlist', user: decodeURIComponent(m[1]), kind: m[2] };
  if ((m = u.match(/\/users\/([^/?#]+)\/(tracks|likes)/))) return { type: 'playlist', user: decodeURIComponent(m[1]), kind: '3' };
  if ((m = u.match(/\/playlists\/([\w.-]+)/))) return { type: 'uuid', uuid: m[1] };
  if ((m = u.match(/\/album\/(\d+)\/track\/(\d+)/))) return { type: 'track', id: m[2] };
  if ((m = u.match(/\/track\/(\d+)/))) return { type: 'track', id: m[1] };
  if ((m = u.match(/\/album\/(\d+)/))) return { type: 'album', id: m[1] };
  if ((m = u.match(/\/artist\/(\d+)/))) return { type: 'artist', id: m[1] };
  return null;
}

async function importYandex(url, log) {
  const p = parse(url);
  if (!p) throw new Error('Не похоже на ссылку Яндекс Музыки (нужен плейлист, «Мне нравится», альбом, трек или артист)');
  try {
    if (p.type === 'playlist' || p.type === 'uuid') {
      let r;
      if (p.type === 'playlist') r = await call(`/users/${encodeURIComponent(p.user)}/playlists/${p.kind}`);
      else r = await call(`/playlist/${p.uuid}`).catch(() => call(`/playlists/${p.uuid}`));
      const pc = cover(r.cover?.uri || r.cover?.itemsUri?.[0] || r.ogImage);
      const tracks = (await hydrate(r.tracks || [])).map((t) => mapTrack(t, pc)).filter(Boolean);
      const name = String(r.kind) === '3' ? `Мне нравится · ${r.owner?.name || p.user || ''}`.trim() : (r.title || 'Плейлист');
      log('ym import playlist', name, tracks.length);
      return [{ id: `ympl:${r.owner?.uid || p.user || ''}:${r.kind || p.uuid}`, name, cover: pc || tracks[0]?.cover || '', source: 'ym', tracks }];
    }
    if (p.type === 'album') {
      const r = await call(`/albums/${p.id}/with-tracks`);
      const ac = cover(r.coverUri);
      const tracks = (r.volumes || []).flat().map((t) => mapTrack(t, ac)).filter(Boolean);
      log('ym import album', r.title, tracks.length);
      return [{ id: 'ymal:' + p.id, name: `${r.title} — ${(r.artists || []).map((a) => a.name).join(', ')}`, cover: ac, source: 'ym', tracks }];
    }
    if (p.type === 'track') {
      const [t] = await call(`/tracks/${p.id}`);
      const tr = mapTrack(t);
      return [{ id: 'ymtr:' + p.id, name: tr.title, cover: tr.cover, source: 'ym', tracks: [tr] }];
    }
    if (p.type === 'artist') {
      const r = await call(`/artists/${p.id}/tracks?page-size=100`);
      const tracks = (r.tracks || []).map((t) => mapTrack(t)).filter(Boolean);
      const name = tracks[0]?.artist?.split(',')[0] || 'Артист';
      return [{ id: 'ymar:' + p.id, name: `${name} — популярное`, cover: tracks[0]?.cover || '', source: 'ym', tracks }];
    }
  } catch (e) {
    log('ym import failed', url, e.status || '', e.message);
    if (e.status === 403 || e.status === 404 || /not.?found|forbidden|access/i.test(e.message)) {
      throw new Error('Яндекс Музыка не отдала плейлист: он приватный. Включи «Публичный доступ к моей фонотеке» (Настройки → Прочее) и попробуй снова.');
    }
    throw new Error('Яндекс Музыка не ответила: ' + e.message);
  }
  return [];
}

module.exports = { importYandex, parseYandexUrl: parse };
