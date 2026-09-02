#!/usr/bin/env node
// gen.mjs — Muybridge horse sprite generator.
//
// A 2-D horse rig in "withers units" (H = height at the withers, x forward,
// y up, ground y = 0; the sprite faces right) is posed by a gait table and
// rasterised straight to 1× pixel art (no anti-aliasing, no downsampling):
// every pixel is either a palette entry or transparent.
//
// Gait timing (touchdown phase per leg + duty factor) follows Hildebrand's
// gait diagrams; posture (neck carriage, head angle, leg fold, tail, body
// bob and pitch) was read off Muybridge's plates:
//   walk   — "Eagle" walking with a bucket, Animal Locomotion 1887 (12 frames)
//   gallop — "Sallie Gardner", The Horse in Motion, Palo Alto 1878 (11 frames/stride)
//
// Output: out/horse-sheet.png (one row per gait), out/horse-sheet.json
// (frame geometry, per-gait fps and ground-scroll speed), per-gait strips,
// and out/preview-*.png (×4 nearest-neighbour, for eyeballing).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'out');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- geometry
export let FW = 64, FH = 48;     // frame size (px) — the centaur sheet is 64×64
export let GROUND = 46;          // pixel row of the ground line (hoof bottoms sit on it)
export const H = 32;             // withers height (px)
export const CX = 32;            // column of the body centre (x = 0 in units)
export const N = 12;             // frames per cycle (Muybridge's 12-camera battery)
export function setFrame({ w = 64, h = 48, ground = 46 } = {}) { FW = w; FH = h; GROUND = ground; }

const toPx = (p) => [CX + p[0] * H, GROUND - p[1] * H];   // units -> px (float, y down)
const wU = (px) => px / H;                                  // a width in px -> units

// ---------------------------------------------------------------- palette
// Bay horse: brown coat, black points (mane, tail, lower legs), very dark
// outline. Far-side legs are a darker, duller brown so the two sides read.
const PALETTE = [
  null,                       // 0 transparent
  [0x2a, 0x1b, 0x12, 255],    // 1 OUT   outline
  [0x8c, 0x5b, 0x2e, 255],    // 2 COAT
  [0xa9, 0x74, 0x40, 255],    // 3 LIGHT top rim
  [0x6a, 0x41, 0x21, 255],    // 4 SHADE belly rim
  [0x24, 0x18, 0x12, 255],    // 5 POINT black points (near side)
  [0x55, 0x36, 0x1e, 255],    // 6 FAR   far-side coat
  [0x1c, 0x12, 0x0e, 255],    // 7 FARPT far-side points
  [0x1a, 0x11, 0x0c, 255],    // 8 HOOF
  [0xe8, 0xd8, 0xc0, 255],    // 9 EYE
  [0x24, 0x18, 0x12, 255],    // 10 MANE (same ink as POINT; separate id so the ring rule can tell body from leg)
  [0x24, 0x18, 0x12, 255],    // 11 TAIL
  [0xd9, 0xa4, 0x78, 255],    // 12 SKIN        (centaur)
  [0xe9, 0xbf, 0x96, 255],    // 13 SKIN_LIGHT
  [0xb8, 0x82, 0x5c, 255],    // 14 SKIN_SHADE
  [0x9c, 0x6e, 0x4e, 255],    // 15 FARSKIN     far arm
];
const OUTL = 1, COAT = 2, LIGHT = 3, SHADE = 4, POINT = 5, FAR = 6, FARPT = 7, HOOF = 8, EYE = 9, MANE = 10, TAIL = 11;
const SKIN = 12, SKIN_LIGHT = 13, SKIN_SHADE = 14, FARSKIN = 15;
const BODY_INK = new Set([COAT, LIGHT, SHADE, MANE, EYE, SKIN, SKIN_LIGHT, SKIN_SHADE]);
const UPPER_LEG_INK = new Set([COAT, FAR]);

// ---------------------------------------------------------------- raster
class Mask {
  constructor() { this.a = new Uint8Array(FW * FH); }
  get(x, y) { return (x < 0 || y < 0 || x >= FW || y >= FH) ? 0 : this.a[y * FW + x]; }
  set(x, y, c) { if (x >= 0 && y >= 0 && x < FW && y < FH) this.a[y * FW + x] = c; }
}

// Scanline polygon fill, pixel-centre sampling, even-odd rule. pts in px.
function fillPolyPx(m, pts, c) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(FH - 1, Math.ceil(ymax));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= sy) !== (by <= sy)) xs.push(ax + (sy - ay) * (bx - ax) / (by - ay));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(FW - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) m.a[y * FW + x] = c;
    }
  }
}
const fillPolyU = (m, ptsU, c) => fillPolyPx(m, ptsU.map(toPx), c);

// Rotated ellipse in unit space (ang: radians, +ve = nose up).
function fillEllipseU(m, [cx, cy], rx, ry, ang, c) {
  const [pcx, pcy] = toPx([cx, cy]);
  const R = Math.max(rx, ry) * H + 1;
  const x0 = Math.max(0, Math.floor(pcx - R)), x1 = Math.min(FW - 1, Math.ceil(pcx + R));
  const y0 = Math.max(0, Math.floor(pcy - R)), y1 = Math.min(FH - 1, Math.ceil(pcy + R));
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const ux = (x + 0.5 - CX) / H - cx, uy = (GROUND - (y + 0.5)) / H - cy;
    const lx = ux * ca + uy * sa, ly = -ux * sa + uy * ca;   // rotate by -ang into ellipse frame
    if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1) m.a[y * FW + x] = c;
  }
}

// Bresenham line (px), for hairlines.
function linePx(m, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    m.set(x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Tapered segment a->b (units) with end widths wa, wb (units); round caps optional.
function segU(m, a, b, wa, wb, c, caps = true) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
  const nx = -dy / L, ny = dx / L;
  fillPolyU(m, [
    [a[0] + nx * wa / 2, a[1] + ny * wa / 2], [b[0] + nx * wb / 2, b[1] + ny * wb / 2],
    [b[0] - nx * wb / 2, b[1] - ny * wb / 2], [a[0] - nx * wa / 2, a[1] - ny * wa / 2],
  ], c);
  if (caps) { fillEllipseU(m, a, wa / 2, wa / 2, 0, c); fillEllipseU(m, b, wb / 2, wb / 2, 0, c); }
  const [ax, ay] = toPx(a), [bx, by] = toPx(b);
  linePx(m, ax - 0.5, ay - 0.5, bx - 0.5, by - 0.5, c);   // guarantees connectivity at w<=1px
}

function fillRect(m, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m.set(x + i, y + j, c); }

// Composite a group mask onto the frame with a 1-px 4-neighbour outline ring.
// The ring paints over whatever is beneath, so a near layer separates from a
// far one with a dark line, and the sprite gets a closed outer outline.
// ringOver(dstInk, srcNeighbourInk) decides per pixel whether the ring may be
// painted there: legs use it to merge their upper segment into the body (a
// thigh is part of the silhouette) while still outlining the lower leg and
// hoof wherever they cross the belly.
function composite(dst, src, ringOver = () => true) {
  const before = new Uint8Array(dst.a);
  for (let i = 0; i < src.a.length; i++) if (src.a[i]) dst.a[i] = src.a[i];
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (src.get(x, y)) continue;
    const nb = src.get(x - 1, y) || src.get(x + 1, y) || src.get(x, y - 1) || src.get(x, y + 1);
    if (nb && ringOver(before[y * FW + x], nb)) dst.set(x, y, OUTL);
  }
}
const LEG_RING = (d, s) => !(BODY_INK.has(d) && UPPER_LEG_INK.has(s));

// Two-pixel top-lit rim and belly shadow on COAT pixels of a group.
function shade(m) {
  const src = new Uint8Array(m.a);
  const at = (x, y) => (x < 0 || y < 0 || x >= FW || y >= FH) ? 0 : src[y * FW + x];
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const c = src[y * FW + x];
    if (c !== COAT && c !== SKIN) continue;
    if (!at(x, y - 1) || !at(x, y - 2)) m.a[y * FW + x] = c === COAT ? LIGHT : SKIN_LIGHT;
    else if (!at(x, y + 1) || !at(x, y + 2)) m.a[y * FW + x] = c === COAT ? SHADE : SKIN_SHADE;
  }
}

// ---------------------------------------------------------------- rig
const FORE = { pivot: [0.30, 0.58], L1: 0.26, L2: 0.28, bend: +1, shift: 0.25, drop: 0.18 };  // elbow -> knee -> hoof; the elbow lowers as the leg reaches (scapular rotation)
const HIND = { pivot: [-0.24, 0.56], L1: 0.26, L2: 0.32, bend: -1, shift: 0.10 }; // stifle -> hock -> hoof
const HOOF_H = 0.06;                                                              // hoof block height (units)
const BODY_C = [0, 0.75];                                                         // pitch centre

// The trunk is a bendable spine, not a tube. Topline and underline stations
// (front to back, withers units): the back dips behind the withers to the
// mid-back, rises to the croup; the underline is deepest at the girth and
// rises into the flank.
const TOPLINE = [[0.42, 0.84], [0.36, 0.95], [0.27, 1.00], [0.18, 0.975], [0.05, 0.93], [-0.10, 0.915], [-0.25, 0.945], [-0.38, 0.965], [-0.48, 0.92], [-0.52, 0.86]];
const UNDERLINE = [[0.42, 0.66], [0.32, 0.585], [0.18, 0.56], [0.05, 0.55], [-0.10, 0.565], [-0.25, 0.60], [-0.38, 0.65], [-0.48, 0.72], [-0.52, 0.80]];
// Spinal flex: +1 rounds the back (gathered), -1 hollows it (extended). The
// displacement is a parabola centred on the mid-back; behind the loin the
// croup also tucks under (lumbosacral rotation), blended in over 0.1 H.
const SPINE = { xm: -0.05, L: 0.47, amp: 0.055, tuckX: -0.20, tuckY: 0.76, tuckW: 0.10, tuck: 7 * Math.PI / 180 };
function spineXform(flex) {
  return ([x, y]) => {
    const u = (x - SPINE.xm) / SPINE.L, bump = Math.max(0, 1 - u * u);
    let px = x, py = y + flex * SPINE.amp * bump;
    const w = Math.min(1, Math.max(0, (SPINE.tuckX - x) / SPINE.tuckW));
    if (w > 0) {
      const th = flex * SPINE.tuck * w, c = Math.cos(th), s = Math.sin(th);
      const dx = px - SPINE.tuckX, dy = py - SPINE.tuckY;
      px = SPINE.tuckX + dx * c - dy * s; py = SPINE.tuckY + dx * s + dy * c;
    }
    return [px, py];
  };
}
// Catmull-Rom through the stations, k samples per span (open curve, clamped ends).
function crSample(pts, k) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Two-bone IK in unit space. bend +1 = joint on the +x side of pivot->target
// (a fore knee), -1 = joint behind it (a hind hock).
function ik(p, t, L1, L2, bend) {
  let dx = t[0] - p[0], dy = t[1] - p[1], d = Math.hypot(dx, dy);
  const maxD = L1 + L2 - 1e-4, minD = Math.abs(L1 - L2) + 1e-4;
  if (d > maxD) { dx *= maxD / d; dy *= maxD / d; d = maxD; }
  if (d < minD) { const k = minD / (d || 1e-9); dx *= k; dy *= k; d = minD; }
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const mx = p[0] + a * dx / d, my = p[1] + a * dy / d;
  const nx = -dy / d, ny = dx / d;
  return { joint: [mx + bend * h * nx, my + bend * h * ny], end: [p[0] + dx, p[1] + dy] };
}

// Hoof target for one leg at a cycle phase: stance slides the foot backward
// under the body at constant speed; swing carries it forward on a lifted arc.
function hoofTarget(kind, td, gait, phase) {
  const D = gait.duty, [xb, xf] = gait.reach[kind];
  const u = ((phase - td) % 1 + 1) % 1;
  if (u < D) return { x: xf + (xb - xf) * (u / D), y: 0, stance: true };
  const s = (u - D) / (1 - D), sm = s * s * (3 - 2 * s);
  const lift = gait.lift[kind];
  // fore legs fold early and hard (Sallie Gardner frames 1, 8, 9), hinds arc.
  const prof = kind === 'fore' ? Math.pow(Math.sin(Math.PI * s), 0.7) : Math.sin(Math.PI * s);
  return { x: xb + (xf - xb) * sm, y: lift * prof, stance: false };
}

const deg = (d) => d * Math.PI / 180;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------- gaits
// td: touchdown phase per leg (L/R hind, L/R fore). The sprite faces right so
// the RIGHT legs are the near side (as in the Sallie Gardner card).
export const GAITS = {
  walk: {
    fps: 12, duty: 0.65,
    // lateral-sequence four-beat: LH, LF, RH, RF a quarter cycle apart
    td: { LH: 0.00, LF: 0.25, RH: 0.50, RF: 0.75 },
    reach: { fore: [-0.20, 0.24], hind: [-0.26, 0.18] },
    lift: { fore: 0.09, hind: 0.10 },
    bob: (p) => 0.010 * Math.cos(2 * TWO_PI * p),
    pitch: () => 0,
    spine: (p) => 0.15 * Math.sin(2 * TWO_PI * p + 1.0),                 // the back barely works at a walk
    neck: (p) => deg(40) + deg(3) * Math.sin(2 * TWO_PI * p + 0.6),   // nods twice a stride
    head: (p) => deg(-62) - deg(4) * Math.sin(2 * TWO_PI * p + 0.6),
    tail: (p) => [[-0.52, 0.88], [-0.55 + 0.02 * Math.sin(TWO_PI * p), 0.72], [-0.57 + 0.04 * Math.sin(TWO_PI * p), 0.55], [-0.58 + 0.05 * Math.sin(TWO_PI * p), 0.42]],
    note: 'Eagle, Animal Locomotion 1887 — lateral sequence LH LF RH RF, duty ≈0.65, low action, tail hanging',
  },
  trot: {
    fps: 16, duty: 0.45,
    // diagonal pairs with a short suspension after each
    td: { LF: 0.00, RH: 0.00, RF: 0.50, LH: 0.50 },
    reach: { fore: [-0.22, 0.26], hind: [-0.30, 0.20] },
    lift: { fore: 0.18, hind: 0.16 },
    bob: (p) => 0.022 * (0.5 - 0.5 * Math.cos(2 * TWO_PI * (p - 0.22))),
    pitch: () => 0,
    spine: (p) => 0.15 * Math.sin(2 * TWO_PI * (p - 0.22)),             // stiff-backed gait
    neck: () => deg(46),
    head: () => deg(-60),
    tail: (p) => [[-0.52, 0.88], [-0.62, 0.84], [-0.69, 0.70 + 0.02 * Math.sin(2 * TWO_PI * p)], [-0.72, 0.56]],
    note: 'diagonal couplets LF+RH / RF+LH, duty ≈0.45, tail carried',
  },
  canter: {
    fps: 18, duty: 0.36,
    // three-beat, right lead: LH; RH+LF together; RF; then suspension
    td: { LH: 0.00, RH: 0.28, LF: 0.28, RF: 0.52 },
    reach: { fore: [-0.28, 0.30], hind: [-0.34, 0.26] },
    lift: { fore: 0.30, hind: 0.24 },
    bob: (p) => 0.04 * (0.5 - 0.5 * Math.cos(TWO_PI * (p - 0.44))),        // highest mid-suspension (RF leaves at 0.88)
    pitch: (p) => deg(4) * Math.sin(TWO_PI * (p + 0.02)),
    spine: (p) => -0.6 * Math.sin(TWO_PI * (p - 0.12)),                  // hollow over the forehand, rounded in suspension
    neck: (p) => deg(32) + deg(5) * Math.sin(TWO_PI * (p + 0.15)),
    head: () => deg(-42),
    tail: (p) => [[-0.52, 0.88], [-0.66, 0.86], [-0.78, 0.80 + 0.03 * Math.sin(TWO_PI * p)], [-0.88, 0.70]],
    note: 'right-lead canter, LH · RH+LF · RF · suspension',
  },
  gallop: {
    fps: 24, duty: 0.28,
    // transverse gallop, right lead: LH, RH, LF, RF then a gathered suspension
    td: { LH: 0.00, RH: 0.10, LF: 0.30, RF: 0.42 },
    reach: { fore: [-0.30, 0.34], hind: [-0.36, 0.30] },
    lift: { fore: 0.42, hind: 0.30 },
    bob: (p) => 0.05 * (0.5 - 0.5 * Math.cos(TWO_PI * (p - 0.35))),        // lowest on the forehand, highest mid-suspension
    pitch: (p) => deg(6) * Math.sin(TWO_PI * (p + 0.05)),                    // nose up on the hind push, down over the forehand
    spine: (p) => -Math.sin(TWO_PI * (p - 0.10)),                        // hollow at the fore reach (frame 4), rounded when gathered (frame 7)
    neck: (p) => deg(22) + deg(5) * Math.sin(TWO_PI * (p + 0.10)),
    head: () => deg(-30),
    tail: (p) => [[-0.52, 0.88], [-0.68, 0.86], [-0.76, 0.82 + 0.03 * Math.sin(TWO_PI * p)], [-0.86, 0.75 - 0.03 * Math.sin(TWO_PI * p)]],
    note: 'Sallie Gardner 1878 — LH RH LF RF, forelegs folded to the chest, gathered suspension',
  },
  idle: {
    fps: 4, duty: 1.0,
    td: { LH: 0, LF: 0, RH: 0, RF: 0 },
    reach: { fore: [0.02, 0.02], hind: [-0.02, -0.02] },
    lift: { fore: 0, hind: 0 },
    bob: () => 0,
    pitch: () => 0,
    spine: () => 0,
    neck: (p) => deg(44) + deg(2) * Math.sin(TWO_PI * p),
    head: (p) => deg(-66) + deg(3) * Math.sin(TWO_PI * p),
    tail: (p) => [[-0.52, 0.88], [-0.55, 0.72], [-0.57 + 0.06 * Math.sin(TWO_PI * p), 0.55], [-0.58 + 0.10 * Math.sin(TWO_PI * p), 0.42]],
    note: 'standing (the card\'s twelfth frame)',
    frames: 4,
  },
};

// Idle: split the far/near pairs so both fore and both hind legs show.
const LEG_KIND = { LH: 'hind', RH: 'hind', LF: 'fore', RF: 'fore' };
const NEAR = { RH: true, RF: true, LH: false, LF: false };
for (const [k, g] of Object.entries(GAITS)) g.name = k;

// ---------------------------------------------------------------- centaur
// The human half stands where the horse neck would root: hip joint J on the
// withers, torso leaning forward with speed, arms swinging at the walk,
// pumping at the trot, held forward and bent at the canter and gallop.
// Torso coordinates are local (upright); lean rotates them about J.
// Human geometry is local to the hip joint J (x forward, y up, withers units).
// The torso in profile is an S-curve: belly, navel in, chest out, collarbone,
// throat; then down the back: shoulders, blades out, small of the back in,
// buttock out. Front line bottom-to-top, back line top-to-bottom.
const HUMAN_FRONT = [[0.07, 0.02], [0.09, 0.10], [0.08, 0.20], [0.11, 0.30], [0.10, 0.38], [0.05, 0.43]];
const HUMAN_BACK = [[-0.06, 0.43], [-0.10, 0.34], [-0.08, 0.24], [-0.05, 0.16], [-0.08, 0.06], [-0.09, 0.02]];
// Face in profile, drawn over the skull ellipse: forehead, brow, nose, lip, chin, jaw.
const HUMAN_FACE = [[0.05, 0.645], [0.10, 0.605], [0.125, 0.578], [0.10, 0.558], [0.10, 0.535], [0.06, 0.512], [0.00, 0.52], [0.00, 0.60]];
// Arms hang from the deltoid; in side view a hanging arm lies over the torso,
// so the walk swing is exaggerated to carry the hands past its edges.
const HUMAN_ARM = { L1: 0.17, L2: 0.16, shoulderNear: [0.00, 0.39], shoulderFar: [-0.03, 0.40] };
const HUMAN = {
  walk: {
    lean: (p) => deg(5) + deg(2) * Math.sin(2 * TWO_PI * p),
    hands: (p) => { const s = Math.sin(TWO_PI * (p - 0.25)); return [[0.16 * s, 0.06 + 0.03 * Math.abs(s)], [-0.03 - 0.16 * s, 0.06 + 0.03 * Math.abs(s)]]; },
  },
  trot: {
    lean: (p) => deg(10) + deg(3) * Math.sin(2 * TWO_PI * (p - 0.22)),
    hands: (p) => { const s = Math.sin(TWO_PI * p); return [[0.12 + 0.08 * s, 0.20], [0.09 - 0.08 * s, 0.20]]; },   // running arms, pumping
  },
  canter: {
    lean: (p, flex) => deg(18) - deg(4) * flex,
    hands: () => [[0.20, 0.26], [0.16, 0.28]],
  },
  gallop: {
    lean: (p, flex) => deg(26) - deg(6) * flex,
    hands: () => [[0.20, 0.28], [0.16, 0.30]],
  },
  idle: {
    lean: (p) => deg(2) + deg(1.5) * Math.sin(TWO_PI * p),
    hands: () => [[0.05, 0.12], [0.02, 0.12]],   // akimbo, elbows back
  },
};

// ---------------------------------------------------------------- pose + draw
export function renderFrame(gait, phase, model = 'horse') {
  const bob = gait.bob(phase), pitch = gait.pitch(phase);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const X = (p) => [
    BODY_C[0] + (p[0] - BODY_C[0]) * cp - (p[1] - BODY_C[1]) * sp,
    BODY_C[1] + bob + (p[0] - BODY_C[0]) * sp + (p[1] - BODY_C[1]) * cp,
  ];
  const flex = gait.spine(phase), S = spineXform(flex);   // body-local spine bend, applied before pitch/bob

  // legs
  const legs = {};
  for (const leg of ['LH', 'LF', 'RH', 'RF']) {
    const kind = LEG_KIND[leg], rig = kind === 'fore' ? FORE : HIND;
    const t = hoofTarget(kind, gait.td[leg], gait, phase);
    const farOff = NEAR[leg] ? 0 : -0.03;
    const pivot = X(S([rig.pivot[0] + rig.shift * t.x + farOff, rig.pivot[1] - (rig.drop || 0) * Math.abs(t.x)]));
    const target = [rig.pivot[0] + t.x + farOff, t.y + HOOF_H];
    const { joint, end } = ik(pivot, target, rig.L1, rig.L2, rig.bend);
    legs[leg] = { kind, pivot, joint, end, stance: t.stance, near: NEAR[leg] };
  }
  const drawLeg = (L) => {
    const m = new Mask();
    const upC = L.near ? COAT : FAR, loC = L.near ? POINT : FARPT;
    if (L.kind === 'fore') {
      segU(m, L.pivot, L.joint, wU(5), wU(3), upC);
      segU(m, L.joint, L.end, wU(3), wU(2), loC);
    } else {
      segU(m, L.pivot, L.joint, wU(7), wU(3.5), upC);
      segU(m, L.joint, L.end, wU(3), wU(2), loC);
    }
    const [hx, hy] = toPx(L.end);
    fillRect(m, Math.round(hx) - 1, Math.round(hy), 3, 2, L.near ? HOOF : FARPT);
    return m;
  };

  const frame = new Mask();
  composite(frame, drawLeg(legs.LH), LEG_RING);
  composite(frame, drawLeg(legs.LF), LEG_RING);

  // tail
  const tail = new Mask();
  const tp = gait.tail(phase).map(S).map(X);   // the dock rides the croup
  for (let i = 0; i + 1 < tp.length; i++) segU(tail, tp[i], tp[i + 1], wU(3 - i * 0.6), wU(2.6 - i * 0.6), TAIL);
  composite(frame, tail);

  // body group: trunk (spine-bent topline/underline), rump, chest, then the
  // front end — a horse neck and head, or the centaur's human torso
  const body = new Mask();
  fillPolyU(body, [...crSample(TOPLINE, 4), ...crSample(UNDERLINE, 4).reverse()].map(S).map(X), COAT);
  fillEllipseU(body, X(S([-0.37, 0.79])), 0.17, 0.17, pitch, COAT);   // hindquarters
  fillEllipseU(body, X(S([0.35, 0.72])), 0.16, 0.16, pitch, COAT);    // chest

  let eye, nearArm = null;
  if (model === 'centaur') {
    const hm = HUMAN[gait.name];
    const J = [0.30, 0.96];                                             // human hip joint, on the withers
    const dJ = S(J).map((v, i) => v - J[i]);                            // torso translates with the withers, no local bend
    const lean = hm.lean(phase, flex), cl = Math.cos(lean), sl = Math.sin(lean);
    // local hip-relative coords -> lean about J (forward = +x) -> withers displacement -> pitch/bob
    const T = ([x, y]) => X([J[0] + x * cl + y * sl + dJ[0], J[1] - x * sl + y * cl + dJ[1]]);
    const Bfix = ([x, y]) => X(S([J[0] + x, J[1] + y]));                 // fixed to the trunk (the pelvis does not lean)
    const [handN, handF] = hm.hands(phase, flex);
    const drawArm = (shoulder, hand, near) => {
      const m = new Mask(), ink = near ? SKIN : FARSKIN;
      const { joint, end } = ik(shoulder, hand, HUMAN_ARM.L1, HUMAN_ARM.L2, -1);   // elbow behind the shoulder-hand line
      segU(m, T(shoulder), T(joint), wU(2.5), wU(2), ink);
      segU(m, T(joint), T(end), wU(2), wU(2), ink);
      fillEllipseU(m, T(end), wU(1.4), wU(1.4), 0, ink);                            // hand
      return m;
    };
    composite(frame, drawArm(HUMAN_ARM.shoulderFar, handF, false));
    // pelvis sunk into the withers and chest, fixed to the trunk; torso above it leans
    fillPolyU(body, [[-0.14, -0.06], [0.12, -0.14], [0.10, 0.12], [-0.09, 0.12]].map(Bfix), SKIN);
    fillPolyU(body, [...crSample(HUMAN_FRONT, 3), ...crSample(HUMAN_BACK, 3)].map(T), SKIN);
    fillEllipseU(body, T([0.00, 0.40]), 0.055, 0.055, 0, SKIN);         // deltoid
    fillPolyU(body, [[-0.03, 0.40], [0.05, 0.40], [0.07, 0.50], [0.00, 0.50]].map(T), SKIN);   // neck, slanting forward
    fillEllipseU(body, T([0.02, 0.585]), 0.075, 0.08, pitch - lean, SKIN);          // skull
    fillPolyU(body, HUMAN_FACE.map(T), SKIN);                            // brow, nose, chin
    shade(body);
    fillEllipseU(body, T([-0.01, 0.62]), 0.08, 0.06, pitch - lean, MANE);           // hair, top and back of the skull
    eye = T([0.085, 0.59]);
    nearArm = drawArm(HUMAN_ARM.shoulderNear, handN, true);
  } else {
    const a = gait.neck(phase), b = gait.head(phase);
    const A = S([0.24, 0.99]), B = [0.44, 0.68];                        // neck root rides the withers
    const P = [A[0] + 0.36 * Math.cos(a), A[1] + 0.36 * Math.sin(a)];           // poll
    const T = [P[0] + 0.21 * Math.sin(a), P[1] - 0.21 * Math.cos(a)];           // throat
    fillPolyU(body, [A, P, T, B].map(X), COAT);
    const hd = [Math.cos(b), Math.sin(b)], pd = [Math.sin(b), -Math.cos(b)];
    const nose = [P[0] + 0.42 * hd[0], P[1] + 0.42 * hd[1]];
    fillPolyU(body, [
      [P[0] - 0.03, P[1] + 0.02], nose,
      [nose[0] + 0.11 * pd[0], nose[1] + 0.11 * pd[1]],
      [P[0] + 0.08 * hd[0] + 0.21 * pd[0], P[1] + 0.08 * hd[1] + 0.21 * pd[1]],
    ].map(X), COAT);
    fillPolyU(body, [[P[0] - 0.04, P[1] - 0.02], [P[0] - 0.02, P[1] + 0.11], [P[0] + 0.05, P[1] + 0.00]].map(X), COAT); // ear
    shade(body);
    // mane (black points) sits on top of the shaded neck
    segU(body, X([0.18, 1.00]), X([P[0] - 0.03, P[1] + 0.02]), wU(2.5), wU(2), MANE, false);
    segU(body, X([P[0] - 0.01, P[1] + 0.03]), X([P[0] + 0.09 * hd[0], P[1] + 0.09 * hd[1] + 0.02]), wU(2), wU(1), MANE, false); // forelock
    eye = X([P[0] + 0.15 * hd[0] + 0.06 * pd[0], P[1] + 0.15 * hd[1] + 0.06 * pd[1]]);
  }
  composite(frame, body);
  { const [ex, ey] = toPx(eye); frame.set(Math.round(ex - 0.5), Math.round(ey - 0.5), EYE); }   // eye: one light pixel
  if (nearArm) composite(frame, nearArm);

  composite(frame, drawLeg(legs.RH), LEG_RING);
  composite(frame, drawLeg(legs.RF), LEG_RING);

  return { frame, legs };
}

// ---------------------------------------------------------------- PNG
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
export function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// An RGBA image we can blit masks into.
class Image {
  constructor(w, h) { this.w = w; this.h = h; this.d = Buffer.alloc(w * h * 4); }
  put(x, y, rgba) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = (y * this.w + x) * 4; this.d[i] = rgba[0]; this.d[i + 1] = rgba[1]; this.d[i + 2] = rgba[2]; this.d[i + 3] = rgba[3]; }
  blitMask(m, ox, oy) { for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) { const c = m.a[y * FW + x]; if (c) this.put(ox + x, oy + y, PALETTE[c]); } }
  png() { return encodePNG(this.w, this.h, this.d); }
}

// ×k nearest-neighbour preview with a 1-px frame grid on a parchment ground.
function preview(strips, k = 4) {
  const rows = strips.length, cols = Math.max(...strips.map(s => s.length));
  const img = new Image(cols * (FW * k + 1) + 1, rows * (FH * k + 1) + 1);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) img.put(x, y, [0xe9, 0xe1, 0xd0, 255]);
  strips.forEach((frames, r) => frames.forEach((m, c) => {
    const ox = c * (FW * k + 1) + 1, oy = r * (FH * k + 1) + 1;
    for (let y = 0; y < FH * k; y++) for (let x = 0; x < FW * k; x++) {
      const v = m.a[Math.floor(y / k) * FW + Math.floor(x / k)];
      const gy = Math.floor(y / k);
      img.put(ox + x, oy + y, v ? PALETTE[v] : (gy === GROUND ? [0xb8, 0xac, 0x94, 255] : [0xe9, 0xe1, 0xd0, 255]));
    }
    for (let x = 0; x < FW * k + 1; x++) { img.put(ox - 1 + x, oy - 1, [0x88, 0x80, 0x70, 255]); img.put(ox - 1 + x, oy + FH * k, [0x88, 0x80, 0x70, 255]); }
    for (let y = 0; y < FH * k + 1; y++) { img.put(ox - 1, oy - 1 + y, [0x88, 0x80, 0x70, 255]); img.put(ox + FW * k, oy - 1 + y, [0x88, 0x80, 0x70, 255]); }
  }));
  return img;
}

// ---------------------------------------------------------------- main
export function build(model = 'horse') {
  setFrame(model === 'centaur' ? { h: 64, ground: 62 } : { h: 48, ground: 46 });
  const names = Object.keys(GAITS);
  const strips = [], meta = {};
  const problems = [];
  names.forEach((name, row) => {
    const g = GAITS[name], n = g.frames ?? N, frames = [];
    for (let i = 0; i < n; i++) {
      const { frame, legs } = renderFrame(g, i / n, model);
      frames.push(frame);
      // checks: nothing clipped at the canvas edge; stance hooves on the ground line
      let minx = FW, maxx = -1, miny = FH, maxy = -1;
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) if (frame.a[y * FW + x]) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      if (minx === 0 || miny === 0 || maxx === FW - 1 || maxy === FH - 1) problems.push(`${name}#${i}: touches canvas edge (bbox ${minx},${miny}-${maxx},${maxy})`);
      for (const [leg, L] of Object.entries(legs)) {
        const [, hy] = toPx(L.end);
        if (L.stance && Math.abs(hy + 2 - GROUND) > 1) problems.push(`${name}#${i}: ${leg} stance hoof off the ground (hoof top row ${hy.toFixed(1)})`);
      }
    }
    strips.push(frames);
    const [xb, xf] = g.reach.fore;
    meta[name] = {
      row, frames: n, fps: g.fps, duty: g.duty, footfalls: g.td,
      groundPxPerFrame: +(((xf - xb) * H) / (g.duty * n)).toFixed(3),
      note: g.note,
    };
  });

  const sheet = new Image(FW * N, FH * names.length);
  strips.forEach((frames, r) => frames.forEach((m, c) => sheet.blitMask(m, c * FW, r * FH)));
  const pv = model === 'horse' ? 'preview-' : `preview-${model}-`;     // the horse keeps its original file names
  writeFileSync(join(OUT, `${model}-sheet.png`), sheet.png());
  names.forEach((name, r) => {
    const s = new Image(FW * strips[r].length, FH);
    strips[r].forEach((m, c) => s.blitMask(m, c * FW, 0));
    writeFileSync(join(OUT, `${model}-${name}.png`), s.png());
  });
  writeFileSync(join(OUT, `${model}-sheet.json`), JSON.stringify({
    model, image: `${model}-sheet.png`, frameWidth: FW, frameHeight: FH, groundY: GROUND, withersPx: H, anchorX: CX,
    palette: PALETTE.slice(1).map(c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')),
    gaits: meta,
    source: 'Gait timing after Hildebrand; postures read from Muybridge: Eagle walking (Animal Locomotion, 1887) and Sallie Gardner (The Horse in Motion, 1878).',
  }, null, 2));
  writeFileSync(join(OUT, `${pv}all.png`), preview(strips, 4).png());
  names.forEach((name, r) => { const f = strips[r]; writeFileSync(join(OUT, `${pv}${name}.png`), preview(f.length > 6 ? [f.slice(0, 6), f.slice(6)] : [f], 6).png()); });

  // fingerprint (FNV-1a over the sheet bytes) so a byte-level change is visible in a diff
  let hsh = 0x811c9dc5; for (const b of sheet.d) { hsh ^= b; hsh = Math.imul(hsh, 0x01000193) >>> 0; }
  return { names, meta, problems, fingerprint: hsh.toString(16).padStart(8, '0') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const model of ['horse', 'centaur']) {
    const r = build(model);
    console.log(`${model}: sheet ${FW * N}×${FH * r.names.length}  frames ${FW}×${FH}  ground row ${GROUND}  withers ${H}px  fingerprint ${r.fingerprint}`);
    if (model === 'horse') for (const [k, v] of Object.entries(r.meta)) console.log(`  ${k.padEnd(7)} ${String(v.frames).padStart(2)} fr @ ${String(v.fps).padStart(2)} fps  duty ${v.duty}  ground ${v.groundPxPerFrame} px/frame  — ${v.note}`);
    if (r.problems.length) { console.log('PROBLEMS:'); r.problems.forEach(p => console.log('  ' + p)); process.exitCode = 1; }
  }
}
