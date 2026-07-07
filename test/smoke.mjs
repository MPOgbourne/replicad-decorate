/*
 * Smoke tests for the SVG parsing pipeline, running against real
 * opencascade geometry. Run with: yarn build && node test/smoke.mjs
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { setOC } from "replicad";

import { drawSVG } from "../dist/es/replicad-decorate.js";

const require = createRequire(import.meta.url);

// The opencascade emscripten build is an ES module that still references
// the CJS globals when running in node — shim them
const ocEntry = require.resolve("replicad-opencascadejs/src/replicad_single.js");
globalThis.__dirname = dirname(ocEntry);
globalThis.require = require;
const { default: opencascade } = await import(ocEntry);

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const near = (a, b, tolerance = 0.15) => Math.abs(a - b) <= tolerance;

const bbox = (drawing) => {
  const { width, height, center } = drawing.boundingBox;
  return { width, height, center };
};

let oc;
try {
  oc = await opencascade({
    locateFile: () =>
      require.resolve("replicad-opencascadejs/src/replicad_single.wasm"),
  });
} catch (error) {
  console.error(
    "opencascade init failed:",
    (error && (error.message || String(error))).slice(0, 500)
  );
  process.exit(1);
}
setOC(oc);

check("basic filled rect keeps aspect ratio", () => {
  const d = drawSVG(`<svg><rect x="10" y="10" width="40" height="20"/></svg>`, {
    width: 60,
  });
  const { width, height } = bbox(d);
  assert(near(width, 60), `width ${width} != 60`);
  assert(near(height, 30), `height ${height} != 30`);
});

check("rect with only rx rounds corners (spec ry default)", () => {
  const sharp = drawSVG(
    `<svg><rect width="40" height="20"/></svg>`,
    { width: 40 }
  );
  const rounded = drawSVG(
    `<svg><rect width="40" height="20" rx="5"/></svg>`,
    { width: 40 }
  );
  // A rounded rect drawn at the same width must contain arcs — compare the
  // svg path output: the rounded one has curve segments
  const sharpPaths = JSON.stringify(sharp.toSVGPaths());
  const roundedPaths = JSON.stringify(rounded.toSVGPaths());
  assert(!sharpPaths.includes("C") && !sharpPaths.includes("A"), "sharp rect has curves");
  assert(roundedPaths.includes("C") || roundedPaths.includes("A"), "rx-only rect has no curves");
});

check("group transforms apply (translate + scale)", () => {
  // two unit squares, one scaled 3x — bounding box must reflect the scaling
  const d = drawSVG(
    `<svg>
      <g transform="scale(3)"><rect x="0" y="0" width="10" height="10"/></g>
      <rect x="40" y="0" width="10" height="10"/>
    </svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 50), `width ${width} != 50`);
  assert(near(height, 30), `height ${height} != 30`);
});

check("rotate transform applies", () => {
  const d = drawSVG(
    `<svg><rect width="40" height="10" transform="rotate(90)"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 10), `width ${width} != 10`);
  assert(near(height, 40), `height ${height} != 40`);
});

check("defs content is not rendered, use references work", () => {
  const d = drawSVG(
    `<svg>
      <defs><rect id="unit" width="10" height="10"/></defs>
      <use href="#unit" x="0" y="0"/>
      <use href="#unit" x="20" y="0"/>
    </svg>`,
    { width: null }
  );
  const { width } = bbox(d);
  // two 10-wide squares at x=0 and x=20 → 30 total; if defs rendered
  // directly it would still be 30, but if use failed it would throw (no
  // geometry). Cross-check count via paths.
  assert(near(width, 30), `width ${width} != 30`);
  const paths = d.toSVGPaths();
  assert(paths.length === 2, `expected 2 shapes, got ${paths.length}`);
});

check("circle and ellipse render", () => {
  const d = drawSVG(
    `<svg><circle cx="0" cy="0" r="10"/><ellipse cx="30" cy="0" rx="8" ry="4"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 48), `width ${width} != 48`);
  assert(near(height, 20), `height ${height} != 20`);
});

check("path data after Z is not dropped", () => {
  // after the Z the L continues from the subpath start (0,0)
  const d = drawSVG(
    `<svg><path d="M0 0H10V10H0Z L-10 0 -10 -10 0 -10Z"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 20), `width ${width} != 20 (post-Z subpath dropped)`);
  assert(near(height, 20), `height ${height} != 20`);
});

check("stroke-only closed shape becomes a band", () => {
  const d = drawSVG(
    `<svg><circle r="10" fill="none" stroke="black" stroke-width="2"/></svg>`,
    { width: null }
  );
  const { width } = bbox(d);
  assert(near(width, 22), `outer width ${width} != 22`);
  const paths = d.toSVGPaths();
  // a band is a compound shape: outer circle + inner hole
  assert(
    JSON.stringify(paths).split("M").length - 1 >= 2,
    "band should have an outer and an inner contour"
  );
});

check("stroke-only open path (polyline) becomes a buffer", () => {
  const d = drawSVG(
    `<svg><polyline points="0,0 20,0" fill="none" stroke="black" stroke-width="4"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 24, 0.5), `width ${width} != 24`);
  assert(near(height, 4, 0.5), `height ${height} != 4`);
});

check("line element with stroke renders", () => {
  const d = drawSVG(
    `<svg><line x1="0" y1="0" x2="0" y2="30" stroke="red" stroke-width="2"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(height, 32, 0.5), `height ${height} != 32`);
  assert(near(width, 2, 0.5), `width ${width} != 2`);
});

check("stroke width scales with transform", () => {
  const d = drawSVG(
    `<svg><g transform="scale(3)"><line x1="0" y1="0" x2="0" y2="10" stroke="red" stroke-width="2"/></g></svg>`,
    { width: null }
  );
  const { width } = bbox(d);
  assert(near(width, 6, 0.5), `width ${width} != 6 (stroke not scaled)`);
});

check("display:none and visibility:hidden are skipped", () => {
  const d = drawSVG(
    `<svg>
      <rect width="10" height="10"/>
      <rect x="100" width="10" height="10" display="none"/>
      <rect x="200" width="10" height="10" visibility="hidden"/>
      <g style="display: none"><rect x="300" width="10" height="10"/></g>
    </svg>`,
    { width: null }
  );
  assert(near(bbox(d).width, 10), `hidden elements were rendered`);
});

check("fill=none stroke=none renders nothing (throws)", () => {
  let threw = false;
  try {
    drawSVG(`<svg><rect width="10" height="10" fill="none"/></svg>`);
  } catch (error) {
    threw = true;
  }
  assert(threw, "expected an error for a fully invisible SVG");
});

check("fitViewBox preserves margins and centers on viewBox", () => {
  const d = drawSVG(
    `<svg viewBox="0 0 100 100"><rect x="40" y="40" width="20" height="20"/></svg>`,
    { width: 50, fitViewBox: true }
  );
  const { width, center } = bbox(d);
  // the 20-wide rect occupies 20% of the 100-wide viewBox → 10 after scaling
  assert(near(width, 10), `width ${width} != 10`);
  assert(near(center[0], 0) && near(center[1], 0), `not centered: ${center}`);
});

check("arc radius correction (undersized radii)", () => {
  // spec: radii too small are scaled up so the arc can span the endpoints
  const d = drawSVG(`<svg><path d="M0 0A1 1 0 0 1 20 0L10 5Z"/></svg>`, {
    width: null,
  });
  const { width } = bbox(d);
  assert(near(width, 20, 0.5), `width ${width} != 20`);
});

check("curve loop with coincident endpoints is kept", () => {
  const d = drawSVG(
    `<svg><path d="M0 0C30 -30 30 30 0 0Z"/></svg>`,
    { width: null }
  );
  const { width } = bbox(d);
  assert(width > 5, `loop curve was dropped (width ${width})`);
});

check("polyline with fill closes for filling (spec)", () => {
  const d = drawSVG(
    `<svg><polyline points="0,0 20,0 20,20 0,20" fill="black"/></svg>`,
    { width: null }
  );
  const { width, height } = bbox(d);
  assert(near(width, 20) && near(height, 20), "polyline fill broken");
});

check("nested transforms compose in order", () => {
  const a = drawSVG(
    `<svg><g transform="translate(10 0)"><g transform="scale(2)"><rect width="5" height="5"/></g></g></svg>`,
    { width: null }
  );
  // translate(10) scale(2) → rect spans x 10..20
  const { center, width } = bbox(a);
  assert(near(width, 10), `width ${width} != 10`);
  assert(near(center[0], 15), `center ${center[0]} != 15`);
});

check("mirrorY behavior: drawing is y-flipped vs raw coordinates", () => {
  const d = drawSVG(
    `<svg><rect x="0" y="10" width="10" height="5"/></svg>`,
    { width: null }
  );
  const { center } = bbox(d);
  assert(near(center[1], -12.5), `y center ${center[1]} != -12.5`);
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll smoke tests passed");
process.exit(failures ? 1 : 0);
