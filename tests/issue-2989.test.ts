// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2989 — standalone `Object.defineProperty` missing spec TypeErrors on the
 * DYNAMIC-descriptor path.
 *
 * Root cause: the inline-literal fast path (`__defineProperty_value`, via
 * `computeRuntimeFlags`) runs the §10.1.6.3 ValidateAndApplyPropertyDescriptor
 * preflight, whose every spec-mandated TypeError is gated on the host-flag
 * "specified" bits (3/4/5 — "Desc has a [[configurable]]/[[enumerable]]/
 * [[writable]] field") and the "hasValue" bit (7). The DYNAMIC-descriptor
 * applier `__obj_define_from_desc` — reached whenever the descriptor is a
 * runtime value (`var d = {...}; Object.defineProperty(o, k, d)`, the dominant
 * ES5 `15.2.3.6-*` shape) — set only the VALUE bits (0/1/2), never the
 * specified/hasValue bits. So the preflight read "no attribute specified / no
 * value" for every field and never threw: an invalid (re)definition through a
 * variable descriptor silently no-op'd instead of throwing a TypeError.
 *
 * Fix (object-runtime.ts `__obj_define_from_desc`): set the specified bit when
 * a `writable`/`enumerable`/`configurable` field is present, and the hasValue
 * bit when `value` is present, so the dispatched `__defineProperty_value`
 * preflight fires identically to the inline-literal path.
 *
 * All snippets run top-level in the standalone start section, so a spec throw
 * escapes `WebAssembly.instantiate`; a silent no-op instantiates cleanly. Each
 * binary is asserted host-free (no `env::` imports).
 */
async function compileStandalone(src: string) {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, `compile failed:\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const envImports = (r.imports ?? []).filter((i) => String(i).startsWith("env"));
  expect(envImports, "expected host-free standalone binary").toEqual([]);
  return r;
}

async function throwsOnInstantiate(src: string): Promise<boolean> {
  const r = await compileStandalone(src);
  try {
    await WebAssembly.instantiate(r.binary, {});
    return false;
  } catch {
    return true;
  }
}

describe("#2989 — dynamic-descriptor defineProperty spec TypeErrors", () => {
  it("redefining configurable:false→true through a var descriptor throws", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 1, configurable: false };
Object.defineProperty(o, "x", d1);
const d2 = { configurable: true };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(true);
  });

  it("changing enumerable on a non-configurable prop through a var descriptor throws", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 1, enumerable: false, configurable: false };
Object.defineProperty(o, "x", d1);
const d2 = { enumerable: true };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(true);
  });

  it("changing the value of a non-configurable non-writable prop through a var descriptor throws", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 1, writable: false, configurable: false };
Object.defineProperty(o, "x", d1);
const d2 = { value: 2 };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(true);
  });

  it("making a non-writable non-configurable prop writable through a var descriptor throws", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 1, writable: false, configurable: false };
Object.defineProperty(o, "x", d1);
const d2 = { writable: true };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(true);
  });

  it("dynamic descriptor still ALLOWS a legal redefine of a configurable prop (no spurious throw)", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 1, configurable: true, writable: true };
Object.defineProperty(o, "x", d1);
const d2 = { value: 2, enumerable: true };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(false);
  });

  it("dynamic descriptor still ALLOWS a same-value redefine of a non-writable prop (SameValue, no throw)", async () => {
    expect(
      await throwsOnInstantiate(
        `const o = {};
const d1 = { value: 7, writable: false, configurable: false };
Object.defineProperty(o, "x", d1);
const d2 = { value: 7 };
Object.defineProperty(o, "x", d2);`,
      ),
    ).toBe(false);
  });
});
