// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (cookie parseCookie tests) — `{ "": "bar" }` is a legal JS literal,
// but the struct lowering made "" a FIELD NAME and the field-name plumbing
// (`__struct_field_names` comma join, `__sget_<name>` exports) degenerates on
// it: the property silently vanished (Object.keys [], in-module read
// undefined). Empty-string keys now route the literal to the host
// plain-object path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4616 empty-string object keys", () => {
  it("keeps the property observable in and out of module", async () => {
    const result = await compile(
      `export function t(): string {
         const o: any = { "": "bar", x: 1 };
         const keys = Object.keys(o);
         return JSON.stringify(o) + "|n=" + String(keys.length) + "|v=" + String(o[""]);
       }`,
      { testRuntime: true, fileName: "issue-4616-ek.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      t: () => string;
    };
    expect(exp.t()).toBe('{"":"bar","x":1}|n=2|v=bar');
  });
});
