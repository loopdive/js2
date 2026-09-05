// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: a destructured binding whose slot is a BOXED ref cell (a spilled
// async-frame binding captured by a closure — react's `const {Fragment} =
// React` in a suspending it-body) stored its extracted value with a plain
// local.set into the CELL-typed slot: the coercion cast the VALUE to the cell
// type (guaranteed trap on a symbol), and even where it validated, the cell
// was never written so captures read the default (null) — the closure
// observed `n` as null after `let {n} = o` plus a post-await mutation. The
// externref destructure lane now redirects the element's stores to a scratch
// local and flushes it THROUGH the cell (the #3396/#1177 boxedForInitStore
// convention).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-boxed-destructure.ts",
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

describe("#4618 destructured bindings into boxed async-frame cells", () => {
  it("closure sees the destructured value and post-await mutations through the cell", async () => {
    const exp = await run(`
      var exports_obj: any = {};
      exports_obj.Fragment = Symbol.for("react.fragment");
      exports_obj.n = 5;
      const NS: any = exports_obj;
      async function act(cb: any): Promise<any> { return await cb(); }
      export async function t(): Promise<string> {
        let {Fragment, n} = NS;
        const read = () => typeof Fragment + ":" + String(n);
        await act(() => { n = n + 1; });
        return read() + "," + typeof Fragment + "," + String(Fragment === NS.Fragment);
      }`);
    expect(await exp.t!()).toBe("symbol:6,symbol,true");
  });
});
