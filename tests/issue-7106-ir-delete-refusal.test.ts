// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the IR has no delete operation. Slice 11 (#1169n) admitted
// `delete <expr>` and lowered it to the operand's side effects plus a constant
// `true`, so a claimed function removed nothing and never threw. In strict
// code, `delete arr.length` must throw a TypeError (the property is
// non-configurable); the claimed body answered `true` instead. The selector now
// refuses every `delete` (`expr-delete-no-ir-lowering`), so such functions
// stay on the direct path, which throws like node.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

const SOURCE = `
  function deleteArrayLength(): number {
    const a = [1, 2];
    return delete (a as any).length ? 1 : 0;
  }
  function deleteLocalProperty(): number {
    const o = { p: 1 };
    return delete (o as any).p ? 1 : 0;
  }
  export function probe(): number {
    let n = 0;
    try {
      deleteArrayLength();
    } catch (e) {
      if (e instanceof TypeError) n += 1;
    }
    if (deleteLocalProperty() === 1) n += 2;
    return n;
  }
`;

async function compileProbe(target?: "standalone"): Promise<CompileResult> {
  const result = await compile(SOURCE, {
    ...(target ? { target } : {}),
    experimentalIR: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-7106-delete.ts",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function nodeProbe(): unknown {
  const js = ts.transpile(SOURCE, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

describe("#7106 — the selector keeps every delete on the direct path", () => {
  for (const lane of ["standalone", "gc"] as const) {
    it(`${lane}: refuses delete before claim and answers like node`, async () => {
      const result = await compileProbe(lane === "standalone" ? "standalone" : undefined);
      for (const name of ["deleteArrayLength", "deleteLocalProperty"]) {
        const row = (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
        expect(row, name).toMatchObject({ irBodyEmitted: false, stage: "select", code: "body-shape-rejected" });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      const got = (instance.exports.probe as () => number)();
      expect(got).toBe(nodeProbe());
      expect(got).toBe(3);
    });
  }
});
