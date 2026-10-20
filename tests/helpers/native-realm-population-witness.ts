// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { liftedAlgorithmFixture, fillLiftedAlgorithmFixture } from "./native-realm-lifted-calls.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  reserveNativeClosureResources,
} from "../../src/backend/wasmgc/resources/native-closures.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  createBuiltinFunctionType,
  BUILTIN_FUNCTION_PROTOTYPE_FIELD,
  BUILTIN_FUNCTION_REALM_FIELD,
  BUILTIN_FUNCTION_INITIAL_NAME_FIELD,
} from "../../src/runtime/wasmgc/values/builtin-function-layouts.js";
import { CLOSURE_BAG_FIELD_IDX } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import { NATIVE_REALM_CATALOG } from "../../src/runtime/contracts/native-realm-catalog.js";
import { buildRealmPopulationDefinition } from "../../src/runtime/wasmgc/values/realm-population-bodies.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
const g = (index: number): Instr => ({ op: "global.get", index });

/** Pure builder operand witness. Observer-only refs are NOT catalog algorithms or production public declarations. */
export function populationOperandWitness(displaced = false, decoded = false) {
  const f = liftedAlgorithmFixture(displaced, decoded),
    { tx } = f;
  const plan = declareNativeClosureResources({
    key: "population-witness:closures",
    startingClosureCounter: 0,
    referenceTypeKeys: f.requests.referenceTypes.map((row) => row.key),
    requests: f.requests.requests,
  });
  const closures = reserveNativeClosureResources(
    tx,
    instantiateNativeClosureRequirements(tx, plan, new Map(f.requests.referenceTypes.map((row) => [row.key, row]))),
    plan,
  );
  const descriptorDependencies = { ...f.dependencies, closures };
  const descriptors = reserveNativeObjectDescriptorResources(
    tx,
    "population-witness:descriptors",
    descriptorDependencies,
    declareNativeObjectDescriptorResources("population-witness:descriptors"),
  );
  const object = tx.reserveGlobal(
    "witness:object-prototype",
    "Object.prototype",
    { kind: "ref_null", typeIdx: f.realmLayouts.types.objectPrototype.typeIndex },
    true,
  );
  const state = tx.reserveGlobal("witness:state", "state", i32, true);
  const mode = tx.reserveGlobal("witness:failure-mode", "failureMode", i32, true);
  const count = tx.reserveGlobal("witness:insert-count", "count", i32, true);
  const after = tx.reserveGlobal("witness:after", "after", i32, true);
  const functionToken = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("witness:" + name, name, { params, results });
  const initialize = functionToken("initialize", [], []);
  const advance = functionToken("advance", [], []);
  const defineData = functionToken("defineData", [ext, ext, ext, f64], []);
  const defineAccessor = functionToken("defineAccessor", [ext, ext, ext, ext, f64], []);
  const bag = functionToken("bag", [i32], [ext]);
  const observerNames = ["prototype", "realm", "initialName", "arity", "count", "objectFlags"];
  const observers = Object.fromEntries(
    observerNames.map((name) => [
      name,
      functionToken(name, [i32], [name === "arity" || name === "count" || name === "objectFlags" ? i32 : ext]),
    ]),
  );
  const descriptorObservers = Object.fromEntries(
    ["value", "getter", "setter", "flags"].map((name) => [
      name,
      functionToken(name, [i32, ext], [name === "flags" ? i32 : ext]),
    ]),
  );
  const entries = f.requests.intrinsics.map((request, index) => {
    const metadata = closures.metadata.find((row) => row.id === request.metadataId)!.binding;
    const type = tx.reserveType(
      "witness:type:" + index,
      createBuiltinFunctionType(
        request.intrinsic.id,
        metadata.type.typeIndex,
        f.realmLayouts.types.identity.typeIndex,
        f.strings.layout.anyStrTypeIdx,
      ),
    );
    const singleton =
      index === 0
        ? f.realmLayouts.anchors.functionPrototype
        : tx.reserveGlobal(
            "witness:singleton:" + index,
            request.intrinsic.id,
            { kind: "ref_null", typeIdx: type.typeIndex },
            true,
          );
    // Not callable implementations. The witness observes graph construction, never invokes these refs.
    const observer = functionToken("unused-reference:" + index, [], []);
    return { request, metadata, type, singleton, observer };
  });
  const texts = [
    ...new Set(
      NATIVE_REALM_CATALOG.intrinsics.flatMap((row) => [
        ...row.properties.flatMap((p) => [
          ...(p.key.kind === "string" ? [p.key.value] : []),
          ...(p.kind === "data" && p.value.kind === "string" ? [p.value.value] : []),
        ]),
        ...(row.callable ? [row.callable.initialName] : []),
      ]),
    ),
  ];
  const literals = texts.map((text, i) => ({ text, token: functionToken("literal:" + i, [], [ext]) }));
  fillLiftedAlgorithmFixture(f);
  fillNativeObjectDescriptorResources(tx, descriptors, f.publicException.tag);
  const literal = (text: string): Instr[] => {
    const binding = requireNativeStringLiteral(tx, f.strings, text);
    if (binding.kind !== "global") throw Error("short catalog literal required");
    return [g(tx.physicalIndex(binding.global))];
  };
  for (const token of [state, mode, count, after]) tx.fillGlobal(token, [n(0)]);
  tx.fillGlobal(object, [{ op: "ref.null", typeIdx: f.realmLayouts.types.objectPrototype.typeIndex }]);
  entries.forEach((entry, i) => {
    if (i !== 0) tx.fillGlobal(entry.singleton, [{ op: "ref.null", typeIdx: entry.type.typeIndex }]);
    tx.fillFunction(entry.observer, { locals: [], body: [] });
    tx.declareFunctionReference(entry.observer);
  });
  const index = (token: typeof state) => tx.physicalIndex(token);
  tx.fillFunction(
    initialize,
    buildRealmPopulationDefinition({
      identityType: f.realmLayouts.types.identity.typeIndex,
      objectPrototypeType: f.realmLayouts.types.objectPrototype.typeIndex,
      objectType: f.layouts.object.typeIndex,
      propMapType: f.layouts.propMap.typeIndex,
      realmGlobal: index(f.realmLayouts.anchors.realm),
      objectPrototypeGlobal: index(object),
      stateGlobal: index(state),
      functions: entries.map((entry) => ({
        id: entry.request.intrinsic.id,
        type: entry.type.typeIndex,
        lifted: entry.observer.handle,
        metadataId: entry.metadata.metadata.id,
        singleton: index(entry.singleton),
      })),
      createNull: f.storage.createNull.handle,
      defineData: defineData.handle,
      defineAccessor: defineAccessor.handle,
      boxNumber: f.values.functions.boxNumber.handle,
      boxSymbol: f.symbols.functions.box.handle,
      literal,
      failure: [
        ...literal("TypeError: native builtin initialization failed"),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: f.errors.newTypeError.handle },
        { op: "throw", tagIdx: tx.physicalIndex(f.publicException.tag) },
      ],
    }),
  );
  tx.fillFunction(advance, {
    locals: [],
    body: [
      g(index(count)),
      n(1),
      { op: "i32.add" },
      { op: "global.set", index: index(count) },
      g(index(count)),
      g(index(after)),
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          g(index(mode)),
          n(1),
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx: tx.physicalIndex(f.publicException.tag) }],
          },
          g(index(mode)),
          n(2),
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: initialize.handle }] },
          g(index(mode)),
          n(3),
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
          g(index(mode)),
          n(4),
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              {
                op: "try",
                blockType: { kind: "empty" },
                body: [{ op: "call", funcIdx: initialize.handle }],
                catches: [],
                catchAll: [],
              },
            ],
          },
        ],
      },
    ],
  });
  for (const [token, target, arity] of [
    [defineData, descriptors.defineData, 4],
    [defineAccessor, descriptors.defineAccessor, 5],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [
        { op: "call", funcIdx: advance.handle },
        ...Array.from({ length: arity }, (_, i) => get(i)),
        { op: "call", funcIdx: target.handle },
      ],
    });
  const select = (bodies: Instr[][]): Instr[] =>
    bodies
      .flatMap((body, i): Instr[] => [
        get(0),
        n(i),
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [...body, { op: "return" }] },
      ])
      .concat({ op: "unreachable" });
  const reference = (entry: (typeof entries)[number]): Instr[] => [
    g(index(entry.singleton)),
    ...(entry.singleton.object.type.kind === "externref"
      ? [{ op: "any.convert_extern" } as Instr, { op: "ref.cast", typeIdx: entry.type.typeIndex } as Instr]
      : [{ op: "ref.as_non_null" } as Instr]),
  ];
  const field = (entry: (typeof entries)[number], fieldIdx: number): Instr[] => [
    ...reference(entry),
    { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx },
  ];
  tx.fillFunction(bag, {
    locals: [],
    body: select([
      [g(index(object)), { op: "extern.convert_any" }],
      ...entries.map((entry) => field(entry, CLOSURE_BAG_FIELD_IDX)),
    ]),
  });
  for (const name of observerNames) {
    const bodies: Instr[][] =
      name === "count" || name === "objectFlags"
        ? Array.from({ length: 45 }, (_, i) => [
            n(i),
            { op: "call", funcIdx: bag.handle },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
            { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: name === "count" ? 2 : 4 },
          ])
        : [
            [name === "arity" ? n(-1) : { op: "ref.null.extern" }],
            ...entries.map((entry): Instr[] => [
              ...field(
                entry,
                name === "prototype"
                  ? BUILTIN_FUNCTION_PROTOTYPE_FIELD
                  : name === "realm"
                    ? BUILTIN_FUNCTION_REALM_FIELD
                    : name === "initialName"
                      ? BUILTIN_FUNCTION_INITIAL_NAME_FIELD
                      : 1,
              ),
              ...(name === "realm" || name === "initialName" ? [{ op: "extern.convert_any" } as Instr] : []),
            ]),
          ];
    tx.fillFunction(observers[name]!, { locals: [], body: select(bodies) });
  }
  for (const [name, token] of Object.entries(descriptorObservers)) {
    const fieldIdx = name === "value" ? 1 : name === "getter" ? 4 : name === "setter" ? 5 : 2;
    tx.fillFunction(token, {
      locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: f.layouts.propEntry.typeIndex } }],
      body: [
        get(0),
        { op: "call", funcIdx: bag.handle },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
        get(1),
        { op: "call", funcIdx: f.lookup.findOwn.handle },
        { op: "local.tee", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [name === "flags" ? n(-1) : { op: "ref.null.extern" }, { op: "return" }],
        },
        get(2),
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx },
        ...(name === "flags" ? [] : [{ op: "extern.convert_any" } as Instr]),
      ],
    });
  }
  for (const { text, token } of literals)
    tx.fillFunction(token, { locals: [], body: [...literal(text), { op: "extern.convert_any" }] });
  const exported = {
    initialize,
    bag,
    ...observers,
    ...descriptorObservers,
    state,
    mode,
    after,
    identity: f.realmLayouts.anchors.realm,
    exception: f.publicException.tag,
    unboxNumber: f.values.functions.unboxNumber,
    symbol: f.symbols.functions.box,
  };
  for (const [name, token] of Object.entries(exported)) tx.defineExport("witness:export:" + name, name, token);
  for (const { token } of literals) tx.defineExport("witness:export:" + token.key, token.key, token);
  [object, ...entries.map((e) => e.singleton)].forEach((token, i) =>
    tx.defineExport("witness:export:intrinsic:" + i, "intrinsic:" + i, token),
  );
  tx.seal();
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(bytes as BufferSource);
  const instantiate = () => {
    const ex = new WebAssembly.Instance(module).exports as unknown as PopulationWitnessExports;
    const intrinsic = (i: number) => (ex["intrinsic:" + i] as WebAssembly.Global).value;
    const text = (value: string) => {
      const binding = literals.find((row) => row.text === value);
      if (!binding) throw Error("witness literal absent: " + value);
      return (ex[binding.token.key] as () => unknown)();
    };
    return { ex, intrinsic, text };
  };
  return { bytes, module, instantiate };
}
export interface PopulationWitnessExports extends Record<string, unknown> {
  initialize(): void;
  bag(i: number): unknown;
  prototype(i: number): unknown;
  realm(i: number): unknown;
  initialName(i: number): unknown;
  arity(i: number): number;
  count(i: number): number;
  objectFlags(i: number): number;
  value(i: number, key: unknown): unknown;
  getter(i: number, key: unknown): unknown;
  setter(i: number, key: unknown): unknown;
  flags(i: number, key: unknown): number;
  unboxNumber(value: unknown): number;
  symbol(id: number): unknown;
  state: WebAssembly.Global;
  mode: WebAssembly.Global;
  after: WebAssembly.Global;
  identity: WebAssembly.Global;
  exception: WebAssembly.Tag;
}
