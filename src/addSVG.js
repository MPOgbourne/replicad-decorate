import { addPatternToShape, faceSize } from "./common";

import { drawSVG } from "./parseSVG";

export async function addSVG(
  shape,
  {
    faceIndex,
    depth,
    svgString,
    width = 60,
    angle = 0,
    xShift = 0,
    yShift = 0,
    margin = 1,
    mirrorY = true,
    disableCut = true,
    carveBackground = false,
    alwaysClosePaths = false,
    fitViewBox = false,
    panel = null,
  }
) {
  if (typeof svgString !== "string" || !svgString.trim()) {
    throw new Error("addSVG requires a non-empty svgString option");
  }
  if (!depth) {
    throw new Error("addSVG requires a non-zero depth option");
  }

  const face = shape.faces[faceIndex];
  if (!face) {
    throw new Error(
      `Face ${faceIndex} not found (the shape has ${shape.faces.length} faces)`
    );
  }

  let image = drawSVG(svgString, { width, alwaysClosePaths, fitViewBox });

  if (!fitViewBox) {
    const imgCenter = image.boundingBox.center;
    image = image.translate(-imgCenter[0], -imgCenter[1]);
  }
  if (angle) {
    image = image.rotate(angle);
  }
  image = image.translate(xShift, yShift);

  const { width: faceWidth, height: faceHeight } = faceSize(face);
  image = image.translate(faceWidth / 2, faceHeight / 2);

  return addPatternToShape(
    shape,
    face,
    image,
    depth,
    margin,
    mirrorY,
    disableCut,
    carveBackground,
    panel
  );
}
