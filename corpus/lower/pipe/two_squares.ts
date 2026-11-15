// Two modules each declare a class Square, functions measure and count, and module state made (D65): printed as one TSL
// module per source module, each keeps its own names, and the root imports one Square under another name, as the source
// does. Printed as one file, each is named for where it's declared (Square_inShapes, Square_inTiles). Reordering the two
// imports leaves the printed TSL as it was (tmk milestone pipe-c).
import { count as shapeCount, measure as measureShape, Square } from "../lib/shapes.ts";
import { count as tileCount, measure as measureTile, Square as Tile } from "../lib/tiles.ts";

export function twoSquares(n: number): number {
  let total = 0;
  for (let i = 0; i < (n | 0); i++) {
    const a = new Square(i);
    const b = new Tile(i);
    total = (total + measureShape(a) + measureTile(b)) | 0;
  }
  return (total + shapeCount() * 1000 + tileCount() * 100000) | 0;
}
