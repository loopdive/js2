// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1597 — `__throw_reference_error` must not leak as a JS-host import under
 * `--target standalone` (or `--target wasi`). The three reference-error sites
 * in `src/codegen/expressions/identifiers.ts` (TDZ flag check, static TDZ
 * throw, unresolved-identifier throw) are all gated by `noJsHost(ctx)`, which
 * is true for standalone/wasi. In those modes the compiler builds a
 * ReferenceError INSTANCE in-module (so `e instanceof ReferenceError` works
 * under wasmtime) instead of calling the absent host import — closing the
 * `unknown import env::__throw_reference_error` instantiation failure.
 *
 * Sibling host-independence work: #1471–#1474, #1473 (errors/exceptions).
 */

function hasRefErrorImport(imports: ReadonlyArray<{ module: string; name: string }>): boolean {
  return imports.some((i) => i.name === "__throw_reference_error");
}

const TDZ_SRC = `
  export function test(): number {
    try {
      return x;
    } catch (e) {
      return 1;
    }
    let x = 5;
  }
`;

const UNDEF_SRC = `
  export function test(): number {
    return notDefinedAnywhere;
  }
`;

describe("#1597 — standalone gate for __throw_reference_error", () => {
  it("TDZ violation compiles standalone with no __throw_reference_error import", async () => {
    const r = await compile(TDZ_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(
      hasRefErrorImport(r.imports),
      `standalone leaked __throw_reference_error: ${r.imports.map((i) => `${i.module}::${i.name}`).join(", ")}`,
    ).toBe(false);
  });

  it("unresolved identifier compiles standalone with no __throw_reference_error import", async () => {
    const r = await compile(UNDEF_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(hasRefErrorImport(r.imports)).toBe(false);
  });

  it("standalone TDZ module instantiates with zero env imports (no panic at instantiation)", async () => {
    const r = await compile(TDZ_SRC, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // {} imports — instantiation must not fail on a missing host import.
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    // The TDZ access is wrapped in try/catch; the in-module ReferenceError
    // is caught and the function returns 1.
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("wasi target also gates the reference-error import", async () => {
    const r = await compile(UNDEF_SRC, { target: "wasi" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(hasRefErrorImport(r.imports)).toBe(false);
  });

  it("default (gc / JS-host) mode preserves the __throw_reference_error import", async () => {
    // Regression guard: standalone gating is opt-in. The default browser
    // target keeps the host import so JS-hosted modules behave as before.
    const r = await compile(TDZ_SRC, {});
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(hasRefErrorImport(r.imports)).toBe(true);
  });
});
