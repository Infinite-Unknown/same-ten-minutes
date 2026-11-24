// The two travel profiles. Every threshold lives here and is documented in the README.

/** 1:12 ramp limit (ADA 2010 §405.2, BS 8300, MS 1184): steeper is impassable unaided. */
export const MAX_WHEELCHAIR_SLOPE = 0.083;
/** Below this a manual wheelchair keeps its flat speed (ADA "running slope" limit for walks, 1:20 = 5%; we start slowing earlier, at 3%). */
export const WHEELCHAIR_SLOW_FROM = 0.03;
/** Flat speeds, metres per second. */
export const WALK_SPEED = 1.33; // ~4.8 km/h, typical pedestrian speed
export const WHEELCHAIR_SPEED = 1.0; // ~3.6 km/h, typical manual wheelchair speed on pavement
export const STEPS_WALK_SPEED = 0.6; // horizontal progress on a staircase
/** Speed factor at the 1:12 limit. */
export const WHEELCHAIR_STEEP_FACTOR = 0.55;
/** Tagged width below this blocks a wheelchair (clear width of a standard wheelchair + hands). */
export const MIN_WIDTH_M = 0.9;

export const BAD_SURFACES = new Set([
  'gravel', 'dirt', 'grass', 'sand', 'mud', 'ground', 'earth', 'pebblestone', 'unpaved', 'woodchips',
  'rock', 'stepping_stones', 'grass_paver',
]);
export const BAD_SMOOTHNESS = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']);
/** Node barriers a wheelchair cannot pass. */
export const BLOCKING_NODE_BARRIERS = new Set(['turnstile', 'stile', 'kissing_gate', 'full-height_turnstile', 'step', 'steps', 'motorcycle_barrier']);

/** Walking speed on a signed slope (rise over run in the direction of travel). Tobler's hiking function, scaled so flat ground = WALK_SPEED and never faster. */
export function walkSpeed(slope: number): number {
  const f = Math.exp(-3.5 * (Math.abs(slope + 0.05) - 0.05));
  return WALK_SPEED * Math.min(1, f);
}

/** Wheelchair speed on a signed slope, or 0 when the slope is beyond the 1:12 limit. Never faster than walking. */
export function wheelchairSpeed(slope: number): number {
  const s = Math.abs(slope);
  if (s > MAX_WHEELCHAIR_SLOPE + 1e-9) return 0;
  let v = WHEELCHAIR_SPEED;
  if (s > WHEELCHAIR_SLOW_FROM) {
    const k = (s - WHEELCHAIR_SLOW_FROM) / (MAX_WHEELCHAIR_SLOPE - WHEELCHAIR_SLOW_FROM);
    v = WHEELCHAIR_SPEED * (1 - k * (1 - WHEELCHAIR_STEEP_FACTOR));
  }
  return Math.min(v, walkSpeed(slope));
}

export type Profile = 'walk' | 'wheelchair';
