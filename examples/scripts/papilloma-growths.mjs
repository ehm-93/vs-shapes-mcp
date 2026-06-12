// Ring-1 procedural pass: Shope-papilloma-style metal tumor field.
// Strips the tidy designed armor (plates/saddles/stacks), keeps the embedded gear,
// and scatters a seeded field of irregular metal horn-growths erupting through the
// whole body — denser on head/neck/dorsal line, like the real virus's keratin horns.
import { readFileSync, writeFileSync } from 'node:fs';
import { ShapeDocument } from './dist/vs/document.js';
import { addElement, deleteElement } from './dist/vs/elements.js';
import { autoUv } from './dist/vs/uv.js';
import { validateDocument } from './dist/vs/validate.js';

const PATH = 'examples/tyrant.json';
const doc = ShapeDocument.parse(readFileSync(PATH, 'utf8'));

// 1. Remove the tidy, designed-looking armor — disease is chaotic, not engineered.
for (const n of ['skull plate', 'shoulder saddle', 'hip saddle', 'L stack', 'R stack']) {
  deleteElement(doc, n); // none are keyframed, so no force needed
}

// seeded LCG so the growth field is deterministic / reproducible
let seed = 8675309;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rng = (lo, hi) => lo + rand() * (hi - lo);
const jit = (a = 22) => rng(-a, a);

const sizeOf = (name) => {
  const el = doc.getElement(name);
  const f = el.from.map((v) => v.value);
  const t = el.to.map((v) => v.value);
  return [t[0] - f[0], t[1] - f[1], t[2] - f[2]];
};

// base rotation that aims a +Y-extending box along each outward face normal
const FACE_ROT = {
  '+y': () => ({ x: jit(), z: jit() }),
  '-y': () => ({ x: 180 + jit(), z: jit() }),
  '+z': () => ({ x: 90 + jit(), y: jit() }),
  '-z': () => ({ x: -90 + jit(), y: jit() }),
  '+x': () => ({ z: -90 + jit(), y: jit() }),
  '-x': () => ({ z: 90 + jit(), y: jit() }),
};

// anchor a base point on the chosen face of a host of given size
function anchor(size, face) {
  const [sx, sy, sz] = size;
  const t = (s) => rng(0.1 * s, 0.9 * s); // tangential scatter, keep off the corners
  const v = (s) => rng(0.05 * s, 0.95 * s); // full-height scatter for flanks (cover lower body too)
  switch (face) {
    case '+y': return [t(sx), sy, t(sz)];
    case '-y': return [t(sx), 0, t(sz)];
    case '+z': return [t(sx), v(sy), sz];
    case '-z': return [t(sx), v(sy), 0];
    case '+x': return [sx, v(sy), t(sz)];
    case '-x': return [0, v(sy), t(sz)];
  }
}

const faces = (tex, glow) => {
  const f = {};
  for (const n of ['north', 'east', 'south', 'west', 'up', 'down']) {
    f[n] = { texture: tex, uv: [0, 0, 1, 1], ...(glow ? { glow: 255 } : {}) };
  }
  return f;
};

// Coverage is full-body and densest on the head/face, like the real virus.
const HOSTS = [
  { name: 'snout', faces: ['+y', '-x', '+z', '-z', '+y'], n: 5, len: [1.2, 3], w: [0.4, 0.8] },
  { name: 'jaw', faces: ['+y', '-x', '+z', '-z'], n: 3, len: [1, 2.4], w: [0.4, 0.7] },
  { name: 'head', faces: ['+y', '+y', '+z', '-z', '+x'], n: 8, len: [1.5, 4.5], w: [0.5, 1] },
  { name: 'neck', faces: ['+y', '+y', '+z', '-z'], n: 7, len: [2, 5.5], w: [0.5, 1.1] },
  { name: 'torso', faces: ['+y', '+y', '+z', '-z'], n: 10, len: [2.5, 6.5], w: [0.6, 1.2] },
  { name: 'belly', faces: ['-y', '+z', '-z', '-y'], n: 5, len: [1.5, 4], w: [0.5, 1] },
  { name: 'hips', faces: ['+y', '+y', '+z', '-z'], n: 6, len: [2, 5.5], w: [0.6, 1.1] },
  { name: 'tail1', faces: ['+y', '+y', '+z', '-z'], n: 5, len: [2, 5], w: [0.5, 1] },
  { name: 'tail2', faces: ['+y', '+z', '-z'], n: 3, len: [1.5, 4], w: [0.4, 0.8] },
  { name: 'tail3', faces: ['+y', '+z', '-z'], n: 2, len: [1.5, 3], w: [0.4, 0.6] },
  { name: 'L thigh', faces: ['+z', '+z', '+y', '-x'], n: 3, len: [1.5, 3.5], w: [0.5, 0.9] },
  { name: 'R thigh', faces: ['-z', '-z', '+y', '-x'], n: 3, len: [1.5, 3.5], w: [0.5, 0.9] },
  { name: 'L shin', faces: ['+z', '-x'], n: 2, len: [1.2, 2.6], w: [0.4, 0.7] },
  { name: 'R shin', faces: ['-z', '-x'], n: 2, len: [1.2, 2.6], w: [0.4, 0.7] },
];

let i = 0, twoSeg = 0, glowTips = 0;
for (const host of HOSTS) {
  const size = sizeOf(host.name);
  for (let k = 0; k < host.n; k++) {
    const face = host.faces[Math.floor(rand() * host.faces.length)];
    const [px, py, pz] = anchor(size, face);
    let L = rng(host.len[0], host.len[1]);
    if (rand() < 0.12) L *= rng(1.5, 2); // occasional grotesque mega-horn
    const w = rng(host.w[0], host.w[1]);
    const tex = rand() < 0.72 ? 'rust' : rand() < 0.7 ? 'brass' : 'rust';
    const name = `growth-${i}`;
    addElement(doc, {
      parent: host.name,
      name,
      from: [px - w, py, pz - w],
      to: [px + w, py + L, pz + w],
      rotationOrigin: [px, py, pz],
      rotation: FACE_ROT[face](),
      faces: faces(tex),
    });
    // taper the longer horns with a thinner, slightly-bent tip segment
    if (L > 2.8 && rand() < 0.8) {
      const w2 = w * rng(0.45, 0.7);
      const L2 = L * rng(0.45, 0.7);
      const glow = rand() < 0.35; // a few infected tips glow
      addElement(doc, {
        parent: name,
        name: `${name}-tip`,
        from: [w - w2, L, w - w2],
        to: [w + w2, L + L2, w + w2],
        rotationOrigin: [w, L, w],
        rotation: { x: jit(18), z: jit(18) },
        faces: faces(glow ? 'glowlamp' : tex, glow),
      });
      twoSeg++;
      if (glow) glowTips++;
    }
    i++;
  }
}

try {
  autoUv(doc);
} catch (e) {
  console.error('autoUv:', e.message);
  process.exit(1);
}

const findings = validateDocument(doc, { level: 'full', footElements: ['L foot', 'R foot'] });
const errs = findings.filter((f) => f.severity === 'error');
console.error(`growths: ${i} (+${twoSeg} tips, ${glowTips} glowing) | findings: ${findings.length} (errors ${errs.length})`);
if (errs.length) {
  console.error(JSON.stringify(errs.slice(0, 6), null, 1));
  process.exit(1);
}
writeFileSync(PATH, doc.serialize());
console.error('saved', PATH);
process.exit(0);
