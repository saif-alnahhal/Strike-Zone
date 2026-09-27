// StrikeZone — authoritative match engine.
// The server owns: positions, movement validation, shooting, hit detection,
// damage, health, death, respawn, weapons, ammo, score, teams, match state.
// Clients only send inputs and intents; nothing here trusts client claims.

import { MAP, TEAMS } from '../../shared/map.js';
import { WEAPONS, START_AMMO } from '../../shared/weapons.js';
import { PHYS, stepPlayer, rayBox, rayPlayer, hasLineOfSight, eyeHeight } from '../../shared/physics.js';
import { MATCH } from '../../shared/constants.js';

let nextRoomNum = 1;
function roomId() { return 'R' + (nextRoomNum++).toString(36).toUpperCase(); }

export function sanitizeName(n) {
  if (typeof n !== 'string') return 'Player';
  n = n.replace(/[^\w\-. \[\]()]/g, '').trim().slice(0, 16);
  return n.length ? n : 'Player';
}

export class Room {
  constructor(name, host) {
    this.id = roomId();
    this.name = sanitizeName(name) + "'s match";
    this.hostId = host.id;
    this.players = new Map();          // id -> player
    this.state = 'lobby';              // lobby | countdown | playing | ended
    this.tick = 0;
    this.scores = [0, 0];
    this.matchEndsAt = 0;              // Date.now() ms
    this.startAt = 0;
    this.winner = -1;
    this.events = [];                  // flushed into snapshots each tick
    this.lastUsed = Date.now();
  }

  addPlayer(conn) {
    if (this.players.size >= MATCH.MAX_PLAYERS) return false;
    const team = this.scores.length && this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
    const p = {
      id: conn.id, conn, name: conn.name, team,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true,
      yaw: 0, pitch: 0, crouch: false, ads: false,
      hp: MATCH.HP, dead: false, respawnAt: 0,
      weapons: START_AMMO.map(a => ({ ...a })),
      slot: 0, reloadEnd: 0, switchEnd: 0, lastShot: 0,
      kills: 0, deaths: 0,
      inputQueue: [], lastInputSeq: 0,
      lastMoveCheck: 0,
    };
    this.players.set(p.id, p);
    this.lastUsed = Date.now();
    if (this.state === 'playing') this.spawnPlayer(p);
    this.pushEvent({ e: 'join', id: p.id, name: p.name, team: p.team });
    this.broadcastRoomState();
    return true;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.pushEvent({ e: 'leave', id, name: p.name });
    // note: if the HOST leaves, the whole room is destroyed (see index.js) —
    // there is intentionally no host handover.
    this.broadcastRoomState();
    this.lastUsed = Date.now();
  }

  /** Destroy the room: notify everyone still inside and detach them. */
  close(reason) {
    const msg = JSON.stringify({ t: 'roomClosed', reason });
    for (const p of this.players.values()) {
      p.conn.room = null;
      try { p.conn.send(msg); } catch { /* socket closing */ }
    }
    this.players.clear();
    this.hostId = null;
  }

  teamCount(t) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t) n++;
    return n;
  }

  setTeam(id, team) {
    const p = this.players.get(id);
    if (!p || this.state === 'playing') return;
    team = team === 1 ? 1 : 0;
    // keep teams within 2 of each other
    const other = 1 - team;
    if (this.teamCount(team) - this.teamCount(other) >= 2) team = other;
    p.team = team;
    this.broadcastRoomState();
  }

  get hostPlayer() { return this.players.get(this.hostId); }

  tryStart(byId) {
    if (this.state !== 'lobby') return { ok: false, err: 'Match already running' };
    if (byId !== this.hostId) return { ok: false, err: 'Only the host can start the match' };
    if (this.players.size < MATCH.MIN_PLAYERS) return { ok: false, err: `Need at least ${MATCH.MIN_PLAYERS} players` };
    if (this.teamCount(0) === 0 || this.teamCount(1) === 0) return { ok: false, err: 'Both teams need at least one player' };
    this.state = 'countdown';
    this.startAt = Date.now() + MATCH.COUNTDOWN * 1000;
    // spawn everyone now so they stand at their spawns during the countdown
    for (const p of this.players.values()) this.spawnPlayer(p);
    this.broadcast({ t: 'countdown', at: this.startAt });
    this.broadcastRoomState();
    return { ok: true };
  }

  startMatch() {
    this.state = 'playing';
    this.scores = [0, 0];
    this.matchEndsAt = Date.now() + MATCH.MATCH_DURATION * 1000;
    // Mark everyone dead first so spawn-safety logic doesn't measure against
    // stale (0,0,0) positions of players that haven't spawned yet this match.
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.dead = true;
      p.weapons = START_AMMO.map(a => ({ ...a }));
      p.slot = 0; p.reloadEnd = 0; p.switchEnd = 0; p.lastShot = 0;
      p.inputQueue.length = 0;
    }
    for (const p of this.players.values()) this.spawnPlayer(p);
    this.pushEvent({ e: 'matchstart' });
    this.broadcastRoomState();
  }

  endMatch() {
    this.state = 'ended';
    this.winner = this.scores[0] === this.scores[1] ? -1 : (this.scores[0] > this.scores[1] ? 0 : 1);
    this.pushEvent({ e: 'matchend', winner: this.winner, scores: this.scores.slice() });
    this.broadcastRoomState();
  }

  restart(byId) {
    if (this.state !== 'ended') return { ok: false, err: 'Match is not over' };
    if (byId !== this.hostId) return { ok: false, err: 'Only the host can restart' };
    if (this.players.size < MATCH.MIN_PLAYERS) return { ok: false, err: 'Need more players to restart' };
    this.state = 'lobby';
    this.broadcastRoomState();
    return this.tryStart(byId);
  }

  // ---------- spawning ----------

  spawnPlayer(p) {
    const spawns = MAP.spawns[p.team];
    const enemies = [...this.players.values()].filter(q => q.team !== p.team && !q.dead);
    let best = spawns[0], bestScore = -Infinity;
    for (const s of spawns) {
      let minDist = Infinity, losPenalty = 0;
      for (const en of enemies) {
        const d = Math.hypot(en.x - s.x, en.z - s.z);
        if (d < minDist) minDist = d;
        const eye = eyeHeight(false);
        if (d < 30 && hasLineOfSight(s.x, eye, s.z, en.x, eye, en.z, MAP.boxes)) losPenalty += 1;
      }
      // prefer distance from enemies, heavily punish line-of-sight exposure,
      // light randomness so players don't all stack one point
      const score = (minDist === Infinity ? 60 : minDist) - losPenalty * 25 + Math.random() * 6;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    p.x = best.x; p.z = best.z; p.y = 0;
    p.vx = 0; p.vy = 0; p.vz = 0; p.onGround = true;
    p.hp = MATCH.HP; p.dead = false; p.respawnAt = 0;
    // face toward map center
    p.yaw = Math.atan2(-(0 - p.x), -(0 - p.z));
    p.pitch = 0;
    this.pushEvent({ e: 'respawn', id: p.id });
  }

  // ---------- input ----------

  handleInput(p, m) {
    // clamp everything; server never trusts raw client values
    const cl = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.max(lo, Math.min(hi, v)) : 0;
    const inp = {
      seq: (typeof m.seq === 'number' ? m.seq >>> 0 : 0),
      dt: cl(m.dt, 0.001, 0.05),
      fx: cl(m.fx, -1, 1), sx: cl(m.sx, -1, 1),
      yaw: cl(m.yaw, -Math.PI * 2, Math.PI * 2), pitch: cl(m.pitch, -1.55, 1.55),
      jump: !!m.jump, sprint: !!m.sprint, crouch: !!m.crouch,
      fire: !!m.fire, ads: !!m.ads,
      at: performance.now(),
    };
    p.inputQueue.push(inp);
    if (p.inputQueue.length > 12) p.inputQueue.splice(0, p.inputQueue.length - 12);
  }

  // ---------- shooting ----------

  tryFire(p) {
    const now = performance.now();
    if (p.dead || this.state !== 'playing') return;
    if (now < p.switchEnd || now < p.reloadEnd) return;
    const w = WEAPONS[p.slot];
    const interval = 60000 / w.rpm;
    if (now - p.lastShot < interval) return;
    const ammo = p.weapons[p.slot];
    if (ammo.mag <= 0) { this.tryReload(p); return; }
    p.lastShot = now;
    ammo.mag--;

    const eye = eyeHeight(p.crouch);
    const ox = p.x, oy = p.y + eye, oz = p.z;
    const cp = Math.cos(p.pitch);
    const baseDx = -Math.sin(p.yaw) * cp;
    const baseDy = Math.sin(p.pitch);
    const baseDz = -Math.cos(p.yaw) * cp;

    const moving = Math.hypot(p.vx, p.vz) > 1.5;
    let spread = w.spread * (moving ? w.moveSpreadMul : 1) * (!p.onGround ? w.airSpreadMul : 1);
    if (p.ads) spread *= w.adsSpreadMul; // aiming down sights: server-side accuracy bonus
    const spreadRad = spread * Math.PI / 180;

    // perpendicular basis around aim direction for cone sampling
    let upX = 0, upY = 1, upZ = 0;
    if (Math.abs(baseDy) > 0.9) { upX = 1; upY = 0; }
    let uX = upY * baseDz - upZ * baseDy, uY = upZ * baseDx - upX * baseDz, uZ = upX * baseDy - upY * baseDx;
    const ul = Math.hypot(uX, uY, uZ); uX /= ul; uY /= ul; uZ /= ul;
    const vX = baseDy * uZ - baseDz * uY, vY = baseDz * uX - baseDx * uZ, vZ = baseDx * uY - baseDy * uX;

    let tracerEnd = null;
    for (let i = 0; i < w.pellets; i++) {
      // random cone around aim direction
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spreadRad;
      const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      const dx = baseDx + uX * ca + vX * sa;
      const dy = baseDy + uY * ca + vY * sa;
      const dz = baseDz + uZ * ca + vZ * sa;
      const len = Math.hypot(dx, dy, dz);
      const nx = dx / len, ny = dy / len, nz = dz / len;
      const hit = this.hitscan(p, ox, oy, oz, nx, ny, dz / len, w);
      if (!tracerEnd || (hit && hit.dist < tracerEnd.dist)) {
        tracerEnd = hit || { dist: w.range };
      }
      if (hit && hit.player) {
        this.applyDamage(p, hit.player, hit.dmg, hit.headshot, w);
      }
    }
    if (!tracerEnd) tracerEnd = { dist: w.range };

    this.pushEvent({
      e: 'shot', id: p.id, w: p.slot,
      x: +ox.toFixed(2), y: +oy.toFixed(2), z: +oz.toFixed(2),
      dx: +baseDx.toFixed(3), dy: +baseDy.toFixed(3), dz: +baseDz.toFixed(3),
      ex: +(ox + baseDx * tracerEnd.dist).toFixed(2),
      ey: +(oy + baseDy * tracerEnd.dist).toFixed(2),
      ez: +(oz + baseDz * tracerEnd.dist).toFixed(2),
    });
  }

  hitscan(shooter, ox, oy, oz, dx, dy, dz, w) {
    // nearest wall
    let wallDist = w.range;
    for (const b of MAP.boxes) {
      const d = rayBox(ox, oy, oz, dx, dy, dz, wallDist, b);
      if (d >= 0 && d < wallDist) wallDist = d;
    }
    // nearest enemy player within wall distance
    let best = null;
    for (const q of this.players.values()) {
      if (q.id === shooter.id || q.dead || q.team === shooter.team) continue;
      const hit = rayPlayer(ox, oy, oz, dx, dy, dz, wallDist, q);
      if (hit && (!best || hit.dist < best.dist)) best = { player: q, ...hit };
    }
    if (!best) return null;
    const h = best.player.crouch ? PHYS.CROUCH_H : PHYS.STAND_H;
    const headshot = best.y > best.player.y + h - 0.38;
    let dmg = w.dmg * (headshot ? w.headMul : 1);
    const t = Math.min(1, best.dist / w.range);
    dmg *= 1 - (1 - w.falloff) * t; // distance falloff
    return { dist: best.dist, player: best.player, dmg, headshot };
  }

  applyDamage(shooter, victim, dmg, headshot, w) {
    dmg = Math.round(dmg);
    victim.hp -= dmg;
    this.pushEvent({ e: 'hit', by: shooter.id, victim: victim.id, dmg, hs: headshot ? 1 : 0 });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.dead = true;
      victim.deaths++;
      victim.respawnAt = Date.now() + MATCH.RESPAWN_DELAY * 1000;
      victim.inputQueue.length = 0;
      shooter.kills++;
      this.scores[shooter.team]++;
      this.pushEvent({ e: 'kill', killer: shooter.id, killerName: shooter.name, victim: victim.id, victimName: victim.name, w: w.slot, hs: headshot ? 1 : 0 });
      if (this.scores[shooter.team] >= MATCH.SCORE_LIMIT) this.endMatch();
    }
  }

  tryReload(p) {
    const now = performance.now();
    if (p.dead || this.state !== 'playing') return;
    if (now < p.reloadEnd || now < p.switchEnd) return;
    const w = WEAPONS[p.slot];
    const ammo = p.weapons[p.slot];
    if (ammo.mag >= w.mag || ammo.reserve <= 0) return;
    p.reloadEnd = now + w.reload * 1000;
    this.pushEvent({ e: 'reload', id: p.id, w: p.slot });
  }

  trySwitch(p, slot) {
    const now = performance.now();
    if (p.dead || this.state !== 'playing') return;
    slot = slot >>> 0;
    if (slot >= WEAPONS.length || slot === p.slot) return;
    if (now < p.switchEnd) return;
    p.slot = slot;
    p.reloadEnd = 0;
    p.switchEnd = now + WEAPONS[slot].switchTime * 1000;
    this.pushEvent({ e: 'switch', id: p.id, w: slot });
  }

  // ---------- simulation ----------

  update(nowMs) {
    if (this.state === 'countdown' && nowMs >= this.startAt) this.startMatch();

    if (this.state === 'playing') {
      const now = performance.now();
      for (const p of this.players.values()) {
        if (p.dead) {
          if (nowMs >= p.respawnAt) this.spawnPlayer(p);
          continue;
        }
        // Consume queued inputs, bounded by SIM time per tick (≈1.25× realtime).
        // Speed-hack protection comes from: dt clamped in handleInput, this sim
        // budget, the 12-deep queue cap, and the hard velocity clamp in
        // stepPlayer — NOT from position resets, which would fight legitimate
        // collision push-outs and freeze players in tight spots.
        let simBudget = 0.0417; // seconds of simulation allowed this tick (30Hz)
        while (simBudget > 0.0001 && p.inputQueue.length) {
          const inp = p.inputQueue.shift();
          p.lastInputSeq = inp.seq;
          if (now - inp.at > 300) continue; // stale, drop
          const dt = Math.min(inp.dt, simBudget);
          simBudget -= dt;
          stepPlayer(p, inp, dt, MAP.boxes, MAP.bounds);
          p.yaw = inp.yaw;
          p.pitch = inp.pitch;
          p.crouch = inp.crouch;
          p.ads = inp.ads;
          // autofire for held trigger on automatic weapons
          if (inp.fire && WEAPONS[p.slot].auto) this.tryFire(p);
        }
        // reload completion
        if (p.reloadEnd && now >= p.reloadEnd) {
          const w = WEAPONS[p.slot];
          const ammo = p.weapons[p.slot];
          const need = w.mag - ammo.mag;
          const take = Math.min(need, ammo.reserve);
          ammo.mag += take; ammo.reserve -= take;
          p.reloadEnd = 0;
        }
      }
      if (nowMs >= this.matchEndsAt) this.endMatch();
    }
    this.tick++;
    this.lastUsed = Date.now();
  }

  pushEvent(ev) { this.events.push(ev); }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      try { p.conn.send(s); } catch { /* socket closing */ }
    }
  }

  broadcastRoomState() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, host: p.id === this.hostId,
      kills: p.kills, deaths: p.deaths,
    }));
    // each client needs to know which id is theirs
    for (const p of this.players.values()) {
      try { p.conn.send(JSON.stringify({ t: 'room', id: this.id, name: this.name, state: this.state, hostId: this.hostId, players, scores: this.scores, you: p.id, cfg: { duration: MATCH.MATCH_DURATION, limit: MATCH.SCORE_LIMIT, countdown: MATCH.COUNTDOWN }, map: MAP.name })); } catch { }
    }
  }

  // per-player snapshot at tick rate
  buildSnapshot(p) {
    const nowMs = Date.now();
    const players = [];
    for (const q of this.players.values()) {
      if (q.id === p.id) continue;
      players.push([
        q.id,
        +q.x.toFixed(2), +q.y.toFixed(2), +q.z.toFixed(2),
        +q.yaw.toFixed(3), +q.pitch.toFixed(3),
        q.hp, q.team, q.dead ? 1 : 0, q.crouch ? 1 : 0, q.slot,
      ]);
    }
    const ev = this.events;
    const scoreboard = (this.tick % 15 === 0)
      ? [...this.players.values()].map(q => [q.name, q.team, q.kills, q.deaths])
      : null;
    const me = {
      seq: p.lastInputSeq,
      x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
      vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2), vz: +p.vz.toFixed(2),
      hp: p.hp, dead: p.dead ? 1 : 0, slot: p.slot,
      ammo: p.weapons.map(a => [a.mag, a.reserve]),
      reloading: p.reloadEnd ? +((p.reloadEnd - performance.now()) / 1000).toFixed(2) : 0,
      kills: p.kills, deaths: p.deaths,
      respawnIn: p.dead ? +((p.respawnAt - nowMs) / 1000).toFixed(1) : 0,
    };
    return {
      t: 'snap', tick: this.tick, now: nowMs,
      state: this.state,
      scores: this.scores,
      timeLeft: this.state === 'playing' ? Math.max(0, Math.round((this.matchEndsAt - nowMs) / 1000)) : (this.state === 'countdown' ? Math.max(0, Math.round((this.startAt - nowMs) / 1000)) : MATCH.MATCH_DURATION),
      me, players, ev, sb: scoreboard,
      winner: this.winner,
    };
  }

  sendSnapshots() {
    if (this.state !== 'lobby') {
      for (const p of this.players.values()) {
        try { p.conn.send(JSON.stringify(this.buildSnapshot(p))); } catch { }
      }
      this.events = [];
    } else if (this.events.length > 200) {
      // lobby: keep events (join/leave) until the first snapshot flushes them,
      // but never let the buffer grow unbounded
      this.events.splice(0, this.events.length - 200);
    }
  }

  publicInfo() {
    return {
      id: this.id, name: this.name, state: this.state,
      players: this.players.size, max: MATCH.MAX_PLAYERS,
      t0: this.teamCount(0), t1: this.teamCount(1), map: MAP.name,
    };
  }
}
