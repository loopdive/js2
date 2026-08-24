// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: `annexBReadEscapesFunctionScope`'s intervening-scope walk did not
// count a block-level FUNCTION DECLARATION as a lexical binding of its block
// (§14.2.3), so a read inside `try { function ParentComponent(){…} … PC … }`
// was condemned by a SAME-NAMED Annex B site in a DIFFERENT sibling function
// — react's tests re-declare ParentComponent/ComponentRendering* per test —
// and threw "X is not defined" for a perfectly bound read (all copies threw,
// even the first). The walk now counts sibling block-level fn-decls.
// react upstream: 81 → 85/146 on this one fix.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-annexb-sibling.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

describe("#4618 same-named block fn-decls across sibling functions", () => {
  it("each sibling's arrow resolves its OWN block fn-decl (no ReferenceError)", async () => {
    const exp = await run(`
      async function act(cb: any): Promise<any> { return await cb(); }
      export async function t_one(): Promise<any> {
        try {
          const marker = "one";
          function ParentComponent(u: any): string { return marker + ":" + String(u); }
          await act(() => { (globalThis as any).__pa4618 = ParentComponent(1); });
          return 1;
        } catch (e) { return "ERR1:" + String(e).slice(0, 60); }
      }
      export async function t_two(): Promise<any> {
        try {
          const marker = "two";
          function ParentComponent(u: any): string { return marker + ":" + String(u); }
          await act(() => { (globalThis as any).__pb4618 = ParentComponent(2); });
          return 1;
        } catch (e) { return "ERR2:" + String(e).slice(0, 60); }
      }
      export function read(): string {
        const g: any = globalThis;
        return String(g.__pa4618) + " | " + String(g.__pb4618);
      }`);
    expect(await exp.t_one!()).toBe(1);
    expect(await exp.t_two!()).toBe(1);
    await new Promise((res) => setTimeout(res, 30));
    expect((exp.read as () => string)()).toBe("one:1 | two:2");
  });
});
