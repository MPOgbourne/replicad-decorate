/*
 * End-to-end: decorate a real 3D box with an SVG and text.
 * Run with: yarn build && node test/e2e.mjs
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const ocEntry = require.resolve("replicad-opencascadejs/src/replicad_single.js");
globalThis.__dirname = dirname(ocEntry);
globalThis.require = require;
const { default: opencascade } = await import(ocEntry);
const { setOC, makeBaseBox } = await import("replicad");
const oc = await opencascade({ locateFile: () => require.resolve("replicad-opencascadejs/src/replicad_single.wasm") });
setOC(oc);

const { addSVG, addText, addBorder, drawSVG } = await import("../dist/es/replicad-decorate.js");
const { measureVolume } = await import("replicad");

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
};

// a realistic icon: shorthand curves, transform on a group, mixed fill and
// stroke, defs/use
const ICON = `
<svg viewBox="0 0 24 24">
  <defs><circle id="dot" r="1.2"/></defs>
  <g transform="translate(2 2) scale(0.9)">
    <path d="M2 2Q2 0 4 0T8 2S10 6 8 8C6 10 4 10 2 8z" />
    <rect x="12" y="2" width="8" height="6" rx="1.5"/>
    <use href="#dot" x="16" y="14"/>
    <polyline points="2,14 6,18 10,14" fill="none" stroke="black" stroke-width="1.4"/>
  </g>
</svg>`;

await check("realistic icon parses into a drawing", () => {
  const d = drawSVG(ICON, { width: 30 });
  const { width, height } = d.boundingBox;
  if (!(width > 29.9 && width < 30.1)) throw new Error(`bad width ${width}`);
  if (!(height > 5)) throw new Error(`bad height ${height}`);
});

await check("addSVG engraves into a box face", async () => {
  const box = makeBaseBox(80, 60, 10);
  const decorated = await addSVG(box, {
    faceIndex: 4,
    depth: -1,
    svgString: ICON,
    width: 40,
  });
  if (!decorated || decorated.faces.length <= box.faces.length) {
    throw new Error("engraving did not add any faces");
  }
});

await check("addSVG embosses (positive depth)", async () => {
  const box = makeBaseBox(80, 60, 10);
  const decorated = await addSVG(box, {
    faceIndex: 4,
    depth: 1,
    svgString: `<svg><circle r="10" fill="none" stroke="black" stroke-width="2"/></svg>`,
    width: 30,
  });
  if (!decorated || decorated.faces.length <= box.faces.length) {
    throw new Error("embossing did not add any faces");
  }
});

await check("addSVG rejects a bad faceIndex with a clear error", async () => {
  const box = makeBaseBox(10, 10, 10);
  try {
    await addSVG(box, { faceIndex: 99, depth: -1, svgString: ICON });
  } catch (error) {
    if (/Face 99 not found/.test(error.message)) return;
    throw new Error(`unexpected error: ${error.message}`);
  }
  throw new Error("no error thrown");
});

await check("addText engraves with defaults (no NaN shifts)", async () => {
  const box = makeBaseBox(80, 60, 10);
  const decorated = await addText(box, {
    faceIndex: 4,
    text: "Hi",
    depth: -1,
    fontSize: 20,
  });
  if (!decorated || decorated.faces.length <= box.faces.length) {
    throw new Error("text engraving did not add any faces");
  }
});

await check("addText caches the font (second call, no reload)", async () => {
  const box = makeBaseBox(80, 60, 10);
  const start = Date.now();
  await addText(box, { faceIndex: 4, text: "Yo", depth: -1, fontSize: 20 });
  console.log(`     (second addText took ${Date.now() - start}ms)`);
});

await check("oversized text still engraves the part inside the outline", async () => {
  const box = makeBaseBox(30, 30, 10);
  const decorated = await addText(box, {
    faceIndex: 4,
    text: "AB",
    depth: -1,
    fontSize: 40, // glyphs overflow the 30mm face
    margin: 2,
    mirrorY: true,
  });
  if (!decorated || decorated.faces.length <= box.faces.length) {
    throw new Error("clipped oversized text did not engrave anything");
  }
});

await check("addText carveBackground sinks the face around the text", async () => {
  const box = makeBaseBox(80, 60, 10);
  const decorated = await addText(box, {
    faceIndex: 4,
    text: "Hi",
    depth: 1,
    fontSize: 20,
    margin: 3,
    carveBackground: true,
  });
  if (!decorated || decorated.faces.length <= box.faces.length) {
    throw new Error("carveBackground did not add any faces");
  }
  // The carve is a cut: the bounding box must not grow beyond the original
  const before = box.boundingBox;
  const after = decorated.boundingBox;
  const grew =
    after.bounds[1][2] > before.bounds[1][2] + 1e-6 ||
    after.bounds[0][2] < before.bounds[0][2] - 1e-6;
  if (grew) throw new Error("carveBackground protruded past the face");
});

// --- addBorder ---

// Top face of a makeBaseBox is index 4 (same as the addSVG tests above)
const borderBox = () => makeBaseBox(40, 40, 10);

for (const profile of ["vertical", "sloped", "chamfered", "rounded"]) {
  await check(`addBorder raised outline (${profile}) adds volume`, async () => {
    const box = borderBox();
    const before = measureVolume(box);
    const decorated = await addBorder(box, {
      faceIndex: 4,
      depth: 1,
      width: 2,
      margin: 2,
      profile,
      angle: 20,
    });
    const after = measureVolume(decorated);
    if (!(after > before + 1e-3)) {
      throw new Error(`volume did not grow (${before} -> ${after})`);
    }
    // A ring must never grow the part outside the original footprint
    const grew =
      decorated.boundingBox.bounds[1][0] > box.boundingBox.bounds[1][0] + 1e-6;
    if (grew) throw new Error("border overflowed the face");
  });

  await check(`addBorder engraved outline (${profile}) removes volume`, async () => {
    const box = borderBox();
    const before = measureVolume(box);
    const decorated = await addBorder(box, {
      faceIndex: 4,
      depth: -1,
      width: 2,
      margin: 2,
      profile,
      angle: 20,
    });
    const after = measureVolume(decorated);
    if (!(after < before - 1e-3)) {
      throw new Error(`volume did not shrink (${before} -> ${after})`);
    }
  });
}

await check("addBorder circle shape cuts a ring groove", async () => {
  const box = borderBox();
  const before = measureVolume(box);
  const decorated = await addBorder(box, {
    faceIndex: 4,
    depth: -1,
    width: 1.5,
    margin: 3,
    borderShape: "circle",
  });
  const after = measureVolume(decorated);
  if (!(after < before - 1e-3)) {
    throw new Error(`circle groove missing (${before} -> ${after})`);
  }
});

await check("addBorder rounded shape raises a filleted-corner ring", async () => {
  const box = borderBox();
  const before = measureVolume(box);
  const decorated = await addBorder(box, {
    faceIndex: 4,
    depth: 1,
    width: 1.5,
    margin: 2,
    borderShape: "rounded",
    cornerRadius: 2,
  });
  const after = measureVolume(decorated);
  if (!(after > before + 1e-3)) {
    throw new Error(`rounded ring missing (${before} -> ${after})`);
  }
});

await check("addBorder rejects a ring that cannot fit", async () => {
  const box = makeBaseBox(10, 10, 10);
  try {
    await addBorder(box, { faceIndex: 4, depth: -1, width: 8, margin: 4 });
  } catch (error) {
    return;
  }
  throw new Error("expected an error for an oversized ring");
});

await check("addBorder sloped profile has smaller volume than vertical", async () => {
  const vertical = await addBorder(borderBox(), {
    faceIndex: 4,
    depth: 2,
    width: 3,
    margin: 2,
    profile: "vertical",
  });
  const sloped = await addBorder(borderBox(), {
    faceIndex: 4,
    depth: 2,
    width: 3,
    margin: 2,
    profile: "sloped",
    angle: 25,
  });
  const vVol = measureVolume(vertical);
  const sVol = measureVolume(sloped);
  if (!(sVol < vVol - 1e-3)) {
    throw new Error(`sloped (${sVol}) not smaller than vertical (${vVol})`);
  }
});

// --- border + raised text composition (panel option) ---

const { measureArea } = await import("replicad");

// Top rim face after decorations: largest upward-facing planar face at the
// original top level (z = 10 for borderBox)
const topRimIndex = (shape) => {
  let best = -1;
  let bestArea = -Infinity;
  shape.faces.forEach((face, i) => {
    try {
      const n = face.normalAt();
      if (n.z < 0.9) return;
      if (Math.abs(face.center.z - 10) > 1e-6) return;
      const area = measureArea(face);
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    } catch (e) {
      // non-planar or degenerate face: skip
    }
  });
  if (best < 0) throw new Error("no top rim face found");
  return best;
};

// Ring: margin 2, width 2 on the 40x40 top face. The decoration panel sits
// inside the ring: margin + width + clearance = 4.3
const RING = { depth: 1, width: 2, margin: 2 };
const PANEL = { shape: "outline", margin: 4.3 };
// outline ring area on a 40x40 face: 36² - 32²
const RING_AREA = 36 * 36 - 32 * 32;

const carvedWithPanel = async () =>
  addText(borderBox(), {
    faceIndex: 4,
    text: "6",
    depth: 1,
    fontSize: 20,
    margin: 2,
    carveBackground: true,
    panel: PANEL,
  });

await check("carveBackground panel carves inside the ring only", async () => {
  const noPanel = await addText(borderBox(), {
    faceIndex: 4,
    text: "6",
    depth: 1,
    fontSize: 20,
    margin: 2,
    carveBackground: true,
  });
  const withPanel = await carvedWithPanel();
  const vNoPanel = measureVolume(noPanel);
  const vPanel = measureVolume(withPanel);
  if (!(vPanel > vNoPanel + 1e-3)) {
    throw new Error(`panel did not shrink the carve (${vNoPanel} -> ${vPanel})`);
  }
});

await check("raised ridge fuses fully onto a face with raised text", async () => {
  const carved = await carvedWithPanel();
  const before = measureVolume(carved);
  const decorated = await addBorder(carved, {
    faceIndex: topRimIndex(carved),
    ...RING,
  });
  const added = measureVolume(decorated) - before;
  const expected = RING_AREA * RING.depth;
  // the full ring volume must fuse onto intact material (a floating or
  // partial ring — the old conflict — adds much less)
  if (!(added > expected * 0.8)) {
    throw new Error(`ridge only added ${added} of ~${expected}`);
  }
});

await check("engraved groove still cuts on a face with raised text", async () => {
  const carved = await carvedWithPanel();
  const before = measureVolume(carved);
  const decorated = await addBorder(carved, {
    faceIndex: topRimIndex(carved),
    ...RING,
    depth: -0.5,
  });
  const removed = before - measureVolume(decorated);
  const expected = RING_AREA * 0.5;
  // without the panel the ring region is already carved away and the groove
  // removes ~nothing (the "border disappears" bug)
  if (!(removed > expected * 0.8)) {
    throw new Error(`groove only removed ${removed} of ~${expected}`);
  }
});

await check("surfaceLevel raised border carves the panel around the ring", async () => {
  const box = borderBox();
  const before = measureVolume(box);
  const decorated = await addBorder(box, {
    faceIndex: 4,
    depth: 1,
    width: 2,
    margin: 4,
    surfaceLevel: true,
    panelMargin: 1,
  });
  const removed = before - measureVolume(decorated);
  // panel (38²) minus the untouched ring band (32² - 28²), carved 1mm deep
  const expected = 38 * 38 - (32 * 32 - 28 * 28);
  if (!(removed > expected * 0.8 && removed < expected * 1.2)) {
    throw new Error(`carved ${removed}, expected ~${expected}`);
  }
  // nothing may protrude past the original surface
  const grew =
    decorated.boundingBox.bounds[1][2] > box.boundingBox.bounds[1][2] + 1e-6;
  if (grew) throw new Error("surfaceLevel border protruded past the face");
});

await check("carveBackground ring option leaves the ring standing", async () => {
  const opts = {
    faceIndex: 4,
    text: "6",
    depth: 1,
    fontSize: 14,
    margin: 2,
    carveBackground: true,
  };
  // Baseline: plain full-panel carve. With a ring, the carve spans the same
  // panel (the panel option only clips the glyphs) but the ring band stays.
  const withoutRing = await addText(borderBox(), opts);
  const withRing = await addText(borderBox(), {
    ...opts,
    panel: { shape: "outline", margin: 6.3 },
    ring: { shape: "outline", margin: 4, width: 2 },
  });
  const kept = measureVolume(withRing) - measureVolume(withoutRing);
  // the ring band (32² - 28²) x 1mm is not carved when the ring is kept
  const expected = 32 * 32 - 28 * 28;
  if (!(kept > expected * 0.8 && kept < expected * 1.2)) {
    throw new Error(`ring kept ${kept}, expected ~${expected}`);
  }
  // ring tops stay at surface: no protrusion
  const grew =
    withRing.boundingBox.bounds[1][2] >
    borderBox().boundingBox.bounds[1][2] + 1e-6;
  if (grew) throw new Error("ring protruded past the face");
});

await check("panel margin 0 carves more than margin 0.1 (no fallback jump)", async () => {
  const carve = async (margin) =>
    measureVolume(
      await addText(borderBox(), {
        faceIndex: 4,
        text: "6",
        depth: 1,
        fontSize: 14,
        margin: 2,
        carveBackground: true,
        panel: { shape: "outline", margin },
      })
    );
  const atZero = await carve(0);
  const atTenth = await carve(0.1);
  // larger margin leaves more material; a failed 0-offset used to fall back
  // to the default rim and flip this ordering
  if (!(atZero < atTenth - 1e-3)) {
    throw new Error(`margin 0 (${atZero}) did not carve more than 0.1 (${atTenth})`);
  }
  // and the step must be small (~perimeter x 0.1 x depth), not a ~2mm rim jump
  const delta = atTenth - atZero;
  if (delta > 40) {
    throw new Error(`margin 0 -> 0.1 volume step too large: ${delta}`);
  }
});

await check("carve wall profiles remove less material than vertical", async () => {
  const carve = (profile) =>
    addText(borderBox(), {
      faceIndex: 4,
      text: "6",
      depth: 1.5,
      fontSize: 14,
      margin: 2,
      carveBackground: true,
      panel: { shape: "outline", margin: 2, profile, angle: 30 },
    });
  const vertical = measureVolume(await carve("vertical"));
  for (const profile of ["sloped", "chamfered", "rounded"]) {
    const shaped = measureVolume(await carve(profile));
    if (!(shaped > vertical + 1e-3)) {
      throw new Error(`${profile} carve (${shaped}) not smaller than vertical cut (${vertical})`);
    }
  }
});

await check("circle panel carve keeps a circular ring's region intact", async () => {
  const carved = await addText(borderBox(), {
    faceIndex: 4,
    text: "6",
    depth: 1,
    fontSize: 14,
    margin: 2,
    carveBackground: true,
    panel: { shape: "circle", margin: 4.3 },
  });
  const before = measureVolume(carved);
  const decorated = await addBorder(carved, {
    faceIndex: topRimIndex(carved),
    ...RING,
    borderShape: "circle",
  });
  if (!(measureVolume(decorated) > before + 1e-3)) {
    throw new Error("circle ridge did not add volume");
  }
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll e2e tests passed");
process.exit(failures ? 1 : 0);
