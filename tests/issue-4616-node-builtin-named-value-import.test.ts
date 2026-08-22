// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616-adjacent (jest-docblock) — a NAMED import from a node builtin is a
// MEMBER of the module object, not the module itself. `import { EOL } from
// 'os'` bound the local name to the `__node_os` module thunk, so `EOL`
// string-concatenated as "[object Object]" and every EOL-based jest-docblock
// parse mismatched (21/39 → 39/39 with the member read).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

describe("#4616 node-builtin named value imports", () => {
  it("reads os.EOL through the named import", async () => {
    const result = await compile(
      `import { EOL } from 'os';
       export function t(): string {
         return "eol=" + JSON.stringify(EOL);
       }`,
      { testRuntime: true, fileName: "issue-4616-eol.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
    (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: (result as { exportSignatures?: unknown }).exportSignatures }) as {
      t: () => string;
    };
    expect(exp.t()).toBe('eol="\\n"');
  });
});
