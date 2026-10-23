// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { indexPhysicalTypes } from "../../src/wasm/physical/type-layout.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { WasmModule, Instr, ValType } from "../../src/ir/types.js";

/** Observe the actual startup-thrown object on a copy, after the original ran. */
export async function inspectPreparedErrorCopy(
  original: WasmModule,
  kind: "ReferenceError" | "TypeError" = "ReferenceError",
): Promise<WebAssembly.Exports> {
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
  const constructors = module.functions.filter((row) => row.name === "__new_" + kind);
  if (!constructors.length) throw Error("missing actual " + kind + " producer");
  const allocation = constructors[0]!.body.find((row) => row.op === "struct.new");
  if (!allocation || allocation.op !== "struct.new") throw Error("missing actual Error allocation");
  const error = table.find((row) => row.index === allocation.typeIdx)!;
  if (error?.type.kind !== "struct" || error.type.name !== "$Error_struct")
    throw Error("missing canonical Error carrier");
  const string = type("NativeString");
  if (string.type.kind !== "struct" || string.type.fields[2]?.type.kind !== "ref")
    throw Error("missing string data type");
  const data = string.type.fields[2].type.typeIdx;
  const captured = module.globals.length;
  module.globals.push({
    name: "test:captured-error",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  for (const producer of constructors) {
    if (producer.locals.length) throw Error("producer scratch ABI changed");
    producer.locals.push({ name: "test:captured", type: { kind: "externref" } });
    producer.body.push(
      { op: "local.tee", index: 1 },
      { op: "global.set", index: captured },
      { op: "local.get", index: 1 },
    );
  }
  const producer = constructors[0]!;
  module.exports.push({ name: "makeError", desc: { kind: "func", index: module.functions.indexOf(producer) } });
  const cast: Instr[] = [
    { op: "global.get", index: captured },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: error.index },
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
  const utf8 = table.find((row) => row.type.kind === "struct" && row.type.name === "Utf8String");
  for (const [label, fieldIdx] of [
    ["name", 2],
    ["message", 1],
  ] as const) {
    const value: Instr[] = [
      ...cast,
      { op: "struct.get", typeIdx: error.index, fieldIdx },
      { op: "any.convert_extern" },
    ];
    const native: Instr[] = [...value, { op: "ref.cast", typeIdx: string.index }];
    const encoded: Instr[] = utf8 ? [...value, { op: "ref.cast", typeIdx: utf8.index }] : [{ op: "unreachable" }];
    const isUtf8: Instr[] = utf8
      ? [...value, { op: "ref.test", typeIdx: utf8.index }]
      : [{ op: "i32.const", value: 0 }];
    probe(label + "IsUtf8", [], [{ kind: "i32" }], isUtf8);
    probe(
      label + "Length",
      [],
      [{ kind: "i32" }],
      utf8
        ? [
            ...isUtf8,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [...encoded, { op: "struct.get", typeIdx: utf8.index, fieldIdx: 0 }],
              else: [...native, { op: "struct.get", typeIdx: string.index, fieldIdx: 0 }],
            },
          ]
        : [...native, { op: "struct.get", typeIdx: string.index, fieldIdx: 0 }],
    );
    probe(
      label + "Unit",
      [{ kind: "i32" }],
      [{ kind: "i32" }],
      [
        ...native,
        { op: "struct.get", typeIdx: string.index, fieldIdx: 2 },
        ...native,
        { op: "struct.get", typeIdx: string.index, fieldIdx: 1 },
        { op: "local.get", index: 0 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: data },
      ],
    );
    if (utf8) {
      if (utf8.type.kind !== "struct" || utf8.type.fields[3]?.type.kind !== "ref")
        throw Error("missing UTF-8 byte carrier");
      const bytes = utf8.type.fields[3].type.typeIdx;
      probe(
        label + "ByteLength",
        [],
        [{ kind: "i32" }],
        [...encoded, { op: "struct.get", typeIdx: utf8.index, fieldIdx: 1 }],
      );
      probe(
        label + "Byte",
        [{ kind: "i32" }],
        [{ kind: "i32" }],
        [
          ...encoded,
          { op: "struct.get", typeIdx: utf8.index, fieldIdx: 3 },
          ...encoded,
          { op: "struct.get", typeIdx: utf8.index, fieldIdx: 2 },
          { op: "local.get", index: 0 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: bytes },
        ],
      );
    }
  }
  return (await WebAssembly.instantiate(emitBinary(module) as Uint8Array<ArrayBuffer>, {})).instance.exports;
}

/** Decode only bytes/code units read from the actual error field on the instrumented copy. */
export function readInspectedErrorString(exports: WebAssembly.Exports, field: "name" | "message"): string {
  const call = (suffix: string, ...args: number[]) => {
    const fn = exports[field + suffix];
    if (typeof fn !== "function") throw Error("missing error string probe " + suffix);
    return Number(fn(...args));
  };
  if (call("IsUtf8"))
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from({ length: call("ByteLength") }, (_, index) => call("Byte", index)),
    );
  return String.fromCharCode(...Array.from({ length: call("Length") }, (_, index) => call("Unit", index)));
}
