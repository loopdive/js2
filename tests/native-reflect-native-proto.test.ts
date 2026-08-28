// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { type CompileResult, compile, compileMulti } from "../src/index.js";

async function run(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

const REFLECT_NATIVE_PROTO = `
  export function inspectNativePrototype(target: any): number {
    const keys: any = Reflect.ownKeys(target);
    let sawToString = false;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === "toString") sawToString = true;
    }
    const descriptor: any = Reflect.getOwnPropertyDescriptor(target, "toString");
    if (!sawToString) return 1;
    if (descriptor === undefined) return 2;
    if (typeof descriptor.value !== "function") return 3;
    return 42;
  }
`;

const REFLECT_TYPED_ARRAY_CTOR = `
  export function inspectTypedArrayConstructor(target: any): number {
    const keys: any = Reflect.ownKeys(target);
    let mask = 0;
    for (let i = 0; i < keys.length; i++) {
      const key: any = keys[i];
      if (key === "length") mask |= 1;
      else if (key === "name") mask |= 2;
      else if (key === "prototype") mask |= 4;
      else if (key === "BYTES_PER_ELEMENT") mask |= 8;
      const descriptor: any = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor === undefined || descriptor === null) return 10 + i;
    }
    if (mask !== 15) return 4;
    const prototypeDescriptor: any = Reflect.getOwnPropertyDescriptor(target, "prototype");
    const bytesDescriptor: any = Reflect.getOwnPropertyDescriptor(target, "BYTES_PER_ELEMENT");
    if (prototypeDescriptor.value !== target.prototype) return 5;
    if (bytesDescriptor.value !== 1) return 6;
    return 42;
  }
`;

describe("standalone Reflect target admission for $NativeProto", () => {
  it("accepts a flowing builtin prototype for ownKeys and getOwnPropertyDescriptor", async () => {
    expect(
      await run(
        await compile(
          `${REFLECT_NATIVE_PROTO}
           const nativePrototype: any = Number.prototype;
           export function test(): number {
             return inspectNativePrototype(nativePrototype);
           }`,
          {
            target: "standalone",
            platform: "deno",
            skipSemanticDiagnostics: true,
          },
        ),
      ),
    ).toBe(42);
  });

  it("fills the target classifier after all sources register their heap types", async () => {
    expect(
      await run(
        await compileMulti(
          {
            "./reflect.ts": REFLECT_NATIVE_PROTO,
            "./entry.ts": `
              import { inspectNativePrototype } from "./reflect.ts";
              const nativePrototype: any = Number.prototype;
              export function test(): number {
                return inspectNativePrototype(nativePrototype);
              }
            `,
          },
          "./entry.ts",
          {
            target: "standalone",
            platform: "deno",
            skipSemanticDiagnostics: true,
          },
        ),
      ),
    ).toBe(42);
  });

  it("reflects the complete own-property surface of a flowing TypedArray constructor", async () => {
    expect(
      await run(
        await compile(
          `${REFLECT_TYPED_ARRAY_CTOR}
           const nativeConstructor: any = Uint8Array;
           const nativeView: any = new nativeConstructor(1);
           export function test(): number {
             if (nativeView.length !== 1) return 9;
             return inspectTypedArrayConstructor(nativeConstructor);
           }`,
          {
            target: "standalone",
            platform: "deno",
            skipSemanticDiagnostics: true,
          },
        ),
      ),
    ).toBe(42);
  });
});

describe("standalone Reflect target admission follows ECMAScript Type(Object)", () => {
  it("accepts every object carrier and rejects primitives for direct and extracted ownKeys", async () => {
    expect(
      await run(
        await compile(
          `
            class SafeMap extends Map {}

            function closureTarget(): number { return 1; }
            const extractedOwnKeys: any = Reflect.ownKeys;

            function directAccepts(target: any): boolean {
              try {
                const keys: any = Reflect.ownKeys(target);
                return keys.length >= 0;
              } catch (_error) {
                return false;
              }
            }

            function extractedAccepts(target: any): boolean {
              try {
                const keys: any = extractedOwnKeys(target);
                return keys.length >= 0;
              } catch (_error) {
                return false;
              }
            }

            function directRejectsWithTypeError(target: any): boolean {
              try {
                Reflect.ownKeys(target);
                return false;
              } catch (error) {
                return error instanceof TypeError;
              }
            }

            function extractedRejectsWithTypeError(target: any): boolean {
              try {
                extractedOwnKeys(target);
                return false;
              } catch (error) {
                return error instanceof TypeError;
              }
            }

            function acceptsBoth(target: any): boolean {
              return directAccepts(target) && extractedAccepts(target);
            }

            function rejectsBoth(target: any): boolean {
              return directRejectsWithTypeError(target) && extractedRejectsWithTypeError(target);
            }

            export function test(): number {
              if (!acceptsBoth([])) return 10;
              if (!acceptsBoth(new Map())) return 11;
              if (!acceptsBoth(new Set())) return 12;
              if (!acceptsBoth(new Error("boom"))) return 13;
              if (!acceptsBoth(SafeMap.prototype)) return 14;
              if (!acceptsBoth(closureTarget)) return 15;

              if (!rejectsBoth(1)) return 20;
              if (!rejectsBoth("primitive")) return 21;
              if (!rejectsBoth(true)) return 22;
              if (!rejectsBoth(1n)) return 23;
              if (!rejectsBoth(Symbol("primitive"))) return 24;
              if (!rejectsBoth(undefined)) return 25;
              if (!rejectsBoth(null)) return 26;
              return 42;
            }
          `,
          {
            target: "standalone",
            platform: "deno",
            skipSemanticDiagnostics: true,
          },
        ),
      ),
    ).toBe(42);
  });
});
