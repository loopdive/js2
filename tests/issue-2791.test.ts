// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2791 — Hybrid fast-path audit Row 4: monomorphic struct.get/set soundness.
//
// Findings (see plan/issues/2791-hybrid-monomorphic-struct-proof.md):
//
//  * READ path is already HI-compliant: every ref/externref struct-field read
//    routes through the runtime `ref.test` multi-struct dispatch (#778/#2674),
//    so a union arm / any-widened / subclass / structurally-distinct receiver
//    reads the CORRECT field, not a wrong offset. These tests LOCK that
//    discharge — they must stay green.
//
//  * WRITE path silently miscompiles when a value is passed to a parameter of a
//    DIFFERENT nominal struct type (a structurally-compatible distinct class, or
//    an `interface`): the call-argument coercion materializes a fresh
//    `struct.new` COPY (type-coercion.ts `emitStructNarrowBody`), so a callee
//    that mutates through the param updates the copy, not the caller's original.
//    The root cause is the structural-narrowing copy at the call boundary, NOT
//    `resolveStructName`/`emitNullGuardedStructGet`. Documented here with
//    `it.fails` so the suite flags it the moment the re-scoped fix lands.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runTest(source: string, standalone: boolean): Promise<number> {
  // The boolean `standalone` option was replaced by `target: "standalone"`.
  const r = await compile(source, { fileName: "test.ts", ...(standalone ? { target: "standalone" as const } : {}) });
  expect(r.success, `compile failed: ${r.errors[0]?.message ?? "unknown"}`).toBe(true);
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  });
  return (instance.exports as { test: () => number }).test();
}

describe("#2791 Row 4 — monomorphic struct read is discharged (runtime ref.test dispatch)", () => {
  for (const standalone of [false, true]) {
    const tag = standalone ? "standalone" : "host";

    it(`reads a union of two struct types at the correct offset (${tag})`, async () => {
      const got = await runTest(
        `
        class A { a: number; x: number; constructor(){this.a=1;this.x=10;} }
        class B { x: number; constructor(){this.x=99;} }
        function read(o: A | B): number { return o.x; }
        export function test(): number { return read(new A())*1000 + read(new B()); }
        `,
        standalone,
      );
      expect(got).toBe(10099);
    });

    it(`reads an any-widened receiver at the correct offset (${tag})`, async () => {
      const got = await runTest(
        `
        class A { a: number; x: number; constructor(){this.a=1;this.x=10;} }
        class B { x: number; constructor(){this.x=99;} }
        function read(o: any): number { return o.x; }
        export function test(): number { return read(new A())*1000 + read(new B()); }
        `,
        standalone,
      );
      expect(got).toBe(10099);
    });

    it(`reads a subclass through a parent-typed ref (prefix subtyping) (${tag})`, async () => {
      const got = await runTest(
        `
        class P { x: number; constructor(){this.x=5;} }
        class C extends P { y: number; constructor(){super(); this.y=7;} }
        function readX(o: P): number { return o.x; }
        export function test(): number { let c: P = new C(); return readX(c)*1000 + readX(new P()); }
        `,
        standalone,
      );
      expect(got).toBe(5005);
    });

    it(`reads two reordered-field anon shapes through one interface (${tag})`, async () => {
      const got = await runTest(
        `
        interface P2 { x: number; y: number; }
        function sum(o: P2): number { return o.x*100 + o.y; }
        export function test(): number {
          const a: P2 = { x: 1, y: 2 };
          const b: P2 = { y: 8, x: 9 };
          return sum(a)*10000 + sum(b);
        }
        `,
        standalone,
      );
      expect(got).toBe(1020908);
    });

    it(`reads sibling subclasses through a shared base ref (${tag})`, async () => {
      const got = await runTest(
        `
        class Base { tag: number; constructor(t: number){ this.tag = t; } }
        class L extends Base { left: number; constructor(){ super(1); this.left = 11; } }
        class R extends Base { right: number; constructor(){ super(2); this.right = 22; } }
        function getTag(b: Base): number { return b.tag; }
        export function test(): number { return getTag(new L())*1000 + getTag(new R()); }
        `,
        standalone,
      );
      expect(got).toBe(1002);
    });
  }
});

describe("#2791 Row 4 — KNOWN write miscompile via structural-narrowing copy (NOT the Row-4 lane)", () => {
  // These document a latent silent miscompile: a value passed to a parameter of
  // a DIFFERENT nominal struct type is COPIED at the call boundary
  // (type-coercion.ts emitStructNarrowBody), so a mutating callee updates the
  // copy, not the caller's original. `it.fails` asserts they are CURRENTLY
  // broken — when the re-scoped fix lands these will flip and the suite will
  // demand `it.fails` be removed. See plan/issues/2791-*.md.
  for (const standalone of [false, true]) {
    const tag = standalone ? "standalone" : "host";

    it.fails(`mutation through a structurally-compatible class param is lost (${tag})`, async () => {
      const got = await runTest(
        `
        class A { x: number; constructor(){this.x=1;} }
        class B { x: number; constructor(){this.x=2;} }
        function setX(o: A, v: number): void { o.x = v; }
        export function test(): number { const b = new B(); setX(b, 9); return b.x; }
        `,
        standalone,
      );
      expect(got).toBe(9); // JS reference semantics; compiler currently returns 2
    });

    // Fixed by 190d5336d (#6634, landed with PR #5978: "named interface's Wasm
    // carrier no longer aliases to one implementer's struct"); bisected
    // 2026-11-26. The structurally-compatible class case above is still #2793.
    it(`mutation through an interface-typed param reaches the caller (${tag})`, async () => {
      const got = await runTest(
        `
        interface I { v: number; }
        class A implements I { a: number; v: number; constructor(){this.a=0;this.v=1;} }
        class B implements I { v: number; constructor(){this.v=2;} }
        function setV(o: I, x: number): void { o.v = x; }
        export function test(): number {
          const a = new A(); const b = new B();
          setV(a, 100); setV(b, 200);
          return a.v*1000 + b.v;
        }
        `,
        standalone,
      );
      expect(got).toBe(100200);
    });
  }
});
