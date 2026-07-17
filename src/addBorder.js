import { drawFaceOutline, drawCircle, loft, Plane } from "replicad";

import { faceMetric } from "./common";

const EPS = 0.05;
const MIN_RING_WIDTH = 0.2;

const degToRad = (deg) => (deg * Math.PI) / 180;

const isUsableDrawing = (drawing) => {
  try {
    const { width, height } = drawing.boundingBox;
    return width > EPS && height > EPS;
  } catch (e) {
    return false;
  }
};

// Outer contour of the border ring, in metric UV space.
const buildOuterContour = (face, metric, { borderShape, margin, cornerRadius }) => {
  const { toMetric, width, height, uMin, vMin, uLen, vLen, xStretch, yStretch } =
    metric;

  if (borderShape === "circle") {
    const radius = Math.min(width, height) / 2 - margin;
    if (radius <= MIN_RING_WIDTH) {
      throw new Error(`Face too small for a circle border (margin ${margin})`);
    }
    const centerX = (uMin + uLen / 2) * xStretch;
    const centerY = (vMin + vLen / 2) * yStretch;
    return drawCircle(radius).translate([centerX, centerY]);
  }

  let outline = toMetric(drawFaceOutline(face)).offset(-margin);
  if (borderShape === "rounded" && cornerRadius > 0) {
    outline = outline.fillet(cornerRadius);
  }
  return outline;
};

// Straight-walled ring solid standing on (or sunk into) the face.
const extrudeRing = (face, metric, outer, inner, depth) =>
  metric.toNative(outer.cut(inner)).sketchOnFace(face, "native").extrude(depth);

// Drafted ring: ruled loft between the base contours and contours narrowed by
// dx at the far end (ridge top when raised, groove bottom when engraved).
const slopedTool = (face, metric, outer, inner, { h, sign, angle, width }) => {
  const { toNative } = metric;

  const maxDx = Math.max(0, (width - MIN_RING_WIDTH) / 2);
  const dx = Math.min(h * Math.tan(degToRad(angle)), maxDx);
  if (dx <= 0) {
    return extrudeRing(face, metric, outer, inner, sign * h);
  }

  const outerFar = outer.offset(-dx);
  const innerFar = inner.offset(dx);
  if (!isUsableDrawing(outerFar)) {
    return extrudeRing(face, metric, outer, inner, sign * h);
  }

  const normal = face.normalAt().normalized();
  const shift = normal.multiply(sign * h);

  const wireOn = (drawing) =>
    toNative(drawing).sketchOnFace(face, "native").wire;
  const wireFar = (drawing) => wireOn(drawing).translate(shift);

  const outerSolid = loft([wireOn(outer), wireFar(outerFar)], { ruled: true });
  const innerSolid = loft([wireOn(inner), wireFar(innerFar)], { ruled: true });
  return outerSolid.cut(innerSolid);
};

// Chamfer/fillet the far edge loops of a straight ring tool (the visible top
// of a raised ridge, or the floor of an engraved groove).
const shapeFarEdges = (tool, face, { h, sign, width, size, profile }) => {
  const clamped = Math.min(size, width / 2 - EPS, h - EPS);
  if (clamped <= 0) return tool;

  const normal = face.normalAt().normalized();
  const farPoint = face.center.add(normal.multiply(sign * h));
  const farPlane = new Plane([farPoint.x, farPoint.y, farPoint.z], null, normal);

  const filter = (e) => e.inPlane(farPlane);
  return profile === "rounded"
    ? tool.fillet(clamped, filter)
    : tool.chamfer(clamped, filter);
};

/**
 * Add a decorative border ring to a face of a shape.
 *
 * The ring follows the face outline (optionally with rounded corners) or an
 * inscribed circle, inset by `margin`, with a wall `width`. `depth` is signed
 * like addInset: positive fuses a raised ridge, negative cuts a groove.
 *
 * Profiles shape the far end of the ring (ridge top / groove bottom):
 * - vertical: straight extruded walls
 * - sloped: drafted walls, ring narrows by depth * tan(angle) per side
 * - chamfered / rounded: far edge loops chamfered or filleted
 */
export async function addBorder(
  shape,
  {
    faceIndex,
    depth,
    width,
    margin = 0,
    borderShape = "outline",
    profile = "vertical",
    angle = 15,
    cornerRadius = 1,
    chamferSize,
    filletRadius,
  }
) {
  if (!depth || !width) return shape;

  const face = shape.faces[faceIndex];
  const metric = faceMetric(face);

  const outer = buildOuterContour(face, metric, {
    borderShape,
    margin,
    cornerRadius,
  });
  const inner = outer.offset(-width);
  if (!isUsableDrawing(outer) || !isUsableDrawing(inner)) {
    throw new Error(
      `Border does not fit face ${faceIndex} (margin ${margin}, width ${width})`
    );
  }

  const h = Math.abs(depth);
  const sign = depth > 0 ? 1 : -1;

  let tool;
  if (profile === "sloped") {
    tool = slopedTool(face, metric, outer, inner, { h, sign, angle, width });
  } else {
    tool = extrudeRing(face, metric, outer, inner, depth);
    if (profile === "chamfered" || profile === "rounded") {
      const size =
        profile === "rounded"
          ? filletRadius ?? width / 3
          : chamferSize ?? width / 3;
      try {
        tool = shapeFarEdges(tool, face, { h, sign, width, size, profile });
      } catch (e) {
        // Fall back to the plain vertical ring if OCCT rejects the
        // chamfer/fillet at these proportions.
        tool = extrudeRing(face, metric, outer, inner, depth);
      }
    }
  }

  // Circle rings can extend past the face on non-centered outlines (e.g. kite
  // faces): clip against the face prism. Outline rings are inside by
  // construction.
  if (borderShape === "circle") {
    const prism = drawFaceOutline(face)
      .sketchOnFace(face, "native")
      .extrude(depth);
    tool = tool.intersect(prism);
  }

  return depth > 0 ? shape.clone().fuse(tool) : shape.clone().cut(tool);
}
