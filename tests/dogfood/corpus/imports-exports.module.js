import defaultExport from "./mod.js";
import * as namespace from "./ns.js";
import { named, aliased as alias } from "./named.js";
import defaultE, { mixed } from "./mixed.js";
import "./side-effect.js";
export const exported = 1;
export function exportedFn() {}
export default class {}
export { named as renamed };
export * from "./reexport.js";
export * as ns from "./reexport2.js";
