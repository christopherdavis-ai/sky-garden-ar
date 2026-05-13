import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import clients from './data/clients.json';
import { SKY_GARDEN_ORIGIN, VISUAL_DEFAULTS } from './config.js';
import { latLngToLocalXYZ } from './utils/geo.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(VISUAL_DEFAULTS.background);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 10000);
camera.position.set(0, 175, 360);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 30, 0);

scene.add(new THREE.AmbientLight(0x8aa2cc, 0.45));
const dir = new THREE.DirectionalLight(0x98bbff, 0.35);
dir.position.set(150, 220, 80);
scene.add(dir);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshStandardMaterial({ color: 0x070c16, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const grid = new THREE.GridHelper(2500, 70, 0x1b3047, 0x0f1f32);
grid.position.y = 0.2;
scene.add(grid);

const originRing = new THREE.Mesh(new THREE.RingGeometry(12, 18, 64), new THREE.MeshBasicMaterial({ color: 0x22ff88, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
originRing.rotation.x = -Math.PI / 2;
originRing.position.y = 0.4;
scene.add(originRing);

const beamObjects = [];
const list = document.getElementById('clientList');

function makeTextSprite(text, fill, size = 128) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff88'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `600 ${size * 0.32}px Inter`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
}

function makeNameLabel(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0009'; ctx.fillRect(0, 10, 512, 76);
  ctx.fillStyle = '#d9ecff'; ctx.font = '600 36px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 256, 48);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
}

for (const client of clients) {
  const local = latLngToLocalXYZ(client.lat, client.lng, SKY_GARDEN_ORIGIN);
  const group = new THREE.Group();
  group.position.set(local.x, 0, local.z);

  const beamMat = new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(VISUAL_DEFAULTS.beamRadius, VISUAL_DEFAULTS.beamRadius, VISUAL_DEFAULTS.beamHeight, 20, 1, true), beamMat);
  beam.position.y = VISUAL_DEFAULTS.beamHeight / 2;

  const glow = new THREE.Mesh(new THREE.CylinderGeometry(VISUAL_DEFAULTS.glowRadius, VISUAL_DEFAULTS.glowRadius, VISUAL_DEFAULTS.beamHeight * 1.05, 20, 1, true), new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.y = VISUAL_DEFAULTS.beamHeight / 2;

  const ring = new THREE.Mesh(new THREE.RingGeometry(7, 10.5, 32), new THREE.MeshBasicMaterial({ color: client.beamColor, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.4;

  const logo = makeTextSprite(client.initials, client.beamColor);
  logo.position.set(0, VISUAL_DEFAULTS.beamHeight + 12, 0);
  logo.scale.setScalar(14);

  const label = makeNameLabel(client.name);
  label.position.set(0, VISUAL_DEFAULTS.beamHeight + 25, 0);
  label.scale.set(45, 8, 1);

  const particles = new THREE.Group();
  for (let i = 0; i < VISUAL_DEFAULTS.particleCount; i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 8), new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.8 }));
    const angle = (i / VISUAL_DEFAULTS.particleCount) * Math.PI * 2;
    p.position.set(Math.cos(angle) * 11, 2 + Math.random() * 12, Math.sin(angle) * 11);
    particles.add(p);
  }

  group.add(beam, glow, ring, logo, label, particles);
  scene.add(group);
  beamObjects.push({ beam, glow, ring, logo, label, particles, baseHeight: VISUAL_DEFAULTS.beamHeight });

  const li = document.createElement('li');
  li.innerHTML = `<span class="swatch" style="background:${client.beamColor}"></span><span>${client.name}</span>`;
  list.appendChild(li);
}

const dayToggle = document.getElementById('dayToggle');
const beamHeightSlider = document.getElementById('beamHeight');
const beamRadiusSlider = document.getElementById('beamRadius');
const glowSlider = document.getElementById('glowStrength');

function applyBeamSettings() {
  const h = Number(beamHeightSlider.value);
  const r = Number(beamRadiusSlider.value);
  const g = Number(glowSlider.value);
  for (const o of beamObjects) {
    o.beam.geometry.dispose();
    o.glow.geometry.dispose();
    o.beam.geometry = new THREE.CylinderGeometry(r, r, h, 20, 1, true);
    o.glow.geometry = new THREE.CylinderGeometry(r * 1.6, r * 1.6, h * 1.05, 20, 1, true);
    o.beam.position.y = h / 2;
    o.glow.position.y = h / 2;
    o.logo.position.y = h + 12;
    o.label.position.y = h + 25;
    o.baseHeight = h;
    o.glow.material.opacity = g * 0.28;
  }
}
[beamHeightSlider, beamRadiusSlider, glowSlider].forEach((el) => el.addEventListener('input', applyBeamSettings));

dayToggle.addEventListener('change', () => {
  const day = dayToggle.checked;
  renderer.setClearColor(day ? '#95b6d7' : VISUAL_DEFAULTS.background);
  ground.material.color.set(day ? '#2e495f' : '#070c16');
  grid.material.color.set(day ? '#3f6d95' : '#1b3047');
});

const clock = new THREE.Clock();
function animate() {
  const t = clock.getElapsedTime();
  originRing.scale.setScalar(1 + Math.sin(t * 2.2) * 0.2);
  originRing.material.opacity = 0.55 + 0.25 * Math.sin(t * 2.2);

  for (const o of beamObjects) {
    const pulse = 1 + Math.sin(t * VISUAL_DEFAULTS.pulseSpeed + o.beam.position.x * 0.01) * 0.12;
    o.beam.scale.set(pulse, 1, pulse);
    o.glow.scale.set(pulse * 1.05, 1, pulse * 1.05);
    o.logo.position.y = o.baseHeight + 12 + Math.sin(t * 1.8 + o.logo.position.x) * VISUAL_DEFAULTS.bobHeight;
    o.particles.rotation.y += 0.01;
    o.particles.children.forEach((p, idx) => { p.position.y = 2 + (idx % 7) + Math.sin(t * 2 + idx) * 1.1; });
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

window.addEventListener('resize', () => {
  const sidebar = document.querySelector('.app-shell');
  const isMobile = window.innerWidth < 900;
  const heightOffset = isMobile ? window.innerHeight * 0.38 : 0;
  renderer.setSize(window.innerWidth, window.innerHeight - heightOffset);
  camera.aspect = window.innerWidth / (window.innerHeight - heightOffset);
  camera.updateProjectionMatrix();
});
