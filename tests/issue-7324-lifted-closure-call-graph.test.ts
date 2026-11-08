// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7324 — calls inside a lifted closure pass the same call-graph gate as the
// enclosing unit's own calls, for the module-init and ordinary functions alike.
// A variable, an ambient function or an unclaimed function declaration called
// from the closure has no direct-call plan, so selection refuses the unit
// instead of claiming it and letting from-ast withdraw it. A claimed function
// declaration, a call through the closure's own parameter and (#7287) a
// statement call through an uninitialized script `var` keep the IR route.
// On main each refused case was claimed and then withdrawn by from-ast ("no
// exact AST-site plan"), so the selection-refusal assertion is what tells the
// two apart; runtime values are covered by the test262 A/B (the routes are
// legacy on both sides).
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// The test262 `assert.throws` shape, minus what the IR refuses on its own.
const HARNESS = `function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } };
`;

interface Case {
  readonly source: string;
  /** The unit whose closure makes the call. */
  readonly unit: string;
  readonly fileName: string;
}

const moduleInitCase = (body: string): Case => ({
  source: HARNESS + body,
  unit: "<module-init>",
  fileName: "issue-7324.js",
});
const functionCase = (source: string): Case => ({ source, unit: "t", fileName: "issue-7324.ts" });

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

const REFUSED: Record<string, Case> = {
  "module-init: var holding a number": moduleInitCase(
    `var getter = 3; assert.throws(TypeError, function () { getter(); });`,
  ),
  "module-init: let holding a number": moduleInitCase(
    `let getter = 3; assert.throws(TypeError, function () { getter(); });`,
  ),
  "module-init: an ambient function": moduleInitCase(`assert.throws(SyntaxError, function () { RegExp("(?-m:a)"); });`),
  "module-init: an unclaimed function declaration": moduleInitCase(`function f({ w: { x } = undefined }) {}
assert.throws(TypeError, function () { f(); });`),
  "function: an unclaimed function declaration": functionCase(
    `function f(o: any): number { const { w: { x } = {} as any } = o; return 1; }
function t(x: number): number { const c = (y: number): number => f(y); return c(x); }
t(1);`,
  ),
  "function: an ambient function": functionCase(
    `function t(x: number): number { const c = (y: number): number => { RegExp("a"); return y; }; return c(x); }
t(1);`,
  ),
};

const CLAIMED: Record<string, Case> = {
  "module-init: a claimed function declaration": moduleInitCase(`function getter() { return 1; }
assert.throws(TypeError, function () { getter(); });`),
  "module-init: the closure's own parameter": moduleInitCase(`assert.throws(TypeError, function (g) { if (g) g(); });`),
  // (#7287) An uninitialized script `var` lives in its dynamic module home, and
  // a statement call through it lowers as the dynamic call (IsCallable, then a
  // catchable TypeError), so the closure has a plan for it.
  "module-init: an uninitialized script var": moduleInitCase(
    `var getter; assert.throws(TypeError, function () { getter(); });`,
  ),
  "function: a claimed function declaration": functionCase(
    `function g(y: number): number { return y + 1; }
function t(x: number): number { const c = (y: number): number => g(y); return c(x); }
t(1);`,
  ),
};

async function unitOutcome(testCase: Case, options: CompileOptions) {
  const result = await compile(testCase.source, {
    fileName: testCase.fileName,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result.irOutcomes?.find((o) => o.displayName === testCase.unit);
}

describe("#7324 calls inside a lifted closure", () => {
  for (const [label, testCase] of Object.entries(REFUSED)) {
    for (const lane of LANES) {
      it(`${label}: refused at selection (${lane.name})`, async () => {
        const unit = await unitOutcome(testCase, lane.options);
        expect(unit?.irBodyEmitted).toBe(false);
        expect(unit?.detail).toContain("rejected by IR selection");
      });
    }
  }
  for (const [label, testCase] of Object.entries(CLAIMED)) {
    for (const lane of LANES) {
      it(`${label}: keeps the IR route (${lane.name})`, async () => {
        const unit = await unitOutcome(testCase, lane.options);
        expect(unit?.irBodyEmitted, unit?.detail).toBe(true);
      });
    }
  }
});

// (#7287) The claimed closure's dynamic call throws a TypeError a caller
// catches: a harness that accepts only that error completes on every lane.
describe("#7324 × #7287 an uninitialized script var called from a lifted closure", () => {
  const source = `function assert(v) {}
assert.typeError = function (f) { try { f(); } catch (e) { if (e instanceof TypeError) return; throw "wrong error"; } throw "no throw"; };
var getter;
assert.typeError(function () { getter(); });
`;
  const wasiStub = new Proxy({}, { get: () => () => 0 });
  for (const lane of [...LANES, { name: "wasi", options: { target: "wasi" } as CompileOptions }]) {
    it(`claims and throws a catchable TypeError (${lane.name})`, async () => {
      const result = await compile(source, {
        fileName: "issue-7324.js",
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
        ...lane.options,
      });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.irOutcomes?.find((o) => o.displayName === "<module-init>")?.irBodyEmitted).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const instance =
        lane.options.target === "standalone"
          ? (await WebAssembly.instantiate(result.binary, {})).instance
          : lane.options.target === "wasi"
            ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
            : await instantiateWithRuntime(result);
      const exports = instance.exports as Record<string, () => unknown>;
      expect(() => (exports.__module_init ?? exports._start)?.()).not.toThrow();
    });
  }
});
