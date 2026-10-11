// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../model/instructions.js";
import type { FieldDef, StructTypeDef, WasmFunction } from "../model/module-records.js";
import type { PhysicalModuleStorage } from "./module-reservations.js";
import { indexPhysicalTypes } from "./type-layout.js";

/**
 * Final physical transform. An immutable per-instance token travels with each
 * struct, without retaining the struct in a module-global allocation registry.
 * Run before binary emission, after semantic getter/field ladders are finalized.
 */
export function stampAllocationOwners(
  mod: Pick<PhysicalModuleStorage, "types" | "imports" | "functions" | "globals" | "elements" | "exports">,
  exportName: string,
): void {
  if (mod.exports.some((entry) => entry.name === exportName))
    throw new Error("Allocation owner export already exists.");
  const table = indexPhysicalTypes(mod.types);
  const structs = new Map<number, { type: StructTypeDef; fields: FieldDef[]; parent?: number; slot: number }>();
  for (const { typeIndex, definition } of table.entries) {
    const type = definition.kind === "sub" ? definition.type : definition;
    if (type.kind !== "struct") continue;
    const parent = definition.kind === "sub" ? (definition.superType ?? undefined) : type.superTypeIdx;
    structs.set(typeIndex, { type, fields: [...type.fields], parent, slot: -1 });
  }
  const slotOf = (index: number): number => {
    const info = structs.get(index);
    if (!info) throw new Error(`Allocation owner requires a struct supertype: ${index}.`);
    if (info.slot >= 0) return info.slot;
    info.slot = info.parent === undefined || info.parent < 0 ? info.fields.length : slotOf(info.parent);
    return info.slot;
  };
  for (const [index, info] of structs) {
    const slot = slotOf(index);
    info.type.fields = [
      ...info.fields.slice(0, slot),
      { name: "$allocationOwner", type: { kind: "eqref" }, mutable: false },
      ...info.fields.slice(slot),
    ];
  }

  const tokenType = table.entries.length;
  mod.types.push({ kind: "struct", name: "__allocation_owner_token", fields: [] });
  const importedGlobals = mod.imports.filter((entry) => entry.desc.kind === "global").length;
  const tokenGlobal = importedGlobals;
  const token = (): Instr => ({ op: "global.get", index: tokenGlobal });

  const cloneChildren = (instr: Instr, transform: (body: Instr[]) => Instr[]): Instr => {
    switch (instr.op) {
      case "block":
      case "loop":
      case "try_table":
        return { ...instr, body: transform(instr.body) };
      case "if":
        return { ...instr, then: transform(instr.then), ...(instr.else ? { else: transform(instr.else) } : {}) };
      case "try":
        return {
          ...instr,
          body: transform(instr.body),
          catches: instr.catches.map((entry) => ({ ...entry, body: transform(entry.body) })),
          ...(instr.catchAll ? { catchAll: transform(instr.catchAll) } : {}),
        };
      default:
        return { ...instr };
    }
  };
  const shifted = (instr: Instr): Instr => {
    if (instr.op === "global.get" || instr.op === "global.set") {
      return { ...instr, index: instr.index >= importedGlobals ? instr.index + 1 : instr.index };
    }
    if (instr.op === "struct.get" || instr.op === "struct.set") {
      const info = structs.get(instr.typeIdx);
      if (!info) throw new Error("Allocation owner cannot resolve a struct field instruction.");
      return { ...instr, fieldIdx: instr.fieldIdx >= info.slot ? instr.fieldIdx + 1 : instr.fieldIdx };
    }
    return instr;
  };

  // Constant initializers cannot use spill locals. Find the suffix operands
  // as complete constant expression trees, including already stamped children.
  const constantInputs = (instr: Instr): number => {
    if (
      instr.op.endsWith(".const") ||
      instr.op.startsWith("ref.null") ||
      instr.op === "global.get" ||
      instr.op === "ref.func"
    )
      return 0;
    if (instr.op === "struct.new") return structs.get(instr.typeIdx)?.type.fields.length ?? 0;
    if (instr.op === "array.new_fixed") return instr.length;
    if (instr.op === "array.new") return 2;
    if (
      instr.op === "array.new_default" ||
      instr.op === "ref.i31" ||
      instr.op === "any.convert_extern" ||
      instr.op === "extern.convert_any"
    )
      return 1;
    if (/^(i32|i64)\.(add|sub|mul)$/.test(instr.op)) return 2;
    throw new Error(`Allocation owner does not support constant operand ${instr.op}.`);
  };
  const transformConstants = (body: Instr[]): Instr[] => {
    const result: Instr[] = [];
    for (const original of body) {
      const instr = shifted({ ...original });
      if (instr.op === "struct.new") {
        const info = structs.get(instr.typeIdx);
        if (!info) throw new Error("Allocation owner cannot resolve a constant allocation.");
        let pending = info.fields.length - info.slot;
        let start = result.length;
        while (pending > 0 && start > 0) {
          const operand = result[--start]!;
          pending += constantInputs(operand) - 1;
        }
        if (pending !== 0) throw new Error("Allocation owner cannot recover constant constructor operands.");
        result.splice(start, 0, token());
      }
      result.push(instr);
    }
    return result;
  };
  for (const fn of mod.functions) {
    const definition = table.entries[fn.typeIdx]?.definition;
    const signature = definition?.kind === "sub" ? definition.type : definition;
    if (signature?.kind !== "func") throw new Error("Allocation owner cannot resolve function parameters.");
    const scratch = new Map<number, number[]>();
    const transform = (body: Instr[]): Instr[] => {
      const result: Instr[] = [];
      for (const original of body) {
        const instr = shifted(cloneChildren(original, transform));
        if (instr.op === "struct.new") {
          const info = structs.get(instr.typeIdx);
          if (!info) throw new Error("Allocation owner cannot resolve a runtime allocation.");
          let locals = scratch.get(instr.typeIdx);
          if (!locals) {
            locals = info.fields.slice(info.slot).map((field, i) => {
              const index = signature.params.length + fn.locals.length;
              const type: ValType =
                field.type.kind === "i8" || field.type.kind === "i16" ? { kind: "i32" } : field.type;
              fn.locals.push({ name: `__owner_operand_${instr.typeIdx}_${i}`, type });
              return index;
            });
            scratch.set(instr.typeIdx, locals);
          }
          for (let i = locals.length - 1; i >= 0; i--) result.push({ op: "local.set", index: locals[i]! });
          result.push(token());
          for (const index of locals) result.push({ op: "local.get", index });
        }
        result.push(instr);
      }
      return result;
    };
    fn.body = transform(fn.body);
  }
  for (const global of mod.globals) global.init = transformConstants(global.init);
  // Element offsets cannot allocate structs; still remap their global reads.
  for (const element of mod.elements) element.offset = element.offset.map((instr) => shifted({ ...instr }));
  // Multiple public names can share one descriptor object. Clone each export
  // so a shared global descriptor cannot be shifted twice.
  mod.exports = mod.exports.map((entry) => ({
    ...entry,
    desc: {
      ...entry.desc,
      index:
        entry.desc.kind === "global" && entry.desc.index >= importedGlobals ? entry.desc.index + 1 : entry.desc.index,
    },
  }));
  mod.globals.unshift({
    name: "__allocation_owner_token",
    type: { kind: "eqref" },
    mutable: false,
    init: [{ op: "struct.new", typeIdx: tokenType }],
  });

  const predicateType = tokenType + 1;
  mod.types.push({ kind: "func", params: [{ kind: "externref" }], results: [{ kind: "i32" }] });
  const predicate: WasmFunction = {
    name: exportName,
    typeIdx: predicateType,
    exported: true,
    locals: [{ name: "__owner_candidate", type: { kind: "anyref" } }],
    body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }],
  };
  for (const [typeIdx, info] of structs)
    predicate.body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: info.slot },
          token(),
          { op: "ref.eq" },
          { op: "return" },
        ],
      },
    );
  predicate.body.push({ op: "i32.const", value: 0 });
  const importedFunctions = mod.imports.filter((entry) => entry.desc.kind === "func").length;
  mod.exports.push({ name: exportName, desc: { kind: "func", index: importedFunctions + mod.functions.length } });
  mod.functions.push(predicate);
}
