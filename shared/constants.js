// StrikeZone — shared match/network constants.

// Server-side env overrides (guarded so this file also bundles for the browser)
const env = (name, fallback) =>
  (typeof process !== 'undefined' && process.env && process.env[name] != null)
    ? Number(process.env[name]) : fallback;

export const MATCH = {
  TICK_RATE: 30,                    // server simulation + snapshot rate (Hz)
  MATCH_DURATION: env('MATCH_DURATION', 10 * 60), // seconds
  SCORE_LIMIT: env('SCORE_LIMIT', 50),            // kills to win
  RESPAWN_DELAY: env('RESPAWN_DELAY', 3),         // seconds
  COUNTDOWN: env('MATCH_COUNTDOWN', 5),           // pre-match countdown seconds
  MIN_PLAYERS: 2,                   // minimum players to start a match
  MAX_PLAYERS: 20,                  // 10 per team
  HP: 100,
};

export const NET = {
  SNAPSHOT_PATH: '/ws',
  INTERP_DELAY: 0.11,        // client interpolation buffer (s)
  MAX_NAME_LEN: 16,
};
