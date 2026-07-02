// BOXSTACK — crane tower stacker on Box3D (WASM) + three.js
import * as THREE from 'three';
import { Physics, BODY_STATIC, BODY_DYNAMIC } from './physics.js';

// ---------- tuning constants ----------
const CRATE_HALF = { x: 1.25, y: 0.5, z: 1.25 };
const BASE_HALF = { x: 1.9, y: 1.0, z: 1.9 };
const SPAWN_RISE = 4.2; // crane height above tower top
const SWING_AMPLITUDE = 4.0;
const SWING_SPEED_BASE = 1.35; // rad/s
const SWING_SPEED_GAIN = 0.045; // per stacked crate
const KILL_Y = -9;
const SETTLE_SPEED = 0.22; // m/s considered "landed"
const PERFECT_OFFSET = 0.32; // horizontal distance for PERFECT
const FIXED_DT = 1 / 60;
const SUBSTEPS = 4;

// ---------- DOM ----------
const canvas = document.getElementById('scene');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const comboEl = document.getElementById('combo');
const overlayEl = document.getElementById('overlay');
const gameoverEl = document.getElementById('gameover');
const finalScoreEl = document.getElementById('final-score');
const finalMsgEl = document.getElementById('final-msg');

// ---------- three.js scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a0f22');
scene.fog = new THREE.Fog('#0a0f22', 26, 60);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

const ambient = new THREE.HemisphereLight('#8fa3ff', '#1a1030', 0.85);
scene.add(ambient);

const sun = new THREE.DirectionalLight('#ffe3b8', 2.2);
sun.position.set(9, 16, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 22;
sun.shadow.camera.bottom = -14;
scene.add(sun);
scene.add(sun.target);

// distant floor disc for grounding, fades into fog
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(60, 48),
  new THREE.MeshStandardMaterial({ color: '#101736', roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -BASE_HALF.y;
floor.receiveShadow = true;
scene.add(floor);

const crateGeo = new THREE.BoxGeometry(CRATE_HALF.x * 2, CRATE_HALF.y * 2, CRATE_HALF.z * 2);
const crateEdges = new THREE.EdgesGeometry(crateGeo);

function crateColor(index) {
  const hue = (0.08 + index * 0.023) % 1;
  return new THREE.Color().setHSL(hue, 0.72, 0.58);
}

function makeCrateMesh(index) {
  const mat = new THREE.MeshStandardMaterial({
    color: crateColor(index),
    roughness: 0.42,
    metalness: 0.12,
  });
  const mesh = new THREE.Mesh(crateGeo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const line = new THREE.LineSegments(
    crateEdges,
    new THREE.LineBasicMaterial({ color: '#0b0e1a', transparent: true, opacity: 0.35 }),
  );
  mesh.add(line);
  return mesh;
}

// drop target marker: crate footprint outline projected straight down.
// The crane crate casts no shadow while swinging — the angled sun shadow
// lands offset from the true drop point and misleads aim.
const markerGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-CRATE_HALF.x, 0, -CRATE_HALF.z),
  new THREE.Vector3(CRATE_HALF.x, 0, -CRATE_HALF.z),
  new THREE.Vector3(CRATE_HALF.x, 0, CRATE_HALF.z),
  new THREE.Vector3(-CRATE_HALF.x, 0, CRATE_HALF.z),
]);
const dropMarker = new THREE.LineLoop(
  markerGeo,
  new THREE.LineBasicMaterial({ color: '#ffb454', transparent: true, opacity: 0.6, depthWrite: false }),
);
dropMarker.visible = false;
scene.add(dropMarker);

// landing pulse ring
const ringGeo = new THREE.RingGeometry(1, 1.18, 40);
const rings = [];
function spawnRing(x, y, z, hot) {
  const mat = new THREE.MeshBasicMaterial({
    color: hot ? '#ff5d73' : '#ffb454',
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, y + 0.02, z);
  ring.userData.life = 0;
  scene.add(ring);
  rings.push(ring);
}
function updateRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.userData.life += dt;
    const t = r.userData.life / 0.55;
    r.scale.setScalar(1.4 + t * 4.2);
    r.material.opacity = 0.9 * (1 - t);
    if (t >= 1) {
      scene.remove(r);
      r.material.dispose();
      rings.splice(i, 1);
    }
  }
}

// ---------- audio (tiny synth, no assets) ----------
let audioCtx = null;
function audio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function thud(speed) {
  const ctx = audio();
  const gain = ctx.createGain();
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120 + Math.min(speed * 8, 60), ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 0.14);
  const vol = Math.min(0.05 + speed * 0.03, 0.5);
  gain.gain.setValueAtTime(vol, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.19);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.2);
}
function chime(combo) {
  const ctx = audio();
  const base = 520 + Math.min(combo, 8) * 70;
  [0, 0.07].forEach((delay, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = base * (i === 0 ? 1 : 1.5);
    gain.gain.setValueAtTime(0.16, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + 0.32);
  });
}

// ---------- game state ----------
let phys = null;
const bodies = []; // { handle, mesh, restY }
const tmp = {};
let mode = 'menu'; // menu | swing | falling | over
let score = 0;
let best = Number(localStorage.getItem('boxstack-best') || 0);
let combo = 0;
let swingPhase = 0;
let swingAxis = 'x';
let craneMesh = null;
let fallingBody = null;
let fallTimer = 0;
let towerTopY = BASE_HALF.y; // top surface of current tower
let pendingGameOverMsg = '';
let collapseTimer = 0;
let camY = 6;
let shake = 0;
let accumulator = 0;
let lastTime = performance.now();

bestEl.textContent = best;

function towerTopBlock() {
  return bodies.length > 0 ? bodies[bodies.length - 1] : null;
}

function resetGame() {
  for (const b of bodies) scene.remove(b.mesh);
  bodies.length = 0;
  if (craneMesh) {
    scene.remove(craneMesh);
    craneMesh = null;
  }
  // a crate that was still falling at game over is not in `bodies` —
  // without this it lingers as a frozen ghost mesh in the next run
  if (fallingBody) {
    scene.remove(fallingBody.mesh);
    fallingBody = null;
  }
  phys.reset();

  // static ground plane matching the visual floor disc (top surface at y = -BASE_HALF.y)
  phys.createBox({
    type: BODY_STATIC,
    position: [0, -BASE_HALF.y - 0.5, 0],
    halfExtents: [60, 0.5, 60],
    friction: 0.8,
  });

  // static base pedestal
  phys.createBox({
    type: BODY_STATIC,
    position: [0, 0, 0],
    halfExtents: [BASE_HALF.x, BASE_HALF.y, BASE_HALF.z],
    friction: 0.9,
  });
  const baseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(BASE_HALF.x * 2, BASE_HALF.y * 2, BASE_HALF.z * 2),
    new THREE.MeshStandardMaterial({ color: '#2a3566', roughness: 0.7, metalness: 0.15 }),
  );
  baseMesh.receiveShadow = true;
  baseMesh.castShadow = true;
  scene.add(baseMesh);
  bodies.push({ handle: -1, mesh: baseMesh, restY: 0, isBase: true });

  score = 0;
  combo = 0;
  towerTopY = BASE_HALF.y;
  swingPhase = 0;
  swingAxis = 'x';
  scoreEl.textContent = '0';
  spawnCrane();
  mode = 'swing';
}

function spawnCrane() {
  craneMesh = makeCrateMesh(score);
  craneMesh.castShadow = false; // shadow would mislead aim; dropMarker shows the real target
  craneMesh.position.set(0, towerTopY + SPAWN_RISE, 0);
  scene.add(craneMesh);
  swingAxis = score % 2 === 0 ? 'x' : 'z';
  swingPhase = Math.random() * Math.PI * 2;
}

function dropCrate() {
  if (mode !== 'swing' || !craneMesh) return;
  craneMesh.castShadow = true;
  dropMarker.visible = false;
  const p = craneMesh.position;
  const handle = phys.createBox({
    type: BODY_DYNAMIC,
    position: [p.x, p.y, p.z],
    halfExtents: [CRATE_HALF.x, CRATE_HALF.y, CRATE_HALF.z],
    density: 1,
    friction: 0.75,
    restitution: 0.02,
    hitEvents: true,
  });
  fallingBody = { handle, mesh: craneMesh, restY: 0 };
  craneMesh = null;
  fallTimer = 0;
  mode = 'falling';
}

function showCombo(text, hot) {
  comboEl.textContent = text;
  comboEl.classList.remove('hidden', 'hot');
  if (hot) comboEl.classList.add('hot');
  comboEl.style.animation = 'none';
  void comboEl.offsetWidth; // restart animation
  comboEl.style.animation = '';
}

// knock the tower loose and let Box3D tumble it before showing the fail screen
function startCollapse(message) {
  if (mode === 'collapsing' || mode === 'over') return;
  mode = 'collapsing';
  pendingGameOverMsg = message;
  collapseTimer = 0;
  if (craneMesh) {
    scene.remove(craneMesh);
    craneMesh = null;
  }
  if (fallingBody) {
    bodies.push({ ...fallingBody, restY: fallingBody.mesh.position.y });
    fallingBody = null;
  }
}

function finalizeGameOver() {
  mode = 'over';
  best = Math.max(best, score);
  localStorage.setItem('boxstack-best', String(best));
  bestEl.textContent = best;
  finalScoreEl.textContent = score;
  finalMsgEl.textContent = pendingGameOverMsg;
  gameoverEl.classList.remove('hidden');
}

function resolveLanding() {
  const top = towerTopBlock();
  const s = tmp;
  const dx = Math.abs(s.x - top.mesh.position.x);
  const dz = Math.abs(s.z - top.mesh.position.z);
  const offset = Math.hypot(dx, dz);
  const supported = dx < CRATE_HALF.x * 2 * 0.92 && dz < CRATE_HALF.z * 2 * 0.92 && s.y > towerTopY - 0.3;

  if (!supported) {
    startCollapse(offset > 3 ? 'Missed the tower entirely.' : 'It slid off the stack.');
    return;
  }

  bodies.push({ ...fallingBody, restY: s.y });
  fallingBody = null;
  score += 1;
  scoreEl.textContent = score;
  towerTopY = s.y + CRATE_HALF.y;

  const perfect = offset < PERFECT_OFFSET;
  if (perfect) {
    combo += 1;
    showCombo(combo > 1 ? `PERFECT ×${combo}` : 'PERFECT', combo >= 3);
    chime(combo);
    spawnRing(s.x, towerTopY, s.z, combo >= 3);
  } else {
    combo = 0;
  }

  spawnCrane();
  mode = 'swing';
}

// ---------- fixed-step update ----------
function physicsTick() {
  phys.step(FIXED_DT, SUBSTEPS);

  // sync placed crates
  for (const b of bodies) {
    if (b.isBase) continue;
    if (phys.readBody(b.handle, tmp)) {
      b.mesh.position.set(tmp.x, tmp.y, tmp.z);
      b.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
    }
  }

  // impact audio + camera shake from Box3D hit events
  for (const hit of phys.hits()) {
    thud(hit.speed);
    shake = Math.min(shake + hit.speed * 0.012, 0.35);
  }

  if (mode === 'falling' && fallingBody) {
    fallTimer += FIXED_DT;
    if (phys.readBody(fallingBody.handle, tmp)) {
      fallingBody.mesh.position.set(tmp.x, tmp.y, tmp.z);
      fallingBody.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);

      if (tmp.y < KILL_Y) {
        startCollapse('Gravity always wins.');
        return;
      }
      const speed = Math.hypot(tmp.vx, tmp.vy, tmp.vz);
      if ((speed < SETTLE_SPEED && fallTimer > 0.35) || fallTimer > 4) {
        resolveLanding();
      }
    }
  }

  // let the collapse play out, then show the fail screen once the rubble settles
  if (mode === 'collapsing') {
    collapseTimer += FIXED_DT;
    let allQuiet = true;
    const s = tmp;
    for (const b of bodies) {
      if (b.isBase) continue;
      if (phys.readBody(b.handle, s) && Math.hypot(s.vx, s.vy, s.vz) > 0.4) {
        allQuiet = false;
        break;
      }
    }
    if ((allQuiet && collapseTimer > 1.2) || collapseTimer > 4.5) {
      finalizeGameOver();
    }
  }

  // topple watch: if any placed crate leaves the tower, the run ends
  if (mode === 'swing' || mode === 'falling') {
    for (const b of bodies) {
      if (b.isBase) continue;
      if (b.mesh.position.y < KILL_Y || b.mesh.position.y < b.restY - 2.2) {
        startCollapse('The tower gave way.');
        break;
      }
    }
  }
}

// ---------- render loop ----------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (mode !== 'menu') {
    accumulator += dt;
    while (accumulator >= FIXED_DT) {
      physicsTick();
      accumulator -= FIXED_DT;
    }
  }

  // crane swing
  if (mode === 'swing' && craneMesh) {
    const speed = SWING_SPEED_BASE + score * SWING_SPEED_GAIN;
    swingPhase += dt * speed;
    const offset = Math.sin(swingPhase) * SWING_AMPLITUDE;
    const y = towerTopY + SPAWN_RISE + Math.cos(swingPhase * 2.3) * 0.15;
    if (swingAxis === 'x') craneMesh.position.set(offset, y, 0);
    else craneMesh.position.set(0, y, offset);
    craneMesh.rotation.z = swingAxis === 'x' ? Math.sin(swingPhase) * -0.06 : 0;
    craneMesh.rotation.x = swingAxis === 'z' ? Math.sin(swingPhase) * 0.06 : 0;

    // marker blinks: visible window shrinks as the tower grows
    dropMarker.position.set(craneMesh.position.x, towerTopY + 0.04, craneMesh.position.z);
    const hold = Math.max(1.15 - score * 0.03, 0.35);
    const cycle = (now * 0.001) % (hold + 1.6);
    let a = 0;
    if (cycle < 0.3) a = cycle / 0.3; // fade in
    else if (cycle < 0.3 + hold) a = 1; // hold
    else if (cycle < 0.75 + hold) a = 1 - (cycle - 0.3 - hold) / 0.45; // fade out
    dropMarker.material.opacity = a * 0.7;
    dropMarker.visible = a > 0.02;
  } else {
    dropMarker.visible = false;
  }

  updateRings(dt);

  // camera follows tower height with soft lag + shake
  const targetY = Math.max(towerTopY, BASE_HALF.y) + 3.2;
  camY += (targetY - camY) * Math.min(dt * 2.4, 1);
  shake = Math.max(shake - dt * 1.4, 0);
  const sx = (Math.random() - 0.5) * shake;
  const sy = (Math.random() - 0.5) * shake;
  camera.position.set(10.5 + sx, camY + 4.4 + sy, 12.5);
  camera.lookAt(0, camY - 1.4, 0);
  sun.position.set(9, camY + 12, 7);
  sun.target.position.set(0, camY - 4, 0);

  renderer.render(scene, camera);
}

// ---------- input & resize ----------
function onAction() {
  if (mode === 'swing') dropCrate();
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    onAction();
  }
});
canvas.addEventListener('pointerdown', onAction);

document.getElementById('start-btn').addEventListener('click', () => {
  audio();
  overlayEl.classList.add('hidden');
  resetGame();
});
document.getElementById('retry-btn').addEventListener('click', () => {
  gameoverEl.classList.add('hidden');
  resetGame();
});

const BASE_FOV = 42; // vertical FOV for landscape; held as horizontal FOV on portrait

function resize() {
  // layout viewport, not window.innerWidth — iOS pinch zoom changes innerWidth
  // and would recompute the camera from the zoomed visual viewport
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  // updateStyle=true: canvas is an absolutely-positioned replaced element, so
  // inset:0 does not stretch it — without explicit CSS size it renders at
  // attribute size (w × devicePixelRatio), overflowing the screen on phones
  renderer.setSize(w, h);
  camera.aspect = w / h;
  if (camera.aspect < 1) {
    // portrait: keep the horizontal field constant so the tower and the
    // full crane swing stay in frame on phones
    const hHalf = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    camera.fov = Math.min(THREE.MathUtils.radToDeg(2 * Math.atan(hHalf / camera.aspect)), 82);
  } else {
    camera.fov = BASE_FOV;
  }
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
window.visualViewport?.addEventListener('resize', resize);
// iOS Safari ignores user-scalable=no; block pinch and double-tap zoom explicitly
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const t = Date.now();
    if (t - lastTouchEnd < 320) e.preventDefault();
    lastTouchEnd = t;
  },
  { passive: false },
);
resize();

// ---------- boot ----------
Physics.create(-10).then((p) => {
  phys = p;
  requestAnimationFrame(frame);
});

// debug hook for automated testing (dev builds only)
if (import.meta.env.DEV) window.__dbg = {
  state: () => ({
    mode,
    score,
    towerTopY,
    crane: craneMesh ? craneMesh.position.toArray() : null,
    falling: fallingBody ? fallingBody.mesh.position.toArray() : null,
  }),
  dropAtCenter: () => {
    if (mode === 'swing' && craneMesh) {
      craneMesh.position.set(0, towerTopY + SPAWN_RISE, 0);
      dropCrate();
    }
  },
};
