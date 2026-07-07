import { fuseBlueprints, Blueprints, CompoundBlueprint } from "replicad";

// organiseBlueprints only accepts plain Blueprint items, but fusing can
// return Blueprints/CompoundBlueprint collections (e.g. when two shapes
// only touch at a corner) — expand those into their member blueprints
export const flattenToBlueprints = (shapes) => {
  return shapes.flatMap((shape) => {
    if (shape instanceof Blueprints || shape instanceof CompoundBlueprint) {
      return flattenToBlueprints(shape.blueprints);
    }
    return [shape];
  });
};

export const fuseIntersectingBlueprints = (blueprints) => {
  const fused = new Map();

  const output = [];

  blueprints.forEach((inputBlueprint, i) => {
    let savedBlueprint = { current: inputBlueprint };

    if (fused.has(i)) {
      savedBlueprint = fused.get(i);
    } else {
      output.push(savedBlueprint);
    }

    let blueprint = savedBlueprint.current;

    blueprints.slice(i + 1).forEach((inputOtherBlueprint, j) => {
      const currentIndex = i + j + 1;
      let otherBlueprint = inputOtherBlueprint;
      let otherIsFused = false;

      if (fused.has(currentIndex)) {
        otherBlueprint = fused.get(currentIndex).current;
        otherIsFused = true;
      }
      if (blueprint.boundingBox.isOut(otherBlueprint.boundingBox)) return;

      // Shapes that only touch (at a point or an edge) can make the fuse
      // fail — in that case keep them as separate blueprints
      let fusedBlueprint = null;
      try {
        if (!blueprint.intersects(otherBlueprint)) return;
        fusedBlueprint = fuseBlueprints(blueprint, otherBlueprint);
      } catch (error) {
        return;
      }
      if (!fusedBlueprint) return;

      savedBlueprint.current = fusedBlueprint;
      blueprint = fusedBlueprint;
      if (otherIsFused) {
        fused.get(currentIndex).current = false;
      }
      fused.set(currentIndex, savedBlueprint);
    });
  });

  return output.map(({ current }) => current).filter((a) => a);
};
