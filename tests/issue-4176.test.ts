// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4176 — NAMED keys on a builtin's `.prototype` must live through the chain
 * (standalone). #4160 shipped the proto-property store gated to INTEGER keys
 * and only the Object/Array brands; this generalises it to per-brand
 * companions with named keys, receiver-aware consults.
 *
 * Two independent defects are pinned here, because either alone reproduces the
 * user-visible symptom and fixing only one leaves it:
 *
 *  1. The COLLECTION gap. A top-level `<Builtin>.prototype.<name> = …` has no
 *     module-global root identifier (`Object`/`Function`/… are builtins), so
 *     `collectDeclarations` dropped the statement from `__module_init` and the
 *     write compiled to NOTHING. Fifth instance of that family, after #2992
 *     (top-level `delete`), #3592 (`throw`), #3615 (bare read) and #4179
 *     (`with`).
 *  2. The STORE gap. Even when the write executed, the store admitted only
 *     integer keys on two brands, so a named key was a silent no-op.
 *
 * The §8.10.5 idiom these serve is an arbitrary object used as a property
 * descriptor, reading its fields through the prototype chain.
 */
import { describe, expect, it } from "vitest";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(result.imports ?? [], "must stay host-free").toEqual([]);
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

function outcomeFor(result: CompileResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes?.find((outcome) => outcome.displayName === name);
}

describe("#4176 named keys on builtin prototypes (standalone)", () => {
  // The headline shape. Measured returning 0 (the write vanished) before the fix.
  it("Object.prototype.zzz is visible on a plain object", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).zzz = 7;
          const o: any = {};
          return o.zzz;
        }
      `),
    ).toBe(7);
  });

  // Per-brand: the store was Object/Array-only, so Function had no companion.
  it("Function.prototype.<name> is visible on a function value", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          function f(): void {}
          (Function.prototype as any).marker = 11;
          return (f as any).marker;
        }
      `),
    ).toBe(11);
  });

  it("for-in enumerates a bound function's inherited enumerable companion key", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          Object.defineProperty(Function.prototype, "forInMarker", {
            value: 7,
            enumerable: true,
            configurable: true
          });
          const base = function (): void {};
          const bound: any = base.bind({});
          let count = 0;
          let value = 0;
          for (const key in bound) {
            if (key === "forInMarker") {
              count++;
              value = bound[key];
            }
          }
          return count * 100 + value;
        }
      `),
    ).toBe(107);
  });

  it("for-in enumerates Object.prototype companion keys on plain objects", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          Object.defineProperty(Object.prototype, "objectForInMarker", {
            value: 3,
            enumerable: true,
            configurable: true
          });
          const value: any = {};
          for (const key in value) {
            if (key === "objectForInMarker") return value[key];
          }
          return 0;
        }
      `),
    ).toBe(3);
  });

  it("for-in's array fast path appends Array.prototype companion keys", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          Object.defineProperty(Array.prototype, "arrayForInMarker", {
            value: 5,
            enumerable: true,
            configurable: true
          });
          const value: any = [9];
          let sawIndex = 0;
          let sawInherited = 0;
          for (const key in value) {
            if (key === "0") sawIndex = 1;
            if (key === "arrayForInMarker") sawInherited = value[key];
          }
          return sawIndex * 10 + sawInherited;
        }
      `),
    ).toBe(15);
  });

  it("prepared IR for-in shares prototype-companion enumeration", async () => {
    const result = await compile(
      `
        Object.defineProperty(Function.prototype, "irInherited", {
          value: 1,
          enumerable: true,
          configurable: true
        });
        export function makeFunction(): any {
          return function (): void {};
        }
        export function hasInherited(object: any): boolean {
          for (var key in object) {
            return true;
          }
          return false;
        }
      `,
      {
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        fileName: "issue-4176-for-in-ir.ts",
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports ?? []).toEqual([]);
    expect(outcomeFor(result, "hasInherited")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as {
      makeFunction: () => unknown;
      hasInherited: (object: unknown) => number;
    };
    expect(exports.hasInherited(exports.makeFunction())).toBe(1);
  });

  it("Array.prototype.<name> is visible on an array", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Array.prototype as any).marker = 13;
          const a: any = [1, 2];
          return a.marker;
        }
      `),
    ).toBe(13);
  });

  // Receiver-awareness: an Array receiver must resolve through the Array
  // companion first and only then fall back to Object.prototype (chain depth 2).
  it("Array receiver falls back to Object.prototype for a key Array lacks", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).onlyOnObject = 17;
          const a: any = [1];
          return a.onlyOnObject;
        }
      `),
    ).toBe(17);
  });

  // Defect 1 in isolation: the write is a TOP-LEVEL statement, so it exercises
  // the module-init collection arm rather than a function body. The same write
  // inside a function always worked — that asymmetry is the whole bug.
  it("the write executes from top-level module scope, not only inside a function", async () => {
    expect(
      await runStandalone(`
        (Object.prototype as any).topLevelKey = 23;
        export function main(): number {
          const o: any = {};
          return o.topLevelKey;
        }
      `),
    ).toBe(23);
  });

  // The §8.10.5 payload: an inherited descriptor field must reach
  // ToPropertyDescriptor. This is what the ~62 test262 files actually assert.
  it("an INHERITED descriptor field is honoured by Object.defineProperty", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).value = 29;
          const target: any = {};
          const desc: any = {};
          Object.defineProperty(target, "p", desc);
          return target.p;
        }
      `),
    ).toBe(29);
  });

  // Guard: an OWN key must still win over the inherited one.
  it("an own property shadows the prototype's named key", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).shadowed = 1;
          const o: any = { shadowed: 2 };
          return o.shadowed;
        }
      `),
    ).toBe(2);
  });

  // Guard: absent stays absent — the store must not fabricate a hit.
  it("an unrelated key still reads undefined", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          (Object.prototype as any).present = 1;
          const o: any = {};
          return o.absent === undefined ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // Scope guard: a module that never writes a prototype key must not reserve
  // the store. Asserted behaviourally — ordinary property access is unchanged.
  it("a flag-clear module is unaffected", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          const o: any = { a: 41 };
          return o.a + 1;
        }
      `),
    ).toBe(42);
  });
});
