// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { builtinFunctionFixture } from "./native-builtin-functions.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  buildBuiltinFunctionArgument,
  buildBuiltinFunctionCallDefinition,
  buildBuiltinFunctionLiftedDefinition,
  buildBuiltinFunctionMatchDefinition,
  buildBuiltinFunctionMethodDefinition,
  type BuiltinFunctionBodyOperands,
} from "../../src/runtime/wasmgc/values/builtin-function-bodies.js";
import { buildBuiltinFunctionGet } from "../../src/runtime/wasmgc/values/builtin-function-prototype-bodies.js";
import { nativeObjectDescriptorReservationInventory } from "../../src/backend/wasmgc/resources/native-object-descriptors.js";
import { NATIVE_BUILTIN_FUNCTION_LITERALS } from "../../src/backend/wasmgc/resources/native-builtin-function-requests.js";

const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
type Fixture = ReturnType<typeof builtinFunctionFixture>;
/**
 * An uninstalled observer object, deliberately NOT accepted by the native owner.
 * These controls test the pure transport recipes against actual issued coordinates.
 */
export function reserveBuiltinTransportControls(f: Fixture) {
  const { tx } = f,
    kernel = f.kernel!,
    entry = kernel.entries[0]!;
  const global = (role: string, type: ValType) => tx.reserveGlobal("transport-control:" + role, role, type, true);
  const globals = {
    singleton: global("singleton", { kind: "ref_null", typeIdx: entry.type.typeIndex }),
    mode: global("mode", i32),
    entered: global("entered", i32),
    thrown: global("thrown", ext),
    receiver: global("receiver", ext),
    vector: global("vector", ext),
  };
  const reserve = (role: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("transport-control:" + role, role, { params, results });
  const vector: ValType = { kind: "ref", typeIdx: f.argumentsPack.carrier.typeIndex };
  const functions = {
    initialize: reserve("initialize", [], []),
    value: reserve("value", [], [ext]),
    bag: reserve("bag", [], [ext]),
    length: reserve("length", [], [ext]),
    match: reserve("match", [ext], [i32]),
    callVector: reserve("call-vector", [ext, ext, vector], [ext]),
    lifted: reserve("lifted", [{ kind: "ref", typeIdx: f.closures.root.typeIndex }, ext, vector], [ext]),
    algorithm: reserve("algorithm", [ext, vector], [ext]),
    call: reserve("call", [ext, ext, ext], [ext]),
    method0: reserve("method0", [ext, ext], [ext]),
    method3: reserve("method3", [ext, ext, ext, ext, ext], [ext]),
    get: reserve("get", [ext, ext, ext], [i32, ext]),
    catch: reserve("catch", [ext, ext, ext], [ext]),
  };
  return { globals, functions };
}
export function fillBuiltinTransportControls(f: Fixture, controls: ReturnType<typeof reserveBuiltinTransportControls>) {
  const { tx } = f,
    kernel = f.kernel!,
    entry = kernel.entries[0]!,
    { globals: g, functions: fn } = controls;
  const global = (role: keyof typeof g): Instr => ({ op: "global.get", index: tx.physicalIndex(g[role]) });
  const globalSet = (role: keyof typeof g): Instr => ({ op: "global.set", index: tx.physicalIndex(g[role]) });
  const call = (role: keyof typeof fn): Instr => ({ op: "call", funcIdx: fn[role].handle });
  const literal = (text: string, external = true): Instr[] => {
    const token = requireNativeStringLiteral(tx, f.strings, text);
    return [
      token.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(token.global) }
        : { op: "call", funcIdx: token.function.handle },
      ...(external ? [{ op: "extern.convert_any" } as Instr] : []),
    ];
  };
  const descriptor = nativeObjectDescriptorReservationInventory(tx, f.pack, f.dependencies);
  const d: BuiltinFunctionBodyOperands = {
    rootTypeIdx: f.closures.root.typeIndex,
    realmTypeIdx: kernel.realmType.typeIndex,
    objectTypeIdx: f.layouts.object.typeIndex,
    vectorTypeIdx: f.argumentsPack.carrier.typeIndex,
    vectorArrayTypeIdx: f.argumentsPack.array.typeIndex,
    realm: tx.physicalIndex(kernel.globals.realm),
    objectPrototype: tx.physicalIndex(kernel.globals.objectPrototype),
    state: tx.physicalIndex(kernel.globals.state),
    undefinedGlobal: tx.physicalIndex(f.values.globals.undefined),
    initializer: fn.initialize.handle,
    match: fn.match.handle,
    callVector: fn.callVector.handle,
    bag: kernel.functions.bag.handle,
    newVector: f.argumentsPack.newVector.handle,
    push: f.argumentsPack.push.handle,
    createNull: f.storage.createNull.handle,
    boxNumber: f.values.functions.boxNumber.handle,
    defineDataBody: descriptor.functions[0]!.handle,
    defineAttributes: f.pack.defineAttributes.handle,
    typeError: f.errors.newTypeError.handle,
    exceptionTag: tx.physicalIndex(kernel.exception),
    lengthKey: literal("length"),
    nameKey: literal("name"),
    errors: NATIVE_BUILTIN_FUNCTION_LITERALS.slice(3).map((text) => literal(text)),
    entries: [
      {
        typeIdx: entry.type.typeIndex,
        metadataId: entry.metadata.metadata.id,
        liftedTypeIdx: entry.metadata.signature.liftedFuncTypeIndex,
        singleton: tx.physicalIndex(g.singleton),
        lifted: fn.lifted.handle,
        algorithm: fn.algorithm.handle,
        initialName: literal("", false),
        initialLength: 2,
        userFormalCount: 7,
        // Pure transport recipes ignore behavior; no intrinsic owner receives this control.
        behavior: "function-prototype",
      },
    ],
  };
  tx.fillGlobal(g.singleton, [{ op: "ref.null", typeIdx: entry.type.typeIndex }]);
  for (const role of ["mode", "entered"] as const) tx.fillGlobal(g[role], [n(0)]);
  for (const role of ["receiver", "vector", "thrown"] as const) tx.fillGlobal(g[role], [{ op: "ref.null.extern" }]);
  const bag = (): Instr[] => [
    global("singleton"),
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx: 2 },
  ];
  tx.fillFunction(fn.initialize, {
    locals: [],
    body: [
      global("singleton"),
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "call", funcIdx: kernel.functions.initialize.handle },
      { op: "ref.func", funcIdx: fn.lifted.handle },
      n(7),
      { op: "call", funcIdx: f.storage.createNull.handle },
      n(0),
      n(entry.metadata.metadata.id),
      { op: "call", funcIdx: entry.getter.handle },
      { op: "global.get", index: d.realm },
      { op: "ref.as_non_null" },
      ...literal("", false),
      { op: "struct.new", typeIdx: entry.type.typeIndex },
      globalSet("singleton"),
      ...bag(),
      ...literal("length"),
      { op: "f64.const", value: 2 },
      { op: "call", funcIdx: d.boxNumber },
      { op: "f64.const", value: 188 },
      { op: "call", funcIdx: d.defineDataBody },
      { op: "drop" },
      ...bag(),
      ...literal("name"),
      ...literal(""),
      { op: "f64.const", value: 188 },
      { op: "call", funcIdx: d.defineDataBody },
      { op: "drop" },
    ],
  });
  tx.fillFunction(fn.value, {
    locals: [],
    body: [call("initialize"), global("singleton"), { op: "ref.as_non_null" }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(fn.bag, { locals: [], body: [call("initialize"), ...bag()] });
  tx.fillFunction(fn.length, {
    locals: [],
    body: [
      call("initialize"),
      ...bag(),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
      ...literal("length"),
      { op: "call", funcIdx: f.lookup.findOwn.handle },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(fn.match, buildBuiltinFunctionMatchDefinition(d));
  tx.fillFunction(fn.lifted, buildBuiltinFunctionLiftedDefinition(d, d.entries[0]!, 0));
  tx.declareFunctionReference(fn.lifted);
  tx.fillFunction(fn.callVector, buildBuiltinFunctionCallDefinition(d));
  tx.fillFunction(fn.method0, buildBuiltinFunctionMethodDefinition(d, 0));
  tx.fillFunction(fn.method3, buildBuiltinFunctionMethodDefinition(d, 3));
  const callBody: Instr[] = [
    get(0),
    get(1),
    get(2),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.vectorTypeIdx },
    call("callVector"),
  ];
  tx.fillFunction(fn.call, { locals: [], body: callBody });
  tx.fillFunction(fn.catch, {
    locals: [],
    body: [
      {
        op: "try",
        blockType: { kind: "val", type: ext },
        body: structuredClone(callBody),
        catches: [{ tagIdx: d.exceptionTag, body: [globalSet("thrown"), { op: "rethrow", depth: 0 }] }],
      },
    ],
  });
  tx.fillFunction(
    fn.get,
    buildBuiltinFunctionGet({
      ...d,
      entryTypeIdx: f.layouts.propEntry.typeIndex,
      mapTypeIdx: f.layouts.propMap.typeIndex,
      findOrdinary: f.lookup.findOwn.handle,
      findOwn: kernel.functions.findOwn.handle,
      defineData: f.pack.defineData.handle,
      defineAccessor: f.pack.defineAccessor.handle,
      keyBefore: kernel.functions.keyBefore.handle,
      writeOwn: kernel.functions.writeOwn.handle,
      lookup: kernel.functions.lookup.handle,
      getPrototypeOf: kernel.functions.getPrototypeOf.handle,
      isExtensible: kernel.functions.isExtensible.handle,
      sameValue: f.sameValue.sameValue.handle,
    }),
  );
  const arg = (index: number) => buildBuiltinFunctionArgument(d, 1, index);
  const arm = (mode: number, body: Instr[]): Instr[] => [
    global("mode"),
    n(mode),
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [...body, { op: "return" }] },
  ];
  tx.fillFunction(fn.algorithm, {
    locals: [
      { name: "nestedArguments", type: ext },
      { name: "remaining", type: { kind: "f64" } },
      { name: "nestedResult", type: ext },
    ],
    body: [
      global("entered"),
      n(1),
      { op: "i32.add" },
      globalSet("entered"),
      get(0),
      globalSet("receiver"),
      get(1),
      { op: "extern.convert_any" },
      globalSet("vector"),
      ...arm(0, [get(0)]),
      ...arm(1, arg(0)),
      ...arm(2, [get(1), { op: "extern.convert_any" }]),
      ...arm(3, [
        get(1),
        { op: "struct.get", typeIdx: d.vectorTypeIdx, fieldIdx: 0 },
        { op: "f64.convert_i32_u" },
        { op: "call", funcIdx: d.boxNumber },
      ]),
      ...arm(4, [
        ...arg(0),
        { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
        { op: "local.tee", index: 3 },
        { op: "f64.const", value: 0 },
        { op: "f64.gt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "call", funcIdx: d.newVector },
            { op: "local.set", index: 2 },
            get(2),
            get(3),
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "call", funcIdx: d.boxNumber },
            { op: "call", funcIdx: d.push },
            get(2),
            ...arg(1),
            { op: "call", funcIdx: d.push },
            global("singleton"),
            { op: "extern.convert_any" },
            get(0),
            get(2),
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: d.vectorTypeIdx },
            call("callVector"),
            { op: "drop" },
          ],
        },
        ...arg(1),
      ]),
      ...arm(5, [
        n(0),
        globalSet("mode"),
        {
          op: "try",
          blockType: { kind: "empty" },
          body: [
            { op: "call", funcIdx: entry.getter.handle },
            ...literal("value"),
            get(0),
            call("get"),
            { op: "local.set", index: 4 },
            { op: "drop" },
          ],
          catches: [],
          catchAll: [n(5), globalSet("mode"), { op: "rethrow", depth: 0 }],
        },
        n(5),
        globalSet("mode"),
        get(4),
      ]),
      ...arm(6, [...arg(0), { op: "throw", tagIdx: d.exceptionTag }]),
      { op: "unreachable" },
    ],
  });
}
