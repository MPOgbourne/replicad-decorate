import {
  GCWithScope,
  getOC,
  drawFaceOutline,
  drawCircle,
  loft,
  Plane,
} from "replicad";

export const range = (size) => [...Array(size).keys()];

export const mergeDrawings = (drawings) => {
  let merged = drawings[0];

  drawings.slice(1).forEach((d) => {
    merged = merged.fuse(d);
  });

  return merged;
};

const cylidreRadius = (face) => {
  const oc = getOC();
  const r = GCWithScope();
  let geomSurf = r(oc.BRep_Tool.Surface_2(face.wrapped));
  const cylinder = r(geomSurf.get().Cylinder());
  return cylinder.Radius();
};

export const faceSize = (face) => {
  const { uMax, uMin, vMax, vMin } = face.UVBounds;
  const vLen = Math.abs(vMax - vMin);
  const uLen = Math.abs(uMax - uMin);

  let width = uLen;
  let height = vLen;

  if (face.geomType === "CYLINDRE") {
    width = width * cylidreRadius(face);
  }

  return {
    uMax,
    uMin,
    vMax,
    vMin,
    vLen,
    uLen,
    width,
    height,
  };
};

export const randomSeed = (seed) => {
  let a = seed;
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// UV parameter space is not metric on most faces: convert drawings into a
// stretched "metric UV" space (1 unit = 1mm) so offsets/radii are true
// distances, then convert back before sketchOnFace(face, "native").
export const faceMetric = (face) => {
  const { width, uLen, height, vLen, uMin, vMin } = faceSize(face);

  const xStretch = width / uLen;
  const yStretch = height / vLen;

  const toMetric = (drawing) => {
    if (xStretch !== 1) {
      drawing = drawing.stretch(xStretch, [0, 1]);
    }
    if (yStretch !== 1) {
      drawing = drawing.stretch(yStretch, [1, 0]);
    }
    return drawing;
  };

  const toNative = (drawing) => {
    if (yStretch !== 1) {
      drawing = drawing.stretch(1 / yStretch, [1, 0]);
    }
    if (xStretch !== 1) {
      drawing = drawing.stretch(1 / xStretch, [0, 1]);
    }
    return drawing;
  };

  return {
    toMetric,
    toNative,
    width,
    height,
    uLen,
    vLen,
    uMin,
    vMin,
    xStretch,
    yStretch,
  };
};

export const EPS = 0.05;
export const MIN_RING_WIDTH = 0.2;

export const isUsableDrawing = (drawing) => {
  try {
    const { width, height } = drawing.boundingBox;
    return width > EPS && height > EPS;
  } catch (e) {
    return false;
  }
};

// Contour of the face outline (or an inscribed circle), inset by margin, in
// metric UV space. Shared by addBorder (ring contours) and addPatternToShape
// (border-aware decoration panels).
export const buildFaceContour = (
  face,
  metric,
  { shape = "outline", margin = 0, cornerRadius = 1 }
) => {
  const { toMetric, width, height, uMin, vMin, uLen, vLen, xStretch, yStretch } =
    metric;

  if (shape === "circle") {
    const radius = Math.min(width, height) / 2 - margin;
    if (radius <= MIN_RING_WIDTH) {
      throw new Error(`Face too small for a circle contour (margin ${margin})`);
    }
    const centerX = (uMin + uLen / 2) * xStretch;
    const centerY = (vMin + vLen / 2) * yStretch;
    return drawCircle(radius).translate([centerX, centerY]);
  }

  // offset(0) yields an unusable drawing in OCCT — skip it for zero margins
  // so margin 0 means "the face outline itself", not a fallback
  let outline = toMetric(drawFaceOutline(face));
  if (margin > 0) {
    outline = outline.offset(-margin);
  }
  if (shape === "rounded" && cornerRadius > 0) {
    outline = outline.fillet(cornerRadius);
  }
  return outline;
};

export const drawFaceMargin = (face, margin) => {
  const { toMetric, toNative } = faceMetric(face);
  const outline = toMetric(drawFaceOutline(face));
  // An inward offset of a fillet-trimmed outline can fail in OCCT — either
  // throwing ("Bug in the offset algorithm") or silently annihilating the
  // drawing (no innerShape, which later throws on sketchOnFace). Degrade to a
  // smaller margin (then none) instead of failing the whole decoration.
  for (const m of [margin, margin / 2, 0]) {
    try {
      const inset = m > 0 ? outline.offset(-m) : outline;
      if (inset.innerShape) {
        if (m !== margin) {
          console.warn(
            `[replicad-decorate] face outline inset by ${margin} collapsed; falling back to ${m}`
          );
        }
        return toNative(inset);
      }
    } catch (e) {
      // try the next smaller margin
    }
  }
  return toNative(outline);
};

// Largest centered circle that fits the face's metric bounding box, inset by
// margin — a clip region that always sketches, for faces whose own outline
// cannot be offset or sketched by OCCT.
export const drawFaceCenterCircle = (face, margin) => {
  const { toNative, width, height, uLen, vLen, uMin, vMin, xStretch, yStretch } =
    faceMetric(face);
  const radius = Math.max(
    Math.min(width, height) / 2 - margin,
    Math.min(width, height) / 4
  );
  const cx = (uMin + uLen / 2) * xStretch;
  const cy = (vMin + vLen / 2) * yStretch;
  return toNative(drawCircle(radius).translate(cx, cy));
};

// The carve solid for carveBackground, shaped by the panel's wall profile:
// - vertical (default): straight extruded walls
// - sloped: drafted walls via a ruled loft, panel narrows by |d|*tan(angle)
// - chamfered / rounded: floor edge loops chamfered or filleted
// Profile failures degrade to the plain vertical carve.
const carvePanelTool = (face, outline, d, panel) => {
  const h = Math.abs(d);
  const vertical = () => outline.sketchOnFace(face, "native").extrude(d);
  const profile = panel?.profile ?? "vertical";

  if (profile === "sloped") {
    try {
      const angle = panel.angle ?? 15;
      const dx = h * Math.tan((angle * Math.PI) / 180);
      const metric = faceMetric(face);
      const floor = metric.toNative(metric.toMetric(outline).offset(-dx));
      if (!isUsableDrawing(floor)) return vertical();
      const normal = face.normalAt().normalized();
      const shift = normal.multiply(d);
      const wireTop = outline.sketchOnFace(face, "native").wire;
      const wireFloor = floor.sketchOnFace(face, "native").wire.translate(shift);
      return loft([wireTop, wireFloor], { ruled: true });
    } catch (e) {
      return vertical();
    }
  }

  if (profile === "chamfered" || profile === "rounded") {
    try {
      const size = Math.min(h / 2, h - EPS);
      if (size <= 0) return vertical();
      const normal = face.normalAt().normalized();
      const farPoint = face.center.add(normal.multiply(d));
      const farPlane = new Plane(
        [farPoint.x, farPoint.y, farPoint.z],
        null,
        normal
      );
      const filter = (e) => e.inPlane(farPlane);
      const tool = vertical();
      return profile === "rounded"
        ? tool.fillet(size, filter)
        : tool.chamfer(size, filter);
    } catch (e) {
      return vertical();
    }
  }

  return vertical();
};

// Decoration boundary: the face outline inset by margin, or — when a panel
// spec ({shape, margin, cornerRadius}) is given, e.g. to keep a decoration
// inside a border ring — the panel contour. Falls back to the plain outline
// when the panel contour cannot be built or collapses.
const drawPatternBoundary = (face, margin, panel) => {
  if (panel) {
    try {
      const metric = faceMetric(face);
      const contour = buildFaceContour(face, metric, panel);
      if (isUsableDrawing(contour)) {
        return metric.toNative(contour);
      }
    } catch (e) {
      // fall through to the default outline
    }
    console.warn(
      "[replicad-decorate] panel contour unusable; falling back to the face outline"
    );
  }
  return drawFaceMargin(face, margin);
};

// Ring solid (annulus) built from a border spec ({shape, margin, width,
// cornerRadius}), extruded by depth — used to keep a border ring standing at
// surface level while carveBackground sinks the face around it.
const ringTowerSolid = (face, ring, depth) => {
  const metric = faceMetric(face);
  const outer = buildFaceContour(face, metric, ring);
  const inner = outer.offset(-ring.width);
  if (!isUsableDrawing(outer) || !isUsableDrawing(inner)) {
    throw new Error("ring does not fit the face");
  }
  return metric
    .toNative(outer.cut(inner))
    .sketchOnFace(face, "native")
    .extrude(depth);
};

export const addPatternToShape = (
  shape,
  face,
  pattern,
  depth,
  margin,
  mirrorY = false,
  disableCut = false,
  carveBackground = false,
  panel = null,
  ring = null
) => {
  const { vLen, uLen, uMin, vMin, width, height } = faceSize(face);

  const yScaleFactor = vLen / height;
  const xScaleFactor = uLen / width;

  const outline = drawPatternBoundary(face, margin, panel);

  if (xScaleFactor !== 1) {
    pattern = pattern.stretch(xScaleFactor, [0, 1]);
  }
  if (yScaleFactor !== 1) {
    pattern = pattern.stretch(yScaleFactor, [1, 0]);
  }
  pattern = pattern.translate([uMin, vMin]);

  if (mirrorY) {
    // Flip vertically about the horizontal line through the face center:
    // a real y-flip that keeps the pattern on the face for any UV origin
    // (the previous mirror([0,1]) point-reflected through the fixed UV
    // point (0,1), throwing patterns off faces whose parameter range is
    // not centered there).
    pattern = pattern.mirror([1, 0], [uMin + uLen / 2, vMin + vLen / 2], "plane");
  }

  // All boundary clipping happens on solids: 2D drawing booleans (cut and
  // intersect) misbehave with multi-contour patterns (e.g. several glyphs)
  // and with contours straddling the boundary.
  if (carveBackground) {
    // Carve the face around the pattern instead of the pattern itself: the
    // whole outline (inset by margin) sinks by |depth|, then the pattern is
    // fused back as towers reaching the original surface level — "raised"
    // without protruding past the face.
    const d = -Math.abs(depth);
    // With a ring the carve spans the standard face panel (the ring and its
    // moat live inside it) while the pattern itself stays clipped to
    // `outline` (typically the region inside the ring, via `panel`).
    const carveOutline = ring ? drawFaceMargin(face, margin) : outline;
    const tool = carvePanelTool(face, carveOutline, d, panel);
    let towers = tool.intersect(pattern.sketchOnFace(face, "native").extrude(d));
    if (ring) {
      towers = towers.intersect(outline.sketchOnFace(face, "native").extrude(d));
      // The border ring is carved around too: it stands at surface level
      // exactly like the pattern towers
      try {
        towers = towers.fuse(ringTowerSolid(face, ring, d).intersect(tool));
      } catch (e) {
        console.warn(
          "[replicad-decorate] ring tower failed; carving without the ring",
          e
        );
      }
    }
    return shape.clone().cut(tool).fuse(towers);
  }

  let patternSolid = pattern.sketchOnFace(face, "native").extrude(depth);
  if (!disableCut) {
    // The boundary clip guards against patterns spilling past the face edge
    // (and into adjacent fillet surfaces, which can crash or corrupt the
    // final boolean). Some fillet-trimmed outlines cannot be sketched/offset
    // by OCCT at all — retry with a centered circle clip. If that fails too,
    // fail the decoration: applying the pattern unclipped can silently
    // produce a mangled solid, which is worse than a skipped face.
    try {
      patternSolid = patternSolid.intersect(
        outline.sketchOnFace(face, "native").extrude(depth)
      );
    } catch (outlineError) {
      patternSolid = patternSolid.intersect(
        drawFaceCenterCircle(face, margin)
          .sketchOnFace(face, "native")
          .extrude(depth)
      );
      console.warn(
        "[replicad-decorate] outline clip failed; clipped to centered circle instead"
      );
    }
  }

  const newShape =
    depth > 0
      ? shape.clone().fuse(patternSolid)
      : shape.clone().cut(patternSolid);
  return newShape;
};
