// Transition catalogue. `id` maps to u_type in FRAG_TRANSITION.
export const TRANSITIONS = [
  { name: 'Cut', id: -1 },
  { name: 'Fade', id: 0 },
  { name: 'Wipe Right', id: 1, dir: [1, 0] },
  { name: 'Wipe Left', id: 1, dir: [-1, 0] },
  { name: 'Wipe Down', id: 1, dir: [0, 1] },
  { name: 'Wipe Up', id: 1, dir: [0, -1] },
  { name: 'Slide Right', id: 2, dir: [1, 0] },
  { name: 'Slide Left', id: 2, dir: [-1, 0] },
  { name: 'Slide Down', id: 2, dir: [0, 1] },
  { name: 'Slide Up', id: 2, dir: [0, -1] },
  { name: 'Push Right', id: 3, dir: [1, 0] },
  { name: 'Push Left', id: 3, dir: [-1, 0] },
  { name: 'Push Down', id: 3, dir: [0, 1] },
  { name: 'Push Up', id: 3, dir: [0, -1] },
  { name: 'Zoom', id: 4 },
  { name: 'Cross Zoom', id: 5 },
  { name: 'Iris', id: 6 },
  { name: 'Dip to Black', id: 7, dip: [0, 0, 0] },
  { name: 'Dip to White', id: 7, dip: [1, 1, 1] },
  { name: 'Dissolve', id: 8 },
  { name: 'Blinds', id: 9, dir: [1, 0] },
  { name: 'Blinds Horizontal', id: 9, dir: [0, 1] },
  { name: 'Cube', id: 10 },
  { name: 'Stinger 1', id: 'stinger', stinger: 0 },
  { name: 'Stinger 2', id: 'stinger', stinger: 1 },
];

export const TRANSITION_BY_NAME = Object.fromEntries(TRANSITIONS.map((t) => [t.name.toLowerCase(), t]));

// Aliases accepted by the API (e.g. Function=Wipe, Function=Slide).
const ALIASES = {
  wipe: 'Wipe Right',
  slide: 'Slide Left',
  push: 'Push Left',
  merge: 'Cross Zoom',
  fly: 'Slide Left',
  cubezoom: 'Cube',
  verticalwipe: 'Wipe Down',
  verticalslide: 'Slide Down',
  barndoor: 'Iris',
  fadetoblack: 'Dip to Black',
  stinger1: 'Stinger 1',
  stinger2: 'Stinger 2',
};

export function findTransition(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/\s+/g, ' ').trim();
  if (TRANSITION_BY_NAME[key]) return TRANSITION_BY_NAME[key];
  const alias = ALIASES[key.replace(/\s/g, '')];
  return alias ? TRANSITION_BY_NAME[alias.toLowerCase()] : null;
}

export const OVERLAY_EFFECTS = ['Fade', 'Cut', 'Zoom', 'Slide Left', 'Slide Right', 'Slide Up', 'Slide Down'];

export const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
