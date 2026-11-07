// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7324 — calls inside a lifted module-init closure pass the same call-graph
// gate as the module-init's own calls. A variable, an ambient function or an
// unclaimed function declaration called from the closure has no direct-call
// plan, so selection refuses the unit instead of claiming it and letting
// from-ast withdraw it. A claimed function declaration and a call through the
// closure's own parameter keep the IR route. On main each refused case was
// claimed and then withdrawn by from-ast ("no exact AST-site plan"), so the
// selection-refusal assertion is what tells the two apart; runtime values are
// covered by the test262 A/B (the routes are legacy on both sides).
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

// The test262 `assert.throws` shape, minus what the IR refuses on its own.
const HARNESS = `function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } };
`;

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

const REFUSED: Record<string, string> = {
  "var holding a number": `var getter = 3; assert.throws(TypeError, function () { getter(); });`,
  "let holding a number": `let getter = 3; assert.throws(TypeError, function () { getter(); });`,
  "uninitialized var": `var getter; assert.throws(TypeError, function () { getter(); });`,
  "an ambient function": `assert.throws(SyntaxError, function () { RegExp("(?-m:a)"); });`,
  "an unclaimed function declaration": `function f({ w: { x } = undefined }) {}
assert.throws(TypeError, function () { f(); });`,
};

const CLAIMED: Record<string, string> = {
  "a claimed function declaration": `function getter() { return 1; }
assert.throws(TypeError, function () { getter(); });`,
  "the closure's own parameter": `assert.throws(TypeError, function (g) { if (g) g(); });`,
};

async function compileCase(body: string, options: CompileOptions) {
  const result = await compile(HARNESS + body, {
    fileName: "issue-7324.js",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

function moduleInit(result: Awaited<ReturnType<typeof compile>>) {
  return result.irOutcomes?.find((o) => o.displayName === "<module-init>");
}

describe("#7324 calls inside a lifted module-init closure", () => {
  for (const [label, body] of Object.entries(REFUSED)) {
    for (const lane of LANES) {
      it(`${label}: refused at selection (${lane.name})`, async () => {
        const result = await compileCase(body, lane.options);
        const unit = moduleInit(result);
        expect(unit?.irBodyEmitted).toBe(false);
        expect(unit?.detail).toContain("rejected by IR selection");
      });
    }
  }
  for (const [label, body] of Object.entries(CLAIMED)) {
    it(`${label}: keeps the IR route (standalone)`, async () => {
      const result = await compileCase(body, { target: "standalone" });
      expect(moduleInit(result)?.irBodyEmitted, moduleInit(result)?.detail).toBe(true);
    });
  }
});
