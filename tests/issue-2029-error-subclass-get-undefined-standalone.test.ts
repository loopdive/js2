// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2029 — standalone Error-subclass instantiation leaked `env::__get_undefined`.
 *
 * The builtin-subclass EMIT crash (`u32 out of range: -1`) was fixed earlier
 * (PR-1, `emitSetSubclassProto` sentinel guard). But `class E extends Error {}`
 * still leaked the JS-host `__get_undefined` import under `--target standalone`,
 * so the module failed to instantiate with an empty import object
 * (`env: module is not an object or function`).
 *
 * Root cause: three `__get_undefined` emit sites called `ensureLateImport`
 * DIRECTLY (type-coercion.ts `emitUndefinedValue`, destructuring-params.ts
 * `emitBoundsCheckedArrayGetUndef`) and only fell back to `ref.null.extern` when
 * the helper returned `undefined`. But `ensureLateImport` does NOT refuse
 * `__get_undefined`, so standalone registered + leaked the import — the fallback
 * never fired. The canonical `ensureGetUndefined` guards on `ctx.nativeStrings`;
 * the direct sites now mirror that guard (undefined collapses to
 * `ref.null.extern` standalone, indistinguishable from null by design).
 *
 * Standalone modules are instantiated with an EMPTY import object so any leak
 * fails the test at instantiation.
 */

const ERROR_SUBCLASS_MODULE = `
  class MyError extends Error {}
  class MyTypeError extends TypeError {}
  class WithMsg extends Error { constructor() { super("boom"); } }
  export function plain(): number { const e = new MyError(); return e instanceof MyError ? 1 : 0; }
  export function typed(): number { const e = new MyTypeError(); return e instanceof MyTypeError ? 1 : 0; }
  export function withMsg(): number { const e = new WithMsg(); return e instanceof Error ? 1 : 0; }
`;

describe("#2029 Error-subclass standalone — no __get_undefined leak", () => {
  it("compiles + instantiates with no host imports (standalone)", async () => {
    const r = await compile(ERROR_SUBCLASS_MODULE, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    // The headline leak — plus a blanket no-env-import assertion for standalone.
    expect(
      labels.filter((l) => /^env::__get_undefined$/.test(l)),
      "leaked env::__get_undefined",
    ).toEqual([]);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `unexpected env:: imports: ${labels.join(", ")}`,
    ).toEqual([]);
    // Empty import object proves zero host dependency.
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.plain!()).toBe(1);
    expect(ex.typed!()).toBe(1);
    expect(ex.withMsg!()).toBe(1);
  });

  it("WASI target also instantiates Error subclasses with no env leak", async () => {
    const r = await compile(ERROR_SUBCLASS_MODULE, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => /^env::__get_undefined$/.test(l)),
      "leaked env::__get_undefined (WASI)",
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.plain!()).toBe(1);
    expect(ex.typed!()).toBe(1);
    expect(ex.withMsg!()).toBe(1);
  });

  it("default (gc / JS-host) mode keeps the __get_undefined host import", async () => {
    // The nativeStrings guard is standalone/WASI-only — gc mode must still emit
    // the host import (undefined vs null distinction matters with a JS runtime).
    const r = await compile(ERROR_SUBCLASS_MODULE, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.plain!()).toBe(1);
    expect(ex.typed!()).toBe(1);
    expect(ex.withMsg!()).toBe(1);
  });
});
