// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2029 — builtin-subclass cluster of the standalone `u32 out of range: -1`
 * emit bucket.
 *
 * `class X extends Error/TypeError/Uint8Array {}` died at EMIT time under
 * `--target standalone` with `Binary emit error: u32 out of range: -1`
 * (named by the #2043 always-on validator as
 * `global index out of range — -1 ... at function 'X_new'`). The whole file
 * was lost — a hard compile error, not a refusal.
 *
 * Root cause (per #2043 diagnosis): in standalone/`nativeStrings` mode,
 * `addStringConstantGlobal` stores the documented `-1` sentinel in
 * `ctx.stringGlobalMap` ("no host `string_constants` global — materialize the
 * literal inline at use sites"). `emitSetSubclassProto` read the class-name
 * globals and guarded only `=== undefined`, NOT the in-pool `-1` value, then
 * baked `{ op: "global.get", index: -1 }` into the prototype-adjustment arm.
 *
 * Fix: `emitSetSubclassProto` now also skips when either name global is the
 * `-1` sentinel. The prototype adjustment exists only to feed the
 * `__set_subclass_proto` HOST import (unavailable standalone anyway), so
 * skipping it is correct — the WasmGC instance tag still carries class
 * identity for `instanceof`.
 *
 * These assert COMPILATION succeeds (the emit-crash is the bug). Runtime
 * behaviour of `extends Error` standalone additionally depends on the
 * `__new_<Builtin>` host-import retirement, tracked separately.
 */
describe("#2029 — builtin subclass compiles under --target standalone", () => {
  async function compilesStandalone(src: string): Promise<void> {
    const r = await compile(src, { fileName: "repro-2029.ts", target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  }

  it("class extends Error with explicit super()", async () => {
    await compilesStandalone(
      `class E extends Error { constructor() { super("x"); } }
       export function test(): number { new E(); return 1; }`,
    );
  });

  it("class extends Error with an own field", async () => {
    await compilesStandalone(
      `class E extends Error { c: number = 9; constructor() { super("x"); } }
       export function test(): number { return new E().c; }`,
    );
  });

  it("class extends TypeError", async () => {
    await compilesStandalone(
      `class E extends TypeError { constructor() { super("y"); } }
       export function test(): number { new E(); return 1; }`,
    );
  });

  it("class extends Error with an implicit constructor", async () => {
    await compilesStandalone(
      `class E extends Error {}
       export function test(): number { new E(); return 1; }`,
    );
  });

  it("three-level extends Error hierarchy", async () => {
    await compilesStandalone(
      `class A extends Error {}
       class B extends A {}
       export function test(): number { new B(); return 1; }`,
    );
  });

  it("class extends Uint8Array (the issue's minimal repro)", async () => {
    await compilesStandalone(`class MyArr extends Uint8Array {} export function test(): number { return 1; }`);
  });

  it("class expression extends Error", async () => {
    await compilesStandalone(`const E = class extends Error {}; export function test(): number { return 1; }`);
  });

  it("plain class still compiles (control — non-subclass path unaffected)", async () => {
    await compilesStandalone(`class A { x: number = 5; } export function test(): number { return new A().x; }`);
  });
});
