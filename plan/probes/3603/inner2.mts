/**
 * Round 2: pin the exact mechanism of `Function.prototype.call.bind(F)`
 * (the test262 "uncurryThis" idiom) on the standalone lane.
 *
 * Run: npx tsx .tmp/vp/inner2.mts [host]
 */
import { compile } from "../../../src/index.ts";
import { assembleOriginalHarness } from "../../../tests/test262-original-harness.ts";

const LANE = process.argv[2] === "host" ? undefined : ("standalone" as const);

const OBS: [number, string, string][] = [
  // --- does the bound function exist / run at all? ---
  [100, "typeof UNCURRIED === 'function'", `typeof UNCURRIED === "function"`],
  [101, "UNCURRIED(OBJ,'a') === 'SPYRET' (spy ran)", `UNCURRIED(OBJ, "a") === "SPYRET"`],
  [102, "UNCURRIED(OBJ,'a') === undefined", `UNCURRIED(OBJ, "a") === undefined`],

  // --- what did the spy actually see? (call UNCURRIED first, then read) ---
  [110, "spy this === OBJ", `RUN() + (SEEN_THIS === OBJ ? 1 : 0) - RUN0()`],
  [111, "spy this === undefined", `RUN() + (SEEN_THIS === undefined ? 1 : 0) - RUN0()`],
  [112, "spy this === SPY (self)", `RUN() + (SEEN_THIS === SPY ? 1 : 0) - RUN0()`],
  [113, "spy argc", `RUN() + SEEN_ARGC - RUN0()`],
  [114, "spy p0 === OBJ", `RUN() + (SEEN_P0 === OBJ ? 1 : 0) - RUN0()`],
  [115, "spy p0 === 'a'", `RUN() + (SEEN_P0 === "a" ? 1 : 0) - RUN0()`],
  [116, "spy p0 === undefined", `RUN() + (SEEN_P0 === undefined ? 1 : 0) - RUN0()`],
  [117, "spy p1 === 'a'", `RUN() + (SEEN_P1 === "a" ? 1 : 0) - RUN0()`],
  [118, "spy p1 === undefined", `RUN() + (SEEN_P1 === undefined ? 1 : 0) - RUN0()`],

  // --- controls: plain .bind, plain .call, .call via variable ---
  [120, "SPY.call(OBJ,'a') === 'SPYRET'", `SPY.call(OBJ, "a") === "SPYRET"`],
  [121, "SPY.bind(OBJ)('a') === 'SPYRET'", `SPY.bind(OBJ)("a") === "SPYRET"`],
  [122, "Function.prototype.call.call(SPY,OBJ,'a')==='SPYRET'", `Function.prototype.call.call(SPY, OBJ, "a") === "SPYRET"`],
  [123, "typeof Function.prototype.call.bind", `typeof Function.prototype.call.bind === "function"`],
  [124, "FPC === Function.prototype.call", `FPC === Function.prototype.call`],

  // --- direct uncurried hasOwnProperty variants ---
  [130, "HOP.call(OBJ,'a')   [direct .call]", `HOP.call(OBJ, "a")`],
  [131, "HOP2(OBJ,'a')       [FPC.bind(HOP)]", `HOP2(OBJ, "a")`],
  [132, "HOP3(OBJ,'a')       [HOP.call.bind(HOP)]", `HOP3(OBJ, "a")`],
  [133, "HOP4(OBJ,'a')       [(a,b)=>HOP.call(a,b)]", `HOP4(OBJ, "a")`],
  [134, "HOP2(FN,'name')     [FPC.bind(HOP), fn recv]", `HOP2(FN, "name")`],
  [135, "HOP2(FN,'nope_zz')  [FPC.bind(HOP), fn recv]", `HOP2(FN, "nope_zz")`],
  [136, "HOP.call(FN,'name') [direct .call, fn recv]", `HOP.call(FN, "name")`],
  [137, "HOP.call(FN,'nope_zz')", `HOP.call(FN, "nope_zz")`],

  // --- bound-with-extra-arg arity probes ---
  [140, "UNCURRIED(OBJ) argc", `RUN1() + SEEN_ARGC - RUN0()`],
  [141, "UNCURRIED(OBJ,'a','b') argc", `RUN3() + SEEN_ARGC - RUN0()`],

  // --- Array.prototype.push / join uncurried ---
  [150, "__push(arr,'x') then arr.length", `PUSHLEN()`],
  [152, "__join(['a','b'],';') === 'a;b'", `__join(["a", "b"], ";") === "a;b"`],
  [153, "Array.prototype.join.call(['a','b'],';') === 'a;b'", `Array.prototype.join.call(["a", "b"], ";") === "a;b"`],
];

const branches = OBS.map(
  ([id, , expr], k) =>
    `  ${k === 0 ? "if" : "else if"} (j === ${id}) { var t${id} = ${expr}; v = (t${id} === true) ? 1 : (t${id} === false) ? 0 : (typeof t${id} === "number") ? t${id} : (t${id} === undefined) ? 7 : 8; }`,
).join("\n");

const PROBE = `
var FN = Math.abs;
var OBJ = { a: 1 };

var SEEN_THIS = "NOTSET";
var SEEN_ARGC = -1;
var SEEN_P0 = "NOTSET";
var SEEN_P1 = "NOTSET";

function SPY(x, y) {
  SEEN_THIS = this;
  SEEN_ARGC = arguments.length;
  SEEN_P0 = x;
  SEEN_P1 = y;
  return "SPYRET";
}

var FPC = Function.prototype.call;
var UNCURRIED = Function.prototype.call.bind(SPY);

var HOP = Object.prototype.hasOwnProperty;
var HOP2 = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var HOP3 = HOP.call.bind(HOP);
function HOP4(a, b) { return HOP.call(a, b); }

function RUN0() { return 0; }
function RUN() { SEEN_THIS = "NOTSET"; SEEN_ARGC = -1; SEEN_P0 = "NOTSET"; SEEN_P1 = "NOTSET"; UNCURRIED(OBJ, "a"); return 0; }
function RUN1() { SEEN_ARGC = -1; UNCURRIED(OBJ); return 0; }
function RUN3() { SEEN_ARGC = -1; UNCURRIED(OBJ, "a", "b"); return 0; }

function PUSHLEN() { var arr = []; __push(arr, "x"); return arr.length; }

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
  fileName: "probe2.js",
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
  console.log(String(id).padStart(4), label.padEnd(54), "=>", out);
}
