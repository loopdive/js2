// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { emitBinary, emitBinaryWithSourceMap, encodeInstr, type SourceMapEntry } from "../src/emit/binary.js";
import { WasmEncoder } from "../src/emit/encoder.js";
import { createEmptyModule, type Instr, type SourcePos, type WasmModule } from "../src/ir/types.js";

// Encoder unit fixtures, deliberately separate from genuine Prepared-program coverage.
const EMPTY = { kind: "empty" } as const;
const pos = (line: number): SourcePos => ({ file: "recursive.ts", line, column: 3 });
interface Boundary {
  offset: number;
  opcode: number;
  functionIndex: number;
  immediateEnd: number;
}
interface Decoded {
  boundaries: Boundary[];
  bodySizes: number[];
  localGroups: number[];
  codeSize: number;
}

// Independent finite Wasm binary decoder. No encoder/recorder is used as an offset oracle.
function decode(binary: Uint8Array): Decoded {
  let cursor = 8;
  const boundaries: Boundary[] = [];
  const bodySizes: number[] = [];
  const localGroups: number[] = [];
  let codeSize = 0;
  const byte = (): number => {
    if (cursor >= binary.length) throw new Error("truncated binary");
    return binary[cursor++]!;
  };
  const leb = (): number => {
    let value = 0;
    let shift = 0;
    for (let n = 0; n < 5; n++) {
      const b = byte();
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
      shift += 7;
    }
    throw new Error("oversized LEB");
  };
  const signed = (): void => {
    for (let n = 0; n < 10; n++) if (!(byte() & 128)) return;
    throw new Error("oversized signed LEB");
  };
  while (cursor < binary.length) {
    const section = byte();
    const size = leb();
    const sectionEnd = cursor + size;
    if (section !== 10) {
      cursor = sectionEnd;
      continue;
    }
    codeSize = size;
    const count = leb();
    for (let fn = 0; fn < count; fn++) {
      const bodySize = leb();
      bodySizes.push(bodySize);
      const end = cursor + bodySize;
      const groups = leb();
      localGroups.push(groups);
      for (let g = 0; g < groups; g++) {
        leb();
        byte();
      }
      while (cursor < end) {
        const offset = cursor;
        const opcode = byte();
        switch (opcode) {
          case 0x02:
          case 0x03:
          case 0x04:
          case 0x06:
            signed();
            break;
          case 0x1f: {
            signed();
            const catches = leb();
            for (let c = 0; c < catches; c++) {
              const kind = byte();
              if (kind === 0 || kind === 1) leb();
              else if (kind !== 2 && kind !== 3) throw new Error("unknown catch kind");
              leb();
            }
            break;
          }
          case 0x07:
          case 0x08:
          case 0x09:
          case 0x0c:
          case 0x0d:
          case 0x10:
          case 0x20:
          case 0x21:
          case 0x22:
            leb();
            break;
          case 0x41:
          case 0x42:
            signed();
            break;
          case 0x43:
            cursor += 4;
            break;
          case 0x44:
            cursor += 8;
            break;
          case 0xfc:
            if (leb() !== 2) throw new Error("unknown misc instruction");
            break;
          case 0x00:
          case 0x01:
          case 0x05:
          case 0x0b:
          case 0x0f:
          case 0x19:
          case 0x1a:
          case 0x6a:
            break;
          default:
            throw new Error(`unadmitted opcode ${opcode}`);
        }
        if (cursor > end) throw new Error("instruction crosses body boundary");
        boundaries.push({ offset, opcode, functionIndex: fn, immediateEnd: cursor });
      }
      if (cursor !== end || binary[end - 1] !== 0x0b) throw new Error("invalid function boundary");
    }
    if (cursor !== sectionEnd) throw new Error("invalid code section boundary");
  }
  return { boundaries, bodySizes, localGroups, codeSize };
}
interface Occurrence {
  functionIndex: number;
  ordinal: number;
  opcode: number;
  line: number;
}
function verify(binary: Uint8Array, entries: SourceMapEntry[], occurrences: Occurrence[]): void {
  const decoded = decode(binary);
  const expected = occurrences.map(({ functionIndex, ordinal, opcode, line }) => {
    const row = decoded.boundaries.filter((x) => x.functionIndex === functionIndex)[ordinal];
    expect(row, `missing occurrence ${functionIndex}/${ordinal}`).toBeDefined();
    expect(row!.opcode).toBe(opcode);
    return { wasmOffset: row!.offset, sourcePos: pos(line) };
  });
  expect(entries).toEqual(expected);
}
function moduleWith(body: Instr[], result = false): WasmModule {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", params: [], results: result ? [{ kind: "i32" }] : [] });
  mod.functions.push({ name: "probe", typeIdx: 0, locals: [], body, exported: true });
  mod.exports.push({ name: "probe", desc: { kind: "func", index: 0 } });
  return mod;
}
function run(binary: Uint8Array): unknown {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(binary)));
  const fn = instance.exports.probe;
  if (typeof fn !== "function") throw new Error("missing probe export");
  return fn();
}
function mapped(mod: WasmModule, occurrences: Occurrence[], expectedValue: unknown): void {
  const ordinary = emitBinary(mod);
  const first = emitBinaryWithSourceMap(mod);
  expect(first.binary).toEqual(ordinary);
  verify(first.binary, first.sourceMapEntries, occurrences);
  expect(run(ordinary)).toBe(expectedValue);
  expect(run(first.binary)).toBe(expectedValue);
  expect(emitBinary(mod)).toEqual(ordinary);
  expect(emitBinaryWithSourceMap(mod)).toEqual(first);
}

const nested = (): WasmModule =>
  moduleWith(
    [
      {
        op: "block",
        blockType: EMPTY,
        sourcePos: pos(1),
        body: [
          { op: "loop", blockType: EMPTY, body: [{ op: "nop", sourcePos: pos(2) }] },
          { op: "i32.const", value: 1 },
          {
            op: "if",
            blockType: EMPTY,
            sourcePos: pos(3),
            then: [{ op: "nop", sourcePos: pos(4) }],
            else: [{ op: "nop", sourcePos: pos(5) }],
          },
        ],
      },
      { op: "i32.const", value: 23, sourcePos: pos(6) },
    ],
    true,
  );
const nestedOccurrences: Occurrence[] = [
  { functionIndex: 0, ordinal: 0, opcode: 2, line: 1 },
  { functionIndex: 0, ordinal: 2, opcode: 1, line: 2 },
  { functionIndex: 0, ordinal: 5, opcode: 4, line: 3 },
  { functionIndex: 0, ordinal: 6, opcode: 1, line: 4 },
  { functionIndex: 0, ordinal: 8, opcode: 1, line: 5 },
  { functionIndex: 0, ordinal: 11, opcode: 0x41, line: 6 },
];

describe("recursive source-map instruction offsets (encoder unit contract)", () => {
  it("records positioned descendants through block/loop and both if arms without inventing markers", () => {
    mapped(nested(), nestedOccurrences, 23);
  });
  it("records shared object and shared array occurrences independently in two functions", () => {
    const shared: Instr[] = [{ op: "nop", sourcePos: pos(7) }];
    const body: Instr[] = [
      { op: "block", blockType: EMPTY, body: shared },
      { op: "block", blockType: EMPTY, body: shared },
    ];
    const mod = moduleWith(body);
    mod.functions.push({ name: "second", typeIdx: 0, locals: [], body, exported: false });
    const occurrences = [0, 1].flatMap((functionIndex) => [
      { functionIndex, ordinal: 1, opcode: 1, line: 7 },
      { functionIndex, ordinal: 4, opcode: 1, line: 7 },
    ]);
    const before = shared[0];
    mapped(mod, occurrences, undefined);
    expect(mod.functions[0]!.body).toBe(mod.functions[1]!.body);
    expect(shared[0]).toBe(before);
    expect(before!.sourcePos).toEqual(pos(7));
  });
  it("adjusts multi-byte body/code lengths and local groups exactly once, across functions", () => {
    const body: Instr[] = Array.from({ length: 130 }, () => ({ op: "nop" }));
    body.push({
      op: "block",
      blockType: EMPTY,
      body: [{ op: "local.get", index: 129, sourcePos: pos(8) }, { op: "drop" }],
    });
    const mod = moduleWith(body);
    mod.functions[0]!.locals = [
      ...Array.from({ length: 130 }, (_, index) => ({ name: `local${index}`, type: { kind: "i32" } as const })),
      { name: "double", type: { kind: "f64" } },
    ];
    mod.functions.push({
      name: "second",
      typeIdx: 0,
      locals: [],
      body: [{ op: "nop", sourcePos: pos(9) }],
      exported: false,
    });
    const ordinary = emitBinary(mod);
    const decoded = decode(ordinary);
    expect(decoded.bodySizes[0]).toBeGreaterThan(127);
    expect(decoded.codeSize).toBeGreaterThan(127);
    expect(decoded.localGroups).toEqual([2, 0]);
    mapped(
      mod,
      [
        { functionIndex: 0, ordinal: 131, opcode: 0x20, line: 8 },
        { functionIndex: 1, ordinal: 0, opcode: 1, line: 9 },
      ],
      undefined,
    );
  });
  it("binds prefixed and variable-length immediate opcodes rather than their immediate bytes", () => {
    const mod = moduleWith([
      {
        op: "block",
        blockType: EMPTY,
        body: [
          { op: "f64.const", value: 123.5, sourcePos: pos(10) },
          { op: "i32.trunc_sat_f64_s", sourcePos: pos(11) },
          { op: "drop" },
          { op: "i32.const", value: 16384, sourcePos: pos(12) },
          { op: "drop" },
        ],
      },
    ]);
    mapped(
      mod,
      [
        { functionIndex: 0, ordinal: 1, opcode: 0x44, line: 10 },
        { functionIndex: 0, ordinal: 2, opcode: 0xfc, line: 11 },
        { functionIndex: 0, ordinal: 4, opcode: 0x41, line: 12 },
      ],
      undefined,
    );
  });
  it("records legacy try body/tag catch/catch-all, with engine support qualified separately", () => {
    const mod = moduleWith([
      {
        op: "try",
        blockType: EMPTY,
        sourcePos: pos(13),
        body: [{ op: "nop", sourcePos: pos(14) }],
        catches: [{ tagIdx: 0, body: [{ op: "nop", sourcePos: pos(15) }] }],
        catchAll: [{ op: "nop", sourcePos: pos(16) }],
      },
    ]);
    mod.tags.push({ name: "exception", typeIdx: 0 });
    const ordinary = emitBinary(mod);
    const actual = emitBinaryWithSourceMap(mod);
    expect(actual.binary).toEqual(ordinary);
    verify(actual.binary, actual.sourceMapEntries, [
      { functionIndex: 0, ordinal: 0, opcode: 6, line: 13 },
      { functionIndex: 0, ordinal: 1, opcode: 1, line: 14 },
      { functionIndex: 0, ordinal: 3, opcode: 1, line: 15 },
      { functionIndex: 0, ordinal: 5, opcode: 1, line: 16 },
    ]);
    const engineAccepted = WebAssembly.validate(new Uint8Array(ordinary));
    console.log("legacy try engine validation", engineAccepted);
    if (engineAccepted) {
      expect(run(ordinary)).toBeUndefined();
      expect(run(actual.binary)).toBeUndefined();
    }
  });
  it("records standardized try_table descendants without mapping catch-vector immediates", () => {
    const mod = moduleWith([
      {
        op: "block",
        blockType: EMPTY,
        body: [
          {
            op: "try_table",
            blockType: EMPTY,
            catches: [{ kind: "catch_all", depth: 0 }],
            body: [{ op: "nop", sourcePos: pos(17) }],
          },
        ],
      },
    ]);
    mapped(mod, [{ functionIndex: 0, ordinal: 2, opcode: 1, line: 17 }], undefined);
  });
  it.each(["local", "function", "tag"] as const)(
    "retains %s validation in both modes and recovers after exact restoration",
    (space) => {
      const instr: Instr =
        space === "local"
          ? { op: "local.get", index: 0 }
          : space === "function"
            ? { op: "call", funcIdx: 0 }
            : { op: "throw", tagIdx: 0 };
      const mod = moduleWith([
        { op: "block", blockType: EMPTY, body: [instr, ...(space === "local" ? [{ op: "drop" } as Instr] : [])] },
      ]);
      if (space === "local") mod.functions[0]!.locals.push({ name: "value", type: { kind: "i32" } });
      if (space === "tag") mod.tags.push({ name: "exception", typeIdx: 0 });
      expect(emitBinaryWithSourceMap(mod).binary).toEqual(emitBinary(mod));
      if (instr.op === "local.get") instr.index = 999;
      else if (instr.op === "call") instr.funcIdx = 999;
      else if (instr.op === "throw") instr.tagIdx = 999;
      for (const emit of [emitBinary, emitBinaryWithSourceMap]) expect(() => emit(mod)).toThrow(/index out of range/);
      if (instr.op === "local.get") instr.index = 0;
      else if (instr.op === "call") instr.funcIdx = 0;
      else if (instr.op === "throw") instr.tagIdx = 0;
      expect(emitBinaryWithSourceMap(mod).binary).toEqual(emitBinary(mod));
      mapped(
        moduleWith([{ op: "nop", sourcePos: pos(18) }]),
        [{ functionIndex: 0, ordinal: 0, opcode: 1, line: 18 }],
        undefined,
      );
    },
  );
  it.each([false, true])("refuses a cyclic instruction graph in map mode %s and recovers on a fresh module", (map) => {
    const body: Instr[] = [];
    body.push({ op: "block", blockType: EMPTY, body });
    const emit = map ? emitBinaryWithSourceMap : emitBinary;
    expect(() => emit(moduleWith(body))).toThrow(/cyclic instruction-array graph/);
    mapped(
      moduleWith([{ op: "nop", sourcePos: pos(19) }]),
      [{ functionIndex: 0, ordinal: 0, opcode: 1, line: 19 }],
      undefined,
    );
  });
  it("independent verifier rejects a corrupted offset and an omitted nested branch", () => {
    const binary = emitBinary(nested());
    const boundaries = decode(binary).boundaries;
    const valid: SourceMapEntry[] = nestedOccurrences.map((o) => ({
      wasmOffset: boundaries.filter((b) => b.functionIndex === o.functionIndex)[o.ordinal]!.offset,
      sourcePos: pos(o.line),
    }));
    verify(binary, valid, nestedOccurrences);
    const corrupted = valid.map((e) => ({ ...e }));
    corrupted[1]!.wasmOffset++;
    expect(() => verify(binary, corrupted, nestedOccurrences)).toThrow();
    expect(() =>
      verify(
        binary,
        valid.filter((_, index) => index !== 4),
        nestedOccurrences,
      ),
    ).toThrow();
  });
  it("preserves exported standalone two-argument instruction encoding", () => {
    const enc = new WasmEncoder();
    encodeInstr({ op: "i32.const", value: 128 }, enc);
    expect(Array.from(enc.finish())).toEqual([0x41, 0x80, 0x01]);
  });
});
