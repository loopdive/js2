import { prepared, legacy, toImports, merge, runTwo, runOne } from "./bridge.mts";
const LIB = `export function lib_isAbc(s: any, z: any): any { return s === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }
export function lib_len(s: any, z: any): any { return String(s).length; }
export function lib_upper(s: any, z: any): any { return String(s).toUpperCase(); }
export function lib_get(o: any, k: any, z: any): any { return o[k]; }
export function lib_obj(z: any): any { return { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 1 }; }`;
const P = (cmp: string) => `
function lib_isAbc(s: any, z: any): any { return z; }
function lib_len(s: any, z: any): any { return z; }
function lib_upper(s: any, z: any): any { return z; }
function lib_get(o: any, k: any, z: any): any { return z; }
function lib_obj(z: any): any { return z; }
function cat(a: string, b: string): string { return a + b; }
var s = cat("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
${cmp}`;
const cases: [string, string, string][] = [
  ["b8 runtime cons string into legacy ===", "if (lib_isAbc(s, 0) !== true) throw 1;", "if (lib_isAbc(s, 0) !== false) throw 1;"],
  ["b9 runtime cons string into legacy .length", "if (lib_len(s, 0) !== 70) throw 1;", "if (lib_len(s, 0) !== 71) throw 1;"],
  ["b10 runtime cons string into legacy toUpperCase", 'if (lib_upper(s, 0) !== "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") throw 1;', 'if (lib_upper(s, 0) !== "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBD") throw 1;'],
  ["b11 runtime cons string as legacy property key", "if (lib_get(lib_obj(0), s, 0) !== 1) throw 1;", "if (lib_get(lib_obj(0), s, 0) !== 2) throw 1;"],
];
const stubs = ["lib_isAbc", "lib_len", "lib_upper", "lib_get", "lib_obj"];
const l = await legacy(LIB);
for (const [name, ok, bad] of cases) {
  const out: string[] = [];
  for (const [i, body] of [ok, bad].entries()) {
    try {
      const p = await prepared(P(body), "p.ts");
      const s = toImports(`b8_${i}`, p.binary, stubs);
      out.push(runTwo(s, l.binary) + " / " + runOne(merge(`b8_${i}`, s, l.binary).binary));
    } catch (e: any) { out.push("ERR " + String(e.message).slice(0, 200)); }
  }
  console.log(name, "->", out[0], "| twin:", out[1]);
}
