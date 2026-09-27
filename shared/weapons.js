// StrikeZone — shared weapon definitions. Server is authoritative; client uses these
// for prediction, UI and effects only.

export const WEAPONS = [
  {
    id: 'rifle', slot: 0, name: 'AR "Viper"',
    dmg: 24, headMul: 2.2,
    rpm: 640, auto: true,
    mag: 30, reserveMax: 150, reload: 2.1, switchTime: 0.45,
    spread: 0.8, moveSpreadMul: 2.2, airSpreadMul: 2.8, // degrees
    pellets: 1, range: 110, falloff: 0.55, // damage multiplier at max range
    recoilUp: 0.9, recoilSide: 0.35, kick: 0.022, shake: 0.05,
  },
  {
    id: 'shotgun', slot: 1, name: 'SG "Breaker"',
    dmg: 13, headMul: 1.5,
    rpm: 72, auto: false,
    mag: 6, reserveMax: 48, reload: 2.5, switchTime: 0.6,
    spread: 4.2, moveSpreadMul: 1.6, airSpreadMul: 2.2,
    pellets: 8, range: 24, falloff: 0.35,
    recoilUp: 3.6, recoilSide: 0.8, kick: 0.09, shake: 0.16,
    adsFov: 62, adsSpreadMul: 0.6,
  },
  {
    id: 'pistol', slot: 2, name: 'P9 "Sidearm"',
    dmg: 32, headMul: 2.0,
    rpm: 300, auto: false,
    mag: 12, reserveMax: 84, reload: 1.45, switchTime: 0.35,
    spread: 0.65, moveSpreadMul: 2.0, airSpreadMul: 2.6,
    pellets: 1, range: 60, falloff: 0.45,
    recoilUp: 1.5, recoilSide: 0.4, kick: 0.04, shake: 0.06,
    adsFov: 58, adsSpreadMul: 0.45,
  },
];

// Initial loadout ammo per weapon slot
export const START_AMMO = WEAPONS.map((w) => ({ mag: w.mag, reserve: w.reserveMax }));
