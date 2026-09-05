// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616-adjacent (jest-docblock) — a NAMED import from a node builtin is a
// MEMBER of the module object, not the module itself. `import { EOL } from
// 'os'` bound the local name to the `__node_os` module thunk, so `EOL`
// string-concatenated as "[object Object]" and every EOL-based jest-docblock
// parse mismatched (21/39 → 39/39 with the member read).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compile, compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

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

  it("imports isNativeError from node:util/types (jest-util isError)", async () => {
    // The suite path: compileProject routes named node-builtin imports
    // through the collector → `__node_util/types` module thunk + member read.
    // (Single-file compile() takes the legacy direct-named-import lane and is
    // not the shape jest-util exercises.)
    const dir = mkdtempSync(join(tmpdir(), "j2w-4616-"));
    try {
      const dep = join(dir, "iserr.ts");
      const main = join(dir, "main.ts");
      writeFileSync(
        dep,
        `import {isNativeError} from 'node:util/types';
         export const isError = typeof (Error as { isError?: unknown }).isError === 'function'
           ? (Error as { isError: (v: unknown) => boolean }).isError : isNativeError;`,
      );
      writeFileSync(
        main,
        `import {isError} from './iserr.ts';
         export function t(): string {
           return String(isError(new Error())) + ":" + String(isError({ message: "f" }));
         }`,
      );
      const r = await compileProject(main, {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "web",
        experimentalIR: true,
        emitWat: false,
        deferTopLevelInit: true,
      });
      expect(r.success).toBe(true);
      const imports = buildCompiledImports(r as Parameters<typeof buildCompiledImports>[0]);
      const { instance } = await WebAssembly.instantiate(r.binary!, imports as WebAssembly.Imports);
      (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
      (instance.exports as { __module_init?: () => void }).__module_init?.();
      const exp = wrapExports(instance.exports as WebAssembly.Exports) as { t: () => string };
      expect(exp.t()).toBe("true:false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
