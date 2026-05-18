import * as THREE from 'three';
import clients from './data/clients.json';
import banks from './data/banks.json';

// ============================================
// Sky Garden AR Experience â€” TrueLayer
// Pure Three.js + Camera + Compass
// ============================================

// --- Constants ---
const SKY_GARDEN = { lat: 51.511398, lng: -0.083507, alt: 155 };
const SHARD_BEARING = 195; // Known bearing from Sky Garden to The Shard

// --- State ---
let compassOffset = 0;
let calibrated = false;
let currentHeading = 0;
let deviceAlpha = 0;
let deviceBeta = 90;
let deviceGamma = 0;
let orientationAvailable = false;

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
  // Logarithmic scale so nearby and far clients are all visible
  // 300m â†’ ~50, 2km â†’ ~120, 10km â†’ ~200, 50km â†’ ~300
  return 30 + Math.log10(meters / 100 + 1) * 100;
}

function getHemisphereFade(beamBearing, cameraHeading) {
  let diff = Math.abs(beamBearing - cameraHeading);
  if (diff > 180) diff = 360 - diff;
  if (diff <= 80) return 1.0;       // Fully visible
  if (diff <= 110) return 1.0 - (diff - 80) / 30;  // Fade out
  return 0;                          // Hidden (behind you)
}

// --- Badge texture (same as map version) ---
function makeBadge(txt, fill, emoji = '') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 192;
  const ctx = c.getContext('2d');
  // Background
  ctx.fillStyle = fill;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.roundRect(16, 16, 224, 160, 16);
  ctx.fill();
  ctx.globalAlpha = 1;
  // Border
  ctx.strokeStyle = '#ffffffcc';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(16, 16, 224, 160, 16);
  ctx.stroke();
  // Text
  ctx.fillStyle = '#fff';
  ctx.font = '700 36px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${emoji}${txt}`, 128, 96);
  return new THREE.CanvasTexture(c);
}

// --- Camera Setup ---
async function startCamera() {
  const video = document.getElementById('camera-feed');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
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
  orientationAvailable = true;
  deviceAlpha = e.alpha || 0;
  deviceBeta = e.beta || 90;
  deviceGamma = e.gamma || 0;

  // Get compass heading
  if (e.webkitCompassHeading !== undefined) {
    // iOS: webkitCompassHeading is degrees from north (0-360)
    currentHeading = e.webkitCompassHeading;
  } else if (e.alpha !== null) {
    // Android: alpha is rotation around z-axis
    currentHeading = (360 - e.alpha) % 360;
  }
}

async function startOrientation() {
  // iOS 13+ requires permission
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    // Show iOS permission button
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
          } else {
            resolve(false);
          }
        } catch (err) {
          console.error('Orientation permission error:', err);
          resolve(false);
        }
      });
    });
  } else {
    // Android / non-iOS: just listen
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
    console.log(`Calibrated! Heading: ${currentHeading.toFixed(1)}Â°, Offset: ${compassOffset.toFixed(1)}Â°`);
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
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  // --- Build beams ---
  const beamEntries = [];

  // Process clients
  clients.forEach((client) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, client.lat, client.lng);
    const sceneDist = scaleDistance(distance);
    const isTL = client.name === 'TrueLayer';
    const h = isTL ? 50 : 25;

    const group = new THREE.Group();

    // Beam cylinder
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 0.5 : 0.3, isTL ? 0.5 : 0.3, h, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    beam.position.y = h / 2;

    // Glow cylinder
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(isTL ? 1 : 0.6, isTL ? 1 : 0.6, h * 1.05, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    glow.position.y = h / 2;

    // Ground ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(isTL ? 1.5 : 0.8, isTL ? 2.5 : 1.3, 32),
      new THREE.MeshBasicMaterial({
        color: client.beamColor, side: THREE.DoubleSide,
        transparent: true, opacity: 0.7
      })
    );
    ring.rotation.x = -Math.PI / 2;

    // Label sprite
    const badgeTex = makeBadge(client.initials, client.beamColor);
    const spriteMat = new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(isTL ? 8 : 4, isTL ? 6 : 3, 1);
    sprite.position.y = h + 2;

    // Load logo if available
    if (client.logo) {
      const texLoader = new THREE.TextureLoader();
      texLoader.load(client.logo, (logoTex) => {
        logoTex.colorSpace = THREE.SRGBColorSpace;
        spriteMat.map = logoTex;
        spriteMat.needsUpdate = true;
        const img = logoTex.image;
        const aspect = img.width / img.height;
        const logoH = isTL ? 10 : 4;
        sprite.scale.set(logoH * aspect, logoH, 1);
      }, undefined, () => {});
    }

    // Beam particles (twisting cables)
    const particles = new THREE.Group();
    const particleData = [];
    const pCount = isTL ? 24 : 12;
    for (let i = 0; i < pCount; i++) {
      const p = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 4, 4),
        new THREE.MeshBasicMaterial({
          color: client.beamColor, transparent: true, opacity: 0.7,
          blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      particleData.push({
        mesh: p,
        speed: 0.015 + Math.random() * 0.025,
        radius: 0.5 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
        twist: 2 + Math.random() * 4,
        yPos: Math.random(),
        dir: Math.random() > 0.5 ? 1 : -1
      });
      particles.add(p);
    }

    group.add(beam, glow, ring, sprite, particles);

    // Position beam in world using bearing + distance
    const bearingRad = bearing * Math.PI / 180;
    group.position.set(
      Math.sin(bearingRad) * sceneDist,
      -8,
      -Math.cos(bearingRad) * sceneDist
    );

    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring, sprite, particleData, isTL, h });
  });

  // Process banks
  banks.forEach((bank) => {
    const bearing = getBearing(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const distance = getDistance(SKY_GARDEN.lat, SKY_GARDEN.lng, bank.lat, bank.lng);
    const sceneDist = scaleDistance(distance);
    const h = 18;

    const group = new THREE.Group();

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, h, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: '#4dabff', transparent: true, opacity: 0.4,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    beam.position.y = h / 2;

    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, h * 1.05, 12, 1, true),
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
    sprite.scale.set(3.5, 2.5, 1);
    sprite.position.y = h + 2;

    group.add(beam, glow, sprite);

    const bearingRad = bearing * Math.PI / 180;
    group.position.set(
      Math.sin(bearingRad) * sceneDist,
      -8,
      -Math.cos(bearingRad) * sceneDist
    );

    scene.add(group);
    beamEntries.push({ group, bearing, beam, glow, ring: null, sprite, particleData: null, isTL: false, h });
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
    const adjustedHeading = (currentHeading + compassOffset + 360) % 360;

    // --- Camera rotation from device orientation ---
    // Convert device orientation to Three.js camera quaternion
    // Phone in portrait mode, landscape-primary screen orientation
    const alpha = deviceAlpha * (Math.PI / 180); // compass
    const beta = deviceBeta * (Math.PI / 180);   // tilt front/back
    const gamma = deviceGamma * (Math.PI / 180); // tilt left/right

    // Build quaternion from device orientation
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();

    // Adjust for compass offset
    const adjustedAlpha = alpha + compassOffset * (Math.PI / 180);

    // Device orientation to Three.js mapping (portrait mode)
    euler.set(beta - Math.PI / 2, adjustedAlpha, -gamma, 'YXZ');
    q.setFromEuler(euler);

    // Apply screen orientation compensation
    const screenQ = new THREE.Quaternion();
    screenQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0);
    q.multiply(screenQ);

    camera.quaternion.copy(q);

    // --- Hemisphere fade + animations ---
    let visibleCount = 0;

    beamEntries.forEach((b, i) => {
      const fade = getHemisphereFade(b.bearing, adjustedHeading);

      // Set visibility
      b.group.visible = fade > 0.01;
      if (!b.group.visible) return;

      visibleCount++;

      // Apply fade to materials
      b.beam.material.opacity = fade * (b.isTL ? 0.6 : 0.5);
      b.glow.material.opacity = fade * 0.2;
      b.sprite.material.opacity = fade;
      if (b.ring) b.ring.material.opacity = fade * 0.7;

      // Pulse animation
      const pulse = 1 + Math.sin(t * 1.7 + i * 0.3) * 0.08;
      b.beam.scale.set(pulse, 1, pulse);
      b.glow.scale.set(pulse * 1.1, 1, pulse * 1.1);

      // Sprite float
      b.sprite.position.y = b.h + 2 + Math.sin(t * 1.5 + i * 0.5) * 0.5;

      // Particles
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

    // Update HUD
    hudHeading.textContent = `Heading: ${adjustedHeading.toFixed(0)}Â°`;
    hudBeams.textContent = `Beams visible: ${visibleCount}`;

    renderer.render(scene, camera);
  }

  animate();

  // --- Handle resize ---
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// --- Init ---
async function init() {
  // Step 1: Start camera
  const cameraOK = await startCamera();
  if (!cameraOK) return;

  // Step 2: Start orientation sensors
  const orientationOK = await startOrientation();
  if (!orientationOK) {
    document.getElementById('loading-overlay').querySelector('p:last-child').textContent =
      'Motion sensors not available. AR requires a mobile device.';
    return;
  }

  // Step 3: Hide loading, show calibration
  document.getElementById('loading-overlay').classList.add('hidden');

  // Wait a moment for compass to stabilise
  setTimeout(() => {
    setupCalibration();
  }, 500);

  // Step 4: Create the 3D scene (beams exist but won't render until calibrated)
  createARScene();
}

init();
