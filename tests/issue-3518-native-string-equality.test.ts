// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
  requireCompletedNativeStringEquality,
  requireNativeStringEqualityReservations,
  nativeStringEqualityReservationInventory,
} from "../src/backend/wasmgc/resources/native-string-equality.js";
import { buildStringEqualityDefinition } from "../src/runtime/wasmgc/values/string-equality-body.js";
import { emitBinary } from "../src/emit/binary.js";
import { nativeStringLiteralHash } from "../src/runtime/wasmgc/values/string-literal-bodies.js";

const rows = [
  { name: "identity-flat", a: "ab", b: "ab", expected: 1, eager: 0, lazy: 0 },
  { name: "identity-rope", a: "rope", b: "rope", expected: 1, eager: 2, lazy: 0 },
  { name: "unequal-length", a: "rope", b: "a", expected: 0, eager: 1, lazy: 0 },
  { name: "unequal-nonzero-hashes", a: "ab", b: "ac", expected: 0, eager: 0, lazy: 0 },
  { name: "valid-hash-collision", a: "1fuolpc", b: "0egfk4u", expected: 0, eager: 0, lazy: 0 },
  { name: "shifted-slice", a: "slice", b: "ab", expected: 1, eager: 0, lazy: 0 },
  { name: "rope-versus-flat", a: "rope", b: "ab", expected: 1, eager: 1, lazy: 1 },
  { name: "utf8-versus-utf16", a: "utf8", b: "😀", expected: 1, eager: 1, lazy: 1 },
  { name: "surrogate-pair", a: "flat:😀", b: "😀", expected: 1, eager: 0, lazy: 0 },
  { name: "lone-surrogate-equal", a: "flat:\ud800", b: "\ud800", expected: 1, eager: 0, lazy: 0 },
  { name: "zero-hash-equal", a: "zero:ab", b: "ab", expected: 1, eager: 0, lazy: 0 },
  { name: "zero-hash-different", a: "zero:ab", b: "ac", expected: 0, eager: 0, lazy: 0 },
  { name: "lone-surrogate", a: "\ud800", b: "\ud801", expected: 0, eager: 0, lazy: 0 },
] as const;
function reserve(lazy: boolean) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "equality:strings",
    utf8Storage: true,
    literals: [
      ...["", "a", "b", "ab", "ac", "!ab!", "1fuolpc", "0egfk4u", "😀", "\ud800", "\ud801"].map((value) => ({
        value,
        encoding: "wtf16" as const,
      })),
      { value: "😀", encoding: "utf8-guaranteed" },
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "equality:flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, lazy);
  return { module, tx, strings, flatten, equality };
}
function build(lazy: boolean) {
  const s = reserve(lazy);
  const { module, tx, strings, flatten, equality } = s;
  const layout = strings.layout;
  const rope = tx.reserveGlobal("equality:rope", "rope", { kind: "ref", typeIdx: layout.consStrTypeIdx }, false);
  const probes = rows.map((row) =>
    tx.reserveFunction("probe:" + row.name, row.name, { params: [], results: [{ kind: "i32" }] }),
  );
  const memo = tx.reserveFunction("probe:memo", "memo", { params: [], results: [{ kind: "i32" }] });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  fillNativeStringEqualityResources(tx, equality);
  const literal = (text: string, encoding: "wtf16" | "utf8-guaranteed" = "wtf16"): Instr[] => {
    const binding = requireNativeStringLiteral(tx, strings, text, encoding);
    if (binding.kind !== "global") throw Error("global literal required");
    return [{ op: "global.get", index: tx.physicalIndex(binding.global) }];
  };
  tx.fillGlobal(rope, [
    { op: "i32.const", value: 2 },
    ...literal("a"),
    ...literal("b"),
    { op: "struct.new", typeIdx: layout.consStrTypeIdx },
  ]);
  const operand = (name: string): Instr[] => {
    if (name.startsWith("flat:") || name.startsWith("zero:")) {
      const text = name.slice(5);
      return [
        { op: "i32.const", value: text.length },
        { op: "i32.const", value: 0 },
        ...literal(text),
        { op: "ref.cast", typeIdx: layout.nativeStrTypeIdx },
        { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
        ...(name.startsWith("zero:")
          ? [
              { op: "i32.const", value: 0 } as const,
              { op: "i32.const", value: 0 } as const,
              { op: "ref.null", typeIdx: -18 } as const,
              { op: "ref.null", typeIdx: -18 } as const,
              { op: "ref.null", typeIdx: -18 } as const,
            ]
          : []),
        { op: "struct.new", typeIdx: name.startsWith("zero:") ? layout.hashedStrTypeIdx : layout.nativeStrTypeIdx },
      ];
    }
    if (name === "rope") return [{ op: "global.get", index: tx.physicalIndex(rope) }];
    if (name === "utf8") return literal("😀", "utf8-guaranteed");
    if (name === "slice")
      return [
        { op: "i32.const", value: 2 },
        { op: "i32.const", value: 1 },
        ...literal("!ab!"),
        { op: "ref.cast", typeIdx: layout.nativeStrTypeIdx },
        { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "struct.new", typeIdx: layout.nativeStrTypeIdx },
      ];
    return literal(name);
  };
  rows.forEach((row, i) => {
    tx.fillFunction(probes[i]!, {
      locals: [],
      body: [...operand(row.a), ...operand(row.b), { op: "call", funcIdx: equality.equals.handle }],
    });
    tx.defineExport("export:" + row.name, row.name, probes[i]!);
  });
  tx.fillFunction(memo, {
    locals: [{ name: "first", type: { kind: "ref_null", typeIdx: layout.nativeStrTypeIdx } }],
    body: [
      ...operand("rope"),
      { op: "call", funcIdx: flatten.flatten.handle },
      { op: "local.set", index: 0 },
      ...operand("rope"),
      { op: "call", funcIdx: flatten.flatten.handle },
      { op: "local.get", index: 0 },
      { op: "ref.eq" },
      ...operand("rope"),
      { op: "struct.get", typeIdx: layout.consStrTypeIdx, fieldIdx: 2 },
      { op: "struct.get", typeIdx: layout.anyStrTypeIdx, fieldIdx: 0 },
      { op: "i32.eqz" },
      { op: "i32.and" },
    ],
  });
  tx.defineExport("export:memo", "memo", memo);
  requireCompletedNativeStringEquality(tx, equality, strings);
  tx.seal();
  return s;
}
function instantiate(module: ReturnType<typeof createEmptyModule>) {
  const binary = new WebAssembly.Module(Uint8Array.from(emitBinary(module)));
  expect(WebAssembly.Module.imports(binary)).toEqual([]);
  return new WebAssembly.Instance(binary, {}).exports;
}
for (const lazy of [false, true])
  describe(`issued native equality lazy=${lazy}`, () => {
    it.each(rows)("$name uses actual string and flatten resources", (row) => {
      const s = build(lazy);
      const actual = instantiate(s.module);
      expect((actual[row.name] as Function)()).toBe(row.expected);
      // Test-only clone: never presented as an authenticated owner-completed module.
      const observed = structuredClone(s.module);
      const counter = observed.globals.length;
      observed.globals.push({
        name: "observed-flatten-calls",
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });
      observed.exports.push({ name: "flattenCalls", desc: { kind: "global", index: counter } });
      const body = observed.functions[s.tx.physicalIndex(s.flatten.flatten)]!.body;
      observed.functions[s.tx.physicalIndex(s.flatten.flatten)]!.body = [
        { op: "global.get", index: counter },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "global.set", index: counter },
        ...body,
      ];
      const traced = instantiate(observed);
      expect((traced[row.name] as Function)()).toBe(row.expected);
      expect((traced.flattenCalls as WebAssembly.Global).value).toBe(lazy ? row.lazy : row.eager);
    });
    it("real flatten memoizes the rope as the same flat identity", () => {
      const s = build(lazy);
      expect((instantiate(s.module).memo as Function)()).toBe(1);
    });
  });
it("collision fixture uses valid nonzero equal hashes of different same-length strings", () => {
  expect("1fuolpc").not.toBe("0egfk4u");
  expect("1fuolpc".length).toBe("0egfk4u".length);
  expect(nativeStringLiteralHash("1fuolpc")).toBe(nativeStringLiteralHash("0egfk4u"));
  expect(nativeStringLiteralHash("1fuolpc")).not.toBe(0);
});
it("rejects forged/cross-ledger owners after a genuine positive", () => {
  const s = build(true);
  expect(requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toBe(s.equality);
  expect(() => requireCompletedNativeStringEquality(s.tx, { ...s.equality }, s.strings)).toThrow(/forged/);
  const other = build(true);
  expect(() => requireCompletedNativeStringEquality(other.tx, s.equality, other.strings)).toThrow(/foreign/);
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, other.strings)).toThrow(/foreign/);
});
it("rejects missing dependencies and duplicate canonical fill", () => {
  const s = reserve(false);
  s.tx.freezeReservations();
  expect(() => fillNativeStringEqualityResources(s.tx, s.equality)).toThrow();
  fillNativeStringLiteralResources(s.tx, s.strings);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  fillNativeStringEqualityResources(s.tx, s.equality);
  expect(() => fillNativeStringEqualityResources(s.tx, s.equality)).toThrow(/duplicate/);
});
it.each(["body", "layout"])("rejects actual %s mutation after genuine completion", (kind) => {
  const s = build(true);
  requireCompletedNativeStringEquality(s.tx, s.equality, s.strings);
  if (kind === "body") s.equality.equals.object.body.push({ op: "nop" });
  else s.module.types[s.strings.layout.nativeStrTypeIdx]!.name = "altered";
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toThrow();
});

it("authenticates reservation inventory before freeze without claiming completion", () => {
  const s = reserve(true);
  expect(requireNativeStringEqualityReservations(s.tx, s.equality, s.strings)).toBe(s.equality);
  const inventory = nativeStringEqualityReservationInventory(s.tx, s.equality);
  expect(inventory.key).toBe("equality");
  expect(inventory.equals).toBe(s.equality.equals);
  expect(Object.isFrozen(inventory.recipe)).toBe(true);
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toThrow(/missing canonical/);
});
it("rejects external prefill even when its body has the canonical shape", () => {
  const s = reserve(true);
  s.tx.freezeReservations();
  fillNativeStringLiteralResources(s.tx, s.strings);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  s.tx.fillFunction(s.equality.equals, buildStringEqualityDefinition(s.strings.layout, s.flatten.flatten.handle, true));
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toThrow(/missing canonical/);
  expect(() => fillNativeStringEqualityResources(s.tx, s.equality)).toThrow(/duplicate/);
  expect(s.tx.state).toBe("failed");
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toThrow();
});
it.each(["flatten", "copyTree", "utf8Decoder"] as const)("rejects mutated actual %s dependency", (name) => {
  const s = build(true);
  requireCompletedNativeStringEquality(s.tx, s.equality, s.strings);
  const dependency = s.flatten[name];
  expect(dependency).not.toBeNull();
  dependency!.object.body.push({ op: "nop" });
  expect(() => requireCompletedNativeStringEquality(s.tx, s.equality, s.strings)).toThrow();
});
