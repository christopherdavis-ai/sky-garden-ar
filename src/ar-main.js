import * as THREE from 'three';
import clients from './data/clients.json';
import banks from './data/banks.json';

// ============================================
// Sky Garden AR Experience â€” TrueLayer v3
// Organic flocking particles + test mode
// ============================================

const SKY_GARDEN = { lat: 51.511398, lng: -0.083507, alt: 155 };
const SHARD_BEARING = 195;
const SMOOTH_FACTOR = 0.08;

let compassOffset = 0;
let calibrated = false;
let testMode = false;
let currentHeading = 0;
let smoothedAlpha = 0;
let smoothedBeta = 90;
let smoothedGamma = 0;
let smoothedHeading = 0;
let deviceAlpha = 0;
let deviceBeta = 90;
let deviceGamma = 0;

// --- Geo Utilities ---
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
  if (testMode) return 1.0; // Test mode: everything visible
  let diff = Math.abs(beamBearing - cameraHeading);
  if (diff > 180) diff = 360 - diff;
  if (diff <= 80) return 1.0;
  if (diff <= 110) return 1.0 - (diff - 80) / 30;
  return 0;
}

function lerpAngle(current, target, factor) {
  let diff = target - current;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (current + diff * factor + 360) % 360;
}

function lerp(current, target, factor) {
  return current + (target - current) * factor;
}

// --- Badge texture ---
function makeBadge(txt, fill, emoji = '') {
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
  ctx.fillText(`${emoji}${txt}`, 128, 96);
  return new THREE.CanvasTexture(c);
}

// --- Organic Flocking Payment Flow ---
function createARFlow(pointA, pointB, colorA, colorB, scene) {
  const mid = pointA.clone().lerp(pointB, 0.5).add(new THREE.Vector3(0, 18, 0));
  const curve = new THREE.CatmullRomCurve3([pointA, mid, pointB]);
  const count = 180;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c1 = new THREE.Color(colorA);
  const c2 = new THREE.Color(colorB);

  const seeds = [];
  for (let i = 0; i < count; i++) {
    const p = curve.getPoint(i / count);
    pos.set([p.x, p.y, p.z], i * 3);
    const blend = i / count;
    const c = c1.clone().lerp(c2, blend);
    col.set([c.r, c.g, c.b], i * 3);
    seeds.push({
      sx: Math.random() * 100,
      sy: Math.random() * 100,
      sz: Math.random() * 100,
      freqX: 0.3 + Math.random() * 0.7,
      freqY: 0.2 + Math.random() * 0.5,
      freqZ: 0.3 + Math.random() * 0.7,
      spread: 1.5 + Math.random() * 4,
      speedMult: 0.7 + Math.random() * 0.6
    });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const layers = [];
  const layerConfigs = [
    { size: 1.0, opacity: 0.35 },
    { size: 2.2, opacity: 0.5 },
    { size: 4.0, opacity: 0.25 }
  ];

  layerConfigs.forEach((cfg) => {
    const layerG = new THREE.BufferGeometry();
    layerG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    layerG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const m = new THREE.PointsMaterial({
      size: cfg.size, vertexColors: true, transparent: true, opacity: cfg.opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    const pts = new THREE.Points(layerG, m);
    scene.add(pts);
    layers.push(pts);
  });

  return { curve, layers, count, seeds, speed: 0.025 + Math.random() * 0.02, offset: Math.random() };
}

// --- Camera Setup ---
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
    console.error('Camera error:', err);
    document.getElementById('loading-overlay').querySelector('p:last-child').textContent =
      'Camera access denied. Please allow camera access and reload.';
    return false;
  }
}

// --- Device Orientation ---
function handleOrientation(e) {
  deviceAlpha = e.alpha || 0;
  deviceBeta = e.beta || 90;
  deviceGamma = e.gamma || 0;
  if (e.webkitCompassHeading !== undefined) {
    currentHeading = e.webkitCompassHeading;
  } else if (e.alpha !== null) {
    currentHeading = (360 - e.alpha) % 360;
  }
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
            window.addEventListener('deviceorientation', handleOrientation, true);
            iosOverlay.classList.add('hidden');
            resolve(true);
          } else { resolve(false); }
        } catch (err) { resolve(false); }
      });
    });
  } else {
    window.addEventListener('deviceorientation', handleOrientation, true);
    return true;
  }
}

// --- Calibration ---
function setupCalibration() {
  const overlay = document.getElementById('calibration-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('calibrate-btn').addEventListener('click', () => {
    compassOffset = SHARD_BEARING - currentHeading;
    calibrated = true;
    overlay.classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('test-btn').classList.remove('hidden');
    document.getElementById('recalibrate-btn').classList.remove('hidden');
  });
}

// --- Three.js AR Scene ---
function createARScene() {
  const canvas = document.getElementById('ar-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const beamEntries = [];
  const flowEmitters = [];

  // Test mode toggle
  const testBtn = document.getElementById('test-btn');
  const hudMode = document.getElementById('hud-mode');
  testBtn.addEventListener('click', () => {
    testMode = !testMode;
    testBtn.textContent = testMode ? 'âœ… Test Mode ON' : 'ðŸ”§ Test Mode';
    testBtn.classList.toggle('active', testMode);
    hudMode.textContent = testMode ? 'MODE: TEST (all visible)' : '';
  });

  // Recalibrate button
  document.getElementById('recalibrate-btn').addEventListener('click', () => {
    compassOffset = SHARD_BEARING - currentHeading;
  });

  // TrueLayer world position
  const tlClient = clients.find(c => c.name === 'TrueLayer');
  const tlBearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng);
  const tlDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng));
  const tlBearingRad = tlBearing * Math.PI / 180;
  const tlWorldPos = new THREE.Vector3(
    Math.sin(tlBearingRad) * tlDist, -8, -Math.cos(tlBearingRad) * tlDist
  );

  // --- Clients ---
  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(distance);
    const isTL = client.name === 'TrueLayer';
    const h = isTL ? 80 : 40;
    const group = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 1 : 0.5, isTL ? 1 : 0.5, h, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 2 : 1, isTL ? 2 : 1, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    glow.position.y = h / 2;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 2.5 : 1.2, isTL ? 4 : 2, 32),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, side: THREE.DoubleSide, transparent: true, opacity: 0.7
      })
    );
    ring.rotation.x = -Math.PI / 2;

    const badgeTex = makeBadge(client.initials, client.beamColor);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(isTL ? 12 : 6, isTL ? 9 : 4.5, 1);
    sprite.position.y = h + 3;

    if (client.logo) {
      const texLoader = new THREE.TextureLoader();
      texLoader.load(client.logo, (logoTex) => {
        logoTex.colorSpace = THREE.SRGBColorSpace;
        spriteMat.map = logoTex;
        spriteMat.needsUpdate = true;
        const img = logoTex.image;
        const aspect = img.width / img.height;
        const logoH = isTL ? 16 : 6;
        sprite.scale.set(logoH * aspect, logoH, 1);
      }, undefined, () => {});
    }

    const particles = new THREE.Group();
    const particleData = [];
    const pCount = isTL ? 30 : 14;
    for (let i = 0; i < pCount; i++) {
      const p = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 4, 4),
        new THREE.MeshBasicMaterial({
          color: client.beamColor, transparent: true, opacity: 0.7,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      particleData.push({
        mesh: p, speed: 0.015 + Math.random() * 0.025,
        radius: 0.8 + Math.random() * 2, phase: Math.random() * Math.PI * 2,
        twist: 2 + Math.random() * 4, yPos: Math.random(),
        dir: Math.random() > 0.5 ? 1 : -1
      });
      particles.add(p);
    }

    group.add(beam, glow, ring, sprite, particles);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, -8, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring, sprite, particleData, isTL, h });

    if (!isTL) {
      const clientWorldPos = group.position.clone();
      const tlFlowStart = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
      const clientFlowEnd = clientWorldPos.clone().add(new THREE.Vector3(0, 8, 0));
      flowEmitters.push(createARFlow(tlFlowStart, clientFlowEnd, '#8b5cf6', '#2dd4bf', scene));
    }
  });

  // --- Banks ---
  banks.forEach((bank) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const sceneDist = scaleDistance(distance);
    const h = 28;
    const group = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, h, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#4dabff', transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.8, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#4dabff', transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    glow.position.y = h / 2;

    const badge = makeBadge(bank.initials, '#3f7dff', 'ðŸ¦');
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: badge, transparent: true, depthWrite: false })
    );
    sprite.scale.set(5, 3.5, 1);
    sprite.position.y = h + 3;

    group.add(beam, glow, sprite);
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(Math.sin(bearingRad) * sceneDist, -8, -Math.cos(bearingRad) * sceneDist);
    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring: null, sprite, particleData: null, isTL: false, h });

    const bankWorldPos = group.position.clone();
    const bankFlowStart = bankWorldPos.clone().add(new THREE.Vector3(0, 5, 0));
    const tlFlowEnd = tlWorldPos.clone().add(new THREE.Vector3(0, 15 + Math.random() * 50, 0));
    flowEmitters.push(createARFlow(bankFlowStart, tlFlowEnd, '#d6ecff', '#5bb4ff', scene));
  });

  // --- Animation Loop ---
  const hudHeading = document.getElementById('hud-heading');
  const hudBeams = document.getElementById('hud-beams');

  function animate() {
    requestAnimationFrame(animate);
    if (!calibrated) { renderer.render(scene, camera); return; }

    const t = performance.now() * 0.001;

    smoothedAlpha = lerpAngle(smoothedAlpha, deviceAlpha, SMOOTH_FACTOR);
    smoothedBeta = lerp(smoothedBeta, deviceBeta, SMOOTH_FACTOR);
    smoothedGamma = lerp(smoothedGamma, deviceGamma, SMOOTH_FACTOR);
    smoothedHeading = lerpAngle(smoothedHeading, currentHeading, SMOOTH_FACTOR);

    const adjustedHeading = (smoothedHeading + compassOffset + 360) % 360;

    const alpha = smoothedAlpha * (Math.PI / 180);
    const beta = smoothedBeta * (Math.PI / 180);
    const gamma = smoothedGamma * (Math.PI / 180);
    const adjustedAlpha = alpha + compassOffset * (Math.PI / 180);
    const euler = new THREE.Euler(beta - Math.PI / 2, adjustedAlpha, -gamma, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    let visibleCount = 0;
    beamEntries.forEach((b, i) => {
      const fade = getHemisphereFade(b.bearing, adjustedHeading);
      b.group.visible = fade > 0.01;
      if (!b.group.visible) return;
      visibleCount++;

      b.beam.material.opacity = fade * (b.isTL ? 0.6 : 0.5);
      b.glow.material.opacity = fade * 0.25;
      b.sprite.material.opacity = fade;
      if (b.ring) b.ring.material.opacity = fade * 0.7;

      const pulse = 1 + Math.sin(t * 1.7 + i * 0.3) * 0.08;
      b.beam.scale.set(pulse, 1, pulse);
      b.glow.scale.set(pulse * 1.1, 1, pulse * 1.1);
      b.sprite.position.y = b.h + 3 + Math.sin(t * 1.5 + i * 0.5) * 0.8;

      if (b.particleData) {
        b.particleData.forEach((pd) => {
          pd.yPos += pd.speed * pd.dir * 0.016;
          if (pd.yPos > 1) { pd.yPos = 1; pd.dir = -1; }
          if (pd.yPos < 0) { pd.yPos = 0; pd.dir = 1; }
          const y = pd.yPos * b.h;
          const angle = pd.phase + pd.twist * pd.yPos + t * 0.3;
          pd.mesh.position.set(Math.cos(angle) * pd.radius, y, Math.sin(angle) * pd.radius);
          pd.mesh.material.opacity = fade * (0.4 + Math.sin(t * 2 + pd.phase) * 0.3);
        });
      }
    });

    // Animate organic flocking flows
    flowEmitters.forEach((f) => {
      f.layers.forEach((layer) => {
        const arr = layer.geometry.attributes.position.array;
        for (let i = 0; i < f.count; i++) {
          const u = (i / f.count + t * f.speed * f.seeds[i].speedMult + f.offset) % 1;
          const p = f.curve.getPoint(u);
          const s = f.seeds[i];
          const turbX = Math.sin(t * s.freqX + s.sx) * Math.cos(t * 0.4 + s.sy) * s.spread;
          const turbY = Math.sin(t * s.freqY + s.sy) * Math.cos(t * 0.35 + s.sz) * s.spread * 0.4;
          const turbZ = Math.cos(t * s.freqZ + s.sz) * Math.sin(t * 0.45 + s.sx) * s.spread;
          const swirl = t * 0.8 + i * 0.15;
          const swirlR = s.spread * 0.3;
          arr[i * 3] = p.x + turbX + Math.cos(swirl) * swirlR;
          arr[i * 3 + 1] = p.y + turbY;
          arr[i * 3 + 2] = p.z + turbZ + Math.sin(swirl) * swirlR;
        }
        layer.geometry.attributes.position.needsUpdate = true;
      });
    });

    hudHeading.textContent = `Heading: ${adjustedHeading.toFixed(0)}\u00B0`;
    hudBeams.textContent = `Beams visible: ${visibleCount}`;
    renderer.render(scene, camera);
  }

  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// --- Init ---
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
