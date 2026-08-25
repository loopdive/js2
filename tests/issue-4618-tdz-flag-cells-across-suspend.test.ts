// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: TDZ flags were per-invocation resume-fn LOCALS — the resume function
// returns at every suspend and re-enters with zeroed locals, so a flag
// flipped by a declaration in state k read 0 again in state k+1. A hoisted
// fn-decl capturing the binding then threw "X is not defined" from its boxed
// flag param even though the declaration had run (react's
// `const {Fragment} = React` + ParentComponent + await act shape). Flagged
// spilled bindings now persist their TDZ state in i32 ref-cell frame fields:
// the entry creates each cell (0 = uninitialized) and the resume prologue
// re-binds it into boxedTdzFlags/tdzFlagLocals, so inits, checks and the
// call-site flag prepend all flow through one suspend-surviving cell.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-tdz-cells.ts",
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

describe("#4618 TDZ flags survive async suspends", () => {
  it("a destructured symbol read directly and via a hoisted fn-decl after await", async () => {
    const exp = await run(`
      const REACT_FRAGMENT_TYPE = Symbol.for("react.fragment");
      var exports_obj: any = {};
      exports_obj.Fragment = REACT_FRAGMENT_TYPE;
      const NS: any = exports_obj;
      async function act(cb: any): Promise<any> { return await cb(); }
      export async function t(): Promise<string> {
        const {Fragment} = NS;
        function Parent(): any { return Fragment; }
        await act(() => 1);
        return typeof Fragment + "," + String(Fragment === NS.Fragment) +
          ",viaFn=" + typeof Parent() + "," + String(Parent() === NS.Fragment);
      }`);
    expect(await exp.t!()).toBe("symbol,true,viaFn=symbol,true");
  });
});
