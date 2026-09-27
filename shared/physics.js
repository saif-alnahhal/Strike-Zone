// StrikeZone — shared deterministic player physics.
// The server runs this authoritatively; the client runs the SAME code for
// client-side prediction + reconciliation, so both sides agree.

export const PHYS = {
  GRAVITY: 24,
  JUMP: 8.2,
  WALK: 5.4,
  SPRINT: 8.3,
  CROUCH: 2.6,
  ACCEL: 60,
  AIR_ACCEL: 14,
  FRICTION: 12,
  RADIUS: 0.35,
  STAND_H: 1.7,
  CROUCH_H: 1.2,
  EYE_STAND: 1.6,
  EYE_CROUCH: 1.12,
  MAX_FALL: 42,
  ADS_SPEED: 0.65, // movement speed multiplier while aiming down sights
};

function overlaps(px, py, pz, h, b) {
  const r = PHYS.RADIUS;
  return (
    px + r > b.x - b.w / 2 && px - r < b.x + b.w / 2 &&
    pz + r > b.z - b.d / 2 && pz - r < b.z + b.d / 2 &&
    py + h > b.y - b.h / 2 && py < b.y + b.h / 2
  );
}

function resolveAxis(p, h, axis, boxes, bounds) {
  for (const b of boxes) {
    if (!overlaps(p.x, p.y, p.z, h, b)) continue;
    if (axis === 'x') {
      if (p.vx > 0) p.x = b.x - b.w / 2 - PHYS.RADIUS - 0.001;
      else if (p.vx < 0) p.x = b.x + b.w / 2 + PHYS.RADIUS + 0.001;
      p.vx = 0;
    } else if (axis === 'z') {
      if (p.vz > 0) p.z = b.z - b.d / 2 - PHYS.RADIUS - 0.001;
      else if (p.vz < 0) p.z = b.z + b.d / 2 + PHYS.RADIUS + 0.001;
      p.vz = 0;
    } else {
      if (p.vy <= 0) {
        // landed on top
        p.y = b.y + b.h / 2;
        p.vy = 0;
        p.onGround = true;
      } else {
        // bumped head
        p.y = b.y - b.h / 2 - h - 0.001;
        p.vy = 0;
      }
    }
  }
  if (axis === 'x') p.x = Math.max(bounds.minX, Math.min(bounds.maxX, p.x));
  if (axis === 'z') p.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, p.z));
}

/**
 * Advance player `p` one step.
 * p: { x,y,z, vx,vy,vz, onGround }
 * inp: { fx, sx (strafe), yaw, jump, sprint, crouch } with fx/sx in [-1,1]
 * Mutates p in place. Fully deterministic given identical inputs.
 */
export function stepPlayer(p, inp, dt, boxes, bounds) {
  dt = Math.max(0.001, Math.min(dt, 0.05));
  const h = inp.crouch ? PHYS.CROUCH_H : PHYS.STAND_H;

  const sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
  // World-space wish direction from view yaw (three.js convention: -Z forward)
  const wx = -sin * inp.fx + cos * inp.sx;
  const wz = -cos * inp.fx - sin * inp.sx;
  const wl = Math.hypot(wx, wz);

  const moving = wl > 0.01;
  let speed = inp.crouch ? PHYS.CROUCH
    : (inp.sprint && inp.fx > 0.5 && p.onGround) ? PHYS.SPRINT
    : PHYS.WALK;
  if (inp.ads) speed *= PHYS.ADS_SPEED; // aiming down sights slows you down

  if (moving) {
    const ax = wx / wl, az = wz / wl;
    const a = p.onGround ? PHYS.ACCEL : PHYS.AIR_ACCEL;
    p.vx += ax * a * dt;
    p.vz += az * a * dt;
    const hs = Math.hypot(p.vx, p.vz);
    if (hs > speed) { p.vx *= speed / hs; p.vz *= speed / hs; }
  } else if (p.onGround) {
    const f = Math.max(0, 1 - PHYS.FRICTION * dt);
    p.vx *= f; p.vz *= f;
    if (Math.abs(p.vx) < 0.02) p.vx = 0;
    if (Math.abs(p.vz) < 0.02) p.vz = 0;
  }

  if (inp.jump && p.onGround) {
    p.vy = PHYS.JUMP;
    p.onGround = false;
  }

  p.vy -= PHYS.GRAVITY * dt;
  if (p.vy < -PHYS.MAX_FALL) p.vy = -PHYS.MAX_FALL;

  // Substep movement to avoid tunnelling at low tick rates
  const dist = Math.hypot(p.vx, p.vy, p.vz) * dt;
  const steps = Math.max(1, Math.ceil(dist / 0.2));
  const sdt = dt / steps;

  const wasGround = p.onGround;
  p.onGround = false;

  for (let i = 0; i < steps; i++) {
    p.x += p.vx * sdt;
    resolveAxis(p, h, 'x', boxes, bounds);
    p.y += p.vy * sdt;
    if (p.y <= 0) { p.y = 0; p.vy = 0; p.onGround = true; }
    else resolveAxis(p, h, 'y', boxes, bounds);
    p.z += p.vz * sdt;
    resolveAxis(p, h, 'z', boxes, bounds);
  }

  if (p.vy === 0 && p.y === 0) p.onGround = true;
  return wasGround && !p.onGround;
}

export function eyeHeight(crouch) {
  return crouch ? PHYS.EYE_CROUCH : PHYS.EYE_STAND;
}

// ---- Ray / AABB helpers (server hit detection, spawn LOS, client can reuse) ----

/** Segment vs AABB. Returns hit distance or -1. */
export function rayBox(ox, oy, oz, dx, dy, dz, maxDist, b) {
  const min = [b.x - b.w / 2, b.y - b.h / 2, b.z - b.d / 2];
  const max = [b.x + b.w / 2, b.y + b.h / 2, b.z + b.d / 2];
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let tmin = 0, tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return -1;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** Segment vs player capsule approximated as AABB. Returns { dist, y } or null. */
export function rayPlayer(ox, oy, oz, dx, dy, dz, maxDist, p) {
  const h = p.crouch ? PHYS.CROUCH_H : PHYS.STAND_H;
  const b = { x: p.x, y: p.y + h / 2, z: p.z, w: PHYS.RADIUS * 2, h: h, d: PHYS.RADIUS * 2 };
  const dist = rayBox(ox, oy, oz, dx, dy, dz, maxDist, b);
  if (dist < 0) return null;
  return { dist, y: oy + dy * dist };
}

export function hasLineOfSight(ax, ay, az, bx, by, bz, boxes) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.001) return true;
  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  for (const box of boxes) {
    if (rayBox(ax, ay, az, nx, ny, nz, dist, box) >= 0) return false;
  }
  return true;
}
