/* ============================================================================
 * Sky Garden AR — "Find Your Client" Quest  +  Photo Booth  (self-contained)
 * ----------------------------------------------------------------------------
 * TWO experiences, one file:
 *
 *  REAR camera  -> "AR Hunt": shows a random client/bank logo, a Hot/Cold radar
 *                  reticle guides you to its beam, hold centre to LOCK ->
 *                  celebration. Find 5 in 60s.
 *
 *  SELFIE camera -> "Photo Booth": beams are hidden (no logos over faces); a
 *                  branded frame with your PARTY LOGO + copy appears; the
 *                  shutter saves a clean watermarked photo, and "Send to wall"
 *                  uploads it to the live photo wall.
 *
 * Decoupled: draws its OWN UI + confetti, reads the live calibrated heading
 * from `window.__skyHeading` (set by ar-main.js).
 * ========================================================================== */

import clients from './data/clients.json';
import banks from './data/banks.json';

/* ---- shared geo constants (must match ar-main.js) ---------------------- */
const SKY_GARDEN = { lat: 51.511398, lng: -0.083507 };

/* =====  PHOTO BOOTH — EDIT THESE  ======================================= *
 * Upload your party logo to the repo at:  public/party.png
 * (Vercel serves the public/ folder at the site root, so '/party.png'.)
 * Change the filename below if you name it something else.                  */
const PHOTO = {
  logo:     '/party.png',                               // <- your party logo
  title:    'TrueLayer 10 Years Anniversary Party!',    // <- big line of copy
  subtitle: 'Sky Garden · Summer 2026',                 // <- smaller line of copy
  tag:      '#TrueLayer10'                               // <- corner pill ('' to hide)
};
/* ======================================================================== */

function getBearing(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angularDiff(target, current) {           // + = target is clockwise (to your right)
  let d = target - current;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
function compass16(bearing) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(bearing / 22.5) % 16];
}

/* ---- build the target pool from the live data -------------------------- */
function buildPool() {
  const pool = [];
  const add = (item, kind) => {
    if (!item || item.name === 'TrueLayer' || item.tier === 'host') return; // host beam is the centre, skip
    pool.push({
      name: item.name,
      bearing: getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, item.lat, item.lng),
      logo: item.logo || '',
      color: item.beamColor || (kind === 'bank' ? '#4D3BD8' : '#AFADFF'),
      kind,
      tier: item.tier || (kind === 'bank' ? 'bank' : 'client')
    });
  };
  (clients || []).forEach((c) => add(c, c.tier === 'star' ? 'star' : 'client'));
  (banks || []).forEach((b) => add(b, 'bank'));
  return pool;
}
const POOL = buildPool();

/* ---- tunables ---------------------------------------------------------- */
const GAME = {
  targets: 5,         // find this many
  seconds: 60,        // within this time
  lockDeg: 6,         // |heading - bearing| under this = on target
  holdMs: 650,        // hold on target this long to LOCK
  hintAfterMs: 12000  // enable hint button after this long on one target
};

/* ===== UI ================================================================ */
function injectStyles() {
  const css = `
  :root { --q-font: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --tl-lav:#AFADFF; --tl-indigo:#4D3BD8; --tl-pale:#E7E6FF; --tl-black:#060606; }
  html, body { font-family: var(--q-font); }
  body * { font-family: var(--q-font) !important; }
  #q-launch, #q-booth {
    background: rgba(6,6,6,0.72); color:#fff; border:1px solid rgba(175,173,255,0.45);
    border-radius: 12px; padding: 9px 14px; font: 700 14px/1 var(--q-font);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor:pointer; white-space:nowrap;
  }
  #q-launch.active { background: linear-gradient(135deg,#AFADFF,#4D3BD8); color:#060606; border-color:transparent; }
  #q-hud { position:fixed; inset:0; z-index:40; pointer-events:none; display:none; font-family:var(--q-font); }
  #q-hud.on { display:block; }
  #q-top { position:absolute; top:14px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:12px;
    background:rgba(6,6,6,0.74); border:1px solid rgba(175,173,255,0.35); border-radius:14px; padding:8px 14px;
    backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); pointer-events:none; max-width:92vw; }
  #q-top img { height:30px; max-width:90px; object-fit:contain; display:block; }
  #q-top .chip-fallback { font-weight:800; font-size:18px; color:#fff; letter-spacing:.5px; }
  #q-top .label { color:rgba(255,255,255,.7); font-size:11px; text-transform:uppercase; letter-spacing:1px; }
  #q-top .name { color:#fff; font-size:17px; font-weight:700; }
  #q-stats { position:absolute; top:16px; right:14px; display:flex; gap:8px; pointer-events:none; }
  #q-stats .pill { background:rgba(6,6,6,0.74); border:1px solid rgba(175,173,255,0.30); border-radius:10px;
    padding:6px 10px; color:#fff; font-weight:700; font-size:15px; backdrop-filter:blur(10px); min-width:48px; text-align:center; }
  #q-stats .pill small { display:block; font-size:9px; font-weight:600; color:rgba(255,255,255,.6); text-transform:uppercase; letter-spacing:1px; }
  #q-stats .pill.warn { color:#ffb4b4; border-color:rgba(255,90,90,.5); }
  /* radar reticle */
  #q-reticle { position:absolute; top:50%; left:50%; width:150px; height:150px; transform:translate(-50%,-50%); }
  #q-ring { position:absolute; inset:0; border-radius:50%; border:3px solid rgba(255,255,255,.35); box-sizing:border-box; transition:border-color .15s; }
  #q-ring.lock { border-color:#AFADFF; box-shadow:0 0 24px #AFADFF; }
  #q-cross:before, #q-cross:after { content:''; position:absolute; background:rgba(255,255,255,.6); }
  #q-cross:before { top:50%; left:35%; width:30%; height:2px; transform:translateY(-50%); }
  #q-cross:after { left:50%; top:35%; height:30%; width:2px; transform:translateX(-50%); }
  #q-arrow { position:absolute; top:50%; left:50%; width:46px; height:46px; transform-origin:center; transition:opacity .2s;
    margin:-23px 0 0 -23px; }
  #q-arrow svg { width:100%; height:100%; filter:drop-shadow(0 0 6px rgba(0,0,0,.6)); }
  #q-prox { position:absolute; bottom:88px; left:50%; transform:translateX(-50%); width:200px; height:8px;
    background:rgba(255,255,255,.15); border-radius:999px; overflow:hidden; }
  #q-prox > i { display:block; height:100%; width:0%; border-radius:999px; transition:width .12s, background .12s; }
  #q-msg { position:absolute; bottom:108px; left:50%; transform:translateX(-50%); color:#fff; font-weight:700; font-size:16px;
    text-shadow:0 1px 6px rgba(0,0,0,.7); text-align:center; width:90vw; }
  #q-hint-btn { position:absolute; bottom:40px; left:50%; transform:translateX(-50%); pointer-events:auto;
    background:#AFADFF; color:#060606; border:none; border-radius:12px; padding:10px 18px; font-weight:800;
    font-size:14px; cursor:pointer; display:none; }
  #q-hint-btn.on { display:block; }
  /* celebration */
  #q-fx { position:fixed; inset:0; z-index:60; pointer-events:none; }
  #q-flash { position:fixed; inset:0; z-index:55; opacity:0; pointer-events:none; transition:opacity .25s; }
  #q-shock { position:fixed; top:50%; left:50%; width:40px; height:40px; border-radius:50%; transform:translate(-50%,-50%) scale(0);
    z-index:56; pointer-events:none; opacity:0; }
  #q-bigimg { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) scale(.2); z-index:58; opacity:0;
    max-width:60vw; max-height:40vh; pointer-events:none; filter:drop-shadow(0 8px 30px rgba(0,0,0,.5)); }
  #q-card { position:fixed; inset:0; z-index:70; display:none; align-items:center; justify-content:center; pointer-events:auto;
    background:rgba(6,4,16,0.82); backdrop-filter:blur(6px); }
  #q-card.on { display:flex; }
  #q-card .box { background:linear-gradient(160deg,#141226,#060606); border:1px solid rgba(175,173,255,.25); border-radius:18px;
    padding:28px 26px; text-align:center; color:#fff; max-width:340px; width:84vw; box-shadow:0 20px 60px rgba(0,0,0,.6); }
  #q-card h2 { margin:0 0 6px; font-size:26px; }
  #q-card p { margin:4px 0; color:rgba(255,255,255,.8); font-size:15px; }
  #q-card .big { font-size:46px; font-weight:800; background:linear-gradient(135deg,#AFADFF,#4D3BD8); -webkit-background-clip:text;
    background-clip:text; -webkit-text-fill-color:transparent; margin:8px 0; }
  #q-card button { margin-top:16px; background:#AFADFF; color:#060606; border:none;
    border-radius:12px; padding:13px 26px; font-size:16px; font-weight:800; cursor:pointer; width:100%; }
  #q-card .ghost { background:transparent; border:1.5px solid rgba(175,173,255,.5); color:#fff; margin-top:10px; }
  body.selfie-mode #camera-feed { transform: scaleX(-1); }
  /* ---- PHOTO BOOTH ---- */
  #q-photo { position:fixed; inset:0; z-index:50; display:none; pointer-events:none;
    font-family:var(--q-font); }
  #q-photo.on { display:block; }
  #q-photo .frame { position:absolute; inset:0; border:6px solid rgba(255,255,255,.92); box-sizing:border-box;
    box-shadow: inset 0 0 0 2px rgba(175,173,255,.9); }
  #q-photo .toplogo { position:absolute; top:16px; left:18px; max-width:34vw; max-height:11vh;
    object-fit:contain; filter:drop-shadow(0 2px 10px rgba(0,0,0,.55)); }
  #q-photo .tag { position:absolute; top:18px; right:18px; background:#4D3BD8; color:#fff; font-weight:800;
    font-size:13px; padding:7px 13px; border-radius:10px; }
  #q-photo .band { position:absolute; left:0; right:0; bottom:0; padding:54px 20px 26px; text-align:center; color:#fff;
    background:linear-gradient(0deg, rgba(6,6,6,.85), transparent); }
  #q-photo .band h3 { margin:0; font-size:25px; font-weight:800; text-shadow:0 1px 6px rgba(0,0,0,.6); }
  #q-photo .band p { margin:5px 0 0; font-size:15px; color:rgba(255,255,255,.9); }
  #q-photo .hint { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:rgba(255,255,255,.85);
    font-weight:700; font-size:15px; text-shadow:0 1px 6px rgba(0,0,0,.7); pointer-events:none; }
  #q-photo .rot { position:absolute; top:74px; right:16px; z-index:2; pointer-events:auto;
    width:48px; height:48px; border-radius:50%; font-size:22px; line-height:1;
    background:rgba(6,6,6,.6); color:#fff; border:1px solid rgba(175,173,255,.55);
    backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); cursor:pointer; }
  #q-photo .rot:active { transform:scale(.9); }
  #q-photo .actions { position:absolute; left:0; right:0; bottom:128px; display:flex; gap:18px; align-items:center;
    justify-content:center; pointer-events:auto; }
  #q-photo .cap { width:76px; height:76px; border-radius:50%; background:#fff; border:none; cursor:pointer;
    box-shadow:0 0 0 4px rgba(255,255,255,.45), 0 6px 20px rgba(0,0,0,.4); }
  #q-photo .cap:active { transform:scale(.92); }
  #q-photo .back { background:rgba(6,6,6,.66); color:#fff; border:1.5px solid rgba(175,173,255,.6); border-radius:12px;
    padding:12px 18px; font-weight:700; font-size:15px; cursor:pointer; backdrop-filter:blur(8px); }
  #q-photo .wall { background:#AFADFF; color:#060606; border:none; border-radius:12px;
    padding:12px 18px; font-weight:800; font-size:15px; cursor:pointer; box-shadow:0 6px 20px rgba(77,59,216,.45); }
  #q-photo .wall:active { transform:scale(.95); }
  #q-photo .toast { position:absolute; bottom:212px; left:50%; transform:translateX(-50%) translateY(8px); opacity:0;
    background:rgba(6,6,6,.92); color:#fff; padding:10px 18px; border-radius:10px; font-weight:700; font-size:14px;
    transition:opacity .25s, transform .25s; pointer-events:none; border:1px solid rgba(175,173,255,.4); white-space:nowrap; }
  #q-photo .toast.on { opacity:1; transform:translateX(-50%) translateY(0); }
  @media (orientation: landscape) {
    #q-photo .toplogo { top:10px; left:12px; max-height:9vh; max-width:24vw; }
    #q-photo .tag { top:10px; right:12px; font-size:11px; padding:5px 10px; }
    #q-photo .hint { top:16%; font-size:13px; }
    #q-photo .band { padding:26px 16px 10px; }
    #q-photo .band h3 { font-size:17px; }
    #q-photo .band p { font-size:12px; margin-top:2px; }
    #q-photo .actions { bottom:12px; gap:12px; }
    #q-photo .cap { width:52px; height:52px; box-shadow:0 0 0 3px rgba(255,255,255,.4), 0 4px 14px rgba(0,0,0,.4); }
    #q-photo .back, #q-photo .wall { padding:8px 13px; font-size:13px; }
    #q-photo .toast { bottom:70px; font-size:12px; padding:7px 13px; }
  }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

let ui = {};
function buildUI() {
  const frag = el(`<div></div>`);
  frag.innerHTML = `
    <div id="q-hud">
      <div id="q-top"><div><div class="label">Find</div><div class="name" id="q-name">—</div></div><div id="q-logo"></div></div>
      <div id="q-stats">
        <div class="pill"><small>Found</small><span id="q-found">0/${GAME.targets}</span></div>
        <div class="pill" id="q-time-pill"><small>Time</small><span id="q-time">${GAME.seconds}</span></div>
      </div>
      <div id="q-reticle"><div id="q-ring"></div><div id="q-cross"></div>
        <div id="q-arrow"><svg viewBox="0 0 24 24"><path d="M12 2 L19 20 L12 15 L5 20 Z" fill="#fff"/></svg></div></div>
      <div id="q-msg"></div>
      <div id="q-prox"><i></i></div>
      <button id="q-hint-btn">💡 Hint</button>
    </div>`;
  document.body.appendChild(frag.firstElementChild);
  document.body.appendChild(el(`<div id="q-flash"></div>`));
  document.body.appendChild(el(`<div id="q-shock"></div>`));
  document.body.appendChild(el(`<img id="q-bigimg"/>`));
  document.body.appendChild(el(`<canvas id="q-fx"></canvas>`));
  document.body.appendChild(el(`<div id="q-card"><div class="box" id="q-card-box"></div></div>`));

  // Photo Booth overlay
  const photoFrag = el(`<div></div>`);
  photoFrag.innerHTML = `
    <div id="q-photo">
      <div class="frame"></div>
      <img class="toplogo" id="q-photo-logo" alt=""/>
      <div class="tag" id="q-photo-tag"></div>
      <div class="hint" id="q-photo-hint">📸 Strike a pose!</div>
      <button class="rot" id="q-photo-rot" aria-label="Rotate camera">🔄</button>
      <div class="band"><h3 id="q-photo-title"></h3><p id="q-photo-sub"></p></div>
      <div class="actions">
        <button class="back" id="q-photo-back">← Back to AR</button>
        <button class="cap" id="q-photo-cap" aria-label="Save photo"></button>
        <button class="wall" id="q-photo-wall">📤 Send to wall</button>
      </div>
      <div class="toast" id="q-toast"></div>
    </div>`;
  document.body.appendChild(photoFrag.firstElementChild);

  ui = {
    hud: document.getElementById('q-hud'),
    name: document.getElementById('q-name'),
    logo: document.getElementById('q-logo'),
    found: document.getElementById('q-found'),
    time: document.getElementById('q-time'),
    timePill: document.getElementById('q-time-pill'),
    ring: document.getElementById('q-ring'),
    arrow: document.getElementById('q-arrow'),
    prox: document.querySelector('#q-prox > i'),
    msg: document.getElementById('q-msg'),
    hintBtn: document.getElementById('q-hint-btn'),
    flash: document.getElementById('q-flash'),
    shock: document.getElementById('q-shock'),
    bigimg: document.getElementById('q-bigimg'),
    fx: document.getElementById('q-fx'),
    card: document.getElementById('q-card'),
    cardBox: document.getElementById('q-card-box'),
    photo: document.getElementById('q-photo')
  };
  ui.hintBtn.addEventListener('click', showHint);

  // populate photo booth copy + wire buttons
  document.getElementById('q-photo-title').textContent = PHOTO.title || '';
  document.getElementById('q-photo-sub').textContent = PHOTO.subtitle || '';
  const tagEl = document.getElementById('q-photo-tag');
  if (PHOTO.tag) tagEl.textContent = PHOTO.tag; else tagEl.style.display = 'none';
  const logoEl = document.getElementById('q-photo-logo');
  logoEl.src = PHOTO.logo;
  logoEl.onerror = () => { logoEl.style.display = 'none'; };
  document.getElementById('q-photo-back').addEventListener('click', exitBooth);
  document.getElementById('q-photo-cap').addEventListener('click', captureBooth);
  document.getElementById('q-photo-wall').addEventListener('click', sendToWall);
  document.getElementById('q-photo-rot').addEventListener('click', rotateSelfie);
  window.addEventListener('resize', () => { if (document.body.classList.contains('selfie-mode')) applySelfieTransform(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { if (document.body.classList.contains('selfie-mode')) applySelfieTransform(); }, 200));

  sizeFx();
  window.addEventListener('resize', sizeFx);
}

function addControlButtons() {
  const controls = document.getElementById('ar-controls');
  if (!controls) return;
  const launch = el(`<button id="q-launch">🎯 Quest</button>`);
  const booth = el(`<button id="q-booth">🤳 Photo Booth</button>`);
  launch.addEventListener('click', toggleGame);
  booth.addEventListener('click', enterBooth);
  controls.appendChild(launch);
  controls.appendChild(booth);
  ui.launch = launch;
  ui.booth = booth;
}

/* ===== camera + Photo Booth ============================================= */
let facing = 'environment';
let photoMode = false;
let selfieRot = (function () { const v = parseInt(localStorage.getItem('tlSelfieRot'), 10); return isNaN(v) ? 0 : v; })();
let selfieAuto = (localStorage.getItem('tlSelfieRot') == null);

function applySelfieTransform() {
  const video = document.getElementById('camera-feed');
  if (!video || !document.body.classList.contains('selfie-mode')) return;
  const sw = window.innerWidth, sh = window.innerHeight;
  const r = ((selfieRot % 360) + 360) % 360;
  const k = (r === 90 || r === 270) ? Math.max(sw / sh, sh / sw) : 1;
  video.style.transformOrigin = 'center center';
  video.style.transform = 'scale(' + (-k) + ',' + k + ') rotate(' + r + 'deg)';
}
function rotateSelfie() {
  selfieRot = (selfieRot + 90) % 360;
  selfieAuto = false;
  try { localStorage.setItem('tlSelfieRot', String(selfieRot)); } catch (e) {}
  applySelfieTransform();
}

async function setFacing(f) {
  const video = document.getElementById('camera-feed');
  if (!video) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: f, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
    const old = video.srcObject;
    if (old) old.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    await video.play();
    facing = f;
    const selfie = (f === 'user');
    document.body.classList.toggle('selfie-mode', selfie);
    if (selfie) {
      const orient = () => {
        if (selfieAuto) {
          const vw = video.videoWidth, vh = video.videoHeight;
          const portrait = window.innerHeight >= window.innerWidth;
          if (vw && vh) selfieRot = ((vw > vh) === portrait) ? 90 : 0;
        }
        applySelfieTransform();
      };
      orient();
      video.addEventListener('loadedmetadata', orient, { once: true });
      setTimeout(orient, 250);
    } else {
      video.style.transform = '';
    }
    return true;
  } catch (e) {
    return false;
  }
}

function setBeamsVisible(v) {
  const c = document.getElementById('ar-canvas');
  if (c) c.style.visibility = v ? '' : 'hidden';
}
function setARChrome(show) {
  setBeamsVisible(show);
  ['ar-controls', 'hud', 'exit-fs-btn'].forEach((id) => {
    const e = document.getElementById(id);
    if (e) e.style.display = show ? '' : 'none';
  });
}

async function enterBooth() {
  if (state === 'playing' || state === 'celebrating') stopGame();
  photoMode = true;
  setARChrome(false);          // hide beams + AR controls + HUD
  ui.photo.classList.add('on');
  const ok = await setFacing('user');
  if (!ok) { // selfie camera unavailable -> bail back to AR
    photoMode = false;
    ui.photo.classList.remove('on');
    setARChrome(true);
  }
}
async function exitBooth() {
  photoMode = false;
  ui.photo.classList.remove('on');
  await setFacing('environment');
  setARChrome(true);
}

/* preload the party logo for canvas capture */
let partyImg = new Image();
let partyReady = false;
partyImg.onload = () => { partyReady = true; };
partyImg.onerror = () => { partyReady = false; };
partyImg.src = PHOTO.logo;

function captureBooth() {
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(saveBoothPhoto);
  else saveBoothPhoto();
}
function sendToWall() {
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(doSendToWall);
  else doSendToWall();
}

/* build the branded photo canvas; pass maxDim to cap longest edge (for upload) */
function buildBoothCanvas(maxDim) {
  const video = document.getElementById('camera-feed');
  if (!video) return null;
  const W = window.innerWidth, H = window.innerHeight;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  let cw = Math.round(W * scale), ch = Math.round(H * scale);
  if (maxDim) { const f = Math.min(1, maxDim / Math.max(cw, ch)); cw = Math.round(cw * f); ch = Math.round(ch * f); }
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const ctx = out.getContext('2d');

  // 1. mirrored + orientation-corrected selfie video, cover-fit
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const r = ((selfieRot % 360) + 360) % 360;
  const rad = r * Math.PI / 180;
  const tw = (r === 90 || r === 270) ? ch : cw;
  const th = (r === 90 || r === 270) ? cw : ch;
  const cover = Math.max(tw / vw, th / vh);
  const dw = vw * cover, dh = vh * cover;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(-1, 1);
  ctx.rotate(rad);
  ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  // 2. white frame + purple inner line
  const bw = Math.max(5, Math.round(cw * 0.012));
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = bw;
  ctx.strokeRect(bw / 2, bw / 2, cw - bw, ch - bw);
  ctx.strokeStyle = 'rgba(175,173,255,0.9)'; ctx.lineWidth = Math.max(2, bw * 0.35);
  const ip = bw * 1.3;
  ctx.strokeRect(ip, ip, cw - ip * 2, ch - ip * 2);

  // 3. bottom copy band
  const bandH = Math.round(ch * 0.16);
  const g = ctx.createLinearGradient(0, ch - bandH, 0, ch);
  g.addColorStop(0, 'rgba(6,6,6,0)'); g.addColorStop(1, 'rgba(6,6,6,0.85)');
  ctx.fillStyle = g; ctx.fillRect(0, ch - bandH, cw, bandH);
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  let tSize = Math.round(ch * 0.042);
  ctx.font = '800 ' + tSize + 'px Manrope, sans-serif';
  const titleTxt = PHOTO.title || '';
  const maxTW = cw * 0.9;
  if (titleTxt && ctx.measureText(titleTxt).width > maxTW) {
    tSize = Math.max(12, Math.floor(tSize * maxTW / ctx.measureText(titleTxt).width));
    ctx.font = '800 ' + tSize + 'px Manrope, sans-serif';
  }
  ctx.fillText(titleTxt, cw / 2, ch - Math.round(bandH * (PHOTO.subtitle ? 0.5 : 0.32)));
  if (PHOTO.subtitle) {
    const sSize = Math.round(ch * 0.028);
    ctx.font = '500 ' + sSize + 'px Manrope, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(PHOTO.subtitle, cw / 2, ch - Math.round(bandH * 0.18));
  }

  // 4. party logo (top centre)
  if (partyReady) {
    const maxW = cw * 0.34, maxH = ch * 0.12;
    const ar = (partyImg.naturalWidth / partyImg.naturalHeight) || 3;
    let lw = maxW, lh = lw / ar;
    if (lh > maxH) { lh = maxH; lw = lh * ar; }
    ctx.drawImage(partyImg, cw * 0.045, ch * 0.04, lw, lh);
  }

  // 5. tag pill (top-right)
  if (PHOTO.tag) {
    const pSize = Math.round(ch * 0.024);
    ctx.font = '700 ' + pSize + 'px Manrope, sans-serif';
    const tw = ctx.measureText(PHOTO.tag).width;
    const padX = pSize * 0.9, padY = pSize * 0.6;
    const pw = tw + padX * 2, phh = pSize + padY * 2;
    const px = cw - pw - cw * 0.03, py = ch * 0.035;
    ctx.fillStyle = 'rgba(77,59,216,0.95)';
    ctx.beginPath(); ctx.roundRect(px, py, pw, phh, Math.min(phh / 2, pSize * 0.5)); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(PHOTO.tag, px + padX, py + phh / 2);
    ctx.textBaseline = 'alphabetic';
  }
  return out;
}

function boothFlash() {
  ui.flash.style.background = '#fff'; ui.flash.style.opacity = '0.85';
  setTimeout(() => { ui.flash.style.opacity = '0'; ui.flash.style.background = ''; }, 180);
}
let toastTimer = 0;
function boothToast(msg) {
  const t = document.getElementById('q-toast');
  if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* shutter = save the photo to the guest's own phone */
function saveBoothPhoto() {
  const out = buildBoothCanvas(null);
  if (!out) return;
  boothFlash();
  out.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], 'truelayer-photobooth.jpg', { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'TrueLayer Sky Garden' }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'truelayer-photobooth.jpg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  }, 'image/jpeg', 0.92);
}

/* "Send to wall" = explicit consent to upload to the live photo wall */
function doSendToWall() {
  const out = buildBoothCanvas(1280);
  if (!out) return;
  boothFlash();
  boothToast('Sending to the wall…');
  const dataUrl = out.toDataURL('image/jpeg', 0.82);
  fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl })
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(r)))
    .then(() => boothToast('✨ On the wall!'))
    .catch(() => boothToast('Upload failed — try again'));
}

/* ===== game state machine =============================================== */
let state = 'idle';          // idle | playing | celebrating | over
let target = null;
let bag = [];
let foundCount = 0;
let endAt = 0;               // timestamp when timer runs out
let pausedRemaining = 0;     // ms banked while paused (celebration)
let onTargetSince = 0;
let targetShownAt = 0;
let rafId = 0;

function shuffledBag() {
  const a = POOL.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function nextTarget() {
  if (bag.length === 0) bag = shuffledBag();
  target = bag.pop();
  onTargetSince = 0;
  targetShownAt = performance.now();
  ui.name.textContent = target.name;
  ui.logo.innerHTML = target.logo
    ? `<img src="${target.logo}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'chip-fallback',textContent:'${(target.name[0]||'?')}'}))"/>`
    : `<span class="chip-fallback">${target.name[0] || '?'}</span>`;
  ui.hintBtn.classList.remove('on');
  ui.msg.textContent = '';
}

function toggleGame() {
  if (state === 'idle' || state === 'over') startGame();
  else stopGame();
}
function startGame() {
  if (typeof window.__skyHeading !== 'number') {
    if (ui.launch) { ui.launch.textContent = 'Calibrate first'; setTimeout(() => { if (ui.launch) ui.launch.textContent = '🎯 Quest'; }, 1500); }
    return;
  }
  if (POOL.length === 0) return;
  state = 'playing';
  foundCount = 0;
  bag = shuffledBag();
  endAt = performance.now() + GAME.seconds * 1000;
  ui.found.textContent = `0/${GAME.targets}`;
  ui.card.classList.remove('on');
  ui.hud.classList.add('on');
  ui.launch.classList.add('active');
  ui.launch.textContent = '✕ Quit';
  nextTarget();
  loop();
}
function stopGame() {
  state = 'idle';
  ui.hud.classList.remove('on');
  ui.launch.classList.remove('active');
  ui.launch.textContent = '🎯 Quest';
  ui.card.classList.remove('on');
  cancelAnimationFrame(rafId);
}

/* ===== main loop ======================================================== */
function loop() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (state !== 'playing') return;
    const now = performance.now();

    const remaining = Math.max(0, endAt - now);
    const secs = Math.ceil(remaining / 1000);
    ui.time.textContent = secs;
    ui.timePill.classList.toggle('warn', secs <= 10);
    if (remaining <= 0) { endGame(false); return; }

    if (now - targetShownAt > GAME.hintAfterMs) ui.hintBtn.classList.add('on');

    const heading = window.__skyHeading;
    if (typeof heading === 'number' && target) {
      const d = angularDiff(target.bearing, heading);   // + = to the right
      const adist = Math.abs(d);

      ui.arrow.style.transform = `rotate(${d}deg)`;
      ui.arrow.style.opacity = adist < GAME.lockDeg ? '0' : '1';

      const prox = Math.max(0, 1 - adist / 90);
      ui.prox.style.width = (prox * 100).toFixed(0) + '%';
      const hot = hotColor(prox);
      ui.prox.style.background = hot;
      ui.ring.style.borderColor = adist < GAME.lockDeg ? '#AFADFF' : hot;

      if (adist > 120) ui.msg.textContent = '↩︎ Turn around';
      else if (adist > GAME.lockDeg) ui.msg.textContent = (d > 0 ? '➡︎ warmer to the right' : '⬅︎ warmer to the left');
      else ui.msg.textContent = '🔥 HOT — hold it!';

      if (adist < GAME.lockDeg) {
        ui.ring.classList.add('lock');
        if (!onTargetSince) onTargetSince = now;
        if (now - onTargetSince >= GAME.holdMs) { found(); return; }
      } else {
        ui.ring.classList.remove('lock');
        onTargetSince = 0;
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function hotColor(p) { // blue(cold) -> green -> amber -> red(hot)
  const stops = [[0,[231,230,255]],[0.5,[175,173,255]],[1,[77,59,216]]];
  let a = stops[0], b = stops[stops.length-1];
  for (let i = 0; i < stops.length-1; i++) { if (p >= stops[i][0] && p <= stops[i+1][0]) { a = stops[i]; b = stops[i+1]; break; } }
  const t = (p - a[0]) / ((b[0]-a[0])||1);
  const c = a[1].map((v,i) => Math.round(v + (b[1][i]-v)*t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ===== found! celebration =============================================== */
function found() {
  state = 'celebrating';
  cancelAnimationFrame(rafId);
  foundCount++;
  ui.found.textContent = `${foundCount}/${GAME.targets}`;
  ui.ring.classList.remove('lock');
  pausedRemaining = Math.max(0, endAt - performance.now());

  celebrate(target);

  setTimeout(() => {
    if (foundCount >= GAME.targets) { endGame(true); return; }
    endAt = performance.now() + pausedRemaining;
    state = 'playing';
    nextTarget();
    loop();
  }, 1600);
}

function celebrate(t) {
  const col = t.color || '#AFADFF';
  ui.flash.style.background = `radial-gradient(circle at 50% 50%, ${col}66, transparent 70%)`;
  ui.flash.style.opacity = '1';
  setTimeout(() => { ui.flash.style.opacity = '0'; }, 260);
  ui.shock.style.border = `4px solid ${col}`;
  ui.shock.style.transition = 'none';
  ui.shock.style.transform = 'translate(-50%,-50%) scale(0)';
  ui.shock.style.opacity = '0.9';
  requestAnimationFrame(() => {
    ui.shock.style.transition = 'transform .7s ease-out, opacity .7s ease-out';
    ui.shock.style.transform = 'translate(-50%,-50%) scale(14)';
    ui.shock.style.opacity = '0';
  });
  if (t.logo) {
    ui.bigimg.src = t.logo;
    ui.bigimg.style.transition = 'none';
    ui.bigimg.style.transform = 'translate(-50%,-50%) scale(.2)';
    ui.bigimg.style.opacity = '0';
    requestAnimationFrame(() => {
      ui.bigimg.style.transition = 'transform .5s cubic-bezier(.2,1.4,.4,1), opacity .4s';
      ui.bigimg.style.transform = 'translate(-50%,-50%) scale(1) rotate(360deg)';
      ui.bigimg.style.opacity = '1';
    });
    setTimeout(() => { ui.bigimg.style.transition = 'opacity .4s'; ui.bigimg.style.opacity = '0'; }, 1100);
  }
  burstConfetti(col);
  ui.msg.textContent = '✨ Found ' + t.name + '!';
}

/* ---- confetti (own canvas) -------------------------------------------- */
let parts = [];
function sizeFx() {
  if (!ui.fx) return;
  ui.fx.width = window.innerWidth; ui.fx.height = window.innerHeight;
  ui.fx.style.width = window.innerWidth + 'px'; ui.fx.style.height = window.innerHeight + 'px';
}
function burstConfetti(col) {
  const cols = [col, '#ffffff', '#AFADFF', '#4D3BD8', '#E7E6FF'];
  const W = ui.fx.width, cx = W / 2, cy = window.innerHeight * 0.42;
  for (let i = 0; i < 140; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 9;
    parts.push({ x: cx, y: cy, vx: Math.cos(ang)*sp, vy: Math.sin(ang)*sp - 3,
      w: 5+Math.random()*6, h: 8+Math.random()*8, rot: Math.random()*6.28, vrot:(Math.random()-.5)*.4,
      color: cols[(Math.random()*cols.length)|0], life: 70+Math.random()*40 });
  }
  if (!confettiOn) { confettiOn = true; confettiTick(); }
}
let confettiOn = false;
function confettiTick() {
  const ctx = ui.fx.getContext('2d'), H = window.innerHeight;
  ctx.clearRect(0, 0, ui.fx.width, ui.fx.height);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.rot += p.vrot; p.life--;
    if (p.life <= 0 || p.y > H + 40) { parts.splice(i, 1); continue; }
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.globalAlpha = Math.min(1, p.life / 30); ctx.fillStyle = p.color;
    ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h); ctx.restore();
  }
  if (parts.length > 0) requestAnimationFrame(confettiTick);
  else { ctx.clearRect(0, 0, ui.fx.width, ui.fx.height); confettiOn = false; }
}

/* ===== hint ============================================================= */
function showHint() {
  if (!target) return;
  const dir = compass16(target.bearing);
  const heading = window.__skyHeading;
  let turn = '';
  if (typeof heading === 'number') {
    const d = angularDiff(target.bearing, heading);
    turn = Math.abs(d) < GAME.lockDeg ? "you're basically on it!" :
           (Math.abs(d) > 120 ? 'turn right around' : (d > 0 ? 'sweep right' : 'sweep left'));
  }
  ui.msg.textContent = `💡 It's to the ${dir} — ${turn}`;
}

/* ===== end card ========================================================= */
function endGame(won) {
  state = 'over';
  cancelAnimationFrame(rafId);
  ui.hud.classList.remove('on');
  ui.launch.classList.remove('active');
  ui.launch.textContent = '🎯 Quest';
  const elapsed = won ? (GAME.seconds - Math.ceil(pausedRemaining / 1000)) : GAME.seconds;
  ui.cardBox.innerHTML = won
    ? `<h2>🏆 Nailed it!</h2><div class="big">${foundCount}/${GAME.targets}</div>
       <p>All found in ${elapsed}s.</p><p>Try the 🤳 Photo Booth for the wall!</p>
       <button id="q-again">Play again</button><button id="q-close" class="ghost">Done</button>`
    : `<h2>⏰ Time!</h2><div class="big">${foundCount}/${GAME.targets}</div>
       <p>${foundCount >= 3 ? 'So close — go again!' : 'Warm up and try again!'}</p>
       <button id="q-again">Play again</button><button id="q-close" class="ghost">Done</button>`;
  ui.card.classList.add('on');
  if (won) burstConfetti('#AFADFF');
  document.getElementById('q-again').addEventListener('click', startGame);
  document.getElementById('q-close').addEventListener('click', stopGame);
}

/* ===== boot ============================================================= */
function loadFont() {
  const pre1 = document.createElement('link'); pre1.rel = 'preconnect'; pre1.href = 'https://fonts.googleapis.com';
  const pre2 = document.createElement('link'); pre2.rel = 'preconnect'; pre2.href = 'https://fonts.gstatic.com'; pre2.crossOrigin = 'anonymous';
  const link = document.createElement('link'); link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
  document.head.appendChild(pre1); document.head.appendChild(pre2); document.head.appendChild(link);
  if (document.fonts && document.fonts.load) {
    ['400','500','600','700','800'].forEach((w) => { try { document.fonts.load(w + ' 16px Manrope'); } catch (e) {} });
  }
}
function boot() {
  loadFont();
  injectStyles();
  buildUI();
  addControlButtons();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
