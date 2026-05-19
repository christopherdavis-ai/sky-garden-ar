import * as THREE from 'three';
import * as maptilersdk from '@maptiler/sdk';
import clients from './data/clients.json';
import banks from './data/banks.json';
import { MAPTILER_API_KEY, SKY_GARDEN_ORIGIN, VISUAL_DEFAULTS } from './config.js';

maptilersdk.config.apiKey = MAPTILER_API_KEY;
const map = new maptilersdk.Map({
  container: 'map',
  style: maptilersdk.MapStyle.STREETS.DARK,
  center: [SKY_GARDEN_ORIGIN.lng, SKY_GARDEN_ORIGIN.lat],
  zoom: 13.8,
  pitch: 66,
  bearing: -20,
  canvasContextAttributes: { antialias: true }
});

/* â”€â”€ Lock View button (inject into page) â”€â”€ */
const lockBtn = document.createElement('button');
lockBtn.id = 'lockViewBtn';
lockBtn.textContent = 'ðŸ”’ Lock View';
lockBtn.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;padding:10px 18px;background:#7C3AED;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.4);';
document.body.appendChild(lockBtn);

let viewLocked = false;
lockBtn.addEventListener('click', () => {
  viewLocked = !viewLocked;
  if (viewLocked) {
    map.dragRotate.disable();
    map.touchPitch.disable();
    map.keyboard.disable();
    // Keep zoom and pan working
    lockBtn.textContent = 'ðŸ”“ Unlock View';
    lockBtn.style.background = '#059669';
  } else {
    map.dragRotate.enable();
    map.touchPitch.enable();
    map.keyboard.enable();
    lockBtn.textContent = 'ðŸ”’ Lock View';
    lockBtn.style.background = '#7C3AED';
  }
});

/* â”€â”€ Client sidebar list â”€â”€ */
const list = document.getElementById('clientList');
clients.forEach((c) => {
  const li = document.createElement('li');
  li.innerHTML = `${c.name}`;
  list.appendChild(li);
});

/* â”€â”€ State â”€â”€ */
const state = { beamHeight: 120, beamRadius: 5, glowStrength: 0.45, day: false, flows: true };
const beamObjects = [];
const flowEmitters = [];
const centerMerc = maptilersdk.MercatorCoordinate.fromLngLat([SKY_GARDEN_ORIGIN.lng, SKY_GARDEN_ORIGIN.lat], 0);

const modelTransform = {
  translateX: centerMerc.x,
  translateY: centerMerc.y,
  translateZ: centerMerc.z,
  scale: centerMerc.meterInMercatorCoordinateUnits()
};

const toLocalMeters = (lng, lat) => {
  const mc = maptilersdk.MercatorCoordinate.fromLngLat([lng, lat], 0);
  const m = centerMerc.meterInMercatorCoordinateUnits();
  return new THREE.Vector3((mc.x - centerMerc.x) / m, 0, (mc.y - centerMerc.y) / m);
};

/* â”€â”€ Badge texture (fallback for initials) â”€â”€ */
const makeBadge = (txt, fill, emoji = '') => {
  const c = document.createElement('canvas'); c.width = 180; c.height = 140;
  const ctx = c.getContext('2d');
  ctx.fillStyle = fill; ctx.fillRect(20, 20, 140, 100);
  ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 4; ctx.strokeRect(20, 20, 140, 100);
  ctx.fillStyle = '#fff'; ctx.font = '700 30px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(`${emoji}${txt}`, 90, 82);
  return new THREE.CanvasTexture(c);
};

/* â”€â”€ Load logo onto a sprite (shared helper) â”€â”€ */
function loadLogo(logoPath, spriteMat, sprite, baseSize) {
  const texLoader = new THREE.TextureLoader();
  texLoader.load(logoPath, (logoTex) => {
    logoTex.colorSpace = THREE.SRGBColorSpace;
    spriteMat.map = logoTex;
    spriteMat.needsUpdate = true;
    // Preserve aspect ratio
    const img = logoTex.image;
    const aspect = img.width / img.height;
    if (aspect >= 1) {
      sprite.scale.set(baseSize, baseSize / aspect, 1);
    } else {
      sprite.scale.set(baseSize * aspect, baseSize, 1);
    }
  }, undefined, () => { /* silently keep initials on fail */ });
}

/* â”€â”€ Payment flow particles â”€â”€ */
function createFlow(points, colorA, colorB, scene) {
  const curve = new THREE.CatmullRomCurve3(points);
  const count = 100;
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
  const m = new THREE.PointsMaterial({ size: 1.8, vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const pts = new THREE.Points(g, m);
  scene.add(pts);
  flowEmitters.push({ curve, points: pts, count, speed: 0.11 + Math.random() * 0.1, offset: Math.random() });
}

/* â”€â”€ Custom Three.js layer â”€â”€ */
const customLayer = {
  id: 'sky-garden-three-layer',
  type: 'custom',
  renderingMode: '3d',
  onAdd(mapRef, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.map = mapRef;
    this.renderer = new THREE.WebGLRenderer({ canvas: mapRef.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.scene.add(new THREE.AmbientLight(0xb8c8ff, 0.75));

    const trueLayer = clients.find((c) => c.name === 'TrueLayer');
    const tlPos = toLocalMeters(trueLayer.lng, trueLayer.lat);

    /* â”€â”€ Sky Garden radar ring â”€â”€ */
    const radar = new THREE.Mesh(
      new THREE.RingGeometry(9, 12, 56),
      new THREE.MeshBasicMaterial({ color: '#7C3AED', transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    radar.rotation.x = -Math.PI / 2;
    radar.position.copy(tlPos).add(new THREE.Vector3(0, 0.2, 0));
    this.scene.add(radar);
    this.radar = radar;

    /* â”€â”€ CLIENT BEAMS â”€â”€ */
    for (const client of clients) {
      const pos = toLocalMeters(client.lng, client.lat);
      const isTL = client.name === 'TrueLayer';
      const h = isTL ? 300 : state.beamHeight;
      const group = new THREE.Group();
      group.position.copy(pos);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(state.beamRadius, state.beamRadius, h, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      beam.position.y = h / 2;

      const glow = new THREE.Mesh(
        new THREE.CylinderGeometry(state.beamRadius * 1.6, state.beamRadius * 1.6, h * 1.05, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: client.beamColor, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      glow.position.y = h / 2;

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(4, isTL ? 8.5 : 6.5, 32),
        new THREE.MeshBasicMaterial({ color: client.beamColor, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;

      /* Logo / badge sprite */
      const badgeTexture = makeBadge(client.initials, client.beamColor);
      const spriteMat = new THREE.SpriteMaterial({ map: badgeTexture, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.scale.set(12, 9, 1);
      sprite.position.y = h + 10;

      if (client.logo) {
        loadLogo(client.logo, spriteMat, sprite, 14);
      }

      /* Orbiting particles */
      const particles = new THREE.Group();
      for (let i = 0; i < VISUAL_DEFAULTS.particleCount; i++) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.45, 6, 6), new THREE.MeshBasicMaterial({ color: client.beamColor }));
        const a = (i / VISUAL_DEFAULTS.particleCount) * Math.PI * 2;
        p.position.set(Math.cos(a) * 7, 2 + (i % 6), Math.sin(a) * 7);
        particles.add(p);
      }
      group.add(beam, glow, ring, sprite, particles);
      this.scene.add(group);
      beamObjects.push({ beam, glow, sprite, particles, baseHeight: h, trueLayer: isTL });
    }

    /* â”€â”€ BANK BEAMS (with logo loading!) â”€â”€ */
    for (const bank of banks) {
      const bankPos = toLocalMeters(bank.lng, bank.lat);
      const h = 85;
      const group = new THREE.Group();
      group.position.copy(bankPos);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(4.2, 4.2, h, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: '#4dabff', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      beam.position.y = h / 2;

      const sq = new THREE.Mesh(
        new THREE.PlaneGeometry(11, 11),
        new THREE.MeshBasicMaterial({ color: '#90caf9', side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
      );
      sq.rotation.x = -Math.PI / 2;

      /* Bank logo / badge sprite */
      const badgeTexture = makeBadge(bank.initials, '#3f7dff', 'ðŸ¦');
      const spriteMat = new THREE.SpriteMaterial({ map: badgeTexture, transparent: true, depthWrite: false });
      const badge = new THREE.Sprite(spriteMat);
      badge.scale.set(14, 10, 1);
      badge.position.y = h + 10;

      if (bank.logo) {
        loadLogo(bank.logo, spriteMat, badge, 14);
      }

      group.add(beam, sq, badge);
      this.scene.add(group);
      beamObjects.push({ beam, glow: null, sprite: badge, particles: null, baseHeight: h, trueLayer: false });

      /* Flow: Bank â†’ TrueLayer */
      const mid = bankPos.clone().lerp(tlPos, 0.5).add(new THREE.Vector3(0, 95, 0));
      createFlow([bankPos.clone().add(new THREE.Vector3(0, 8, 0)), mid, tlPos.clone().add(new THREE.Vector3(0, 220, 0))], '#d6ecff', '#5bb4ff', this.scene);
    }

    /* â”€â”€ Flows: TrueLayer â†’ Clients â”€â”€ */
    clients.filter((c) => c.name !== 'TrueLayer').forEach((c) => {
      const cPos = toLocalMeters(c.lng, c.lat);
      const mid = tlPos.clone().lerp(cPos, 0.5).add(new THREE.Vector3(0, 80, 0));
      createFlow([tlPos.clone().add(new THREE.Vector3(0, 220, 0)), mid, cPos.clone().add(new THREE.Vector3(0, 60, 0))], '#8b5cf6', '#2dd4bf', this.scene);
    });
  },

  render(gl, args) {
    const t = performance.now() * 0.001;
    const scale = modelTransform.scale;

    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
    const l = new THREE.Matrix4()
      .makeTranslation(modelTransform.translateX, modelTransform.translateY, modelTransform.translateZ)
      .scale(new THREE.Vector3(scale, -scale, scale))
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2));

    this.camera.projectionMatrix = m.multiply(l);

    this.radar.scale.setScalar(1 + Math.sin(t * 3) * 0.25 + 0.3);
    this.radar.material.opacity = 0.55 + Math.sin(t * 3) * 0.2;

    beamObjects.forEach((o, i) => {
      const pulse = 1 + Math.sin(t * 1.7 + i * 0.3) * 0.1;
      o.beam.scale.set(pulse, 1, pulse);
      if (o.glow) o.glow.scale.set(pulse * 1.08, 1, pulse * 1.08);
      o.sprite.position.y = o.baseHeight + 10 + Math.sin(t * 2 + i) * 1.8;
      if (o.particles?.rotation) o.particles.rotation.y += 0.01;
    });

    flowEmitters.forEach((f) => {
      f.points.visible = state.flows;
      const arr = f.points.geometry.attributes.position.array;
      for (let i = 0; i < f.count; i++) {
        const u = (i / f.count + t * f.speed + f.offset) % 1;
        const p = f.curve.getPoint(u);
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      f.points.geometry.attributes.position.needsUpdate = true;
    });

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }
};

map.on('style.load', () => map.addLayer(customLayer));

/* â”€â”€ UI Controls â”€â”€ */
document.getElementById('dayToggle').addEventListener('change', (e) => {
  state.day = e.target.checked;
  map.setStyle(state.day ? maptilersdk.MapStyle.STREETS.PASTEL : maptilersdk.MapStyle.STREETS.DARK);
});
document.getElementById('flowToggle').addEventListener('change', (e) => { state.flows = e.target.checked; });

function applyBeamSettings() {
  state.beamHeight = Number(document.getElementById('beamHeight').value);
  state.beamRadius = Number(document.getElementById('beamRadius').value);
  state.glowStrength = Number(document.getElementById('glowStrength').value);
  beamObjects.forEach((o) => {
    if (o.trueLayer) return;
    o.beam.geometry.dispose();
    o.beam.geometry = new THREE.CylinderGeometry(state.beamRadius, state.beamRadius, state.beamHeight, 20, 1, true);
    o.beam.position.y = state.beamHeight / 2;
    if (o.glow) {
      o.glow.geometry.dispose();
      o.glow.geometry = new THREE.CylinderGeometry(state.beamRadius * 1.6, state.beamRadius * 1.6, state.beamHeight * 1.05, 20, 1, true);
      o.glow.position.y = state.beamHeight / 2;
      o.glow.material.opacity = state.glowStrength * 0.3;
    }
    o.baseHeight = state.beamHeight;
  });
}
['beamHeight', 'beamRadius', 'glowStrength'].forEach((id) => document.getElementById(id).addEventListener('input', applyBeamSettings));
