// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3591 — late-fill opaque native-generator resume dispatch (standalone).
 *
 * A module-scope generator function expression is constructed during module
 * init.  A distinct, unrelated top-level call keeps the real module-init pass
 * 2 enabled; that pass recreates the closure/state type after the exported
 * consumer body has already compiled.  The consumer must therefore not retain
 * the pass-1 state type in its opaque `.next()` / `.return()` / `.throw()`
 * dispatch ladder.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runHostFree(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-3591.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  if (!result.success) return Number.NaN;

  const envImports = result.imports.filter((entry) => entry.module === "env").map((entry) => entry.name);
  expect(envImports, `unexpected env imports: ${envImports.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3591 — opaque generator resume dispatch late fill (standalone)", () => {
  it("keeps .next/.return/.throw correct after a real module-init pass 2", async () => {
    expect(
      await runHostFree(`
        function forceSecondModuleInitPass(): number { return 1; }
        const unrelatedTopLevelCall = forceSecondModuleInitPass();

        const nextGen = function* () { yield 2; yield 3; };
        const returnGen = function* () { yield 4; yield 5; };
        const throwGen = function* () { yield 6; yield 7; };

        export function test(): number {
          const nextIt: any = nextGen();
          const nextValue = nextIt.next().value as number;

          const returnIt: any = returnGen();
          returnIt.next();
          const returned: any = returnIt.return(9);

          const throwIt: any = throwGen();
          throwIt.next();
          let caught = 0;
          try { throwIt.throw(new Error("forced opaque dispatch")); } catch (_) { caught = 1; }

          return unrelatedTopLevelCall + nextValue + (returned.done ? 10 : 0) + caught;
        }
      `),
    ).toBe(14);
  });
});
