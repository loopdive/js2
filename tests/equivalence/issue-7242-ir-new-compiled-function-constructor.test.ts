// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7242 — `new F(args)` of a self-guarded top-level function constructor (the
// harness `Test262Error` shape) inside an IR body.
//
// The #7106 S3c selector arm claims `new F(…)` / `x instanceof F` as
// `dyn.construct` / `dyn.instanceof_fn` on F's function-object value. When F
// itself stays legacy (here: `message || ""` with a non-string caller) F's
// signature has no flow evidence, and the planner used to refuse the value
// plan, so the claimed body demoted at build (`unknown class "MyErr"`). The
// plan now takes the opaque all-dynamic signature, as a receiver use does.
// Inside a class method the planner mints the plan too since #7243, and the
// member compiles on the post-direct overlay.
//
// Each case asserts the IR route (`trackIrOutcomes`) on standalone and the
// default gc target, and the result on all three lanes against the JS
// evaluation of the same source — or, on WASI, against the pinned legacy value
// where WASI already diverges from JS (base and head agree there; WASI keeps
// every unit below on legacy).
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions; ir: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, ir: true },
  // (#6979 S7-c) WASI lowers with the native semantic regime, so it takes the IR
  // body like standalone and gives the JS answer; the pre-flip `wasiValue` pins
  // recorded WASI's old divergence and are no longer consulted.
  { name: "wasi", options: { target: "wasi" }, ir: true },
  { name: "gc (default)", options: {}, ir: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

/** Folds `inner()`'s string into a number so every lane compares one value. */
const HASHED_TEST = `
export function test() { var s = inner(); var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h + s.length * 1000003; }`;

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7242.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, exports };
}

interface Case {
  readonly source: string;
  /** Units that must take the IR body on standalone and gc. */
  readonly irUnits: readonly string[];
  /** Units refused at select (never claimed, so never demoted at build). */
  readonly selectRefused?: readonly string[];
}

const CASES: Record<string, Case> = {
  "throw new F() caught and inspected: instanceof, .message, .constructor, String(e)": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
function check(x, msg) {
  if (x !== 1) throw new MyErr(msg);
  return 1;
}
function inner() {
  MyErr(5);
  try { check(2, "bad"); return "no"; } catch (e) { return (e instanceof MyErr) + "|" + e.message + "|" + (e.constructor === MyErr) + "|" + String(e); }
}`,
    irUnits: ["check"],
  },
  "new F() used as a value": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
function make(m) { var e = new MyErr(m); return e; }
function inner() { MyErr(7); var v = make("hi"); return v.message + "|" + (v instanceof MyErr) + "|" + typeof v; }`,
    irUnits: ["make"],
  },
  "F returning an object replaces this; a primitive is ignored": {
    source: `
function F(m) {
  if (!(this instanceof F)) return new F(m);
  this.m = m || "";
  if (m === "obj") return { m: "replaced" };
  if (m === "prim") return 5;
}
function mk(m) { return new F(m); }
function inner() { F(1); var a = mk("obj"), b = mk("prim"), c = mk("x"); return a.m + "|" + b.m + "|" + c.m + "|" + (a instanceof F) + (b instanceof F); }`,
    irUnits: ["mk"],
  },
  "F reading this": {
    source: `
function F(m) {
  if (!(this instanceof F)) return new F(m);
  this.m = m || "";
  this.k = typeof this;
}
function mk(m) { return new F(m); }
function inner() { F(0); var a = mk("q"); return a.m + "|" + a.k; }`,
    irUnits: ["mk"],
  },
  "F called with and without new in one program": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
function viaNew(m) { return new MyErr(m); }
function viaCall(m) { return MyErr(m); }
function inner() { var a = viaNew("n"), b = viaCall("c"); return a.message + b.message + "|" + (a instanceof MyErr) + (b instanceof MyErr) + "|" + (a.constructor === b.constructor); }`,
    irUnits: ["viaNew"],
  },
  "x instanceof F in an IR body": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
function isIt(v) { return v instanceof MyErr; }
function mk(m) { return new MyErr(m); }
function inner() { MyErr(1); return isIt(mk("a")) + "|" + isIt({}) + "|" + isIt(1); }`,
    irUnits: ["isIt", "mk"],
  },
  "a class extending F": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
class Sub extends MyErr { constructor(m) { super(m); this.extra = 1; } }
function mk(m) { return new MyErr(m); }
function inner() { MyErr(1); var s = new Sub("s"); return s.message + "|" + (s instanceof MyErr) + "|" + mk("z").message; }`,
    irUnits: ["mk"],
  },
  "F reading new.target (route unchanged)": {
    source: `
function F(m) {
  if (!(this instanceof F)) return new F(m);
  this.nt = new.target === F;
  this.m = m || "";
}
function mk(m) { return new F(m); }
function inner() { F(1); var a = mk("v"); return a.m + "|" + a.nt; }`,
    irUnits: [],
  },
  "new F() inside a class member takes the IR body (#7243)": {
    source: `
function MyErr(message) {
  if (!(this instanceof MyErr)) return new MyErr(message);
  this.message = message || "";
}
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
class C { m(x) { if (x) throw new MyErr("cm"); return 1; } }
function inner() { MyErr(1); try { new C().m(1); return "no"; } catch (e) { return e.message + "|" + (e instanceof MyErr); } }`,
    irUnits: ["C_m"],
  },
  "an exception thrown inside F propagates out of the IR construct": {
    source: `
function F(m) {
  if (!(this instanceof F)) return new F(m);
  if (m === "boom") throw new RangeError("inner");
  this.m = m || "";
}
function mk(m) { return new F(m); }
function inner() { F(0); var r = "no"; try { mk("boom"); } catch (e) { r = "caught"; } return r + "|" + mk("ok").m; }`,
    irUnits: ["mk"],
  },
};

describe("#7242 IR new of a self-guarded function constructor", () => {
  for (const [title, c] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${title} [${lane.name}]`, async () => {
        const source = c.source + HASHED_TEST;
        const { result, exports } = await compileAndRun(source, lane.options);
        const outcomes = result.irOutcomes ?? [];
        for (const unit of c.irUnits) {
          const kind = outcomes.find((o) => o.displayName === unit)?.kind;
          expect(kind, `${unit} route`).toBe(lane.ir ? "emitted" : "unsupported");
        }
        for (const unit of c.selectRefused ?? []) {
          const outcome = outcomes.find((o) => o.displayName === unit);
          expect(outcome?.kind, `${unit} route`).toBe("unsupported");
          if (outcome?.kind === "unsupported") expect(outcome.stage, `${unit} stage`).toBe("select");
        }
        expect(outcomes.some((o) => o.kind === "unsupported" && /unknown class/.test(o.detail))).toBe(false);
        const expected = evaluateAsJs(source).test!();
        expect(exports.test!()).toBe(expected);
      });
    }
  }
});
