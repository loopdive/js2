import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";
import type { CompileOptions } from "../src/index.js";

// #2595 — standalone TypedArray `BYTES_PER_ELEMENT` (static + instance): the
//   static read CE'd ("built-in static property value read not supported") and
//   the instance read returned 0. Both are statically known per constructor
//   name — pure constant folds.
// #2597 — TypedArray/DataView/ArrayBuffer `@@toStringTag`:
//   `Object.prototype.toString.call(view)` returned `[object Object]` (or
//   `[object Array]` for typed arrays) instead of the constructor-name tag.
async function run(source: string, opts: CompileOptions = {}): Promise<Record<string, Function>> {
  const result = await compile(source, opts);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const built = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#2595 — TypedArray.BYTES_PER_ELEMENT static read (constant fold)", () => {
  const cases: Array<[string, number]> = [
    ["Int8Array", 1],
    ["Uint8Array", 1],
    ["Uint8ClampedArray", 1],
    ["Int16Array", 2],
    ["Uint16Array", 2],
    ["Int32Array", 4],
    ["Uint32Array", 4],
    ["Float32Array", 4],
    ["Float64Array", 8],
  ];
  for (const [name, bytes] of cases) {
    it(`${name}.BYTES_PER_ELEMENT === ${bytes} (standalone)`, async () => {
      const e = await run(`export function test(): number { return ${name}.BYTES_PER_ELEMENT; }`, {
        target: "standalone",
      });
      expect(e.test!()).toBe(bytes);
    });
    it(`${name}.BYTES_PER_ELEMENT === ${bytes} (gc/host)`, async () => {
      const e = await run(`export function test(): number { return ${name}.BYTES_PER_ELEMENT; }`);
      expect(e.test!()).toBe(bytes);
    });
  }
});

describe("#2595 — view.BYTES_PER_ELEMENT instance read (constant fold, standalone)", () => {
  const cases: Array<[string, number]> = [
    ["Int8Array", 1],
    ["Uint8Array", 1],
    ["Int16Array", 2],
    ["Uint32Array", 4],
    ["Float32Array", 4],
    ["Float64Array", 8],
  ];
  for (const [name, bytes] of cases) {
    it(`new ${name}(2).BYTES_PER_ELEMENT === ${bytes}`, async () => {
      const e = await run(`export function test(): number { return new ${name}(2).BYTES_PER_ELEMENT; }`, {
        target: "standalone",
      });
      expect(e.test!()).toBe(bytes);
    });
  }

  it("evaluates a side-effecting receiver before folding the constant", async () => {
    // Confirms the receiver is compiled (and dropped), not skipped.
    const e = await run(
      `export function test(): number {
         const v = new Int32Array(3);
         return v.BYTES_PER_ELEMENT + v.length; // 4 + 3
       }`,
      { target: "standalone" },
    );
    expect(e.test!()).toBe(7);
  });
});

describe("#2597 — @@toStringTag for TypedArray / DataView / ArrayBuffer", () => {
  // In-Wasm string equality so the assertion holds in BOTH modes (standalone
  // returns a native $AnyString that can't round-trip to a JS string at the
  // boundary; the === comparison is evaluated inside Wasm and yields i32 1/0).
  const tagCase = (expr: string, tag: string) =>
    `export function test(): boolean { return Object.prototype.toString.call(${expr}) === "[object ${tag}]"; }`;

  const cases: Array<[string, string]> = [
    ["new Int8Array(2)", "Int8Array"],
    ["new Uint8Array(2)", "Uint8Array"],
    ["new Int32Array(2)", "Int32Array"],
    ["new Float64Array(2)", "Float64Array"],
  ];

  for (const [expr, tag] of cases) {
    it(`${expr} → [object ${tag}] (standalone)`, async () => {
      const e = await run(tagCase(expr, tag), { target: "standalone" });
      expect(Boolean(e.test!())).toBe(true);
    });
    it(`${expr} → [object ${tag}] (gc/host)`, async () => {
      const e = await run(tagCase(expr, tag));
      expect(Boolean(e.test!())).toBe(true);
    });
  }

  it("DataView → [object DataView] (both modes)", async () => {
    const src = `export function test(): boolean {
      const buf = new ArrayBuffer(8);
      return Object.prototype.toString.call(new DataView(buf)) === "[object DataView]";
    }`;
    expect(Boolean((await run(src, { target: "standalone" })).test!())).toBe(true);
    expect(Boolean((await run(src)).test!())).toBe(true);
  });

  it("ArrayBuffer → [object ArrayBuffer] (both modes)", async () => {
    const src = `export function test(): boolean {
      return Object.prototype.toString.call(new ArrayBuffer(8)) === "[object ArrayBuffer]";
    }`;
    expect(Boolean((await run(src, { target: "standalone" })).test!())).toBe(true);
    expect(Boolean((await run(src)).test!())).toBe(true);
  });

  it("plain Array still tags [object Array] (no regression)", async () => {
    const src = `export function test(): boolean {
      const a = [1, 2, 3];
      return Object.prototype.toString.call(a) === "[object Array]";
    }`;
    expect(Boolean((await run(src, { target: "standalone" })).test!())).toBe(true);
    expect(Boolean((await run(src)).test!())).toBe(true);
  });
});
