// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pin: `__linear_ir_str_char_code_at`'s ASCII fast path must not move any
 * observable semantics (#3673).
 *
 * The helper decoded UTF-8 one sequence at a time starting from byte 0, so
 * indexing the i-th UTF-16 code unit was O(i) and an N-character scan was
 * O(N²) — the reason the linear lane measured 184x slower than the GC lane on
 * tokenizing. For a pure-ASCII string the byte index *is* the code-unit index,
 * so the whole decode collapses to one `i32.load8_u`; the verdict is memoised
 * in the string header so it is paid once per string, not once per index.
 *
 * Two levels are pinned, because they reach different code:
 *
 *  - **End to end** through `compile({ target: "linear" })`. Only ASCII gets
 *    here: the IR overlay's `charCodeAt` arm requires an `ascii`-proven
 *    receiver (`src/ir/analysis/encoding.ts`) and rejects anything else with
 *    "Unsupported method call: .charCodeAt()". That predates this change.
 *  - **Directly against the runtime helper**, which is the only way to exercise
 *    the mixed-width decode path — multi-byte scalars, astral surrogate pairs,
 *    and the ASCII-except-the-last-character case that catches a fast path
 *    which samples only the prefix.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addArrayRuntime,
  addLinearIrStringRuntime,
  addRuntime,
  addStringRuntime,
  addUint8ArrayRuntime,
  LINEAR_IR_STRING_CHAR_CODE_AT_FN,
} from "../src/codegen-linear/runtime.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/ir/types.js";

// ── Direct-helper harness ──────────────────────────────────────────────────
// Places the UTF-8 bytes in a data segment, builds the string with
// `__str_from_data`, then calls the helper — the same shape a compiled module
// produces, without needing the overlay to accept the literal.

const SCRATCH = 512;

/**
 * Build a module exporting `charCodeAt(i)` over `literal`, plus `byteLen()`
 * so a test can assert the multi-byte cases really are multi-byte.
 */
async function helperProbe(literal: string): Promise<{
  charCodeAt(index: number): number;
  byteLen(): number;
}> {
  const bytes = new TextEncoder().encode(literal);
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addLinearIrStringRuntime(mod);

  mod.dataSegments.push({ offset: SCRATCH, bytes });

  const funcIdx = (name: string): number => {
    const local = mod.functions.findIndex((f) => f.name === name);
    if (local < 0) throw new Error(`missing runtime function ${name}`);
    return mod.imports.filter((i) => i.desc.kind === "func").length + local;
  };
  const fromData = funcIdx("__str_from_data");
  const charCodeAtIdx = funcIdx(LINEAR_IR_STRING_CHAR_CODE_AT_FN);
  const strLen = funcIdx("__str_len");

  const makeString: Instr[] = [
    { op: "i32.const", value: SCRATCH },
    { op: "i32.const", value: bytes.length },
    { op: "call", funcIdx: fromData },
  ];

  const addExport = (name: string, params: { kind: "f64" }[], results: Instr[], resultType: "f64" | "i32"): void => {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", name: `$type_${name}`, params, results: [{ kind: resultType }] });
    const localIdx = mod.functions.length;
    mod.functions.push({ name, typeIdx, locals: [], body: results, exported: false });
    mod.exports.push({
      name,
      desc: { kind: "func", index: mod.imports.filter((i) => i.desc.kind === "func").length + localIdx },
    });
  };

  addExport(
    "charCodeAt",
    [{ kind: "f64" }],
    [
      ...makeString,
      { op: "local.get", index: 0 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "call", funcIdx: charCodeAtIdx },
    ],
    "f64",
  );
  addExport("byteLen", [], [...makeString, { op: "call", funcIdx: strLen }], "i32");

  const { instance } = await WebAssembly.instantiate(emitBinary(mod), {});
  return instance.exports as unknown as { charCodeAt(index: number): number; byteLen(): number };
}

/** Assert the helper agrees with the host at every index, plus both edges. */
async function expectHelperMatchesHost(literal: string, label: string): Promise<void> {
  const probe = await helperProbe(literal);
  for (let i = 0; i < literal.length; i++) {
    expect(`${label}[${i}]=${probe.charCodeAt(i)}`).toBe(`${label}[${i}]=${literal.charCodeAt(i)}`);
  }
  // §22.1.3.3: an index outside [0, length) yields NaN.
  expect(probe.charCodeAt(-1)).toBeNaN();
  expect(probe.charCodeAt(literal.length)).toBeNaN();
  expect(probe.charCodeAt(literal.length + 5)).toBeNaN();
}

// ── End-to-end harness ─────────────────────────────────────────────────────

async function compiledProbe(literal: string): Promise<(index: number) => number> {
  const result = await compile(
    `
export function at(i: number): number {
  const s = ${JSON.stringify(literal)};
  return s.charCodeAt(i);
}
export function len(): number {
  const s = ${JSON.stringify(literal)};
  return s.length;
}
`,
    { target: "linear" },
  );
  expect(result.errors ?? []).toEqual([]);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.exports as unknown as { at(i: number): number; len(): number };
  expect(exports.len()).toBe(literal.length);
  return (index) => exports.at(index);
}

describe("linear backend: charCodeAt ASCII fast path", { timeout: 60_000 }, () => {
  describe("runtime helper — every width", () => {
    it("matches the host on a pure-ASCII string", async () => {
      const literal = "const answer = 42; // tokenize me";
      const probe = await helperProbe(literal);
      expect(probe.byteLen()).toBe(literal.length); // ASCII: bytes == code units
      await expectHelperMatchesHost(literal, "ascii");
    });

    it("matches the host when a multi-byte scalar makes byteLen > length", async () => {
      // "é" is 2 UTF-8 bytes, "€" is 3 — byteLen and code-unit length diverge,
      // so the fast path must not fire.
      const literal = "aéb€c";
      const probe = await helperProbe(literal);
      expect(probe.byteLen()).toBeGreaterThan(literal.length);
      await expectHelperMatchesHost(literal, "multibyte");
    });

    it("matches the host on an astral pair, surrogate halves included", async () => {
      const literal = "a\u{1F600}b"; // 4-byte scalar -> two UTF-16 code units
      expect(literal.length).toBe(4);
      await expectHelperMatchesHost(literal, "astral");
      const probe = await helperProbe(literal);
      expect(probe.charCodeAt(1)).toBe(0xd83d); // high surrogate
      expect(probe.charCodeAt(2)).toBe(0xde00); // low surrogate
      expect(probe.charCodeAt(3)).toBe("b".charCodeAt(0));
    });

    it("matches the host on a string that is ASCII except its final character", async () => {
      // The guard against a fast path that samples only a prefix: every byte
      // but the last is < 0x80, so a prefix-only check would wrongly claim
      // ASCII and then read the wrong code unit for the tail.
      await expectHelperMatchesHost("plain ascii runway then é", "ascii-then-tail");
    });

    it("matches the host on a string that is ASCII except its first character", async () => {
      await expectHelperMatchesHost("é then plain ascii runway", "tail-then-ascii");
    });

    it("returns NaN for every index of an empty string", async () => {
      const probe = await helperProbe("");
      expect(probe.charCodeAt(0)).toBeNaN();
      expect(probe.charCodeAt(-1)).toBeNaN();
      expect(probe.charCodeAt(1)).toBeNaN();
    });

    it("stays correct when the same string is indexed repeatedly", async () => {
      // The verdict is memoised in the string header, so re-entry has to read
      // back exactly what the first call wrote. Run both widths.
      for (const literal of ["abcdefghij", "aé€b"]) {
        const probe = await helperProbe(literal);
        for (let round = 0; round < 3; round++) {
          for (let i = 0; i < literal.length; i++) expect(probe.charCodeAt(i)).toBe(literal.charCodeAt(i));
        }
      }
    });

    it("matches the host across a long mixed-width string", async () => {
      const literal = `head ${"aé€\u{1F600}".repeat(40)} tail`;
      await expectHelperMatchesHost(literal, "mixed-long");
    });
  });

  describe("end to end through the linear backend", () => {
    it("matches the host on a pure-ASCII literal", async () => {
      const literal = "const answer = 42; // tokenize me";
      const at = await compiledProbe(literal);
      for (let i = 0; i < literal.length; i++) expect(at(i)).toBe(literal.charCodeAt(i));
      expect(at(-1)).toBeNaN();
      expect(at(literal.length)).toBeNaN();
    });

    it("returns NaN for out-of-range indices on a long ASCII literal", async () => {
      const literal = "x".repeat(500);
      const at = await compiledProbe(literal);
      expect(at(0)).toBe(0x78);
      expect(at(499)).toBe(0x78);
      expect(at(500)).toBeNaN();
      expect(at(-1)).toBeNaN();
    });

    it("keeps a full in-wasm scan of a long ASCII literal byte-exact", async () => {
      const literal = Array.from({ length: 2048 }, (_, i) => String.fromCharCode(32 + (i % 95))).join("");
      const result = await compile(
        `
export function checksum(): number {
  const s = ${JSON.stringify(literal)};
  let h = 0;
  for (let i = 0; i < s.length; i = i + 1) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
`,
        { target: "linear" },
      );
      expect(result.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary!, {});
      let expected = 0;
      for (let i = 0; i < literal.length; i++) expected = (expected * 31 + literal.charCodeAt(i)) | 0;
      expect((instance.exports as unknown as { checksum(): number }).checksum()).toBe(expected);
    });
  });
});
