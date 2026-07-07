import { BlueprintSketcher } from "replicad";

// Builds the outline ("buffer") of a stroked open path without boolean
// operations: the path is flattened to a polyline, then the outline is
// constructed directly — offset sides, round joins and round caps (sampled
// as small line segments).

const JOIN_ANGLE_STEP = Math.PI / 15; // 12° facets on joins and caps

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (a, f) => [a[0] * f, a[1] * f];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = (a) => Math.sqrt(a[0] ** 2 + a[1] ** 2);
const normalize = (a) => scale(a, 1 / norm(a));
// The normal on the left-hand side of a direction
const leftNormal = (d) => [-d[1], d[0]];

const samePoint = (a, b, tolerance = 1e-9) =>
  Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance;

/* --- Flattening ------------------------------------------------------- */

const flattenCubic = (from, c1, c2, to, tolerance, out, depth = 0) => {
  // flat enough when the control points are close to the chord
  const chord = sub(to, from);
  const chordLength = norm(chord);

  let flat = false;
  if (chordLength < tolerance) {
    flat = samePoint(c1, from, tolerance) && samePoint(c2, to, tolerance);
  } else {
    const d1 = Math.abs(cross(sub(c1, from), chord)) / chordLength;
    const d2 = Math.abs(cross(sub(c2, from), chord)) / chordLength;
    flat = d1 < tolerance && d2 < tolerance;
  }

  if (flat || depth > 18) {
    out.push(to);
    return;
  }

  // de Casteljau split at t = 0.5
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = mid(from, c1);
  const p12 = mid(c1, c2);
  const p23 = mid(c2, to);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);

  flattenCubic(from, p01, p012, p0123, tolerance, out, depth + 1);
  flattenCubic(p0123, p123, p23, to, tolerance, out, depth + 1);
};

// Endpoint to center parametrization of an SVG arc (spec F.6.5)
const arcCenterParametrization = (segment) => {
  const { from, to, rotation, largeArc, sweep } = segment;
  let rx = Math.abs(segment.rx);
  let ry = Math.abs(segment.ry);

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const num =
    rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2;
  const den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2;
  let factor = Math.sqrt(Math.max(num / den, 0));
  if (largeArc === sweep) factor = -factor;

  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (from[0] + to[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from[1] + to[1]) / 2;

  // angles in the unrotated ellipse frame
  const pointAt = (theta) => {
    const ex = rx * Math.cos(theta);
    const ey = ry * Math.sin(theta);
    return [cosPhi * ex - sinPhi * ey + cx, sinPhi * ex + cosPhi * ey + cy];
  };

  const unrotate = (p) => {
    const x = p[0] - cx;
    const y = p[1] - cy;
    return Math.atan2(
      (-sinPhi * x + cosPhi * y) / ry,
      (cosPhi * x + sinPhi * y) / rx
    );
  };

  const startAngle = unrotate(from);
  let deltaAngle = unrotate(to) - startAngle;
  if (!sweep && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  if (sweep && deltaAngle < 0) deltaAngle += 2 * Math.PI;

  return { pointAt, startAngle, deltaAngle, rx, ry };
};

const flattenArc = (segment, tolerance, out) => {
  const { pointAt, startAngle, deltaAngle, rx, ry } =
    arcCenterParametrization(segment);

  const radius = Math.max(rx, ry);
  let step = 2 * Math.acos(Math.max(1 - tolerance / radius, -1));
  step = Math.min(Math.max(step, Math.PI / 90), Math.PI / 4);

  const steps = Math.max(Math.ceil(Math.abs(deltaAngle) / step), 2);
  for (let i = 1; i < steps; i++) {
    out.push(pointAt(startAngle + (deltaAngle * i) / steps));
  }
  out.push(segment.to);
};

/**
 * Flattens normalized path segments (as produced by pathDataToBlueprints)
 * into a polyline
 */
export const flattenSegments = (segments, tolerance) => {
  const points = [segments[0].from];
  const push = (p) => {
    if (!samePoint(points[points.length - 1], p, tolerance / 100)) {
      points.push(p);
    }
  };

  for (const segment of segments) {
    const { key, from, to } = segment;
    if (key === "L") {
      push(to);
    } else if (key === "C") {
      const sampled = [];
      flattenCubic(from, segment.control1, segment.control2, to, tolerance, sampled);
      sampled.forEach(push);
    } else if (key === "Q") {
      // elevate the quadratic to a cubic
      const c1 = add(scale(from, 1 / 3), scale(segment.control1, 2 / 3));
      const c2 = add(scale(to, 1 / 3), scale(segment.control1, 2 / 3));
      const sampled = [];
      flattenCubic(from, c1, c2, to, tolerance, sampled);
      sampled.forEach(push);
    } else if (key === "A") {
      const sampled = [];
      flattenArc(segment, tolerance, sampled);
      sampled.forEach(push);
    }
  }

  return points;
};

/* --- Buffer construction ---------------------------------------------- */

// Sampled arc around `center` with radius `radius`, from angle `start`
// rotating by `delta` (end point excluded)
const sampleArc = (center, radius, start, delta, out) => {
  const steps = Math.max(Math.ceil(Math.abs(delta) / JOIN_ANGLE_STEP), 1);
  for (let i = 1; i < steps; i++) {
    const theta = start + (delta * i) / steps;
    out.push([
      center[0] + radius * Math.cos(theta),
      center[1] + radius * Math.sin(theta),
    ]);
  }
};

// One side of the outline: walks the polyline and returns the points of the
// left-hand offset, with round joins on the outer corners and intersection
// joins on the inner ones
const leftOffsetSide = (points, offset) => {
  const out = [];

  const directions = [];
  for (let i = 0; i < points.length - 1; i++) {
    directions.push(normalize(sub(points[i + 1], points[i])));
  }

  const firstNormal = leftNormal(directions[0]);
  out.push(add(points[0], scale(firstNormal, offset)));

  for (let i = 0; i < directions.length - 1; i++) {
    const vertex = points[i + 1];
    const a = directions[i];
    const b = directions[i + 1];
    const na = leftNormal(a);
    const nb = leftNormal(b);
    const endA = add(vertex, scale(na, offset));
    const startB = add(vertex, scale(nb, offset));

    const turn = cross(a, b);

    if (Math.abs(turn) < 1e-9) {
      out.push(endA);
      continue;
    }

    if (turn < 0) {
      // turning right: the left side is on the outside — round join
      out.push(endA);
      const startAngle = Math.atan2(na[1], na[0]);
      let delta = Math.atan2(nb[1], nb[0]) - startAngle;
      while (delta > 0) delta -= 2 * Math.PI;
      sampleArc(vertex, offset, startAngle, delta, out);
      out.push(startB);
    } else {
      // turning left: the left side is on the inside — join at the
      // intersection of the two offset lines
      const w = sub(startB, endA);
      const t = cross(w, b) / turn;
      // when the corner is too tight for a miter, fall back to a small notch
      const limit = Math.max(norm(sub(vertex, points[i])), offset) * 4;
      if (Number.isFinite(t) && Math.abs(t) < limit) {
        out.push(add(endA, scale(a, t)));
      } else {
        out.push(endA);
        out.push(startB);
      }
    }
  }

  const lastNormal = leftNormal(directions[directions.length - 1]);
  out.push(add(points[points.length - 1], scale(lastNormal, offset)));

  return out;
};

/**
 * Builds the closed outline of an open path stroked with the given width —
 * round caps and round outer joins — as a single blueprint
 */
export const strokeOpenPathBlueprint = (segments, halfWidth) => {
  const tolerance = Math.max(halfWidth / 20, 1e-6);
  const points = flattenSegments(segments, tolerance);

  if (points.length < 2) {
    // degenerate: a dot — render a disc
    const center = points[0];
    const disc = [[center[0] + halfWidth, center[1]]];
    sampleArc(center, halfWidth, 0, 2 * Math.PI, disc);
    return polygonBlueprint(disc);
  }

  const forward = leftOffsetSide(points, halfWidth);
  const backward = leftOffsetSide([...points].reverse(), halfWidth);

  const outline = [...forward];

  // end cap: from the end of the left side around the last point to the
  // start of the right side
  const lastDirection = normalize(
    sub(points[points.length - 1], points[points.length - 2])
  );
  const endNormal = leftNormal(lastDirection);
  const endAngle = Math.atan2(endNormal[1], endNormal[0]);
  sampleArc(points[points.length - 1], halfWidth, endAngle, -Math.PI, outline);

  outline.push(...backward);

  // start cap
  const firstDirection = normalize(sub(points[1], points[0]));
  const startNormal = scale(leftNormal(firstDirection), -1);
  const startAngle = Math.atan2(startNormal[1], startNormal[0]);
  sampleArc(points[0], halfWidth, startAngle, -Math.PI, outline);

  return polygonBlueprint(outline);
};

const polygonBlueprint = (points) => {
  const sk = new BlueprintSketcher(points[0]);
  for (let i = 1; i < points.length; i++) {
    if (samePoint(points[i], points[i - 1])) continue;
    sk.lineTo(points[i]);
  }
  return sk.close();
};
