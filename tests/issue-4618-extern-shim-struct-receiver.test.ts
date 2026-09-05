// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: the any-receiver first-match extern binding (tryExternClassMethodOnAny)
// can route a WasmGC-STRUCT receiver into the generic `<Class>_<method>` host
// shim under a colliding ambient method name — `el.type()` on a struct with a
// closure-valued `type` field bound `env.CSSNumericValue_type`. The shim only
// read `self[m] ?? sidecar`, both blind to struct FIELDS, so the call silently
// answered undefined. It now resolves through the same struct-aware field
// reader __extern_method_call uses (and wraps a raw closure struct) before
// giving up.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4618-extern-shim.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4618 struct receiver through a name-collided extern method binding", () => {
  it("el.type() reads the struct's closure field instead of answering undefined", async () => {
    const exp = await run(`
      const React: any = { createElement: (type: any) => ({ type }) };
      function Inner(): string { return "top-ok"; }
      export function t(): string {
        const el = React.createElement(Inner);
        const f: any = el.type;
        return String(el.type()) + "," + String(f());
      }`);
    expect(exp.t!()).toBe("top-ok,top-ok");
  });
});
