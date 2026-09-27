// StrikeZone — browser client.
// Rendering + input + prediction. The server is authoritative for everything
// that matters (damage, health, kills, score, ammo, match state).
import * as THREE from 'three';
import { MAP, TEAMS } from '../../shared/map.js';
import { WEAPONS } from '../../shared/weapons.js';
import { PHYS, stepPlayer, eyeHeight } from '../../shared/physics.js';
import { NET, MATCH } from '../../shared/constants.js';

// ---------------------------------------------------------------- config
const SERVER_URL = (() => {
  // 1. explicit ?server=ws://... query parameter (handy for testing)
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  // 2. build-time baked URL (STRIKEZONE_SERVER_URL env at build → esbuild define)
  if (typeof STRIKEZONE_SERVER_URL !== 'undefined' && STRIKEZONE_SERVER_URL) return STRIKEZONE_SERVER_URL;
  // 3. same origin (server also hosts the frontend — the default deployment)
  if (location.protocol === 'file:') return 'ws://localhost:3000/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${NET.SNAPSHOT_PATH}`;
})();

const $ = (id) => document.getElementById(id);
const els = {
  canvas: $('game-canvas'),
  menu: $('screen-menu'), browser: $('screen-browser'), lobby: $('screen-lobby'),
  hud: $('hud'), countdown: $('overlay-countdown'), death: $('overlay-death'),
  end: $('overlay-end'), scoreboard: $('scoreboard'), pause: $('pause-overlay'),
  loading: $('loading-screen'), reconnect: $('reconnect-overlay'),
};

// ---------------------------------------------------------------- audio (procedural)
const AudioFX = {
  ctx: null, master: null, noiseBuf: null,
  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    // white noise buffer
    const len = this.ctx.sampleRate * 1;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  _noise(dur, filterFreq, gain, dest, q = 1) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(dest || this.master);
    src.start(); src.stop(c.currentTime + dur + 0.02);
    return g;
  },
  _tone(freq, dur, gain, type = 'sine', dest) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g); g.connect(dest || this.master);
    o.start(); o.stop(c.currentTime + dur + 0.02);
  },
  _panner(x, y, z) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.setPosition(x, y, z);
    p.connect(this.master);
    return p;
  },
  setListener(cam) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.position;
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      const d = new THREE.Vector3(); cam.getWorldDirection(d);
      l.forwardX.value = d.x; l.forwardY.value = d.y; l.forwardZ.value = d.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(p.x, p.y, p.z);
    }
  },
  shootLocal(w) {
    if (!this.ctx) return;
    const base = [0, 1, 2][w] ?? 0;
    const freq = [1400, 700, 1800][base];
    const dur = [0.09, 0.22, 0.08][base];
    this._noise(dur, freq, 0.5);
    this._tone([150, 90, 190][base], dur, 0.35, 'square');
  },
  shootRemote(w, x, y, z) {
    if (!this.ctx) return;
    const dest = this._panner(x, y, z);
    const freq = [1100, 600, 1500][w] ?? 1100;
    const dur = [0.1, 0.24, 0.09][w] ?? 0.1;
    this._noise(dur, freq, 0.4, dest);
    this._tone([120, 80, 160][w] ?? 120, dur, 0.25, 'square', dest);
  },
  reloadStart() { if (this.ctx) { this._tone(320, 0.06, 0.25, 'square'); setTimeout(() => this._tone(240, 0.07, 0.22, 'square'), 180); } },
  reloadDone() { if (this.ctx) { this._tone(520, 0.06, 0.3, 'square'); } },
  hitmark(hs) { if (this.ctx) this._tone(hs ? 1300 : 950, 0.07, 0.3, 'triangle'); },
  hurt() { if (this.ctx) { this._noise(0.16, 500, 0.45); this._tone(110, 0.14, 0.3, 'sawtooth'); } },
  death() { if (this.ctx) { this._tone(220, 0.5, 0.35, 'sawtooth'); this._noise(0.5, 300, 0.3); } },
  step() { if (this.ctx) this._noise(0.06, 260 + Math.random() * 120, 0.09); },
  ui() { if (this.ctx) this._tone(660, 0.05, 0.18, 'triangle'); },
  countdownBeep(last) { if (this.ctx) this._tone(last ? 880 : 520, last ? 0.25 : 0.1, 0.3, 'triangle'); },
  matchStart() { if (this.ctx) { this._tone(440, 0.15, 0.3, 'triangle'); setTimeout(() => this._tone(660, 0.2, 0.3, 'triangle'), 160); } },
  matchEnd(win) {
    if (!this.ctx) return;
    const seq = win ? [523, 659, 784, 1047] : [392, 330, 262];
    seq.forEach((f, i) => setTimeout(() => this._tone(f, 0.28, 0.28, 'triangle'), i * 170));
  },
  empty() { if (this.ctx) this._tone(1900, 0.03, 0.15, 'square'); },
};

// ---------------------------------------------------------------- network
const Net = {
  ws: null, connected: false, myId: null, name: '',
  onMsg: null, onClose: null,
  connect() {
    return new Promise((resolve, reject) => {
      try { this.ws = new WebSocket(SERVER_URL); } catch (e) { reject(e); return; }
      const timeout = setTimeout(() => { try { this.ws.close(); } catch { } reject(new Error('timeout')); }, 8000);
      this.ws.onopen = () => { clearTimeout(timeout); this.connected = true; resolve(); };
      this.ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket error')); };
      this.ws.onclose = (ev) => {
        this.connected = false;
        if (this.onClose) this.onClose(ev);
      };
      this.ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'welcome') this.myId = m.id;
        if (this.onMsg) this.onMsg(m);
      };
    });
  },
  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  },
  close() { this.onClose = null; if (this.ws) try { this.ws.close(); } catch { } },
};

// ---------------------------------------------------------------- game state
const state = {
  screen: 'loading',       // menu | browser | lobby | countdown | playing | ended
  room: null,              // latest room message
  snap: null,              // latest snapshot
  myTeam: 0,
  playing: false,
  paused: true,
  scoreData: null,
  clockOffset: 0,          // serverNow - Date.now()
  pingMs: 0,
  lastSnapAt: 0,
};

// local predicted player
const local = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true,
  yaw: 0, pitch: 0, crouch: false,
  hp: 100, dead: true, slot: 0,
  ammo: WEAPONS.map(w => ({ mag: w.mag, reserve: w.reserveMax })),
  reloading: 0, kills: 0, deaths: 0, respawnIn: 0,
};
let pendingInputs = [];    // {seq, inp}
let inputSeq = 0;

// remote players: id -> { x,y,z, yaw,pitch, hp, team, dead, crouch, slot, mesh, group, label }
const remotes = new Map();
const rosterNames = new Map(); // id -> name (from room messages, used for labels)
const snapBuffer = [];     // { at, players: Map }

// ---------------------------------------------------------------- three.js
const renderer = new THREE.WebGLRenderer({ canvas: els.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9db4cc);
scene.fog = new THREE.Fog(0x9db4cc, 40, 130);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.08, 300);
camera.rotation.order = 'YXZ';

// lights
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x444a52, 1.05));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
sun.position.set(30, 50, 18);
scene.add(sun);

// ground
{
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#4d535b'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.14)'; g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 220; i++) g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(72, 72),
    new THREE.MeshLambertMaterial({ map: tex })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
}

// map boxes
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
for (const b of MAP.boxes) {
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(b.c) });
  const mesh = new THREE.Mesh(boxGeo, mat);
  mesh.position.set(b.x, b.y, b.z);
  mesh.scale.set(b.w, b.h, b.d);
  scene.add(mesh);
  // subtle top edge highlight
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
  );
  edge.position.copy(mesh.position); edge.scale.copy(mesh.scale);
  scene.add(edge);
}

// team spawn pads
for (let t = 0; t < 2; t++) {
  const color = t === 0 ? 0x3b82f6 : 0xef4444;
  const padGeo = new THREE.CylinderGeometry(0.9, 0.9, 0.05, 20);
  const padMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 });
  for (const s of MAP.spawns[t]) {
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(s.x, 0.03, s.z);
    scene.add(pad);
  }
}

// ---------------------------------------------------------------- player meshes
const TEAM_COLORS = [0x3b82f6, 0xef4444];
const bodyGeo = new THREE.BoxGeometry(0.7, 0.95, 0.4);
const headGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
const legsGeo = new THREE.BoxGeometry(0.56, 0.55, 0.34);

function makeLabel(name, team) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  g.font = 'bold 30px Arial';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = team === 0 ? '#7db4ff' : '#ff8a8a';
  g.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(2.2, 0.55, 1);
  return sp;
}

function makePlayerMesh(name, team) {
  const group = new THREE.Group();
  const c = TEAM_COLORS[team];
  const dark = new THREE.Color(c).multiplyScalar(0.7);
  const torso = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color: c }));
  torso.position.y = 0.55 + 0.475;
  const legs = new THREE.Mesh(legsGeo, new THREE.MeshLambertMaterial({ color: dark }));
  legs.position.y = 0.275;
  const head = new THREE.Mesh(headGeo, new THREE.MeshLambertMaterial({ color: 0xd8b48e }));
  head.position.y = 1.025 + 0.17 + 0.16;
  // simple gun
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.66), new THREE.MeshLambertMaterial({ color: 0x22262c }));
  gun.position.set(0.28, 1.15, -0.35);
  const label = makeLabel(name, team);
  label.position.y = 2.15;
  group.add(torso, legs, head, gun, label);
  group.userData = { torso, legs, head, gun, label };
  return group;
}

// ---------------------------------------------------------------- viewmodel
const vmGroup = new THREE.Group();
camera.add(vmGroup);
scene.add(camera);

const vmMats = [
  new THREE.MeshLambertMaterial({ color: 0x2b3038 }), // rifle
  new THREE.MeshLambertMaterial({ color: 0x4a3524 }), // shotgun
  new THREE.MeshLambertMaterial({ color: 0x3a3f47 }), // pistol
];
function buildViewModel(slot) {
  while (vmGroup.children.length) vmGroup.remove(vmGroup.children[0]);
  const g = new THREE.Group();
  const mat = vmMats[slot];
  const metal = new THREE.MeshLambertMaterial({ color: 0x1a1d22 });
  if (slot === 0) { // rifle
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.75), mat);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 8), metal);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.5);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.09), metal);
    mag.position.set(0, -0.13, -0.05);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.22), mat);
    stock.position.set(0, -0.02, 0.42);
    g.add(body, barrel, mag, stock);
  } else if (slot === 1) { // shotgun
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.85), mat);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.55, 8), metal);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.04, -0.62);
    const pump = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.16), metal);
    pump.position.set(0, -0.06, -0.42);
    g.add(body, barrel, pump);
  } else { // pistol
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.3), mat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.16), metal);
    barrel.position.set(0, 0.05, -0.2);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.14, 0.08), mat);
    grip.position.set(0, -0.12, 0.08); grip.rotation.x = 0.25;
    g.add(body, barrel, grip);
  }
  g.position.set(0.28, -0.26, -0.55);
  g.rotation.y = 0.06;
  vmGroup.add(g);
  // muzzle flash sprite
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    color: 0xffcc66, transparent: true, opacity: 0, depthTest: false,
  }));
  flash.scale.set(0.34, 0.34, 1);
  flash.position.set(0.28, -0.2, -1.15);
  vmGroup.add(flash);
  vmGroup.userData = { gun: g, flash, flashUntil: 0 };
  return vmGroup.userData;
}
let vm = buildViewModel(0);
const vmLight = new THREE.PointLight(0xffaa44, 0, 6);
vmLight.position.set(0.3, -0.2, -1.1);
camera.add(vmLight);

// recoil / bob state
const vmState = { kick: 0, kickVel: 0, bobT: 0, swayX: 0, swayY: 0, reloadT: 0, reloadDur: 0 };
const recoilState = { pitch: 0, yaw: 0, vPitch: 0, vYaw: 0 };
let adsSmooth = 0; // 0..1 aim-down-sights blend, smoothed per frame

// ---------------------------------------------------------------- effects pools
const tracers = [];  // { line, mat, until }
const tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
function spawnTracer(from, to, color = 0xffd27a) {
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const geo = tracerGeo.clone();
  geo.setFromPoints([from, to]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, mat, until: performance.now() + 90 });
}

const impacts = []; // { mesh, until }
const impactGeo = new THREE.SphereGeometry(0.06, 6, 6);
function spawnImpact(pos, color = 0xdddddd) {
  const m = new THREE.Mesh(impactGeo, new THREE.MeshBasicMaterial({ color }));
  m.position.copy(pos);
  scene.add(m);
  impacts.push({ mesh: m, until: performance.now() + 160 });
}

const flashes = []; // remote muzzle flashes { sprite, until }
const flashTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,240,180,1)');
  grad.addColorStop(0.4, 'rgba(255,180,60,0.7)');
  grad.addColorStop(1, 'rgba(255,140,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
function spawnFlash(pos) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthTest: false }));
  sp.scale.set(0.8, 0.8, 1);
  sp.position.copy(pos);
  scene.add(sp);
  flashes.push({ sprite: sp, until: performance.now() + 60 });
}

function cleanupEffects(now) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    const left = t.until - now;
    if (left <= 0) { scene.remove(t.line); t.line.geometry.dispose(); t.mat.dispose(); tracers.splice(i, 1); }
    else t.mat.opacity = Math.min(0.9, left / 90);
  }
  for (let i = impacts.length - 1; i >= 0; i--) {
    const im = impacts[i];
    if (now > im.until) { scene.remove(im.mesh); impacts.splice(i, 1); }
  }
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    if (now > f.until) { scene.remove(f.sprite); f.sprite.material.dispose(); flashes.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- input
const keys = {};
let mouseDown = false;
let aimDown = false;    // RMB held — aim down sights
let wantFire = false;   // edge for semi-auto

addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();
  keys[e.code] = true;
  if (state.screen === 'playing' && !state.paused) {
    if (e.code === 'KeyR') Net.send({ t: 'reload' });
    if (e.code === 'Digit1') Net.send({ t: 'switch', slot: 0 });
    if (e.code === 'Digit2') Net.send({ t: 'switch', slot: 1 });
    if (e.code === 'Digit3') Net.send({ t: 'switch', slot: 2 });
  }
  if (e.code === 'Space' && state.screen === 'playing' && !state.paused) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseDown = false; aimDown = false; });

els.canvas.addEventListener('mousedown', (e) => {
  if (state.screen !== 'playing') return;
  if (state.paused) { requestLock(); return; }
  if (e.button === 0) { mouseDown = true; wantFire = true; Net.send({ t: 'fire' }); }
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });
addEventListener('wheel', (e) => {
  if (state.screen !== 'playing' || state.paused) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  Net.send({ t: 'switch', slot: (local.slot + dir + 3) % 3 });
});
addEventListener('contextmenu', (e) => e.preventDefault());

let lockRequested = false;
function requestLock() {
  AudioFX.resume();
  lockRequested = true;
  els.canvas.requestPointerLock();
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === els.canvas;
  lockRequested = false;
  if (state.screen === 'playing') {
    state.paused = !locked;
    els.pause.classList.toggle('active', !locked);
  }
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== els.canvas || state.paused) return;
  const s = 0.0022 * (1 - 0.45 * adsSmooth); // slower look while scoped
  local.yaw -= e.movementX * s;
  local.pitch -= e.movementY * s;
  local.pitch = Math.max(-1.55, Math.min(1.55, local.pitch));
});

$('btn-resume').addEventListener('click', requestLock);

// ---------------------------------------------------------------- input send + prediction
const SEND_HZ = 50;
let lastSendAt = 0;

function gatherInput(dt) {
  const fx = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const sx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  return {
    seq: ++inputSeq,
    dt,
    fx, sx,
    yaw: local.yaw, pitch: local.pitch,
    jump: !!keys.Space,
    sprint: !!keys.ShiftLeft || !!keys.ShiftRight,
    crouch: !!keys.ControlLeft || !!keys.KeyC,
    fire: mouseDown,
    ads: aimDown && !local.dead,
  };
}

function sendInput(dt) {
  const inp = gatherInput(dt);
  pendingInputs.push(inp);
  if (pendingInputs.length > 120) pendingInputs.splice(0, pendingInputs.length - 120);
  Net.send({ t: 'input', ...inp });
  // local prediction
  if (!local.dead) {
    stepPlayer(local, inp, inp.dt, MAP.boxes, MAP.bounds);
    local.crouch = inp.crouch;
  }
  // footsteps
  const speed = Math.hypot(local.vx, local.vz);
  if (!local.dead && local.onGround && speed > 1) {
    stepAccum += speed * inp.dt;
    const stride = inp.crouch ? 2.6 : (inp.sprint ? 2.0 : 1.6);
    if (stepAccum > stride) { stepAccum = 0; AudioFX.step(); }
  }
  wantFire = false;
}
let stepAccum = 0;

// ---------------------------------------------------------------- snapshots
function handleSnapshot(m) {
  state.snap = m;
  state.lastSnapAt = performance.now();
  state.clockOffset = m.now - Date.now();
  state.scoreData = m.sb || state.scoreData;

  const me = m.me;
  // ----- reconcile local player -----
  local.hp = me.hp;
  local.dead = !!me.dead;
  local.slot = me.slot;
  local.kills = me.kills;
  local.deaths = me.deaths;
  local.respawnIn = me.respawnIn;
  local.reloading = me.reloading;
  for (let i = 0; i < me.ammo.length; i++) {
    local.ammo[i].mag = me.ammo[i][0];
    local.ammo[i].reserve = me.ammo[i][1];
  }
  if (vm && currentSlotShown !== me.slot) {
    vm = buildViewModel(me.slot);
    currentSlotShown = me.slot;
  }
  if (me.reloading > 0 && vmState.reloadDur === 0) {
    vmState.reloadT = 0; vmState.reloadDur = me.reloading;
  }
  if (me.reloading === 0) vmState.reloadDur = 0;

  const dx = me.x - local.x, dy = me.y - local.y, dz = me.z - local.z;
  const err = Math.hypot(dx, dy, dz);
  // drop acknowledged inputs
  while (pendingInputs.length && pendingInputs[0].seq <= me.seq) pendingInputs.shift();

  if (err > 3.5) {
    // teleport/respawn: hard snap
    pendingInputs = [];
    local.x = me.x; local.y = me.y; local.z = me.z;
    local.vx = me.vx; local.vy = me.vy; local.vz = me.vz;
    local.onGround = true;
  } else {
    // authoritative correction + replay unacked inputs (reconciliation)
    local.x = me.x; local.y = me.y; local.z = me.z;
    local.vx = me.vx; local.vy = me.vy; local.vz = me.vz;
    local.onGround = me.vy === 0 && me.y <= 0.01;
    for (const inp of pendingInputs) stepPlayer(local, inp, inp.dt, MAP.boxes, MAP.bounds);
  }

  // ----- buffer remote snapshots for interpolation -----
  const pm = new Map();
  for (const r of m.players) {
    pm.set(r[0], { x: r[1], y: r[2], z: r[3], yaw: r[4], pitch: r[5], hp: r[6], team: r[7], dead: r[8], crouch: r[9], slot: r[10] });
  }
  snapBuffer.push({ at: performance.now(), players: pm });
  while (snapBuffer.length > 60) snapBuffer.shift();

  // ----- events -----
  if (m.ev && m.ev.length) processEvents(m.ev, m);

  // ----- match flow -----
  const preMatchScreens = ['lobby', 'browser', 'menu'];
  if (m.state === 'countdown' && (state.screen === 'lobby' || preMatchScreens.includes(state.screen))) {
    enterCountdown();
  }
  if (m.state === 'playing' && (state.screen === 'countdown' || preMatchScreens.includes(state.screen))) {
    enterPlaying();
  }
  if (m.state === 'ended' && (state.screen === 'playing' || state.screen === 'countdown')) {
    enterEnd(m.winner);
  }
}

function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function updateRemotes(now) {
  const renderAt = now - NET.INTERP_DELAY * 1000;
  let a = null, b = null;
  for (let i = 0; i < snapBuffer.length - 1; i++) {
    if (snapBuffer[i].at <= renderAt && snapBuffer[i + 1].at >= renderAt) { a = snapBuffer[i]; b = snapBuffer[i + 1]; break; }
  }
  if (!a && snapBuffer.length >= 2) { a = snapBuffer[snapBuffer.length - 2]; b = snapBuffer[snapBuffer.length - 1]; }

  if (a && b) {
    const span = Math.max(1, b.at - a.at);
    const t = Math.max(0, Math.min(1.4, (renderAt - a.at) / span));
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id) || pb;
      const r = ensureRemote(id, pb.team);
      r.lastSeen = now;
      r.x = pa.x + (pb.x - pa.x) * t;
      r.y = pa.y + (pb.y - pa.y) * t;
      r.z = pa.z + (pb.z - pa.z) * t;
      r.yaw = angleLerp(pa.yaw, pb.yaw, Math.min(1, t));
      r.hp = pb.hp; r.dead = pb.dead; r.crouch = pb.crouch;
      r.group.position.set(r.x, r.y, r.z);
      r.group.rotation.y = r.yaw + Math.PI; // model faces -Z local → rotate to face aim dir
      const squash = r.crouch ? 0.72 : 1;
      r.group.scale.y = r.dead ? 0.25 : squash;
      r.group.visible = true;
    }
  }
  // remove remotes that vanished from snapshots (disconnects, missed events)
  for (const [id, r] of [...remotes]) {
    if (r.lastSeen && now - r.lastSeen > 1000) removeRemote(id);
  }
}

function ensureRemote(id, team, name) {
  if (remotes.has(id)) return remotes.get(id);
  const label = name || rosterNames.get(id) || 'Player';
  const group = makePlayerMesh(label, team);
  scene.add(group);
  const r = { id, team, x: 0, y: 0, z: 0, yaw: 0, hp: 100, dead: false, crouch: false, group, name: label, lastSeen: 0 };
  remotes.set(id, r);
  return r;
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.group);
  r.group.userData.label.material.map.dispose();
  remotes.delete(id);
}

// ---------------------------------------------------------------- events
let currentSlotShown = 0;
const killerByVictim = new Map();

function processEvents(evts, snap) {
  for (const e of evts) {
    switch (e.e) {
      case 'join': {
        if (e.id !== Net.myId) ensureRemote(e.id, e.team, e.name);
        break;
      }
      case 'leave': removeRemote(e.id); break;
      case 'shot': {
        const from = new THREE.Vector3(e.x, e.y, e.z);
        const to = new THREE.Vector3(e.ex, e.ey, e.ez);
        const isLocal = e.id === Net.myId;
        if (isLocal) {
          AudioFX.shootLocal(e.w);
          // recoil
          const w = WEAPONS[e.w];
          recoilState.vPitch += w.recoilUp * 0.55;
          recoilState.vYaw += (Math.random() - 0.5) * w.recoilSide;
          vmState.kickVel += w.kick * 60;
          vmState.flashUntil = performance.now() + 55;
          vmLight.intensity = 3.5;
        } else {
          AudioFX.shootRemote(e.w, e.x, e.y, e.z);
          spawnFlash(from);
        }
        spawnTracer(from, to, isLocal ? 0xffe6a0 : 0xffb060);
        const dir = to.clone().sub(from);
        if (dir.lengthSq() > 0.01) spawnImpact(to, 0xcfcfcf);
        break;
      }
      case 'hit': {
        if (e.by === Net.myId) {
          showHitmarker(!!e.hs);
          AudioFX.hitmark(!!e.hs);
        }
        if (e.victim === Net.myId) {
          damageFlash(Math.min(1, e.dmg / 45));
          AudioFX.hurt();
        }
        break;
      }
      case 'kill': {
        addKillfeed(e);
        if (e.victim === Net.myId) {
          killerByVictim.set(Net.myId, { name: e.killerName, w: e.w, hs: e.hs });
          AudioFX.death();
        }
        if (e.killer === Net.myId) local.kills++;
        break;
      }
      case 'respawn': {
        if (e.id === Net.myId) {
          // hard reset prediction on respawn
          pendingInputs = [];
        }
        break;
      }
      case 'reload': {
        if (e.id === Net.myId) AudioFX.reloadStart();
        break;
      }
      case 'matchstart': AudioFX.matchStart(); break;
      case 'matchend': break;
    }
  }
}

// ---------------------------------------------------------------- HUD
let hitmarkerUntil = 0, hitmarkerHs = false;
function showHitmarker(hs) { hitmarkerUntil = performance.now() + 180; hitmarkerHs = hs; }

let vignetteUntil = 0;
function damageFlash(intensity) {
  els.vignette.style.opacity = String(Math.min(1, intensity));
  vignetteUntil = performance.now() + 250;
}

const killfeedEntries = [];
function addKillfeed(e) {
  const div = document.createElement('div');
  div.className = 'kill-entry';
  const killerTeam = state.snap ? null : null;
  const kTeam = killerTeamOf(e.killer);
  const vTeam = killerTeamOf(e.victim);
  div.innerHTML = `<span class="k-${kTeam === 0 ? 'alpha' : 'bravo'}">${esc(e.killerName)}</span><span class="skull">${e.hs ? '☠ HS' : '▸'}</span><span class="k-${vTeam === 0 ? 'alpha' : 'bravo'}">${esc(e.victimName)}</span>`;
  els.killfeed.appendChild(div);
  killfeedEntries.push({ div, until: performance.now() + 5000 });
  if (killfeedEntries.length > 6) {
    const old = killfeedEntries.shift();
    old.div.remove();
  }
}
function killerTeamOf(id) {
  if (id === Net.myId) return state.myTeam;
  const r = remotes.get(id);
  return r ? r.team : 0;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function updateHUD(now) {
  const s = state.snap;
  if (!s) return;
  // scores + timer
  els.scoreAlpha = els.scoreAlpha || $('score-alpha');
  $('score-alpha').textContent = s.scores[0];
  $('score-bravo').textContent = s.scores[1];
  const t = s.timeLeft;
  $('match-timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  $('match-timer').classList.toggle('urgent', t <= 60 && s.state === 'playing');

  // health
  const hp = Math.max(0, local.hp);
  $('health-bar').style.width = hp + '%';
  $('health-bar').style.background = hp > 55 ? 'linear-gradient(90deg,#22c55e,#4ade80)' : hp > 25 ? 'linear-gradient(90deg,#eab308,#facc15)' : 'linear-gradient(90deg,#dc2626,#ef4444)';
  $('health-num').textContent = Math.round(hp);
  $('lowhp').style.opacity = (!local.dead && hp <= 30) ? String(0.5 + 0.3 * Math.sin(now / 180)) : '0';

  // ammo
  const ammo = local.ammo[local.slot];
  const w = WEAPONS[local.slot];
  $('ammo-mag').textContent = ammo.mag;
  $('ammo-reserve').textContent = '/ ' + ammo.reserve;
  $('ammo-mag').classList.toggle('low', ammo.mag === 0);
  $('ammo-reserve').classList.toggle('low', ammo.reserve === 0);
  $('weapon-name').textContent = w.name;
  const slots = els.weaponSlots || (els.weaponSlots = $('weapon-slots').children);
  for (let i = 0; i < 3; i++) slots[i].classList.toggle('active', i === local.slot);
  $('reload-hint').textContent = local.reloading > 0 ? 'RELOADING…' : (ammo.mag === 0 && ammo.reserve > 0 ? 'PRESS R TO RELOAD' : '');

  // hitmarker
  const hm = $('hitmarker');
  if (now < hitmarkerUntil) {
    hm.style.opacity = String((hitmarkerUntil - now) / 180);
    hm.classList.toggle('hs', hitmarkerHs);
  } else hm.style.opacity = '0';

  // vignette fade
  if (now > vignetteUntil) els.vignette.style.opacity = '0';

  // killfeed cleanup
  for (let i = killfeedEntries.length - 1; i >= 0; i--) {
    if (now > killfeedEntries[i].until) { killfeedEntries[i].div.remove(); killfeedEntries.splice(i, 1); }
  }

  // crosshair dynamic spread (collapses to a dot while scoped)
  const speed = Math.hypot(local.vx, local.vz);
  const spreadPx = 6 + speed * 1.4 + (mouseDown ? 5 : 0) + (!local.dead && !local.onGround ? 6 : 0);
  const ch = $('crosshair');
  const chSize = (24 + spreadPx * 2) * (1 - adsSmooth) + 9 * adsSmooth;
  ch.style.width = chSize + 'px';
  ch.style.height = chSize + 'px';
  ch.style.opacity = (!local.dead && !state.paused) ? String(1 - 0.25 * adsSmooth) : '0.2';

  // connection quality
  const age = (now - state.lastSnapAt) / 1000;
  const cs = $('conn-status');
  if (age > 3) { cs.textContent = 'CONNECTION LOST'; cs.classList.add('bad'); }
  else { cs.textContent = `● online · ${MAP.name} · ping ~${state.pingMs}ms`; cs.classList.remove('bad'); }

  // death overlay
  if (local.dead && state.screen === 'playing') {
    els.death.classList.add('active');
    const k = killerByVictim.get(Net.myId);
    $('death-killer').textContent = k ? `Killed by ${k.name}${k.hs ? ' (headshot)' : ''}` : '';
    $('respawn-timer').textContent = Math.max(0, Math.ceil(local.respawnIn));
  } else {
    els.death.classList.remove('active');
  }

  // scoreboard (Tab)
  const showSb = keys.Tab && state.screen === 'playing';
  els.scoreboard.classList.toggle('active', showSb);
  if (showSb && state.scoreData) renderScoreboard();
}

function renderScoreboard() {
  const data = state.scoreData || [];
  const alpha = data.filter(r => r[1] === 0).sort((a, b) => b[2] - a[2]);
  const bravo = data.filter(r => r[1] === 1).sort((a, b) => b[2] - a[2]);
  const rows = (list) => list.map(r =>
    `<tr class="${r[0] === Net.name ? 'me' : ''}"><td>${esc(r[0])}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('');
  $('sb-content').innerHTML = `
    <div class="sb-team-title alpha">ALPHA — ${state.snap ? state.snap.scores[0] : 0}</div>
    <table class="sb-table"><tr><th>Player</th><th>Kills</th><th>Deaths</th></tr>${rows(alpha)}</table>
    <div class="sb-team-title bravo">BRAVO — ${state.snap ? state.snap.scores[1] : 0}</div>
    <table class="sb-table"><tr><th>Player</th><th>Kills</th><th>Deaths</th></tr>${rows(bravo)}</table>`;
}

// ---------------------------------------------------------------- screens / flow
function showScreen(name) {
  state.screen = name;
  els.menu.classList.toggle('active', name === 'menu');
  els.browser.classList.toggle('active', name === 'browser');
  els.lobby.classList.toggle('active', name === 'lobby');
  els.hud.classList.toggle('active', name === 'countdown' || name === 'playing');
  els.countdown.classList.toggle('active', name === 'countdown');
  if (name !== 'playing') {
    els.death.classList.remove('active');
    els.end.classList.toggle('active', name === 'ended');
  }
}

async function connectToServer() {
  setMenuStatus('Connecting to server…', '');
  try {
    await Net.connect();
    Net.send({ t: 'hello', name: Net.name });
    setMenuStatus('Connected.', 'ok');
    return true;
  } catch (e) {
    setMenuStatus(`Could not reach server (${SERVER_URL}). Is it running?`, 'err');
    return false;
  }
}

function setMenuStatus(msg, cls) {
  const el = $('menu-status');
  el.textContent = msg;
  el.className = 'status-line ' + (cls || '');
}

// --- menu
$('btn-play').addEventListener('click', async () => {
  AudioFX.init(); AudioFX.ui();
  Net.name = ($('name-input').value || 'Player').trim() || 'Player';
  localStorage.setItem('sz-name', Net.name);
  if (!Net.connected && !(await connectToServer())) return;
  showBrowser();
});
$('btn-quick').addEventListener('click', async () => {
  AudioFX.init(); AudioFX.ui();
  Net.name = ($('name-input').value || 'Player').trim() || 'Player';
  localStorage.setItem('sz-name', Net.name);
  if (!Net.connected && !(await connectToServer())) return;
  Net.send({ t: 'rooms' });
  quickMatch = true;
});
let quickMatch = false;

$('name-input').value = localStorage.getItem('sz-name') || '';
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-play').click(); });

// --- browser
function showBrowser() {
  showScreen('browser');
  const st = $('browser-status');
  st.textContent = '';
  st.className = 'status-line';
  Net.send({ t: 'rooms' });
}
$('btn-browser-back').addEventListener('click', () => { AudioFX.ui(); showScreen('menu'); });
$('btn-refresh').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'rooms' }); });
$('btn-create').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'create', name: Net.name }); });

function renderRooms(rooms) {
  const list = $('room-list');
  if (quickMatch) {
    quickMatch = false;
    const joinable = rooms.find(r => r.players < r.max && r.state !== 'ended');
    if (joinable) { Net.send({ t: 'join', id: joinable.id }); return; }
    Net.send({ t: 'create', name: Net.name });
    return;
  }
  if (!rooms.length) {
    list.innerHTML = '<div class="empty-note">No matches yet — create one!</div>';
    return;
  }
  list.innerHTML = '';
  for (const r of rooms) {
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `
      <div>
        <div style="font-weight:700">${esc(r.name)}</div>
        <div class="meta">${r.map} · ${r.players}/${r.max} players · A:${r.t0} B:${r.t1}</div>
      </div>
      <div style="display:flex;align-items:center;gap:0.6rem">
        <span class="badge ${r.state}">${r.state}</span>
        <button class="btn small">Join</button>
      </div>`;
    row.querySelector('button').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'join', id: r.id }); });
    list.appendChild(row);
  }
}

// --- lobby
function renderLobby(room) {
  state.room = room;
  for (const p of room.players) rosterNames.set(p.id, p.name);
  $('lobby-title').textContent = room.name + ' — ' + room.map;
  const lists = [$('team-list-0'), $('team-list-1')];
  lists.forEach(l => l.innerHTML = '');
  let myTeam = -1;
  for (const p of room.players) {
    if (p.id === room.you) myTeam = p.team;
    const d = document.createElement('div');
    d.innerHTML = esc(p.name) + (p.host ? ' <span class="host-tag">HOST</span>' : '') + (p.id === room.you ? ' (you)' : '');
    lists[p.team].appendChild(d);
  }
  state.myTeam = myTeam;
  $('team-card-0').classList.toggle('selected', myTeam === 0);
  $('team-card-1').classList.toggle('selected', myTeam === 1);
  const iAmHost = room.hostId === room.you;
  $('btn-start').style.display = iAmHost ? '' : 'none';
  const st = $('lobby-status');
  if (room.state === 'countdown') st.textContent = 'Match starting…';
  else if (room.state === 'ended') st.textContent = 'Match over — host can restart.';
  else st.textContent = iAmHost
    ? `Need ${MATCH.MIN_PLAYERS}+ players and both teams filled, then press Start.`
    : 'Waiting for the host to start the match…';
}
$('btn-team-0').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'team', team: 0 }); });
$('btn-team-1').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'team', team: 1 }); });
$('btn-start').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'start' }); });
$('btn-leave').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'leave' }); showBrowser(); Net.send({ t: 'rooms' }); });
$('btn-end-lobby').addEventListener('click', () => { AudioFX.ui(); showScreen('lobby'); });
$('btn-again').addEventListener('click', () => { AudioFX.ui(); Net.send({ t: 'restart' }); });
$('btn-disconnect').addEventListener('click', () => { AudioFX.ui(); Net.close(); location.reload(); });
$('btn-reconnect').addEventListener('click', () => location.reload());

function enterCountdown() {
  showScreen('countdown');
  els.pause.classList.remove('active');
  state.paused = false;
  requestLock();
  // build remotes from room info
  lastCountBeep = -1;
}
let lastCountBeep = -1;

function enterPlaying() {
  showScreen('playing');
  state.paused = document.pointerLockElement !== els.canvas;
  els.pause.classList.toggle('active', state.paused);
  if (!state.paused) requestLock();
  killerByVictim.clear();
  pendingInputs = [];
  local.dead = false;
}

function enterEnd(winner) {
  showScreen('ended');
  state.paused = true;
  if (document.pointerLockElement) document.exitPointerLock();
  const iAmHost = state.room && state.room.hostId === Net.myId;
  $('btn-again').style.display = iAmHost ? '' : 'none';
  const title = $('end-title');
  if (winner === -1) { title.textContent = 'Draw'; title.className = 'draw'; }
  else if (winner === state.myTeam) { title.textContent = 'Victory'; title.className = 'win'; }
  else { title.textContent = 'Defeat'; title.className = 'lose'; }
  const s = state.snap ? state.snap.scores : [0, 0];
  $('end-score').innerHTML = `<span style="color:var(--alpha)">${s[0]}</span> — <span style="color:var(--bravo)">${s[1]}</span>`;
  $('end-stats').textContent = `Your score: ${local.kills} kills / ${local.deaths} deaths`;
  AudioFX.matchEnd(winner === state.myTeam);
}

// ---------------------------------------------------------------- net message router
Net.onMsg = (m) => {
  switch (m.t) {
    case 'welcome': break;
    case 'helloOk': break;
    case 'rooms': if (state.screen === 'browser' || quickMatch) renderRooms(m.rooms); break;
    case 'room':
      if (m.state === 'lobby' || m.state === 'ended') {
        if (state.screen !== 'ended' || m.state === 'lobby') {
          if (state.screen !== 'playing' && state.screen !== 'countdown') {
            showScreen('lobby');
          }
        }
        renderLobby(m);
      } else {
        renderLobby(m); // keep room info fresh during countdown
      }
      break;
    case 'snap': handleSnapshot(m); break;
    case 'countdown': break;
    case 'leftRoom': break;
    case 'roomClosed': {
      // the room we were in was destroyed (its host left) — drop back to the
      // server browser no matter what screen we were on
      state.room = null;
      state.paused = true;
      if (document.pointerLockElement) document.exitPointerLock();
      showScreen('browser');
      const st = $('browser-status');
      st.textContent = m.reason || 'The room was closed.';
      st.className = 'status-line err';
      Net.send({ t: 'rooms' });
      break;
    }
    case 'error':
      if (state.screen === 'browser') setMenuStatus(m.msg, 'err');
      if (state.screen === 'lobby') $('lobby-status').textContent = m.msg;
      if (state.screen === 'menu') setMenuStatus(m.msg, 'err');
      break;
  }
};
Net.onClose = (ev) => {
  if (state.screen === 'menu' && !Net.connected) {
    setMenuStatus('Disconnected from server.', 'err');
    return;
  }
  els.reconnect.classList.add('active');
  $('reconnect-msg').textContent = ev && ev.code === 1008 ? 'Kicked by server (rate limit).' : 'The connection to the game server was lost.';
};

// ping measurement
setInterval(() => {
  if (!Net.connected) return;
  const t0 = performance.now();
  Net.send({ t: 'rooms' });
  const check = setInterval(() => {
    if (state.snap) { state.pingMs = Math.round(performance.now() - t0); clearInterval(check); }
  }, 30);
  setTimeout(() => clearInterval(check), 1500);
}, 4000);

// ---------------------------------------------------------------- main loop
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  // countdown ticking
  if (state.screen === 'countdown' && state.snap && state.snap.state === 'countdown') {
    const n = state.snap.timeLeft;
    $('countdown-num').textContent = Math.max(1, n);
    if (n !== lastCountBeep) { lastCountBeep = n; AudioFX.countdownBeep(n <= 1); }
  }

  // input
  if (state.screen === 'playing' && !state.paused && !local.dead) {
    sendInputAccum += dt;
    while (sendInputAccum >= 1 / SEND_HZ) {
      sendInputAccum -= 1 / SEND_HZ;
      sendInput(1 / SEND_HZ);
    }
  } else {
    // still keep yaw/pitch authority fresh, but no movement packets when dead/paused
  }

  // remotes
  updateRemotes(now);

  // aim-down-sights blend + FOV zoom
  const adsTarget = (aimDown && !local.dead && !state.paused && state.screen === 'playing') ? 1 : 0;
  adsSmooth += (adsTarget - adsSmooth) * Math.min(1, dt * 14);
  if (adsSmooth < 0.002) adsSmooth = 0;
  if (adsSmooth > 0.998) adsSmooth = 1;
  const targetFov = 75 - (75 - (WEAPONS[local.slot].adsFov || 55)) * adsSmooth;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }

  // camera
  const eye = eyeHeight(local.crouch);
  // view bob
  const speed = Math.hypot(local.vx, local.vz);
  if (local.onGround && speed > 0.6 && !local.dead) vmState.bobT += dt * speed * 1.5;
  const bobY = Math.sin(vmState.bobT * 2) * 0.028 * Math.min(1, speed / 6);
  const bobX = Math.cos(vmState.bobT) * 0.02 * Math.min(1, speed / 6);
  camera.position.set(local.x + bobX * 0.3, local.y + eye + bobY - (local.dead ? 1.1 : 0), local.z);

  // recoil spring recovery
  recoilState.pitch += recoilState.vPitch * dt * 12;
  recoilState.yaw += recoilState.vYaw * dt * 12;
  recoilState.vPitch *= Math.pow(0.0016, dt);
  recoilState.vYaw *= Math.pow(0.0016, dt);
  recoilState.pitch *= Math.pow(0.0022, dt);
  recoilState.yaw *= Math.pow(0.0022, dt);
  local.pitch = Math.max(-1.55, Math.min(1.55, local.pitch));

  camera.rotation.y = local.yaw + recoilState.yaw * 0.01;
  camera.rotation.x = local.pitch + recoilState.pitch * 0.01;
  if (local.dead) camera.rotation.z = 0.9; else camera.rotation.z = 0;

  // viewmodel
  const vmu = vmGroup.userData;
  vmState.kick += vmState.kickVel * dt;
  vmState.kickVel -= vmState.kick * 240 * dt;
  vmState.kickVel *= Math.pow(0.0009, dt);
  const targetKick = Math.max(0, vmState.kick) * 0.5;
  if (vmu.gun) {
    const swayScale = 1 - 0.7 * adsSmooth; // steadier while scoped
    const swayX = (local.yaw - lastCamYaw) * 8 * swayScale;
    const swayY = (local.pitch - lastCamPitch) * 8 * swayScale;
    // hip position (0.28, -0.26) blends to centered sight position when aiming
    const gx = 0.28 + (0 - 0.28) * adsSmooth;
    const gy = -0.26 + (-0.155 + 0.26) * adsSmooth;
    const bob = Math.sin(vmState.bobT * 2) * 0.008 * (1 - adsSmooth);
    vmu.gun.position.set(
      gx - Math.max(-0.05, Math.min(0.05, swayX)),
      gy - Math.max(-0.04, Math.min(0.04, swayY)) + bob,
      targetKick * (1 - 0.5 * adsSmooth)
    );
    // reload animation (dip + rotate)
    if (vmState.reloadDur > 0) {
      vmState.reloadT += dt;
      const p = Math.min(1, vmState.reloadT / vmState.reloadDur);
      const dip = Math.sin(p * Math.PI) * 0.35;
      vmu.gun.position.y -= dip;
      vmu.gun.rotation.x = Math.sin(p * Math.PI) * 0.7;
      if (p >= 1) { vmState.reloadDur = 0; vmu.gun.rotation.x = 0; AudioFX.reloadDone(); }
    }
    // hide vm when dead
    vmu.gun.visible = !local.dead;
  }
  if (vmu.flash) {
    vmu.flash.material.opacity = now < vmState.flashUntil ? 0.95 : 0;
  }
  vmLight.intensity *= Math.pow(0.001, dt);
  lastCamYaw = local.yaw; lastCamPitch = local.pitch;

  // effects
  cleanupEffects(now);

  // audio listener
  AudioFX.setListener(camera);

  // HUD
  if (state.screen === 'playing' || state.screen === 'countdown') updateHUD(now);

  renderer.render(scene, camera);
}
let sendInputAccum = 0;
let lastCamYaw = 0, lastCamPitch = 0;
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  // fake a short loading ramp so the arena compiles shaders first
  const bar = $('loading-bar');
  renderer.compile(scene, camera);
  for (let p = 0; p <= 100; p += 20) {
    bar.style.width = p + '%';
    await new Promise(r => setTimeout(r, 45));
  }
  els.loading.classList.remove('active');
  showScreen('menu');
})();
