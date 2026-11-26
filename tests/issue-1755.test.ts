import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

function expectCompileSuccess(result: CompileResult): void {
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("\n")).toBe(true);
}

function instantiateNoImports(result: CompileResult): WebAssembly.Exports {
  expectCompileSuccess(result);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), {}).exports;
}

describe("#1755 Uint8Array<ArrayBuffer> generic typed-array annotation", () => {
  it("erases the generic argument in param, return, variable, and field positions", async () => {
    const result = await compile(`
      class Holder {
        bytes: Uint8Array<ArrayBuffer>;

        constructor(bytes: Uint8Array<ArrayBuffer>) {
          this.bytes = bytes;
        }

        get(): Uint8Array<ArrayBuffer> {
          const local: Uint8Array<ArrayBuffer> = this.bytes;
          return local;
        }
      }

      export function echo(input: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
        const holder = new Holder(input);
        return holder.get();
      }
    `);

    expectCompileSuccess(result);
    expect(result.exportSignatures?.echo).toEqual({
      params: ["uint8array"],
      result: "uint8array",
    });

    expectCompileSuccess(result);
    const { exports } = await instantiateWithRuntime(result);
    const out = exports.echo(new Uint8Array([7, 8, 9]));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([7, 8, 9]);
  });

  it("accepts sibling typed-array generics as typed-array annotations", async () => {
    const result = await compile(`
      export function echoI32(input: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
        const local: Int32Array<ArrayBuffer> = input;
        return local;
      }

      export function echoF64(input: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
        return input;
      }
    `);

    expectCompileSuccess(result);
    expect(result.exportSignatures?.echoI32).toEqual({
      params: ["typed-array"],
      result: "typed-array",
    });
    expect(result.exportSignatures?.echoF64).toEqual({
      params: ["typed-array"],
      result: "typed-array",
    });
  });

  it("compiles the #389 encodeMessage shape with a generic Uint8Array return", async () => {
    const result = await compile(`
      const encoder: TextEncoder = new TextEncoder();

      function encodeMessage(message: object): Uint8Array<ArrayBuffer> {
        return encoder.encode(JSON.stringify(message));
      }

      export function encodedLength(): number {
        return encodeMessage({ ok: true }).length;
      }
    `);

    expectCompileSuccess(result);
  });

  it("accepts Uint8Array<ArrayBuffer> in standalone and WASI modes", async () => {
    const source = `
      export function encodedLength(): number {
        const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode("ok");
        return bytes.length;
      }
    `;

    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(source, { fileName: `issue-1755-${target}.ts`, target });
      const exports = instantiateNoImports(result) as { encodedLength: () => number };
      expect(exports.encodedLength()).toBe(2);
    }
  });

  it("accepts Uint8Array<ArrayBuffer> collection annotations in the linear backend", async () => {
    const result = await compile(
      `
        class Holder {
          bytes: Uint8Array<ArrayBuffer>;

          constructor(bytes: Uint8Array<ArrayBuffer>) {
            this.bytes = bytes;
          }

          get(): Uint8Array<ArrayBuffer> {
            return this.bytes;
          }
        }

        function firstPlusLength(input: Uint8Array<ArrayBuffer>): number {
          return input[0] + input.length;
        }

        export function test(): number {
          const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(3);
          bytes[0] = 40;
          const holder = new Holder(bytes);
          return firstPlusLength(holder.get());
        }
      `,
      { target: "linear" },
    );

    const exports = instantiateNoImports(result) as { test: () => number };
    expect(exports.test()).toBe(43);
  });
});
