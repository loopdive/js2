// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3922 — host-free String.prototype.repeat in the linear-memory backend.
 *
 * Valid counts are checked against Node/V8. The linear backend cannot yet
 * materialize catchable JS RangeError objects (#1838/#1937), so the same
 * invalid-count cases that V8 classifies as RangeError are required to take
 * the native helper's deterministic pre-allocation trap instead.
 */

import { afterEach, describe, expect, it } from "vitest";

import { stringBenchmarks } from "../benchmarks/suites/strings.js";
import { compile, compileMulti } from "../src/index.js";

const ORIGINAL_LINEAR_IR = process.env.JS2WASM_LINEAR_IR;
const SOURCE = `
export function repeat(count: number): string { return "A😀".repeat(count); }
export function repeatLength(count: number): number { return "A😀".repeat(count).length; }
export function omitted(): string { return "ab".repeat(); }
export function empty(count: number): string { return "".repeat(count); }
`;

afterEach(() => {
  if (ORIGINAL_LINEAR_IR === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
  else process.env.JS2WASM_LINEAR_IR = ORIGINAL_LINEAR_IR;
});

async function instantiateRepeat(overlay: boolean) {
  process.env.JS2WASM_LINEAR_IR = overlay ? "1" : "0";
  const result = await compile(SOURCE, {
    target: "linear",
    fileName: `issue-3922-${overlay ? "ir" : "direct"}.ts`,
    emitWat: true,
    optimize: false,
    allocator: "arena-reset",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(result.wat).toContain("$__str_repeat");

  const instance = await WebAssembly.instantiate(module, {});
  const memory = instance.exports.memory as WebAssembly.Memory;
  const exports = instance.exports as unknown as {
    repeat(count?: number): number;
    repeatLength(count: number): number;
    omitted(): number;
    empty(count: number): number;
    __arena_used(): number;
  };
  const decode = (pointer: number): string => {
    const length = new DataView(memory.buffer).getUint32(pointer + 8, true);
    return new TextDecoder().decode(new Uint8Array(memory.buffer, pointer + 12, length));
  };
  return { decode, exports, memory };
}

describe("#3922 linear String.prototype.repeat", () => {
  it.each([false, true])("matches Node/V8 for valid ToIntegerOrInfinity counts (IR overlay=%s)", async (overlay) => {
    const { decode, exports } = await instantiateRepeat(overlay);
    const receiver = "A😀";
    for (const count of [NaN, -0, -0.75, 0, 0.75, 1, 1.9, 2, 3.9, 32]) {
      expect(decode(exports.repeat(count)), `count=${String(count)}`).toBe(receiver.repeat(count));
      expect(exports.repeatLength(count), `length count=${String(count)}`).toBe(receiver.repeat(count).length);
    }
    expect(decode(exports.repeat())).toBe(receiver.repeat(undefined));
    expect(decode(exports.omitted())).toBe("ab".repeat());
    expect(decode(exports.empty(2 ** 53))).toBe("".repeat(2 ** 53));
  });

  it("traps invalid and oversized counts before allocating", async () => {
    const { exports, memory } = await instantiateRepeat(true);
    const invalid = [-1, -1.25, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 2 ** 53];
    exports.repeat(1); // Materialize the cached receiver; repeat(1) itself allocates nothing.
    const arenaBefore = exports.__arena_used();
    const bytesBefore = memory.buffer.byteLength;

    for (const count of invalid) {
      expect(() => "A😀".repeat(count), `Node oracle count=${String(count)}`).toThrow(RangeError);
      expect(() => exports.repeat(count), `linear count=${String(count)}`).toThrow(WebAssembly.RuntimeError);
      expect(exports.__arena_used(), `arena count=${String(count)}`).toBe(arenaBefore);
    }
    expect(memory.buffer.byteLength).toBe(bytesBefore);

    expect(() => "".repeat(-1)).toThrow(RangeError);
    expect(() => exports.empty(-1)).toThrow(WebAssembly.RuntimeError);
  });

  it("source-gates the helper and compiles the exact concat-long benchmark with no imports", async () => {
    const control = await compile(`export function run(): number { return "ok".length; }`, {
      target: "linear",
      emitWat: true,
    });
    expect(control.success, control.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(control.wat).not.toContain("$__str_repeat");

    const benchmark = stringBenchmarks.find((entry) => entry.name === "string/concat-long");
    expect(benchmark?.source).toBeDefined();
    const candidate = await compile(benchmark!.source, {
      target: "linear",
      fileName: "benchmark-string-concat-long.ts",
      emitWat: true,
      optimize: false,
    });
    expect(candidate.success, candidate.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(candidate.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect(WebAssembly.Module.exports(module).some((entry) => entry.name === "run")).toBe(true);
    expect(candidate.wat).toContain("$__str_repeat");
  });

  it("registers the helper for multi-source linear compilation", async () => {
    const result = await compileMulti(
      {
        "repeat.ts": `export function repeated(count: number): string { return "xy".repeat(count); }`,
        "main.ts": `export { repeated } from "./repeat.js";`,
      },
      "main.ts",
      { target: "linear", emitWat: true, optimize: false },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    expect(result.wat).toContain("$__str_repeat");
  });

  it.each(["standalone", "wasi"] as const)("keeps the existing %s native lane host-free", async (target) => {
    const result = await compile(`export function run(): number { return "ab".repeat(3) === "ababab" ? 1 : 0; }`, {
      target,
      fileName: `issue-3922-${target}.ts`,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.run as () => number)()).toBe(1);
  });
});
