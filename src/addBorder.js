import { drawFaceOutline, loft, Plane } from "replicad";

import {
  faceMetric,
  buildFaceContour,
  drawFaceMargin,
  isUsableDrawing,
  EPS,
  MIN_RING_WIDTH,
} from "./common";

const degToRad = (deg) => (deg * Math.PI) / 180;

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
 *
 * With `surfaceLevel` (positive depth only) the ring is not fused on top of
 * the face: instead the face panel around it — the moat between the panel rim
 * (face outline inset by `panelMargin`) and the ring, plus the ring interior —
 * is carved down by depth, leaving the ring standing flush with the original
 * surface. Chamfered/rounded profiles then shape the carved floor edges;
 * sloped falls back to vertical walls.
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
    surfaceLevel = false,
    panelMargin = 0,
  }
) {
  if (!depth || !width) return shape;

  const face = shape.faces[faceIndex];
  const metric = faceMetric(face);

  const outer = buildFaceContour(face, metric, {
    shape: borderShape,
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

  if (surfaceLevel && depth > 0) {
    // Carve the panel around the ring instead of fusing a ridge on top: the
    // ring top stays flush with the original surface, like raised text.
    const panelSolid = drawFaceMargin(face, panelMargin)
      .sketchOnFace(face, "native")
      .extrude(-h);
    const carve = () => panelSolid.cut(extrudeRing(face, metric, outer, inner, -h));
    let tool = carve();
    if (profile === "chamfered" || profile === "rounded") {
      const size =
        profile === "rounded"
          ? filletRadius ?? width / 3
          : chamferSize ?? width / 3;
      try {
        tool = shapeFarEdges(tool, face, { h, sign: -1, width, size, profile });
      } catch (e) {
        // Fall back to the plain vertical carve if OCCT rejects the
        // chamfer/fillet at these proportions.
        tool = carve();
      }
    }
    return shape.clone().cut(tool);
  }

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
