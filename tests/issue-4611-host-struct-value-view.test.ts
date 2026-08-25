// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4611 — a non-callable WasmGC struct stored onto a PLAIN HOST object must be
// readable by native JS. The driver of acorn's official suite reads
// `comment.loc.start.line` with plain property access (no _safeGet in the
// path), so a raw struct stored by `__extern_set(_strict)` marshalled as `{}`
// and the whole locations family compared `undefined !== {line, column}`.
// The set bindings now store the `_wrapForHost` proxy view for struct values
// landing on plain host objects (closures and wasm-struct receivers excluded).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4611 host-object struct-value proxy view", () => {
  it("native reads see fields of a struct stored on a plain host object", async () => {
    const result = await compile(
      `var Loc = function Loc(a, b) { this.a = a; this.b = b; };
       export function attach(host: any): number {
         host.loc = new Loc(1, 2);
         return 1;
       }`,
      { testRuntime: true, fileName: "issue-4611-view.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      attach: (host: object) => number;
    };
    const host: Record<string, { a?: number; b?: number } | undefined> = {};
    exp.attach(host);
    expect(host.loc?.a).toBe(1);
    expect(host.loc?.b).toBe(2);
  });
});
