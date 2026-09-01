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
          const { value: nextValue, done: nextDone } = nextIt.next();

          const returnIt: any = returnGen();
          returnIt.next();
          const returned: any = returnIt.return(9);

          const throwIt: any = throwGen();
          throwIt.next();
          let caught = 0;
          try { throwIt.throw(new Error("forced opaque dispatch")); } catch (_) { caught = 1; }

          return unrelatedTopLevelCall + nextValue + (nextDone ? 100 : 0) + (returned.done ? 10 : 0) + caught;
        }
      `),
    ).toBe(14);
  });

  it("routes opaque chunks and windows .next() calls to the native iterator helper", async () => {
    expect(
      await runHostFree(`
        export function test(): number {
          const chunkSource: any = (function* () { yield 1; yield 2; yield 3; })();
          const windowSource: any = (function* () { yield 1; yield 2; yield 3; })();
          const chunks: any = chunkSource.chunks(2);
          const windows: any = windowSource.windows(2);

          const c1 = chunks.next();
          const c2 = chunks.next();
          const c3 = chunks.next();
          const w1 = windows.next();
          const w2 = windows.next();
          const w3 = windows.next();

          return (c1.done ? 1 : 0) + (c2.done ? 1 : 0) + (c3.done ? 1 : 0) +
            (w1.done ? 1 : 0) + (w2.done ? 1 : 0) + (w3.done ? 1 : 0);
        }
      `),
    ).toBe(2);
  });
});
