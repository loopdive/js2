/**
 * P3 attribution sweep — ONE ARM PER PROCESS.
 *
 * `assembleOriginalHarness` caches harness sources in a module-private Map, so
 * an in-process kill switch is impossible; instead each arm runs in its own
 * process over the IDENTICAL file list in the IDENTICAL order, and arm "A2"
 * repeats arm A verbatim so ordering/load drift can be EXCLUDED empirically
 * rather than assumed away.
 *
 * Arms:
 *   A   stock harness (baseline)
 *   B1  uncurryThis -> literal `.call(...)` spelling      (isolates call.bind)
 *   B2  uncurryThis -> primitive spelling, NO reflection  (upper bound)
 *   A2  stock harness again (drift control; must equal A row-for-row)
 *
 * usage: npx tsx .tmp/arm.mts <A|B1|B2|A2> <listfile> <outfile>
 */
import fs from "node:fs";
import path from "node:path";
import { runTest262File } from "../tests/test262-runner.js";

const [arm, listFile, outFile] = process.argv.slice(2);
if (!arm || !listFile || !outFile) {
  console.error("usage: arm.mts <A|B1|B2|A2> <listfile> <outfile>");
  process.exit(2);
}

const WT = process.cwd();
const HARNESS = path.join(WT, "test262", "harness");
const PH = path.join(HARNESS, "propertyHelper.js");

// ── the kill switch ────────────────────────────────────────────────────────
// Replaces exactly the four uncurried captures on lines 29-32. Every call site
// in propertyHelper.js passes exactly 2 arguments, so no rest/spread is needed
// and no second confound is introduced.
const STOCK = `var __join = Function.prototype.call.bind(Array.prototype.join);
var __push = Function.prototype.call.bind(Array.prototype.push);
var __hasOwnProperty = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);`;

// B1: drop ONLY the `Function.prototype.call.bind` layer; keep `.call`.
const B1 = `var __join = function (o, s) { return Array.prototype.join.call(o, s); };
var __push = function (o, v) { return Array.prototype.push.call(o, v); };
var __hasOwnProperty = function (o, n) { return Object.prototype.hasOwnProperty.call(o, n); };
var __propertyIsEnumerable = function (o, n) { return Object.prototype.propertyIsEnumerable.call(o, n); };`;

// B2: no reflective dispatch at all. Semantically equivalent for own-property
// queries: getOwnPropertyDescriptor returns undefined iff the property is not
// an own property, and .enumerable mirrors propertyIsEnumerable for own props.
const B2 = `var __join = function (o, s) { var r = ""; for (var __i = 0; __i < o.length; __i++) { if (__i > 0) r += s; r += o[__i]; } return r; };
var __push = function (o, v) { o[o.length] = v; return o.length; };
var __hasOwnProperty = function (o, n) { return Object.getOwnPropertyDescriptor(o, n) !== undefined; };
var __propertyIsEnumerable = function (o, n) { var d = Object.getOwnPropertyDescriptor(o, n); return d !== undefined && d.enumerable === true; };`;

// Arm S — SIMULATE THE #3976 FIX in the harness, then let the REAL probes run.
// Unlike arm U (which is vacuous), S only supplies what the fix would supply:
// own-property PRESENCE and a spec descriptor. The writable / configurable
// probes still execute for real against the real object, so S measures the
// REALISED yield of a presence+descriptor fix including its mutability
// requirements — before any compiler code is written.
// NOTE: the first version of this arm REBOUND `__hasOwnProperty = __simPresent`.
// That was a SILENT NO-OP under standalone — a function-valued `var`
// reassignment does not take effect in the compiled code, so all 40 rows still
// failed at the own-property gate and the arm would have read as "the fix is
// worth 0". Caught only because the failure SIGNATURE was inspected instead of
// the pass count. Call sites are substituted textually instead.
const S_EXTRA = `
function __simPresent(o, n) {
  if (o === undefined || o === null) return false;
  if (Object.prototype.hasOwnProperty.call(o, n)) return true;
  if (Object.getOwnPropertyDescriptor(o, n) !== undefined) return true;
  return o[n] !== undefined;           // class method: callable but not an own prop
}
function __simGOPD(o, n) {
  var d = Object.getOwnPropertyDescriptor(o, n);
  if (d !== undefined) return d;
  if (o === undefined || o === null) return undefined;
  if (o[n] === undefined) return undefined;
  return { value: o[n], writable: true, enumerable: false, configurable: true };
}
`;

const REPL: Record<string, string> = { A: STOCK, A2: STOCK, B1, B2, P: STOCK, U: STOCK, S: STOCK };
if (!(arm in REPL)) {
  console.error(`unknown arm ${arm}`);
  process.exit(2);
}

// Arm P — WHERE does the throw originate? propertyHelper reaches line 48
// `__getOwnPropertyDescriptor(obj, name)` BEFORE line 64's uncurried
// `__hasOwnProperty(obj, name)`, and line 27 captures gOPD DIRECTLY (not via
// uncurryThis). Arm P labels the entry condition so the two are separable.
const P_FROM = `  var originalDesc = __getOwnPropertyDescriptor(obj, name);`;
const P_TO = `  if (obj === undefined || obj === null) { throw new Test262Error("P3PROBE-ENTRY-NULLISH"); }
  var originalDesc = __getOwnPropertyDescriptor(obj, name);
  if (originalDesc === undefined) { throw new Test262Error("P3PROBE-NO-OWN-PROP"); }`;

// ── private harness copy (protects OTHER agents; see 3603/NOTES.txt) ───────
let swapped = false;
function restore() {
  if (!swapped) return;
  try {
    fs.rmSync(HARNESS, { recursive: true, force: true });
    fs.symlinkSync("/workspace/test262/harness", HARNESS);
  } catch (e) {
    console.error("RESTORE FAILED", e);
  }
  swapped = false;
}
process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    restore();
    process.exit(1);
  });
}

const isLink = fs.lstatSync(HARNESS).isSymbolicLink();
if (!isLink) {
  console.error("REFUSING: test262/harness is not a symlink — a previous run may not have restored it.");
  process.exit(1);
}
fs.cpSync("/workspace/test262/harness", HARNESS + ".tmpcopy", { recursive: true, dereference: true });
fs.unlinkSync(HARNESS);
fs.renameSync(HARNESS + ".tmpcopy", HARNESS);
swapped = true;

// apply the arm
const orig = fs.readFileSync(PH, "utf8");
if (!orig.includes(STOCK)) {
  console.error("REFUSING: stock uncurryThis block not found verbatim in propertyHelper.js");
  process.exit(1);
}
// Arm U — CEILING, deliberately VACUOUS. Makes verifyProperty a no-op, i.e.
// simulates "class elements are installed perfectly with the expected
// descriptor". A file that STILL fails has a defect BEYOND the own-property
// gap. This is an UPPER BOUND on #3976's flip yield and MUST NEVER be quoted
// as a flip prediction or as a conformance number — it weakens the check by
// construction. Its only valid reading is: files that do not pass here cannot
// be fixed by #3976 alone.
let patched = orig.replace(STOCK, REPL[arm]);
if (arm === "U") {
  const anchor = `function verifyProperty(obj, name, desc, options) {`;
  if (!patched.includes(anchor)) {
    console.error("REFUSING: arm U anchor not found");
    process.exit(1);
  }
  patched = patched.replace(anchor, anchor + `\n  return true; // ARM U CEILING — vacuous by design`);
}
if (arm === "S") {
  patched = patched.replace(STOCK, STOCK + "\n" + S_EXTRA);
  // Substitute the CALL SITES (rebinding is a silent no-op — see above).
  const before = patched;
  patched = patched
    .replaceAll("__hasOwnProperty(obj, name)", "__simPresent(obj, name)")
    .replaceAll("__getOwnPropertyDescriptor(obj, name)", "__simGOPD(obj, name)");
  if (patched === before) {
    console.error("REFUSING: arm S call-site substitution matched nothing");
    process.exit(1);
  }
  console.error(`arm S: substituted call sites (+${patched.length - before.length} bytes)`);
}
if (arm === "P") {
  if (!patched.includes(P_FROM)) {
    console.error("REFUSING: arm P anchor not found");
    process.exit(1);
  }
  patched = patched.replace(P_FROM, P_TO);
}
if (arm !== "A" && arm !== "A2" && patched === orig) {
  console.error("REFUSING: patch was a no-op");
  process.exit(1);
}
fs.writeFileSync(PH, patched);
console.error(`arm ${arm}: harness patched (${patched.length - orig.length} byte delta)`);

// ── run ────────────────────────────────────────────────────────────────────
const files: string[] = JSON.parse(fs.readFileSync(listFile, "utf8"));
const out: any[] = [];
let n = 0;
for (const rel of files) {
  const abs = path.join("/workspace/test262", rel);
  const cat = rel.split("/").slice(1, 3).join("/");
  const t0 = Date.now();
  let status = "ERROR";
  let error = "";
  try {
    const r = await runTest262File(abs, cat, 60000, "standalone");
    status = r.status;
    error = (r as any).error ?? "";
  } catch (e: any) {
    status = "THREW";
    error = String(e?.message ?? e);
  }
  out.push({ file: rel, status, error, ms: Date.now() - t0 });
  n++;
  if (n % 10 === 0) console.error(`  ${arm}: ${n}/${files.length}`);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 0));
const pass = out.filter((r) => r.status === "pass").length;
console.error(`arm ${arm}: ${pass}/${out.length} pass -> ${outFile}`);
restore();
