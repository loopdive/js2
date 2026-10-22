// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7124 — opt-in unmasked module-init census.
//
// The module-init assessment stops at the FIRST rejected top-level statement,
// so a statement every test262 file shares (the harness) hides each test's own
// blockers. `JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1` (on top of
// `JS2WASM_IR_SHAPE_DIAG=1`) records every rejected statement instead. Pinned
// here: the detail lists all of them in source order, and the claim outcome
// (reason code, IR body emitted or not) is identical with and without it.

import { afterEach, describe, expect, it, vi } from "vitest";

const SOURCE = [
  "var obj = {};",
  'Object.defineProperty(obj, "p", { value: 1 });',
  "var g = function () { return 1; };",
  "g();",
  "",
].join("\n");

async function moduleInitOutcome(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  vi.resetModules();
  try {
    const { compile } = await import("../src/index.js");
    const result = await compile(SOURCE, {
      fileName: "t.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      scriptGoal: true,
      deferTopLevelInit: true,
      trackIrOutcomes: true,
    } as never);
    expect(result.success).toBe(true);
    const outcome = (result as { irOutcomes?: { displayName: string }[] }).irOutcomes?.find(
      (entry) => entry.displayName === "<module-init>",
    ) as { code?: string; detail?: string; irBodyEmitted?: boolean } | undefined;
    expect(outcome).toBeDefined();
    return outcome!;
  } finally {
    process.env = saved;
  }
}

describe("#7124 unmasked module-init census", () => {
  afterEach(() => vi.resetModules());

  it("records every rejected top-level statement in source order", async () => {
    const outcome = await moduleInitOutcome({
      JS2WASM_IR_SHAPE_DIAG: "1",
      JS2WASM_IR_MODULE_INIT_ALL_REJECTS: "1",
    });
    const labels = outcome.detail!.split(" | ").map((label) => label.split(":")[0]);
    // Since #6835 (#7114) a script `var` is admitted as module storage, so the
    // two declarations now reject on their own shapes: the `{}` initializer has
    // no representable module slot, and a function-expression initializer is a
    // closure binding.
    expect(labels).toEqual([
      "body-shape-rejected@vardecl-module-storage-unrepresentable",
      "call-resolution-unsupported@expr-object-define-property-target",
      "body-shape-rejected@vardecl-let-closure",
      "call-resolution-unsupported@expr-local-call-target",
    ]);
  }, 120_000);

  it("leaves the claim outcome unchanged", async () => {
    const census = await moduleInitOutcome({
      JS2WASM_IR_SHAPE_DIAG: "1",
      JS2WASM_IR_MODULE_INIT_ALL_REJECTS: "1",
    });
    const plain = await moduleInitOutcome({
      JS2WASM_IR_SHAPE_DIAG: undefined,
      JS2WASM_IR_MODULE_INIT_ALL_REJECTS: undefined,
    });
    expect(census.code).toBe(plain.code);
    expect(census.irBodyEmitted).toBe(plain.irBodyEmitted);
    expect(plain.detail).not.toContain(" | ");
  }, 120_000);

  it("is inert without the shape-diagnostic switch", async () => {
    const outcome = await moduleInitOutcome({
      JS2WASM_IR_SHAPE_DIAG: undefined,
      JS2WASM_IR_MODULE_INIT_ALL_REJECTS: "1",
    });
    expect(outcome.detail ?? "").not.toContain(" | ");
  }, 120_000);
});
