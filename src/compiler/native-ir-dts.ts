// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { EmittedPreparedIrProgram, PreparedIrProgram, PreparedIrAbiEntry } from "../ir/program.js";
import { PreparedIrProgramInvariantError, freezePreparedIrValue } from "../ir/program.js";
import { assertPreparedIrProgram } from "../ir/program-validation.js";
import { preparedIrDataMismatch } from "../ir/program/data.js";
import {
  assertEmittedPreparedIrProgram,
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
  emittedStartupAdapterIndex,
} from "../ir/program-consumer.js";
import type { IrBindingId } from "../shared/contracts/ir-identity.js";
import type { IrType } from "../ir/core/types.js";
import type { ValType } from "../ir/types.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";
import type { PhysicalSignatureType } from "../ir/program-physical-plan.js";

type Scalar = "number" | "boolean";
interface CallableDeclaration {
  readonly externalName: string;
  readonly params: readonly { readonly name: string; readonly type: Scalar }[];
  readonly result: Scalar | "void";
}
export interface NativePreparedDtsView {
  readonly declarations: readonly CallableDeclaration[];
  /** Every actual export is classified, including deliberate callable-DTS omissions. */
  readonly census: readonly {
    readonly externalName: string;
    readonly kind: "source-callable" | "source-global" | "startup" | "linear-memory";
  }[];
}
const observations = new WeakMap<
  NativePreparedDtsView,
  {
    readonly program: PreparedIrProgram;
    readonly emission: EmittedPreparedIrProgram;
  }
>();
function refuse(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native prepared DTS: ${detail}`);
}
function scalar(type: IrType): Scalar {
  if (type.kind !== "val" || type.typeRef !== undefined) return refuse("public slot lacks a scalar semantic contract");
  if (
    type.val.kind === "i32" &&
    type.val.boolean === true &&
    type.val.symbol === undefined &&
    type.val.int32 === undefined
  )
    return "boolean";
  if (
    ["f64", "f32", "i32"].includes(type.val.kind) &&
    !(type.val.kind === "i32" && (type.val.boolean === true || type.val.symbol !== undefined))
  )
    return "number";
  return refuse("public slot has no Number/Boolean JavaScript declaration mapping");
}
function sameTypes(left: readonly IrType[], right: readonly IrType[]): boolean {
  return preparedIrDataMismatch(left, right) === undefined;
}
function physicalMatches(expected: readonly PhysicalSignatureType[], physical: readonly ValType[]): boolean {
  return (
    expected.length === physical.length &&
    expected.every((type, index) => {
      // Logical Number/Boolean provenance is checked independently against the
      // immutable unit and ABI. Physical signatures prove the actual carrier.
      return ["i32", "i64", "f32", "f64"].includes(type.kind) && type.kind === physical[index]?.kind;
    })
  );
}

function canonical(entries: ReadonlyMap<IrBindingId, PreparedIrAbiEntry>, id: IrBindingId): PreparedIrAbiEntry {
  const seen = new Set<IrBindingId>();
  let row = entries.get(id);
  while (row?.plan.slotPolicy === "alias") {
    if (seen.has(row.plan.id)) return refuse("cyclic export/alias target");
    seen.add(row.plan.id);
    row = entries.get(row.plan.aliasOf);
  }
  if (!row || row.plan.slotPolicy !== "required") return refuse("export target has no required canonical binding");
  return row;
}
/** No source, checker, annotation text, display-name matching or source renderer enters this join. */
export function createNativePreparedDtsView(
  program: PreparedIrProgram,
  emission: EmittedPreparedIrProgram,
): NativePreparedDtsView {
  assertPreparedIrProgram(program);
  assertEmittedPreparedIrProgram(program, emission);
  const plan = emittedPhysicalSetupPlan(emission);
  if (plan.target !== "standalone" && plan.target !== "wasi") return refuse("requires an actual native target");
  const mod = emission.module;
  const types = indexPhysicalTypes(mod.types);
  const entries = new Map(program.abi.entries.map((row) => [row.plan.id, row]));
  if (entries.size !== program.abi.entries.length) return refuse("duplicate ABI binding");
  const declarations: CallableDeclaration[] = [];
  const census: NativePreparedDtsView["census"][number][] = [];
  const names = new Set<string>();
  const functionsImported = mod.imports.filter((row) => row.desc.kind === "func").length;
  const globalsImported = mod.imports.filter((row) => row.desc.kind === "global").length;
  const exported = program.abi.entries.filter((row) => row.contract.kind === "export");
  if (exported.length !== plan.exports.length) return refuse("semantic/physical export census differs");
  for (const row of exported) {
    const contract = row.contract;
    if (contract.kind !== "export") return refuse("missing export contract");
    if (names.has(contract.externalName)) return refuse("duplicate export name");
    names.add(contract.externalName);
    const target = canonical(entries, contract.targetId);
    const slot = emittedProgramBindingIndex(emission, contract.targetId);
    const expected = plan.exports.filter((value) => value.externalName === contract.externalName);
    const actual = mod.exports.filter((value) => value.name === contract.externalName);
    if (
      expected.length !== 1 ||
      expected[0]!.targetBindingId !== contract.targetId ||
      !slot ||
      expected[0]!.space !== slot.space ||
      actual.length !== 1 ||
      actual[0]!.desc.kind !== (slot.space === "function" ? "func" : "global") ||
      actual[0]!.desc.index !== slot.index
    )
      return refuse("physical export name, target and final index do not join exactly");
    if (target.contract.kind === "global") {
      if (target.plan.intent.kind !== "global" || target.plan.intent.origin !== "source" || slot.space !== "global")
        return refuse("global export lacks its canonical source storage owner");
      const global = mod.globals[slot.index - globalsImported];
      const binding = program.startup
        .flatMap((value) => value.bindings)
        .filter((value) => value.globalBindingId === target.plan.id);
      if (
        !global ||
        binding.length !== 1 ||
        target.contract.type.kind !== "val" ||
        global.type.kind !== target.contract.type.val.kind ||
        global.mutable !== target.contract.mutable
      )
        return refuse("global export source lifetime, storage type or mutability changed");
      // wrapExports preserves the real WebAssembly.Global. The prior callable-only
      // declaration product omitted it; scalar-value declarations would be wrong.
      census.push({ externalName: contract.externalName, kind: "source-global" });
      continue;
    }
    const intent = target.plan.intent;
    if (
      target.contract.kind !== "callable" ||
      intent.kind !== "callable" ||
      intent.origin !== "source" ||
      !intent.unitId ||
      slot.space !== "function" ||
      target.contract.promise
    )
      return refuse("export lacks a synchronous canonical source callable");
    const unit = program.units.get(intent.unitId);
    const functions = program.ir.functions.filter((value) => value.unitId === intent.unitId);
    const physical = plan.functions.filter(
      (value) => value.unitId === intent.unitId && value.bindingId === target.plan.id,
    );
    const fn = functions[0];
    const emitted = mod.functions[slot.index - functionsImported];
    const signature = emitted && types.entries[emitted.typeIdx]?.definition;
    if (
      !unit ||
      unit.kind === "module-init" ||
      functions.length !== 1 ||
      physical.length !== 1 ||
      !fn ||
      (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
      fn.asyncPlan ||
      fn.closureSubtype ||
      target.contract.ref.binding.kind !== "unit" ||
      target.contract.ref.binding.unitId !== unit.id ||
      !sameTypes(
        fn.params.map((value) => value.type),
        target.contract.params,
      ) ||
      !sameTypes(fn.resultTypes, target.contract.results) ||
      !signature ||
      signature.kind !== "func" ||
      !physicalMatches(physical[0]!.params, signature.params) ||
      !physicalMatches(physical[0]!.results, signature.results) ||
      fn.resultTypes.length > 1
    )
      return refuse("source unit, formal/result/effect contract and completed function signature disagree");
    declarations.push({
      externalName: contract.externalName,
      params: fn.params.map((value) => ({ name: value.name, type: scalar(value.type) })),
      result: fn.resultTypes.length ? scalar(fn.resultTypes[0]!) : "void",
    });
    census.push({ externalName: contract.externalName, kind: "source-callable" });
  }
  const adapter = emittedStartupAdapterIndex(emission);
  const adapterKind = plan.startup.adapter;
  const startupName =
    adapterKind === "deferred-export" ? "__module_init" : adapterKind === "wasi-start-export" ? "_start" : undefined;
  if ((adapterKind === "none") !== (adapter === undefined)) return refuse("startup adapter census changed");
  if (adapter !== undefined) {
    const fn = mod.functions[adapter - functionsImported];
    const type = fn && types.entries[fn.typeIdx]?.definition;
    if (
      !type ||
      type.kind !== "func" ||
      type.params.length ||
      type.results.length ||
      (adapterKind === "wasm-start" ? mod.startFuncIdx !== adapter : mod.startFuncIdx !== undefined)
    )
      return refuse("startup adapter signature or start disposition changed");
  } else if (mod.startFuncIdx !== undefined) return refuse("unexpected module start");
  for (const row of mod.exports) {
    if (names.has(row.name)) continue;
    if (startupName === row.name && row.desc.kind === "func" && row.desc.index === adapter) {
      names.add(row.name);
      census.push({ externalName: row.name, kind: "startup" });
      continue;
    }
    const memory = plan.linearMemory;
    const planned = memory?.exports.filter((value) => value.externalName === row.name);
    const actualMemory = mod.memories[0];
    if (
      row.desc.kind === "memory" &&
      planned?.length === 1 &&
      memory?.memory &&
      planned[0]!.targetKey === memory.memory.key &&
      row.desc.index === 0 &&
      mod.memories.length === 1 &&
      actualMemory?.min === memory.memory.min &&
      actualMemory.max === memory.memory.max
    ) {
      names.add(row.name);
      census.push({ externalName: row.name, kind: "linear-memory" });
      continue;
    }
    return refuse("unclassified physical export (including runtime/support/callback)");
  }
  if (
    new Set(mod.exports.map((row) => row.name)).size !== mod.exports.length ||
    census.length !== mod.exports.length ||
    (startupName && !names.has(startupName)) ||
    plan.linearMemory?.exports.some((row) => !names.has(row.externalName))
  )
    return refuse("complete physical export census differs");
  const view = freezePreparedIrValue({ declarations, census }) as NativePreparedDtsView;
  observations.set(view, { program, emission });
  return view;
}
// ECMAScript identifier grammar, including Unicode; reserved bindings get a
// deterministic private local and a TypeScript export-name alias.
const identifier = /^[$_\p{ID_Start}](?:[$\p{ID_Continue}]|\u200c|\u200d)*$/u;
const reserved = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield implements interface package private protected public static eval arguments".split(
    " ",
  ),
);
function bindingName(name: string): boolean {
  return identifier.test(name) && !reserved.has(name);
}
/** Genuine views reauthenticate their exact original semantic/physical pair on every render. */
export function renderNativePreparedDts(view: NativePreparedDtsView): string {
  const observation = observations.get(view);
  if (!observation) return refuse("invalid declaration view");
  assertPreparedIrProgram(observation.program);
  assertEmittedPreparedIrProgram(observation.program, observation.emission);
  const lines = ["// Generated by js2wasm", ""];
  const occupied = new Set(view.census.map((row) => row.externalName));
  let ordinal = 0;
  const local = (): string => {
    let name: string;
    do {
      name = `__native_export_${ordinal++}`;
    } while (occupied.has(name));
    occupied.add(name);
    return name;
  };
  for (const row of view.declarations) {
    const used = new Set<string>();
    const params = row.params
      .map((param, index) => {
        let name = param.name;
        if (!bindingName(name) || used.has(name)) {
          name = `__arg_${index}`;
          while (used.has(name)) name += "_";
        }
        used.add(name);
        return `${name}: ${param.type}`;
      })
      .join(", ");
    if (bindingName(row.externalName))
      lines.push(`export declare function ${row.externalName}(${params}): ${row.result};`);
    else {
      const name = local();
      lines.push(`declare function ${name}(${params}): ${row.result};`);
      const exportedName = identifier.test(row.externalName) ? row.externalName : JSON.stringify(row.externalName);
      lines.push(`export { ${name} as ${exportedName} };`);
    }
  }
  if (view.declarations.length) lines.push("");
  return lines.join("\n");
}
