import * as THREE from 'three';
import clients from './data/clients.json';
import banks from './data/banks.json';

const SKY_GARDEN = { lat: 51.511398, lng: -0.083507, alt: 155 };
const SHARD_BEARING = 195;
const SMOOTH_FACTOR = 0.12;

let compassOffset = 0;
let calibrated = false;
let testMode = false;
let currentHeading = 0;
let smoothedHeading = 0;
let deviceAlpha = 0;
let deviceBeta = 90;
let deviceGamma = 0;
let usingAbsolute = false;   // once an absolute (compass) reading arrives, ignore relative events

/* Landmarks for calibration — bearings computed at runtime via getBearing
   so they stay consistent with how beams are placed. */
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

/* signed smallest angle: positive = target is clockwise (turn right) */
function angularDiff(target, current) {
  let d = target - current;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/* Deterministic hash -> used for staggered client heights so logos don't overlap */
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); };

/* AR-scene beam height by tier (AR scene is much smaller than the map scene) */
function arHeight(tier, name) {
  if (tier === 'host') return 82;          // TrueLayer - hero
  if (tier === 'star' || tier === 'bank') return 64; // stars + banks: tallest tier
  return 30 + (hashStr(name) % 24);        // regular clients: varied 30-53
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

/* Particle sprite reuses ONE shared glow texture + tints via material.color */
function makeParticleSprite(color, size, sharedTex) {
  const mat = new THREE.SpriteMaterial({ map: sharedTex, color: new THREE.Color(color), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  return sprite;
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

function createARFlow(pointA, pointB, colorA, colorB, scene, glowTex) {
  const mid = pointA.clone().lerp(pointB, 0.5).add(new THREE.Vector3(0, 18, 0));
  const curve = new THREE.CatmullRomCurve3([pointA, mid, pointB]);
  const count = 50;
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
  [{ size: 2.0, opacity: 0.12 }, { size: 0.8, opacity: 0.35 }].forEach((cfg) => {
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

/* -- Quaternion-based device orientation (no gimbal lock) -- */
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

/* Shared reading applier - used by both event handlers */
function applyReading(e) {
  if (e.alpha == null && e.webkitCompassHeading == null) return;
  deviceAlpha = e.alpha || 0;
  deviceBeta = e.beta != null ? e.beta : 90;
  deviceGamma = e.gamma || 0;
  if (typeof e.webkitCompassHeading === 'number') {
    currentHeading = e.webkitCompassHeading;        // iOS Safari (true north)
  } else if (e.alpha != null) {
    currentHeading = (360 - e.alpha) % 360;          // Android compass
  }
}

function handleOrientationAbsolute(e) {
  if (e.alpha == null) return;
  usingAbsolute = true;
  applyReading(e);
}

function handleOrientationRelative(e) {
  if (usingAbsolute) return;        // absolute compass wins - never mix frames
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

/* -- Guided landmark calibration -- */
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
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const glowTex = createGlowTexture();
  const beamEntries = [];
  const flowEmitters = [];
  const allSprites = [];

  document.getElementById('exit-fs-btn').addEventListener('click', () => exitFullscreen());

  const testBtn = document.getElementById('test-btn');
  const hudMode = document.getElementById('hud-mode');
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

  document.getElementById('recalibrate-btn').addEventListener('click', () => {
    calibrated = false;
    setupCalibration();
  });

  document.getElementById('snap-btn').addEventListener('click', () => {
    hudMode.textContent = '\uD83D\uDCF8 Coming soon!';
    setTimeout(() => { if (!testMode) hudMode.textContent = ''; }, 1500);
  });

  const tlClient = clients.find(c => c.name === 'TrueLayer');
  const tlBearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng);
  const tlDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng));
  const tlBearingRad = tlBearing * Math.PI / 180;
  const tlWorldPos = new THREE.Vector3(Math.sin(tlBearingRad) * tlDist, -8, -Math.cos(tlBearingRad) * tlDist);

  /* -- CLIENT BEAMS -- */
  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(distance);
    const isTL = client.name === 'TrueLayer';
    const isStar = client.tier === 'star';
    const h = arHeight(client.tier, client.name);

    const group = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 1 : 0.5, isTL ? 1 : 0.5, h, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 2 : 1, isTL ? 2 : 1, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = h / 2;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 2.5 : 1.2, isTL ? 4 : 2, 32),
      new THREE.MeshBasicMaterial({ color: client.beamColor, side: THREE.DoubleSide, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = -Math.PI / 2;

    const badgeTex = makeBadge(client.initials, client.beamColor);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    const spriteH = isTL ? 9 : (isStar ? 6 : 4.5);
    sprite.scale.set(spriteH * 1.33, spriteH, 1);
    sprite.position.y = h + 3;
    sprite.userData.baseY = h + 3;
    allSprites.push(sprite);

    if (client.logo) loadLogo(client.logo, spriteMat, sprite, isTL ? 16 : (isStar ? 9 : 6));

    const particles = new THREE.Group();
    const particleData = [];
    const pCount = isTL ? 14 : (isStar ? 7 : 4);
    for (let i = 0; i < pCount; i++) {
      const size = 0.3 + Math.random() * 0.5;
      const p = makeParticleSprite(client.beamColor, size, glowTex);
      particleData.push({
        mesh: p, speed: 0.008 + Math.random() * 0.012,
        radius: 0.6 + Math.random() * 1.2, phase: Math.random() * Math.PI * 2,
        twist: 2 + Math.random() * 3, yPos: Math.random(),
        dir: Math.random() > 0.5 ? 1 : -1
      });
      particles.add(p);
    }

    group.add(beam, glow, ring, sprite, particles);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, -8, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring, sprite, particleData, isTL, h });

    if (!isTL && isStar) {
      const clientWorldPos = group.position.clone();
      const tlFlowStart = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
      const clientFlowEnd = clientWorldPos.clone().add(new THREE.Vector3(0, 8, 0));
      const flow = createARFlow(tlFlowStart, clientFlowEnd, '#8b5cf6', '#2dd4bf', scene, glowTex);
      flow.bearing = bearing;
      flowEmitters.push(flow);
    }
  });

  /* -- BANK BEAMS -- */
  banks.forEach((bank) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const sceneDist = scaleDistance(distance);
    const h = arHeight('bank', bank.name);
    const group = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, h, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: '#4dabff', transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: '#4dabff', transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.position.y = h / 2;

    const badgeTex = makeBadge(bank.initials, '#3f7dff');
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(8, 6, 1);
    sprite.position.y = h + 3;
    sprite.userData.baseY = h + 3;
    allSprites.push(sprite);

    if (bank.logo) loadLogo(bank.logo, spriteMat, sprite, 8);

    group.add(beam, glow, sprite);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, -8, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring: null, sprite, particleData: null, isTL: false, h });

    const bankWorldPos = group.position.clone();
    const bankFlowStart = bankWorldPos.clone().add(new THREE.Vector3(0, 5, 0));
    const tlFlowEnd = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
    const flow = createARFlow(bankFlowStart, tlFlowEnd, '#d6ecff', '#5bb4ff', scene, glowTex);
    flow.bearing = bearing;
    flowEmitters.push(flow);
  });

  const hudHeading = document.getElementById('hud-heading');
  const hudBeams = document.getElementById('hud-beams');

  const rawQuat = new THREE.Quaternion();
  const smoothQuat = new THREE.Quaternion();
  let quatReady = false;
  const camEuler = new THREE.Euler();

  function animate() {
    requestAnimationFrame(animate);
    if (!calibrated) { renderer.render(scene, camera); return; }

    const t = performance.now() * 0.001;

    smoothedHeading = lerpAngle(smoothedHeading, currentHeading, SMOOTH_FACTOR);
    const adjustedHeading = (smoothedHeading + compassOffset + 360) % 360;

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

      b.beam.material.opacity = fade * (b.isTL ? 0.6 : 0.5);
      b.glow.material.opacity = fade * 0.2;
      b.sprite.material.opacity = fade;
      if (b.ring) b.ring.material.opacity = fade * 0.7;

      b.sprite.material.rotation = counterRoll;
      b.sprite.position.y = b.sprite.userData.baseY + Math.sin(t * 1.1 + i * 0.7) * 1.2;

      const pulse = 1 + Math.sin(t * 1.2 + i * 0.3) * 0.05;
      b.beam.scale.set(pulse, 1, pulse);
      b.glow.scale.set(pulse * 1.05, 1, pulse * 1.05);

      if (b.particleData) {
        b.particleData.forEach((pd) => {
          pd.yPos += pd.speed * pd.dir * 0.016;
          if (pd.yPos > 1) { pd.yPos = 1; pd.dir = -1; }
          if (pd.yPos < 0) { pd.yPos = 0; pd.dir = 1; }
          const y = pd.yPos * b.h;
          const angle = pd.phase + pd.twist * pd.yPos + t * 0.2;
          pd.mesh.position.set(Math.cos(angle) * pd.radius, y, Math.sin(angle) * pd.radius);
          pd.mesh.material.opacity = fade * (0.25 + Math.sin(t * 1.5 + pd.phase) * 0.15);
        });
      }
    });

    flowEmitters.forEach((f) => {
      const fade = getHemisphereFade(f.bearing, adjustedHeading);
      const vis = fade > 0.01;
      f.layers.forEach((layer) => { layer.visible = vis; });
      if (!vis) return;
      f.layers.forEach((layer) => {
        const arr = layer.geometry.attributes.position.array;
        for (let i = 0; i < f.count; i++) {
          const u = (i / f.count + t * f.speed * f.seeds[i].speedMult + f.offset) % 1;
          const p = f.curve.getPoint(u);
          const s = f.seeds[i];
          const turbX = Math.sin(t * s.freqX + s.sx) * s.spread;
          const turbY = Math.sin(t * s.freqY + s.sy) * s.spread * 0.3;
          const turbZ = Math.cos(t * s.freqZ + s.sz) * s.spread;
          arr[i * 3] = p.x + turbX;
          arr[i * 3 + 1] = p.y + turbY;
          arr[i * 3 + 2] = p.z + turbZ;
        }
        layer.geometry.attributes.position.needsUpdate = true;
      });
    });

    hudHeading.textContent = 'Heading: ' + adjustedHeading.toFixed(0) + String.fromCharCode(176) +
      (usingAbsolute ? ' [abs]' : ' [rel]');
    hudBeams.textContent = 'Beams visible: ' + visibleCount;
    renderer.render(scene, camera);
  }

  animate();

  function handleResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', () => setTimeout(handleResize, 200));
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
