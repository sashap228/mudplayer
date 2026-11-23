import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

const api = window.api;

/* ───────────── utils ───────────── */
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SRC = { sc: 'SoundCloud', yt: 'YouTube Music', au: 'Audius' };
const SRC_ALL = { ...SRC, sp: 'Spotify' };
const SRC_SHORT = { yt: 'YTM', sc: 'SC', au: 'AUD', sp: 'SPOT' };
const GENRES = ['рэп', 'поп', 'электроника', 'инди', 'рок', 'фонк', 'lo-fi', 'r&b', 'хаус', 'альтернатива', 'джаз', 'гиперпоп'];
const tkey = (t) => t && (t.src === 'sp' ? t.id : t.src + ':' + (t.vid || t.scid || t.url || t.aid));
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ls = {
  get: (k, d) => { try { const v = localStorage.getItem('mp:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('mp:' + k, JSON.stringify(v)); } catch {} },
};
function usePersist(k, d) {
  const [v, setV] = useState(() => ls.get(k, d));
  useEffect(() => ls.set(k, v), [k, v]);
  return [v, setV];
}

/* маленький внешний стор: время и уровни обновляются 60 раз/с без ререндера всего приложения */
function createStore(init) {
  let v = init; const subs = new Set();
  return { get: () => v, set: (n) => { v = n; subs.forEach((f) => f()); }, sub: (f) => (subs.add(f), () => subs.delete(f)) };
}
const clock = createStore(0);
const levels = createStore([0, 0, 0, 0, 0]);
const useStore = (s) => useSyncExternalStore(s.sub, s.get);

/* ───────────── palette ───────────── */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const palCache = new Map();
function extractPalette(url, port) {
  if (!url) return Promise.resolve({ h: 30, s: 10, ts: 12 });
  if (palCache.has(url)) return palCache.get(url);
  const p = new Promise((res) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 40;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 40, 40);
        const d = x.getImageData(0, 0, 40, 40).data;
        const bins = Array.from({ length: 36 }, () => ({ w: 0, h: 0, s: 0 }));
        for (let i = 0; i < d.length; i += 4) {
          const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
          if (s < .14 || l < .1 || l > .92) continue;
          const w = s * (1 - Math.abs(l - .5)); const b = bins[Math.floor(h / 10) % 36];
          b.w += w; b.h += h * w; b.s += s * w;
        }
        const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
        if (!best.w) return res({ h: 30, s: 8, ts: 10 });
        const raw = (best.s / best.w) * 100;
        res({ h: Math.round(best.h / best.w), s: Math.round(clamp(raw * .55, 16, 42)), ts: Math.round(clamp(raw * .7, 18, 58)) });
      } catch { res({ h: 30, s: 10, ts: 12 }); }
    };
    img.onerror = () => res({ h: 30, s: 10, ts: 12 });
    img.src = port ? `http://127.0.0.1:${port}/img?u=${encodeURIComponent(url)}` : url;
  });
  palCache.set(url, p);
  return p;
}

/* ───────────── icons ───────────── */
const S = (p) => <svg width={p.s || 16} height={p.s || 16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">{p.children}</svg>;
const I = {
  play: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 2.8v10.4c0 .5.6.9 1 .6l8-5.2a.7.7 0 0 0 0-1.2l-8-5.2c-.4-.3-1 0-1 .6Z" fill="currentColor"/></svg>,
  playL: <svg width="22" height="22" viewBox="0 0 16 16"><path d="M4.5 2.8v10.4c0 .5.6.9 1 .6l8-5.2a.7.7 0 0 0 0-1.2l-8-5.2c-.4-.3-1 0-1 .6Z" fill="currentColor"/></svg>,
  pause: <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>,
  pauseL: <svg width="22" height="22" viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>,
  prev: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M13 3.2v9.6c0 .5-.6.8-1 .5L5.5 8.5a.6.6 0 0 1 0-1L12 2.7c.4-.3 1 0 1 .5ZM3 3h1.6v10H3z" fill="currentColor"/></svg>,
  next: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3.2v9.6c0 .5.6.8 1 .5l6.5-4.8a.6.6 0 0 0 0-1L4 2.7c-.4-.3-1 0-1 .5ZM11.4 3H13v10h-1.6z" fill="currentColor"/></svg>,
  shuffle: <S><path d="M2 4h2.5c1.6 0 2.6.8 3.5 2.2l1 1.6c.9 1.4 1.9 2.2 3.5 2.2H14M2 12h2.5c1 0 1.8-.3 2.4-.9M14 4h-1.5c-1 0-1.8.3-2.4.9M12 2l2 2-2 2M12 8l2 2-2 2"/></S>,
  repeat: <S><path d="M3 7V6a2 2 0 0 1 2-2h8M11 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3M5 14l-2-2 2-2"/></S>,
  search: <S s={14}><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></S>,
  home: <S s={18}><path d="M2.5 7.2 8 2.8l5.5 4.4V13a.7.7 0 0 1-.7.7H9.8V10H6.2v3.7H3.2a.7.7 0 0 1-.7-.7Z"/></S>,
  searchL: <S s={18}><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></S>,
  wave: <S s={18}><path d="M1.5 8c1.2 0 1.2-3 2.4-3s1.2 6 2.4 6 1.2-8 2.4-8 1.2 10 2.4 10 1.2-5 2.4-5 1 0 1 0"/></S>,
  heart: <S s={18}><path d="M8 13.5S2.5 10.3 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3C13.5 10.3 8 13.5 8 13.5Z"/></S>,
  heartS: (on) => <svg width="15" height="15" viewBox="0 0 16 16" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round"><path d="M8 13.5S2.5 10.3 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3C13.5 10.3 8 13.5 8 13.5Z"/></svg>,
  gear: <S s={18}><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/></S>,
  lyrics: <S s={15}><path d="M2.5 4h11M2.5 8h7M2.5 12h9"/></S>,
  queue: <S s={15}><path d="M2.5 4h11M2.5 8h11M2.5 12h6M12 10.5v4M10 12.5h4"/></S>,
  expand: <S s={14}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></S>,
  close: <S s={14}><path d="m4 4 8 8M12 4l-8 8"/></S>,
  vol: <S s={15}><path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5ZM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8"/></S>,
  mute: <S s={15}><path d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5ZM11 6l4 4M15 6l-4 4"/></S>,
  island: <S s={16}><rect x="3" y="2.5" width="10" height="4" rx="2"/><path d="M2 10h12M2 13h8"/></S>,
  plus: <S s={14}><path d="M8 3v10M3 8h10"/></S>,
  back: <S s={12}><path d="M10 3 5 8l5 5"/></S>,
};

/* ───────────── small pieces ───────────── */
function Eq({ n = 4, h = 14 }) {
  const lv = useStore(levels);
  return <div className="eq" style={{ height: h }}>{Array.from({ length: n }, (_, i) => <i key={i} style={{ transform: `scaleY(${.15 + (lv[i % lv.length] || 0) * .85})` }} />)}</div>;
}
function Seek({ value, max, onSeek, thin }) {
  const ref = useRef(null);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); onSeek(clamp((e.clientX - r.left) / r.width) * max); };
  const down = (e) => {
    at(e);
    const mv = (ev) => at(ev), up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const pct = max ? clamp(value / max) * 100 : 0;
  return (
    <div className="seek" ref={ref} onPointerDown={down} style={thin ? { height: 10 } : null}>
      <div className="tr"><div className="fl" style={{ width: `${pct}%` }} /><div className="th" style={{ left: `${pct}%` }} /></div>
    </div>
  );
}
const Img = ({ src, alt = '' }) => {
  const [err, setErr] = useState(false);
  useEffect(() => setErr(false), [src]);
  return src && !err ? <img src={src} alt={alt} loading="lazy" onError={() => setErr(true)} /> : <div style={{ width: '100%', height: '100%', background: 'linear-gradient(135deg,#1c1c20,#121214)' }} />;
};

/* ───────────── lyrics ───────────── */
const LEAD = 0.15; // строка появляется чуть раньше голоса
function Lyrics({ lines, onSeek, full, offset = 0 }) {
  const raw = useStore(clock);
  const time = raw + offset + LEAD;
  const wrap = useRef(null), refs = useRef([]);
  const items = useMemo(() => [{ t: 0, gap: true }, ...lines.map(([t, text, words]) => ({ t, text, words, gap: text === '♪' }))], [lines]);
  let active = 0;
  for (let i = 0; i < items.length; i++) { if (items[i].t <= time) active = i; else break; }
  const cur = items[active], nxt = items[active + 1];
  const p = cur.gap ? clamp((time - cur.t) / ((nxt ? nxt.t : cur.t + 4) - cur.t)) : 0;
  const [y, setY] = useState(0);
  const measure = useCallback(() => {
    const el = refs.current[active], w = wrap.current;
    if (el && w) setY(el.offsetTop + el.offsetHeight / 2 - w.clientHeight * (full ? .42 : .36));
  }, [active, full]);
  useLayoutEffect(measure, [measure, items]);
  useEffect(() => { const ro = new ResizeObserver(measure); ro.observe(wrap.current); return () => ro.disconnect(); }, [measure]);
  return (
    <div className="lyr" ref={wrap}>
      <div className="lyr-in" style={{ transform: `translate3d(0,${-y}px,0)` }}>
        {items.map((it, i) => {
          const d = Math.abs(i - active), act = i === active;
          const style = act ? null : { opacity: d > 4 ? .12 : Math.max(.16, .55 - d * .1), filter: d <= 3 ? `blur(${(d * .6).toFixed(1)}px)` : undefined };
          if (it.gap) return (
            <div key={i} ref={(el) => (refs.current[i] = el)} className={`gapdots ${act ? 'act' : ''}`} style={style} onClick={() => onSeek(it.t)}>
              {[0, 1, 2].map((k) => <span key={k} style={{ opacity: .25 + (act ? clamp(p * 3 - k) : 0) * .75 }} />)}
            </div>
          );
          if (!act) return <button key={i} ref={(el) => (refs.current[i] = el)} className="line" style={style} onClick={() => onSeek(it.t + .02)}>{it.text}</button>;
          if (!it.words) // тайминга слов нет — подсвечиваем строку целиком, без «угадывания» слов
            return <button key={i} ref={(el) => (refs.current[i] = el)} className="line act full" onClick={() => onSeek(it.t + .02)}>{it.text}</button>;
          const ws = it.words; const end = nxt ? nxt.t : ws[ws.length - 1][0] + 1;
          return (
            <button key={i} ref={(el) => (refs.current[i] = el)} className="line act" onClick={() => onSeek(it.t + .02)}>
              {ws.map(([wt, w], k) => {
                const wEnd = Math.min(ws[k + 1] ? ws[k + 1][0] : end, wt + 1.2);
                const f = clamp((time - wt) / Math.max(.08, wEnd - wt));
                return <span key={k} className="w" style={{ '--f': f }}>{w}{k < ws.length - 1 && !/\s$/.test(w) ? ' ' : ''}</span>;
              })}
            </button>
          );
        })}
        <div style={{ height: '60vh' }} />
      </div>
    </div>
  );
}
function LyricsBody({ lyr, onSeek, full, offset }) {
  if (!lyr || lyr.status === 'loading') return <div className="nolrc"><span className="spin" style={{ display: 'inline-block', color: '#55555B' }} /></div>;
  if (lyr.synced) return <Lyrics lines={lyr.synced} onSeek={onSeek} full={full} offset={offset} />;
  if (lyr.plain) return <div className="plain">{lyr.plain}</div>;
  if (lyr.instrumental) return <div className="nolrc"><b>Инструментал</b>Здесь просто музыка.</div>;
  return <div className="nolrc"><b>Текст не найден</b>В LRCLIB нет текста для этого трека.</div>;
}

/* ───────────── track row / card ───────────── */
const dlStore = createStore({});
function DlBtn({ t }) {
  const st = useStore(dlStore)[tkey(t)];
  const icon = st === 'done' ? <S s={14}><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></S> : st === 'loading' || st === 'queued' ? <span className="spin" style={{ width: 11, height: 11 }} />
    : <S s={14}><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></S>;
  return <button className={`more dl ${st === 'done' ? 'on' : ''}`} title={st === 'done' ? 'Скачано — играет офлайн' : 'Скачать'} onClick={(e) => { e.stopPropagation(); if (!st || st === 'error') api.invoke('dl:tracks', [t]); }}>{icon}</button>;
}
function TapBox({ lines, offset, lineRef, onTap }) {
  const t = useStore(clock) + offset;
  // следующая строка, которую певец ещё не начал (с запасом, если текст сильно отстаёт)
  const line = (lines || []).find(([lt, x]) => lt > t - 2 && x !== '♪') || null;
  lineRef.current = line;
  return (
    <div className="tapbox">
      <div className="d">Нажми, когда певец начнёт эту строку (или клавиша S):</div>
      <button className="tapbtn" onClick={onTap} disabled={!line}>{line ? `«${line[1]}»` : '…'}</button>
    </div>
  );
}
function Row({ t, i, cur, playing, liked, onPlay, onLike, onArtist, onQueue }) {
  return (
    <div className={`row ${cur ? 'cur' : ''}`} onDoubleClick={onPlay}>
      <span className="n mono">
        {cur && playing ? <Eq n={3} h={11} /> : <><span className="num">{String(i + 1).padStart(2, '0')}</span><button className="pi" onClick={onPlay}>{I.play}</button></>}
      </span>
      <div className="cvs"><Img src={t.cover} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="t">{t.title}</div>
        <div className="a"><span className="lnk" onClick={(e) => { e.stopPropagation(); onArtist(t); }}>{t.artist || '—'}</span></div>
      </div>
      <span className="badge">{(t.alts ? [t.src, ...t.alts] : [t.src]).map((x) => <i key={x} className={`srcdot src-${x}`} />)}{SRC_SHORT[t.src]}{t.alts ? ` +${t.alts.length}` : ''}</span>
      <button className={`heart ${liked ? 'on' : ''}`} onClick={onLike}>{I.heartS(liked)}</button>
      <span className="d mono">{t.duration ? fmt(t.duration) : '—'}</span>
      <span className="rbtns"><DlBtn t={t} /><button className="more" title="В очередь" onClick={onQueue}>{I.plus}</button></span>
    </div>
  );
}
function Card({ t, onPlay, onArtist }) {
  return (
    <div className="card" onDoubleClick={onPlay}>
      <div className="cv"><Img src={t.cover} /><button className="pl" onClick={onPlay}>{I.play}</button></div>
      <div className="t">{t.title}</div>
      <div className="a"><i className={`srcdot src-${t.src}`} /><span className="lnk" onClick={() => onArtist(t)}>{t.artist}</span></div>
    </div>
  );
}
const SkelRows = ({ n = 6 }) => <div className="tlist">{Array.from({ length: n }, (_, i) => <div key={i} className="skel" style={{ height: 52, margin: '3px 0' }} />)}</div>;
const SkelCards = () => <div className="hrow">{Array.from({ length: 7 }, (_, i) => <div key={i}><div className="skel" style={{ aspectRatio: 1, borderRadius: 9 }} /><div className="skel" style={{ height: 12, marginTop: 10, width: '80%' }} /></div>)}</div>;

function uniqArtists(tracks, n = 14) {
  const m = new Map();
  for (const t of tracks) {
    const name = (t.artist || '').split(/,| & | feat/i)[0].trim();
    if (!name) continue;
    const k = name.toLowerCase();
    if (!m.has(k)) m.set(k, { name, cover: t.cover, src: t.src, artistId: t.artistId, count: 0 });
    m.get(k).count++;
  }
  return [...m.values()].slice(0, n);
}
function Artists({ list, onOpen }) {
  return (
    <div className="artists">
      {list.map((a) => (
        <button key={a.name} className="ac" onClick={() => onOpen(a)}>
          <div className="ph"><Img src={a.cover} /></div>
          <div className="n">{a.name}</div>
          <div className="m">{a.count} трек.</div>
        </button>
      ))}
    </div>
  );
}

/* ───────────── «Моя волна»: живой визуализатор ─────────────
   Размытые «капли» цвета обложки дышат под музыку + тонкие линии-волны поверх. */
// Шар «Моей волны» в духе голосового режима ChatGPT: внутри плывут облака цвета обложки,
// шар дышит и подпрыгивает под музыку, от сильных долей расходятся кольца.
function WaveViz({ pal, playing, height = 420, intensity = 1, size = .62 }) {
  const ref = useRef(null);
  const palRef = useRef(pal); palRef.current = pal;
  const playRef = useRef(playing); playRef.current = playing;
  useEffect(() => {
    const c = ref.current; const x = c.getContext('2d');
    let raf, t = 0, last = performance.now(), lv = [0, 0, 0, 0, 0], en = 0, prevEn = 0, visible = true, rings = [], cooldown = 0;
    const fit = () => { const r = c.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2); c.width = Math.max(1, r.width * dpr); c.height = Math.max(1, r.height * dpr); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(c);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting)); io.observe(c);
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) { last = now; return; }
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      const target = playRef.current ? levels.get() : [0, 0, 0, 0, 0];
      lv = lv.map((v, i) => v + ((target[i] || 0) - v) * Math.min(1, dt * 10));
      prevEn = en; en = (lv[0] * 1.5 + lv[1] * 1.1 + lv[2] * .8 + lv[3] * .4) / 3.8;
      t += dt * (playRef.current ? .6 + en * 1.4 : .25);
      cooldown -= dt;
      if (playRef.current && en - prevEn > .045 && cooldown <= 0) { rings.push({ a: 0 }); cooldown = .35; }
      const W = c.width, H = c.height; x.clearRect(0, 0, W, H);
      const { h = 210, ts = 40 } = palRef.current || {};
      const S = clamp(ts * 1.6, 35, 85);
      const base = Math.min(W, H) * size * .5 * intensity;
      const R = base * (1 + en * .14 + Math.sin(t * 1.3) * .012);
      const cx = W / 2, cy = H / 2 + Math.sin(t * .9) * base * .04;
      // кольца
      rings = rings.filter((r) => (r.a += dt / 1.3) < 1);
      for (const r of rings) {
        x.beginPath(); x.arc(cx, cy, R * (1 + r.a * .7), 0, Math.PI * 2);
        x.strokeStyle = `hsla(${h},${S}%,75%,${(1 - r.a) * .35})`; x.lineWidth = base * .02 * (1 - r.a) + 1; x.stroke();
      }
      // свечение
      const glow = x.createRadialGradient(cx, cy, R * .8, cx, cy, Math.min(R * 1.75, H / 2 - 2, W / 2 - 2));
      glow.addColorStop(0, `hsla(${h},${S}%,60%,${.28 + en * .35})`); glow.addColorStop(1, `hsla(${h},${S}%,50%,0)`);
      x.fillStyle = glow; x.fillRect(0, 0, W, H);
      // шар
      x.save(); x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.clip();
      const bg = x.createRadialGradient(cx - R * .35, cy - R * .4, R * .05, cx, cy, R);
      bg.addColorStop(0, `hsl(${h + 10},${S}%,72%)`); bg.addColorStop(.55, `hsl(${h + 25},${S}%,48%)`); bg.addColorStop(1, `hsl(${h + 45},${S * .8}%,24%)`);
      x.fillStyle = bg; x.fillRect(cx - R, cy - R, R * 2, R * 2);
      x.globalCompositeOperation = 'screen';
      const blobs = [[-30, .62, 66], [35, .55, 58], [70, .5, 52], [0, .45, 80], [180, .4, 62]];
      blobs.forEach(([dh, rr, L], i) => {
        const sp = .35 + i * .13;
        const bx = cx + Math.cos(t * sp + i * 1.9) * R * (.35 + lv[i] * .25);
        const by = cy + Math.sin(t * sp * 1.2 + i * 2.7) * R * (.32 + lv[(i + 2) % 5] * .25);
        const br = R * rr * (1 + lv[i] * .4);
        const g = x.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${h + dh},${i === 3 ? 30 : S}%,${L}%,.75)`); g.addColorStop(1, `hsla(${h + dh},${S}%,${L}%,0)`);
        x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
      });
      // белые «облака» как у ChatGPT
      for (let i = 0; i < 2; i++) {
        const bx = cx + Math.cos(t * .5 + i * 3) * R * .4, by = cy - R * .25 + Math.sin(t * .7 + i) * R * .2, br = R * (.5 + en * .2);
        const g = x.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `rgba(255,255,255,${.38 + en * .2})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
      }
      x.globalCompositeOperation = 'source-over';
      const rim = x.createRadialGradient(cx, cy, R * .6, cx, cy, R);
      rim.addColorStop(0, 'rgba(0,0,0,0)'); rim.addColorStop(1, 'rgba(0,0,0,.28)');
      x.fillStyle = rim; x.fillRect(cx - R, cy - R, R * 2, R * 2);
      x.restore();
      x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.strokeStyle = 'rgba(255,255,255,.12)'; x.lineWidth = 1.2; x.stroke();
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, [size, intensity]);
  return <div className="wviz" style={{ height }}><canvas ref={ref} /></div>;
}

const CHARACTERS = [['любимое', 'Любимое', 'Похожее на то, что ты слушаешь'], ['незнакомое', 'Незнакомое', 'Новые артисты'], ['популярное', 'Популярное', 'Чарты и хиты']];
const MOODS = [['бодрое', 'Бодрое'], ['спокойное', 'Спокойное'], ['весёлое', 'Весёлое'], ['грустное', 'Грустное']];
const LANGS = [['русский', 'Русский'], ['иностранный', 'Иностранный'], ['без слов', 'Без слов']];

function WavePage({ P }) {
  const { settings, setSettings, startWave, waveLoading, waveMode, cur, playing, toggle, next, pal, liked, toggleLike, dislike } = P;
  const w = settings.wave || {};
  const setW = (k, v) => setSettings((s) => ({ ...s, wave: { ...(s.wave || {}), [k]: (s.wave || {})[k] === v && k !== 'character' ? '' : v } }));
  const toggleGenre = (g) => setSettings((s) => ({ ...s, genres: s.genres.includes(g) ? s.genres.filter((x) => x !== g) : [...s.genres, g] }));
  const first = useRef(true);
  useEffect(() => { // меняешь настройки во время волны — волна перестраивается
    if (first.current) { first.current = false; return; }
    if (!waveMode) return;
    const id = setTimeout(() => startWave(), 600);
    return () => clearTimeout(id);
  }, [w.character, w.mood, w.lang, settings.genres.join(',')]);
  const on = waveMode && cur;
  return (
    <div className="page wave-page">
      <div className="wstage">
        <WaveViz pal={pal} playing={playing && waveMode} height={360} size={.66} />
        <div className="wcenter">
          <div className="label" style={{ color: 'rgba(255,255,255,.55)' }}>Моя волна</div>
          {on ? <>
            <div className="wtitle">{cur.title}</div>
            <div className="wart">{cur.artist}</div>
          </> : <div className="wtitle" style={{ marginTop: 10 }}>Музыка под тебя<br />без конца</div>}
          <div className="wbtns">
            {on && <button className="wb" title="Не нравится" onClick={dislike}><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6"/><path d="m4 12 8-8"/></svg></button>}
            <button className="bigplay wplay" onClick={() => (on ? toggle() : startWave())}>{waveLoading ? <span className="spin" /> : on && playing ? I.pauseL : I.playL}</button>
            {on && <button className={`wb ${liked ? 'on' : ''}`} title="Нравится" onClick={() => toggleLike(cur)}>{I.heartS(liked)}</button>}
          </div>
          {on && <button className="wskip" onClick={() => next()}>Следующий {I.next}</button>}
        </div>
      </div>

      <div className="wset">
        <div className="wgroup">
          <div className="label">Характер</div>
          <div className="wchars">
            {CHARACTERS.map(([k, v, d]) => (
              <button key={k} className={`wchar ${(w.character || 'любимое') === k ? 'on' : ''}`} onClick={() => setW('character', k)}>
                <b>{v}</b><span>{d}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="wgroup">
          <div className="label">Настроение</div>
          <div className="row">{MOODS.map(([k, v]) => <button key={k} className={`chip ${w.mood === k ? 'on' : ''}`} onClick={() => setW('mood', k)}>{v}</button>)}</div>
          <div className="label" style={{ marginTop: 16 }}>Язык</div>
          <div className="row">{LANGS.map(([k, v]) => <button key={k} className={`chip ${w.lang === k ? 'on' : ''}`} onClick={() => setW('lang', k)}>{v}</button>)}</div>
        </div>
        <div className="wgroup" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Жанры · {settings.genres.length || 'любые'}</div>
          <div className="row">{GENRES.map((g) => <button key={g} className={`chip ${settings.genres.includes(g) ? 'on' : ''}`} onClick={() => toggleGenre(g)}>{g}</button>)}</div>
        </div>
      </div>
    </div>
  );
}

/* ───────────── pages ───────────── */
function Home({ P }) {
  const { settings, setSettings, history, likes, startWave, waveLoading, playList, openArtist, trending } = P;
  const genres = settings.genres;
  const toggleGenre = (g) => setSettings((s) => ({ ...s, genres: s.genres.includes(g) ? s.genres.filter((x) => x !== g) : [...s.genres, g] }));
  const toggleSrc = (k) => setSettings((s) => ({ ...s, sources: { ...s.sources, [k]: !s.sources[k] } }));
  const hour = new Date().getHours();
  const greet = hour < 6 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  const recent = history.slice(0, 14);
  const artists = uniqArtists([...history, ...likes, ...(trending.hits || [])]);
  return (
    <div className="page">
      <div className="label">{greet}</div>
      <div className="h1" style={{ marginTop: 6, marginBottom: 22 }}>Что включим?</div>

      <div className="hero">
        <div className="hero-viz"><WaveViz pal={P.pal} playing={P.playing && P.waveMode} height={260} size={.7} /></div>
        <div className="hero-top">
          <div>
            <h2>Моя волна</h2>
            <div className="sub">Бесконечный поток из всех источников — под твою историю и жанры</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn sec" style={{ background: 'rgba(0,0,0,.25)' }} onClick={() => P.go('wave')}>Настроить</button>
            <button className="bigplay" onClick={startWave}>{waveLoading ? <span className="spin" /> : I.playL}</button>
          </div>
        </div>
        <div className="label" style={{ marginTop: 22 }}>Источники</div>
        <div className="row">
          {Object.keys(SRC).map((k) => (
            <button key={k} className={`chip ${settings.sources[k] ? 'on' : ''}`} onClick={() => toggleSrc(k)}><i className={`dot src-${k}`} />{SRC[k]}</button>
          ))}
        </div>
        <div className="label" style={{ marginTop: 16 }}>Жанры · {genres.length || 'любые'}</div>
        <div className="row">
          {GENRES.map((g) => <button key={g} className={`chip ${genres.includes(g) ? 'on' : ''}`} onClick={() => toggleGenre(g)}>{g}</button>)}
        </div>
      </div>

      {P.playlists.length > 0 && <>
        <div className="h2">Твои плейлисты <small className="lnk" onClick={() => P.go('library')}>все →</small></div>
        <div className="hrow">{P.playlists.slice(0, 12).map((pl) => <PlaylistCard key={pl.id} pl={pl} onOpen={() => P.go('playlist', { plId: pl.id })} onPlay={() => playList(pl.tracks, 0)} />)}</div>
      </>}
      {!P.playlists.length && <div className="hero" style={{ marginTop: 16, padding: '16px 20px', background: '#121214' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div><div style={{ fontWeight: 600 }}>Перенеси свою музыку</div><div className="sub">Лайки и плейлисты из SoundCloud и Spotify — в один клик.</div></div>
          <button className="btn pri" onClick={() => P.go('library')}>Импортировать</button>
        </div>
      </div>}

      {recent.length > 0 && <>
        <div className="h2">Недавно слушал <small>{history.length} в истории</small></div>
        <div className="hrow">{recent.map((t, i) => <Card key={tkey(t) + i} t={t} onPlay={() => playList(recent, i)} onArtist={openArtist} />)}</div>
      </>}

      {artists.length > 0 && <>
        <div className="h2">Популярные авторы</div>
        <Artists list={artists} onOpen={openArtist} />
      </>}

      <div className="h2">Хиты сейчас <small>YouTube Music</small></div>
      {trending.loading ? <SkelCards /> : (trending.hits || []).length
        ? <div className="hrow">{trending.hits.map((t, i) => <Card key={tkey(t)} t={t} onPlay={() => playList(trending.hits, i)} onArtist={openArtist} />)}</div>
        : <div className="empty">Не удалось загрузить — проверь интернет или включи YouTube Music в источниках.</div>}

      {(trending.au || []).length > 0 && <>
        <div className="h2">В тренде на Audius <small>за неделю</small></div>
        <div className="hrow">{trending.au.map((t, i) => <Card key={tkey(t)} t={t} onPlay={() => playList(trending.au, i)} onArtist={openArtist} />)}</div>
      </>}
    </div>
  );
}

function Search({ P }) {
  const { query, search, results, searching, playList, cur, playing, likes, toggleLike, openArtist, addQueue, settings } = P;
  const [tab, setTab] = useState('all');
  const all = useMemo(() => {
    if (!results) return [];
    const { yt = [], sc = [], au = [] } = results;
    const out = []; const n = Math.max(yt.length, sc.length, au.length);
    for (let i = 0; i < n; i++) { if (sc[i]) out.push(sc[i]); if (yt[i]) out.push(yt[i]); if (i % 2 === 0 && au[i / 2]) out.push(au[i / 2]); }
    for (let i = Math.ceil(n / 2); i < au.length; i++) if (au[i]) out.push(au[i]);
    // один и тот же трек из разных источников — одной строкой (играем SoundCloud: быстрее и без блокировок)
    const nk = (t) => (t.artist.split(/,|&/)[0] + ' ' + t.title).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const map = new Map(), res = [];
    for (const t of out) {
      const k = nk(t); const ex = map.get(k);
      if (!ex) { const c = { ...t }; map.set(k, c); res.push(c); continue; }
      if (ex.src !== t.src && !(ex.alts || []).includes(t.src)) ex.alts = [...(ex.alts || []), t.src];
      if (!ex.cover && t.cover) ex.cover = t.cover;
    }
    return res;
  }, [results]);
  const list = tab === 'all' ? all : (results?.[tab] || []);
  const best = list[0];
  const likedSet = useMemo(() => new Set(likes.map(tkey)), [likes]);
  if (!query) return (
    <div className="page"><div className="h1">Поиск</div><div className="sub">Один поиск по YouTube Music, SoundCloud и Audius. Нажми <kbd>Ctrl</kbd> <kbd>K</kbd>.</div></div>
  );
  return (
    <div className="page">
      <div className="tabs">
        {[['all', 'Все'], ...Object.entries(SRC).filter(([k]) => settings.sources[k])].map(([k, v]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {k !== 'all' && <i className={`dot src-${k}`} />}{v}{results && k !== 'all' ? ` · ${results[k]?.length || 0}` : ''}
          </button>
        ))}
      </div>
      {searching && !list.length ? <div className="sgrid" style={{ marginTop: 26 }}><div className="skel" style={{ height: 220, borderRadius: 16 }} /><SkelRows n={4} /></div>
        : !list.length ? <div className="empty">Ничего не нашлось по «{query}».</div>
        : <>
          <div className="sgrid" style={{ marginTop: 26 }}>
            <div>
              <div className="h2" style={{ marginTop: 0 }}>Лучший результат</div>
              <div className="best" onDoubleClick={() => playList(list, 0)}>
                <img src={best.cover} alt="" />
                <div><div className="t">{best.title}</div><div className="sub"><span className="lnk" onClick={() => openArtist(best)}>{best.artist}</span> · <span className="badge"><i className={`srcdot src-${best.src}`} />{SRC_ALL[best.src]}</span></div></div>
                <button className="bigplay" onClick={() => playList(list, 0)}>{I.playL}</button>
              </div>
            </div>
            <div>
              <div className="h2" style={{ marginTop: 0 }}>Треки {searching && <span className="spin" style={{ width: 12, height: 12, color: '#55555B' }} />}</div>
              <div className="tlist">{list.slice(1, 6).map((t, i) => (
                <Row key={tkey(t)} t={t} i={i} cur={tkey(t) === tkey(cur)} playing={playing} liked={likedSet.has(tkey(t))}
                  onPlay={() => playList(list, i + 1)} onLike={() => toggleLike(t)} onArtist={openArtist} onQueue={() => addQueue(t)} />
              ))}</div>
            </div>
          </div>
          <div className="h2">Артисты</div>
          <Artists list={uniqArtists(list, 12)} onOpen={openArtist} />
          {list.length > 6 && <>
            <div className="h2">Ещё треки <small>{list.length}</small></div>
            <div className="tlist">{list.slice(6).map((t, i) => (
              <Row key={tkey(t)} t={t} i={i + 5} cur={tkey(t) === tkey(cur)} playing={playing} liked={likedSet.has(tkey(t))}
                onPlay={() => playList(list, i + 6)} onLike={() => toggleLike(t)} onArtist={openArtist} onQueue={() => addQueue(t)} />
            ))}</div>
          </>}
        </>}
    </div>
  );
}

function Artist({ P, artist }) {
  const { settings, playList, cur, playing, likes, toggleLike, openArtist, addQueue, go, history } = P;
  const [tracks, setTracks] = useState(null);
  useEffect(() => {
    setTracks(null);
    api.invoke('artist', artist, settings.sources).then(setTracks).catch(() => setTracks([]));
  }, [artist.name]);
  const likedSet = useMemo(() => new Set(likes.map(tkey)), [likes]);
  const bySrc = (k) => (tracks || []).filter((t) => t.src === k).length;
  const heard = history.filter((t) => t.artist.toLowerCase().includes(artist.name.toLowerCase())).length;
  return (
    <div className="page">
      <button className="back" onClick={() => go('back')}>{I.back} Назад</button>
      <div className="ahero">
        <div className="ph"><Img src={artist.cover || tracks?.[0]?.cover} /></div>
        <div>
          <div className="label">Артист</div>
          <h1 style={{ marginTop: 8 }}>{artist.name}</h1>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className="btn pri" disabled={!tracks?.length} onClick={() => tracks?.length && playList(tracks, 0)}>{I.play} Слушать</button>
            <button className="btn sec" disabled={!tracks?.length} onClick={() => tracks?.length && playList([...tracks].sort(() => Math.random() - .5), 0)}>{I.shuffle} Перемешать</button>
          </div>
        </div>
      </div>
      <div className="stats">
        {Object.keys(SRC).map((k) => <div className="stat" key={k}><div className="v mono">{tracks ? bySrc(k) : '·'}</div><div className="k">{SRC[k]}</div></div>)}
        <div className="stat"><div className="v mono">{heard}</div><div className="k">прослушано тобой</div></div>
      </div>
      <div className="h2">Треки</div>
      {!tracks ? <SkelRows /> : !tracks.length ? <div className="empty">Не нашёл треков этого артиста.</div>
        : <div className="tlist">{tracks.map((t, i) => (
          <Row key={tkey(t)} t={t} i={i} cur={tkey(t) === tkey(cur)} playing={playing} liked={likedSet.has(tkey(t))}
            onPlay={() => playList(tracks, i)} onLike={() => toggleLike(t)} onArtist={openArtist} onQueue={() => addQueue(t)} />
        ))}</div>}
    </div>
  );
}

function ImportBox({ P }) {
  const { importUrl, importCsv, importing } = P;
  const [url, setUrl] = useState('');
  const file = useRef(null);
  return (
    <div className="imp">
      <div className="label">Импорт</div>
      <div className="imp-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && importUrl(url).then((ok) => ok && setUrl(''))}
          placeholder="Ссылка: плейлист/альбом Spotify, профиль или плейлист SoundCloud" />
        <button className="btn pri" disabled={!url || importing} onClick={() => importUrl(url).then((ok) => ok && setUrl(''))}>{importing ? <span className="spin" /> : 'Импорт'}</button>
        <button className="btn sec" disabled={importing} onClick={() => file.current.click()}>CSV</button>
        <input ref={file} type="file" accept=".csv,text/csv" multiple hidden onChange={async (e) => { for (const f of e.target.files) await importCsv(f.name, await f.text()); e.target.value = ''; }} />
      </div>
      <div className="imp-hint">
        SoundCloud: ссылка на профиль подтянет все лайки и плейлисты. Spotify: публичный плейлист или альбом по ссылке (до 100 треков).
        Весь Spotify, включая «Любимые треки»: выгрузи на <span className="mono">exportify.net</span> и перетащи CSV сюда.
      </div>
    </div>
  );
}

function PlaylistCard({ pl, onOpen, onPlay }) {
  const covers = [...new Set(pl.tracks.map((t) => t.cover).filter(Boolean))].slice(0, 4);
  return (
    <div className="card" onClick={onOpen}>
      <div className="cv">
        {pl.cover ? <Img src={pl.cover} /> : covers.length >= 4 ? <div className="mosaic">{covers.map((c) => <img key={c} src={c} alt="" />)}</div> : <Img src={covers[0]} />}
        <button className="pl" onClick={(e) => { e.stopPropagation(); onPlay(); }}>{I.play}</button>
      </div>
      <div className="t">{pl.name}</div>
      <div className="a"><i className={`srcdot src-${pl.source}`} />{SRC_ALL[pl.source] || 'Плейлист'} · {pl.tracks.length}</div>
    </div>
  );
}

function Library({ P }) {
  const { likes, history, playlists, playList, cur, playing, toggleLike, openArtist, addQueue, go } = P;
  const [tab, setTab] = usePersist('libtab', 'playlists');
  const list = tab === 'likes' ? likes : tab === 'downloads' ? P.downloads : history;
  const likedSet = useMemo(() => new Set(likes.map(tkey)), [likes]);
  return (
    <div className="page">
      <div className="h1">Медиатека</div>
      <div className="tabs" style={{ marginTop: 16 }}>
        <button className={`chip ${tab === 'playlists' ? 'on' : ''}`} onClick={() => setTab('playlists')}>Плейлисты · {playlists.length}</button>
        <button className={`chip ${tab === 'likes' ? 'on' : ''}`} onClick={() => setTab('likes')}>Любимое · {likes.length}</button>
        <button className={`chip ${tab === 'history' ? 'on' : ''}`} onClick={() => setTab('history')}>История · {history.length}</button>
        <button className={`chip ${tab === 'downloads' ? 'on' : ''}`} onClick={() => setTab('downloads')}>Скачанное · {P.downloads.length}</button>
      </div>
      {tab === 'playlists' ? <>
        <ImportBox P={P} />
        {playlists.length > 0 && <div className="pgrid">{playlists.map((pl) => (
          <PlaylistCard key={pl.id} pl={pl} onOpen={() => go('playlist', { plId: pl.id })} onPlay={() => playList(pl.tracks, 0)} />
        ))}</div>}
      </> : <>
        {list.length > 0 && <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn pri" onClick={() => playList(list, 0)}>{I.play} Слушать всё</button>
          {tab === 'likes' && <button className="btn sec" onClick={() => { api.invoke('dl:tracks', list); P.toast(`Скачиваю ${list.length} треков…`); }}>Скачать всё</button>}
        </div>}
        <div className="tlist" style={{ marginTop: 18 }}>
          {!list.length ? <div className="empty">{tab === 'likes' ? 'Ставь ♥ трекам — они появятся здесь.' : tab === 'downloads' ? 'Жми ↓ у трека или «Скачать всё» в плейлисте — треки будут играть мгновенно и без интернета.' : 'Пока пусто.'}</div>
            : list.map((t, i) => (
              <Row key={tkey(t) + i} t={t} i={i} cur={tkey(t) === tkey(cur)} playing={playing} liked={likedSet.has(tkey(t))}
                onPlay={() => playList(list, i)} onLike={() => toggleLike(t)} onArtist={openArtist} onQueue={() => addQueue(t)} />
            ))}
        </div>
      </>}
    </div>
  );
}

function Playlist({ P, plId }) {
  const { playlists, setPlaylists, playList, cur, playing, likes, toggleLike, openArtist, addQueue, go } = P;
  const pl = playlists.find((p) => p.id === plId);
  const [q, setQ] = useState('');
  const likedSet = useMemo(() => new Set(likes.map(tkey)), [likes]);
  if (!pl) return <div className="page"><button className="back" onClick={() => go('back')}>{I.back} Назад</button><div className="empty">Плейлист удалён.</div></div>;
  const shown = q ? pl.tracks.filter((t) => (t.title + ' ' + t.artist).toLowerCase().includes(q.toLowerCase())) : pl.tracks;
  const total = pl.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const cover = pl.cover || pl.tracks.find((t) => t.cover)?.cover;
  return (
    <div className="page">
      <button className="back" onClick={() => go('back')}>{I.back} Назад</button>
      <div className="ahero">
        <div className="ph" style={{ borderRadius: 14 }}><Img src={cover} /></div>
        <div>
          <div className="label">Плейлист · {SRC_ALL[pl.source] || 'импорт'}</div>
          <h1 style={{ marginTop: 8, fontSize: 44, textTransform: 'none' }}>{pl.name}</h1>
          <div className="sub">{pl.tracks.length} треков · {Math.round(total / 60)} мин{pl.source === 'sp' ? ' · играет через полные версии с SoundCloud / YouTube Music' : ''}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className="btn pri" onClick={() => playList(pl.tracks, 0)}>{I.play} Слушать</button>
            <button className="btn sec" onClick={() => playList([...pl.tracks].sort(() => Math.random() - .5), 0)}>{I.shuffle} Перемешать</button>
            <button className="btn sec" onClick={() => { api.invoke('dl:tracks', pl.tracks); P.toast(`Скачиваю ${pl.tracks.length} треков — потом они играют мгновенно`); }}>Скачать всё</button>
            <button className="btn sec" onClick={() => { setPlaylists((l) => l.filter((x) => x.id !== pl.id)); go('back'); }}>Удалить</button>
          </div>
        </div>
      </div>
      <label className="tsearch" style={{ margin: '24px 0 10px', maxWidth: 360 }}>
        <span style={{ color: '#55555B', display: 'grid' }}>{I.search}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в плейлисте" />
      </label>
      {pl.partial && <div className="imp-hint" style={{ marginBottom: 10 }}>Spotify по ссылке отдаёт только первые 100 треков. Полный список — через CSV с exportify.net.</div>}
      <div className="tlist">{shown.slice(0, 600).map((t) => {
        const i = pl.tracks.indexOf(t);
        return <Row key={tkey(t) + i} t={t} i={i} cur={tkey(t) === tkey(cur)} playing={playing} liked={likedSet.has(tkey(t))}
          onPlay={() => playList(pl.tracks, i)} onLike={() => toggleLike(t)} onArtist={openArtist} onQueue={() => addQueue(t)} />;
      })}</div>
    </div>
  );
}

function CacheRow({ toast }) {
  const [size, setSize] = useState(null);
  useEffect(() => { api.invoke('cache:size').then(setSize); }, []);
  return (
    <div className="it"><div><div className="k">Кэш треков</div><div className="d">Прослушанные треки с YouTube лежат на диске и включаются мгновенно · {size == null ? '…' : `${(size / 1048576).toFixed(0)} МБ`} из 1500</div></div>
      <button className="btn sec" onClick={async () => { await api.invoke('cache:clear'); setSize(0); toast('Кэш очищен'); }}>Очистить</button></div>
  );
}

function Settings({ P }) {
  const { settings, setSettings, boot, info, toast } = P;
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const Tog = ({ on, onClick }) => <button className={`tog ${on ? 'on' : ''}`} onClick={onClick} />;
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="h1">Настройки</div>
      <div className="set">
        {Object.keys(SRC).map((k) => (
          <div className="it" key={k}>
            <div><div className="k"><i className={`srcdot src-${k}`} style={{ marginRight: 8 }} />{SRC[k]}</div><div className="d">{k === 'yt' ? 'Огромный каталог; трек скачивается в кэш через yt-dlp, старт 2–5 с' : k === 'sc' ? 'Прямой API: поиск и старт за доли секунды, превью отсеиваются' : 'Открытый API, полные треки без ключей'}</div></div>
            <Tog on={settings.sources[k]} onClick={() => set('sources', { ...settings.sources, [k]: !settings.sources[k] })} />
          </div>
        ))}
      </div>
      <div className="set">
        <div className="it"><div><div className="k">Dynamic Island</div><div className="d">Островок поверх всех окон. «Когда плеер свёрнут» — не мешает, пока окно плеера открыто.</div></div>
          <select className="sel" value={settings.islandMode || (settings.island === false ? 'off' : 'background')} onChange={(e) => set('islandMode', e.target.value)}>
            <option value="background">Когда плеер свёрнут</option><option value="always">Всегда</option><option value="off">Выключен</option>
          </select></div>
        <div className="it"><div><div className="k">Вход в YouTube через браузер</div><div className="d">Если YouTube пишет «подтвердите, что вы не бот» — возьмём куки из браузера, где ты вошёл в YouTube. Лучше всего работает Firefox; браузер при этом лучше закрыть.</div></div>
          <select className="sel" value={settings.ytCookies || ''} onChange={(e) => set('ytCookies', e.target.value)}>
            <option value="">Не использовать</option><option value="firefox">Firefox</option><option value="edge">Edge</option><option value="chrome">Chrome</option><option value="opera">Opera</option><option value="yandex">Яндекс Браузер</option>
          </select></div>
        <div className="it"><div><div className="k">Мгновенный старт</div><div className="d">Заранее скачивать два следующих трека очереди целиком</div></div><Tog on={settings.prefetch} onClick={() => set('prefetch', !settings.prefetch)} /></div>
      </div>
      <div className="set">
        <div className="it"><div><div className="k">yt-dlp</div><div className="d mono">{boot.state === 'ready' ? `версия ${boot.version}` : boot.state === 'downloading' ? `скачивается… ${boot.progress}%` : boot.state === 'error' ? `ошибка: ${boot.error}` : 'проверка…'}</div></div>
          <button className="btn sec" onClick={async () => { toast('Обновляю yt-dlp…'); try { const v = await api.invoke('ytdlp:update'); toast(`yt-dlp ${v}`); } catch (e) { toast('Не вышло: ' + e.message); } }}>Обновить</button></div>
        <CacheRow toast={toast} />
        <div className="it"><div><div className="k">Журнал</div><div className="d mono">{info?.logFile}</div></div><button className="btn sec" onClick={() => api.invoke('open:log')}>Открыть</button></div>
      </div>
      <div className="set">
        <div className="it"><div><div className="k">Обновления</div><div className="d">{P.upd.state === 'dev' ? 'Запуск из папки — автообновление работает в установленной версии' : P.upd.state === 'checking' ? 'Проверяю…' : P.upd.state === 'downloading' ? `Скачиваю ${P.upd.version || ''}… ${P.upd.progress || 0}%` : P.upd.state === 'ready' ? `Версия ${P.upd.version} готова к установке` : P.upd.state === 'latest' ? 'У тебя последняя версия' : P.upd.state === 'error' ? `Ошибка: ${P.upd.error}` : 'Проверяются автоматически каждые 30 минут'}</div></div>
          {P.upd.state === 'ready' ? <button className="btn pri" onClick={() => api.invoke('update:install')}>Перезапустить</button> : <button className="btn sec" onClick={() => api.invoke('update:check').then(P.setUpd)}>Проверить</button>}</div>
      </div>
      <div className="sub" style={{ marginTop: 18 }}>MudPlayer {info?.version} · тексты — lrclib.net</div>
    </div>
  );
}

/* ───────────── main app ───────────── */
function App() {
  const [info, setInfo] = useState(null);
  const [boot, setBoot] = useState({ state: 'checking', progress: 0 });
  const [settings, setSettings] = usePersist('settings', { sources: { yt: true, sc: true, au: true }, genres: [], islandMode: 'background', prefetch: true, ytCookies: '' });
  const [likes, setLikes] = usePersist('likes', []);
  const [history, setHistory] = usePersist('history', []);
  const [playlists, setPlaylists] = usePersist('playlists', []);
  const [disliked, setDisliked] = usePersist('disliked', []);
  const [offsets, setOffsets] = usePersist('offsets', {});
  const [importing, setImporting] = useState(false);
  const [vol, setVol] = usePersist('vol', .8);
  const [queue, setQueue] = useState([]);
  const [qi, setQi] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('off');
  const [waveMode, setWaveMode] = useState(false);
  const [waveLoading, setWaveLoading] = useState(false);
  const [lyr, setLyr] = useState(null);
  const [pal, setPal] = useState({ h: 30, s: 22, ts: 30 });
  const [rp, setRp] = usePersist('rp', 'lyrics');
  const [fullLyr, setFullLyr] = useState(false);
  const [nav, setNav] = useState([{ name: 'home' }]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [trending, setTrending] = useState({ loading: true });
  const [toasts, setToasts] = useState([]);
  const [muted, setMuted] = useState(false);
  const [dur, setDur] = useState(0);
  const audio = useRef(null);
  const graph = useRef(null);
  const errCount = useRef(0);
  const searchRef = useRef(null);
  const st = useRef({});
  const cur = queue[qi] || null;
  const view = nav[nav.length - 1];

  const toast = useCallback((msg) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const go = (name, params) => setNav((n) => (name === 'back' ? (n.length > 1 ? n.slice(0, -1) : n) : [...n, { name, ...params }]));

  /* boot */
  useEffect(() => {
    api.invoke('app:info').then((i) => { setInfo(i); setBoot(i.ytdlp); });
    return api.on('boot', setBoot);
  }, []);
  useEffect(() => {
    setTrending({ loading: true });
    api.invoke('trending', settings.sources).then((r) => setTrending({ ...r, loading: false })).catch(() => setTrending({ loading: false }));
  }, [settings.sources.yt, settings.sources.au]);
  const islandMode = settings.islandMode || (settings.island === false ? 'off' : 'background');
  useEffect(() => { api.send('island:visible', islandMode); }, [islandMode]);
  useEffect(() => api.on('island-mode', (m) => { setSettings((s) => ({ ...s, islandMode: m })); toast('Островок скрыт. Вернуть — кнопка слева внизу или Настройки.'); }), []);
  /* обновления */
  const [upd, setUpd] = useState({ state: 'idle' });
  useEffect(() => { api.invoke('update:state').then(setUpd); return api.on('update', (u) => setUpd((o) => ({ ...o, ...u }))); }, []);
  /* загрузки */
  const [downloads, setDownloads] = useState([]);
  const refreshDl = useCallback(() => api.invoke('dl:list').then((l) => {
    setDownloads(l.sort((a, b) => b.at - a.at).map((x) => x.track));
    const m = {}; l.forEach((x) => (m[x.id] = 'done')); dlStore.set({ ...dlStore.get(), ...m });
  }), []);
  useEffect(() => { refreshDl(); return api.on('dl', (d) => { dlStore.set({ ...dlStore.get(), [d.id]: d.state }); if (d.state === 'done') refreshDl(); if (d.state === 'error') toast('Не удалось скачать: ' + (d.error || '')); }); }, []);
  useEffect(() => { api.invoke('yt:config', { cookies: settings.ytCookies || '' }); }, [settings.ytCookies]);
  useEffect(() => api.on('notice', (n) => {
    if (n === 'yt-blocked') toast('YouTube просит подтвердить, что ты не бот (часто из-за VPN). Треки с YouTube теперь играют через SoundCloud.');
  }), []);

  /* audio engine */
  if (!audio.current) { audio.current = new Audio(); audio.current.crossOrigin = 'anonymous'; audio.current.preload = 'auto'; }
  const ensureGraph = () => {
    if (graph.current) { graph.current.ctx.resume(); return; }
    try {
      const ctx = new AudioContext(); const src = ctx.createMediaElementSource(audio.current);
      const an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = .78;
      src.connect(an); an.connect(ctx.destination);
      graph.current = { ctx, an, buf: new Uint8Array(an.frequencyBinCount) };
    } catch (e) { api.send('log', 'audio graph failed', e.message); }
  };
  useEffect(() => { audio.current.volume = muted ? 0 : vol * vol; }, [vol, muted]);

  const streamUrl = (t) => {
    const payload = { src: t.src, vid: t.vid, scid: t.scid, url: t.url, aid: t.aid, title: t.title, artist: t.artist, duration: t.duration };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `http://127.0.0.1:${info?.port}/stream?t=${b64}`;
  };

  const loadTrack = useCallback(async (t) => {
    if (!t || !info) return;
    ensureGraph();
    const a = audio.current;
    const k = tkey(t);
    a.pause();
    setLoading(true); setLyr({ status: 'loading' }); clock.set(0); setDur(t.duration || 0);
    api.invoke('lyrics', t).then((r) => { if (tkey(st.current.cur) === k) setLyr(r ? { status: 'ok', ...r } : { status: 'none' }); }).catch(() => setLyr({ status: 'none' }));
    setHistory((h) => [t, ...h.filter((x) => tkey(x) !== k)].slice(0, 200));
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: SRC_ALL[t.src], artwork: t.cover ? [{ src: t.cover, sizes: '512x512' }] : [] });
    let playable = t;
    if (t.src === 'sp') { // трек из Spotify/CSV → подбираем полную версию
      try { playable = await api.invoke('match', t); } catch { playable = null; }
      if (tkey(st.current.cur) !== k) return;
      if (!playable) {
        setLoading(false); toast(`Не нашёл полную версию «${t.artist} — ${t.title}», пропускаю`);
        if (++errCount.current < 8) setTimeout(() => st.current.next(true), 500);
        return;
      }
      if (!t.cover && playable.cover) {
        const fix = (x) => (x.id === t.id ? { ...x, cover: playable.cover } : x);
        setQueue((q) => q.map(fix));
        setPlaylists((ls) => ls.map((pl) => (pl.tracks.some((x) => x.id === t.id) ? { ...pl, tracks: pl.tracks.map(fix) } : pl)));
      }
    }
    st.current.playable = playable;
    extractPalette(t.cover || playable.cover, info.port).then((p) => { if (tkey(st.current.cur) === k) setPal(p); });
    a.src = streamUrl(playable);
    a.play().catch((e) => { if (e.name !== 'AbortError') api.send('log', 'play() rejected', e.message); });
  }, [info]);

  const playList = useCallback((list, i, keepWave = false) => {
    if (!keepWave) setWaveMode(false);
    setQueue(list); setQi(i);
  }, []);
  useEffect(() => { st.current.cur = cur; if (cur) loadTrack(cur); }, [cur && tkey(cur) + ':' + qi, info]); // eslint-disable-line

  /* prefetch следующего */
  useEffect(() => {
    if (settings.prefetch === false) return;
    const nexts = [queue[qi + 1], queue[qi + 2]].filter(Boolean);
    const id = setTimeout(() => nexts.forEach((n, k) => setTimeout(() => api.invoke('prefetch', n), k * 2500)), 1200);
    return () => clearTimeout(id);
  }, [qi, queue, settings.prefetch]);

  const next = useCallback((auto = false) => {
    if (!queue.length) return;
    if (auto && repeat === 'one') { audio.current.currentTime = 0; audio.current.play(); return; }
    let n = qi + 1;
    if (shuffle && !waveMode) { n = Math.floor(Math.random() * queue.length); if (n === qi && queue.length > 1) n = (n + 1) % queue.length; }
    if (n >= queue.length) { if (repeat === 'all') n = 0; else { if (auto) { setPlaying(false); return; } n = 0; } }
    setQi(n);
  }, [queue, qi, shuffle, repeat, waveMode]);
  const prev = useCallback(() => {
    if (audio.current.currentTime > 3 || qi <= 0) { audio.current.currentTime = 0; clock.set(0); return; }
    setQi(qi - 1);
  }, [qi]);
  const toggle = useCallback(() => {
    const a = audio.current;
    if (!cur) { if (history.length) playList(history, 0); return; }
    ensureGraph();
    a.paused ? a.play().catch(() => {}) : a.pause();
  }, [cur, history]);
  const seek = useCallback((t) => { const a = audio.current; if (isFinite(t)) { a.currentTime = t; clock.set(t); if (a.paused) a.play().catch(() => {}); } }, []);

  st.current = { ...st.current, next, prev, toggle, seek };

  // поток SoundCloud приходит частями: браузер сначала думает, что трек длится ~10 с (первый кусок).
  // Если длительность из плеера сильно расходится с метаданными трека — верим метаданным.
  const fixDur = (d) => {
    const td = st.current.cur?.duration || st.current.playable?.duration || 0;
    if (!td) return d;
    return d < td * 0.85 || d > td * 1.6 ? td : d;
  };
  useEffect(() => {
    const a = audio.current;
    const on = {
      playing: () => { setPlaying(true); setLoading(false); errCount.current = 0; },
      pause: () => setPlaying(false),
      waiting: () => setLoading(true),
      canplay: () => setLoading(false),
      ended: () => st.current.next(true),
      loadedmetadata: () => { if (isFinite(a.duration)) setDur(fixDur(a.duration)); },
      durationchange: () => { if (isFinite(a.duration) && a.duration > 0) setDur(fixDur(a.duration)); },
      error: () => {
        if (!a.src || !st.current.cur) return;
        // SoundCloud/YouTube→SoundCloud: если формат не декодировался — повторяем через yt-dlp, а не пропускаем
        const pk = st.current.playable || st.current.cur;
        if (!a.src.includes('&dl=1') && (pk.src === 'sc' || pk.src === 'yt')) {
          api.send('log', 'media error, retry via yt-dlp', a.error?.code, tkey(pk));
          const at = a.currentTime; a.src = a.src + '&dl=1'; a.currentTime = at || 0; a.play().catch(() => {});
          return;
        }
        setLoading(false); setPlaying(false);
        const c = st.current.cur, pl = st.current.playable || c;
        api.send('log', 'media error', a.error?.code, a.error?.message, tkey(pl));
        toast(`Не получилось воспроизвести «${c.title}» (${SRC_ALL[pl.src]}). Пропускаю…`);
        if (++errCount.current < 4) setTimeout(() => st.current.next(true), 1200);
      },
    };
    Object.entries(on).forEach(([k, f]) => a.addEventListener(k, f));
    return () => Object.entries(on).forEach(([k, f]) => a.removeEventListener(k, f));
  }, [toast]);

  /* rAF: время, уровни, строка для островка */
  const lyrRef = useRef(null); lyrRef.current = lyr;
  useEffect(() => {
    let raf, frame = 0, lastLine = null;
    const loop = () => {
      const a = audio.current; clock.set(a.currentTime || 0);
      const g = graph.current;
      if (g && !a.paused) {
        g.an.getByteFrequencyData(g.buf);
        const bands = [2, 5, 9, 16, 28].map((b, i, arr) => { let s = 0; const to = arr[i + 1] || 48; for (let k = b; k < to; k++) s += g.buf[k]; return clamp(s / (to - b) / 210); });
        levels.set(bands);
        if (++frame % 2 === 0) api.send('island:levels', bands);
      } else if (levels.get()[0] !== 0) { levels.set([0, 0, 0, 0, 0]); api.send('island:levels', [0, 0, 0, 0, 0]); }
      const L = lyrRef.current?.synced; let line = '';
      if (L) { for (const [t, x] of L) { if (t <= a.currentTime + .15) line = x; else break; } }
      if (line !== lastLine) { lastLine = line; api.send('island:state', { line }); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* состояние островка */
  useEffect(() => {
    api.send('island:state', { track: cur, playing, loading, pal, dur: dur || cur?.duration || 0, t: audio.current.currentTime, at: Date.now() });
  }, [cur, playing, loading, pal, dur]);
  useEffect(() => {
    const id = setInterval(() => api.send('island:state', { t: audio.current.currentTime, at: Date.now(), playing: !audio.current.paused }), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => api.on('cmd', (c, arg) => {
    if (c === 'toggle') st.current.toggle(); else if (c === 'next') st.current.next(); else if (c === 'prev') st.current.prev(); else if (c === 'seek') st.current.seek(arg);
  }), []);

  /* media session / hotkeys */
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => st.current.toggle()); ms.setActionHandler('pause', () => st.current.toggle());
    ms.setActionHandler('nexttrack', () => st.current.next()); ms.setActionHandler('previoustrack', () => st.current.prev());
    ms.setActionHandler('seekto', (d) => st.current.seek(d.seekTime));
  }, []);
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (e.target.tagName === 'INPUT') { if (e.code === 'Escape') e.target.blur(); return; }
      if (e.code === 'Space') { e.preventDefault(); st.current.toggle(); }
      else if (e.code === 'KeyL') setFullLyr((f) => !f);
      else if (e.code === 'Escape') setFullLyr(false);
      else if (e.code === 'ArrowRight') st.current.seek(audio.current.currentTime + 5);
      else if (e.code === 'ArrowLeft') st.current.seek(Math.max(0, audio.current.currentTime - 5));
      else if (e.code === 'KeyN') st.current.next();
      else if (e.code === 'KeyS' && st.current.tapping) st.current.tap?.();
      else if (e.code === 'BracketLeft') st.current.nudge?.(-0.25);
      else if (e.code === 'BracketRight') st.current.nudge?.(0.25);
      else if (e.code === 'KeyP') st.current.prev();
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  /* поиск с debounce */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const id = setTimeout(async () => {
      setResults({});
      const srcs = Object.keys(SRC).filter((k) => settings.sources[k]);
      await Promise.all(srcs.map((k) => api.invoke('search:src', q, k).then((r) => {
        if (st.current.lastQ === q) setResults((o) => ({ ...(o || {}), [k]: r }));
      }).catch(() => {})));
      if (st.current.lastQ === q) setSearching(false);
    }, 300);
    st.current.lastQ = q;
    return () => clearTimeout(id);
  }, [query, settings.sources]);

  /* волна */
  const startWave = useCallback(async () => {
    if (!Object.values(settings.sources).some(Boolean)) return toast('Включи хотя бы один источник');
    setWaveLoading(true);
    try {
      const W = settings.wave || {};
      const pool = [...likes.slice(0, 20), ...history.slice(0, 20), ...playlists.flatMap((p) => p.tracks.slice(0, 30))];
      const seeds = [...history.slice(0, 2), ...pool.sort(() => Math.random() - .5).slice(0, 4)].filter(Boolean);
      let list = await api.invoke('wave', { seeds, genres: settings.genres, sources: settings.sources, mood: W.mood || '', character: W.character || 'любимое', lang: W.lang || '', exclude: disliked.slice(0, 300) });
      const badArtists = new Set(disliked.filter((x) => x.startsWith('a:')).map((x) => x.slice(2)));
      list = list.filter((t) => !badArtists.has((t.artist || '').toLowerCase()));
      // подмешиваем твою музыку из импортированных плейлистов и лайков
      const lib = (W.character === 'незнакомое' || W.character === 'популярное') ? [] : [...likes, ...playlists.flatMap((p) => p.tracks)].sort(() => Math.random() - .5).slice(0, 12);
      if (lib.length) { const mixed = []; let j = 0; list.forEach((t, i) => { mixed.push(t); if (i % 3 === 2 && lib[j]) mixed.push(lib[j++]); }); list = mixed; }
      if (!list.length) toast('Волна пока пустая — попробуй другие жанры или источники');
      else { playList(list, 0, true); setWaveMode(true); }
    } catch (e) { toast('Волна не загрузилась: ' + e.message); }
    setWaveLoading(false);
  }, [settings, likes, history, playlists, disliked]);
  // подгружаем волну, когда очередь подходит к концу
  useEffect(() => {
    if (!waveMode || qi < queue.length - 3 || st.current.waveFetching) return;
    st.current.waveFetching = true;
    api.invoke('wave', { seeds: queue.slice(Math.max(0, qi - 2), qi + 1), genres: settings.genres, sources: settings.sources, ...(settings.wave || {}), exclude: disliked.slice(0, 300) })
      .then((more) => { const have = new Set(queue.map(tkey)); setQueue((q) => [...q, ...more.filter((t) => !have.has(tkey(t)))]); })
      .finally(() => { st.current.waveFetching = false; });
  }, [qi, waveMode]);

  const addPlaylists = (pls) => setPlaylists((l) => [...pls, ...l.filter((p) => !pls.some((n) => n.id === p.id))]);
  const importUrl = async (url) => {
    setImporting(true);
    try {
      const pls = await api.invoke('import:url', url.trim());
      if (!pls.length) { toast('Ничего не нашлось по этой ссылке'); return false; }
      addPlaylists(pls);
      toast(`Импортировано: ${pls.length === 1 ? `«${pls[0].name}»` : `${pls.length} плейлист.`} · ${pls.reduce((s, p) => s + p.tracks.length, 0)} треков`);
      return true;
    } catch (e) { toast(errMsg(e)); return false; } finally { setImporting(false); }
  };
  const importCsv = async (name, text) => {
    try { const pls = await api.invoke('import:csv', name, text); addPlaylists(pls); toast(`«${pls[0].name}» · ${pls[0].tracks.length} треков`); }
    catch (e) { toast(errMsg(e)); }
  };
  const toggleLike = (t) => setLikes((l) => (l.some((x) => tkey(x) === tkey(t)) ? l.filter((x) => tkey(x) !== tkey(t)) : [t, ...l]));
  const addQueue = (t) => { setQueue((q) => (q.length ? [...q.slice(0, qi + 1), t, ...q.slice(qi + 1)] : [t])); if (!queue.length) setQi(0); toast(`«${t.title}» — следующий`); };
  const openArtist = (t) => {
    const name = (t.name || t.artist || '').split(/,| & | feat/i)[0].trim();
    if (name) go('artist', { artist: { name, cover: t.name ? t.cover : undefined, src: t.src, artistId: t.artistId } });
  };
  const liked = cur && likes.some((x) => tkey(x) === tkey(cur));
  const dislike = () => {
    if (!cur) return;
    const norm = (cur.artist + ' ' + cur.title).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const artistKey = 'a:' + (cur.artist || '').toLowerCase();
    setDisliked((d) => {
      const n = [norm, ...d.filter((x) => x !== norm)];
      const artistHits = d.filter((x) => x === 'h:' + artistKey).length; // второй дизлайк артисту — убираем артиста из волны
      return (artistHits >= 1 ? [artistKey, ...n] : ['h:' + artistKey, ...n]).slice(0, 600);
    });
    setLikes((l) => l.filter((x) => tkey(x) !== tkey(cur)));
    toast('Понял, такое реже');
    next();
  };
  const okey = lyr?.vid ? 'l' + lyr.vid : cur ? tkey(cur) : '';
  const offset = okey ? offsets[okey] || 0 : 0;
  const nudge = (d) => okey && setOffsets((o) => ({ ...o, [okey]: Math.round(((o[okey] || 0) + d) * 100) / 100 }));
  // синхронизация в одно касание: жмёшь, когда певец начинает строку
  const [tapping, setTapping] = useState(false);
  const tapLineRef = useRef(null);
  const tap = () => {
    const tapLine = tapLineRef.current;
    if (!tapLine || !okey) return;
    const off = Math.round((tapLine[0] - audio.current.currentTime - LEAD) * 100) / 100;
    setOffsets((o) => ({ ...o, [okey]: off })); setTapping(false); toast(`Текст сдвинут на ${off > 0 ? '+' : ''}${off.toFixed(2)} с — запомнил для этого трека`);
  };
  // выбираем версию текста, совпадающую по длительности с реально играющим файлом
  useEffect(() => {
    if (!lyr?.versions?.length || !dur) return;
    const best = [...lyr.versions].sort((a, b) => Math.abs(a.duration - dur) - Math.abs(b.duration - dur))[0];
    if (best && best.id !== lyr.vid) { setLyr((l) => ({ ...l, synced: best.synced, vid: best.id })); api.send('log', `lyrics version ${best.id} (${Math.round(best.duration)}s) for audio ${Math.round(dur)}s`); }
  }, [lyr?.versions, Math.round(dur)]);
  st.current.nudge = nudge; st.current.tap = tap; st.current.tapping = tapping;

  const P = { settings, setSettings, history, likes, startWave, waveLoading, playList, openArtist, trending, query, search: setQuery, results, searching,
    cur, playing, toggleLike, addQueue, go, boot, info, toast, playlists, setPlaylists, importUrl, importCsv, importing,
    pal, waveMode, toggle, next, liked, dislike, upd, setUpd, downloads };

  return (
    <div className="app" style={{ '--ah': pal.h, '--as': pal.s, '--ts': pal.ts }}>
      <div className="titlebar">
        <div className="brand"><i />MudPlayer</div>
        <label className="tsearch">
          <span style={{ color: '#55555B', display: 'grid' }}>{I.search}</span>
          <input ref={searchRef} value={query} placeholder="Трек, артист, альбом — по всем источникам"
            onChange={(e) => { setQuery(e.target.value); if (view.name !== 'search') go('search'); }}
            onFocus={() => { if (query && view.name !== 'search') go('search'); }} />
          {query ? <button onClick={() => setQuery('')} style={{ color: '#55555B', display: 'grid' }}>{I.close}</button> : <kbd>Ctrl K</kbd>}
        </label>
        <div className="boot nodrag" style={{ width: 200, justifyContent: 'flex-end' }}>
          {boot.state === 'downloading' && <>yt-dlp <div className="pb"><i style={{ width: `${boot.progress}%` }} /></div></>}
          {boot.state === 'error' && <span style={{ color: '#E5484D' }}>yt-dlp: ошибка</span>}
          {upd.state === 'ready' && <button className="updbtn" onClick={() => api.invoke('update:install')}>Обновить до {upd.version}</button>}
          {upd.state === 'downloading' && <span>обновление {upd.progress || 0}%</span>}
        </div>
      </div>

      <nav className="rail">
        {[['home', I.home, 'Главная'], ['search', I.searchL, 'Поиск']].map(([k, ic, tip]) => (
          <button key={k} className={`rb ${view.name === k ? 'on' : ''}`} onClick={() => { go(k); if (k === 'search') setTimeout(() => searchRef.current?.focus(), 50); }}>{ic}<span className="tip">{tip}</span></button>
        ))}
        <button className={`rb wave ${view.name === 'wave' ? 'on' : ''}`} onClick={() => go('wave')}>{waveLoading ? <span className="spin" /> : I.wave}<span className="tip">Моя волна</span></button>
        <button className={`rb ${view.name === 'library' ? 'on' : ''}`} onClick={() => go('library')}>{I.heart}<span className="tip">Медиатека</span></button>
        <div className="sp" />
        <button className="rb" style={{ color: islandMode !== 'off' ? 'var(--accent)' : undefined }}
          onClick={() => setSettings((s) => { const cur = s.islandMode || 'background'; return { ...s, islandMode: cur === 'off' ? 'background' : cur === 'background' ? 'always' : 'off' }; })}>
          {I.island}<span className="tip">Островок: {islandMode === 'off' ? 'выключен' : islandMode === 'always' ? 'всегда' : 'когда плеер свёрнут'} · клик — сменить</span></button>
        <button className={`rb ${view.name === 'settings' ? 'on' : ''}`} onClick={() => go('settings')}>{I.gear}<span className="tip">Настройки</span></button>
      </nav>

      <main className="content" key={view.name + (view.artist?.name || '') + (view.plId || '')}>
        {view.name === 'home' && <Home P={P} />}
        {view.name === 'search' && <Search P={P} />}
        {view.name === 'artist' && <Artist P={P} artist={view.artist} />}
        {view.name === 'wave' && <WavePage P={P} />}
        {view.name === 'library' && <Library P={P} />}
        {view.name === 'playlist' && <Playlist P={P} plId={view.plId} />}
        {view.name === 'settings' && <Settings P={P} />}
      </main>

      <aside className={`rp ${rp ? '' : 'closed'}`}>
        <div className="rp-h">
          <button className={`tab ${rp === 'lyrics' ? 'on' : ''}`} onClick={() => setRp('lyrics')}>Текст</button>
          <button className={`tab ${rp === 'queue' ? 'on' : ''}`} onClick={() => setRp('queue')}>Очередь{queue.length ? ` · ${queue.length}` : ''}</button>
          <div className="sp" />
          {rp === 'lyrics' && lyr?.synced && <button className={`tbtn ${tapping ? 'on' : ''}`} onClick={() => setTapping((v) => !v)} title="Синхронизировать текст в одно касание">Синхр.</button>}
          {rp === 'lyrics' && lyr?.synced && <div className="sync" title="Сдвиг текста, если он спешит или отстаёт">
            <button onClick={() => nudge(-0.25)}>−</button><span className="mono">{offset > 0 ? '+' : ''}{offset.toFixed(2)}с</span><button onClick={() => nudge(0.25)}>+</button>
          </div>}
          {rp === 'lyrics' && <button className="ib" onClick={() => setFullLyr(true)} title="На весь экран (L)">{I.expand}</button>}
          <button className="ib" onClick={() => setRp(null)}>{I.close}</button>
        </div>
        {rp === 'lyrics' && tapping && <TapBox lines={lyr?.synced} offset={offset} lineRef={tapLineRef} onTap={tap} />}
        {rp === 'lyrics' && (cur ? <LyricsBody lyr={lyr} onSeek={seek} offset={offset} /> : <div className="nolrc"><b>Ничего не играет</b>Включи трек или «Мою волну».</div>)}
        {rp === 'queue' && <div className="qlist">
          {waveMode && <div className="label" style={{ padding: '6px 8px 10px' }}>Моя волна · бесконечно</div>}
          {queue.map((t, i) => (
            <button key={tkey(t) + i} className={`qrow ${i === qi ? 'cur' : ''} ${i < qi ? 'past' : ''}`} onClick={() => setQi(i)}>
              <img src={t.cover} alt="" />
              <div style={{ minWidth: 0 }}><div className="t">{t.title}</div><div className="a">{t.artist}</div></div>
              {i === qi && playing ? <Eq n={3} h={11} /> : <i className={`srcdot src-${t.src}`} />}
            </button>
          ))}
          {!queue.length && <div className="nolrc">Очередь пуста</div>}
        </div>}
      </aside>

      {fullLyr && cur && (
        <div className="fsl">
          <button className="ib fsl-x" onClick={() => setFullLyr(false)}>{I.close}</button>
          <div className="fsl-l">
            <div className={`cv ${playing ? '' : 'paused'}`}><Img src={cur.cover} /></div>
            <div className="t">{cur.title}</div>
            <div className="a">{cur.artist}</div>
            <button className={`heart on`} style={{ opacity: 1, marginTop: 12, color: liked ? 'var(--accent)' : 'rgba(255,255,255,.5)' }} onClick={() => toggleLike(cur)}>{I.heartS(liked)}</button>
          </div>
          <LyricsBody lyr={lyr} onSeek={seek} full offset={offset} />
          {lyr?.synced && <div className="sync fsl-sync"><button onClick={() => nudge(-0.25)}>−</button><span className="mono">{offset > 0 ? '+' : ''}{offset.toFixed(2)}с</span><button onClick={() => nudge(0.25)}>+</button></div>}
        </div>
      )}

      <Bar P={{ cur, playing, loading, toggle, next, prev, seek, shuffle, setShuffle, repeat, setRepeat, vol, setVol, muted, setMuted, dur, rp, setRp, liked, toggleLike, openArtist, setFullLyr, settings, setSettings }} />

      <div className="toasts">{toasts.map((t) => <div key={t.id} className="toast">{t.msg}</div>)}</div>
    </div>
  );
}

function Bar({ P }) {
  const { cur, playing, loading, toggle, next, prev, seek, shuffle, setShuffle, repeat, setRepeat, vol, setVol, muted, setMuted, dur, rp, setRp, liked, toggleLike, openArtist, setFullLyr } = P;
  const time = useStore(clock);
  const D = dur || cur?.duration || 0;
  return (
    <footer className="bar">
      <div className="mini">
        {cur ? <>
          <div className="cvb" onClick={() => setFullLyr(true)}><Img src={cur.cover} /></div>
          <div style={{ minWidth: 0 }}><div className="t">{cur.title}</div><div className="a"><span className="lnk" onClick={() => openArtist(cur)}>{cur.artist}</span> · {SRC_ALL[cur.src]}</div></div>
          <button className={`heart ${liked ? 'on' : ''}`} style={{ opacity: 1, marginLeft: 6 }} onClick={() => toggleLike(cur)}>{I.heartS(liked)}</button>
        </> : <div className="a" style={{ color: '#55555B', fontSize: 12.5 }}>Ничего не играет</div>}
      </div>
      <div className="transport">
        <div className="ctrls">
          <button className={`ib ${shuffle ? 'on' : ''}`} onClick={() => setShuffle((v) => !v)} title="Перемешать">{I.shuffle}</button>
          <button className="ib" onClick={prev}>{I.prev}</button>
          <button className="play" onClick={toggle}>{loading ? <span className="spin" /> : playing ? I.pause : I.play}</button>
          <button className="ib" onClick={() => next()}>{I.next}</button>
          <button className={`ib ${repeat !== 'off' ? 'on' : ''}`} style={{ position: 'relative' }} onClick={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))} title="Повтор">
            {I.repeat}{repeat === 'one' && <span className="mono" style={{ position: 'absolute', fontSize: 8, top: 3, right: 4 }}>1</span>}
          </button>
        </div>
        <div className="prog mono"><span>{fmt(time)}</span><Seek value={time} max={D} onSeek={seek} /><span>{fmt(D)}</span></div>
      </div>
      <div className="right">
        <button className={`ib ${rp === 'lyrics' ? 'on' : ''}`} onClick={() => setRp(rp === 'lyrics' ? null : 'lyrics')} title="Текст">{I.lyrics}</button>
        <button className={`ib ${rp === 'queue' ? 'on' : ''}`} onClick={() => setRp(rp === 'queue' ? null : 'queue')} title="Очередь">{I.queue}</button>
        <button className="ib" onClick={() => setMuted((m) => !m)}>{muted || vol === 0 ? I.mute : I.vol}</button>
        <div className="vol"><Seek value={muted ? 0 : vol} max={1} onSeek={(v) => { setMuted(false); setVol(v); }} /></div>
      </div>
    </footer>
  );
}

/* ───────────── Dynamic Island window ───────────── */
function IslandApp() {
  const [s, setS] = useState({ track: null, playing: false, loading: false, pal: { h: 30, s: 20 }, dur: 0, t: 0, at: Date.now(), line: '' });
  const [hover, setHover] = useState(false);
  const [, force] = useState(0);
  const pill = useRef(null);
  const inside = useRef(false);
  useEffect(() => api.on('island:state', (p) => setS((o) => ({ ...o, ...p }))), []);
  useEffect(() => api.on('island:levels', (l) => levels.set(l)), []);
  useEffect(() => { let raf; const loop = () => { force((x) => (x + 1) % 1e6); raf = requestAnimationFrame(loop); }; if (hover && s.playing) raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf); }, [hover, s.playing]);
  useEffect(() => { if (!hover) { const id = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(id); } }, [hover]);
  // клики сквозь прозрачные области: окно игнорирует мышь, пока курсор не над пилюлей
  useEffect(() => {
    const mv = (e) => {
      const r = pill.current?.getBoundingClientRect(); if (!r) return;
      const inn = e.clientX >= r.left - 2 && e.clientX <= r.right + 2 && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
      if (inn !== inside.current) { inside.current = inn; api.send('island:hit', inn); if (inn) setHover(true); else setTimeout(() => !inside.current && setHover(false), 350); }
    };
    const lv = () => { inside.current = false; api.send('island:hit', false); setTimeout(() => !inside.current && setHover(false), 350); };
    window.addEventListener('mousemove', mv); document.addEventListener('mouseleave', lv);
    return () => { window.removeEventListener('mousemove', mv); document.removeEventListener('mouseleave', lv); };
  }, []);
  const tr = s.track;
  const t = clamp(s.t + (s.playing ? (Date.now() - s.at) / 1000 : 0), 0, s.dur || 1e9);
  const open = hover && !!tr;
  const W = open ? 420 : tr ? 190 : 120, H = open ? 188 : 38, R = open ? 30 : 19;
  const layer = (show) => ({ opacity: show ? 1 : 0, filter: show ? 'none' : 'blur(6px)', transform: show ? 'none' : `scale(${open ? .92 : 1.08})`, pointerEvents: show ? 'auto' : 'none' });
  const cmd = (c, a) => api.send('island:cmd', c, a);
  return (
    <div className="isl-root">
      <div ref={pill} className="island" style={{ width: W, height: H, borderRadius: R, '--ah': s.pal?.h ?? 30, '--as': s.pal?.s ?? 20 }}>
        <div className="isl-layer isl-idle" style={layer(!open)}>
          {tr ? <img src={tr.cover} className={s.playing ? '' : 'off'} alt="" /> : <span style={{ width: 8 }} />}
          {s.loading ? <span className="spin" style={{ width: 11, height: 11, color: '#5F5F66' }} /> : <span className="mono" style={{ fontSize: 10.5, color: '#5F5F66' }}>{tr ? fmt(t) : 'MudPlayer'}</span>}
          <Eq n={5} h={13} />
        </div>
        {tr && <div className="isl-layer isl-full" style={layer(open)}>
          <div className="isl-top">
            <img src={tr.cover} alt="" onClick={() => cmd('focus')} />
            <div style={{ minWidth: 0, flex: 1 }}><div className="t">{tr.title}</div><div className="a">{tr.artist}</div></div>
            <Eq n={5} h={16} />
            <button className="isl-x" title="Скрыть островок" onClick={() => cmd('hide')}>{I.close}</button>
          </div>
          <div className="isl-lyric"><div key={s.line}>{s.line && s.line !== '♪' ? s.line : '♪'}</div></div>
          <div className="isl-prog mono"><span>{fmt(t)}</span><Seek value={t} max={s.dur} onSeek={(v) => cmd('seek', v)} thin /><span>-{fmt((s.dur || 0) - t)}</span></div>
          <div className="isl-ctrls">
            <button onClick={() => cmd('prev')}>{I.prev}</button>
            <button onClick={() => cmd('toggle')}>{s.loading ? <span className="spin" /> : s.playing ? I.pause : I.play}</button>
            <button onClick={() => cmd('next')}>{I.next}</button>
          </div>
        </div>}
      </div>
    </div>
  );
}

const isIsland = location.hash === '#island';
if (isIsland) document.documentElement.classList.add('island-mode');
createRoot(document.getElementById('root')).render(isIsland ? <IslandApp /> : <App />);
