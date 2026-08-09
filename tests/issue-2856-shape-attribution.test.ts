// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2856 Step 0 — first-wins attribution for Phase-1 helper rejections.

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

const SOURCE = `
function objectSpread(value: { n: number }): { n: number } {
  return { ...value };
}

function tryBinding(value: number): number {
  try {
    throw value;
  } catch ({ message }) {
  }
  return value;
}

function closureParam(value: number): number {
  const inner = (next?: number): number => 0;
  return value;
}

function forInitializer(limit: number): number {
  for (var i = 0; i < limit; i++) {}
  return limit;
}

function updFoot(): boolean {
  return selStart > 0;
}

function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    resolve(value);
  });
}
`;

async function plan(shapeDiag: boolean) {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  if (shapeDiag) process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  else Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  vi.resetModules();
  try {
    const { planIrCompilation } = await import("../src/ir/select.js");
    const sourceFile = ts.createSourceFile("issue-2856-step0.ts", SOURCE, ts.ScriptTarget.ES2022, true);
    return planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
    else process.env.JS2WASM_IR_SHAPE_DIAG = previous;
    vi.resetModules();
  }
}

describe("#2856 Step 0 reject-arm attribution", () => {
  it("records stable subchecks for every helper and both corpus leaf shapes", async () => {
    const selection = await plan(true);
    const details = new Map((selection.fallbacks ?? []).map((fallback) => [fallback.name, fallback.detail]));

    expect(details.get("objectSpread")).toBe("objectlit-spread:SpreadAssignment");
    expect(details.get("tryBinding")).toBe("try-catch-binding:ObjectBindingPattern");
    expect(details.get("closureParam")).toBe("closure-param-shape:Parameter");
    expect(details.get("forInitializer")).toBe("for-init-var-kind:VariableDeclarationList");
    expect(details.get("updFoot")).toBe("expr-ident-not-in-scope:Identifier");
    expect(details.get("delay")).toBe("expr-new-type-args:NewExpression");
  });

  it("keeps diagnostic detail absent when the opt-in flag is unset", async () => {
    const selection = await plan(false);
    for (const fallback of selection.fallbacks ?? []) expect(fallback.detail).toBeUndefined();
  });
});
