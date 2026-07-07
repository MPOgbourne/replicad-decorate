import { BlueprintSketcher } from "replicad";
import svgpath from "svgpath";

const samePoint = (a, b) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

// Radius correction of the SVG spec (F.6.6): radii too small to span the
// endpoints are scaled up uniformly, taking the x-axis rotation into account
const correctArcRadii = (from, to, rx, ry, rotationDegrees) => {
  const phi = (rotationDegrees * Math.PI) / 180;
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;

  const x1p = Math.cos(phi) * dx + Math.sin(phi) * dy;
  const y1p = -Math.sin(phi) * dx + Math.cos(phi) * dy;

  const lambda = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2;
  if (lambda <= 1) return [rx, ry];

  const scale = Math.sqrt(lambda);
  return [rx * scale, ry * scale];
};

const applySegment = (sk, segment) => {
  const { key, from, to } = segment;

  if (key === "L") {
    sk.lineTo(to);
  } else if (key === "C") {
    sk.cubicBezierCurveTo(to, segment.control1, segment.control2);
  } else if (key === "Q") {
    sk.quadraticBezierCurveTo(to, segment.control1);
  } else if (key === "A") {
    let [rx, ry] = [Math.abs(segment.rx), Math.abs(segment.ry)];

    // A radius of zero degrades the arc to a straight line (spec F.6.6)
    if (rx < 1e-12 || ry < 1e-12) {
      sk.lineTo(to);
      return;
    }

    [rx, ry] = correctArcRadii(from, to, rx, ry, segment.rotation);
    sk.ellipseTo(to, rx, ry, segment.rotation, segment.largeArc, segment.sweep);
  }
};

// A degenerate segment renders nothing. Curves whose endpoints coincide can
// still be valid loops when their control points differ.
const isEmptySegment = (segment) => {
  const { key, from, to } = segment;
  if (!samePoint(from, to)) return false;

  if (key === "C") {
    return samePoint(segment.control1, from) && samePoint(segment.control2, from);
  }
  if (key === "Q") {
    return samePoint(segment.control1, from);
  }
  // Arcs with identical endpoints are omitted, as per spec F.6.2
  return true;
};

// Normalizes a svgpath segment (already absolute and with shorthands
// expanded) into an explicit segment object
const normalizeSegment = (s, lastX, lastY) => {
  const from = [lastX, lastY];
  const key = s[0];

  if (key === "L") return { key, from, to: [s[1], s[2]] };
  if (key === "H") return { key: "L", from, to: [s[1], lastY] };
  if (key === "V") return { key: "L", from, to: [lastX, s[1]] };
  if (key === "C") {
    return {
      key,
      from,
      control1: [s[1], s[2]],
      control2: [s[3], s[4]],
      to: [s[5], s[6]],
    };
  }
  if (key === "Q") {
    return { key, from, control1: [s[1], s[2]], to: [s[3], s[4]] };
  }
  if (key === "A") {
    return {
      key,
      from,
      rx: Number(s[1]),
      ry: Number(s[2]),
      rotation: Number(s[3]),
      // svgpath can turn these flags into strings when transforming
      largeArc: !!Number(s[4]),
      sweep: !!Number(s[5]),
      to: [s[6], s[7]],
    };
  }

  throw new Error(`Unknown path command ${key}`);
};

/**
 * Converts SVG path data into replicad blueprints, one per subpath.
 *
 * Returns a list of `{ blueprint, closed, segments }` objects — `closed`
 * tells whether the subpath was explicitly closed (or closed by
 * `autoClose`), and `segments` is the normalized list of drawing commands
 * (useful to build stroke outlines).
 *
 * Options:
 * - `transform`: an SVG transform list to apply to the path data
 * - `autoClose`: close open subpaths (what the fill operation does per spec)
 */
export function pathDataToBlueprints(
  pathData,
  { transform = "", autoClose = false } = {}
) {
  let parsed = svgpath(pathData);
  if (parsed.err) {
    throw new Error(`Invalid path data "${pathData}": ${parsed.err}`);
  }
  if (transform && transform.trim()) {
    parsed = parsed.transform(transform);
  }
  parsed = parsed.abs().unshort();

  const out = [];

  let sk = null;
  let segments = [];

  const flush = (closedByZ) => {
    if (sk && segments.length) {
      let closed = closedByZ;
      let blueprint = null;

      if (closedByZ) {
        blueprint = sk.close();
      } else if (autoClose) {
        // Filling implicitly closes subpaths; a single straight segment
        // closed onto itself has no area and is dropped
        const onlyLines = segments.every((s) => s.key === "L");
        if (!onlyLines || segments.length >= 2) {
          blueprint = sk.close();
          closed = true;
        }
      } else {
        blueprint = sk.done();
      }

      if (blueprint) {
        out.push({ blueprint, closed, segments });
      }
    }
    sk = null;
    segments = [];
  };

  parsed.iterate((s, index, lastX, lastY) => {
    const key = s[0];

    if (key === "M") {
      flush(false);
      sk = new BlueprintSketcher([s[1], s[2]]);
      return;
    }

    if (key === "Z") {
      flush(true);
      // Per spec, drawing commands after a Z continue from the start of the
      // subpath that was just closed. `iterate` resets lastX/lastY to that
      // point, so the next command reopens a sketcher there.
      return;
    }

    const segment = normalizeSegment(s, lastX, lastY);
    if (isEmptySegment(segment)) return;

    if (!sk) {
      sk = new BlueprintSketcher(segment.from);
    }
    applySegment(sk, segment);
    segments.push(segment);
  });

  flush(false);

  return out;
}
