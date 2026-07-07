// Converts SVG shape elements into their equivalent path data, following the
// equivalent path definitions of the SVG spec
// (https://www.w3.org/TR/SVG2/shapes.html)

// Attribute lengths can have units (we keep the numeric part, treating user
// units, px, and unitless the same) or be percentages of the viewport
const parseLength = (value, { viewBox, axis }) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return null;

  if (typeof value === "string" && value.trim().endsWith("%") && viewBox) {
    const { width, height } = viewBox;
    let reference = width;
    if (axis === "y") reference = height;
    if (axis === "diagonal")
      reference = Math.sqrt(width ** 2 + height ** 2) / Math.SQRT2;
    return (parsed / 100) * reference;
  }

  return parsed;
};

const lengthAttr = (element, name, axis, viewBox, defaultValue = 0) => {
  const value = parseLength(element.getAttribute(name), { viewBox, axis });
  return value === null ? defaultValue : value;
};

const rectToPath = (element, viewBox) => {
  const x = lengthAttr(element, "x", "x", viewBox);
  const y = lengthAttr(element, "y", "y", viewBox);
  const width = lengthAttr(element, "width", "x", viewBox);
  const height = lengthAttr(element, "height", "y", viewBox);

  if (width <= 0 || height <= 0) return null;

  // Per the spec, when only one of rx/ry is given (or is "auto" or negative),
  // it defaults to the other one
  const readRadius = (name, axis) => {
    const raw = element.getAttribute(name);
    if (raw === null || raw === "" || raw.trim() === "auto") return null;
    const value = parseLength(raw, { viewBox, axis });
    if (value === null || value < 0) return null;
    return value;
  };

  let rx = readRadius("rx", "x");
  let ry = readRadius("ry", "y");
  if (rx === null && ry === null) {
    rx = 0;
    ry = 0;
  } else {
    if (rx === null) rx = ry;
    if (ry === null) ry = rx;
  }
  rx = Math.min(rx, width / 2);
  ry = Math.min(ry, height / 2);

  if (rx <= 0 || ry <= 0) {
    return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
  }

  return [
    `M${x + rx} ${y}`,
    `H${x + width - rx}`,
    `A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}`,
    `V${y + height - ry}`,
    `A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}`,
    `H${x + rx}`,
    `A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}`,
    `V${y + ry}`,
    `A${rx} ${ry} 0 0 1 ${x + rx} ${y}`,
    "Z",
  ].join("");
};

const ellipseArcsPath = (cx, cy, rx, ry) => {
  return [
    `M${cx - rx} ${cy}`,
    `A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}`,
    `A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}`,
    "Z",
  ].join("");
};

const circleToPath = (element, viewBox) => {
  const cx = lengthAttr(element, "cx", "x", viewBox);
  const cy = lengthAttr(element, "cy", "y", viewBox);
  const r = lengthAttr(element, "r", "diagonal", viewBox);

  if (r <= 0) return null;
  return ellipseArcsPath(cx, cy, r, r);
};

const ellipseToPath = (element, viewBox) => {
  const cx = lengthAttr(element, "cx", "x", viewBox);
  const cy = lengthAttr(element, "cy", "y", viewBox);

  // rx/ry follow the same auto rule as the rect radii
  const readRadius = (name, axis) => {
    const raw = element.getAttribute(name);
    if (raw === null || raw === "" || raw.trim() === "auto") return null;
    const value = parseLength(raw, { viewBox, axis });
    if (value === null || value < 0) return null;
    return value;
  };

  let rx = readRadius("rx", "x");
  let ry = readRadius("ry", "y");
  if (rx === null && ry === null) return null;
  if (rx === null) rx = ry;
  if (ry === null) ry = rx;

  if (rx <= 0 || ry <= 0) return null;
  return ellipseArcsPath(cx, cy, rx, ry);
};

const lineToPath = (element, viewBox) => {
  const x1 = lengthAttr(element, "x1", "x", viewBox);
  const y1 = lengthAttr(element, "y1", "y", viewBox);
  const x2 = lengthAttr(element, "x2", "x", viewBox);
  const y2 = lengthAttr(element, "y2", "y", viewBox);

  if (x1 === x2 && y1 === y2) return null;
  return `M${x1} ${y1}L${x2} ${y2}`;
};

// Parses the points attribute of polyline/polygon. As per the spec, a
// trailing odd coordinate is dropped (the shape is rendered up to it)
const parsePoints = (element) => {
  const raw = element.getAttribute("points");
  if (!raw) return null;

  const numbers = raw
    .trim()
    .split(/[\s,]+/)
    .filter((v) => v !== "")
    .map(parseFloat);

  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    if (Number.isNaN(numbers[i]) || Number.isNaN(numbers[i + 1])) break;
    points.push([numbers[i], numbers[i + 1]]);
  }

  if (points.length < 2) return null;
  return points;
};

const polylineToPath = (element) => {
  const points = parsePoints(element);
  if (!points) return null;
  const [first, ...rest] = points;
  return `M${first[0]} ${first[1]}${rest
    .map(([x, y]) => `L${x} ${y}`)
    .join("")}`;
};

const polygonToPath = (element) => {
  const path = polylineToPath(element);
  return path ? `${path}Z` : null;
};

/**
 * Returns the path data equivalent to a shape element, or null when the
 * shape renders nothing (zero sized, invalid attributes, ...)
 */
export function elementToPathData(tag, element, viewBox = null) {
  switch (tag) {
    case "path":
      return element.getAttribute("d") || null;
    case "rect":
      return rectToPath(element, viewBox);
    case "circle":
      return circleToPath(element, viewBox);
    case "ellipse":
      return ellipseToPath(element, viewBox);
    case "line":
      return lineToPath(element, viewBox);
    case "polyline":
      return polylineToPath(element);
    case "polygon":
      return polygonToPath(element);
    default:
      return null;
  }
}
