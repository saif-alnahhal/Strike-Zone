// StrikeZone — shared arena definition.
// Used by BOTH server (authoritative collision + LOS) and client (rendering + prediction),
// so physics are guaranteed identical on both sides.
// Coordinates: y is up, ground at y = 0, arena spans roughly x,z in [-32, 32] (meters).

export const MAP = {
  name: 'Depot',
  bounds: { minX: -31.3, maxX: 31.3, minZ: -31.3, maxZ: 31.3 },

  // Boxes: { x,y,z = center, w,h,d = full size, c = css hex color, t = type tag }
  boxes: [
    // ---- Perimeter walls ----
    { x: 0, y: 3, z: -32, w: 66, h: 6, d: 1, c: '#4a5158', t: 'wall' },
    { x: 0, y: 3, z: 32, w: 66, h: 6, d: 1, c: '#4a5158', t: 'wall' },
    { x: -32, y: 3, z: 0, w: 1, h: 6, d: 66, c: '#4a5158', t: 'wall' },
    { x: 32, y: 3, z: 0, w: 1, h: 6, d: 66, c: '#4a5158', t: 'wall' },

    // ---- Central building (4 doorways = routes through the middle) ----
    // North wall (gap at x in [-1.6, 1.6])
    { x: -3.8, y: 2, z: -6, w: 4.4, h: 4, d: 0.6, c: '#6b7076', t: 'building' },
    { x: 3.8, y: 2, z: -6, w: 4.4, h: 4, d: 0.6, c: '#6b7076', t: 'building' },
    { x: 0, y: 4.3, z: -6, w: 3.2, h: 0.6, d: 0.6, c: '#6b7076', t: 'building' }, // lintel
    // South wall
    { x: -3.8, y: 2, z: 6, w: 4.4, h: 4, d: 0.6, c: '#6b7076', t: 'building' },
    { x: 3.8, y: 2, z: 6, w: 4.4, h: 4, d: 0.6, c: '#6b7076', t: 'building' },
    { x: 0, y: 4.3, z: 6, w: 3.2, h: 0.6, d: 0.6, c: '#6b7076', t: 'building' },
    // East wall (gap at z in [-1.6, 1.6])
    { x: 6, y: 2, z: -3.8, w: 0.6, h: 4, d: 4.4, c: '#6b7076', t: 'building' },
    { x: 6, y: 2, z: 3.8, w: 0.6, h: 4, d: 4.4, c: '#6b7076', t: 'building' },
    { x: 6, y: 4.3, z: 0, w: 0.6, h: 0.6, d: 3.2, c: '#6b7076', t: 'building' },
    // West wall
    { x: -6, y: 2, z: -3.8, w: 0.6, h: 4, d: 4.4, c: '#6b7076', t: 'building' },
    { x: -6, y: 2, z: 3.8, w: 0.6, h: 4, d: 4.4, c: '#6b7076', t: 'building' },
    { x: -6, y: 4.3, z: 0, w: 0.6, h: 0.6, d: 3.2, c: '#6b7076', t: 'building' },
    // Central pillar inside the building
    { x: 0, y: 1.5, z: 0, w: 1.6, h: 3, d: 1.6, c: '#7a8087', t: 'building' },

    // ---- Shipping containers (paired for cover corridors) ----
    { x: -16, y: 1.3, z: 10, w: 6, h: 2.6, d: 2.4, c: '#b5651d', t: 'container' },
    { x: -16, y: 1.3, z: 14, w: 6, h: 2.6, d: 2.4, c: '#8a5a2b', t: 'container' },
    { x: 16, y: 1.3, z: -10, w: 6, h: 2.6, d: 2.4, c: '#b5651d', t: 'container' },
    { x: 16, y: 1.3, z: -14, w: 6, h: 2.6, d: 2.4, c: '#8a5a2b', t: 'container' },
    { x: -10, y: 1.3, z: -18, w: 2.4, h: 2.6, d: 6, c: '#2e7d6f', t: 'container' },
    { x: 10, y: 1.3, z: 18, w: 2.4, h: 2.6, d: 6, c: '#2e7d6f', t: 'container' },

    // ---- Low cover walls ----
    { x: -20, y: 0.7, z: -3, w: 0.6, h: 1.4, d: 9, c: '#5d646b', t: 'cover' },
    { x: 20, y: 0.7, z: 3, w: 0.6, h: 1.4, d: 9, c: '#5d646b', t: 'cover' },
    { x: 0, y: 0.7, z: -14, w: 9, h: 1.4, d: 0.6, c: '#5d646b', t: 'cover' },
    { x: 0, y: 0.7, z: 14, w: 9, h: 1.4, d: 0.6, c: '#5d646b', t: 'cover' },
    { x: -12, y: 0.7, z: 0, w: 5, h: 1.4, d: 0.6, c: '#5d646b', t: 'cover' },
    { x: 12, y: 0.7, z: 0, w: 5, h: 1.4, d: 0.6, c: '#5d646b', t: 'cover' },

    // ---- Corner L-walls (flank routes) ----
    { x: -26, y: 1.75, z: -20, w: 0.6, h: 3.5, d: 8, c: '#60666d', t: 'wall' },
    { x: -22, y: 1.75, z: -24, w: 8, h: 3.5, d: 0.6, c: '#60666d', t: 'wall' },
    { x: 26, y: 1.75, z: 20, w: 0.6, h: 3.5, d: 8, c: '#60666d', t: 'wall' },
    { x: 22, y: 1.75, z: 24, w: 8, h: 3.5, d: 0.6, c: '#60666d', t: 'wall' },

    // ---- Crates (jumpable cover, h=1.2) — flush L-blocks, no narrow channels ----
    { x: -10.4, y: 0.6, z: -13, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
    { x: -8.8, y: 0.6, z: -13, w: 1.6, h: 1.2, d: 1.6, c: '#7c613a', t: 'crate' },
    { x: -9.6, y: 0.6, z: -11.4, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
    { x: 10.4, y: 0.6, z: 13, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
    { x: 8.8, y: 0.6, z: 13, w: 1.6, h: 1.2, d: 1.6, c: '#7c613a', t: 'crate' },
    { x: 9.6, y: 0.6, z: 11.4, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
    { x: 24, y: 0.6, z: -6, w: 1.6, h: 1.2, d: 1.6, c: '#7c613a', t: 'crate' },
    { x: -24, y: 0.6, z: 6, w: 1.6, h: 1.2, d: 1.6, c: '#7c613a', t: 'crate' },
    { x: 0, y: 0.6, z: -24, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
    { x: 0, y: 0.6, z: 24, w: 1.6, h: 1.2, d: 1.6, c: '#8d6e3f', t: 'crate' },
  ],

  // Team spawn points (feet positions)
  spawns: [
    // Team 0 — ALPHA (west edge)
    [
      { x: -28.5, z: -20 }, { x: -29, z: -9 }, { x: -29, z: 9 }, { x: -28.5, z: 20 },
      { x: -25, z: 0 }, { x: -26.5, z: -14 }, { x: -26.5, z: 14 }, { x: -24, z: -27.5 },
      { x: -24, z: 27.5 }, { x: -22, z: -9 },
    ],
    // Team 1 — BRAVO (east edge)
    [
      { x: 28.5, z: 20 }, { x: 29, z: 9 }, { x: 29, z: -9 }, { x: 28.5, z: -20 },
      { x: 25, z: 0 }, { x: 26.5, z: 14 }, { x: 26.5, z: -14 }, { x: 24, z: 27.5 },
      { x: 24, z: -27.5 }, { x: 22, z: 9 },
    ],
  ],
};

export const TEAMS = [
  { id: 0, name: 'ALPHA', color: '#3b82f6' },
  { id: 1, name: 'BRAVO', color: '#ef4444' },
];

/**
 * Sanity check: no spawn point may be inside a box or out of bounds, and no
 * pair of boxes may form an impassable channel (gap > 0 but < player width).
 * Returns a list of problems (empty = map is valid).
 */
export function validateMap() {
  const problems = [];
  const R = 0.35, H = 1.7, PLAYER_W = R * 2 + 0.1; // 0.8m clearance required
  for (let t = 0; t < MAP.spawns.length; t++) {
    for (const s of MAP.spawns[t]) {
      if (s.x < MAP.bounds.minX || s.x > MAP.bounds.maxX || s.z < MAP.bounds.minZ || s.z > MAP.bounds.maxZ) {
        problems.push(`team ${t} spawn (${s.x},${s.z}) out of bounds`);
      }
      for (const b of MAP.boxes) {
        if (s.x + R > b.x - b.w / 2 && s.x - R < b.x + b.w / 2 &&
            s.z + R > b.z - b.d / 2 && s.z - R < b.z + b.d / 2 &&
            H > b.y - b.h / 2 && 0 < b.y + b.h / 2) {
          problems.push(`team ${t} spawn (${s.x},${s.z}) inside box at (${b.x},${b.y},${b.z})`);
        }
      }
    }
  }
  // impassable channel detection between box pairs at player height
  const bs = MAP.boxes;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i], b = bs[j];
      // both must be tall/solid enough to block a standing player
      const aBlocks = a.y - a.h / 2 < 1.0 && a.y + a.h / 2 > 0.5;
      const bBlocks = b.y - b.h / 2 < 1.0 && b.y + b.h / 2 > 0.5;
      if (!aBlocks || !bBlocks) continue;
      const xOverlap = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
      const zOverlap = Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2);
      const xGap = Math.max(a.x - a.w / 2, b.x - b.w / 2) - Math.min(a.x + a.w / 2, b.x + b.w / 2);
      const zGap = Math.max(a.z - a.d / 2, b.z - b.d / 2) - Math.min(a.z + a.d / 2, b.z + b.d / 2);
      if (zOverlap > 0 && xGap > 0.001 && xGap < PLAYER_W) {
        problems.push(`impassable x-channel ${xGap.toFixed(2)}m between boxes (${a.x},${a.z}) and (${b.x},${b.z})`);
      }
      if (xOverlap > 0 && zGap > 0.001 && zGap < PLAYER_W) {
        problems.push(`impassable z-channel ${zGap.toFixed(2)}m between boxes (${a.x},${a.z}) and (${b.x},${b.z})`);
      }
    }
  }
  return problems;
}
