// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7254 — `body-exprstmt-other` names the refusal it hides.
//
// An expression statement no statement arm admits is re-tested as a discarded
// VALUE (#4459). That probe restores the diagnostics when it declines, so the
// row read `body-exprstmt-other` whatever the value walker refused. Under
// `JS2WASM_IR_SHAPE_DIAG=1` the catch-all label now carries the declined
// probe's first-refusal arm: `body-exprstmt-other(expr-binary-op-in)`.
//
// Pinned here: the qualified labels for the shapes the 2026-11-05 stride census
// found (IIFE, `in` on a primitive, `delete`, `new` of an unknown constructor),
// and that the change is diagnostics-only — same claim outcome, same binary,
// with and without the variable.

import { afterEach, describe, expect, it, vi } from "vitest";

const statements = [
  "(function () { counter = counter + 1; }());",
  '"toString" in true;',
  "delete holder.p;",
  "new Unknown(1);",
];

function sourceFor(statement: string): string {
  return [
    "var counter = 0;",
    "var holder = { p: 1 };",
    "function Unknown(v) { this.v = v; }",
    `try { ${statement} } catch (e) { counter = -1; }`,
    "",
  ].join("\n");
}

interface Outcome {
  readonly displayName: string;
  readonly kind: string;
  readonly code?: string;
  readonly detail?: string;
  readonly irBodyEmitted?: boolean;
}

async function compileWith(source: string, diag: boolean) {
  const saved = { ...process.env };
  const { JS2WASM_IR_SHAPE_DIAG: _ignored, ...rest } = saved;
  process.env = diag ? { ...rest, JS2WASM_IR_SHAPE_DIAG: "1" } : rest;
  vi.resetModules();
  try {
    const { compile } = await import("../src/index.js");
    const result = await compile(source, {
      fileName: "t.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
      scriptGoal: true,
      deferTopLevelInit: true,
      trackIrOutcomes: true,
    } as never);
    const outcomes = ((result as { irOutcomes?: Outcome[] }).irOutcomes ?? []).map((o) => ({
      displayName: o.displayName,
      kind: o.kind,
      code: o.code,
      irBodyEmitted: o.irBodyEmitted,
      detail: o.detail,
    }));
    return { success: result.success, binary: result.binary, outcomes };
  } finally {
    process.env = saved;
  }
}

function exprStatementLabels(outcomes: readonly Outcome[]): string[] {
  return outcomes.flatMap((o) => (o.detail ?? "").match(/(?:body|nontail)-[\w-]+(?:\([\w-]+\))?/g) ?? []);
}

describe("#7254 expression-statement catch-all names the declined value refusal", () => {
  afterEach(() => vi.resetModules());

  it.each([
    [statements[0]!, "body-exprstmt-other(expr-call-callee-nonident)"],
    [statements[1]!, "body-exprstmt-other(expr-binary-op-in)"],
    [statements[2]!, "body-exprstmt-other(expr-delete-no-ir-lowering)"],
  ])(
    "`%s` → %s",
    async (statement, label) => {
      const { outcomes } = await compileWith(sourceFor(statement), true);
      expect(exprStatementLabels(outcomes)).toContain(label);
    },
    120_000,
  );

  it("is diagnostics-only: claim outcomes and binary are identical without SHAPE_DIAG", async () => {
    for (const statement of statements) {
      const source = sourceFor(statement);
      const diag = await compileWith(source, true);
      const plain = await compileWith(source, false);
      expect(diag.success).toBe(plain.success);
      const strip = (os: readonly Outcome[]) => os.map(({ detail: _detail, ...rest }) => rest);
      expect(strip(diag.outcomes)).toEqual(strip(plain.outcomes));
      expect(Buffer.from(diag.binary ?? []).equals(Buffer.from(plain.binary ?? []))).toBe(true);
    }
  }, 240_000);
});
