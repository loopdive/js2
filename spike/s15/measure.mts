// (f) size and compile time: ordinary prelude vs per-program shim vs one shared library.
import { legacy, prepared, toImports } from "./bridge.mts";
import { compile as ordinary } from "../../src/index.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const B = "../../node_modules/.pnpm/binaryen@132.0.0/node_modules/binaryen/bin";
const FEAT = ["--enable-gc", "--enable-reference-types", "--enable-exception-handling", "--enable-tail-call", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-multivalue"];
const bin = (t: string, ...a: string[]) => execFileSync(`${B}/${t}`, a, { encoding: "utf8", maxBuffer: 1 << 28 });
const time = (f: () => void) => { const t = performance.now(); f(); return Math.round(performance.now() - t); };
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// What the prelude needs from a library: its built-ins (census in #7354) plus the dynamic operations
// Prepared refuses today ("has no Prepared intrinsic"): member get/set, +, typeof, call, new, instanceof.
const PRELUDE: [string, string, string][] = [
  ["lib_globalThis", "", "return globalThis;"],
  ["lib_global", "k: any", "return (globalThis as any)[k];"],
  ["lib_String", "v: any", "return String(v);"],
  ["lib_JSON_stringify", "v: any", "return JSON.stringify(v);"],
  ["lib_objToString", "v: any", "return Object.prototype.toString.call(v);"],
  ["lib_mapCall", "a: any, f: any", "return Array.prototype.map.call(a, f);"],
  ["lib_join", "a: any, s: any", "return a.join(s);"],
  ["lib_TypeError", "m: any", "return new TypeError(m);"],
  ["lib_ReferenceError", "m: any", "return new ReferenceError(m);"],
  ["lib_SyntaxError", "m: any", "return new SyntaxError(m);"],
  ["lib_RangeError", "m: any", "return new RangeError(m);"],
  ["lib_EvalError", "m: any", "return new EvalError(m);"],
  ["lib_URIError", "m: any", "return new URIError(m);"],
  ["lib_Error", "m: any", "return new Error(m);"],
  ["lib_log", "v: any", "console.log(v); return undefined;"],
  ["lib_symbolDesc", "s: any", "return String(s.description);"],
  ["lib_get", "o: any, k: any", "return o[k];"],
  ["lib_set", "o: any, k: any, v: any", "o[k] = v; return v;"],
  ["lib_add", "a: any, b: any", "return a + b;"],
  ["lib_lt", "a: any, b: any", "return a < b;"],
  ["lib_looseEq", "a: any, b: any", "return a == b;"],
  ["lib_typeof", "v: any", "return typeof v;"],
  ["lib_call0", "f: any", "return f();"],
  ["lib_call1", "f: any, a: any", "return f(a);"],
  ["lib_call2", "f: any, a: any, b: any", "return f(a, b);"],
  ["lib_callThis", "f: any, t: any, a: any", "return f.call(t, a);"],
  ["lib_new1", "f: any, a: any", "return new f(a);"],
  ["lib_instanceof", "v: any, f: any", "return v instanceof f;"],
  ["lib_in", "k: any, o: any", "return k in o;"],
  ["lib_obj", "", "return {};"],
  ["lib_arr", "", "return [];"],
  ["lib_keys", "o: any", "return Object.keys(o);"],
  ["lib_isArray", "v: any", "return Array.isArray(v);"],
];
// A wider library: what a share-everything runtime.wasm would also carry for test bodies.
const WIDE: [string, string, string][] = [...PRELUDE];
for (const m of ["toUpperCase", "toLowerCase", "trim", "charAt", "charCodeAt", "indexOf", "lastIndexOf", "slice", "substring", "split", "replace", "concat", "localeCompare", "padStart", "repeat", "startsWith", "endsWith", "includes", "match", "search"])
  WIDE.push([`lib_str_${m}`, "s: any, a: any", `return String(s).${m}(a);`]);
for (const m of ["push", "pop", "shift", "unshift", "slice", "splice", "concat", "indexOf", "lastIndexOf", "reverse", "sort", "filter", "forEach", "every", "some", "reduce", "reduceRight", "find", "findIndex", "fill"])
  WIDE.push([`lib_arr_${m}`, "a: any, b: any", `return a.${m}(b);`]);
for (const m of ["abs", "floor", "ceil", "round", "sqrt", "sin", "cos", "exp", "log", "pow", "max", "min", "random", "trunc", "sign"])
  WIDE.push([`lib_math_${m}`, "a: any, b: any", `return (Math as any).${m}(a, b);`]);
for (const m of ["getOwnPropertyNames", "getOwnPropertyDescriptor", "defineProperty", "getPrototypeOf", "setPrototypeOf", "create", "freeze", "isFrozen", "seal", "isSealed", "preventExtensions", "isExtensible", "assign", "entries", "values"])
  WIDE.push([`lib_object_${m}`, "a: any, b: any, c: any", `return (Object as any).${m}(a, b, c);`]);
WIDE.push(["lib_json_parse", "s: any", "return JSON.parse(s);"], ["lib_regexp_test", "r: any, s: any", "return new RegExp(r).test(s);"],
  ["lib_date_now", "", "return new Date(0).getTime();"], ["lib_map_new", "", "return new Map();"], ["lib_set_new", "", "return new Set();"],
  ["lib_num_toFixed", "n: any, d: any", "return Number(n).toFixed(d);"], ["lib_num_toString", "n: any, r: any", "return Number(n).toString(r);"],
  ["lib_parseFloat", "s: any", "return parseFloat(s);"], ["lib_parseInt", "s: any, r: any", "return parseInt(s, r);"]);

const libSource = (xs: [string, string, string][]) => xs.map(([n, p, b]) => `export function ${n}(${p}): any { ${b} }`).join("\n");
const preludeSrc = readFileSync("prelude.js", "utf8");

async function compileTimes(label: string, f: () => Promise<{ binary: Uint8Array; ms: number }>) {
  const runs: number[] = []; let bytes = 0;
  for (let i = 0; i < 4; i++) { const r = await f(); runs.push(r.ms); bytes = r.binary.length; }
  console.log(label, { bytes, coldMs: Math.round(runs[0]!), warmMedianMs: Math.round(median(runs.slice(1))) });
  return (await f()).binary;
}
await compileTimes("M0 ordinary standalone: prelude + assert.sameValue(1,1)", async () => {
  const t = performance.now();
  const r: any = await ordinary(preludeSrc, { target: "standalone", fileName: "prelude.js", allowJs: true } as any);
  if (!r.success) throw new Error(r.errors.map((e: any) => e.message).join(" | "));
  return { binary: r.binary, ms: performance.now() - t };
});
const shim = await compileTimes(`M1 per-program shim (${PRELUDE.length} prelude exports)`, () => legacy(libSource(PRELUDE)));
const wide = await compileTimes(`M2 shared library (${WIDE.length} exports)`, () => legacy(libSource(WIDE)));

// A Prepared module with the prelude's import surface: one stub per export, each called once.
const stubs = PRELUDE.map(([n, p]) => `function ${n}(${p.replace(/: any/g, "")}) { return __d; }`).join("\n");
const calls = PRELUDE.map(([n, p]) => `  ${n}(${p ? p.split(",").map(() => "0").join(", ") : ""});`).join("\n");
const prep = await prepared(`var __d;\n${stubs}\nfunction never() {\n${calls}\n}\nvar __n = 0;\nif (__n === 1) never();\n`);
const prepBridged = toImports("meas", prep.binary, PRELUDE.map(([n]) => n));
console.log("Prepared module with the prelude import surface", { bytes: prepBridged.length, compileMs: Math.round(prep.ms) });

for (const [label, lib] of [["shim", shim], ["wide", wide]] as const) {
  writeFileSync(`meas.${label}.wasm`, lib);
  const inst = median([0, 1, 2].map(() => time(() => new WebAssembly.Instance(new WebAssembly.Module(lib), {}))));
  const L = new WebAssembly.Instance(new WebAssembly.Module(lib), {});
  const link = median([0, 1, 2].map(() => time(() => new WebAssembly.Instance(new WebAssembly.Module(prepBridged), { "legacy-lib": L.exports as any }))));
  const mergeMs = time(() => bin("wasm-merge", ...FEAT, `meas.${label}.wasm`, "legacy-lib", "meas.bridged.wasm", "prep", "-o", `meas.${label}.merged.wasm`));
  // Keep only the Prepared exports, then drop what nothing reaches.
  bin("wasm-dis", ...FEAT, `meas.${label}.merged.wasm`, "-o", `meas.${label}.merged.wat`);
  const wat = readFileSync(`meas.${label}.merged.wat`, "utf8").split("\n").filter((l) => !/^ \(export "lib_/.test(l)).join("\n");
  writeFileSync(`meas.${label}.noexp.wat`, wat);
  bin("wasm-as", ...FEAT, `meas.${label}.noexp.wat`, "-o", `meas.${label}.noexp.wasm`);
  const dceMs = time(() => bin("wasm-opt", ...FEAT, "--remove-unused-module-elements", `meas.${label}.noexp.wasm`, "-o", `meas.${label}.dce.wasm`));
  const o2Ms = time(() => bin("wasm-opt", ...FEAT, "-O2", `meas.${label}.noexp.wasm`, "-o", `meas.${label}.o2.wasm`));
  console.log(`link with ${label}`, {
    libInstantiateMs: inst, prepInstantiateAgainstLibMs: link,
    mergeMs, mergedBytes: readFileSync(`meas.${label}.merged.wasm`).length,
    dceMs, dceBytes: readFileSync(`meas.${label}.dce.wasm`).length, o2Ms, o2Bytes: readFileSync(`meas.${label}.o2.wasm`).length,
  });
}
