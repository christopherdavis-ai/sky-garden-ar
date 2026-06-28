import * as THREE from 'three';
import clients from './data/clients.json';
import banks from './data/banks.json';
import './quest.js';

const SKY_GARDEN = { lat: 51.511398, lng: -0.083507, alt: 155 };
const SHARD_BEARING = 195;
const SMOOTH_FACTOR = 0.12;
const BASE_FOV = 60;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/* === Geo-anchored, horizon-stuck placement (tunable on-site) ============ */
const VIEWER_ALT = SKY_GARDEN.alt;               // ~155 m above street level
function _clampNum(v, lo, hi, def) { return (typeof v === 'number' && !isNaN(v)) ? Math.min(hi, Math.max(lo, v)) : def; }
let HORIZON_HUG = _clampNum(parseFloat(localStorage.getItem('tlHug')), 0.05, 1.5, 0.4);    // 1 = true geometry; <1 hugs the horizon
let BEAM_SCALE  = _clampNum(parseFloat(localStorage.getItem('tlBeamScale')), 0.3, 3.0, 1.0);// multiplies light-column height (the drama / "wow")
let NORTH_NUDGE = _clampNum(parseFloat(localStorage.getItem('tlNorthNudge')), -45, 45, 0);// manual compass correction (applied live)
let SHOW_LANDMARKS = localStorage.getItem('tlShowLandmarks') === '1';
// Each beam's BASE sits at the office's true ground point (relative to the 155 m
// deck) so it stays planted on the real skyline; base elevation is compressed by
// HORIZON_HUG. The COLUMN then rises a generous tier height (see arHeight) * BEAM_SCALE
// so the beams read as tall light shafts again. Azimuth stays 100% true.
function groundBaseY(distM, r) {
  const d = Math.max(distM, 40);
  return r * Math.tan(Math.atan2(-VIEWER_ALT, d) * HORIZON_HUG);
}
const skyTargets = {};   // name -> { bearing, elev } ; published as window.__skyTargets for the Quest

// Particle-flow density by tier (more particles = more apparent payment volume).
// Star clients and banks read as high-volume; regular clients are lighter.
const FLOW_PARTICLES_STAR = 26;
const FLOW_PARTICLES_BANK = 26;   // <- set to 8 if you want banks lighter like regular clients
const FLOW_PARTICLES_CLIENT = 14;

// Branded photo frame text (easy to edit / swap for the party later)
const FRAME_TITLE = 'TrueLayer \u00b7 10 Year Anniversary';
const FRAME_SUBTITLE = 'Sky Garden \u00b7 2026';

let compassOffset = 0;
let calibrated = false;
let testMode = false;
let currentHeading = 0;
let smoothedHeading = 0;
let deviceAlpha = 0;
let deviceBeta = 90;
let deviceGamma = 0;
let usingAbsolute = false;

const LANDMARKS = {
  'shard':        { name: 'The Shard',    short: 'SHARD',   lat: 51.5045, lng: -0.0865 },
  'tower-bridge': { name: 'Tower Bridge', short: 'TWR BR',  lat: 51.5055, lng: -0.0754 },
  'gherkin':      { name: 'The Gherkin',  short: 'GHERKIN', lat: 51.5145, lng: -0.0803 },
  'canary-wharf': { name: 'Canary Wharf', short: 'CANARY',  lat: 51.5049, lng: -0.0195 }
};
let calSelected = null;
let calTargetBearing = 0;
let calRunning = false;
let calBound = false;

function angularDiff(target, current) {
  let d = target - current;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); };

function arHeight(tier, name) {
  if (tier === 'host') return 82;
  if (tier === 'star' || tier === 'bank') return 64;
  return 30 + (hashStr(name) % 24);
}

function getBearing(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scaleDistance(meters) {
  return 30 + Math.log10(meters / 100 + 1) * 100;
}

function getHemisphereFade(beamBearing, cameraHeading) {
  if (testMode) return 1.0;
  let diff = Math.abs(beamBearing - cameraHeading);
  if (diff > 180) diff = 360 - diff;
  if (diff <= 100) return 1.0;
  if (diff <= 145) return 1.0 - (diff - 100) / 45;
  return 0;
}

function lerpAngle(current, target, factor) {
  let diff = target - current;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (current + diff * factor + 360) % 360;
}

function createGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

const BEAM_VERT = `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;
const BEAM_FRAG = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uPhase;
  uniform float uFade;
  uniform float uDay;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float grad = mix(1.0, 0.22, vUv.y);
    float stripes = 0.5 + 0.5 * sin((vUv.y * 16.0 - uTime * 1.8 + uPhase * 6.2831) * 6.2831);
    stripes = pow(stripes, 3.0);
    float band = fract(uTime * 0.22 + uPhase);
    float wipe = smoothstep(0.13, 0.0, abs(vUv.y - band));
    float fres = pow(1.0 - abs(dot(vNormalW, vViewDir)), 2.0);
    if (uDay > 0.5) {
      // DAY: solid, opaque, readable against a bright sky (normal blending)
      float a = clamp(0.6 + 0.35 * stripes + wipe * 0.4, 0.0, 1.0) * uFade;
      vec3 c = uColor * (0.65 + 0.3 * stripes);
      c *= mix(1.0, 0.5, fres);            // darken rim for edge contrast
      gl_FragColor = vec4(c, a);
    } else {
      // NIGHT: additive neon glow
      float intensity = grad * (0.35 + 0.5 * stripes) + wipe * 0.9 + fres * 0.55;
      float a = clamp(intensity, 0.0, 1.0) * uFade;
      gl_FragColor = vec4(uColor * (0.85 + intensity * 0.6), a);
    }
  }
`;

function makeBeamMaterial(color, phase) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uPhase: { value: phase },
      uFade: { value: 1 },
      uDay: { value: 0 }
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
  });
}

function makeBadge(txt, fill, prefix = '') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 192;
  const ctx = c.getContext('2d');
  ctx.fillStyle = fill;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(16, 16, 224, 160, 16);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#ffffffcc';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(16, 16, 224, 160, 16);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 36px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${prefix}${txt}`, 128, 96);
  return new THREE.CanvasTexture(c);
}

function loadLogo(logoPath, spriteMat, sprite, baseHeight) {
  const texLoader = new THREE.TextureLoader();
  texLoader.load(logoPath, (logoTex) => {
    logoTex.colorSpace = THREE.SRGBColorSpace;
    spriteMat.map = logoTex;
    spriteMat.color.set('#ffffff');
    spriteMat.needsUpdate = true;
    const img = logoTex.image;
    const aspect = img.width / img.height;
    sprite.scale.set(baseHeight * aspect, baseHeight, 1);
  }, undefined, () => {});
}

function buildFlowCurve(a, b) {
  const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(
    (Math.random() - 0.5) * 12, 16 + Math.random() * 28, (Math.random() - 0.5) * 12
  ));
  return new THREE.CatmullRomCurve3([a.clone(), mid, b.clone()]);
}
function appendCurveLine(curve, linePos, seg) {
  seg = seg || 22;
  let prev = curve.getPoint(0);
  for (let s = 1; s <= seg; s++) {
    const cur = curve.getPoint(s / seg);
    linePos.push(prev.x, prev.y, prev.z, cur.x, cur.y, cur.z);
    prev = cur;
  }
}

function createARFlow(curve, colorA, colorB, scene, glowTex, count) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c1 = new THREE.Color(colorA);
  const c2 = new THREE.Color(colorB);
  const seeds = [];
  for (let i = 0; i < count; i++) {
    const p = curve.getPoint(i / count);
    pos.set([p.x, p.y, p.z], i * 3);
    const c = c1.clone().lerp(c2, i / count);
    col.set([c.r, c.g, c.b], i * 3);
    seeds.push({
      sx: Math.random() * 100, sy: Math.random() * 100, sz: Math.random() * 100,
      freqX: 0.25 + Math.random() * 0.55, freqY: 0.2 + Math.random() * 0.45,
      freqZ: 0.25 + Math.random() * 0.55, spread: 0.8 + Math.random() * 1.4,
      speedMult: 0.7 + Math.random() * 0.6
    });
  }
  const layers = [];
  // layers[0] = soft halo, layers[1] = bright core
  [{ size: 3.4, opacity: 0.4 }, { size: 1.4, opacity: 0.85 }].forEach((cfg) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const m = new THREE.PointsMaterial({
      size: cfg.size, map: glowTex, vertexColors: true, transparent: true,
      opacity: cfg.opacity, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    const pts = new THREE.Points(g, m);
    scene.add(pts);
    layers.push(pts);
  });
  return { curve, layers, count, seeds, baseCol: col, speed: 0.03 + Math.random() * 0.025, offset: Math.random(), bearing: 0 };
}

const _zee = new THREE.Vector3(0, 0, 1);
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function getDeviceQuaternion(out, alpha, beta, gamma, screenOrient) {
  const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(_q1);
  out.multiply(new THREE.Quaternion().setFromAxisAngle(_zee, -screenOrient));
}

function getScreenOrientation() {
  return (window.screen.orientation?.angle || window.orientation || 0) * (Math.PI / 180);
}

function requestFullscreen() {
  const el = document.documentElement;
  const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (rfs) rfs.call(el).catch(() => {});
  if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
}

function exitFullscreen() {
  const efs = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (efs) efs.call(document).catch(() => {});
  if (screen.orientation?.unlock) screen.orientation.unlock();
}

/* Pin the UI to the VISIBLE viewport (dvh + safe-area) so that when the browser
   chrome (address bar) reappears on rotation, the bottom control bar and the
   corner buttons are never pushed off-screen / chopped. */
(function injectViewportFix() {
  // Chrome reports env(safe-area-inset-*)=0 unless the viewport meta opts in with
  // viewport-fit=cover; without it the control labels sit under the gesture bar.
  let mv = document.querySelector('meta[name="viewport"]');
  if (!mv) { mv = document.createElement('meta'); mv.name = 'viewport'; (document.head || document.documentElement).appendChild(mv); }
  if (!/viewport-fit/.test(mv.content || '')) {
    mv.content = (mv.content ? mv.content + ', ' : '') + 'viewport-fit=cover';
  }
  const css = document.createElement('style');
  css.textContent =
    'html,body{height:100dvh!important;min-height:100dvh!important;overflow:hidden!important;}' +
    '#ar-canvas,#camera-feed{height:100dvh!important;}' +
    '#loading-overlay,#calibration-overlay,#ios-permission{height:100dvh!important;}' +
    '#ar-controls{position:fixed!important;top:auto!important;' +
      'bottom:calc(env(safe-area-inset-bottom,0px) + 20px)!important;z-index:60!important;}' +
    '#exit-fs-btn{position:fixed!important;bottom:auto!important;' +
      'top:calc(env(safe-area-inset-top,0px) + 10px)!important;' +
      'right:calc(env(safe-area-inset-right,0px) + 12px)!important;z-index:61!important;}' +
    '#hud{position:fixed!important;bottom:auto!important;' +
      'top:calc(env(safe-area-inset-top,0px) + 10px)!important;' +
      'left:calc(env(safe-area-inset-left,0px) + 12px)!important;z-index:61!important;}';
  (document.head || document.documentElement).appendChild(css);
})();

async function startCamera() {
  const video = document.getElementById('camera-feed');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    return true;
  } catch (err) {
    document.getElementById('loading-overlay').querySelector('p:last-child').textContent =
      'Camera access denied. Please allow camera access and reload.';
    return false;
  }
}

function applyReading(e) {
  if (e.alpha == null && e.webkitCompassHeading == null) return;
  deviceAlpha = e.alpha || 0;
  deviceBeta = e.beta != null ? e.beta : 90;
  deviceGamma = e.gamma || 0;
  if (typeof e.webkitCompassHeading === 'number') {
    currentHeading = e.webkitCompassHeading;
  } else if (e.alpha != null) {
    currentHeading = (360 - e.alpha) % 360;
  }
}

function handleOrientationAbsolute(e) {
  if (e.alpha == null) return;
  usingAbsolute = true;
  applyReading(e);
}

function handleOrientationRelative(e) {
  if (usingAbsolute) return;
  applyReading(e);
}

async function startOrientation() {
  if (typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function') {
    const iosOverlay = document.getElementById('ios-permission');
    iosOverlay.classList.remove('hidden');
    return new Promise((resolve) => {
      document.getElementById('ios-permission-btn').addEventListener('click', async () => {
        try {
          const permission = await DeviceOrientationEvent.requestPermission();
          if (permission === 'granted') {
            window.addEventListener('deviceorientation', handleOrientationRelative, true);
            iosOverlay.classList.add('hidden');
            resolve(true);
          } else { resolve(false); }
        } catch (err) { resolve(false); }
      });
    });
  } else {
    window.addEventListener('deviceorientationabsolute', handleOrientationAbsolute, true);
    window.addEventListener('deviceorientation', handleOrientationRelative, true);
    return true;
  }
}

function showCalibration() {
  document.getElementById('cal-step2').classList.add('hidden');
  document.getElementById('cal-step1').classList.remove('hidden');
  document.getElementById('calibration-overlay').classList.remove('hidden');
  calSelected = null;
  document.getElementById('hud')?.classList.add('hidden');
  document.getElementById('ar-controls')?.classList.add('hidden');
}

function setupCalibration() {
  const overlay = document.getElementById('calibration-overlay');
  const step1 = document.getElementById('cal-step1');
  const step2 = document.getElementById('cal-step2');
  const nameEl = document.getElementById('cal-name');
  const hintEl = document.getElementById('cal-hint');
  const degEl = document.getElementById('cal-deg');
  const arrowEl = document.getElementById('cal-arrow');
  const reticle = document.getElementById('cal-reticle');
  const lockBtn = document.getElementById('cal-lock-btn');

  function calTick() {
    if (!calSelected) { calRunning = false; return; }
    const diff = angularDiff(calTargetBearing, currentHeading);
    const aligned = Math.abs(diff) <= 8;
    degEl.textContent = aligned ? '' : Math.round(Math.abs(diff)) + '\u00b0 to go';
    if (aligned) {
      arrowEl.textContent = '';
      hintEl.textContent = 'On target \u2014 tap LOCK';
      reticle.classList.add('aligned');
      lockBtn.classList.add('ready');
    } else {
      reticle.classList.remove('aligned');
      lockBtn.classList.remove('ready');
      arrowEl.textContent = diff > 0 ? '\u25B6' : '\u25C0';
      hintEl.textContent = diff > 0 ? 'Turn right to find it' : 'Turn left to find it';
    }
    requestAnimationFrame(calTick);
  }

  if (!calBound) {
    // Auto-compass: a one-tap entry that uses the phone's absolute north (no landmark needed).
    const autoBtn = document.createElement('button');
    autoBtn.id = 'cal-auto-btn';
    autoBtn.textContent = 'Enter AR \u2192';
    autoBtn.style.cssText = 'display:block;width:100%;margin:0 0 14px;padding:15px;border:none;border-radius:12px;font:800 17px/1 -apple-system,BlinkMacSystemFont,sans-serif;background:linear-gradient(135deg,#AFADFF,#4D3BD8);color:#060606;cursor:pointer;';
    autoBtn.addEventListener('click', () => {
      compassOffset = 0;
      calibrated = true; calSelected = null;
      overlay.classList.add('hidden');
      requestFullscreen();
      document.getElementById('hud')?.classList.remove('hidden');
      document.getElementById('ar-controls')?.classList.remove('hidden');
      document.getElementById('exit-fs-btn')?.classList.remove('hidden');
    });
    step1.insertBefore(autoBtn, step1.firstChild);
    document.querySelectorAll('.cal-landmark-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        calSelected = btn.dataset.landmark;
        const lm = LANDMARKS[calSelected];
        calTargetBearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, lm.lat, lm.lng);
        nameEl.textContent = lm.name;
        hintEl.textContent = 'Find it in view';
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        if (!calRunning) { calRunning = true; requestAnimationFrame(calTick); }
      });
    });
    document.getElementById('cal-back-btn').addEventListener('click', () => {
      calSelected = null;
      step2.classList.add('hidden');
      step1.classList.remove('hidden');
    });
    lockBtn.addEventListener('click', () => {
      if (!calSelected) return;
      compassOffset = calTargetBearing - currentHeading;
      calibrated = true;
      calSelected = null;
      overlay.classList.add('hidden');
      requestFullscreen();
      document.getElementById('hud')?.classList.remove('hidden');
      document.getElementById('ar-controls')?.classList.remove('hidden');
      document.getElementById('exit-fs-btn')?.classList.remove('hidden');
    });
    calBound = true;
  }

  showCalibration();
}

function createARScene() {
  const canvas = document.getElementById('ar-canvas');
  const video = document.getElementById('camera-feed');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 2000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const glowTex = createGlowTexture();
  const beamEntries = [];
  const flowEmitters = [];

  const hudMode = document.getElementById('hud-mode');

  /* -- RENDER MODES: day/night (auto from camera brightness) + disco -- */
  let dayMode = false;
  let lightMode = 'auto';   // 'auto' | 'day' | 'night'
  let discoMode = false;
  let latticeMat = null;

  function applyRenderMode() {
    const add = THREE.AdditiveBlending, norm = THREE.NormalBlending;
    beamEntries.forEach((b) => {
      b.beamMat.uniforms.uDay.value = dayMode ? 1 : 0;
      b.beamMat.blending = dayMode ? norm : add;
      b.glow.visible = !dayMode;                       // glow halo is night-only
      b.ring.material.blending = dayMode ? norm : add;
    });
    flowEmitters.forEach((f) => {
      f.layers[0].material.blending = dayMode ? norm : add;
      f.layers[1].material.blending = dayMode ? norm : add;
      f.layers[0].material.opacity = dayMode ? 0.55 : 0.42;  // soft glow halo (visible day + night)
      f.layers[1].material.opacity = dayMode ? 0.98 : 0.9;   // bright glowing cores
    });
    if (latticeMat) {
      latticeMat.blending = dayMode ? norm : add;
      latticeMat.opacity = dayMode ? 0.4 : 0.2;
      latticeMat.color.set(dayMode ? '#AFADFF' : '#9fd0ff');
    }
  }

  // brightness sampler (auto day/night)
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 16; sampleCanvas.height = 16;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  function sampleBrightness() {
    if (!video.videoWidth) return null;
    try {
      sampleCtx.drawImage(video, 0, 0, 16, 16);
      const data = sampleCtx.getImageData(0, 0, 16, 16).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return (sum / (data.length / 4)) / 255;
    } catch (e) { return null; }
  }
  setInterval(() => {
    if (lightMode !== 'auto') return;
    const b = sampleBrightness();
    if (b == null) return;
    const wantDay = dayMode ? b > 0.45 : b > 0.55;   // hysteresis to avoid flicker
    if (wantDay !== dayMode) { dayMode = wantDay; applyRenderMode(); }
  }, 1500);

  /* -- ZOOM (digital: FOV + matching video scale keeps beams locked) -- */
  let zoom = 1;
  function applyZoom(z) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    camera.fov = 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) / zoom) * 180 / Math.PI;
    camera.updateProjectionMatrix();
    video.style.transformOrigin = 'center center';
    video.style.transform = 'scale(' + zoom + ')';
    if (!testMode) hudMode.textContent = zoom > 1.02 ? 'Zoom ' + zoom.toFixed(1) + 'x' : '';
  }

  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let lastTapTime = 0;
  window.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = touchDist(e.touches);
      pinchStartZoom = zoom;
    }
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist > 0) {
      const d = touchDist(e.touches);
      applyZoom(pinchStartZoom * (d / pinchStartDist));
      e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = 0;
    if (e.touches.length === 0) {
      const now = Date.now();
      const onButton = e.target && (e.target.closest('#ar-controls') || e.target.closest('#exit-fs-btn'));
      if (!onButton && now - lastTapTime < 300) applyZoom(1);
      lastTapTime = now;
    }
  }, { passive: true });

  /* -- CONFETTI: on-screen celebration after a Snap (not baked into the photo) -- */
  const confettiCanvas = document.createElement('canvas');
  confettiCanvas.style.cssText = 'position:fixed;inset:0;z-index:4;pointer-events:none;';
  document.body.appendChild(confettiCanvas);
  const confettiCtx = confettiCanvas.getContext('2d');
  let confettiParticles = [];
  let confettiRunning = false;
  const CONFETTI_COLORS = ['#4D3BD8', '#AFADFF', '#ec4899', '#ffffff', '#5bb4ff', '#f59e0b'];
  function sizeConfetti() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    confettiCanvas.width = window.innerWidth * dpr;
    confettiCanvas.height = window.innerHeight * dpr;
    confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeConfetti();
  function fireConfetti() {
    const Wd = window.innerWidth, Hd = window.innerHeight;
    for (let i = 0; i < 130; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;  // upward fan
      const spd = 7 + Math.random() * 11;
      confettiParticles.push({
        x: Wd * 0.5, y: Hd * 0.6,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        w: 6 + Math.random() * 7, h: 8 + Math.random() * 9,
        rot: Math.random() * Math.PI, vrot: (Math.random() - 0.5) * 0.45,
        color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
        life: 70 + Math.random() * 45
      });
    }
    if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(confettiTick); }
  }
  function confettiTick() {
    const Wd = window.innerWidth, Hd = window.innerHeight;
    confettiCtx.clearRect(0, 0, Wd, Hd);
    for (let i = confettiParticles.length - 1; i >= 0; i--) {
      const p = confettiParticles[i];
      p.vy += 0.3; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vrot; p.life--;
      if (p.life <= 0 || p.y > Hd + 40) { confettiParticles.splice(i, 1); continue; }
      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      confettiCtx.globalAlpha = Math.min(1, p.life / 30);
      confettiCtx.fillStyle = p.color;
      confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      confettiCtx.restore();
    }
    if (confettiParticles.length > 0) { requestAnimationFrame(confettiTick); }
    else { confettiCtx.clearRect(0, 0, Wd, Hd); confettiRunning = false; }
  }

  /* -- WATERMARK: corner logo burned into captured photos.
        Swap WATERMARK_SRC to your party logo later (e.g. '/logos/party.png'). -- */
  const WATERMARK_SRC = '/party.png';   // transparent party logo (looks better than the white-card logo)
  const watermarkImg = new Image();
  let watermarkReady = false;
  if (WATERMARK_SRC) {
    watermarkImg.onload = () => { watermarkReady = true; };
    watermarkImg.src = WATERMARK_SRC;
  }

  /* -- PHOTO CAPTURE: camera feed + overlay + branded frame + watermark -> share/download -- */
  function capturePhoto() {
    const gl = renderer.domElement;
    const W = gl.width, H = gl.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');

    // 1. camera feed (object-fit: cover * current zoom)
    const vw = video.videoWidth || W;
    const vh = video.videoHeight || H;
    const coverScale = Math.max(W / vw, H / vh) * zoom;
    const dw = vw * coverScale, dh = vh * coverScale;
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);

    // 2. 3D overlay (beams + logos) — HUD/buttons/confetti are not included
    ctx.drawImage(gl, 0, 0, W, H);

    // 3. branded frame (adapts to portrait & landscape): sizes key off the SHORT
    //    side so text/logo look consistent in either orientation. Caption sits
    //    bottom-LEFT (light Manrope, ~half the old size); party logo bottom-RIGHT,
    //    so the two never overlap.
    const m = Math.min(W, H);
    const pad = Math.round(m * 0.045);
    const fF = 'Manrope, -apple-system, BlinkMacSystemFont, sans-serif';

    const bandH = Math.round(m * 0.22);
    const g = ctx.createLinearGradient(0, H - bandH, 0, H);
    g.addColorStop(0, 'rgba(10,8,25,0)');
    g.addColorStop(1, 'rgba(10,8,25,0.74)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - bandH, W, bandH);

    // transparent party logo, bottom-right (no white card; soft shadow so it
    // still reads against a bright sky)
    if (watermarkReady) {
      const aspect = (watermarkImg.naturalWidth / watermarkImg.naturalHeight) || 1;
      const logoH = Math.round(m * 0.13);
      const logoW = Math.round(logoH * aspect);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.round(m * 0.02);
      ctx.globalAlpha = 0.96;
      ctx.drawImage(watermarkImg, W - logoW - pad, H - logoH - pad, logoW, logoH);
      ctx.restore();
    }

    // caption bottom-left, two lines, lighter Manrope at ~half the previous size
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const s1 = Math.round(m * 0.030);
    const s2 = Math.round(m * 0.024);
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = '600 ' + s1 + 'px ' + fF;
    ctx.fillText(FRAME_TITLE, pad, H - pad - s2 - Math.round(m * 0.014));
    if (FRAME_SUBTITLE) {
      ctx.fillStyle = 'rgba(255,255,255,0.74)';
      ctx.font = '300 ' + s2 + 'px ' + fF;
      ctx.fillText(FRAME_SUBTITLE, pad, H - pad);
    }

    // thin brand border
    const bw = Math.max(3, Math.round(m * 0.006));
    ctx.strokeStyle = 'rgba(77,59,216,0.9)';
    ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);

    // 5. export + share/download
    out.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], 'truelayer-sky-garden.jpg', { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'TrueLayer Sky Garden AR' }).catch(() => {});
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'truelayer-sky-garden.jpg';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      hudMode.textContent = '\uD83D\uDCF8 Saved!';
      setTimeout(() => { if (!testMode && zoom <= 1.02) hudMode.textContent = ''; }, 1500);
    }, 'image/jpeg', 0.92);
  }

  document.getElementById('exit-fs-btn').addEventListener('click', () => exitFullscreen());

  const testBtn = document.getElementById('test-btn');
  testBtn.addEventListener('click', () => {
    testMode = !testMode;
    if (testMode) {
      testBtn.textContent = 'TEST ON';
      testBtn.classList.add('active');
      hudMode.textContent = 'MODE: TEST (all beams)';
    } else {
      testBtn.textContent = '🔧 Test Mode';
      testBtn.classList.remove('active');
      hudMode.textContent = '';
    }
    buildTunePanel().style.display = testMode ? 'block' : 'none';
  });

  let _tunePanel = null;
  function buildTunePanel() {
    if (_tunePanel) return _tunePanel;
    const p = document.createElement('div');
    p.id = 'tl-tune';
    p.style.cssText = 'position:fixed;top:64px;left:10px;z-index:50;width:212px;padding:12px 13px;border-radius:14px;background:rgba(6,6,6,0.82);border:1px solid rgba(175,173,255,0.4);color:#fff;font:600 12px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:none;';
    const row = (label, id, min, max, step, val) =>
      '<label style="display:block;margin:8px 0 2px;">' + label + ': <b id="' + id + '-v">' + val + '</b></label>' +
      '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" style="width:100%;">';
    p.innerHTML =
      '<div style="font-weight:800;font-size:13px;margin-bottom:4px;">\uD83D\uDD27 Tuning</div>' +
      row('Horizon hug', 'tl-hug', 0.05, 1.5, 0.05, HORIZON_HUG) +
      row('Beam length', 'tl-beam', 0.3, 3.0, 0.1, BEAM_SCALE) +
      row('North nudge (\u00b0)', 'tl-north', -45, 45, 1, NORTH_NUDGE) +
      '<label style="display:flex;align-items:center;gap:8px;margin:10px 0 4px;"><input id="tl-lm" type="checkbox" ' + (SHOW_LANDMARKS ? 'checked' : '') + '> Show landmark beams</label>' +
      '<div style="opacity:.6;font-size:10px;margin:6px 0;">North &amp; landmarks update live. Hug &amp; height apply on tap.</div>' +
      '<button id="tl-apply" style="width:100%;margin-top:4px;padding:9px;border:none;border-radius:10px;background:#AFADFF;color:#060606;font-weight:800;cursor:pointer;">Apply layout</button>' +
      '<button id="tl-reset" style="width:100%;margin-top:7px;padding:8px;border:1px solid rgba(175,173,255,.5);border-radius:10px;background:transparent;color:#fff;font-weight:700;cursor:pointer;">Reset defaults</button>';
    document.body.appendChild(p);
    const $ = (id) => p.querySelector('#' + id);
    $('tl-hug').addEventListener('input', (e) => { HORIZON_HUG = parseFloat(e.target.value); $('tl-hug-v').textContent = HORIZON_HUG; localStorage.setItem('tlHug', HORIZON_HUG); });
    $('tl-beam').addEventListener('input', (e) => { BEAM_SCALE = parseFloat(e.target.value); $('tl-beam-v').textContent = BEAM_SCALE; localStorage.setItem('tlBeamScale', BEAM_SCALE); });
    $('tl-north').addEventListener('input', (e) => { NORTH_NUDGE = parseFloat(e.target.value); $('tl-north-v').textContent = NORTH_NUDGE; localStorage.setItem('tlNorthNudge', NORTH_NUDGE); });
    $('tl-lm').addEventListener('change', (e) => { SHOW_LANDMARKS = e.target.checked; localStorage.setItem('tlShowLandmarks', SHOW_LANDMARKS ? '1' : '0'); });
    $('tl-apply').addEventListener('click', () => location.reload());
    $('tl-reset').addEventListener('click', () => { ['tlHug', 'tlBeamScale', 'tlNorthNudge', 'tlShowLandmarks'].forEach((k) => localStorage.removeItem(k)); location.reload(); });
    _tunePanel = p;
    return p;
  }

  const discoBtn = document.getElementById('disco-btn');
  discoBtn.addEventListener('click', () => {
    discoMode = !discoMode;
    discoBtn.classList.toggle('active', discoMode);
    if (!discoMode) {
      beamEntries.forEach((b) => b.beamMat.uniforms.uColor.value.copy(b.baseColor));
    }
  });

  const lightBtn = document.getElementById('light-btn');
  lightBtn.addEventListener('click', () => {
    if (lightMode === 'auto') { lightMode = 'day'; dayMode = true; lightBtn.textContent = '☀️ Day'; }
    else if (lightMode === 'day') { lightMode = 'night'; dayMode = false; lightBtn.textContent = '🌙 Night'; }
    else { lightMode = 'auto'; lightBtn.textContent = '🌓 Auto'; }
    applyRenderMode();
  });

  document.getElementById('recalibrate-btn').addEventListener('click', () => {
    calibrated = false;
    setupCalibration();
  });

  document.getElementById('snap-btn').addEventListener('click', () => { capturePhoto(); fireConfetti(); });

  const tlClient = clients.find(c => c.name === 'TrueLayer');
  const tlBearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng);
  const tlDistM = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng);
  const tlDist = scaleDistance(tlDistM);
  const tlBearingRad = tlBearing * Math.PI / 180;
  const tlBaseY = groundBaseY(tlDistM, tlDist);
  const tlColumnH = arHeight('host', tlClient.name) * BEAM_SCALE;
  const tlWorldPos = new THREE.Vector3(Math.sin(tlBearingRad) * tlDist, tlBaseY, -Math.cos(tlBearingRad) * tlDist);
  const tlTopPos = tlWorldPos.clone().add(new THREE.Vector3(0, tlColumnH, 0));

  const linePos = [];   // lattice segments, shared with the particle flows

  function buildBeam({ color, h, isTL, initials, logo, isStar, bearing, sceneDist, isBank, baseY = -8, isLandmark = false }) {
    const group = new THREE.Group();
    const phase = Math.random();

    const beamMat = makeBeamMaterial(color, phase);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 3 : 0.6, isTL ? 3 : 0.6, h, isTL ? 32 : 16, 1, true),
      beamMat
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 5 : 1.1, isTL ? 5 : 1.1, h * 1.05, isTL ? 32 : 16, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = h / 2;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 5 : 1.1, isTL ? 7.5 : 1.9, 32),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;

    const badgeTex = makeBadge(initials, color);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.renderOrder = 10;   // draw logos LAST so beams, flows & particles sit behind them
    const spriteH = isTL ? 9 : (isStar ? 6 : (isBank ? 6 : 4.5));
    sprite.scale.set(spriteH * 1.33, spriteH, 1);
    sprite.position.y = h + 3;
    sprite.userData.baseY = h + 3;
    if (logo) loadLogo(logo, spriteMat, sprite, isTL ? 16 : (isStar || isBank ? 9 : 6));

    group.add(beam, glow, ring, sprite);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, baseY, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, beam, bearing, beamMat, glow, ring, sprite, phase, h, isTL, isLandmark, baseColor: new THREE.Color(color) });
    return group;
  }

  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const distM = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(distM);
    const isTL = client.name === 'TrueLayer';
    const isStar = client.tier === 'star';
    const baseY = groundBaseY(distM, sceneDist);
    const h = arHeight(isTL ? 'host' : (isStar ? 'star' : client.tier), client.name) * BEAM_SCALE;

    const group = buildBeam({
      color: client.beamColor, h, isTL, initials: client.initials,
      logo: client.logo, isStar, bearing, sceneDist, isBank: false, baseY
    });
    skyTargets[client.name] = { bearing, elev: Math.atan2(baseY + h + 3, sceneDist) * 180 / Math.PI };

    if (!isTL) {
      const clientWorldPos = group.position.clone();
      const clientTop = clientWorldPos.clone().add(new THREE.Vector3(0, h, 0));
      const tlFlowPoint = tlTopPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 14));
      const count = isStar ? FLOW_PARTICLES_STAR : FLOW_PARTICLES_CLIENT;
      const curve = buildFlowCurve(clientTop, tlFlowPoint);   // client -> TrueLayer (flows IN)
      const flow = createARFlow(curve, '#a78bfa', '#2dd4bf', scene, glowTex, count);
      flow.bearing = bearing;
      flowEmitters.push(flow);
      appendCurveLine(curve, linePos);
    }
  });

  banks.forEach((bank) => {
    let bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    // Offset Starling so its beam does not sit directly behind TrueLayer.
    if (/starling/i.test(bank.name)) bearing += 16;
    const distM = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const sceneDist = scaleDistance(distM);
    const baseY = groundBaseY(distM, sceneDist);
    const h = arHeight('bank', bank.name) * BEAM_SCALE;

    const group = buildBeam({
      color: '#4dabff', h, isTL: false, initials: bank.initials,
      logo: bank.logo, isStar: false, bearing, sceneDist, isBank: true, baseY
    });
    skyTargets[bank.name] = { bearing, elev: Math.atan2(baseY + h + 3, sceneDist) * 180 / Math.PI };

    const bankWorldPos = group.position.clone();
    const bankTop = bankWorldPos.clone().add(new THREE.Vector3(0, h, 0));
    const tlFlowPoint = tlTopPos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 14));
    const curve = buildFlowCurve(tlFlowPoint, bankTop);   // TrueLayer -> bank (flows OUT)
    const flow = createARFlow(curve, '#d6ecff', '#5bb4ff', scene, glowTex, FLOW_PARTICLES_BANK);
    flow.bearing = bearing;
    flowEmitters.push(flow);
    appendCurveLine(curve, linePos);
  });

  /* -- TEST: reference beams on real landmarks to verify alignment on-site -- */
  Object.keys(LANDMARKS).forEach((key) => {
    const lm = LANDMARKS[key];
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, lm.lat, lm.lng);
    const distM = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, lm.lat, lm.lng);
    const sceneDist = scaleDistance(distM);
    const baseY = groundBaseY(distM, sceneDist);
    const g = buildBeam({
      color: '#ffd54a', h: 60 * BEAM_SCALE, isTL: false, initials: lm.short || lm.name,
      logo: '', isStar: false, bearing, sceneDist, isBank: false, baseY, isLandmark: true
    });
    g.visible = false;
  });

  window.__skyTargets = skyTargets;

  /* -- LATTICE: one glowing line per connection, sharing each flow's curve -- */
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
  latticeMat = new THREE.LineBasicMaterial({
    color: '#8fc8ff', transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false
  });
  const lattice = new THREE.LineSegments(lineGeo, latticeMat);
  scene.add(lattice);

  applyRenderMode();   // initialise materials for the current (night) mode

  const hudHeading = document.getElementById('hud-heading');
  const hudBeams = document.getElementById('hud-beams');
  const hudBox = document.getElementById('hud');

  const rawQuat = new THREE.Quaternion();
  const smoothQuat = new THREE.Quaternion();
  let quatReady = false;
  const camEuler = new THREE.Euler();
  const _fwd = new THREE.Vector3();

  /* -- HERO: party logo floating, facing you & glowing in the sky above Sky Garden -- */
  let skyLogo = null, skyGlow = null, skyGlowW = 200, skyGlowH = 150;
  const SKY_DIST = 95, SKY_BASE_Y = 135;
  const _skyBR = SHARD_BEARING * Math.PI / 180;
  const skyPos = new THREE.Vector3(Math.sin(_skyBR) * SKY_DIST, SKY_BASE_Y, -Math.cos(_skyBR) * SKY_DIST);
  {
    const sg = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xAFADFF, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    sg.scale.set(skyGlowW, skyGlowH, 1); sg.position.copy(skyPos); scene.add(sg); skyGlow = sg;
    const sl = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
    sl.position.copy(skyPos); scene.add(sl); skyLogo = sl;
    new THREE.TextureLoader().load('/party.png', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      sl.material.map = tex; sl.material.opacity = 1; sl.material.needsUpdate = true;
      const a = (tex.image.width / tex.image.height) || 3;
      const HH = 70; const W = HH * a; sl.scale.set(W, HH, 1);   // much bigger hero
      skyGlowW = W * 0.85; skyGlowH = HH * 2.0;
    }, undefined, () => { sg.visible = false; });
  }

  function animate() {
    requestAnimationFrame(animate);
    if (!calibrated) { renderer.render(scene, camera); return; }

    const t = performance.now() * 0.001;

    smoothedHeading = lerpAngle(smoothedHeading, currentHeading, SMOOTH_FACTOR);
    const adjustedHeading = (smoothedHeading + compassOffset + NORTH_NUDGE + 360) % 360;
    // __skyHeading is now set from camAz below (the screen-orientation-corrected look direction the beams use) so the Quest arrow and the beams share one reference.

    const alphaRad = (deviceAlpha * Math.PI / 180) + ((compassOffset + NORTH_NUDGE) * Math.PI / 180);
    const betaRad = deviceBeta * Math.PI / 180;
    const gammaRad = deviceGamma * Math.PI / 180;
    const screenOrient = getScreenOrientation();

    getDeviceQuaternion(rawQuat, alphaRad, betaRad, gammaRad, screenOrient);
    if (!quatReady) { smoothQuat.copy(rawQuat); quatReady = true; }
    else { smoothQuat.slerp(rawQuat, SMOOTH_FACTOR); }
    camera.quaternion.copy(smoothQuat);

    camEuler.setFromQuaternion(smoothQuat, 'YXZ');
    const counterRoll = -camEuler.z;

    // Cull by where the camera ACTUALLY looks (stable in any orientation / tilt),
    // not the raw compass heading (which flips when the phone pitches up in portrait).
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const camAz = (Math.atan2(_fwd.x, -_fwd.z) * 180 / Math.PI + 360) % 360;
    window.__skyHeading = camAz;   // FIX: feed the Quest game the actual camera look direction (matches beam placement), not the raw compass heading.
    window.__skyPitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y))) * 180 / Math.PI;   // up/down look angle, for the Quest vertical cue

    let visibleCount = 0;
    beamEntries.forEach((b, i) => {
      if (b.isLandmark && !SHOW_LANDMARKS) { b.group.visible = false; return; }
      const fade = getHemisphereFade(b.bearing, camAz);
      b.group.visible = fade > 0.01;
      if (!b.group.visible) return;
      visibleCount++;

      const ph6 = b.phase * 6.2831;
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.4 + ph6);

      // ---- DISCO: gentle rainbow + soft swaying columns (movement-focused, tamed) ----
      let topY = b.h + 3;
      if (discoMode) {
        const hue = (t * 0.12 + b.phase) % 1;                          // slow, calm colour drift
        b.beamMat.uniforms.uColor.value.setHSL(hue, 0.85, 0.58);
        const beat = 0.5 + 0.5 * Math.sin(t * 2.2);                     // gentle shared sway
        const wob  = 0.5 + 0.5 * Math.sin(t * (1.4 + b.phase * 1.6) + ph6);
        const s = 0.82 + 0.3 * (0.5 * beat + 0.5 * wob);              // ~0.82 .. ~1.12 (calm)
        b.beam.scale.y = s; b.beam.position.y = b.h * s / 2;
        topY = b.h * s + 3;
      } else if (b.beam.scale.y !== 1) {
        b.beam.scale.y = 1; b.beam.position.y = b.h / 2;                // reset after disco
      }

      b.beamMat.uniforms.uTime.value = t;
      b.beamMat.uniforms.uFade.value = fade;

      const gxz = 1 + breathe * 0.07;
      const gy = discoMode ? b.beam.scale.y : 1;
      b.glow.scale.set(gxz, gy, gxz);
      b.glow.position.y = (discoMode ? b.h * b.beam.scale.y : b.h) / 2;
      b.glow.material.opacity = fade * (0.10 + 0.10 * breathe);

      const ringP = (t * 0.4 + b.phase) % 1;
      const rs = 1 + ringP * 2.6;
      b.ring.scale.set(rs, rs, 1);
      b.ring.material.opacity = fade * (1 - ringP) * (dayMode ? 0.4 : 0.6);

      b.sprite.material.opacity = fade;
      b.sprite.material.rotation = counterRoll;
      b.sprite.position.y = topY + Math.sin(t * 1.1 + i * 0.7) * 1.2;
    });

    if (skyLogo) {
      const bob = Math.sin(t * 0.8) * 5;
      skyLogo.position.y = SKY_BASE_Y + bob;
      if (skyGlow && skyGlow.visible) {
        skyGlow.position.y = SKY_BASE_Y + bob;
        const pulse = 0.3 + 0.16 * Math.sin(t * 1.3);
        skyGlow.material.opacity = discoMode ? pulse * 1.4 : pulse;
        const k = 1 + 0.06 * Math.sin(t * 1.3) + (discoMode ? 0.08 : 0);
        skyGlow.scale.set(skyGlowW * k, skyGlowH * k, 1);
      }
    }

    flowEmitters.forEach((f) => {
      const fade = getHemisphereFade(f.bearing, camAz);
      const vis = fade > 0.01;
      f.layers.forEach((layer, li) => {
        const arr = layer.geometry.attributes.position.array;
        const carr = li === 1 ? layer.geometry.attributes.color.array : null;
        for (let i = 0; i < f.count; i++) {
          const u = (i / f.count + t * f.speed * f.seeds[i].speedMult + f.offset) % 1;
          const p = f.curve.getPoint(u);
          const s = f.seeds[i];
          arr[i * 3] = p.x + Math.sin(t * s.freqX + s.sx) * s.spread;
          arr[i * 3 + 1] = p.y + Math.sin(t * s.freqY + s.sy) * s.spread * 0.3;
          arr[i * 3 + 2] = p.z + Math.cos(t * s.freqZ + s.sz) * s.spread;
          if (carr) {
            const local = (u * 3) % 1;
            const b = 0.3 + 0.7 * local * local;   // comet: bright leading edge, faint tail (shows flow direction)
            carr[i * 3] = f.baseCol[i * 3] * b;
            carr[i * 3 + 1] = f.baseCol[i * 3 + 1] * b;
            carr[i * 3 + 2] = f.baseCol[i * 3 + 2] * b;
          }
        }
        layer.geometry.attributes.position.needsUpdate = true;
        if (carr) layer.geometry.attributes.color.needsUpdate = true;
      });
    });

    if (testMode) {
      hudHeading.textContent = 'Heading: ' + adjustedHeading.toFixed(0) + String.fromCharCode(176) +
      (usingAbsolute ? ' [abs]' : ' [rel]') + (dayMode ? ' \u2600' : ' \u263e');
    hudBeams.textContent = 'Beams visible: ' + visibleCount;
    } else {
      hudHeading.textContent = '';
      hudBeams.textContent = '';
    }
    if (hudBox) hudBox.classList.toggle('hidden', !(hudHeading.textContent || hudBeams.textContent || hudMode.textContent));
    renderer.render(scene, camera);
  }

  animate();
  setupControlBar();

  function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    sizeConfetti();
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', () => setTimeout(handleResize, 250));
}

function setupControlBar() {
  const bar = document.getElementById('ar-controls');
  if (!bar) return;
  const PRIMARY = { 'disco-btn': 'Disco', 'snap-btn': 'Snap', 'q-launch': 'Quest' };
  const PRIMARY_ORDER = ['disco-btn', 'snap-btn', 'q-launch'];
  const SECONDARY = ['recalibrate-btn', 'light-btn', 'test-btn'];

  let moreBtn = document.getElementById('tl-more');
  let panel = document.getElementById('tl-more-panel');
  if (!moreBtn) {
    moreBtn = document.createElement('button');
    moreBtn.id = 'tl-more';
    moreBtn.className = 'tl-chip';
    moreBtn.setAttribute('data-label', 'More');
    moreBtn.setAttribute('aria-label', 'More options');
    panel = document.createElement('div');
    panel.id = 'tl-more-panel';
    document.body.appendChild(panel);
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); panel.classList.toggle('open'); });
    panel.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') panel.classList.remove('open'); });
    document.addEventListener('click', (e) => {
      if (panel.classList.contains('open') && !panel.contains(e.target) && e.target !== moreBtn) panel.classList.remove('open');
    });
  }

  function apply() {
    Object.keys(PRIMARY).forEach((id) => {
      const b = document.getElementById(id);
      if (b) { b.classList.add('tl-chip'); b.setAttribute('data-label', PRIMARY[id]); }
    });
    SECONDARY.forEach((id) => {
      const b = document.getElementById(id);
      if (b && b.parentElement !== panel) { b.classList.remove('tl-chip'); panel.appendChild(b); }
    });
    const desired = PRIMARY_ORDER.map((id) => document.getElementById(id)).filter(Boolean);
    desired.push(moreBtn);
    const cur = Array.prototype.slice.call(bar.children);
    let needReorder = cur.length !== desired.length;
    if (!needReorder) { for (let i = 0; i < desired.length; i++) { if (cur[i] !== desired[i]) { needReorder = true; break; } } }
    if (needReorder) desired.forEach((el) => bar.appendChild(el));
  }
  apply();
  new MutationObserver(apply).observe(bar, { childList: true });
}

async function init() {
  const t0 = Date.now();   // page-load reference for the minimum splash time
  const cameraOK = await startCamera();
  if (!cameraOK) return;
  const orientationOK = await startOrientation();
  if (!orientationOK) {
    document.getElementById('loading-overlay').querySelector('p:last-child').textContent =
      'Motion sensors not available. AR requires a mobile device.';
    return;
  }
  createARScene();   // build the scene behind the splash so it's ready when revealed
  // Keep the intro / browser-tips splash up for at least a few seconds so it's
  // readable (on fast devices with permissions already granted it used to flash by).
  const MIN_INTRO_MS = 3500;
  const remaining = Math.max(0, MIN_INTRO_MS - (Date.now() - t0));
  setTimeout(() => {
    document.getElementById('loading-overlay').classList.add('hidden');
    setTimeout(() => { setupCalibration(); }, 500);
  }, remaining);
}

init();

/* Keep the screen awake during the AR experience (event QoL) */
(() => {
  let wakeLock = null;
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* wake lock unavailable or denied — safe to ignore */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
  requestWakeLock();
})();

/* Desktop / non-mobile fallback: AR needs a phone with motion sensors. */
(() => {
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints || 0) > 1;
  if (!isMobile) document.getElementById('ar-fallback')?.classList.remove('hidden');
})();
