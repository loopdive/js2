// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5191 — a class whose `extends` clause names a BUILTIN (`Array`, `Error`,
// `Map`, …) got no class-object singleton, so its own name evaluated to `null`
// whenever it was read as a first-class value: `C == null` was true,
// `Boolean(C)` false, and every property access on it threw "Cannot access
// property on null or undefined".
//
// What masked it — and what these tests deliberately pin alongside the repro —
// is that `typeof C`, `C.name` and `new C()` all answer correctly: they are
// served by statically resolved arms that never materialize the constructor
// object. Only shapes that leave that arm and load the class as a VALUE
// degraded. So a fix that only made `C == null` false while breaking `new C()`
// would look identical from the repro alone.
//
// Measured on origin/main @ 279ce9a4f2 (2026-08-29): every `builtin-derived`
// case below reproduces (`== null` true / property read throws) on BOTH the
// host and standalone lanes, while the plain-class and user-derived controls
// already pass. The real-world shape is jsbi@4.3.0's `class JSBI extends
// Array` plus a comma sequence of static-table writes — the second top-level
// statement of the compiled @js-temporal/polyfill bundle, and the reason
// #4628 Option A could not run.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

/** Standalone lane: pure Wasm, no JS host imports. */
async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-5191.ts",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => number }).test();
}

/** Host lane: the ordinary equivalence-suite import surface. */
async function runHost(source: string): Promise<number> {
  const exports = await compileToWasm(source);
  return exports.test!() as number;
}

/** Every builtin base named in the #5191 receiver table. */
const BUILTIN_BASES = ["Array", "Error", "Map"] as const;

describe("#5191 builtin-derived class as a value", () => {
  for (const base of BUILTIN_BASES) {
    const decl = `class C extends ${base} {}`;

    it(`\`class C extends ${base}\` is not null (host)`, async () => {
      await expect(runHost(`${decl}\nexport function test(): number { return C == null ? 1 : 0; }`)).resolves.toBe(0);
    });

    it(`\`class C extends ${base}\` is not null (standalone)`, async () => {
      await expect(
        runStandalone(`${decl}\nexport function test(): number { return C == null ? 1 : 0; }`),
      ).resolves.toBe(0);
    });

    it(`\`class C extends ${base}\` is truthy (host)`, async () => {
      await expect(runHost(`${decl}\nexport function test(): number { return Boolean(C) ? 1 : 0; }`)).resolves.toBe(1);
    });

    it(`a missing property on \`class C extends ${base}\` reads undefined instead of throwing (host)`, async () => {
      await expect(
        runHost(`${decl}\nexport function test(): number { return (C as any).zzz === undefined ? 1 : 0; }`),
      ).resolves.toBe(1);
    });

    it(`a missing property on \`class C extends ${base}\` reads undefined instead of throwing (standalone)`, async () => {
      await expect(
        runStandalone(`${decl}\nexport function test(): number { return (C as any).zzz === undefined ? 1 : 0; }`),
      ).resolves.toBe(1);
    });
  }

  it("distinct builtin-derived classes are distinct values, not two nulls", async () => {
    // The pre-fix identity result (`A === B` false, `const v = C; v === C` true)
    // was an artifact of `null === null`, so identity alone never showed the
    // defect. Comparing two SEPARATE builtin-derived classes does.
    await expect(
      runHost(`
        class A extends Array {}
        class B extends Array {}
        export function test(): number { return (A === B ? 0 : 1) + ((A as any) === (A as any) ? 1 : 0); }
      `),
    ).resolves.toBe(2);
  });

  it("reads a static field off a builtin-derived class", async () => {
    await expect(
      runHost(`
        class C extends Array { static x = 1; static y = 2; }
        export function test(): number { return C.x + C.y; }
      `),
    ).resolves.toBe(3);
  });

  it("reads a static field off a builtin-derived class (standalone)", async () => {
    await expect(
      runStandalone(`
        class C extends Array { static x = 1; static y = 2; }
        export function test(): number { return C.x + C.y; }
      `),
    ).resolves.toBe(3);
  });

  it("reads back separate-statement static writes assigned after the declaration", async () => {
    // Pre-fix: a single statically PAIRED write+read (`C.a = 1; C.a`) already
    // answered 1 off the static arm — it is the second write, read as a value,
    // that degraded. Two writes as separate statements is the minimal shape
    // that leaves that arm.
    await expect(
      runHost(`
        class C extends Array {}
        C.a = 1;
        C.b = 2;
        export function test(): number { return C.b; }
      `),
    ).resolves.toBe(2);
  });

  it("runs jsbi's real pattern: a comma sequence of static-table writes", async () => {
    // Verbatim shape of jsbi@4.3.0's second top-level statement, the exact
    // statement the compiled @js-temporal/polyfill bundle died on.
    await expect(
      runHost(`
        class JSBI extends Array {}
        JSBI.__kMaxLength = 33554432,
          JSBI.__kMaxLengthBits = JSBI.__kMaxLength << 5,
          JSBI.__kMaxBitsPerChar = 1;
        export function test(): number { return JSBI.__kMaxLengthBits; }
      `),
    ).resolves.toBe(33554432 << 5);
  });

  it("runs jsbi's real pattern (standalone)", async () => {
    await expect(
      runStandalone(`
        class JSBI extends Array {}
        JSBI.__kMaxLength = 33554432,
          JSBI.__kMaxLengthBits = JSBI.__kMaxLength << 5,
          JSBI.__kMaxBitsPerChar = 1;
        export function test(): number { return JSBI.__kMaxLengthBits; }
      `),
    ).resolves.toBe(33554432 << 5);
  });

  it("enumerates own static keys instead of throwing on a null receiver", async () => {
    await expect(
      runHost(`
        class C extends Array {}
        C.a = 1;
        export function test(): number { return Object.getOwnPropertyNames(C).length > 0 ? 1 : 0; }
      `),
    ).resolves.toBe(1);
  });

  it("keeps a class derived from a builtin-derived class non-null too", async () => {
    await expect(
      runHost(`
        class C extends Array {}
        class D extends C {}
        export function test(): number { return (C == null ? 0 : 1) + (D == null ? 0 : 1); }
      `),
    ).resolves.toBe(2);
  });
});

describe("#5191 unregressed builtin-subclass behaviour", () => {
  // These are the arms that MASKED the defect. They passed before the fix and
  // must still pass after it: the fix hands the identifier a real class object
  // where it used to hand it null, and the risk is that the new carrier
  // shadows a statically resolved arm.

  it("keeps typeof, .name, construction and instanceof on `class C extends Array`", async () => {
    await expect(
      runHost(`
        class C extends Array {}
        export function test(): number {
          const o = new C();
          return (typeof C === "function" ? 1 : 0)
            + (C.name === "C" ? 1 : 0)
            + (o instanceof C ? 1 : 0)
            + (Array.isArray(o) ? 1 : 0)
            + (C.prototype ? 1 : 0);
        }
      `),
    ).resolves.toBe(5);
  });

  it("keeps static methods callable directly and through a variable", async () => {
    await expect(
      runHost(`
        class C extends Array { static m(): number { return 5; } }
        export function test(): number { const K = C; return C.m() + K.m(); }
      `),
    ).resolves.toBe(10);
  });

  it("keeps static methods inherited by a further subclass", async () => {
    await expect(
      runHost(`
        class C extends Array { static m(): number { return 4; } }
        class D extends C {}
        export function test(): number { return D.m(); }
      `),
    ).resolves.toBe(4);
  });

  it("keeps `class C extends Error` throwable and catchable", async () => {
    await expect(
      runHost(`
        class C extends Error {}
        export function test(): number {
          try { throw new C("x"); } catch (e) { return e instanceof C ? 1 : 0; }
        }
      `),
    ).resolves.toBe(1);
  });

  it("keeps `class C extends Map` usable as a Map", async () => {
    await expect(
      runHost(`
        class C extends Map<string, number> {}
        export function test(): number { const m = new C(); m.set("a", 3); return m.get("a")!; }
      `),
    ).resolves.toBe(3);
  });

  it("keeps `class C extends Set` usable as a Set (standalone)", async () => {
    await expect(
      runStandalone(`
        class C extends Set<number> {}
        export function test(): number { const s = new C(); s.add(1); return s.size + (C == null ? 0 : 1); }
      `),
    ).resolves.toBe(2);
  });
});
