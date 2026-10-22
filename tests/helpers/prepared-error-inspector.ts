// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { indexPhysicalTypes } from "../../src/wasm/physical/type-layout.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { WasmModule, Instr, ValType } from "../../src/ir/types.js";

/** Observe the actual startup-thrown object on a copy, after the original ran. */
export async function inspectPreparedErrorCopy(original: WasmModule): Promise<WebAssembly.Exports> {
  if (original.imports.length) throw Error("error inspector requires zero imports");
  const module = structuredClone(original);
  const table = indexPhysicalTypes(module.types).entries.map((row) => ({
    index: row.typeIndex,
    type: row.definition.kind === "sub" ? row.definition.type : row.definition,
  }));
  const type = (name: string) => {
    const rows = table.filter((row) => row.type.kind === "struct" && row.type.name === name);
    if (rows.length !== 1) throw Error("inspector requires one actual " + name);
    return rows[0]!;
  };
  const error = type("$Error_struct"),
    string = type("NativeString");
  if (string.type.kind !== "struct" || string.type.fields[2]?.type.kind !== "ref")
    throw Error("missing string data type");
  const data = string.type.fields[2].type.typeIdx;
  const constructors = module.functions.filter((row) => row.name === "__new_ReferenceError");
  if (constructors.length !== 1) throw Error("missing actual ReferenceError producer");
  const producer = constructors[0]!;
  if (producer.locals.length) throw Error("producer scratch ABI changed");
  const captured = module.globals.length;
  module.globals.push({
    name: "test:captured-error",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  producer.locals.push({ name: "test:captured", type: { kind: "externref" } });
  producer.body.push(
    { op: "local.tee", index: 1 },
    { op: "global.set", index: captured },
    { op: "local.get", index: 1 },
  );
  module.exports.push({ name: "makeError", desc: { kind: "func", index: module.functions.indexOf(producer) } });
  const cast: Instr[] = [
    { op: "global.get", index: captured },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: error.index },
  ];
  const name: Instr[] = [
    ...cast,
    { op: "struct.get", typeIdx: error.index, fieldIdx: 2 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: string.index },
  ];
  function probe(label: string, params: ValType[], results: ValType[], body: Instr[]) {
    const signature = module.types.length;
    module.types.push({ kind: "func", params, results });
    const index = module.functions.length;
    module.functions.push({ name: label, typeIdx: signature, locals: [], body, exported: true });
    module.exports.push({ name: label, desc: { kind: "func", index } });
  }
  probe("capturedError", [], [{ kind: "externref" }], [{ op: "global.get", index: captured }]);
  probe("errorTag", [], [{ kind: "i32" }], [...cast, { op: "struct.get", typeIdx: error.index, fieldIdx: 0 }]);
  probe(
    "messageAbsent",
    [],
    [{ kind: "i32" }],
    [...cast, { op: "struct.get", typeIdx: error.index, fieldIdx: 1 }, { op: "ref.is_null" }],
  );
  probe("nameLength", [], [{ kind: "i32" }], [...name, { op: "struct.get", typeIdx: string.index, fieldIdx: 0 }]);
  probe(
    "nameUnit",
    [{ kind: "i32" }],
    [{ kind: "i32" }],
    [
      ...name,
      { op: "struct.get", typeIdx: string.index, fieldIdx: 2 },
      ...name,
      { op: "struct.get", typeIdx: string.index, fieldIdx: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: data },
    ],
  );
  return (await WebAssembly.instantiate(emitBinary(module) as Uint8Array<ArrayBuffer>, {})).instance.exports;
}
