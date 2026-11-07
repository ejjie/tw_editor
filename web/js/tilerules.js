// Which tile indices each physics layer accepts (ported from DDNet src/game/mapitems.cpp).
const T = {
  AIR: 0, SOLID: 1, DEATH: 2, NOHOOK: 3, NOLASER: 4, THROUGH_CUT: 5, THROUGH: 6, JUMP: 7, FREEZE: 9, TELEINEVIL: 10,
  UNFREEZE: 11, DFREEZE: 12, DUNFREEZE: 13, TELEINWEAPON: 14, TELEINHOOK: 15, WALLJUMP: 16, HIT_ENABLE: 19, HIT_DISABLE: 20,
  SOLO_DISABLE: 22, SWITCHTIMEDOPEN: 22, SWITCHCLOSE: 25, TELEIN: 26, TELEOUT: 27, SPEED_BOOST_OLD: 28, SPEED_BOOST: 29,
  TELECHECK: 29, TELECHECKOUT: 30, TELECHECKIN: 31, REFILL_JUMPS: 32, STOP: 60, STOPS: 61, STOPA: 62, TELECHECKINEVIL: 63,
  CP: 64, CP_F: 65, THROUGH_DIR: 67, TUNE: 68, OLDLASER: 71, UNLOCK_TEAM: 76, ADD_TIME: 79, NPC_DISABLE: 88, NPH_DISABLE: 91,
  SUBTRACT_TIME: 95, TELE_GUN_ENABLE: 96, TELE_GUN_DISABLE: 97, ALLOW_TELE_GUN: 98, ALLOW_BLUE_TELE_GUN: 99,
  NPC_ENABLE: 104, NPH_ENABLE: 107, TELE_GRENADE_ENABLE: 112, TELE_GRENADE_DISABLE: 113, TELE_LASER_ENABLE: 128,
  TELE_LASER_DISABLE: 129, LFREEZE: 144, LUNFREEZE: 145, ENTITIES_OFF_1: 190, ENTITIES_OFF_2: 191,
};
export const TILE = T;
const E = { SPAWN: 1, ARMOR_1: 6, WEAPON_LASER: 11, LASER_O_FAST: 27, PLASMAE: 29, CRAZY_SHOTGUN_EX: 33, CRAZY_SHOTGUN: 34, ARMOR_SHOTGUN: 35, ARMOR_LASER: 38, DRAGGER_WEAK: 42, DRAGGER_STRONG_NW: 47, DOOR: 49 };
const ENTITY_OFFSET = 255 - 16 * 4;
const inr = (i, a, b) => i >= a && i <= b;

export function isValidEntity(i) {
  i -= ENTITY_OFFSET;
  return inr(i, E.SPAWN, E.LASER_O_FAST) || inr(i, E.PLASMAE, E.ARMOR_LASER) || inr(i, E.DRAGGER_WEAK, E.DRAGGER_STRONG_NW) || i === E.DOOR;
}

function common(i) {
  return i === T.FREEZE || inr(i, T.UNFREEZE, T.DUNFREEZE) || inr(i, T.LFREEZE, T.LUNFREEZE) || inr(i, T.WALLJUMP, T.SOLO_DISABLE)
    || inr(i, T.REFILL_JUMPS, T.STOPA) || inr(i, T.CP, T.THROUGH_DIR) || inr(i, T.OLDLASER, T.UNLOCK_TEAM) || inr(i, T.NPC_DISABLE, T.NPH_DISABLE)
    || inr(i, T.TELE_GRENADE_ENABLE, T.TELE_GRENADE_DISABLE) || inr(i, T.TELE_LASER_ENABLE, T.TELE_LASER_DISABLE)
    || inr(i, T.NPC_ENABLE, T.NPH_ENABLE) || inr(i, T.ENTITIES_OFF_1, T.ENTITIES_OFF_2) || isValidEntity(i);
}

export function isValidGameTile(i) {
  return i === T.AIR || inr(i, T.SOLID, T.THROUGH) || common(i) || inr(i, T.TELE_GUN_ENABLE, T.TELE_GUN_DISABLE);
}
export function isValidFrontTile(i) {
  return i === T.AIR || i === T.DEATH || inr(i, T.NOLASER, T.THROUGH) || common(i) || inr(i, T.TELE_GUN_ENABLE, T.ALLOW_BLUE_TELE_GUN);
}
export function isValidTeleTile(i) {
  return [T.TELEINEVIL, T.TELEINWEAPON, T.TELEINHOOK, T.TELEIN, T.TELEOUT, T.TELECHECK, T.TELECHECKOUT, T.TELECHECKIN, T.TELECHECKINEVIL].includes(i);
}
export const isTeleCheckpoint = (i) => i === T.TELECHECK || i === T.TELECHECKOUT;
export const isTeleNumberUsedAny = (i) => i !== T.TELECHECKIN && i !== T.TELECHECKINEVIL;
export const isValidSpeedupTile = (i) => i === T.SPEED_BOOST_OLD || i === T.SPEED_BOOST;
export function isValidSwitchTile(i) {
  return [T.JUMP, T.FREEZE, T.DFREEZE, T.DUNFREEZE, T.LFREEZE, T.LUNFREEZE, T.HIT_ENABLE, T.HIT_DISABLE, T.ADD_TIME, T.SUBTRACT_TIME, T.ALLOW_TELE_GUN, T.ALLOW_BLUE_TELE_GUN].includes(i)
    || inr(i, T.SWITCHTIMEDOPEN, T.SWITCHCLOSE) || (isValidEntity(i) && i >= ENTITY_OFFSET + E.ARMOR_1);
}
export const isSwitchFlagsUsed = (i) => i !== T.FREEZE && i !== T.DFREEZE && i !== T.DUNFREEZE;
export const isSwitchNumberUsed = (i) => ![T.JUMP, T.HIT_ENABLE, T.HIT_DISABLE, T.ALLOW_TELE_GUN, T.ALLOW_BLUE_TELE_GUN].includes(i);
export const isSwitchDelayUsed = (i) => i !== T.DFREEZE && i !== T.DUNFREEZE;
export const isValidTuneTile = (i) => i === T.TUNE;

export function isRotatableTile(i) {
  const e = i - ENTITY_OFFSET;
  return [T.STOP, T.STOPS, T.CP, T.CP_F, T.THROUGH_DIR, T.ENTITIES_OFF_1, T.ENTITIES_OFF_2].includes(i)
    || e === E.CRAZY_SHOTGUN_EX || e === E.CRAZY_SHOTGUN || inr(e, E.ARMOR_1, E.WEAPON_LASER) || inr(e, E.ARMOR_SHOTGUN, E.ARMOR_LASER);
}

export function isValidFor(kind, i) {
  if (i === 0) return true;
  switch (kind) {
    case 'game': return isValidGameTile(i);
    case 'front': return isValidFrontTile(i);
    case 'tele': return isValidTeleTile(i);
    case 'speedup': return isValidSpeedupTile(i);
    case 'switch': return isValidSwitchTile(i);
    case 'tune': return isValidTuneTile(i);
    default: return true;
  }
}
