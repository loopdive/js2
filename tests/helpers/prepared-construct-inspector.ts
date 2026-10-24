// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, WasmModule } from "../../src/ir/types.js";
import { buildStandardRethrowingTry } from "../../src/wasm/physical/exception-control.js";
import { emitBinary } from "../../src/emit/binary.js";

/** Instrument only a copy after the original artifact executes; all state comes from its real dispatcher. */
export async function inspectConstructCopy(original: WasmModule) {
  if (original.imports.length) throw Error("Construct inspector requires zero imports");
  const module = {
    ...original,
    globals: [...original.globals],
    functions: [...original.functions],
    exports: [...original.exports],
  };
  const global = (name: string) => {
    const found = module.globals.flatMap((row, index) => (row.name === name ? [{ row, index }] : []));
    if (found.length !== 1) throw Error("expected one actual invocation global: " + name);
    return found[0]!;
  };
  const argc = global("__argc"),
    extras = global("__extra_args"),
    receiver = global("__current_this");
  const add = (name: string, external = false) => {
    const index = module.globals.length;
    module.globals.push({
      name: "test:" + name,
      type: { kind: external ? "externref" : "i32" },
      mutable: true,
      init: external ? [{ op: "ref.null.extern" }] : [{ op: "i32.const", value: 0 }],
    });
    module.exports.push({ name, desc: { kind: "global", index } });
    return index;
  };
  const allocations = add("allocations"),
    firstClass = add("firstClass", true),
    secondClass = add("secondClass", true);
  const seenTarget = add("seenTarget", true),
    seenArguments = add("seenArguments", true);
  const firstEntryTarget = add("firstEntryTarget", true),
    secondEntryTarget = add("secondEntryTarget", true);
  const calls = add("constructCalls"),
    nonempty = add("nonemptyFrames"),
    bad = add("badFrames"),
    entries = add("internalEntries"),
    badEntries = add("badEntries");
  const readers = module.functions.filter((fn) => fn.name === "__closure_undefined");
  const undefinedRead = readers[0]?.body[0];
  if (readers.length !== 1 || undefinedRead?.op !== "global.get")
    throw Error("inspector lost actual canonical undefined reader");
  const undefinedIndex = undefinedRead.index;
  const increment = (index: number): Instr[] => [
    { op: "global.get", index },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index },
  ];
  const recordValue = (counter: number, ordinal: number, target: number, local: number): Instr[] => [
    { op: "global.get", index: counter },
    { op: "i32.const", value: ordinal },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: local },
        { op: "global.set", index: target },
      ],
    },
  ];
  let allocators = 0,
    dispatchers = 0;
  module.functions = module.functions.map((fn) => {
    if (fn.name === "__class_value_new") {
      allocators++;
      const value = 5 + fn.locals.length;
      return {
        ...fn,
        locals: [...fn.locals, { name: "test:value", type: { kind: "externref" as const } }],
        body: [
          ...fn.body,
          { op: "local.set", index: value },
          ...recordValue(allocations, 0, firstClass, value),
          ...recordValue(allocations, 1, secondClass, value),
          ...increment(allocations),
          { op: "local.get", index: value },
        ],
      };
    }
    if (fn.name === "left" || fn.name === "right") {
      const wrong = (condition: Instr[]): Instr[] => [
        ...condition,
        { op: "if", blockType: { kind: "empty" }, then: increment(badEntries) },
      ];
      return {
        ...fn,
        body: [
          ...increment(entries),
          ...recordValue(entries, 1, firstEntryTarget, 1),
          ...recordValue(entries, 2, secondEntryTarget, 1),
          ...wrong([{ op: "global.get", index: argc.index }, { op: "i32.const", value: -1 }, { op: "i32.ne" }]),
          ...wrong([{ op: "global.get", index: extras.index }, { op: "ref.is_null" }, { op: "i32.eqz" }]),
          ...wrong([
            { op: "global.get", index: receiver.index },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: -19 },
            { op: "global.get", index: undefinedIndex },
            { op: "ref.eq" },
            { op: "i32.eqz" },
          ]),
          ...fn.body,
        ],
      };
    }
    if (fn.name !== "__construct_class_value") return fn;
    dispatchers++;
    const base = 3 + fn.locals.length,
      savedThis = base,
      savedArgc = base + 1,
      savedExtras = base + 2,
      result = base + 3;
    const changed = (condition: Instr[]): Instr[] => [
      ...condition,
      { op: "if", blockType: { kind: "empty" }, then: increment(bad) },
    ];
    const after: Instr[] = [
      ...changed([{ op: "global.get", index: argc.index }, { op: "local.get", index: savedArgc }, { op: "i32.ne" }]),
      ...changed([
        { op: "global.get", index: extras.index },
        { op: "local.get", index: savedExtras },
        { op: "ref.eq" },
        { op: "i32.eqz" },
      ]),
      ...changed([
        { op: "global.get", index: receiver.index },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: -19 },
        { op: "local.get", index: savedThis },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: -19 },
        { op: "ref.eq" },
        { op: "i32.eqz" },
      ]),
    ];
    const prefix: Instr[] = [
      ...increment(calls),
      { op: "local.get", index: 1 },
      { op: "global.set", index: seenTarget },
      { op: "local.get", index: 2 },
      { op: "extern.convert_any" },
      { op: "global.set", index: seenArguments },
      { op: "global.get", index: receiver.index },
      { op: "local.set", index: savedThis },
      { op: "global.get", index: argc.index },
      { op: "local.set", index: savedArgc },
      { op: "global.get", index: extras.index },
      { op: "local.tee", index: savedExtras },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: increment(nonempty) },
    ];
    return {
      ...fn,
      locals: [
        ...fn.locals,
        { name: "test:this", type: receiver.row.type },
        { name: "test:argc", type: argc.row.type },
        { name: "test:extras", type: extras.row.type },
        { name: "test:result", type: { kind: "externref" as const } },
      ],
      body: [
        ...prefix,
        buildStandardRethrowingTry(
          structuredClone([...fn.body, { op: "local.set", index: result }] as Instr[]),
          structuredClone(after),
        ),
        ...after,
        { op: "local.get", index: result },
      ],
    };
  });
  if (allocators !== 1 || dispatchers !== 1) throw Error("inspector lost real class allocation/Construct owners");
  const binary = emitBinary(module) as Uint8Array<ArrayBuffer>;
  const exports = (await WebAssembly.instantiate(binary, {})).instance.exports;
  return {
    run: exports.run as Function,
    value: (name: string) => (exports[name] as WebAssembly.Global).value,
    reset: () => {
      for (const name of [
        "allocations",
        "constructCalls",
        "nonemptyFrames",
        "badFrames",
        "internalEntries",
        "badEntries",
      ])
        (exports[name] as WebAssembly.Global).value = 0;
    },
  };
}
