# Muybridge horse — sprite plates

Pixel-art horse locomotion cycles generated from a 2-D rig whose timing
follows Hildebrand's gait diagrams and whose postures were read off
Eadweard Muybridge's plates. 64×48 px frames, 12 per cycle (Muybridge's
twelve-camera battery), one row per gait, no anti-aliasing, 11-colour palette.

Live viewer: https://syntaxswine.github.io/muybridge-horse/

```
node gen.mjs        # regenerates out/ and prints the sheet fingerprint; exit 1 on a clipped frame or a stance hoof off the ground
```

No dependencies — the PNG encoder is forty lines over `zlib.deflateSync`.

## The sheet

`out/horse-sheet.png` (768×240) + `out/horse-sheet.json`

| row | gait   | frames | fps | duty | footfalls (phase)                   | ground px/frame | read from |
|-----|--------|--------|-----|------|-------------------------------------|-----------------|-----------|
| 0   | walk   | 12     | 12  | 0.65 | LH 0.00 · LF 0.25 · RH 0.50 · RF 0.75 | 1.805 | *Eagle walking*, Animal Locomotion pl. (1887) |
| 1   | trot   | 12     | 16  | 0.45 | LF+RH 0.00 · RF+LH 0.50               | 2.844 | diagonal couplets |
| 2   | canter | 12     | 18  | 0.36 | LH 0.00 · RH+LF 0.28 · RF 0.52        | 4.296 | right lead, three-beat |
| 3   | gallop | 12     | 24  | 0.28 | LH 0.00 · RH 0.10 · LF 0.30 · RF 0.42 | 6.095 | *Sallie Gardner*, The Horse in Motion (1878) |
| 4   | idle   | 4      | 4   | 1.00 | —                                     | 0     | the card's twelfth frame |

The sprite faces right, so the **right** legs are the near side (as Sallie
Gardner ran past the battery). Frame anchor: body centre at column 32, ground
line at row 46 (hoof bottoms rest on row 45). `groundPxPerFrame` is the speed
a scrolling ground must move, per animation frame, for a stance hoof to stay
planted — it is (stance excursion) / (duty × frames), so it is a property of
the cycle, not a guess.

Per-gait strips are also written (`out/horse-<gait>.png`), and ×4/×6
nearest-neighbour previews (`out/preview-*.png`) for eyeballing.

## The centaur

`out/centaur-sheet.png` (768×320, 64×64 frames, ground row 62) + `out/centaur-sheet.json`

Same rig from the withers back — trunk, spine, legs, tail and every gait table
are shared byte-for-byte, so a centaur and a horse in the same scene keep step.
The horse neck and head are replaced by a human half whose hip joint sits on
the withers: pelvis on the withers-to-chest slope, torso widening to the
shoulders, neck, head with a cap of hair, and two IK arms (elbow behind the
shoulder-hand line). Per gait the torso leans forward with speed (5° walk,
10° trot, 18° canter, 26° gallop, minus a little when the back rounds) and the
arms swing at the walk, pump at the trot, and are held forward and bent at the
canter and gallop; idle is akimbo. Far arm is drawn behind the body group, near
arm in front with its own outline. The frame is 16 px taller for the head.

## How the frames are made

`gen.mjs` poses a rig in *withers units* (H = height at the withers, x forward,
y up, ground at 0):

- **Legs** are two-bone IK chains — elbow → knee → hoof with the knee bending
  forward, stifle → hock → hoof with the hock bending back — driven by a hoof
  target: during stance the hoof slides backward under the body at constant
  speed; during swing it travels forward on a lifted arc. Fore legs fold early
  and hard (the folded-to-the-chest forelegs of Sallie Gardner frames 1, 8, 9);
  hinds arc. The shoulder pivot swings a little with the hoof (scapular rotation).
- **Trunk** is a bendable spine, not a tube. Topline and underline stations
  (the back dips behind the withers and rises to the croup; the belly is
  deepest at the girth and rises into the flank) are sampled through a
  Catmull-Rom curve and displaced by the gait's spinal flex: a parabola on the
  mid-back where +1 rounds the back and tucks the croup under (Sallie Gardner
  frame 7) and −1 hollows it (frame 4). Rump, chest, neck root, leg pivots and
  the tail dock all ride the same spine. The whole trunk is then pitched and
  bobbed per gait: the gallop is lowest over the forehand and highest
  mid-suspension, nose up on the hind push and down over the forehand.
- **Neck and head** angles per gait: 40° neck / steep face at the walk (Eagle's
  carriage, nodding twice a stride), 22° extended neck with the nose out at the
  gallop.
- **Raster**: scanline polygons and rotated ellipses sampled at pixel centres,
  straight to 1×. Each layer group (far legs, tail, body, near legs) is
  composited with a one-pixel outline ring; the ring is suppressed where an
  upper leg segment meets the body, so thighs merge into the silhouette while
  cannons and hooves stay outlined across the belly. A two-pixel top-lit rim and
  belly shadow are the only shading.

## Sources (public domain)

- Eadweard Muybridge, *Walking with a bucket in mouth; light-gray horse, Eagle*,
  Animal Locomotion, 1884–87 (George Eastman Museum via Google Art Project) —
  https://commons.wikimedia.org/wiki/File:Eadweard_J._Muybridge_-_Walking_with_a_bucket_in_mouth;_light-gray_horse,_Eagle_-_Google_Art_Project.jpg
- Eadweard Muybridge, *The Horse in Motion* ("Sallie Gardner", Palo Alto, 19 June 1878) —
  https://commons.wikimedia.org/wiki/File:The_Horse_in_Motion_high_res.jpg
- Gait timing after Milton Hildebrand, "Symmetrical gaits of horses", *Science* 150 (1965).

Everything in `out/` is generated; the sprites are CC0 — take them.
