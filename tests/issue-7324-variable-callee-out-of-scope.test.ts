// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7324 — a lifted module-init closure that calls a module VARIABLE has no
// binding for it and no direct-call plan, so selection refuses the unit instead
// of claiming it and letting from-ast withdraw it. A function declaration
// callee keeps its direct-call plan and its IR route.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const HARNESS = `function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } throw new Error("no throw"); };
`;

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

const REFUSED: Record<string, string> = {
  "var holding a number": `var getter = 3;`,
  "let holding a number": `let getter = 3;`,
  "uninitialized var": `var getter;`,
  "var holding a call result": `var getter = parseInt("3");`,
};

async function compileCase(decl: string, options: CompileOptions) {
  const source = `${HARNESS}${decl}\nassert.throws(TypeError, function () { getter(); });`;
  const result = await compile(source, {
    fileName: "issue-7324.js",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

async function completes(result: Awaited<ReturnType<typeof compile>>, options: CompileOptions) {
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : await instantiateWithRuntime(result);
    (instance.exports as Record<string, () => unknown>).__module_init?.();
    return true;
  } catch {
    return false;
  }
}

function moduleInit(result: Awaited<ReturnType<typeof compile>>) {
  return result.irOutcomes?.find((o) => o.displayName === "<module-init>");
}

describe("#7324 out-of-scope variable callee in a lifted closure", () => {
  for (const [label, decl] of Object.entries(REFUSED)) {
    for (const lane of LANES) {
      it(`${label}: refused at selection, still throws TypeError (${lane.name})`, async () => {
        const result = await compileCase(decl, lane.options);
        const unit = moduleInit(result);
        expect(unit?.irBodyEmitted).toBe(false);
        expect(unit?.detail).toContain("rejected by IR selection");
        expect(await completes(result, lane.options)).toBe(true);
      });
    }
  }
  it("a function declaration callee keeps its direct-call plan (standalone)", async () => {
    const result = await compileCase(`function getter() { return 1; }`, { target: "standalone" });
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
  });
});
