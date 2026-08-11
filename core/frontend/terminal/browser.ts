// The terminal capability's browser-bound surface: the parts that need xterm,
// a DOM or a GPU, and therefore cannot be loaded by the node --test lanes.
//
// It is kept apart from "./index.ts" — the logic entry point, which stays
// loadable in a bare node process — and from "./views.ts", which is React. A
// module belongs here when its subject is the engine rather than the product's
// meaning, which makes this entry point the named legacy side of area 05's
// deletion: what remains listed here is what still binds xterm.
export { computeTerminalSize } from "./terminalXtermMeasure.ts";
