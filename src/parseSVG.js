import { organiseBlueprints, Drawing } from "replicad";
import svgpath from "svgpath";

import {
  fuseIntersectingBlueprints,
  flattenToBlueprints,
} from "./blueprintHelpers";
import { collectRenderedShapes } from "./svgDom";
import { elementToPathData } from "./svgElementToPath";
import { pathDataToBlueprints } from "./svgShapes";
import { strokeOpenPathBlueprint } from "./strokeOutline";

const hasGeometry = (drawing) => {
  const bbox = drawing.boundingBox;
  return bbox.width > 1e-12 || bbox.height > 1e-12;
};

// The stroke width scales with the transform. For non-conformal transforms
// (that would render an elliptic pen) we approximate with the average scale,
// i.e. the square root of the determinant.
const transformScaleFactor = (transform) => {
  if (!transform || !transform.trim()) return 1;

  const points = [];
  svgpath("M0 0L1 0L0 1")
    .transform(transform)
    .abs()
    .iterate((s) => {
      points.push([s[s.length - 2], s[s.length - 1]]);
    });

  const [origin, unitX, unitY] = points;
  const determinant =
    (unitX[0] - origin[0]) * (unitY[1] - origin[1]) -
    (unitX[1] - origin[1]) * (unitY[0] - origin[0]);
  return Math.sqrt(Math.abs(determinant));
};

// replicad's offset has no miter limit, so an unlimited miter can shoot
// spikes on sharp corners. We default to round joins instead.
const JOIN_TYPES = {
  miter: "miter",
  "miter-clip": "miter",
  bevel: "bevel",
  round: "round",
  arcs: "round",
};
const strokeJoinType = (style) => JOIN_TYPES[style.strokeLinejoin] || "round";

const isPainted = (paint) => {
  return paint && paint !== "none" && paint !== "transparent";
};

const strokeBands = (pathData, transform, style) => {
  const bands = [];

  const scaledWidth = style.strokeWidth * transformScaleFactor(transform);
  if (!(scaledWidth > 1e-12)) return bands;
  const halfWidth = scaledWidth / 2;
  const joinConfig = { lineJoinType: strokeJoinType(style) };

  for (const { blueprint, closed, segments } of pathDataToBlueprints(
    pathData,
    { transform }
  )) {
    try {
      let band;
      if (closed) {
        const base = new Drawing(blueprint);
        const outer = base.offset(halfWidth, joinConfig);
        const inner = base.offset(-halfWidth, joinConfig);
        band = hasGeometry(inner) ? outer.cut(inner) : outer;
      } else {
        band = new Drawing(strokeOpenPathBlueprint(segments, halfWidth));
      }
      if (band && hasGeometry(band)) bands.push(band);
    } catch (error) {
      console.warn(
        `replicad-decorate: could not render a stroke (${error.message})`
      );
    }
  }

  return bands;
};

/**
 * Draws an SVG string as a replicad Drawing.
 *
 * Handles path, rect, circle, ellipse, line, polyline and polygon elements,
 * groups, use/defs/symbol references, transforms, and both fills and
 * strokes (strokes are expanded into bands of their stroke-width).
 *
 * Options:
 * - `width`: the drawing is scaled so its width matches this value
 * - `fitViewBox`: scale and center relative to the SVG viewBox instead of
 *   the geometry bounding box, preserving designed margins
 * - `alwaysClosePaths`: deprecated — filling now always closes open
 *   subpaths, as the SVG spec mandates
 */
export function drawSVG(
  svg,
  { width = 60, alwaysClosePaths = false, fitViewBox = false } = {}
) {
  // eslint-disable-next-line no-unused-vars
  void alwaysClosePaths;

  const { shapes, viewBox } = collectRenderedShapes(svg);

  const fillBlueprints = [];
  const strokes = [];

  for (const { tag, element, transform, style } of shapes) {
    const stroked = isPainted(style.stroke) && style.strokeWidth > 0;
    // A line has no fill area, per spec
    const filled = tag !== "line" && isPainted(style.fill);
    if (!filled && !stroked) continue;

    const pathData = elementToPathData(tag, element, viewBox);
    if (!pathData) continue;

    try {
      if (filled) {
        const subpaths = pathDataToBlueprints(pathData, {
          transform,
          autoClose: true,
        });
        fillBlueprints.push(...subpaths.map(({ blueprint }) => blueprint));
      }
      if (stroked) {
        strokes.push(...strokeBands(pathData, transform, style));
      }
    } catch (error) {
      console.warn(
        `replicad-decorate: skipping a <${tag}> element (${error.message})`
      );
    }
  }

  let drawing = null;
  if (fillBlueprints.length) {
    const fused = fuseIntersectingBlueprints(fillBlueprints);
    drawing = new Drawing(organiseBlueprints(flattenToBlueprints(fused)));
  }
  for (const stroke of strokes) {
    drawing = drawing ? drawing.fuse(stroke) : stroke;
  }

  if (!drawing || !hasGeometry(drawing)) {
    throw new Error("The SVG contains no drawable geometry");
  }

  // SVG uses a y-down coordinate system
  drawing = drawing.mirror([1, 0], [0, 0], "plane");

  if (fitViewBox && viewBox) {
    const factor = width ? width / viewBox.width : 1;
    const centerX = viewBox.x + viewBox.width / 2;
    const centerY = viewBox.y + viewBox.height / 2;
    drawing = drawing.translate(-centerX, centerY).scale(factor, [0, 0]);
  } else if (width) {
    const bbox = drawing.boundingBox;
    const reference = bbox.width > 1e-9 ? bbox.width : bbox.height;
    if (reference > 1e-9) {
      drawing = drawing.scale(width / reference, bbox.center);
    }
  }

  return drawing;
}
