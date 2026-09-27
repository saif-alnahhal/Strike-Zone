// StrikeZone — end-to-end multiplayer test.
// Boots the real server and connects multiple real WebSocket clients.
// Verifies: room create/join, match start, movement sync, authoritative
// combat (hits/kills/score), respawn, disconnect handling, input validation.
//
// Run: node test/multiplayer_test.js

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { MAP } from '../shared/map.js';
import { hasLineOfSight, eyeHeight } from '../shared/physics.js';

const PORT = 3123;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0, failed = 0;
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(condFn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = condFn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

class TestClient {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.ws = new WebSocket(URL);
    this.ws.on('message', (d) => { try { this.msgs.push(JSON.parse(d.toString())); } catch { } });
    this.send = (o) => { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); };
    this.lastSnap = null;
    this.me = null;
    this.open = once(this.ws, 'open');
    const iv = setInterval(() => {
      const s = this.latest('snap');
      if (s) { this.lastSnap = s; this.me = s.me; }
    }, 50);
    this.ws.on('close', () => clearInterval(iv));
  }
  latest(t) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i]; return null; }
  eventsOfType(e) { return this.msgs.filter(m => m.t === 'snap' && m.ev).flatMap(m => m.ev).filter(ev => ev.e === e); }
  close() { try { this.ws.close(); } catch { } }
}

async function main() {
  console.log('Starting server on port', PORT, '…');
  const server = spawn('node', ['server/src/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SCORE_LIMIT: '3', MATCH_COUNTDOWN: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`  [server:err] ${d}`));
  await sleep(800);

  const clients = [];
  try {
    // ---------- 1. connections ----------
    console.log('\n[1] Connecting 3 clients…');
    const a = new TestClient('AlphaOne'); clients.push(a);
    const b = new TestClient('BravoOne'); clients.push(b);
    const c = new TestClient('BravoTwo'); clients.push(c);
    await Promise.all(clients.map(cl => cl.open));
    for (const cl of clients) {
      cl.send({ t: 'hello', name: cl.name });
      await waitFor(() => cl.latest('welcome'), 3000, 'welcome');
    }
    check('3 clients connected + welcomed', clients.every(cl => cl.latest('welcome')));

    // ---------- 2. room create / join ----------
    console.log('\n[2] Room create + join + browser…');
    a.send({ t: 'create', name: 'Tester' });
    const roomMsg = await waitFor(() => a.latest('room'), 3000, 'room state');
    check('room created', !!roomMsg && roomMsg.state === 'lobby', JSON.stringify(roomMsg));
    const roomId = roomMsg.id;

    b.send({ t: 'rooms' });
    const roomsList = await waitFor(() => b.latest('rooms'), 3000, 'rooms list');
    check('server browser lists the room', roomsList.rooms.some(r => r.id === roomId));

    b.send({ t: 'join', id: roomId });
    c.send({ t: 'join', id: roomId });
    await waitFor(() => {
      const r = a.latest('room');
      return r && r.players.length === 3;
    }, 3000, '3 players in room');
    check('both players joined (3 in room)', a.latest('room').players.length === 3);
    const teams = new Set(a.latest('room').players.map(p => p.team));
    check('players auto-assigned to both teams', teams.size === 2);

    // ---------- 3. start rules ----------
    console.log('\n[3] Start permission + countdown…');
    b.send({ t: 'start' });
    await sleep(300);
    const err = b.msgs.find(m => m.t === 'error');
    check('non-host cannot start (server rejects)', !!err, JSON.stringify(err));
    a.send({ t: 'start' });
    await waitFor(() => a.latest('room')?.state === 'countdown', 3000, 'countdown state');
    check('host started match → countdown', true);
    await waitFor(() => a.latest('snap')?.state === 'playing', 12000, 'match playing');
    check('match reached playing state', true);

    // ---------- 4. movement sync between clients ----------
    console.log('\n[4] Movement: client B sees client A move…');
    // wait until A's real spawn position is reflected (not the 0,0,0 countdown default)
    await waitFor(() => a.me && (a.me.x !== 0 || a.me.z !== 0), 3000, 'A spawn position');
    const aStart = { ...a.me };
    // pick the cardinal direction with clear space — probe with 3 parallel
    // rays (player is 0.7m wide, a single center ray can squeeze past corners)
    const eye = aStart.y + 1.0;
    const probeClear = (dx, dz) => {
      const px = dz !== 0 ? 0.36 : 0, pz = dx !== 0 ? 0.36 : 0; // perpendicular offsets
      for (const off of [-1, 0, 1]) {
        const ox = aStart.x + px * off, oz = aStart.z + pz * off;
        if (!hasLineOfSight(ox, eye, oz, ox + dx, eye, oz + dz, MAP.boxes)) return false;
      }
      return true;
    };
    const probes = [
      { yaw: 0, dx: 0, dz: -8, name: 'north' },
      { yaw: Math.PI, dx: 0, dz: 8, name: 'south' },
      { yaw: Math.PI / 2, dx: -8, dz: 0, name: 'west' },
      { yaw: -Math.PI / 2, dx: 8, dz: 0, name: 'east' },
    ];
    let best = null;
    for (const p of probes) {
      if (probeClear(p.dx, p.dz)) { best = p; break; }
    }
    const moveYaw = best ? best.yaw : 0;
    console.log(`    A starts at (${aStart.x.toFixed(2)}, ${aStart.z.toFixed(2)}), moving ${best ? best.name : 'north'}`);
    // A walks for 1 second
    const moveInputs = setInterval(() => {
      a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: 1, sx: 0, yaw: moveYaw, pitch: 0, jump: false, sprint: true, crouch: false, fire: false });
    }, 50);
    for (let k = 0; k < 5; k++) {
      await sleep(200);
      console.log(`    t=${(k + 1) * 200}ms A=(${a.me.x.toFixed(2)}, ${a.me.z.toFixed(2)}) seq=${a.me.seq}`);
    }
    clearInterval(moveInputs);
    await sleep(300);
    const movedDist = Math.hypot(a.me.x - aStart.x, a.me.z - aStart.z);
    check(`A moved on server (${movedDist.toFixed(1)}m)`, movedDist > 3, `moved ${movedDist}`);
    const bView = b.lastSnap.players.find(p => p[0] === a.latest('welcome').id);
    check('B received A position in snapshots', !!bView, JSON.stringify(bView));
    if (bView) {
      const diff = Math.hypot(bView[1] - a.me.x, bView[3] - a.me.z);
      check(`B's copy of A matches server (<1m, got ${diff.toFixed(2)}m)`, diff < 1);
    }

    // ---------- 4b. ADS movement penalty (server-authoritative) ----------
    console.log('\n[4b] Aim-down-sights slows movement…');
    // first bleed off velocity from the previous sprint (idle inputs, friction)
    const brakeInputs = setInterval(() => {
      a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: 0, sx: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, fire: false });
    }, 50);
    await sleep(400);
    clearInterval(brakeInputs);
    const adsStart = { ...a.me };
    // pick the direction with the longest verified reach (3 parallel rays per probe)
    const reachOf = (dxn, dzn) => {
      const px = dzn !== 0 ? 0.36 : 0, pz = dxn !== 0 ? 0.36 : 0;
      let reach = 0;
      for (let d = 2; d <= 10; d += 2) {
        let clear = true;
        for (const off of [-1, 0, 1]) {
          const ox = adsStart.x + px * off, oz = adsStart.z + pz * off;
          if (!hasLineOfSight(ox, adsStart.y + 1.0, oz, ox + dxn * d, adsStart.y + 1.0, oz + dzn * d, MAP.boxes)) { clear = false; break; }
        }
        if (!clear) break;
        reach = d;
      }
      return reach;
    };
    const dirs = [
      { yaw: 0, dx: 0, dz: -1 }, { yaw: Math.PI, dx: 0, dz: 1 },
      { yaw: Math.PI / 2, dx: -1, dz: 0 }, { yaw: -Math.PI / 2, dx: 1, dz: 0 },
    ].map(d => ({ ...d, reach: reachOf(d.dx, d.dz) }));
    const adsDir = dirs.reduce((m, d) => (d.reach > m.reach ? d : m));
    if (adsDir.reach >= 4) {
      const adsInputs = setInterval(() => {
        a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: 1, sx: 0, yaw: adsDir.yaw, pitch: 0, jump: false, sprint: true, crouch: false, fire: false, ads: true });
      }, 50);
      await sleep(600);
      clearInterval(adsInputs);
      await sleep(250);
      const adsDist = Math.hypot(a.me.x - adsStart.x, a.me.z - adsStart.z);
      // ADS sprint cap: 8.3 * 0.65 = 5.4 m/s → ~3.1m in 0.6s from standstill
      // (plain sprint from standstill would be ~4.8m)
      check(`ADS sprint is slower (${adsDist.toFixed(2)}m in 0.6s, expect ~3.1m not ~4.8m)`, adsDist > 2.2 && adsDist < 4.0);
    } else {
      check('ADS sprint is slower (skipped, no open direction)', true);
    }

    // ---------- 5. collision: cannot walk through walls ----------
    console.log('\n[5] Collision: player cannot leave the arena…');
    const wallInputs = setInterval(() => {
      a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: 1, sx: 0, yaw: Math.PI / 2, pitch: 0, jump: false, sprint: true, crouch: false, fire: false }); // run west into perimeter
    }, 50);
    await sleep(3000);
    clearInterval(wallInputs);
    check(`A blocked by perimeter wall (x=${a.me.x.toFixed(1)})`, a.me.x > MAP.bounds.minX - 0.1);

    // ---------- 6. authoritative combat ----------
    console.log('\n[6] Combat: A hunts B, server registers hits/kill/score…');
    const aId = a.latest('welcome').id;
    const bId = b.latest('welcome').id;
    // A hunts B: walk toward B until LOS, then hold trigger.
    // Detours via a building doorway when the center blocks the way; once the
    // detour starts it commits (latch) so physics sliding carries A around
    // corners until line of sight opens.
    const DOORS = [{ x: 0, z: -6 }, { x: 0, z: 6 }, { x: -6, z: 0 }, { x: 6, z: 0 }];
    function startHunt() {
      let routed = false; // latched once we've committed to pushing at B
      let lastPos = null, lastPosT = Date.now(), unstickUntil = 0, strafeDir = 1;
      const hunt = setInterval(() => {
        if (!a.me || a.lastSnap?.state !== 'playing') return;
        const bv = a.lastSnap.players.find(p => p[0] === bId);
        if (!bv) return;
        const bx = bv[1], bz = bv[3], bDead = bv[8];
        const dx = bx - a.me.x, dz = bz - a.me.z;
        const dist = Math.hypot(dx, dz);
        const los = !bDead && dist < 60 && hasLineOfSight(a.me.x, a.me.y + eyeHeight(false), a.me.z, bx, bv[2] + eyeHeight(false), bz, MAP.boxes);
        // unstuck: if we haven't made progress in 1.5s, strafe away for 0.8s
        const nowT = Date.now();
        if (lastPos && nowT - lastPosT > 1500) {
          // stuck if we barely moved while NOT in firing position (dist<=6 means we're holding to shoot, which is fine)
          if (Math.hypot(a.me.x - lastPos.x, a.me.z - lastPos.z) < 0.6 && !(los && dist <= 6)) {
            unstickUntil = nowT + 800;
            strafeDir = -strafeDir;
          }
          lastPos = { x: a.me.x, z: a.me.z }; lastPosT = nowT;
        } else if (!lastPos) { lastPos = { x: a.me.x, z: a.me.z }; lastPosT = nowT; }
        if (nowT < unstickUntil) {
          a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: -0.4, sx: strafeDir, yaw: Math.atan2(-dx, -dz), pitch: 0, jump: false, sprint: true, crouch: false, fire: false });
          return;
        }
        let tx = bx, tz = bz;
        if (!los && !routed) {
          // pick doorway minimizing total path cost
          let best = null, bc = Infinity;
          for (const d of DOORS) {
            const cost = Math.hypot(d.x - a.me.x, d.z - a.me.z) + Math.hypot(bx - d.x, bz - d.z);
            if (cost < bc) { bc = cost; best = d; }
          }
          if (Math.hypot(best.x - a.me.x, best.z - a.me.z) < 2.5) routed = true;
          else { tx = best.x; tz = best.z; }
        }
        const yawTo = Math.atan2(-(tx - a.me.x), -(tz - a.me.z));
        if (los && dist < 40) {
          a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: dist > 6 ? 1 : 0, sx: 0, yaw: yawTo, pitch: 0, jump: false, sprint: false, crouch: false, fire: true });
        } else {
          a.send({ t: 'input', seq: (a.seq = (a.seq || 0) + 1), dt: 0.05, fx: 1, sx: 0, yaw: yawTo, pitch: 0, jump: false, sprint: true, crouch: false, fire: false });
        }
      }, 50);
      // B walks to the map center (open ground) and waits there — keeps the
      // fight away from spawn pockets so the dumb bots converge reliably.
      const idle = setInterval(() => {
        if (!b.me) return;
        const dc = Math.hypot(b.me.x, b.me.z);
        if (dc > 2.5) {
          // face the origin: forward = (-sin yaw, -cos yaw) ∝ (-x, -z) → yaw = atan2(x, z)
          const yawC = Math.atan2(b.me.x, b.me.z);
          b.send({ t: 'input', seq: (b.seq = (b.seq || 0) + 1), dt: 0.05, fx: 1, sx: 0, yaw: yawC, pitch: 0, jump: false, sprint: true, crouch: false, fire: false });
        } else {
          b.send({ t: 'input', seq: (b.seq = (b.seq || 0) + 1), dt: 0.05, fx: 0, sx: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, fire: false });
        }
      }, 50);
      return () => { clearInterval(hunt); clearInterval(idle); };
    }
    const stopHunt = startHunt();

    let killEv = null;
    try {
      killEv = await waitFor(() => a.eventsOfType('kill').find(e => e.killer === aId && e.victim === bId), 45000, 'kill event');
    } catch (e) {
      stopHunt();
      throw e;
    }
    stopHunt();
    check('server registered kill A→B', !!killEv, JSON.stringify(killEv));
    check('killfeed event has names + weapon', killEv.killerName === 'AlphaOne' && killEv.victimName === 'BravoOne' && typeof killEv.w === 'number');
    const aTeam = a.latest('room').players.find(p => p.id === aId).team;
    const scoredSnap = await waitFor(() => {
      const s = a.latest('snap');
      return s && s.scores[aTeam] >= 1 ? s : null;
    }, 3000, 'score increment in snapshot');
    check(`team score incremented (${JSON.stringify(scoredSnap.scores)})`, scoredSnap.scores[aTeam] === 1 && scoredSnap.scores[1 - aTeam] === 0);
    const hitEvs = a.eventsOfType('hit').filter(e => e.by === aId);
    check(`hit events delivered (${hitEvs.length}, headshots allowed)`, hitEvs.length >= 2);

    // B saw itself die
    await waitFor(() => b.me && b.me.dead === 1, 3000, 'B dead flag');
    check('victim client marked dead by server', b.me.dead === 1);

    // ---------- 7. respawn ----------
    console.log('\n[7] Respawn after death…');
    const respawnEv = await waitFor(() => b.eventsOfType('respawn').length >= 1, 8000, 'respawn event');
    check('respawn event sent', !!respawnEv);
    await waitFor(() => b.me && b.me.dead === 0 && b.me.hp === 100, 4000, 'B alive again');
    check('B alive again with full HP at team spawn', b.me.hp === 100 && Math.abs(b.me.x) > 15);

    // ---------- 8. security: server ignores fake state ----------
    console.log('\n[8] Security: server ignores client state injection…');
    const snapIdxBefore = a.msgs.length;
    a.send({ t: 'setHp', hp: 9999 });
    a.send({ t: 'snap', me: { hp: 9999 } });
    a.send({ t: 'kill', victim: bId });
    a.send({ t: 'input', seq: 1e9, dt: 999, fx: 999, sx: NaN, yaw: 'x', pitch: null, jump: 'yes', sprint: 1, crouch: 0, fire: 1 });
    await sleep(500);
    check('server still alive after malformed/cheat messages', a.msgs.length > snapIdxBefore);
    check('no fake HP applied', a.me.hp <= 100 && isFinite(a.me.x) && isFinite(a.me.z));
    check('no fake kills/score applied', a.lastSnap.scores.reduce((x, y) => x + y, 0) < 5);

    // ---------- 9. disconnect handling ----------
    console.log('\n[9] Disconnect: C leaves, match continues…');
    const cId = c.latest('welcome').id;
    const snapCountBefore = a.msgs.filter(m => m.t === 'snap').length;
    c.close();
    await waitFor(() => a.eventsOfType('leave').some(e => e.id === cId), 4000, 'leave event for C');
    check('remaining players notified of disconnect', true);
    await waitFor(() => a.latest('room') && a.latest('room').players.length === 2, 3000, 'room now 2 players');
    check('room roster updated to 2 players', a.latest('room').players.length === 2);
    await sleep(600);
    const snapCountAfter = a.msgs.filter(m => m.t === 'snap').length;
    check('match keeps running after disconnect', snapCountAfter > snapCountBefore + 5);

    // ---------- 10. match timer ----------
    console.log('\n[10] Match timer counts down…');
    const t1 = a.lastSnap.timeLeft;
    await sleep(2200);
    const t2 = a.lastSnap.timeLeft;
    check(`timer decreased (${t1} → ${t2})`, t2 < t1);

    // ---------- 11. match end at score limit + restart ----------
    // (test server runs with SCORE_LIMIT=3; A already has 1 kill)
    console.log('\n[11] Match ends at score limit, host restarts…');
    const stopHunt2 = startHunt();
    try {
      const t0 = Date.now();
      let ended = false;
      while (Date.now() - t0 < 90000) {
        if (a.latest('snap')?.state === 'ended') { ended = true; break; }
        await sleep(5000);
        const s = a.latest('snap');
        const bv2 = s && s.players.find(p => p[0] === bId);
        if (s) console.log(`    …scores=${JSON.stringify(s.scores)} A=(${a.me.x.toFixed(0)},${a.me.z.toFixed(0)}) B=(${bv2 ? bv2[1].toFixed(0) + ',' + bv2[3].toFixed(0) + ' dead=' + bv2[8] : '?'}) hp=${a.me.hp} ammo=${a.me.ammo[0]}`);
      }
      if (!ended) throw new Error('match did not end within 90s');
    } finally {
      stopHunt2();
    }
    check('match ended when score limit reached', a.latest('snap').state === 'ended');
    const aTeam2 = a.latest('room').players.find(p => p.id === aId).team;
    check(`winner is A's team (${a.latest('snap').winner})`, a.latest('snap').winner === aTeam2);
    const endScores = a.latest('snap').scores;
    check(`final score ${JSON.stringify(endScores)} at limit`, endScores[aTeam2] === 3);
    // non-host cannot restart
    b.send({ t: 'restart' });
    await sleep(250);
    check('non-host restart rejected', a.latest('snap').state === 'ended');
    // host restarts
    a.send({ t: 'restart' });
    await waitFor(() => ['countdown', 'playing'].includes(a.latest('snap')?.state), 5000, 'restart countdown');
    check('host restarted → new match countdown', true);
    await waitFor(() => a.latest('snap')?.state === 'playing', 10000, 'restarted match playing');
    check('restarted match is playing with reset scores', a.latest('snap').scores[0] === 0 && a.latest('snap').scores[1] === 0);

    // ---------- 12. host leaving destroys the room ----------
    console.log('\n[12] Host leaves → room deleted, others notified…');
    a.send({ t: 'leave' }); // a is the host, mid-match
    await waitFor(() => b.msgs.some(m => m.t === 'roomClosed'), 3000, 'roomClosed message for B');
    const closedMsg = b.msgs.find(m => m.t === 'roomClosed');
    check('remaining player received roomClosed', !!closedMsg, JSON.stringify(closedMsg));
    check('roomClosed carries a reason', typeof closedMsg.reason === 'string' && closedMsg.reason.length > 0);
    b.send({ t: 'rooms' });
    await waitFor(() => {
      const list = b.latest('rooms');
      return list && !list.rooms.some(r => r.id === roomId);
    }, 3000, 'room gone from server browser');
    check('room removed from server browser list', true);
    // B can immediately create a fresh room (server state is clean)
    b.send({ t: 'create', name: 'BravoOne' });
    const newRoom = await waitFor(() => {
      const r = b.latest('room');
      return r && r.id !== roomId ? r : null;
    }, 3000, 'B creates a new room');
    check('former member can create a new room afterwards', newRoom.hostId === b.latest('welcome').id);
    console.log(`\n─────────────────────────────\nRESULT: ${passed} passed, ${failed} failed`);
  } catch (e) {
    console.error('\nTEST FAILURE:', e.message);
    failed++;
  } finally {
    for (const cl of clients) cl.close();
    server.kill('SIGTERM');
    await sleep(200);
  }
  process.exit(failed ? 1 : 0);
}

main();
