/**
 * Fine-grained observation channel into the standalone lane's execution of the
 * upstream propertyHelper.js. Compiles the REAL assembled harness (same
 * assembleOriginalHarness the runner uses) plus a probe body that re-evaluates
 * one observation per exported call and returns a NUMBER.
 *
 * Encoding: 0 = falsy, 1 = truthy, 2 = threw, 7 = undefined, 8 = other,
 * 9 = branch not taken; plain integers where the observation is a count.
 *
 * Run: npx tsx .tmp/vp/inner.mts [host]
 */
import { compile } from "../../../src/index.ts";
import { assembleOriginalHarness } from "../../../tests/test262-original-harness.ts";

const LANE = process.argv[2] === "host" ? undefined : ("standalone" as const);

const OBS: [number, string, string][] = [
  // id, label, expression (must evaluate to boolean or number)
  [0, "typeof __hasOwnProperty === 'function'", `typeof __hasOwnProperty === "function"`],
  [1, "typeof __push === 'function'", `typeof __push === "function"`],
  [2, "typeof __join === 'function'", `typeof __join === "function"`],
  [3, "typeof __getOwnPropertyDescriptor === 'function'", `typeof __getOwnPropertyDescriptor === "function"`],
  [4, "typeof __getOwnPropertyNames === 'function'", `typeof __getOwnPropertyNames === "function"`],
  [5, "typeof __propertyIsEnumerable === 'function'", `typeof __propertyIsEnumerable === "function"`],
  [6, "typeof Function.prototype.call === 'function'", `typeof Function.prototype.call === "function"`],
  [7, "typeof Function.prototype.bind === 'function'", `typeof Function.prototype.bind === "function"`],

  [10, "__hasOwnProperty(Math.abs,'name')", `__hasOwnProperty(FN, "name")`],
  [11, "__hasOwnProperty(Math.abs,'no_such_zz')", `__hasOwnProperty(FN, "no_such_zz")`],
  [12, "__hasOwnProperty(OBJ,'a')", `__hasOwnProperty(OBJ, "a")`],
  [13, "__hasOwnProperty(OBJ,'zz')", `__hasOwnProperty(OBJ, "zz")`],
  [14, "__hasOwnProperty(DESC,'value')", `__hasOwnProperty(DESC, "value")`],
  [15, "__hasOwnProperty(DESC,'writable')", `__hasOwnProperty(DESC, "writable")`],
  [16, "__hasOwnProperty(DESC,'enumerable')", `__hasOwnProperty(DESC, "enumerable")`],
  [17, "__hasOwnProperty(DESC,'configurable')", `__hasOwnProperty(DESC, "configurable")`],
  [18, "__hasOwnProperty(DESC,'zz')", `__hasOwnProperty(DESC, "zz")`],

  [20, "Object.prototype.hasOwnProperty.call(DESC,'value')", `Object.prototype.hasOwnProperty.call(DESC, "value")`],
  [21, "DESC.hasOwnProperty('value')", `DESC.hasOwnProperty("value")`],
  [22, "'value' in DESC", `"value" in DESC`],
  [23, "OBJ.hasOwnProperty('a')", `OBJ.hasOwnProperty("a")`],

  [30, "gOPD(Math.abs,'name') === undefined", `__getOwnPropertyDescriptor(FN, "name") === undefined`],
  [31, "gOPD(Math.abs,'name').value === 'abs'", `__getOwnPropertyDescriptor(FN, "name").value === "abs"`],
  [32, "gOPD(OBJ,'a') === undefined", `__getOwnPropertyDescriptor(OBJ, "a") === undefined`],
  [33, "gOPD(OBJ,'a').value === 1", `__getOwnPropertyDescriptor(OBJ, "a").value === 1`],
  [34, "gOPD(OBJ,'a').writable === true", `__getOwnPropertyDescriptor(OBJ, "a").writable === true`],
  [35, "gOPD(OBJ,'a').enumerable === true", `__getOwnPropertyDescriptor(OBJ, "a").enumerable === true`],
  [36, "gOPD(Math.abs,'name').writable === false", `__getOwnPropertyDescriptor(FN, "name").writable === false`],

  [40, "__getOwnPropertyNames(DESC).length", `__getOwnPropertyNames(DESC).length`],
  [41, "Object.getOwnPropertyNames(DESC).length", `Object.getOwnPropertyNames(DESC).length`],
  [42, "Object.keys(DESC).length", `Object.keys(DESC).length`],

  [50, "arr.length after __push(arr,'x')", `PUSHLEN()`],
  [51, "arr.length after arr.push('x')", `NATPUSHLEN()`],
  [52, "__join(['a','b'],';') === 'a;b'", `__join(["a", "b"], ";") === "a;b"`],

  [60, "isEnumerable(OBJ,'a')", `isEnumerable(OBJ, "a")`],
  [61, "isEnumerable(Math.abs,'name')", `isEnumerable(FN, "name")`],
  [62, "isSameValue(1,1)", `isSameValue(1, 1)`],
  [63, "isSameValue(1,2)", `isSameValue(1, 2)`],
  [64, "isWritable(OBJ,'a')", `isWritable(OBJ, "a")`],
  [65, "isConfigurable(OBJ,'a')", `isConfigurable(OBJ, "a")`],

  // The exact vacuity sites, re-expressed as observations.
  [70, "DESC.value === gOPD(OBJ,'a').value", `DESC.value === __getOwnPropertyDescriptor(OBJ, "a").value`],
  [71, "isSameValue(DESC.value, OBJ['a'])", `isSameValue(DESC.value, OBJ["a"])`],
  [72, "typeof DESC === 'object'", `typeof DESC === "object"`],
  [73, "DESC.enumerable !== undefined", `DESC.enumerable !== undefined`],
  [74, "DESC.writable !== undefined", `DESC.writable !== undefined`],
];

const branches = OBS.map(
  ([id, , expr], k) => `  ${k === 0 ? "if" : "else if"} (j === ${id}) { var t${id} = ${expr}; v = (t${id} === true) ? 1 : (t${id} === false) ? 0 : (typeof t${id} === "number") ? t${id} : (t${id} === undefined) ? 7 : 8; }`,
).join("\n");

const PROBE = `
var FN = Math.abs;
var OBJ = { a: 1 };
var DESC = { value: 1, writable: true, enumerable: true, configurable: true };

function PUSHLEN() { var arr = []; __push(arr, "x"); return arr.length; }
function NATPUSHLEN() { var arr = []; arr.push("x"); return arr.length; }

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
const src = assembly.primary.source;

const result = await compile(src, {
  allowJs: true,
  fileName: "probe.js",
  sourceMap: true,
  emitWat: false,
  skipSemanticDiagnostics: true,
  ...(LANE ? { target: LANE } : {}),
  deferTopLevelInit: true,
} as any);

if (!result.success || result.errors.some((e: any) => e.severity === "error")) {
  console.log("COMPILE ERRORS:", result.errors.map((e: any) => e.message).join("; ").slice(0, 2000));
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
  v === 9 ? "NOT-TAKEN" : v === 2 ? "THREW" : v === 7 ? "undefined" : v === 8 ? "other" : v === 1 ? "TRUE" : v === 0 ? "false" : String(v);

for (const [id, label] of OBS) {
  let out: string;
  try {
    const v = exp.p(id);
    out = typeof v === "number" ? DECODE(v) : `NON-NUMERIC ${String(v)}`;
  } catch (e) {
    out = `ACCESSOR-THREW ${String(e).slice(0, 90)}`;
  }
  console.log(String(id).padStart(3), label.padEnd(52), "=>", out);
}
