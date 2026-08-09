/**
 * Round 3: map the FIX BOUNDARY. For each object-construction shape, does the
 * standalone runtime (non-syntactic) own-property MOP answer correctly?
 *
 * `ho`/`gopd`/`gopn` take UNTYPED params, so every query inside them is a
 * runtime one — the same situation `verifyProperty(obj, name, desc)` is in.
 *
 * Run: npx tsx .tmp/vp/inner3.mts [host]
 */
import { compile } from "../../../src/index.ts";
import { assembleOriginalHarness } from "../../../tests/test262-original-harness.ts";

const LANE = process.argv[2] === "host" ? undefined : ("standalone" as const);

const SHAPES: [string, string][] = [
  ["object literal {a:1}", `S_LIT`],
  ["{} then o.a = 1", `S_ASSIGN`],
  ["{} then o['a'] = 1", `S_COMPUTED`],
  ["{} then defineProperty(o,'a',…)", `S_DEFPROP`],
  ["new Object() then o.a = 1", `S_NEWOBJ`],
  ["Object.create(null) then o.a=1", `S_CREATENULL`],
  ["JSON.parse('{\"a\":1}')", `S_JSON`],
  ["{...{a:1}} spread", `S_SPREAD`],
  ["Object.assign({}, {a:1})", `S_ASSIGNFN`],
  ["literal passed through any-param fn", `S_THRUFN`],
  ["Math (builtin namespace, key 'abs')", `S_MATH`],
  ["Math.abs (builtin fn, key 'name')", `S_ABS`],
];

const OBS: [number, string, string][] = [];
let id = 200;
for (const [label, v] of SHAPES) {
  const key = v === "S_MATH" ? `"abs"` : v === "S_ABS" ? `"name"` : `"a"`;
  OBS.push([id++, `ho()      ${label}`, `ho(${v}, ${key})`]);
  OBS.push([id++, `gopd!==u  ${label}`, `gopd(${v}, ${key}) !== undefined`]);
  OBS.push([id++, `gopn.len  ${label}`, `gopn(${v}).length`]);
  OBS.push([id++, `keys.len  ${label}`, `keys(${v}).length`]);
  OBS.push([id++, `forin.n   ${label}`, `forinCount(${v})`]);
  id += 5 - 5; // keep 5 per shape
}

const branches = OBS.map(
  ([oid, , expr], k) =>
    `  ${k === 0 ? "if" : "else if"} (j === ${oid}) { var t${oid} = ${expr}; v = (t${oid} === true) ? 1 : (t${oid} === false) ? 0 : (typeof t${oid} === "number") ? t${oid} : (t${oid} === undefined) ? 7 : 8; }`,
).join("\n");

const PROBE = `
function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
function gopd(a, b) { return Object.getOwnPropertyDescriptor(a, b); }
function gopn(a) { return Object.getOwnPropertyNames(a); }
function keys(a) { return Object.keys(a); }
function forinCount(a) { var n = 0; for (var k in a) { n++; } return n; }

var S_LIT = { a: 1 };
var S_ASSIGN = {}; S_ASSIGN.a = 1;
var S_COMPUTED = {}; S_COMPUTED["a"] = 1;
var S_DEFPROP = {}; Object.defineProperty(S_DEFPROP, "a", { value: 1, writable: true, enumerable: true, configurable: true });
var S_NEWOBJ = new Object(); S_NEWOBJ.a = 1;
var S_CREATENULL = Object.create(null); S_CREATENULL.a = 1;
var S_JSON = JSON.parse('{"a":1}');
var S_SPREAD = { ...{ a: 1 } };
var S_ASSIGNFN = Object.assign({}, { a: 1 });
function thru(x) { return x; }
var S_THRUFN = thru({ a: 1 });
var S_MATH = Math;
var S_ABS = Math.abs;

/** @param {number} i */
export function p(i) {
  var v = 9;
  var j = i + 0;
  try {
${branches}
  else { v = 1000 + j; }
  } catch (e) { v = 2; }
  return v + 0;
}
`;

const assembly = assembleOriginalHarness(PROBE, { includes: ["propertyHelper.js"], flags: ["noStrict"] });
const result = await compile(assembly.primary.source, {
  allowJs: true,
  fileName: "probe3.js",
  sourceMap: true,
  emitWat: false,
  skipSemanticDiagnostics: true,
  ...(LANE ? { target: LANE } : {}),
  deferTopLevelInit: true,
} as any);

if (!result.success || result.errors.some((e: any) => e.severity === "error")) {
  console.log("COMPILE ERRORS:", result.errors.map((e: any) => e.message).join("; ").slice(0, 1500));
  process.exit(1);
}
console.log("lane =", LANE ?? "host", "| imports =", JSON.stringify(result.imports));

const { instance } = await WebAssembly.instantiate(result.binary, {} as any);
const exp = instance.exports as Record<string, any>;
try {
  exp.__module_init?.();
} catch (e) {
  console.log("MODULE INIT THREW:", String(e).slice(0, 300));
}

const DECODE = (v: number): string =>
  v === 9 ? "NOT-TAKEN" : v === 2 ? "THREW" : v === 7 ? "undef" : v === 8 ? "other" : v === 1 ? "TRUE" : v === 0 ? "false" : String(v);

for (const [oid, label] of OBS) {
  let out: string;
  try {
    const v = exp.p(oid);
    out = typeof v === "number" ? DECODE(v) : `NON-NUMERIC ${String(v)}`;
  } catch (e) {
    out = `TRAP ${String(e).slice(0, 60)}`;
  }
  console.log(String(oid).padStart(4), label.padEnd(48), "=>", out);
}
