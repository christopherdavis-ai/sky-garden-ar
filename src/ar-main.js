import * as THREE from 'three';
import clients from './data/clients.json';
import { SKY_GARDEN_ORIGIN } from './config.js';
import { latLngToLocalXYZ } from './utils/geo.js';

const video = document.getElementById('cameraFeed');
const compassEl = document.getElementById('compass');
const calibration = document.getElementById('calibration');
const startBtn = document.getElementById('startAr');

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  video.srcObject = stream;
}
startCamera().catch((err) => console.error('Camera error', err));

window.addEventListener('deviceorientationabsolute', (e) => {
  if (e.alpha != null) compassEl.textContent = `Compass: ${Math.round(e.alpha)}°`;
});

const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('arScene'), alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 8000);
camera.position.set(0, 8, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.9));

for (const client of clients) {
  const { x, z } = latLngToLocalXYZ(client.lat, client.lng, SKY_GARDEN_ORIGIN);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, 35, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  beam.position.set(x * 0.05, 17.5, z * 0.05);
  scene.add(beam);
}

let started = false;
startBtn.addEventListener('click', async () => {
  if (!started && typeof DeviceOrientationEvent?.requestPermission === 'function') {
    try { await DeviceOrientationEvent.requestPermission(); } catch {}
  }
  calibration.classList.remove('active');
  started = true;
});

const clock = new THREE.Clock();
function tick() {
  const t = clock.getElapsedTime();
  scene.children.forEach((obj, i) => {
    if (obj.isMesh) {
      obj.scale.x = 1 + Math.sin(t * 2 + i) * 0.08;
      obj.scale.z = obj.scale.x;
    }
  });
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
