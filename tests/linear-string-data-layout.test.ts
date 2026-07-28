// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pin: string literals on the linear backend must never collide with the heap.
 *
 * The bug (found via a benchmark CHECKSUM MISMATCH, #3673 round 37): literals
 * were emitted into a data segment starting at `DATA_SEGMENT_BASE = 64` while
 * `__heap_ptr` was initialised to a *fixed* `HEAP_START = 1024`, with nothing
 * reconciling the two. A literal long enough to run past 1024 got overwritten
 * by the string runtime's own first allocation:
 *
 *   - at 980 chars `.length` reported 979 and 17 characters read back wrong;
 *   - at 1024 chars `.length` was right but characters were still wrong;
 *   - past one page the module would not even instantiate.
 *
 * It corrupted **silently**, which is the dangerous kind — hence a pin that
 * asserts full round-trip content equality, not just `.length`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Deterministic non-repeating-at-page-boundaries ASCII payload. */
function makeLiteral(length: number, salt = ""): string {
  const alphabet = `${salt}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[i % alphabet.length];
  return out;
}

/** Same rolling hash the compiled module computes, evaluated on the host. */
function hostChecksum(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * A `.length` probe plus a full-content checksum walked inside wasm. The
 * checksum is what catches the silent case — a literal can report the right
 * length while its tail bytes have been clobbered.
 */
function probeSource(literal: string): string {
  const encoded = JSON.stringify(literal);
  return `
export function literalLength(): number {
  const s = ${encoded};
  return s.length;
}
export function literalChecksum(): number {
  const s = ${encoded};
  let h = 0;
  for (let i = 0; i < s.length; i = i + 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
`;
}

async function instantiate(source: string): Promise<Record<string, CallableFunction>> {
  const result = await compile(source, { target: "linear" });
  expect(result.errors ?? []).toEqual([]);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return instance.exports as unknown as Record<string, CallableFunction>;
}

describe("linear backend: string-literal data segment vs heap", { timeout: 60_000 }, () => {
  // 900 is under the old 960-byte window, 960 is exactly at it, and everything
  // above used to corrupt. 3127 is not a synthetic boundary — it is the length
  // at which the #3687 hybrid study observed the corruption in the wild (linear
  // returned a checksum of 106161 where both node and the GC lane returned
  // 101058, with no error). 70000 additionally exceeds the initial one-page
  // memory, which the old layout could not even instantiate.
  for (const length of [900, 960, 1024, 3127, 4096, 16384, 70000]) {
    it(`round-trips a ${length}-char literal without corruption`, async () => {
      const literal = makeLiteral(length);
      const exports = await instantiate(probeSource(literal));
      expect(exports.literalLength()).toBe(length);
      expect(exports.literalChecksum()).toBe(hostChecksum(literal));
    });
  }

  it("keeps several large literals independent when they coexist", async () => {
    const first = makeLiteral(3000, "A");
    const second = makeLiteral(5000, "B");
    const third = makeLiteral(1200, "C");

    const checksumFn = (name: string, literal: string): string => `
export function ${name}(): number {
  const s = ${JSON.stringify(literal)};
  let h = 0;
  for (let i = 0; i < s.length; i = i + 1) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
export function ${name}Length(): number {
  const s = ${JSON.stringify(literal)};
  return s.length;
}`;

    const exports = await instantiate(
      [checksumFn("first", first), checksumFn("second", second), checksumFn("third", third)].join("\n"),
    );

    expect(exports.firstLength()).toBe(first.length);
    expect(exports.secondLength()).toBe(second.length);
    expect(exports.thirdLength()).toBe(third.length);
    expect(exports.first()).toBe(hostChecksum(first));
    expect(exports.second()).toBe(hostChecksum(second));
    expect(exports.third()).toBe(hostChecksum(third));
  });

  it("keeps literals clear of the Ryū tables when the number formatter is linked", async () => {
    // `toString()` pulls in the linear number formatter, which owns its own
    // data segments and its own (higher) heap floor. Literals have to clear
    // both, so the finalizer works off every emitted segment, not just theirs.
    const literal = makeLiteral(40000, "R");
    const exports = await instantiate(`
${probeSource(literal)}
export function formatted(x: number): number {
  return x.toString().length;
}
`);
    expect(exports.literalLength()).toBe(literal.length);
    expect(exports.literalChecksum()).toBe(hostChecksum(literal));
    expect(exports.formatted(12345)).toBe(5);
  });

  it("still allocates above every data segment", async () => {
    // Direct structural check: the bump allocator's first hand-out must not
    // land inside a data segment. Reading it back through `__arena_used`
    // would need the arena exports, so inspect the module instead.
    const { generateLinearModule } = await import("../src/codegen-linear/index.js");
    const { analyzeSource } = await import("../src/checker/index.js");
    const ast = analyzeSource(probeSource(makeLiteral(5000)), "test.ts");
    const mod = generateLinearModule(ast);

    const dataEnd = mod.dataSegments!.reduce((max, seg) => Math.max(max, seg.offset + seg.bytes.length), 0);
    const heapPtr = mod.globals.find((g) => g.name === "__heap_ptr")!;
    const init = heapPtr.init[0];
    expect(init.op).toBe("i32.const");
    expect((init as { value: number }).value).toBeGreaterThanOrEqual(dataEnd);
    // Declared memory minimum must already cover the active segments.
    expect(mod.memories[0].min * 65536).toBeGreaterThanOrEqual(dataEnd);
  });
});
