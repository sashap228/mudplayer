// SoundCloud через api-v2 напрямую (без yt-dlp): поиск ~300 мс, поток сразу.
const { net } = require('electron');

module.exports = function createSoundCloud({ log, store }) {
  const API = 'https://api-v2.soundcloud.com';
  let clientId = store.get('sc_client_id') || null;
  let cidPromise = null;

  async function fetchClientId() {
    const html = await (await net.fetch('https://soundcloud.com/')).text();
    const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
    for (const src of scripts) {
      const js = await (await net.fetch(src)).text();
      const m = js.match(/client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/) || js.match(/client_id=([0-9a-zA-Z]{32})/);
      if (m) { log('soundcloud client_id found'); store.set('sc_client_id', m[1]); return m[1]; }
    }
    throw new Error('SoundCloud client_id не найден');
  }
  function cid(force = false) {
    if (clientId && !force) return Promise.resolve(clientId);
    if (!cidPromise) cidPromise = fetchClientId().then((c) => (clientId = c)).finally(() => { cidPromise = null; });
    return cidPromise;
  }

  async function api(pathOrUrl, retry = true) {
    const id = await cid();
    const base = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
    const url = base + (base.includes('?') ? '&' : '?') + 'client_id=' + id;
    const r = await net.fetch(url, { headers: { Accept: 'application/json' } });
    if ((r.status === 401 || r.status === 403) && retry) { log('sc', r.status, '→ new client_id'); await cid(true); return api(pathOrUrl, false); }
    if (!r.ok) throw new Error(`SoundCloud HTTP ${r.status}`);
    return r.json();
  }

  const art = (u) => (u || '').replace(/-(large|t\d+x\d+|small|badge|crop)\./, '-t500x500.');
  // DRM-потоки (cbc-/ctr-encrypted-hls, подписка Go+) не играет ни один сторонний плеер
  const isPlayableTr = (x) => x.url && !x.snipped && !/^abr/.test(x.preset || '') && !/^(ctr|cbc)-/.test(x.format?.protocol || '');
  const drmOnly = (t) => (t.media?.transcodings || []).length > 0 && !(t.media.transcodings || []).some(isPlayableTr);
  const snipped = (t) => t.policy === 'SNIP' || t.policy === 'BLOCK' || (t.duration && t.full_duration && t.full_duration - t.duration > 2000)
    || (t.media?.transcodings || []).every((x) => x.snipped);
  function map(t) {
    if (!t || !t.id || !t.title) return null;
    return {
      id: 'sc:' + t.id, src: 'sc', scid: t.id, url: t.permalink_url, title: t.title,
      artist: t.publisher_metadata?.artist || t.user?.username || '', artistId: t.user?.id,
      duration: Math.round((t.full_duration || t.duration || 0) / 1000), cover: art(t.artwork_url || t.user?.avatar_url),
      preview: snipped(t) || undefined, drm: drmOnly(t) || undefined,
    };
  }
  // для поиска/волны — только то, что реально играет; для импорта — всё, DRM-треки заменятся при воспроизведении
  const full = (list, { keepDrm = false } = {}) => list.map(map).filter((t) => t && !t.preview && (keepDrm || !t.drm));

  async function search(q, limit = 20) {
    const j = await api(`/search/tracks?q=${encodeURIComponent(q)}&limit=${limit + 10}&linked_partitioning=1`);
    return full(j.collection || []).slice(0, limit);
  }

  // дотягиваем «лёгкие» треки (только id) пачками по 50
  async function hydrate(tracks) {
    const lite = tracks.filter((t) => !t.title).map((t) => t.id);
    const got = new Map(tracks.filter((t) => t.title).map((t) => [t.id, t]));
    const batches = []; for (let i = 0; i < lite.length; i += 50) batches.push(lite.slice(i, i + 50));
    const parts = await Promise.all(batches.map((b) => api(`/tracks?ids=${b.join(',')}`).catch(() => [])));
    parts.flat().forEach((t) => got.set(t.id, t));
    return tracks.map((t) => got.get(t.id)).filter(Boolean);
  }
  async function paged(path, max = 2000) {
    let url = path + (path.includes('?') ? '&' : '?') + 'limit=200&linked_partitioning=1';
    const out = [];
    while (url && out.length < max) {
      const j = await api(url);
      out.push(...(j.collection || []));
      url = j.next_href || null;
    }
    return out;
  }

  // какие потоки есть у трека, в порядке предпочтения (как в yt-dlp: без abr-пресетов и DRM)
  function rankTranscodings(t) {
    const all = (t.media?.transcodings || []).filter((x) => x.url && x.preset && !x.snipped
      && !/\/preview\//.test(x.url) && !/^abr/.test(x.preset) && !/^(ctr|cbc)-/.test(x.format?.protocol || ''));
    const kind = (x) => {
      const p = x.format?.protocol || '', m = x.format?.mime_type || '';
      const proto = p === 'progressive' ? 0 : p === 'hls' ? 1 : p === 'encrypted-hls' ? 2 : 9;
      const codec = /mpeg/.test(m) ? 0 : /mp4|aac/.test(m) ? 1 : /ogg|opus/.test(m) ? 2 : 3;
      return proto * 10 + codec;
    };
    return all.sort((a, b) => kind(a) - kind(b));
  }
  async function trackStreamInfo(scid) {
    const t = await api(`/tracks/${scid}`);
    const list = rankTranscodings(t);
    if (!list.length) throw Object.assign(new Error('DRM: у трека нет доступного потока: ' + (t.media?.transcodings || []).map((x) => `${x.preset}/${x.format?.protocol}`).join(',')), { drm: true });
    let lastErr;
    for (const pick of list) {
      try {
        const j = await api(pick.url);
        if (!j.url) throw new Error('пустой url');
        const mime = (pick.format.mime_type || 'audio/mpeg').split(';')[0];
        log(`sc ${scid} stream ${pick.preset} ${pick.format.protocol}`);
        return { url: j.url, protocol: pick.format.protocol, mime };
      } catch (e) { lastErr = e; log(`sc ${scid} ${pick.preset}/${pick.format?.protocol} failed: ${e.message}`); }
    }
    throw lastErr || new Error('поток не получен');
  }

  // HLS → один файл: качаем сегменты параллельно и склеиваем (mp3/fMP4/ogg склеиваются корректно).
  // Поддерживает AES-128 (encrypted-hls).
  async function assembleHls(m3u8Url, onPart) {
    let text = await (await net.fetch(m3u8Url)).text();
    let base = m3u8Url;
    if (/#EXT-X-STREAM-INF/.test(text)) { // мастер-плейлист → берём первый вариант
      const v = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      base = new URL(v, m3u8Url).href; text = await (await net.fetch(base)).text();
    }
    const abs = (u) => new URL(u, base).href;
    const lines = text.split('\n').map((l) => l.trim());
    const init = text.match(/#EXT-X-MAP:URI="([^"]+)"/);
    const segs = []; let key = null, seq = +((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0);
    for (const l of lines) {
      if (l.startsWith('#EXT-X-KEY')) {
        const method = (l.match(/METHOD=([^,]+)/) || [])[1];
        key = method && method !== 'NONE' ? { method, uri: abs((l.match(/URI="([^"]+)"/) || [])[1]), iv: (l.match(/IV=0x([0-9a-f]+)/i) || [])[1] } : null;
      } else if (l && !l.startsWith('#')) segs.push({ url: abs(l), key, seq: seq++ });
    }
    const keys = new Map();
    const getKey = (uri) => { if (!keys.has(uri)) keys.set(uri, net.fetch(uri).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b))); return keys.get(uri); };
    const crypto = require('crypto');
    const items = init ? [{ url: abs(init[1]), key: null }, ...segs] : segs;
    const bufs = new Array(items.length);
    let next = 0, emitted = 0;
    const flush = () => { while (emitted < items.length && bufs[emitted]) { onPart && onPart(bufs[emitted]); emitted++; } };
    const worker = async () => {
      while (next < items.length) {
        const i = next++; const it = items[i];
        for (let a = 0; a < 3; a++) {
          try {
            const r = await net.fetch(it.url); if (!r.ok) throw new Error('segment HTTP ' + r.status);
            let b = Buffer.from(await r.arrayBuffer());
            if (it.key && it.key.method === 'AES-128') {
              const k = await getKey(it.key.uri);
              const iv = it.key.iv ? Buffer.from(it.key.iv.padStart(32, '0'), 'hex') : (() => { const x = Buffer.alloc(16); x.writeUInt32BE(it.seq, 12); return x; })();
              const d = crypto.createDecipheriv('aes-128-cbc', k, iv); b = Buffer.concat([d.update(b), d.final()]);
            } else if (it.key) throw new Error('неподдерживаемое шифрование ' + it.key.method);
            bufs[i] = b; flush(); break;
          } catch (e) { if (a === 2) throw e; }
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return Buffer.concat(bufs);
  }

  async function resolveUrl(url) {
    return api(`/resolve?url=${encodeURIComponent(url.split('?')[0])}`);
  }

  // импорт: профиль (лайки + плейлисты), плейлист, страница лайков
  async function importUrl(url) {
    const clean = url.replace(/\/(likes|sets|tracks|reposts)\/?$/, '');
    const isLikes = /\/likes\/?$/.test(url.split('?')[0]);
    const obj = await resolveUrl(isLikes ? clean : url);
    const playlists = [];
    if (obj.kind === 'playlist') {
      const tracks = full(await hydrate(obj.tracks || []), { keepDrm: true });
      playlists.push({ id: 'scpl:' + obj.id, name: obj.title, cover: art(obj.artwork_url) || tracks[0]?.cover, source: 'sc', tracks });
    } else if (obj.kind === 'user') {
      const likes = await paged(`/users/${obj.id}/track_likes`);
      const lt = full(likes.map((x) => x.track).filter(Boolean), { keepDrm: true });
      if (lt.length) playlists.push({ id: 'sclikes:' + obj.id, name: `Лайки ${obj.username}`, cover: art(obj.avatar_url), source: 'sc', tracks: lt });
      if (!isLikes) {
        const pls = await paged(`/users/${obj.id}/playlists_without_albums`, 200).catch(() => paged(`/users/${obj.id}/playlists`, 200));
        const hyd = await Promise.all(pls.slice(0, 40).map((p) => hydrate(p.tracks || []).then((l) => full(l, { keepDrm: true })).catch(() => [])));
        pls.slice(0, 40).forEach((p, i) => {
          if (hyd[i].length) playlists.push({ id: 'scpl:' + p.id, name: p.title, cover: art(p.artwork_url) || hyd[i][0]?.cover, source: 'sc', tracks: hyd[i] });
        });
        if (!lt.length && !pls.length) {
          const own = full(await paged(`/users/${obj.id}/tracks`, 500));
          if (own.length) playlists.push({ id: 'scuser:' + obj.id, name: obj.username, cover: art(obj.avatar_url), source: 'sc', tracks: own });
        }
      }
    } else if (obj.kind === 'track') {
      const t = map(obj);
      if (t) playlists.push({ id: 'sctrack:' + obj.id, name: obj.title, cover: t.cover, source: 'sc', tracks: [t] });
    }
    log('sc import', url, playlists.map((p) => `${p.name}:${p.tracks.length}`).join(', '));
    return playlists;
  }

  async function related(scid) {
    const j = await api(`/tracks/${scid}/related?limit=40`);
    return full(j.collection || []).filter((t) => !t.duration || (t.duration > 60 && t.duration < 600));
  }

  async function charts(kind = 'trending', genre = 'all-music') {
    const j = await api(`/charts?kind=${kind}&genre=soundcloud%3Agenres%3A${genre}&limit=50`);
    return full((j.collection || []).map((x) => x.track).filter(Boolean));
  }

  async function userTracks(userId) { return full(await api(`/users/${userId}/tracks?limit=50`).then((j) => j.collection || [])); }

  return { charts, resolveId: async (url) => (await resolveUrl(url)).id, search, related, trackStreamInfo, assembleHls, importUrl, userTracks, warm: () => cid().catch((e) => log('sc warm failed', e.message)) };
};
