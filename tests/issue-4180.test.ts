/**
 * #4180 — the #2372 descriptor-struct transcription fabricated a descriptor out
 * of a typed struct's INTERNAL wasm fields.
 *
 * `emitDescriptorStructReify` (`object-ops.ts`) copies a typed descriptor
 * struct's fields into a fresh `$Object` so `__obj_define_from_desc` can read
 * them. That is right for the case it was written for — a descriptor object
 * literal the checker closed into a struct — and silently wrong for every other
 * struct, because it transcribes the representation rather than the object.
 * For an array it emitted, literally,
 * `__extern_set(descObj, "length", …); __extern_set(descObj, "data", …)`, so
 * ToPropertyDescriptor saw no `value`/`enumerable` at all and
 * CompletePropertyDescriptor filled in `undefined` + all-false.
 *
 * The gate is `isDescriptorTranscribableStruct` (`property-descriptor-shape.ts`).
 * Kill-switch: make it return `true` unconditionally and the array/Date cases
 * below fail while the literal cases keep passing — which is exactly why the
 * literal cases are here.
 *
 * ## The unchanged-behaviour half is the load-bearing half
 * The transcription is the ONLY thing that makes a closed-struct descriptor
 * literal work at all (a closed struct is not a `$Object`, and before #3246 it
 * was not even accepted by the applier). Narrowing its gate is therefore a
 * change with a real way to go wrong: over-narrow and every
 * `var d = {value: 1}; Object.defineProperty(o, "p", d)` in the corpus breaks.
 * The `__anon_*` cases below pin that it does not.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { isDescriptorTranscribableStruct } from "../src/codegen/property-descriptor-shape.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown };

/** Instantiating with NO import object also asserts host-import freedom. */
async function runStandalone(src: string): Promise<unknown> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

const f = (name: string) => ({ name, type: { kind: "externref" } as const, mutable: true });

describe("#4180 descriptor-struct transcription gate", () => {
  describe("isDescriptorTranscribableStruct", () => {
    it("transcribes an object-literal struct even with no descriptor field", () => {
      // `{foo: 1}` is a valid (empty) descriptor, not a TypeError — its fields
      // ARE its own properties, so transcription is faithful.
      expect(isDescriptorTranscribableStruct("__anon_3", [f("foo")])).toBe(true);
    });

    it("transcribes a NAMED struct that carries a descriptor field", () => {
      // `function D() { this.value = 1 }` — a genuine descriptor carrier.
      expect(isDescriptorTranscribableStruct("D", [f("value")])).toBe(true);
      expect(isDescriptorTranscribableStruct("D", [f("other"), f("get")])).toBe(true);
    });

    it("REFUSES a builtin representation struct", () => {
      expect(isDescriptorTranscribableStruct("__vec_externref", [f("length"), f("data")])).toBe(false);
      expect(isDescriptorTranscribableStruct("__Date", [f("timestamp")])).toBe(false);
      expect(isDescriptorTranscribableStruct("__subview_i8_byte", [f("length"), f("data"), f("byteOffset")])).toBe(
        false,
      );
    });
  });

  it("an ARRAY descriptor carrier is read as an object (15.2.3.6-3-34 shape)", async () => {
    // Before: the descriptor became {length, data} and obj.property was
    // undefined with all-false attributes.
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const arrObj: any[] = [];
          (arrObj as any).enumerable = true;
          (arrObj as any).value = 42;
          Object.defineProperty(obj, "property", arrObj);
          let seen: number = 0;
          for (const k in obj) { if (k === "property") seen = 1; }
          return seen === 1 && obj.property === 42 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a DATE descriptor carrier is read as an object (15.2.3.6-3-36 shape)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const dateObj: Date = new Date();
          (dateObj as any).value = 7;
          Object.defineProperty(obj, "p", dateObj);
          return obj.p === 7 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("an array carrier WITHOUT the field still yields the spec default", async () => {
    // Guards the other direction: pass-through must not invent a `true`.
    // No `enumerable` on the carrier ⇒ CompletePropertyDescriptor default false.
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const arrObj: any[] = [];
          (arrObj as any).value = 5;
          Object.defineProperty(obj, "p", arrObj);
          let seen: number = 0;
          for (const k in obj) { if (k === "p") seen = 1; }
          return seen === 0 && obj.p === 5 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a closed-struct descriptor LITERAL still works (transcription unchanged)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const d = { value: 11, writable: true, enumerable: true, configurable: true };
          Object.defineProperty(obj, "p", d);
          let seen: number = 0;
          for (const k in obj) { if (k === "p") seen = 1; }
          return seen === 1 && obj.p === 11 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a closed-struct ACCESSOR descriptor literal still works", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const obj: any = {};
          const d = { get: function (): number { return 13; } };
          Object.defineProperty(obj, "p", d);
          return obj.p === 13 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
