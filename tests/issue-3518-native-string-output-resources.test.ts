// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
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
import {
  declareNativeStringOutputResources,
  reserveNativeStringOutputResources,
  requireNativeStringOutputReservations,
  nativeStringOutputReservationInventory,
  fillNativeStringOutputResources,
  requireCompletedNativeStringOutput,
  publishNativeStringOutput,
} from "../src/backend/wasmgc/resources/native-string-output.js";
import { planNativeStringOutputResources } from "../src/backend/wasmgc/program/native-string-output.js";
import { deriveNativeStringOutputRequirements } from "../src/ir/program/native-string-output-requirements.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { IR_STRING_CONCAT_FN, irStringConcatManySymbol } from "../src/ir/core/string-callables.js";
import { STRING_CONCAT_RUNTIME_PROVIDERS, STRING_CONCAT_MANY_RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
} from "../src/ir/runtime/native-async-callables.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";

let baseProgram: PreparedIrProgram | undefined;
// These complete model fixtures authenticate descriptive requirements. They do
// not assert prepared-program acceptance; execution below uses the real ledger.
function requirementFixture(
  selection = { binaryConcat: true, batchArities: [3, 4, 5, 6, 7, 8], stdout: true },
  emptyIdentity = true,
) {
  const base = (baseProgram ??= requireProgram(prepareTypedIrProgram(sourcePacket().packet, typedOptions)));
  const string = { kind: "string" } as const;
  const values = Array.from({ length: 8 }, (_, i) => asValueId(100 + i));
  const instructions: IrInstr[] = values.map((result, i) => ({
    kind: "string.const",
    value: String(i),
    result,
    resultType: string,
  }));
  if (selection.binaryConcat)
    instructions.push({
      kind: "string.concat",
      lhs: values[0]!,
      rhs: values[1]!,
      result: asValueId(110),
      resultType: string,
      provider: irIntrinsicFuncRef(IR_STRING_CONCAT_FN),
    });
  selection.batchArities.forEach((arity, i) =>
    instructions.push({
      kind: "call",
      target: irIntrinsicFuncRef(irStringConcatManySymbol(arity)),
      args: values.slice(0, arity),
      result: asValueId(120 + i),
      resultType: string,
    }),
  );
  const stdout = NATIVE_ASYNC_CALLABLE_DECLARATIONS.find((row) => row.feature === "async.native.console-append")!;
  if (selection.stdout) instructions.push({ kind: "call", target: stdout.ref, args: [values[0]!], result: null });
  const functions = base.ir.functions.map((fn, i) =>
    i ? fn : { ...fn, blocks: [{ ...fn.blocks[0]!, instrs: instructions }] },
  );
  const providers = [
    ...STRING_CONCAT_RUNTIME_PROVIDERS,
    ...STRING_CONCAT_MANY_RUNTIME_PROVIDERS,
    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  ].filter(
    (row) =>
      ["js.string.concat", "js.string.concat.many", "async.native.console-append"].includes(row.feature) &&
      ["runtime-callable", "runtime-callable-family"].includes(row.implementation.kind),
  );
  const projection = {
    ...base.runtime[0]!,
    prepared: {
      ...base.runtime[0]!.prepared,
      functions,
      manifest: {
        ...base.runtime[0]!.prepared.manifest,
        policy: {
          target: "standalone",
          backend: "wasmgc",
          stringConst: { storage: "native" },
          stringConcat: { concat: "native" },
        },
        providers,
        features: providers.map((row) => row.feature),
      },
    },
  } as PreparedIrProgram["runtime"][number];
  const program = { ...base, ir: { ...base.ir, functions }, runtime: [projection] };
  const demands = collectNativeStringValueDemands(program, projection);
  const requirements = deriveNativeStringOutputRequirements(demands, { emptyIdentity });
  if ("kind" in requirements) throw Error(requirements.detail);
  return { requirements, program, instructions };
}
const keys = { key: "output", stringKey: "output:strings", flattenKey: "output:flatten" };

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

function issuedModule(emptyIdentity: boolean, utf8Storage: boolean) {
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
    utf8Storage,
    literals: literalRows.map((row) => ({
      value: row.backing ?? row.text,
      encoding: utf8Storage ? row.encoding : "wtf16",
    })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "output:flatten", strings);
  const l = strings.layout;
  const layout: StringConcatLayout = {
    strTypeIdx: l.nativeStrTypeIdx,
    strDataTypeIdx: l.nativeStrDataTypeIdx,
    anyStrTypeIdx: l.anyStrTypeIdx,
    consStrTypeIdx: l.consStrTypeIdx,
  };
  const { requirements } = requirementFixture(undefined, emptyIdentity);
  const plan = planNativeStringOutputResources(requirements, keys);
  const output = reserveNativeStringOutputResources(tx, requirements, plan, { strings, flatten });
  const { concat } = output,
    batches = output.batches.map((row) => row.function);
  const { accumulator, flat: buffer, append, prepare, char } = output.stdout!;
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
    const binding = requireNativeStringLiteral(
      tx,
      strings,
      row.backing ?? row.text,
      utf8Storage ? row.encoding : "wtf16",
    );
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
  fillNativeStringOutputResources(tx, output);
  expect(requireCompletedNativeStringOutput(tx, output)).toBe(output);
  expect(concat.object.locals).toEqual(
    buildStringConcatDefinition(layout, { flattenIdx: flatten.flatten.handle, emptyIdentity }).locals,
  );
  expect(concat.object.body).toEqual(
    buildStringConcatDefinition(layout, { flattenIdx: flatten.flatten.handle, emptyIdentity }).body,
  );
  output.batches.forEach(({ arity, function: token }) =>
    expect({ locals: token.object.locals, body: token.object.body }).toEqual(
      buildStringBatchedConcatDefinition(layout, arity, {
        flattenIdx: flatten.flatten.handle,
        concatIdx: concat.handle,
        undefinedLiterals: Array.from({ length: arity }, () => literal(flat("undefined"))),
      }),
    ),
  );
  for (const [token, definition] of [
    [append, buildStdoutAppendDefinition({ accGlobalIdx: tx.physicalIndex(accumulator), concatIdx: concat.handle })],
    [
      prepare,
      buildStdoutPrepareDefinition({
        accGlobalIdx: tx.physicalIndex(accumulator),
        flatGlobalIdx: tx.physicalIndex(buffer),
        flatTypeIdx: layout.strTypeIdx,
        flattenIdx: flatten.flatten.handle,
      }),
    ],
    [
      char,
      buildStdoutCharDefinition({
        flatGlobalIdx: tx.physicalIndex(buffer),
        flatTypeIdx: layout.strTypeIdx,
        dataTypeIdx: layout.strDataTypeIdx,
      }),
    ],
  ] as const)
    expect({ locals: token.object.locals, body: token.object.body }).toEqual(definition);
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
  publishNativeStringOutput(tx, output);
  for (const token of [identity, ...appends]) tx.defineExport("export:" + token.object.name, token.object.name, token);
  expect(requireCompletedNativeStringFlatten(tx, flatten, strings)).toBe(flatten);
  const census = tx.seal();
  expect(requireCompletedNativeStringOutput(tx, output)).toBe(output);
  return { module, layout, census, concat, batches, probes, prepare, char, output, plan };
}

function compileFixture(emptyIdentity: boolean, utf8Storage: boolean) {
  const state = issuedModule(emptyIdentity, utf8Storage);
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
    scope: "genuine output owner and issued literal/flatten resources; not prepared consumer admission",
    utf8Storage,
    outputPlan: state.plan,
    emptyIdentity,
    recipes,
    node: process.version,
    execArgv: process.execArgv,
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
  const directory = mkdtempSync(resolve(parent, "native-string-output-resources-"));
  writeFileSync(resolve(directory, "artifact.json"), JSON.stringify(artifact, null, 2));
  return { ...state, compiled, artifact, directory };
}
const fixtures = new Map<string, { value: ReturnType<typeof compileFixture> } | { error: unknown }>();
function fixture(emptyIdentity: boolean, utf8Storage: boolean) {
  const key = String(emptyIdentity) + ":" + String(utf8Storage);
  let entry = fixtures.get(key);
  if (!entry) {
    try {
      entry = { value: compileFixture(emptyIdentity, utf8Storage) };
    } catch (error) {
      entry = { error };
    }
    fixtures.set(key, entry);
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
  for (const utf8Storage of [false, true])
    for (const emptyIdentity of [false, true]) {
      it.each(recipes)("executes $name with empty identity " + emptyIdentity + " utf8=" + utf8Storage, (row) => {
        const f = fixture(emptyIdentity, utf8Storage),
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
      it("executes real empty-identity choice " + emptyIdentity + " utf8=" + utf8Storage, () => {
        const f = fixture(emptyIdentity, utf8Storage);
        for (let instance = 0; instance < 2; instance++) {
          const exports = new WebAssembly.Instance(f.compiled, {}).exports;
          expect(call(exports, "empty_identity")).toBe(Number(emptyIdentity));
          expect(call(exports, "empty_identity")).toBe(Number(emptyIdentity));
        }
      });
      it("reads real stdout null/bounds/offset/four-newline joins " + emptyIdentity + " utf8=" + utf8Storage, () => {
        const f = fixture(emptyIdentity, utf8Storage),
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
});

const full = { binaryConcat: true, batchArities: [5], stdout: true };
function setup(selection = full, includeUndefined = true, utf8Storage = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const { requirements, program, instructions } = requirementFixture(selection);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: keys.stringKey,
    utf8Storage,
    literals: [{ value: "", encoding: "wtf16" }, ...(includeUndefined ? [{ value: "undefined" }] : [])],
  });
  const flatten = reserveNativeStringFlattenResources(tx, keys.flattenKey, strings);
  const plan = planNativeStringOutputResources(requirements, keys);
  return { module, tx, requirements, program, instructions, strings, flatten, plan };
}
type Setup = ReturnType<typeof setup>;
function reserve(s: Setup) {
  return reserveNativeStringOutputResources(s.tx, s.requirements, s.plan, s);
}
function finish(s: Setup, output = reserve(s)) {
  s.tx.freezeReservations();
  fillNativeStringLiteralResources(s.tx, s.strings);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  fillNativeStringOutputResources(s.tx, output);
  return output;
}
function coordinates(s: Setup, output: ReturnType<typeof reserve>) {
  return nativeStringOutputReservationInventory(s.tx, output, s.plan).map((token) => ({
    key: token.key,
    kind: token.kind,
    handle: token.kind === "function" ? token.handle : null,
    object: structuredClone(token.object),
  }));
}

describe("one symbolic output recipe and allocator trace", () => {
  for (const preseed of [false, true])
    it("retains explicit/implicit signature lookups with preseed=" + preseed, () => {
      const s = setup();
      const l = s.strings.layout;
      const signatures = [
        { params: [{ kind: "ref_null", typeIdx: l.anyStrTypeIdx }], results: [] },
        { params: [], results: [{ kind: "i32" }] },
        { params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
      ] as const;
      if (preseed)
        signatures.forEach((signature, i) => s.tx.internFunctionType(signature.params, signature.results, "seed:" + i));
      const before = {
        types: s.module.types.length,
        functions: s.module.functions.length,
        globals: s.module.globals.length,
      };
      const trace: unknown[] = [];
      for (const method of ["internFunctionType", "reserveFunction", "reserveGlobal"] as const) {
        const original = s.tx[method].bind(s.tx);
        vi.spyOn(s.tx, method).mockImplementation((...args: never[]) => {
          trace.push([method, ...args]);
          return (original as (...args: never[]) => never)(...args);
        });
      }
      const earlyIndex = vi.spyOn(s.tx, "physicalIndex");
      const output = reserve(s);
      expect(earlyIndex).not.toHaveBeenCalled();
      expect(s.plan.declarations.map((row) => [row.key, row.role])).toEqual([
        ["output:concat", ["output", "concat"]],
        ["output:batch:5", ["output", "batch", "5"]],
        ["output:accumulator", ["output", "stdout-accumulator"]],
        ["output:append", ["output", "stdout-append"]],
        ["output:flat", ["output", "stdout-flat"]],
        ["output:prepare", ["output", "stdout-prepare"]],
        ["output:char", ["output", "stdout-char"]],
      ]);
      expect(
        trace.map((row) => {
          const [method, ...args] = row as unknown[];
          return [method, method === "internFunctionType" ? (args.length === 3 ? args[2] : "<unnamed>") : args[0]];
        }),
      ).toEqual([
        ["reserveFunction", "output:concat"],
        ["internFunctionType", "<unnamed>"],
        ["reserveFunction", "output:batch:5"],
        ["internFunctionType", "<unnamed>"],
        ["reserveGlobal", "output:accumulator"],
        ["internFunctionType", "$stdout_append_type"],
        ["reserveFunction", "output:append"],
        ["internFunctionType", "<unnamed>"],
        ["reserveGlobal", "output:flat"],
        ["internFunctionType", "$stdout_prepare_type"],
        ["reserveFunction", "output:prepare"],
        ["internFunctionType", "<unnamed>"],
        ["internFunctionType", "$stdout_char_type"],
        ["reserveFunction", "output:char"],
        ["internFunctionType", "<unnamed>"],
      ]);
      expect(s.module.types.length - before.types).toBe(preseed ? 2 : 5);
      expect(s.module.functions.length - before.functions).toBe(5);
      expect(s.module.globals.length - before.globals).toBe(2);
      const std = output.stdout!;
      [std.append, std.prepare, std.char].forEach((token, i) => {
        const type = s.module.types[token.object.typeIdx]!;
        expect(type).toMatchObject({
          ...signatures[i],
          name: preseed ? "seed:" + i : ["$stdout_append_type", "$stdout_prepare_type", "$stdout_char_type"][i],
        });
      });
      const rows = nativeStringOutputReservationInventory(s.tx, output, s.plan);
      expect(rows).toHaveLength(7);
      expect(rows.map((row) => row.key)).toEqual(s.plan.declarations.map((row) => row.key));
      expect(Object.isFrozen(rows)).toBe(true);
      expect(rows.every((row) => row !== s.flatten.flatten && !s.strings.types.includes(row as never))).toBe(true);
      finish(s, output);
      expect(s.tx.physicalIndex(output.concat)).toBe(before.functions);
      expect(s.tx.physicalIndex(output.batches[0]!.function)).toBe(before.functions + 1);
      expect(s.tx.physicalIndex(std.accumulator)).toBe(before.globals);
      expect(s.tx.physicalIndex(std.flat)).toBe(before.globals + 1);
      expect(std.accumulator.object).toMatchObject({
        type: { kind: "ref_null", typeIdx: l.anyStrTypeIdx },
        mutable: true,
        init: [{ op: "ref.null", typeIdx: l.anyStrTypeIdx }],
      });
      expect(std.flat.object).toMatchObject({
        type: { kind: "ref_null", typeIdx: l.nativeStrTypeIdx },
        mutable: true,
        init: [{ op: "ref.null", typeIdx: l.nativeStrTypeIdx }],
      });
      expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
      publishNativeStringOutput(s.tx, output);
      expect(s.module.exports.map((row) => row.name)).toEqual(["__stdout_prepare", "__stdout_char"]);
      const census = s.tx.seal();
      expect(census.completedFunctions).toBe(census.functions);
      expect(census.completedGlobals).toBe(census.globals);
      expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
    });
  it("retains first-occurrence batch ordering and every nonnullable operand", () => {
    const s = setup({ binaryConcat: true, batchArities: [8, 3, 5, 4, 7, 6, 8], stdout: false });
    expect(s.plan.batchArities).toEqual([8, 3, 5, 4, 7, 6]);
    const output = reserve(s);
    expect(output.batches.map((row) => row.arity)).toEqual(s.plan.batchArities);
    output.batches.forEach((row) =>
      expect(s.module.types[row.function.object.typeIdx]).toMatchObject({
        params: Array.from({ length: row.arity }, () => ({ kind: "ref", typeIdx: s.strings.layout.anyStrTypeIdx })),
        results: [{ kind: "ref", typeIdx: s.strings.layout.anyStrTypeIdx }],
      }),
    );
  });
});

describe("before-allocation admission and issued owner checks", () => {
  for (const [name, selection] of [
    ["contradictory batch", { ...full, binaryConcat: false }],
    ["contradictory stdout", { binaryConcat: false, batchArities: [], stdout: true }],
    ["duplicate arity", { ...full, batchArities: [3, 3] }],
    ["too small", { ...full, batchArities: [2] }],
    ["too large", { ...full, batchArities: [9] }],
    ["fractional", { ...full, batchArities: [3.1] }],
    ["sparse", { ...full, batchArities: Array(1) }],
    ["nonboolean", { ...full, stdout: 1 }],
  ] as const)
    it("rejects recipe " + name, () => {
      expect(declareNativeStringOutputResources(keys.key, keys.stringKey, full).declarations).toHaveLength(7);
      expect(() => declareNativeStringOutputResources(keys.key, keys.stringKey, selection as typeof full)).toThrow();
    });
  it("rejects empty keys and leaves empty output selection allocation-free", () => {
    for (const pair of [
      ["", keys.stringKey],
      [keys.key, ""],
    ])
      expect(() => declareNativeStringOutputResources(pair[0]!, pair[1]!, full)).toThrow();
    const s = setup({ binaryConcat: false, batchArities: [], stdout: false });
    expect(s.plan.declarations).toEqual([]);
    expect(s.plan.reservationSteps).toEqual([]);
    const before = structuredClone(s.module);
    expect(() => reserve(s)).toThrow("empty output selection");
    expect(s.module).toEqual(before);
    fillNativeStringLiteralResourcesAfterFreeze(s);
    const first = Uint8Array.from(emitBinary(s.module)),
      wat = emitWat(s.module);
    const twin = setup({ binaryConcat: false, batchArities: [], stdout: false });
    fillNativeStringLiteralResourcesAfterFreeze(twin);
    expect(Uint8Array.from(emitBinary(twin.module))).toEqual(first);
    expect(emitWat(twin.module)).toBe(wat);
    expect(s.module.exports).toEqual([]);
    expect(s.module.functions.map((row) => row.name).some((name) => /concat|stdout/.test(name))).toBe(false);
  });
  for (const name of [
    "copied requirements",
    "foreign strings",
    "copied strings",
    "foreign flatten",
    "copied flatten",
    "wrong string key",
    "wrong flatten key",
    "wrong option",
    "recipe signature",
    "recipe order",
  ] as const)
    it("rejects " + name + " before keys/ordinals and permits authentic retry", () => {
      const positive = setup(),
        expected = coordinates(positive, reserve(positive));
      const s = setup(),
        other = setup();
      let requirements = s.requirements,
        plan = s.plan,
        dependencies = { strings: s.strings, flatten: s.flatten };
      if (name === "copied requirements") requirements = { ...requirements };
      if (name === "foreign strings") dependencies.strings = other.strings;
      if (name === "copied strings") dependencies.strings = { ...s.strings };
      if (name === "foreign flatten") dependencies.flatten = other.flatten;
      if (name === "copied flatten") dependencies.flatten = { ...s.flatten };
      if (name === "wrong string key") plan = { ...plan, stringKey: "other" };
      if (name === "wrong flatten key") plan = { ...plan, flattenKey: "other" };
      if (name === "wrong option") plan = { ...plan, options: { emptyIdentity: !plan.options.emptyIdentity } };
      if (name === "recipe signature") {
        const changed = structuredClone(plan);
        const row = changed.declarations[0]!;
        if (row.space !== "function") throw Error("function premise");
        (row.signature.results as unknown[])[0] = { kind: "i32" };
        plan = changed;
      }
      if (name === "recipe order") plan = { ...plan, declarations: [...plan.declarations].reverse() };
      const before = structuredClone(s.module);
      expect(() => reserveNativeStringOutputResources(s.tx, requirements, plan, dependencies)).toThrow();
      expect(s.module).toEqual(before);
      expect(s.tx.state).toBe("reserving");
      expect(coordinates(s, reserve(s))).toEqual(expected);
    });
  it("requires the actual undefined string literal before batch allocation", () => {
    reserve(setup());
    const s = setup(full, false),
      before = structuredClone(s.module);
    expect(() => reserve(s)).toThrow();
    expect(s.module).toEqual(before);
    const binaryOnly = setup({ binaryConcat: true, batchArities: [], stdout: false }, false);
    expect(reserve(binaryOnly).batches).toEqual([]);
  });
  it("rejects stale borrowed input before reservation and on all later owner readers", () => {
    const s = setup(),
      output = reserve(s),
      before = structuredClone(s.module);
    expect(requireNativeStringOutputReservations(s.tx, output)).toBe(output);
    const literal = s.instructions[0]!;
    if (literal.kind !== "string.const") throw Error("literal premise");
    literal.value = "changed";
    for (const reader of [
      () => requireNativeStringOutputReservations(s.tx, output),
      () => nativeStringOutputReservationInventory(s.tx, output, s.plan),
      () => fillNativeStringOutputResources(s.tx, output),
      () => requireCompletedNativeStringOutput(s.tx, output),
    ])
      expect(reader).toThrow();
    expect(s.module).toEqual(before);
    const fresh = setup();
    const instr = fresh.instructions[0]!;
    if (instr.kind !== "string.const") throw Error("literal premise");
    instr.value = "stale-before-reserve";
    const snapshot = structuredClone(fresh.module);
    expect(() => reserve(fresh)).toThrow();
    expect(fresh.module).toEqual(snapshot);
  });
  it("rejects copied packs, foreign ledgers, substituted plan identity and changed retained plan", () => {
    const s = setup();
    const plan = structuredClone(s.plan),
      output = reserveNativeStringOutputResources(s.tx, s.requirements, plan, s);
    expect(requireNativeStringOutputReservations(s.tx, output)).toBe(output);
    expect(() => requireNativeStringOutputReservations(s.tx, { ...output })).toThrow();
    expect(() => requireNativeStringOutputReservations(setup().tx, output)).toThrow();
    expect(() => nativeStringOutputReservationInventory(s.tx, output, { ...plan })).toThrow();
    (plan.options as { emptyIdentity: boolean }).emptyIdentity = false;
    expect(() => requireNativeStringOutputReservations(s.tx, output)).toThrow("changed retained plan");
  });
  it("detects changed prerequisite physical content without allocating output", () => {
    const s = setup();
    s.flatten.flatten.object.typeIdx = -1;
    const before = structuredClone(s.module);
    expect(() => reserve(s)).toThrow();
    expect(s.module).toEqual(before);
  });
});
function fillNativeStringLiteralResourcesAfterFreeze(s: Setup) {
  s.tx.freezeReservations();
  fillNativeStringLiteralResources(s.tx, s.strings);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  s.tx.seal();
}

describe("canonical fill completion and publication", () => {
  it("enforces dependency completion and one canonical fill before publication", () => {
    const s = setup(),
      output = reserve(s);
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow();
    expect(() => requireCompletedNativeStringOutput(s.tx, output)).toThrow();
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
    s.tx.freezeReservations();
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow();
    fillNativeStringLiteralResources(s.tx, s.strings);
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow();
    fillNativeStringFlattenResources(s.tx, s.flatten);
    expect(() => requireCompletedNativeStringOutput(s.tx, output)).toThrow();
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
    expect(s.module.exports).toEqual([]);
    fillNativeStringOutputResources(s.tx, output);
    expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow();
    publishNativeStringOutput(s.tx, output);
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow("duplicate stdout");
    s.tx.seal();
    expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow();
  });
  it("does not mark a partially failed canonical fill complete", () => {
    const s = setup(),
      output = reserve(s);
    s.tx.freezeReservations();
    fillNativeStringLiteralResources(s.tx, s.strings);
    fillNativeStringFlattenResources(s.tx, s.flatten);
    const original = s.tx.fillFunction.bind(s.tx);
    vi.spyOn(s.tx, "fillFunction").mockImplementation((token, definition) => {
      if (token === output.stdout!.prepare) throw Error("injected prepare fill failure");
      original(token, definition);
    });
    expect(() => fillNativeStringOutputResources(s.tx, output)).toThrow("injected prepare fill failure");
    expect(output.concat.object.body.length).toBeGreaterThan(0);
    expect(output.stdout!.prepare.object.body).toEqual([]);
    expect(() => requireCompletedNativeStringOutput(s.tx, output)).toThrow("incomplete");
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
    expect(s.module.exports).toEqual([]);
  });
  it("keeps nonstdout publication a pre-seal no-op", () => {
    const s = setup({ binaryConcat: true, batchArities: [], stdout: false }),
      output = finish(s);
    publishNativeStringOutput(s.tx, output);
    publishNativeStringOutput(s.tx, output);
    expect(s.module.exports).toEqual([]);
    s.tx.seal();
    expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
    expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
  });
  for (const afterSeal of [false, true])
    for (const mutation of [
      "concat body",
      "batch body",
      "append body",
      "prepare body",
      "char body",
      "locals",
      "accumulator initializer",
      "flat initializer",
      "signature",
      "flatten dependency",
    ] as const)
      it("rejects actual " + mutation + " mutation afterSeal=" + afterSeal, () => {
        const s = setup(),
          output = finish(s);
        expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
        if (afterSeal) {
          publishNativeStringOutput(s.tx, output);
          s.tx.seal();
          expect(requireCompletedNativeStringOutput(s.tx, output)).toBe(output);
        }
        const stdout = output.stdout!;
        if (mutation === "concat body") output.concat.object.body.push({ op: "nop" });
        if (mutation === "batch body") output.batches[0]!.function.object.body.push({ op: "nop" });
        if (mutation === "append body") stdout.append.object.body.push({ op: "nop" });
        if (mutation === "prepare body") stdout.prepare.object.body.push({ op: "nop" });
        if (mutation === "char body") stdout.char.object.body.push({ op: "nop" });
        if (mutation === "locals") output.concat.object.locals.push({ name: "unexpected", type: { kind: "i32" } });
        if (mutation === "accumulator initializer") stdout.accumulator.object.init.push({ op: "nop" });
        if (mutation === "flat initializer") stdout.flat.object.init.push({ op: "nop" });
        if (mutation === "signature") {
          const type = s.module.types[stdout.prepare.object.typeIdx]!;
          if (type.kind !== "func") throw Error("signature premise");
          type.results[0] = { kind: "f64" };
        }
        if (mutation === "flatten dependency") s.flatten.flatten.object.body.push({ op: "nop" });
        expect(() => requireCompletedNativeStringOutput(s.tx, output)).toThrow();
        expect(() => publishNativeStringOutput(s.tx, output)).toThrow();
        if (!afterSeal) expect(s.module.exports).toEqual([]);
      });
});

describe("batch operand integrity", () => {
  it("uses a distinct authenticated undefined-literal instruction at each guard", () => {
    const s = setup(),
      output = finish(s);
    const binding = requireNativeStringLiteral(s.tx, s.strings, "undefined");
    if (binding.kind !== "global") throw Error("bounded undefined literal premise");
    const index = s.tx.physicalIndex(binding.global),
      occurrences: object[] = [];
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if ("op" in value && value.op === "global.get" && "index" in value && value.index === index)
        occurrences.push(value);
      for (const child of Object.values(value)) visit(child);
    }
    visit(output.batches[0]!.function.object.body);
    expect(occurrences).toHaveLength(5);
    expect(new Set(occurrences).size).toBe(5);
  });
  it("rejects nullable operands at the real nonnullable batch call boundary", () => {
    const f = fixture(true, true),
      module = structuredClone(f.module),
      probe = module.functions[f.module.functions.indexOf(f.probes[0]!.object)]!;
    expect(call(new WebAssembly.Instance(f.compiled).exports, "empty-both")).toEqual([0, 0]);
    const batch = f.batches[0]!;
    expect(f.module.types[batch.object.typeIdx]).toMatchObject({
      params: Array.from({ length: 3 }, () => ({ kind: "ref", typeIdx: f.layout.anyStrTypeIdx })),
    });
    probe.body = [
      ...Array.from({ length: 3 }, () => ({ op: "ref.null" as const, typeIdx: f.layout.anyStrTypeIdx })),
      { op: "call", funcIdx: batch.handle },
      { op: "drop" },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
    ];
    expect(() => new WebAssembly.Module(Uint8Array.from(emitBinary(module)))).toThrow(WebAssembly.CompileError);
  });
});
