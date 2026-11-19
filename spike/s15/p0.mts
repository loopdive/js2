import { probe } from "./bridge.mts";
const lib = "export function lib_parseInt(s: any): number { return parseInt(s); }";
console.log(await probe("p0", 'function lib_parseInt(s) { return 0; }\nif (lib_parseInt("42") !== 42) throw 1;', ["lib_parseInt"], lib));
console.log(await probe("p0w", 'function lib_parseInt(s) { return 0; }\nif (lib_parseInt("42") !== 43) throw 1;', ["lib_parseInt"], lib));
