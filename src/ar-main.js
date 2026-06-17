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

// Particle-flow density by tier (more particles = more apparent payment volume).
// Star clients and banks read as high-volume; regular clients are lighter.
const FLOW_PARTICLES_STAR = 26;
const FLOW_PARTICLES_BANK = 26;   // <- set to 8 if you want banks lighter like regular clients
const FLOW_PARTICLES_CLIENT = 12;

// Branded photo frame text (easy to edit / swap for the party later)
const FRAME_TITLE = 'TrueLayer \u00b7 Sky Garden';
const FRAME_SUBTITLE = '';   // e.g. 'Summer Party 2026'

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
  'shard':        { name: 'The Shard',    lat: 51.5045, lng: -0.0865 },
  'tower-bridge': { name: 'Tower Bridge', lat: 51.5055, lng: -0.0754 },
  'gherkin':      { name: 'The Gherkin',  lat: 51.5145, lng: -0.0803 },
  'canary-wharf': { name: 'Canary Wharf', lat: 51.5049, lng: -0.0195 }
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

function createARFlow(pointA, pointB, colorA, colorB, scene, glowTex, count) {
  const mid = pointA.clone().lerp(pointB, 0.5).add(new THREE.Vector3(0, 18, 0));
  const curve = new THREE.CatmullRomCurve3([pointA, mid, pointB]);
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
      freqX: 0.2 + Math.random() * 0.4, freqY: 0.15 + Math.random() * 0.3,
      freqZ: 0.2 + Math.random() * 0.4, spread: 0.4 + Math.random() * 0.8,
      speedMult: 0.7 + Math.random() * 0.6
    });
  }
  const layers = [];
  // layers[0] = soft halo, layers[1] = bright core
  [{ size: 2.0, opacity: 0.14 }, { size: 0.85, opacity: 0.4 }].forEach((cfg) => {
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
  return { curve, layers, count, seeds, speed: 0.025 + Math.random() * 0.02, offset: Math.random(), bearing: 0 };
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
      f.layers[0].material.opacity = dayMode ? 0.5 : 0.2;    // keep soft halo visible (incl. day)
      f.layers[1].material.opacity = dayMode ? 0.95 : 0.55;  // opaque cores by day
    });
    if (latticeMat) {
      latticeMat.blending = dayMode ? norm : add;
      latticeMat.opacity = dayMode ? 0.18 : 0.06;
      latticeMat.color.set(dayMode ? '#2b6fd6' : '#6fb3ff');
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
  const CONFETTI_COLORS = ['#7C3AED', '#2dd4bf', '#ec4899', '#ffffff', '#5bb4ff', '#f59e0b'];
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
  const WATERMARK_SRC = (clients.find(c => c.name === 'TrueLayer') || {}).logo || '';
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

    // 3. branded frame: bottom gradient banner + title + thin border
    const bandH = Math.round(H * 0.14);
    const g = ctx.createLinearGradient(0, H - bandH, 0, H);
    g.addColorStop(0, 'rgba(10,8,25,0)');
    g.addColorStop(1, 'rgba(10,8,25,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - bandH, W, bandH);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    const titleSize = Math.round(H * 0.05);
    ctx.font = '700 ' + titleSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(FRAME_TITLE, Math.round(W * 0.04), H - Math.round(bandH * (FRAME_SUBTITLE ? 0.45 : 0.32)));
    if (FRAME_SUBTITLE) {
      const subSize = Math.round(H * 0.03);
      ctx.font = '400 ' + subSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fillText(FRAME_SUBTITLE, Math.round(W * 0.04), H - Math.round(bandH * 0.14));
    }

    const bw = Math.max(3, Math.round(W * 0.006));
    ctx.strokeStyle = 'rgba(77,59,216,0.9)';
    ctx.lineWidth = bw;
    ctx.strokeRect(bw / 2, bw / 2, W - bw, H - bw);

    // 4. corner watermark logo on a clean rounded card (bottom-right)
    if (watermarkReady) {
      const pad = Math.round(W * 0.03);
      const cardW = Math.round(W * 0.18);
      const innerPad = cardW * 0.12;
      const aspect = (watermarkImg.naturalWidth / watermarkImg.naturalHeight) || 3;
      const logoW = cardW - innerPad * 2;
      const logoH = logoW / aspect;
      const cardH = logoH + innerPad * 2;
      const x = W - cardW - pad;
      const y = H - cardH - pad;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath();
      ctx.roundRect(x, y, cardW, cardH, cardW * 0.1);
      ctx.fill();
      ctx.drawImage(watermarkImg, x + innerPad, y + innerPad, logoW, logoH);
    }

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
  });

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
  const tlDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng));
  const tlBearingRad = tlBearing * Math.PI / 180;
  const tlWorldPos = new THREE.Vector3(Math.sin(tlBearingRad) * tlDist, -8, -Math.cos(tlBearingRad) * tlDist);

  const nodeWorldPositions = [];

  function buildBeam({ color, h, isTL, initials, logo, isStar, bearing, sceneDist, isBank }) {
    const group = new THREE.Group();
    const phase = Math.random();

    const beamMat = makeBeamMaterial(color, phase);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 1 : 0.6, isTL ? 1 : 0.6, h, 16, 1, true),
      beamMat
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 2 : 1.1, isTL ? 2 : 1.1, h * 1.05, 16, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = h / 2;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 2.2 : 1.1, isTL ? 3.4 : 1.9, 32),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;

    const badgeTex = makeBadge(initials, color);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteH = isTL ? 9 : (isStar ? 6 : (isBank ? 6 : 4.5));
    sprite.scale.set(spriteH * 1.33, spriteH, 1);
    sprite.position.y = h + 3;
    sprite.userData.baseY = h + 3;
    if (logo) loadLogo(logo, spriteMat, sprite, isTL ? 16 : (isStar || isBank ? 9 : 6));

    group.add(beam, glow, ring, sprite);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, -8, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, beam, bearing, beamMat, glow, ring, sprite, phase, h, isTL, baseColor: new THREE.Color(color) });
    return group;
  }

  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng));
    const isTL = client.name === 'TrueLayer';
    const isStar = client.tier === 'star';
    const h = arHeight(client.tier, client.name);

    const group = buildBeam({
      color: client.beamColor, h, isTL, initials: client.initials,
      logo: client.logo, isStar, bearing, sceneDist, isBank: false
    });

    if (!isTL) {
      const clientWorldPos = group.position.clone();
      nodeWorldPositions.push(clientWorldPos.clone());
      const tlFlowStart = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
      const clientFlowEnd = clientWorldPos.clone().add(new THREE.Vector3(0, 8, 0));
      const count = isStar ? FLOW_PARTICLES_STAR : FLOW_PARTICLES_CLIENT;
      const flow = createARFlow(tlFlowStart, clientFlowEnd, '#8b5cf6', '#2dd4bf', scene, glowTex, count);
      flow.bearing = bearing;
      flowEmitters.push(flow);
    }
  });

  banks.forEach((bank) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const sceneDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng));
    const h = arHeight('bank', bank.name);

    const group = buildBeam({
      color: '#4dabff', h, isTL: false, initials: bank.initials,
      logo: bank.logo, isStar: false, bearing, sceneDist, isBank: true
    });

    const bankWorldPos = group.position.clone();
    nodeWorldPositions.push(bankWorldPos.clone());
    const bankFlowStart = bankWorldPos.clone().add(new THREE.Vector3(0, 5, 0));
    const tlFlowEnd = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
    const flow = createARFlow(bankFlowStart, tlFlowEnd, '#d6ecff', '#5bb4ff', scene, glowTex, FLOW_PARTICLES_BANK);
    flow.bearing = bearing;
    flowEmitters.push(flow);
  });

  /* -- LATTICE: curved, height-varied web from every node toward TrueLayer -- */
  const LATTICE_SEG = 18;
  const linePos = [];
  nodeWorldPositions.forEach((p) => {
    const hub = tlWorldPos.clone().add(new THREE.Vector3(
      (Math.random() - 0.5) * 16,
      20 + Math.random() * 55,
      (Math.random() - 0.5) * 16
    ));
    const end = p.clone().add(new THREE.Vector3(
      (Math.random() - 0.5) * 4,
      10 + Math.random() * 45,
      (Math.random() - 0.5) * 4
    ));
    const mid = hub.clone().lerp(end, 0.5).add(new THREE.Vector3(
      (Math.random() - 0.5) * 24,
      12 + Math.random() * 40,
      (Math.random() - 0.5) * 24
    ));
    const curve = new THREE.QuadraticBezierCurve3(hub, mid, end);
    let prev = curve.getPoint(0);
    for (let s = 1; s <= LATTICE_SEG; s++) {
      const cur = curve.getPoint(s / LATTICE_SEG);
      linePos.push(prev.x, prev.y, prev.z, cur.x, cur.y, cur.z);
      prev = cur;
    }
  });
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
  latticeMat = new THREE.LineBasicMaterial({
    color: '#6fb3ff', transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false
  });
  const lattice = new THREE.LineSegments(lineGeo, latticeMat);
  scene.add(lattice);

  applyRenderMode();   // initialise materials for the current (night) mode

  const hudHeading = document.getElementById('hud-heading');
  const hudBeams = document.getElementById('hud-beams');

  const rawQuat = new THREE.Quaternion();
  const smoothQuat = new THREE.Quaternion();
  let quatReady = false;
  const camEuler = new THREE.Euler();

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
    const adjustedHeading = (smoothedHeading + compassOffset + 360) % 360;
    window.__skyHeading = adjustedHeading;

    const alphaRad = (deviceAlpha * Math.PI / 180) + (compassOffset * Math.PI / 180);
    const betaRad = deviceBeta * Math.PI / 180;
    const gammaRad = deviceGamma * Math.PI / 180;
    const screenOrient = getScreenOrientation();

    getDeviceQuaternion(rawQuat, alphaRad, betaRad, gammaRad, screenOrient);
    if (!quatReady) { smoothQuat.copy(rawQuat); quatReady = true; }
    else { smoothQuat.slerp(rawQuat, SMOOTH_FACTOR); }
    camera.quaternion.copy(smoothQuat);

    camEuler.setFromQuaternion(smoothQuat, 'YXZ');
    const counterRoll = -camEuler.z;

    let visibleCount = 0;
    beamEntries.forEach((b, i) => {
      const fade = getHemisphereFade(b.bearing, adjustedHeading);
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
      const fade = getHemisphereFade(f.bearing, adjustedHeading);
      const vis = fade > 0.01;
      f.layers.forEach((layer) => { layer.visible = vis && (layer.material.opacity > 0.001); });
      if (!vis) return;
      f.layers.forEach((layer) => {
        const arr = layer.geometry.attributes.position.array;
        for (let i = 0; i < f.count; i++) {
          const u = (i / f.count + t * f.speed * f.seeds[i].speedMult + f.offset) % 1;
          const p = f.curve.getPoint(u);
          const s = f.seeds[i];
          arr[i * 3] = p.x + Math.sin(t * s.freqX + s.sx) * s.spread;
          arr[i * 3 + 1] = p.y + Math.sin(t * s.freqY + s.sy) * s.spread * 0.3;
          arr[i * 3 + 2] = p.z + Math.cos(t * s.freqZ + s.sz) * s.spread;
        }
        layer.geometry.attributes.position.needsUpdate = true;
      });
    });

    hudHeading.textContent = 'Heading: ' + adjustedHeading.toFixed(0) + String.fromCharCode(176) +
      (usingAbsolute ? ' [abs]' : ' [rel]') + (dayMode ? ' \u2600' : ' \u263e');
    hudBeams.textContent = 'Beams visible: ' + visibleCount;
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
  window.addEventListener('orientationchange', () => setTimeout(handleResize, 200));
}

function setupControlBar() {
  const bar = document.getElementById('ar-controls');
  if (!bar) return;
  const PRIMARY = { 'disco-btn': 'Disco', 'snap-btn': 'Snap', 'q-launch': 'Quest', 'q-booth': 'Photo Booth' };
  const PRIMARY_ORDER = ['disco-btn', 'snap-btn', 'q-launch', 'q-booth'];
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
  const cameraOK = await startCamera();
  if (!cameraOK) return;
  const orientationOK = await startOrientation();
  if (!orientationOK) {
    document.getElementById('loading-overlay').querySelector('p:last-child').textContent =
      'Motion sensors not available. AR requires a mobile device.';
    return;
  }
  document.getElementById('loading-overlay').classList.add('hidden');
  setTimeout(() => { setupCalibration(); }, 500);
  createARScene();
}

init();
