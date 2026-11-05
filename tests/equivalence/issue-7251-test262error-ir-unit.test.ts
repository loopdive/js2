// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7251 — the harness `Test262Error` unit (test262 `harness/sta.js`, verbatim
// below) as an IR unit when a top-level caller passes only string literals.
//
// Such a caller (`isConstructor.js`'s `throw new Test262Error("…")`) narrows
// the IR call-site lattice for `message` to `string`, while legacy's own
// call-site inference sees an opaque caller and registers `externref`. The
// IR's implicit-parameter projection — the shared selector/resolver mirror of
// legacy's ABI — did not consider a `||` operand, so both IR sides fell back
// to the lattice's `string`, and `message || ""` was refused
// (`expr-logical-value-family`). The projection now covers `||`/`&&`
// operands, answers legacy's `externref`, and the unit lowers like the
// default (dynamic-param) harness case.
//
// Each case asserts the route on standalone and the default gc target and
// the result on all three lanes against the JS evaluation of the same source
// (or, on WASI, the pinned value base and head both give where WASI already
// diverges from JS).
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions; ir: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, ir: true },
  { name: "wasi", options: { target: "wasi" }, ir: false },
  { name: "gc (default)", options: {}, ir: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

const STA = `
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}

Test262Error.prototype.toString = function () {
  return "Test262Error: " + this.message;
};

Test262Error.thrower = function (message) {
  throw new Test262Error(message);
};
`;

/** The only top-level caller passes a string literal: the lattice says `string`. */
const LITERAL_CALLER = `function fail() { throw new Test262Error("lit"); }\n`;

/** Folds `inner()`'s string into a number so every lane compares one value. */
const HASHED_TEST = `
export function test() { var s = inner(); var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h + s.length * 1000003; }`;

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7251.js", trackIrOutcomes: true, ...options });
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
  /** Units whose IR body must be emitted on standalone and gc. */
  readonly irUnits: readonly string[];
  /** WASI already diverges from JS here; the value (or trap) base and head both give. */
  readonly wasiValue?: number | "throws";
}

const CASES: Record<string, Case> = {
  "throw caught: instanceof, .message, String(e), .constructor": {
    source:
      STA +
      LITERAL_CALLER +
      `function inner() { try { fail(); return "no"; } catch (e) { return (e instanceof Test262Error) + "|" + e.message + "|" + String(e) + "|" + (e.constructor === Test262Error); } }`,
    irUnits: ["Test262Error"],
    wasiValue: 30791622,
  },
  "Test262Error(m) without new": {
    source:
      STA +
      LITERAL_CALLER +
      `function mk() { return Test262Error("nn"); }
function inner() { var e = mk(); return (e instanceof Test262Error) + "|" + e.message + "|" + e.toString(); }`,
    irUnits: ["Test262Error"],
    wasiValue: 23070926,
  },
  "Test262Error.thrower": {
    source:
      STA +
      LITERAL_CALLER +
      `function inner() { try { Test262Error.thrower("t"); return "no"; } catch (e) { return (e instanceof Test262Error) + "|" + e.message; } }`,
    irUnits: ["Test262Error"],
  },
  "message undefined / null / number": {
    source:
      STA +
      LITERAL_CALLER +
      `var a = new Test262Error(); var b = new Test262Error(null); var c = new Test262Error(7); var d = Test262Error(0);
function inner() { return JSON.stringify([a.message, b.message, c.message, d.message]) + "|" + String(c); }`,
    irUnits: ["Test262Error"],
    wasiValue: 28919330,
  },
  "assert.throws-shaped constructor check": {
    source:
      STA +
      LITERAL_CALLER +
      `function throws(C, f) { try { f(); } catch (e) { return e.constructor === C ? "ok" : "wrongctor"; } return "nothrow"; }
function inner() { return throws(Test262Error, fail) + "|" + throws(TypeError, fail); }`,
    irUnits: ["Test262Error"],
    wasiValue: 19040817,
  },
  "prototype chain and own message": {
    source:
      STA +
      LITERAL_CALLER +
      `function inner() { var e = new Test262Error("p"); return Object.prototype.hasOwnProperty.call(e, "message") + "|" + (Object.getPrototypeOf(e) === Test262Error.prototype) + "|" + typeof Test262Error.prototype.toString; }`,
    irUnits: ["Test262Error"],
    wasiValue: "throws",
  },
  "string || on a plain function (call sites agree: string ABI, unchanged)": {
    source: `function pick(s) { return s || "none"; }
function g() { return pick("x") + pick(""); }
function inner() { return g(); }`,
    irUnits: [],
    wasiValue: NaN,
  },
  "string && on a plain function (call sites agree: string ABI, unchanged)": {
    source: `function both(s) { return s && "yes"; }
function g() { return both("x") + "|" + both(""); }
function inner() { return g(); }`,
    irUnits: [],
  },
  "|| on a plain function with mixed callers": {
    source: `function pick(s) { return s || "none"; }
function g() { return pick("x") + pick(0) + pick(5); }
function inner() { return g(); }`,
    irUnits: [],
    wasiValue: NaN,
  },
};

describe("#7251 harness Test262Error as an IR unit", () => {
  for (const [title, c] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${title} [${lane.name}]`, async () => {
        const source = c.source + HASHED_TEST;
        const { result, exports } = await compileAndRun(source, lane.options);
        const wasi = lane.options.target === "wasi";
        const outcomes = result.irOutcomes ?? [];
        if (lane.ir) {
          for (const unit of c.irUnits) {
            const outcome = outcomes.find((o) => o.displayName === unit);
            expect(outcome?.irBodyEmitted, `${unit} route: ${JSON.stringify(outcome)}`).toBe(true);
          }
        }
        if (wasi && c.wasiValue === "throws") {
          expect(() => exports.test!()).toThrow();
          return;
        }
        const expected = wasi && c.wasiValue !== undefined ? c.wasiValue : evaluateAsJs(source).test!();
        expect(exports.test!()).toBe(expected);
      });
    }
  }
});
