// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
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
import {
  buildStringConcatDefinition,
  buildStringBatchedConcatDefinition,
  type StringConcatLayout,
} from "../src/runtime/wasmgc/values/string-concat-bodies.js";
import {
  buildStdoutAppendDefinition,
  buildStdoutPrepareDefinition,
  buildStdoutCharDefinition,
} from "../src/runtime/wasmgc/values/stdout-bodies.js";
import { STRING_CONCAT_MANY_NATIVE_ARITY } from "../src/ir/runtime/contracts/manifest.js";
import { ensureNativeBatchedConcat } from "../src/codegen/native-batched-concat.js";
import type { CodegenContext } from "../src/codegen/context/types.js";

type Leaf = { text: string; encoding: "wtf16" | "utf8-guaranteed"; backing?: string; offset?: number };
type Operand = Leaf | { text: string; rope: readonly [Leaf, Leaf] };
const flat = (text: string): Leaf => ({ text, encoding: "wtf16" });
const utf8 = (text: string): Leaf => ({ text, encoding: "utf8-guaranteed" });
const empty = flat("");
const window: Leaf = { text: "Aé€😀", encoding: "wtf16", backing: "!?Aé€😀&Ω", offset: 2 };
const rope: Operand = { text: "rope-é", rope: [flat("rope-"), utf8("é")] };
const lines = ["seq: 6", "par: 6", "elapsed: 0", "undefined"];
type Recipe = { name: string; operands: readonly Operand[]; expected: string; binary: boolean };
const binaryRecipes: Recipe[] = [
  { name: "empty-both", operands: [empty, empty], expected: "", binary: true },
  { name: "empty-left", operands: [empty, flat("right")], expected: "right", binary: true },
  { name: "empty-right", operands: [flat("left"), empty], expected: "left", binary: true },
  { name: "short", operands: [flat("ab"), flat("cd")], expected: "abcd", binary: true },
  ...[63, 64, 65].map(
    (n): Recipe => ({
      name: "threshold-" + n,
      operands: [flat("a".repeat(31)), flat("b".repeat(n - 31))],
      expected: "a".repeat(31) + "b".repeat(n - 31),
      binary: true,
    }),
  ),
  { name: "utf16-window", operands: [window, flat("!")], expected: "Aé€😀!", binary: true },
  { name: "utf8-unicode", operands: [utf8("Aé€😀"), utf8("Ω")], expected: "Aé€😀Ω", binary: true },
  { name: "mixed-encoding", operands: [utf8("é"), flat("\ud800")], expected: "é\ud800", binary: true },
  { name: "rope-input", operands: [rope, window], expected: "rope-éAé€😀", binary: true },
  { name: "empty-rope", operands: [empty, rope], expected: "rope-é", binary: true },
];
const arities = [3, 4, 5, 6, 7, 8] as const;
const batchRecipes: Recipe[] = arities.flatMap((arity) =>
  [false, true].map((long): Recipe => {
    const operands: Operand[] = [window, rope, utf8(long ? "€".repeat(65) : "€")];
    for (let i = 3; i < arity; i++) operands.push(flat(String(i)));
    return {
      name: "batch-" + arity + (long ? "-rope" : "-flat"),
      operands,
      expected: operands.map((x) => x.text).join(""),
      binary: false,
    };
  }),
);
const recipes = [...binaryRecipes, ...batchRecipes];
const leaves = (operand: Operand): readonly Leaf[] => ("rope" in operand ? operand.rope : [operand]);
const units = (text: string) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function issuedModule(emptyIdentity: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const literalRows = [
    empty,
    flat("undefined"),
    window,
    flat("\n"),
    ...lines.map(flat),
    flat("identity"),
    ...recipes.flatMap((r) => r.operands.flatMap(leaves)),
  ];
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "output:strings",
    utf8Storage: true,
    literals: literalRows.map((row) => ({ value: row.backing ?? row.text, encoding: row.encoding })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "output:flatten", strings);
  const l = strings.layout;
  const layout: StringConcatLayout = {
    strTypeIdx: l.nativeStrTypeIdx,
    strDataTypeIdx: l.nativeStrDataTypeIdx,
    anyStrTypeIdx: l.anyStrTypeIdx,
    consStrTypeIdx: l.consStrTypeIdx,
  };
  const strRef: ValType = { kind: "ref", typeIdx: layout.anyStrTypeIdx };
  const concat = tx.reserveFunction("output:concat", "__str_concat", { params: [strRef, strRef], results: [strRef] });
  const batches = arities.map((arity) =>
    tx.reserveFunction("output:batch:" + arity, "__str_concat_" + arity, {
      params: Array.from({ length: arity }, () => ({ ...strRef })),
      results: [{ ...strRef }],
    }),
  );
  const accumulator = tx.reserveGlobal(
    "output:acc",
    "__stdout_acc",
    { kind: "ref_null", typeIdx: layout.anyStrTypeIdx },
    true,
  );
  const buffer = tx.reserveGlobal(
    "output:flat",
    "__stdout_flat",
    { kind: "ref_null", typeIdx: layout.strTypeIdx },
    true,
  );
  const append = tx.reserveFunction("output:append", "__stdout_append", {
    params: [{ kind: "ref_null", typeIdx: layout.anyStrTypeIdx }],
    results: [],
  });
  const prepare = tx.reserveFunction("output:prepare", "__stdout_prepare", { params: [], results: [{ kind: "i32" }] });
  const char = tx.reserveFunction("output:char", "__stdout_char", {
    params: [{ kind: "i32" }],
    results: [{ kind: "i32" }],
  });
  const probes = recipes.map((row) =>
    tx.reserveFunction("output:probe:" + row.name, row.name, {
      params: [],
      results: Array.from({ length: 2 + row.expected.length }, () => ({ kind: "i32" as const })),
    }),
  );
  const identity = tx.reserveFunction("output:identity", "empty_identity", { params: [], results: [{ kind: "i32" }] });
  const appends = [flat(""), window, ...lines.map(flat)].map((_, i) =>
    tx.reserveFunction("output:append-probe:" + i, "append_" + i, { params: [], results: [] }),
  );
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  expect(requireCompletedNativeStringFlatten(tx, flatten, strings)).toBe(flatten);
  function literal(row: Leaf): Instr[] {
    const binding = requireNativeStringLiteral(tx, strings, row.backing ?? row.text, row.encoding);
    if (binding.kind !== "global") throw Error("bounded output literal must be a genuine issued global");
    const load: Instr[] = [{ op: "global.get", index: tx.physicalIndex(binding.global) }];
    if (row.offset === undefined) return load;
    if (row.encoding !== "wtf16") throw Error("this fixture's explicit subview is UTF-16");
    return [
      { op: "i32.const", value: row.text.length },
      { op: "i32.const", value: row.offset },
      ...load,
      { op: "struct.get", typeIdx: layout.strTypeIdx, fieldIdx: 2 },
      { op: "struct.new", typeIdx: layout.strTypeIdx },
    ];
  }
  function operand(row: Operand): Instr[] {
    if (!("rope" in row)) return literal(row);
    return [
      { op: "i32.const", value: row.text.length },
      ...literal(row.rope[0]),
      ...literal(row.rope[1]),
      { op: "struct.new", typeIdx: layout.consStrTypeIdx },
    ];
  }
  tx.fillFunction(concat, buildStringConcatDefinition(layout, { flattenIdx: flatten.flatten.handle, emptyIdentity }));
  arities.forEach((arity, i) =>
    tx.fillFunction(
      batches[i]!,
      buildStringBatchedConcatDefinition(layout, arity, {
        flattenIdx: flatten.flatten.handle,
        concatIdx: concat.handle,
        undefinedLiterals: Array.from({ length: arity }, () => literal(flat("undefined"))),
      }),
    ),
  );
  tx.fillGlobal(accumulator, [{ op: "ref.null", typeIdx: layout.anyStrTypeIdx }]);
  tx.fillGlobal(buffer, [{ op: "ref.null", typeIdx: layout.strTypeIdx }]);
  tx.fillFunction(
    append,
    buildStdoutAppendDefinition({ accGlobalIdx: tx.physicalIndex(accumulator), concatIdx: concat.handle }),
  );
  tx.fillFunction(
    prepare,
    buildStdoutPrepareDefinition({
      accGlobalIdx: tx.physicalIndex(accumulator),
      flatGlobalIdx: tx.physicalIndex(buffer),
      flatTypeIdx: layout.strTypeIdx,
      flattenIdx: flatten.flatten.handle,
    }),
  );
  tx.fillFunction(
    char,
    buildStdoutCharDefinition({
      flatGlobalIdx: tx.physicalIndex(buffer),
      flatTypeIdx: layout.strTypeIdx,
      dataTypeIdx: layout.strDataTypeIdx,
    }),
  );
  recipes.forEach((row, i) => {
    const target = row.binary ? concat : batches[arities.indexOf(row.operands.length as (typeof arities)[number])]!;
    if (!target) throw Error("missing exact batch target");
    tx.fillFunction(probes[i]!, {
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: layout.anyStrTypeIdx } },
        { name: "flat", type: { kind: "ref_null", typeIdx: layout.strTypeIdx } },
      ],
      body: [
        ...row.operands.flatMap(operand),
        { op: "call", funcIdx: target.handle },
        { op: "local.set", index: 0 },
        { op: "local.get", index: 0 },
        { op: "ref.test", typeIdx: layout.consStrTypeIdx },
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: flatten.flatten.handle },
        { op: "local.set", index: 1 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: layout.strTypeIdx, fieldIdx: 0 },
        ...units(row.expected).flatMap((_, index): Instr[] => [
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: layout.strTypeIdx, fieldIdx: 2 },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: layout.strTypeIdx, fieldIdx: 1 },
          { op: "i32.const", value: index },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: layout.strDataTypeIdx },
        ]),
      ],
    });
    tx.defineExport("export:" + row.name, row.name, probes[i]!);
  });
  tx.fillFunction(identity, {
    locals: [],
    body: [
      ...literal(empty),
      ...literal(flat("identity")),
      { op: "call", funcIdx: concat.handle },
      ...literal(flat("identity")),
      { op: "ref.eq" },
    ],
  });
  appends.forEach((token, i) =>
    tx.fillFunction(token, {
      locals: [],
      body:
        i === 0
          ? [
              { op: "ref.null", typeIdx: layout.anyStrTypeIdx },
              { op: "call", funcIdx: append.handle },
            ]
          : i === 1
            ? [...literal(window), { op: "call", funcIdx: append.handle }]
            : [
                ...literal(flat(lines[i - 2]!)),
                ...literal(flat("\n")),
                { op: "call", funcIdx: concat.handle },
                { op: "call", funcIdx: append.handle },
              ],
    }),
  );
  for (const token of [prepare, char, identity, ...appends])
    tx.defineExport("export:" + token.object.name, token.object.name, token);
  expect(requireCompletedNativeStringFlatten(tx, flatten, strings)).toBe(flatten);
  const census = tx.seal();
  return { module, layout, census, concat, batches, probes, prepare, char };
}

function compileFixture(emptyIdentity: boolean) {
  const state = issuedModule(emptyIdentity);
  const binary = Uint8Array.from(emitBinary(state.module));
  const compiled = new WebAssembly.Module(binary);
  const imports = WebAssembly.Module.imports(compiled),
    exports = WebAssembly.Module.exports(compiled);
  expect(imports).toEqual([]);
  expect(exports.map((e) => e.name)).toEqual([
    ...recipes.map((r) => r.name),
    "__stdout_prepare",
    "__stdout_char",
    "empty_identity",
    ...Array.from({ length: 6 }, (_, i) => "append_" + i),
  ]);
  const artifact = {
    scope: "canonical output bodies + genuine issued literal/flatten resources; not prepared consumer admission",
    emptyIdentity,
    recipes,
    node: process.version,
    versions: process.versions,
    binary: Buffer.from(binary).toString("base64"),
    instantiatedBinary: Buffer.from(binary).toString("base64"),
    binarySha256: digest(binary),
    wat: emitWat(state.module),
    imports,
    exports,
    census: state.census,
    functionOrder: state.module.functions.map((f) => f.name),
  };
  const parent = resolve(import.meta.dirname, "..", ".tmp");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "native-string-output-"));
  writeFileSync(resolve(directory, "artifact.json"), JSON.stringify(artifact, null, 2));
  return { ...state, compiled, artifact, directory };
}
const fixtures = new Map<boolean, { value: ReturnType<typeof compileFixture> } | { error: unknown }>();
function fixture(emptyIdentity: boolean) {
  let entry = fixtures.get(emptyIdentity);
  if (!entry) {
    try {
      entry = { value: compileFixture(emptyIdentity) };
    } catch (error) {
      entry = { error };
    }
    fixtures.set(emptyIdentity, entry);
  }
  if ("error" in entry) throw entry.error;
  return entry.value;
}
function call(exports: WebAssembly.Exports, name: string, ...args: number[]) {
  const fn = exports[name];
  if (typeof fn !== "function") throw Error("missing actual export " + name);
  return fn(...args);
}
function readStdout(exports: WebAssembly.Exports): string {
  const length = call(exports, "__stdout_prepare");
  if (!Number.isSafeInteger(length) || length < 0) throw Error("invalid stdout length");
  return Array.from({ length }, (_, i) => String.fromCharCode(call(exports, "__stdout_char", i))).join("");
}
function expectedRope(row: Recipe, emptyIdentity: boolean) {
  if (emptyIdentity && row.binary) {
    if (!row.operands[0]!.text.length) return Number("rope" in row.operands[1]!);
    if (!row.operands[1]!.text.length) return Number("rope" in row.operands[0]!);
  }
  return Number(row.expected.length >= 64);
}

describe("real canonical string-output execution", () => {
  it("pins the complete supported arity and recipe denominator", () => {
    expect(STRING_CONCAT_MANY_NATIVE_ARITY).toEqual({ min: 3, max: 8 });
    expect(binaryRecipes).toHaveLength(12);
    expect(batchRecipes).toHaveLength(12);
    expect(new Set(recipes.map((r) => r.name)).size).toBe(24);
    expect(units(window.text)).toEqual([65, 233, 8364, 55357, 56832]);
  });
  for (const emptyIdentity of [false, true]) {
    it.each(recipes)("executes $name with empty identity " + emptyIdentity, (row) => {
      const f = fixture(emptyIdentity),
        observations = [];
      expect(f.artifact.binary).toBe(f.artifact.instantiatedBinary);
      for (let instance = 0; instance < 2; instance++) {
        const exports = new WebAssembly.Instance(f.compiled, {}).exports;
        for (let repetition = 0; repetition < 2; repetition++) {
          const value = call(exports, row.name);
          observations.push({ instance, repetition, name: row.name, value });
          expect(value).toEqual([expectedRope(row, emptyIdentity), row.expected.length, ...units(row.expected)]);
        }
      }
      expect(observations).toHaveLength(4);
      writeFileSync(resolve(f.directory, row.name + ".json"), JSON.stringify(observations, null, 2));
    });
    it("executes real empty-identity choice " + emptyIdentity, () => {
      const f = fixture(emptyIdentity);
      for (let instance = 0; instance < 2; instance++) {
        const exports = new WebAssembly.Instance(f.compiled, {}).exports;
        expect(call(exports, "empty_identity")).toBe(Number(emptyIdentity));
        expect(call(exports, "empty_identity")).toBe(Number(emptyIdentity));
      }
    });
    it("reads real stdout null/bounds/offset/four-newline joins " + emptyIdentity, () => {
      const f = fixture(emptyIdentity),
        observations = [];
      for (let instance = 0; instance < 2; instance++) {
        const exports = new WebAssembly.Instance(f.compiled, {}).exports;
        expect(call(exports, "__stdout_char", 0)).toBe(0); // null prepared buffer
        expect(readStdout(exports)).toBe("");
        call(exports, "append_0"); // genuine nullable append signature
        expect(readStdout(exports)).toBe("");
        call(exports, "append_1"); // first assignment keeps the nonzero flat offset
        expect(readStdout(exports)).toBe(window.text);
        let expected = window.text;
        for (let repetition = 0; repetition < 2; repetition++) {
          for (let line = 0; line < 4; line++) call(exports, "append_" + (line + 2));
          expected += lines.join("\n") + "\n";
          call(exports, "append_0");
          const value = readStdout(exports);
          observations.push({ instance, repetition, value });
          expect(value).toBe(expected);
          expect(readStdout(exports)).toBe(expected);
          for (const index of [-1, -2147483648, expected.length, expected.length + 1])
            expect(call(exports, "__stdout_char", index)).toBe(0);
        }
      }
      writeFileSync(resolve(f.directory, "stdout.json"), JSON.stringify(observations, null, 2));
    });
  }
  it("keeps real nonnullable batch input signatures; null injection is not a successful guard execution", () => {
    const f = fixture(true),
      mutant = structuredClone(f.module);
    const target = f.batches[0]!;
    const type = f.module.types[target.object.typeIdx]!;
    if (type.kind !== "func") throw Error("batch signature unavailable");
    expect(type.params).toEqual(Array.from({ length: 3 }, () => ({ kind: "ref", typeIdx: f.layout.anyStrTypeIdx })));
    const probe = mutant.functions[f.module.functions.indexOf(f.probes[0]!.object)]!;
    probe.body = [
      { op: "ref.null", typeIdx: f.layout.anyStrTypeIdx },
      { op: "ref.null", typeIdx: f.layout.anyStrTypeIdx },
      { op: "ref.null", typeIdx: f.layout.anyStrTypeIdx },
      { op: "call", funcIdx: target.handle },
      { op: "drop" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
    ];
    expect(() => new WebAssembly.Module(Uint8Array.from(emitBinary(mutant)))).toThrow(WebAssembly.CompileError);
  });
});

describe("builder detachment and legacy bounded registration", () => {
  const layout: StringConcatLayout = { strTypeIdx: 2, strDataTypeIdx: 0, anyStrTypeIdx: 1, consStrTypeIdx: 3 };
  const literal = (): Instr[] => [
    { op: "block", blockType: { kind: "empty" }, body: [{ op: "global.get", index: 9 }] },
  ];
  it("detaches all five definitions across calls, including nested literal dependencies", () => {
    const dependencies = Array.from({ length: 3 }, literal);
    const builders = [
      () => buildStringConcatDefinition(layout, { flattenIdx: 10, emptyIdentity: true }),
      () =>
        buildStringBatchedConcatDefinition(layout, 3, {
          flattenIdx: 10,
          concatIdx: 11,
          undefinedLiterals: dependencies,
        }),
      () => buildStdoutAppendDefinition({ accGlobalIdx: 12, concatIdx: 11 }),
      () => buildStdoutPrepareDefinition({ accGlobalIdx: 12, flatGlobalIdx: 13, flatTypeIdx: 2, flattenIdx: 10 }),
      () => buildStdoutCharDefinition({ flatGlobalIdx: 13, flatTypeIdx: 2, dataTypeIdx: 0 }),
    ];
    const collect = (root: unknown) => {
      const objects = new Set<object>();
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object" || objects.has(value)) return;
        objects.add(value);
        for (const entry of Object.values(value)) visit(entry);
      };
      visit(root);
      return objects;
    };
    for (const build of builders) {
      const a = build(),
        b = build();
      expect(a).toEqual(b);
      const owned = collect(a),
        others = collect([b, dependencies]);
      expect([...owned].filter((x) => others.has(x))).toEqual([]);
      a.body.length = 0;
      expect(b.body.length).toBeGreaterThan(0);
    }
    expect(builders.map((build) => build().locals.length)).toEqual([6, 3, 0, 0, 1]);
  });
  it.each(["missing", "extra", "hole"] as const)("rejects %s literal population", (kind) => {
    const make = () => ({ flattenIdx: 10, concatIdx: 11, undefinedLiterals: Array.from({ length: 3 }, literal) });
    expect(buildStringBatchedConcatDefinition(layout, 3, make()).body.length).toBeGreaterThan(0);
    const deps = make();
    if (kind === "missing") deps.undefinedLiterals.pop();
    if (kind === "extra") deps.undefinedLiterals.push(literal());
    if (kind === "hole") {
      Reflect.deleteProperty(deps.undefinedLiterals, 1);
      expect(Object.hasOwn(deps.undefinedLiterals, 1)).toBe(false);
    }
    expect(() => buildStringBatchedConcatDefinition(layout, 3, deps)).toThrow();
  });
  it("retains out-of-range refusal before touching the legacy context", () => {
    const ctx = new Proxy({} as CodegenContext, {
      get() {
        throw Error("out-of-range helper touched context");
      },
    });
    for (const arity of [0, 1, 2, 9, 16]) expect(ensureNativeBatchedConcat(ctx, arity)).toBeUndefined();
  });
  it("retains each already registered arity without allocating or reading layouts", () => {
    const helpers = new Map(arities.map((arity) => ["__str_concat_" + arity, 100 + arity]));
    const ctx = new Proxy({} as CodegenContext, {
      get(_target, key) {
        if (key === "nativeStrHelpers") return helpers;
        throw Error("cached helper touched " + String(key));
      },
    });
    for (const arity of arities) expect(ensureNativeBatchedConcat(ctx, arity)).toBe(100 + arity);
  });
});
