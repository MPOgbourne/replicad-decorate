import { loadFont, drawText } from "replicad";
import { faceSize, addPatternToShape } from "./common";

const ROBOTO =
  "https://fonts.gstatic.com/s/roboto/v15/W5F8_SL0XFawnjxHGsZjJA.ttf";

// Fonts are fetched over the network — load each URL only once
const loadedFonts = new Map();

const ensureFont = (fontUrl, alias) => {
  if (!loadedFonts.has(fontUrl)) {
    const loading = loadFont(fontUrl, alias).catch((error) => {
      loadedFonts.delete(fontUrl);
      throw new Error(`Could not load the font at ${fontUrl}: ${error}`);
    });
    loadedFonts.set(fontUrl, loading);
  }
  return loadedFonts.get(fontUrl);
};

export async function addText(
  shape,
  {
    faceIndex,
    text,
    depth,
    angle = 0,
    xShift = 0,
    yShift = 0,
    fontSize = 16,
    fontUrl = null,
    fontFamily = null,
    margin = 1,
    mirrorY = false,
    mirrorX = false,
    autoOrient = true,
    disableCut = false,
    carveBackground = false,
  }
) {
  if (typeof text !== "string" || !text) {
    throw new Error("addText requires a non-empty text option");
  }
  if (!depth) {
    throw new Error("addText requires a non-zero depth option");
  }

  const face = shape.faces[faceIndex];
  if (!face) {
    throw new Error(
      `Face ${faceIndex} not found (the shape has ${shape.faces.length} faces)`
    );
  }

  // With only a fontFamily we assume the font was already loaded (with
  // replicad's loadFont). A fontUrl is loaded (once) and registered under
  // the given family name, or under its URL.
  let family = fontFamily ?? undefined;
  if (fontUrl) {
    family = fontFamily ?? fontUrl;
    await ensureFont(fontUrl, family);
  } else if (!fontFamily) {
    await ensureFont(ROBOTO, undefined);
  }

  let txt = drawText(text, { fontSize, fontFamily: family });
  const txtCenter = txt.boundingBox.center;

  if (mirrorY) {
    // addPatternToShape y-flips the positioned pattern (the SVG pipeline is
    // Y-down). Pre-flip the glyphs about their own center so they end up
    // upright while the placement semantics (shifts, rotation direction)
    // stay identical to SVG patterns.
    txt = txt.mirror([1, 0], txtCenter, "plane");
  } else if (autoOrient && face.orientation === "backward") {
    // Heuristic readability flip; callers that resolve the face frame
    // themselves (mirrorX/angle) should pass autoOrient: false
    txt = txt.mirror([1, 0], txtCenter, "plane");
  }

  if (mirrorX) {
    // Horizontal flip about the text's own vertical center line, applied
    // before rotation — used to correct the handedness of faces whose UV
    // frame is left-handed relative to their outward normal
    txt = txt.mirror([0, 1], txtCenter, "plane");
  }

  const { width, height } = faceSize(face);
  txt = txt.translate(-txtCenter[0], -txtCenter[1]);
  if (angle) {
    txt = txt.rotate(angle);
  }
  txt = txt.translate(xShift + width / 2, yShift + height / 2);

  return addPatternToShape(
    shape,
    face,
    txt,
    depth,
    margin,
    mirrorY,
    disableCut,
    carveBackground
  );
}
