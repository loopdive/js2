// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireCompletedNativeStringFlatten,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import { buildStringUtf8ToFlatDefinition } from "../src/runtime/wasmgc/values/string-utf8-decode-bodies.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";

// The complete repaired canonical source, not a substitute decoder or a runtime Git dependency.
const DECODER_SHA256 = "119976d2b5c593dc05b22ed82df454537d3b0bed9395e9ae47ef7dbac64bb748";
const decoderURL = new URL("../src/runtime/wasmgc/values/string-utf8-decode-bodies.ts", import.meta.url);
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const payloads = [
  { name: "empty", text: "", units: [] },
  { name: "ascii", text: "AZ09", units: [65, 90, 48, 57] },
  { name: "two-byte", text: "é", units: [233] },
  { name: "three-byte", text: "€", units: [8364] },
  { name: "four-byte", text: "😀", units: [55357, 56832] },
  { name: "mixed", text: "Aé€😀", units: [65, 233, 8364, 55357, 56832] },
] as const;
const prefixes = [
  { name: "zero", text: "", byteOffset: 0 },
  { name: "ascii-prefix", text: "^!", byteOffset: 2 },
  { name: "multibyte-prefix", text: "é😀|", byteOffset: 7 },
] as const;
const windows = payloads.flatMap((payload) =>
  prefixes.map((prefix) => ({
    name: `${payload.name}__${prefix.name}`,
    text: payload.text,
    units: [...payload.units],
    prefix: prefix.text,
    suffix: "&Ω",
    byteOffset: prefix.byteOffset,
    byteLength: new TextEncoder().encode(payload.text).length,
    backing: prefix.text + payload.text + "&Ω",
  })),
);
type Module = ReturnType<typeof createEmptyModule>;

function buildIssuedModule() {
  expect(sha256(readFileSync(decoderURL))).toBe(DECODER_SHA256);
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "utf8-window:strings",
    utf8Storage: true,
    literals: [
      { value: "", encoding: "wtf16" },
      ...windows.map((row) => ({ value: row.backing, encoding: "utf8-guaranteed" as const })),
    ],
  });
  const pack = reserveNativeStringFlattenResources(tx, "utf8-window:flatten", strings);
  const probes = windows.map((row) =>
    tx.reserveFunction(`utf8-window:${row.name}`, row.name, {
      params: [],
      // Complete UTF-16 data, including the surrogate pair, plus len/off/array length.
      results: Array.from({ length: 3 + row.units.length }, () => ({ kind: "i32" as const })),
    }),
  );
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, pack);
  expect(requireCompletedNativeStringFlatten(tx, pack, strings)).toBe(pack);
  if (!pack.utf8Decoder) throw Error("issued UTF-8 decoder missing");
  const layout = strings.layout;
  const utf8Type = module.types[layout.utf8StrTypeIdx]!;
  if (utf8Type.kind !== "struct") throw Error("issued UTF-8 layout is not a struct");
  expect(utf8Type.fields.map((field) => field.name)).toEqual(["len", "byteLen", "off", "data"]);
  const definition = buildStringUtf8ToFlatDefinition(layout);
  expect(pack.utf8Decoder.object.locals).toEqual(definition.locals);
  expect(pack.utf8Decoder.object.body).toEqual(definition.body);
  expect(definition.locals).toHaveLength(8);
  windows.forEach((row, i) => {
    const literal = requireNativeStringLiteral(tx, strings, row.backing, "utf8-guaranteed");
    if (literal.kind !== "global") throw Error("UTF-8 window backing must be an issued literal global");
    const getFlat: Instr = { op: "local.get", index: 0 };
    tx.fillFunction(probes[i]!, {
      locals: [{ name: "flat", type: { kind: "ref_null", typeIdx: layout.nativeStrTypeIdx } }],
      body: [
        { op: "i32.const", value: row.units.length },
        { op: "i32.const", value: row.byteLength },
        { op: "i32.const", value: row.byteOffset },
        { op: "global.get", index: tx.physicalIndex(literal.global) },
        { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 3 },
        { op: "struct.new", typeIdx: layout.utf8StrTypeIdx },
        // Call the real owned flatten dispatcher, whose issued decoder was filled above.
        { op: "call", funcIdx: pack.flatten.handle },
        { op: "local.set", index: 0 },
        getFlat,
        { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 0 },
        getFlat,
        { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 1 },
        getFlat,
        { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "array.len" },
        ...row.units.flatMap((_, index): Instr[] => [
          getFlat,
          { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: index },
          { op: "array.get_u", typeIdx: layout.nativeStrDataTypeIdx },
        ]),
      ],
    });
    tx.defineExport(`export:${row.name}`, row.name, probes[i]!);
  });
  expect(requireCompletedNativeStringFlatten(tx, pack, strings)).toBe(pack);
  const census = tx.seal();
  const decoderIndex = module.functions.indexOf(pack.utf8Decoder.object);
  expect(decoderIndex).toBe(1);
  return { module, layout, census, decoderIndex, definition };
}

function execute(module: Module) {
  const binary = Uint8Array.from(emitBinary(module));
  const bytes = Buffer.from(binary).toString("base64");
  const wat = emitWat(module);
  // Compile errors cannot masquerade as successful semantic mutant detection.
  const compiled = new WebAssembly.Module(binary);
  const imports = WebAssembly.Module.imports(compiled);
  const exports = WebAssembly.Module.exports(compiled);
  expect(imports).toEqual([]);
  expect(exports.map((row) => row.name)).toEqual(windows.map((row) => row.name));
  const observations = [];
  for (let instance = 0; instance < 2; instance++) {
    const actual = new WebAssembly.Instance(compiled, {}).exports;
    for (const row of windows) {
      const call = actual[row.name];
      if (typeof call !== "function") throw Error(`missing actual export ${row.name}`);
      for (let repetition = 0; repetition < 2; repetition++) {
        try {
          observations.push({ name: row.name, instance, repetition, outcome: "returned" as const, value: call() });
        } catch (error) {
          if (!(error instanceof WebAssembly.RuntimeError)) throw error;
          observations.push({
            name: row.name,
            instance,
            repetition,
            outcome: "trapped" as const,
            error: { name: error.name, message: error.message, stack: error.stack },
          });
        }
      }
    }
  }
  return {
    bytes,
    instantiatedBytes: Buffer.from(binary).toString("base64"),
    wat,
    imports,
    exports,
    functionOrder: module.functions.map((fn) => fn.name),
    observations,
  };
}
type Execution = ReturnType<typeof execute>;
function mismatches(receipt: Execution) {
  expect(receipt.bytes).toBe(receipt.instantiatedBytes);
  expect(receipt.observations).toHaveLength(72);
  return receipt.observations.filter((observation, index) => {
    const instance = Math.floor(index / 36),
      row = windows[Math.floor((index % 36) / 2)]!;
    expect([observation.name, observation.instance, observation.repetition]).toEqual([row.name, instance, index % 2]);
    return (
      observation.outcome !== "returned" ||
      !isDeepStrictEqual(observation.value, [row.units.length, 0, row.units.length, ...row.units])
    );
  });
}
function persist(label: string, receipt: Execution) {
  const parent = resolve(import.meta.dirname, "..", ".tmp");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "native-utf8-window-"));
  writeFileSync(
    resolve(directory, "receipt.json"),
    JSON.stringify(
      {
        label,
        source: { url: decoderURL.href, sha256: DECODER_SHA256 },
        runtime: { node: process.version, versions: process.versions, execArgv: process.execArgv },
        windows,
        ...receipt,
        mismatches: mismatches(receipt),
        scope: "issued string/flatten resource execution; not whole-program or public compiler preservation",
      },
      null,
      2,
    ),
  );
}
let genuineOutcome:
  | { value: ReturnType<typeof buildIssuedModule> & { receipt: Execution } }
  | { error: unknown }
  | undefined;
function genuine() {
  if (genuineOutcome === undefined) {
    try {
      const issued = buildIssuedModule();
      const receipt = execute(issued.module);
      persist("genuine", receipt);
      genuineOutcome = { value: { ...issued, receipt } };
    } catch (error) {
      genuineOutcome = { error };
    }
  }
  if ("error" in genuineOutcome) throw genuineOutcome.error;
  const value = genuineOutcome.value;
  expect(sha256(readFileSync(decoderURL))).toBe(DECODER_SHA256);
  expect(value.module.functions[value.decoderIndex]!.body).toEqual(value.definition.body);
  expect(value.module.functions[value.decoderIndex]!.locals).toEqual(value.definition.locals);
  expect(mismatches(value.receipt)).toEqual([]);
  return value;
}

function replaceExactlyOne(body: Instr[], before: Instr[], after: Instr[]) {
  const matches: { array: Instr[]; index: number }[] = [];
  const visit = (array: Instr[]) => {
    for (let index = 0; index <= array.length - before.length; index++)
      if (isDeepStrictEqual(array.slice(index, index + before.length), before)) matches.push({ array, index });
    for (const instruction of array) {
      if (instruction.op === "block" || instruction.op === "loop") visit(instruction.body);
      if (instruction.op === "if") {
        visit(instruction.then);
        if (instruction.else) visit(instruction.else);
      }
    }
  };
  visit(body);
  expect(matches).toHaveLength(1);
  matches[0]!.array.splice(matches[0]!.index, before.length, ...after);
}
const mutants = [
  "ignored-offset",
  "wrong-field",
  "no-end-addition",
  "wrong-cursor",
  "wrong-end",
  "changed-continuation-read",
  "output-offset-propagation",
] as const;
function mutate(module: Module, issued: ReturnType<typeof buildIssuedModule>, mode: (typeof mutants)[number]) {
  const body = module.functions[issued.decoderIndex]!.body;
  const { utf8StrTypeIdx: utf8, utf8StrDataTypeIdx: data, nativeStrTypeIdx: flat } = issued.layout;
  const readOffset: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: utf8, fieldIdx: 2 },
  ];
  const start: Instr[] = [...readOffset, { op: "local.tee", index: 5 }];
  const loopTest: Instr[] = [
    { op: "local.get", index: 5 },
    { op: "local.get", index: 2 },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
  ];
  if (mode === "ignored-offset")
    replaceExactlyOne(body, start, [
      { op: "i32.const", value: 0 },
      { op: "local.tee", index: 5 },
    ]);
  else if (mode === "wrong-field")
    replaceExactlyOne(body, start, [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: utf8, fieldIdx: 1 },
      { op: "local.tee", index: 5 },
    ]);
  else if (mode === "no-end-addition")
    replaceExactlyOne(
      body,
      [...start, { op: "local.get", index: 2 }, { op: "i32.add" }, { op: "local.set", index: 2 }],
      [...readOffset, { op: "local.set", index: 5 }],
    );
  else if (mode === "wrong-cursor" || mode === "wrong-end")
    replaceExactlyOne(body, loopTest, [
      { op: "local.get", index: mode === "wrong-cursor" ? 6 : 5 },
      { op: "local.get", index: mode === "wrong-end" ? 1 : 2 },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
    ]);
  else if (mode === "changed-continuation-read") {
    const continuation = (delta: number): Instr[] => [
      { op: "local.get", index: 3 },
      { op: "local.get", index: 5 },
      { op: "i32.const", value: delta },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: data },
      { op: "i32.const", value: 0x3f },
      { op: "i32.and" },
      { op: "i32.or" },
    ];
    replaceExactlyOne(body, continuation(1), continuation(0));
  } else {
    const tail: Instr[] = [
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: flat },
    ];
    replaceExactlyOne(
      body,
      [{ op: "local.get", index: 1 }, { op: "i32.const", value: 0 }, ...tail],
      [{ op: "local.get", index: 1 }, ...readOffset, ...tail],
    );
  }
}

describe("genuine native UTF-8 window decoder", () => {
  it("pins complete payload units and byte offsets independently of decoder output", () => {
    expect(windows).toHaveLength(18);
    expect(payloads).toHaveLength(6);
    for (const row of windows) {
      expect(Array.from({ length: row.text.length }, (_, index) => row.text.charCodeAt(index))).toEqual(row.units);
      expect(new TextEncoder().encode(row.prefix).length).toBe(row.byteOffset);
      expect(row.backing).toBe(row.prefix + row.text + row.suffix);
      expect(row.suffix).not.toBe(row.prefix);
    }
    expect(prefixes[2].text.length).toBe(4);
    expect(prefixes[2].byteOffset).toBe(7);
  });
  it.each(windows)("decodes $name completely twice in each of two instances", (row) => {
    const { receipt } = genuine();
    const observations = receipt.observations.filter((item) => item.name === row.name);
    expect(observations).toHaveLength(4);
    for (const observation of observations) {
      expect(observation.outcome).toBe("returned");
      if (observation.outcome === "returned")
        expect(observation.value).toEqual([row.units.length, 0, row.units.length, ...row.units]);
    }
  });
  it("clones the genuine full module without changing decoder body, bytes, WAT or observations", () => {
    const issued = genuine();
    const clone = structuredClone(issued.module);
    expect(clone).toEqual(issued.module);
    expect(clone.functions[issued.decoderIndex]!.body).not.toBe(issued.module.functions[issued.decoderIndex]!.body);
    expect(execute(clone)).toEqual(issued.receipt);
  });
  it.each(mutants)("rejects semantic mutant %s after the exact genuine positive", (mode) => {
    const issued = genuine();
    const clone = structuredClone(issued.module);
    expect(clone).toEqual(issued.module);
    mutate(clone, issued, mode);
    expect(clone.functions[issued.decoderIndex]!.body).not.toEqual(issued.definition.body);
    const receipt = execute(clone);
    persist(mode, receipt);
    expect(mismatches(receipt).length).toBeGreaterThan(0);
    expect(issued.module.functions[issued.decoderIndex]!.body).toEqual(issued.definition.body);
    expect(issued.module.functions[issued.decoderIndex]!.locals).toEqual(issued.definition.locals);
  });
});
