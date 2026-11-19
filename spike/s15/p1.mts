import { probe } from "./bridge.mts";
// Each probe: a Prepared program whose lib_* stubs become legacy-lib imports, the legacy shim, and a
// wrong-answer twin so a "returned" cannot come from a check that never ran.
const LIB = `
export function lib_obj(): any { return { a: 1 }; }
export function lib_keys(o: any): any { return Object.keys(o).length; }
export function lib_upper(s: any): any { return String(s).toUpperCase(); }
export function lib_isAbc(s: any): any { return s === "abc"; }
export function lib_len(s: any): any { return String(s).length; }
export function lib_concat(a: any, b: any): any { return String(a) + String(b); }
export function lib_throw(): any { throw new TypeError("boom"); }
export function lib_errName(e: any): any { return e instanceof TypeError ? "TypeError" : typeof e; }
export function lib_catchThunk(v: any): any { try { throw v; } catch (e) { return e; } }
export function lib_undef(): any { return undefined; }
export function lib_isUndef(v: any): any { return v === undefined; }
export function lib_typeof(v: any): any { return typeof v; }
export function lib_true(): any { return true; }
export function lib_isTrue(v: any): any { return v === true; }
export function lib_getParseInt(): any { return parseInt; }
export function lib_call1(f: any, a: any): any { return f(a); }
export function lib_objProto(): any { return Object.prototype; }
export function lib_protoOf(o: any): any { return Object.getPrototypeOf(o); }
export function lib_same(a: any, b: any): any { return a === b; }
export function lib_get(o: any, k: any): any { return o[k]; }
export function lib_set(o: any, k: any, v: any): any { o[k] = v; return o; }
export function lib_has(o: any, k: any): any { return k in o; }
`;
const stub = (n: string, arity: number) =>
  `function ${n}(${["a", "b", "c"].slice(0, arity).join(",")}) { return __d; }\n`;
const STUBS: Record<string, number> = {
  lib_obj: 0, lib_keys: 1, lib_upper: 1, lib_isAbc: 1, lib_len: 1, lib_concat: 2, lib_throw: 0, lib_errName: 1,
  lib_catchThunk: 1, lib_undef: 0, lib_isUndef: 1, lib_typeof: 1, lib_true: 0, lib_isTrue: 1, lib_getParseInt: 0,
  lib_call1: 2, lib_objProto: 0, lib_protoOf: 1, lib_same: 2, lib_get: 2, lib_set: 3, lib_has: 2,
};
const cases: [string, string, [string, string]][] = [
  ["a1 legacy object through Prepared and back", "var o = lib_obj(); if (lib_keys(o) !== 1) throw 1;", ["!== 1", "!== 2"]],
  ["a2 object identity on the Prepared side", "var o = lib_obj(); var p = o; if (p !== o) throw 1; if (lib_same(o, p) !== true) throw 1;", ["!== true", "!== false"]],
  ["b1 legacy string result, Prepared ===", 'var r = lib_upper("abc"); if (r !== "ABC") throw 1;', ['"ABC"', '"ABd"']],
  ["b2 Prepared literal into legacy ===", 'if (lib_isAbc("abc") !== true) throw 1;', ["!== true", "!== false"]],
  ["b3 Prepared concat (cons string) into legacy", 'var s = "ab" + "c"; if (lib_isAbc(s) !== true) throw 1; if (lib_len(s) !== 3) throw 1;', ["!== 3", "!== 4"]],
  ["b4 legacy concat, Prepared ===", 'var r = lib_concat("a", "bc"); if (r !== "abc") throw 1;', ['"abc")', '"abd")']],
  ["c1 legacy throw caught by Prepared", "var caught = 0; try { lib_throw(); } catch (e) { caught = 1; } if (caught !== 1) throw 1;", ["caught = 1;", "caught = 2;"]],
  ["c2 caught legacy error value back to legacy", 'var n = 0; try { lib_throw(); } catch (e) { n = lib_errName(e); } if (n !== "TypeError") throw 1;', ['"TypeError"', '"TypeErrox"']],
  ["c3 Prepared value thrown/caught inside legacy", "if (lib_catchThunk(5) !== 5) throw 1;", ["!== 5", "!== 6"]],
  ["d1 legacy undefined, Prepared === undefined", "var u = lib_undef(); if (u !== undefined) throw 1;", ["u !== undefined", "u === undefined"]],
  ["d2 Prepared undefined, legacy === undefined", "if (lib_isUndef(undefined) !== true) throw 1;", ["!== true", "!== false"]],
  ["d3 Prepared undefined, legacy typeof", 'if (lib_typeof(undefined) !== "undefined") throw 1;', ['"undefined")', '"undefinex")']],
  ["d4 legacy true, Prepared === true", "var t = lib_true(); if (t !== true) throw 1;", ["t !== true", "t === true"]],
  ["d5 Prepared true, legacy === true", "if (lib_isTrue(true) !== true) throw 1;", ["!== true", "!== false"]],
  ["d6 legacy undefined vs Prepared undefined in legacy ===", "if (lib_same(lib_undef(), undefined) !== true) throw 1;", ["!== true", "!== false"]],
  ["d7 legacy undefined vs Prepared dynamic undefined, Prepared ===", "var v; var u = lib_undef(); if (u !== v) throw 1;", ["u !== v", "u === v"]],
  ["d8 legacy boxed true vs Prepared dynamic true, Prepared ===", "var v = true; var u = lib_true(); if (u !== v) throw 1;", ["u !== v", "u === v"]],
  ["b5 Prepared literal as property key in legacy get", 'if (lib_get(lib_obj(), "a") !== 1) throw 1;', ["!== 1", "!== 2"]],
  ["b6 Prepared key set then legacy keys/get/has", 'var o = lib_obj(); lib_set(o, "b", 2); if (lib_keys(o) !== 2 || lib_get(o, "b") !== 2 || lib_has(o, "b") !== true) throw 1;', ["lib_keys(o) !== 2", "lib_keys(o) !== 3"]],
  ["b7 Prepared cons-string key", 'var k = "a" + ""; var o = lib_obj(); if (lib_get(o, k) !== 1) throw 1;', ["!== 1", "!== 2"]],
  ["e1 built-in as a value, called in legacy", 'var f = lib_getParseInt(); if (lib_call1(f, "7") !== 7) throw 1;', ["!== 7", "!== 8"]],
  ["e2 Object.prototype identity", "var o = lib_obj(); if (lib_same(lib_protoOf(o), lib_objProto()) !== true) throw 1;", ["!== true", "!== false"]],
];
const SHARE = process.argv.includes("--share-tag");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
for (const [name, body, [right, wrong]] of cases) {
  if (ONLY && !ONLY.includes(name.split(" ")[0]!)) continue;
  const used = Object.keys(STUBS).filter((n) => body.includes(n + "("));
  const src = "var __d;\n" + used.map((n) => stub(n, STUBS[n]!)).join("") + body;
  const tag = name.split(" ")[0]!;
  try {
    const ok = await probe(tag, src, used, LIB, SHARE);
    const bad = await probe(tag + "w", src.replace(right, wrong), used, LIB, SHARE);
    console.log(JSON.stringify({ name, two: ok.two, merged: ok.merged, twin: [bad.two, bad.merged], bytes: ok.bytes }));
  } catch (e: any) {
    console.log(JSON.stringify({ name, error: String(e.message).slice(0, 300) }));
  }
}
