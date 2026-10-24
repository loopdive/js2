// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, WasmModule } from "../../src/ir/types.js";
import { indexPhysicalTypes } from "../../src/wasm/physical/type-layout.js";
import { emitBinary } from "../../src/emit/binary.js";
import {
  CLASS_CONSTRUCT_CLOSURE_FIELD,
  CLASS_OBJECT_STATE_FIELD,
} from "../../src/runtime/wasmgc/values/class-constructor-layouts.js";
import {
  REALM_STATE_IDENTITY_FIELD,
  REALM_STATE_PROTOTYPE_FIELD,
} from "../../src/runtime/wasmgc/values/realm-object-layouts.js";

/** Test-only append-only probes on a COPY, after executing the original artifact. */
export async function inspectPreparedClassCopy(original: WasmModule): Promise<WebAssembly.Exports> {
  if (original.imports.length !== 0) throw Error("inspector requires actual zero-import artifact");
  const table = indexPhysicalTypes(original.types).entries.map((row) => ({
    index: row.typeIndex,
    type: row.definition.kind === "sub" ? row.definition.type : row.definition,
  }));
  function unique<T>(rows: T[], label: string): T {
    if (rows.length !== 1) throw Error(`inspector expected exactly one ${label}, got ${rows.length}`);
    return rows[0]!;
  }
  const cls = unique(
    table.filter((row) => row.type.kind === "struct" && row.type.name === "$ClassConstructor"),
    "class type",
  );
  const state = unique(
    table.filter((row) => row.type.kind === "struct" && row.type.name === "$RealmObjectState"),
    "state type",
  );
  const source = unique(
    table.filter(
      (row) =>
        row.type.kind === "struct" &&
        row.type.fields[3]?.type.kind === "f64" &&
        row.type.fields.at(-1)?.name === "[[ObjectState]]",
    ),
    "captured source type",
  );
  if (source.type.kind !== "struct") throw Error("source is not a struct");
  const unary = unique(
    table.filter(
      (row) =>
        row.type.kind === "func" &&
        row.type.params.length === 1 &&
        row.type.params[0]?.kind === "externref" &&
        row.type.results.length === 1 &&
        row.type.results[0]?.kind === "externref",
    ),
    "unary external signature",
  );
  const module = { ...original, functions: [...original.functions], exports: [...original.exports] };
  function probe(name: string, carrier: number, field: number, stateField?: number): void {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: carrier },
      { op: "struct.get", typeIdx: carrier, fieldIdx: field },
    ];
    if (stateField !== undefined) body.push({ op: "struct.get", typeIdx: state.index, fieldIdx: stateField });
    if (stateField !== REALM_STATE_PROTOTYPE_FIELD) body.push({ op: "extern.convert_any" });
    const index = module.functions.length;
    module.functions.push({ name, typeIdx: unary.index, locals: [], body, exported: true });
    module.exports.push({ name, desc: { kind: "func", index } });
  }
  probe("inspectConstruct", cls.index, CLASS_CONSTRUCT_CLOSURE_FIELD);
  probe("inspectClassRealm", cls.index, CLASS_OBJECT_STATE_FIELD, REALM_STATE_IDENTITY_FIELD);
  probe("inspectClassParent", cls.index, CLASS_OBJECT_STATE_FIELD, REALM_STATE_PROTOTYPE_FIELD);
  probe("inspectSourceRealm", source.index, source.type.fields.length - 1, REALM_STATE_IDENTITY_FIELD);
  probe("inspectSourcePrototype", source.index, source.type.fields.length - 1, REALM_STATE_PROTOTYPE_FIELD);
  for (const [name, suffix] of [
    ["inspectKernelRealm", ":realm"],
    ["inspectKernelPrototype", ":function-prototype"],
    ["inspectKernelState", ":state"],
  ]) {
    const global = unique(
      module.globals.filter((row) => row.name.endsWith(suffix!)),
      name!,
    );
    const index = module.globals.indexOf(global);
    if (global.type.kind === "i32") module.exports.push({ name: name!, desc: { kind: "global", index } });
    else {
      const functionIndex = module.functions.length;
      module.functions.push({
        name: name!,
        typeIdx: unary.index,
        locals: [],
        exported: true,
        body: [{ op: "global.get", index }, { op: "extern.convert_any" }],
      });
      module.exports.push({ name: name!, desc: { kind: "func", index: functionIndex } });
    }
  }
  const binary = emitBinary(module) as Uint8Array<ArrayBuffer>;
  return (await WebAssembly.instantiate(binary, {})).instance.exports;
}
