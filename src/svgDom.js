import { DOMParser as XMLDOMParser } from "@xmldom/xmldom";

// Elements that are never rendered directly (some, like symbol, only render
// when referenced through <use>)
const NON_RENDERED_TAGS = new Set([
  "defs",
  "symbol",
  "clipPath",
  "mask",
  "marker",
  "pattern",
  "metadata",
  "title",
  "desc",
  "style",
  "script",
  "linearGradient",
  "radialGradient",
  "filter",
  "foreignObject",
]);

const CONTAINER_TAGS = new Set(["svg", "g", "a", "switch"]);

export const SHAPE_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
]);

const MAX_USE_DEPTH = 30;

const DEFAULT_STYLE = {
  fill: "black",
  stroke: "none",
  strokeWidth: 1,
  strokeLinejoin: null,
  visibility: "visible",
};

// Presentation properties we care about, and whether they inherit
const STYLE_PROPS = [
  ["fill", "fill"],
  ["stroke", "stroke"],
  ["stroke-width", "strokeWidth"],
  ["stroke-linejoin", "strokeLinejoin"],
  ["visibility", "visibility"],
];

export function parseSVGDocument(svgString) {
  if (typeof svgString !== "string" || !svgString.trim()) {
    throw new Error("drawSVG expects a non-empty SVG string");
  }

  let doc;
  if (typeof DOMParser !== "undefined") {
    doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
    const errorNode = doc.getElementsByTagName("parsererror")[0];
    if (errorNode) {
      throw new Error(`Invalid SVG: ${errorNode.textContent}`);
    }
  } else {
    const errors = [];
    const parser = new XMLDOMParser({
      onError: (level, message) => {
        if (level === "fatalError" || level === "error") errors.push(message);
      },
    });
    doc = parser.parseFromString(svgString, "image/svg+xml");
    if (errors.length) {
      throw new Error(`Invalid SVG: ${errors[0]}`);
    }
  }

  return doc;
}

const tagOf = (element) => element.localName || element.tagName;

const elementChildren = (node) => {
  return Array.from(node.childNodes || []).filter((c) => c.nodeType === 1);
};

const parseStyleAttribute = (styleString) => {
  const style = {};
  if (!styleString) return style;

  for (const declaration of styleString.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) style[property] = value;
  }
  return style;
};

// The style attribute has priority over presentation attributes
const propValue = (element, property) => {
  const inlineStyle = parseStyleAttribute(element.getAttribute("style"));
  if (property in inlineStyle) return inlineStyle[property];

  const attr = element.getAttribute(property);
  if (attr !== null && attr !== "") return attr;
  return null;
};

const resolveStyle = (element, parentStyle) => {
  const style = { ...parentStyle };

  for (const [property, key] of STYLE_PROPS) {
    const value = propValue(element, property);
    if (value === null || value === "inherit") continue;

    if (key === "strokeWidth") {
      const width = parseFloat(value);
      if (!Number.isNaN(width)) style.strokeWidth = Math.max(width, 0);
    } else {
      style[key] = value;
    }
  }

  return style;
};

const isDisplayNone = (element) => {
  const display = propValue(element, "display");
  return display !== null && display.trim() === "none";
};

// Transform lists compose left-to-right (leftmost is outermost), so
// accumulating down the tree is simple string concatenation.
const combineTransforms = (parentTransform, element) => {
  const own = element.getAttribute("transform");
  if (!own) return parentTransform;
  return parentTransform ? `${parentTransform} ${own}` : own;
};

const collectIds = (root) => {
  const byId = new Map();
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      const id = child.getAttribute && child.getAttribute("id");
      if (id && !byId.has(id)) byId.set(id, child);
      visit(child);
    }
  };
  visit(root);
  const rootId = root.getAttribute && root.getAttribute("id");
  if (rootId && !byId.has(rootId)) byId.set(rootId, root);
  return byId;
};

const useTarget = (element, idMap) => {
  const href =
    element.getAttribute("href") || element.getAttribute("xlink:href");
  if (!href || !href.startsWith("#")) return null;
  return idMap.get(href.slice(1)) || null;
};

// <switch> renders its first child whose conditional attributes pass. We
// don't evaluate features/languages, so pick the first child without
// restricting conditions.
const switchChild = (element) => {
  for (const child of elementChildren(element)) {
    if (
      !child.getAttribute("requiredFeatures") &&
      !child.getAttribute("requiredExtensions")
    ) {
      return child;
    }
  }
  return null;
};

const parseViewBox = (svgElement) => {
  const viewBox = svgElement.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox
      .split(/[\s,]+/)
      .filter((p) => p !== "")
      .map(parseFloat);
    if (parts.length === 4 && parts.every((p) => !Number.isNaN(p))) {
      const [x, y, width, height] = parts;
      if (width > 0 && height > 0) return { x, y, width, height };
    }
    return null;
  }

  const width = parseFloat(svgElement.getAttribute("width"));
  const height = parseFloat(svgElement.getAttribute("height"));
  if (width > 0 && height > 0) {
    return { x: 0, y: 0, width, height };
  }
  return null;
};

/**
 * Walks the SVG document and returns the list of shape elements that would
 * actually be rendered, each with its cumulative transform (as an SVG
 * transform list string) and resolved fill/stroke style.
 */
export function collectRenderedShapes(svgString) {
  const doc = parseSVGDocument(svgString);

  const root = elementChildren(doc).find((el) => tagOf(el) === "svg") || null;
  if (!root) {
    throw new Error("Invalid SVG: no <svg> root element found");
  }

  const idMap = collectIds(root);
  const shapes = [];

  const visitElement = (element, transform, parentStyle, useStack) => {
    const tag = tagOf(element);

    if (isDisplayNone(element)) return;

    if (tag === "use") {
      const target = useTarget(element, idMap);
      if (!target) return;
      const targetId = target.getAttribute("id");
      if (useStack.includes(targetId) || useStack.length >= MAX_USE_DEPTH) {
        return;
      }

      const x = parseFloat(element.getAttribute("x")) || 0;
      const y = parseFloat(element.getAttribute("y")) || 0;
      let useTransform = combineTransforms(transform, element);
      if (x || y) {
        useTransform = useTransform
          ? `${useTransform} translate(${x} ${y})`
          : `translate(${x} ${y})`;
      }
      const useStyle = resolveStyle(element, parentStyle);

      const targetTag = tagOf(target);
      if (targetTag === "symbol" || targetTag === "svg") {
        // Render the children of the symbol (we do not implement the nested
        // viewport/viewBox mapping of symbols)
        const symbolStyle = resolveStyle(target, useStyle);
        const symbolTransform = combineTransforms(useTransform, target);
        for (const child of elementChildren(target)) {
          visitElement(child, symbolTransform, symbolStyle, [
            ...useStack,
            targetId,
          ]);
        }
      } else {
        visitElement(target, useTransform, useStyle, [...useStack, targetId]);
      }
      return;
    }

    if (SHAPE_TAGS.has(tag)) {
      const style = resolveStyle(element, parentStyle);
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return;
      }
      shapes.push({
        tag,
        element,
        transform: combineTransforms(transform, element),
        style,
      });
      return;
    }

    if (NON_RENDERED_TAGS.has(tag)) return;

    if (CONTAINER_TAGS.has(tag)) {
      const style = resolveStyle(element, parentStyle);
      const childTransform = combineTransforms(transform, element);

      if (tag === "switch") {
        const child = switchChild(element);
        if (child) visitElement(child, childTransform, style, useStack);
        return;
      }

      for (const child of elementChildren(element)) {
        visitElement(child, childTransform, style, useStack);
      }
    }

    // Unknown elements (and their children) are not rendered, as per the
    // SVG spec
  };

  const rootStyle = resolveStyle(root, DEFAULT_STYLE);
  const rootTransform = root.getAttribute("transform") || "";
  for (const child of elementChildren(root)) {
    visitElement(child, rootTransform, rootStyle, []);
  }

  return { shapes, viewBox: parseViewBox(root) };
}
