// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4531 (AstPath headline): a class-field array (`this.stack = [value]`) was
// stored through the generic vec→externref coercion, which appends
// `__make_iterable` — the field then held a JS MIRROR while every native
// method/read lane `ref.cast`ed to the vec, so EVERY stack op in prettier's
// AstPath trapped `illegal cast` (getValue/call/callParent/each/map). Three
// coordinated fixes:
//   1. `compileCoercionRhs` (char-at-transfer.ts) raw-boxes an array-literal
//      RHS into an externref field (`extern.convert_any`, no mirror) — the
//      ctor-store twin of the #4611 member-set-dispatcher arm.
//   2. `compileArrayMethodCall`'s push/pop (array-methods.ts) emit a
//      #2784-style guarded dual-lane for an externref-shaped receiver
//      (`ref.test` vec carriers → native `__vec_push`/`__vec_pop`, else the
//      host bridge) instead of the unguarded native cast.
//   3. `_tryWasmVecMutation` (runtime.ts) resolves a registered
//      `__make_iterable` mirror back to its source vec (`vecForMirror`) and
//      mutates BOTH, so a push that does reach the host bridge is no longer a
//      silent no-op wiped by the next crossing's refresh.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";

async function runJs(source: string, fileName: string) {
  const result = await compile(source, { fileName, skipSemanticDiagnostics: true, allowJs: true });
  expect(result.success).toBe(true);
  const imports = buildCompiledImports(result as never, {}) as WebAssembly.Imports & {
    setInstance?: (i: WebAssembly.Instance) => void;
    __setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4531 class-field array keeps native identity across ops", () => {
  it("heterogeneous stack ops: at/push/read/scan/length-truncate", async () => {
    const exp = await runJs(
      `
      class P {
        constructor(value) { this.stack = [value]; }
        at1() { return this.stack.at(-1); }
        push2(a, b) { this.stack.push(a); this.stack.push(b); }
        len() { return this.stack.length; }
        read(i) { return this.stack[i]; }
        scan() {
          const { stack } = this;
          for (let i = stack.length - 1; i >= 0; i -= 2) {
            if (!Array.isArray(stack[i])) return stack[i];
          }
          return null;
        }
      }
      export function u2() { const p = new P({ x: 1 }); p.push2("k", { x: 9 }); return String(p.len()); }
      export function u4() { const p = new P({ x: 1 }); p.push2("k", { x: 9 }); const v = p.scan(); return String(v && v.x); }
      export function u6() {
        const ast = { property: { deep: 1 } };
        const p = new P(ast);
        p.push2("property", ast.property);
        const v = p.scan();
        return String(v === ast.property);
      }`,
      "issue-4531-stack-field.js",
    );
    expect(exp.u2!()).toBe("3");
    expect(exp.u4!()).toBe("9");
    expect(exp.u6!()).toBe("true");
  });

  it("prettier AstPath call/getValue shape round-trips with element identity", async () => {
    const exp = await runJs(
      `
      class AstPath {
        constructor(value) { this.stack = [value]; }
        getValue() {
          const { stack } = this;
          for (let i = stack.length - 1; i >= 0; i -= 2) {
            if (!Array.isArray(stack[i])) return stack[i];
          }
          return null;
        }
        call(callback, ...names) {
          const { stack } = this;
          const { length } = stack;
          let value = stack.at(-1);
          for (const name of names) {
            value = value?.[name];
            stack.push(name);
            stack.push(value);
          }
          try {
            return callback(this);
          } finally {
            stack.length = length;
          }
        }
      }
      export function t1() {
        const ast = { property: { deep: { name: "deep" } } };
        const path = new AstPath(ast);
        const r = path.call(() => path.getValue(), "property");
        return String(r === ast.property) + "|" + String(path.stack.length);
      }`,
      "issue-4531-astpath-call.js",
    );
    expect(exp.t1!()).toBe("true|1");
  });
});
