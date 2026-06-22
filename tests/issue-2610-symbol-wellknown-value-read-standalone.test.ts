// #2610 — standalone `Symbol.<wellKnown>` read as a VALUE must fold to its i32
// sentinel id instead of hard-refusing at compile time.
//
// Root cause: `hasNativeBuiltinConstantHandler` (property-access.ts) omitted a
// `Symbol` arm, so the standalone builtin-static-value-read refusal pre-empted
// the existing well-known-symbol constant emitter (`getWellKnownSymbolId`).
// Reading `Symbol.iterator`/`Symbol.asyncIterator`/… as a value (a bare property
// read or a computed-key) refused-loud in `--target standalone`, blocking the
// `language/{statements,expressions}/class/dstr` iterator-protocol families.
//
// The fix is substrate-independent: the value is a compile-time i32 constant
// (the well-known-symbol sentinel id), so it needs no builtin-prototype object.
// gc/host mode is unaffected (the defer is gated on `ctx.standalone`).
//
// Scope note: this slice removes the COMPILE refusal (necessary). Some
// iterator-error-path tests additionally need the open-object value-rep work
// (#2611 / #2580) to fully PASS at runtime — those still exercise the dynamic
// `__extern_set`/`__extern_get` symbol-keyed path, which is out of scope here.
// We therefore assert COMPILES for the write/computed-key cases and COMPILES +
// RUNS for the bare value reads (which fold to a constant and fully work).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return (await compile(src, { target: "standalone" })) as {
    success: boolean;
    errors: { message: string }[];
    binary: Uint8Array;
    importObject?: WebAssembly.Imports;
  };
}

function assertCompiles(r: { success: boolean; errors: { message: string }[] }) {
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  assertCompiles(r);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("#2610 standalone Symbol.<wellKnown> value-read folds to its i32 sentinel", () => {
  it("compiles a computed-key WRITE keyed by Symbol.iterator (was refused)", async () => {
    const r = await compileStandalone(`
      const o: any = {};
      o[Symbol.iterator] = function () {
        return { next() { return { done: true, value: undefined }; } };
      };
      export function test(): number { return 1; }
    `);
    assertCompiles(r);
  });

  it("compiles a bare Symbol.iterator value-read stored in a const (was refused)", async () => {
    const r = await compileStandalone(`
      const k = Symbol.iterator;
      export function test(): number { return 1; }
    `);
    assertCompiles(r);
  });

  it("compiles Symbol.asyncIterator / toPrimitive / toStringTag value reads (was refused)", async () => {
    for (const name of ["asyncIterator", "toPrimitive", "toStringTag"]) {
      const r = await compileStandalone(`
        const k = Symbol.${name};
        export function test(): number { return 1; }
      `);
      assertCompiles(r);
    }
  });

  // Runtime: the bare value-read folds to the well-known-symbol sentinel id
  // (iterator=1, asyncIterator=12, toPrimitive=3, toStringTag=4 — see
  // WELL_KNOWN_SYMBOLS in property-access.ts). These run end-to-end with no
  // open-object substrate involved.
  it("Symbol.iterator value folds to sentinel 1 at runtime", async () => {
    expect(await runStandalone(`export function test(): number { return Symbol.iterator as unknown as number; }`)).toBe(
      1,
    );
  });

  it("Symbol.asyncIterator value folds to sentinel 12 at runtime", async () => {
    expect(
      await runStandalone(`export function test(): number { return Symbol.asyncIterator as unknown as number; }`),
    ).toBe(12);
  });

  it("Symbol.toPrimitive value folds to sentinel 3 at runtime", async () => {
    expect(
      await runStandalone(`export function test(): number { return Symbol.toPrimitive as unknown as number; }`),
    ).toBe(3);
  });

  it("Symbol.toStringTag value folds to sentinel 4 at runtime", async () => {
    expect(
      await runStandalone(`export function test(): number { return Symbol.toStringTag as unknown as number; }`),
    ).toBe(4);
  });

  it("passing Symbol.species as a call argument compiles and folds to sentinel 5", async () => {
    expect(
      await runStandalone(`
        function id(x: number): number { return x; }
        export function test(): number { return id(Symbol.species as unknown as number); }
      `),
    ).toBe(5);
  });
});
