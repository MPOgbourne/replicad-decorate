# replicad decorate

This is a library based on [replicad](https://replicad.xyz).

This library contains a set of helpers to decorate faces of your models with
different patterns:

- an inset (`addInset`)
- a grid (`addGrid`)
- a honeycomb (`addHoneycomb`)
- a voronoi pattern (`addVoronoi`)
- some text (`addText`)
- or a SVG (`addSVG`)

You can play with the parameters of these function is the small webapp based on
this library, [BlingMyThing](https://blingmything.sgenoud.com)

## As a library

This module can be used either as a library:

```js
yarn add replicad-decorate
```

You can have a look at how it is used within [BlingMyThing](https://github.com/sgenoud/blingmything).

## Within the replicad studio

You can also import it within the replicad studio

```js
import { addVoronoi } from "https://cdn.jsdelivr.net/npm/replicad-decorate/dist/studio/replicad-decorate.js";

export default function main() {
  const baseShape = drawCircle(20).sketchOnPlane().extrude(52);
  return addVoronoi(baseShape, { faceIndex: 1, depth: -2 });
}
```

You can have a look at what it looks like [here](https://studio.replicad.xyz/share/https%3A%2F%2Fgist.githubusercontent.com%2Fsgenoud%2F7c8aaf814f633624853e8484f5505601%2Fraw%2F6f83c7ef17365d9cf5769cb996a57ccbbe259f4a%2Fshowcase-decorate.js)

## addSVG / drawSVG

`addSVG(shape, options)` engraves (negative `depth`) or embosses (positive
`depth`) an SVG onto a face. `drawSVG(svgString, options)` returns the SVG as
a replicad `Drawing`.

Supported SVG features:

- `path`, `rect` (including rounded corners), `circle`, `ellipse`, `line`,
  `polyline` and `polygon` elements
- `transform` attributes on shapes and groups (`matrix`, `translate`,
  `scale`, `rotate`, `skewX`, `skewY`)
- `use`/`defs`/`symbol` references
- fills **and strokes**: stroked shapes are expanded into bands of their
  `stroke-width` (round joins and caps for open paths); `fill="none"` shapes
  are not filled
- `display:none`, `visibility:hidden`, and inline `style` attributes for the
  paint properties

Options of `addSVG` (on top of `faceIndex`, `depth`, `svgString`):

- `width` (default 60): the drawing is scaled to this width
- `angle`, `xShift`, `yShift`: positioning on the face
- `fitViewBox` (default false): scale and center using the SVG `viewBox`
  instead of the geometry bounding box, preserving designed margins
- `mirrorY` (default true), `disableCut` (default true)

Known limitations: gradients/patterns are treated as plain paint,
`stroke-dasharray` and masks/clip paths are ignored, and `fill-rule` is not
taken into account for self-intersecting paths.

## addText

Options: `faceIndex`, `text`, `depth`, plus:

- `fontSize` (default 16), `angle`, `xShift`, `yShift` (default 0)
- `fontUrl`: URL of a TTF font to use (loaded once and cached); defaults to
  Roboto
- `fontFamily`: name of a font already loaded with replicad's `loadFont`
  (or the family name to register `fontUrl` under)
- `margin` (default 1), `mirrorY` (default false), `disableCut` (default
  false)
- `carveBackground` (default false): instead of engraving/embossing the
  glyphs, sink the face around them by `|depth|` (bounded by the face
  outline inset by `margin`), leaving the text standing at the original
  surface level — a "raised" look that never protrudes past the face
