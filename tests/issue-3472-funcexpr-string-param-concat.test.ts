// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3472 — function-EXPRESSION / closure param used as a string in the native
 * compound `+=` fast path produced INVALID Wasm under `--target standalone`.
 *
 * A closure param is physically an `externref` slot (closure calling
 * convention). When its static type flow-narrows to `string` (e.g.
 * `m = ''; m += 'x'`), the native-string compound-assign path
 * (`compileNativeStringCompoundAssignment` in `expressions/operator-assignment.ts`)
 * loaded the current value with a bare `local.get` and fed the resulting
 * `externref` straight into `__str_concat`, whose arg[0] is `(ref null
 * $AnyString)` → `call[0] expected type (ref null $AnyString), found externref`.
 *
 * This is exactly the shape of the test262 `assert` harness message build
 * (`assert.sameValue = function (a, b, message) { if (message === undefined)
 * { message = ''; } else { message += ' '; } message += 'Expected...'; }`), so
 * it blocked the #3468 closure-own-property routing from being net-positive:
 * once the harness actually stored+invoked `assert.sameValue`, its body hit
 * this pre-existing bug and failed to instantiate.
 *
 * Fix: coerce an externref-physical LHS local to `$AnyString`
 * (`any.convert_extern` + `ref.cast $AnyString`) on the load, mirroring the
 * existing RHS externref arm. gc/host is byte-identical (the path is inside the
 * `ctx.nativeStrings` branch, which is off for gc/host).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-3472.ts",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const fn = (instance.exports.test ?? instance.exports.main) as (...a: unknown[]) => unknown;
  return fn();
}

describe("#3472 funcexpr/closure string-param native compound += ", () => {
  it("compiles to VALID Wasm (was: call[0] expected $AnyString, found externref)", async () => {
    // Harness message-build shape on a function EXPRESSION.
    const v = await run(`
      const f = function (m) {
        if (m === undefined) { m = ''; } else { m += ' '; }
        m += 'x';
        return m;
      };
      export function test(): number { return f('a') === 'a x' ? 1 : 0; }
    `);
    expect(v).toBe(1);
  });

  it("undefined branch: message defaults to '' then concatenates", async () => {
    const v = await run(`
      const f = function (m) {
        if (m === undefined) { m = ''; } else { m += ' '; }
        m += 'x';
        return m;
      };
      export function test(): number { return f(undefined) === 'x' ? 1 : 0; }
    `);
    expect(v).toBe(1);
  });

  it("minimal: string-literal reassign then compound += on a closure param", async () => {
    const v = await run(`
      const f = function (m) { m = ''; m += 'x'; return m; };
      export function test(): number { return f('a') === 'x' ? 1 : 0; }
    `);
    expect(v).toBe(1);
  });
});
