// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1719 CPR (compiled prototype record) read-drive — array destructuring honours
// an overridden `Array.prototype[Symbol.iterator]` / `.values`.
//
// The write-arm (captured override) + the read-drive (drive the override at the
// dstr observation boundary via `__drive_proto_iterator` → `__call_fn_method_0`,
// drained through `__iterator_next`) must:
//   1. supply the override's yielded values to the binding pattern (z===42), and
//   2. terminate (the brand fires only at the dstr boundary, so internal array
//      iterations inside the override body stay on the typed-vec fast path — no
//      re-entrancy / infinite loop), and
//   3. leave override-free modules byte-identical (the whole read-drive branch is
//      behind `arrayIteratorMaybeOverridden && override-captured`, both false in
//      the common case).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function run(source: string, opts?: { fileName?: string }): Promise<Record<string, Function>> {
  const result = await compile(source, opts as never);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  const rt = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, rt);
  if (rt.setExports) rt.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

describe("#1719 CPR — array destructuring drives the overridden Array.prototype[@@iterator]", () => {
  it("var [a,b,z]=[1,2,3] uses the override's 3rd yield (42), not the backing store (3)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield 42;
      };
      function test() {
        var arr = [1, 2, 3];
        var [a, b, z] = arr;
        return z;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(42);
  });

  it("terminates (no re-entrancy) — the override fires once at the dstr boundary", async () => {
    // If the brand re-routed every internal `arr[i]` read, driving the override
    // (whose body itself reads `this[0]`/`this[1]`) would recurse forever. This
    // test simply completing proves the brand only fires at the observation site.
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield this[2];
      };
      function test() {
        var arr = [10, 20, 30];
        var [a, b, c] = arr;
        return a + b + c;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(60);
  });

  it("for-of head array destructuring drives the override per element (CPR-2)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield 42;
      };
      function test() {
        var z = 0;
        for (var [a, b, c] of [[1, 2, 3]]) { z = c; }
        return z;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(42);
  });

  it("for-of head drive terminates over multiple outer elements (CPR-2)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield this[2];
      };
      function test() {
        var total = 0;
        for (var [a, b, c] of [[10, 20, 30], [1, 2, 3]]) { total += a + b + c; }
        return total;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(66);
  });

  it("parameter array destructuring drives the override (CPR-2)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield 42;
      };
      function take([a, b, z]) { return z; }
      function test() { return take([1, 2, 3]); }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(42);
  });

  it("assignment array destructuring drives the override (CPR-2)", async () => {
    const ex = await run(
      `
      Array.prototype[Symbol.iterator] = function* () {
        yield this[0];
        yield this[1];
        yield 42;
      };
      function test() {
        var a, b, z;
        var arr = [1, 2, 3];
        [a, b, z] = arr;
        return z;
      }
      export { test };
      `,
      { fileName: "t.js" },
    );
    expect(ex.test()).toBe(42);
  });

  it("override-free array destructuring still reads the backing store", async () => {
    const ex = await run(
      `
      function test(): number {
        const arr = [1, 2, 3];
        const [a, b, c] = arr;
        return a + b + c;
      }
      export { test };
      `,
    );
    expect(ex.test()).toBe(6);
  });
});
