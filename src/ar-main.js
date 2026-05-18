import * as THREE from 'three';
import clients from './data/clients.json';
import banks from './data/banks.json';

// ============================================
// Sky Garden AR Experience â€” TrueLayer v2
// Smoothed compass + bigger visuals + payment flows
// ============================================

// --- Constants ---
const SKY_GARDEN = { lat: 51.511398, lng: -0.083507, alt: 155 };
const SHARD_BEARING = 195;
const SMOOTH_FACTOR = 0.08; // Lower = smoother, higher = more responsive

// --- State ---
let compassOffset = 0;
let calibrated = false;
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
  let diff = Math.abs(beamBearing - cameraHeading);
  if (diff > 180) diff = 360 - diff;
  if (diff <= 80) return 1.0;
  if (diff <= 110) return 1.0 - (diff - 80) / 30;
  return 0;
}

// Smooth angle lerp (handles 0/360 wraparound)
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

// --- Payment flow between two points ---
function createARFlow(pointA, pointB, colorA, colorB, scene) {
  const mid = pointA.clone().lerp(pointB, 0.5).add(new THREE.Vector3(0, 15, 0));
  const curve = new THREE.CatmullRomCurve3([pointA, mid, pointB]);
  const count = 60;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c1 = new THREE.Color(colorA);
  const c2 = new THREE.Color(colorB);
  for (let i = 0; i < count; i++) {
    const p = curve.getPoint(i / count);
    pos.set([p.x, p.y, p.z], i * 3);
    const blend = i / count;
    const c = c1.clone().lerp(c2, blend);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 1.5, vertexColors: true, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  const pts = new THREE.Points(g, m);
  scene.add(pts);
  return { curve, points: pts, count, speed: 0.04 + Math.random() * 0.03, offset: Math.random() };
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

  // Find TrueLayer position for payment flows
  const tlClient = clients.find(c => c.name === 'TrueLayer');
  const tlBearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng);
  const tlDist = scaleDistance(getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, tlClient.lat, tlClient.lng));
  const tlBearingRad = tlBearing * Math.PI / 180;
  const tlWorldPos = new THREE.Vector3(
    Math.sin(tlBearingRad) * tlDist,
    -8,
    -Math.cos(tlBearingRad) * tlDist
  );

  // --- Process clients ---
  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(distance);
    const isTL = client.name === 'TrueLayer';
    const h = isTL ? 80 : 40;

    const group = new THREE.Group();

    // Beam - BIGGER
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 1 : 0.5, isTL ? 1 : 0.5, h, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    beam.position.y = h / 2;

    // Glow - BIGGER
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 2 : 1, isTL ? 2 : 1, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    glow.position.y = h / 2;

    // Ground ring - BIGGER
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 2.5 : 1.2, isTL ? 4 : 2, 32),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, side: THREE.DoubleSide,
        transparent: true, opacity: 0.7
      })
    );
    ring.rotation.x = -Math.PI / 2;

    // Label sprite - BIGGER
    const badgeTex = makeBadge(client.initials, client.beamColor);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(isTL ? 12 : 6, isTL ? 9 : 4.5, 1);
    sprite.position.y = h + 3;

    // Logo
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

    // Particles - BIGGER
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
        mesh: p,
        speed: 0.015 + Math.random() * 0.025,
        radius: 0.8 + Math.random() * 2,
        phase: Math.random() * Math.PI * 2,
        twist: 2 + Math.random() * 4,
        yPos: Math.random(),
        dir: Math.random() > 0.5 ? 1 : -1
      });
      particles.add(p);
    }

    group.add(beam, glow, ring, sprite, particles);

    const bearingRad = bearing * Math.PI / 180;
    group.position.set(
      Math.sin(bearingRad) * sceneDist,
      -8,
      -Math.cos(bearingRad) * sceneDist
    );

    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring, sprite, particleData, isTL, h });

    // Payment flow: TrueLayer â†’ Client (skip TrueLayer itself)
    if (!isTL) {
      const clientWorldPos = group.position.clone();
      const tlFlowStart = tlWorldPos.clone().add(new THREE.Vector3(0, 20 + Math.random() * 40, 0));
      const clientFlowEnd = clientWorldPos.clone().add(new THREE.Vector3(0, 10, 0));
      flowEmitters.push(createARFlow(tlFlowStart, clientFlowEnd, '#8b5cf6', '#2dd4bf', scene));
    }
  });

  // --- Process banks ---
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
    group.position.set(
      Math.sin(bearingRad) * sceneDist,
      -8,
      -Math.cos(bearingRad) * sceneDist
    );

    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring: null, sprite, particleData: null, isTL: false, h });

    // Payment flow: Bank â†’ TrueLayer
    const bankWorldPos = group.position.clone();
    const bankFlowStart = bankWorldPos.clone().add(new THREE.Vector3(0, 5, 0));
    const tlFlowEnd = tlWorldPos.clone().add(new THREE.Vector3(0, 20 + Math.random() * 40, 0));
    flowEmitters.push(createARFlow(bankFlowStart, tlFlowEnd, '#d6ecff', '#5bb4ff', scene));
  });

  // --- Animation Loop ---
  const hudHeading = document.getElementById('hud-heading');
  const hudBeams = document.getElementById('hud-beams');

  function animate() {
    requestAnimationFrame(animate);

    if (!calibrated) {
      renderer.render(scene, camera);
      return;
    }

    const t = performance.now() * 0.001;

    // Smooth orientation values
    smoothedAlpha = lerpAngle(smoothedAlpha, deviceAlpha, SMOOTH_FACTOR);
    smoothedBeta = lerp(smoothedBeta, deviceBeta, SMOOTH_FACTOR);
    smoothedGamma = lerp(smoothedGamma, deviceGamma, SMOOTH_FACTOR);
    smoothedHeading = lerpAngle(smoothedHeading, currentHeading, SMOOTH_FACTOR);

    const adjustedHeading = (smoothedHeading + compassOffset + 360) % 360;

    // Camera rotation from smoothed device orientation
    const alpha = smoothedAlpha * (Math.PI / 180);
    const beta = smoothedBeta * (Math.PI / 180);
    const gamma = smoothedGamma * (Math.PI / 180);
    const adjustedAlpha = alpha + compassOffset * (Math.PI / 180);

    const euler = new THREE.Euler(beta - Math.PI / 2, adjustedAlpha, -gamma, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    // Hemisphere fade + animations
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

    // Animate payment flows
    flowEmitters.forEach((f) => {
      const arr = f.points.geometry.attributes.position.array;
      for (let i = 0; i < f.count; i++) {
        const u = (i / f.count + t * f.speed + f.offset) % 1;
        const p = f.curve.getPoint(u);
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      f.points.geometry.attributes.position.needsUpdate = true;
    });

    hudHeading.textContent = `Heading: ${adjustedHeading.toFixed(0)}Â°`;
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
