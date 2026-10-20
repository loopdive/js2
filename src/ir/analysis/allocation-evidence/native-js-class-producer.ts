// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachInstrDeep,
  directUses,
  type IrModule,
  type IrFunction,
  type IrInstr,
  type IrValueId,
  type AllocSiteId,
} from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { irGlobalBindingKey } from "../../core/global-binding-keys.js";
import { irRuntimeFuncRef, irCallableBindingKey } from "../../core/callable-bindings.js";
import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import type { EscapeClass } from "../contracts/allocations.js";
import { nativeJsClassEffects, type NativeJsClassEvidenceDomain } from "./native-js-class-effects.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

const scalar = new Set([
  "const",
  "binary",
  "unary",
  "select",
  "tag.test",
  "dyn.to_number",
  "dyn.eq",
  "dyn.truthy",
  "unbox",
]);
const memory = new Set([
  "box",
  "vec.new_fixed",
  "vec.get",
  "vec.len",
  "vec.set",
  "refcell.new",
  "refcell.get",
  "refcell.set",
  "closure.new",
  "call",
]);
const flow = new Set(["slot.read", "slot.write", "if", "if.stmt", "early.return"]);
const escapeOrder: readonly EscapeClass[] = ["local", "returned", "stored", "captured", "opaque"];
const accessOrder = ["read", "write", "mutate", "identity", "escape"] as const;
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class producer: ${detail}`);
}
function unsupported(detail: string): never {
  throw new IrUnsupportedError("class-member-unsupported", "build", `native JS class allocation profile: ${detail}`);
}
function visit(fn: IrFunction, observer: (instruction: IrInstr) => void): void {
  for (const block of fn.blocks) for (const instruction of block.instrs) forEachInstrDeep(instruction, observer);
}
function reference(type: IrType | null): boolean {
  return type !== null && type.kind !== "val";
}

/** Exact semantic declarations, not permission from a global name or opcode. */
function checkGlobalAndErrorOperation(
  instruction: IrInstr,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
  domain: NativeJsClassEvidenceDomain,
): boolean {
  if (instruction.kind === "global.get" || instruction.kind === "global.set") {
    const ref = instruction.target;
    if (ref.binding.kind !== "source") unsupported("non-source global transport");
    const entries = domain.programData?.abiEntries as
      | readonly {
          plan: {
            id: string;
            slotPolicy: string;
            slotSpace?: string;
            structuralReferenceKey?: string;
            intent: { kind: string; valueType?: string; mutable?: boolean };
          };
          contract: { kind: string; ref?: unknown; type?: IrType; mutable?: boolean };
        }[]
      | undefined;
    const matches = entries?.filter((entry) => entry.plan.structuralReferenceKey === irGlobalBindingKey(ref.binding));
    if (matches?.length !== 1) invalid("global operation lacks its complete actual ABI declaration");
    const entry = matches[0]!,
      type = entry.contract.type;
    if (!type || type.kind !== "val" || !["i32", "f64"].includes(type.val.kind))
      unsupported("non-scalar global transport");
    if (
      entry.contract.kind !== "global" ||
      entry.plan.id !== ref.binding.bindingId ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "global" ||
      entry.plan.intent.kind !== "global" ||
      entry.plan.intent.valueType !==
        `${type.val.kind}:${JSON.stringify({ kind: "val", val: Object.fromEntries(Object.entries(type.val).sort(([a], [b]) => a.localeCompare(b))) })}` ||
      entry.plan.intent.mutable !== entry.contract.mutable ||
      preparedIrDataMismatch(entry.contract.ref, ref) !== undefined
    )
      invalid("global operation has contradictory actual ABI");
    if (instruction.kind === "global.get") {
      if (preparedIrDataMismatch(instruction.resultType, type) !== undefined) invalid("global read type");
    } else if (!entry.contract.mutable || preparedIrDataMismatch(types.get(instruction.value), type) !== undefined)
      invalid("global write mutability/type");
    return true;
  }
  if (instruction.kind === "call" && instruction.target.binding.kind !== "unit") {
    const canonical = irRuntimeFuncRef("__new_ReferenceError");
    if (preparedIrDataMismatch(instruction.target, canonical) !== undefined) unsupported("foreign runtime call");
    const extern = { kind: "val", val: { kind: "externref" } };
    const entries = domain.programData?.abiEntries as
      | readonly {
          plan: {
            structuralReferenceKey?: string;
            slotPolicy: string;
            slotSpace?: string;
            intent: { kind: string; origin?: string; signature?: unknown };
          };
          contract: { kind: string; ref?: unknown; params?: unknown; results?: unknown };
        }[]
      | undefined;
    const matches = entries?.filter(
      (entry) => entry.plan.structuralReferenceKey === irCallableBindingKey(canonical.binding),
    );
    if (matches?.length !== 1) invalid("ReferenceError call lacks its complete actual ABI");
    const entry = matches[0]!;
    if (
      entry.contract.kind !== "callable" ||
      entry.plan.intent.kind !== "callable" ||
      entry.plan.intent.origin !== "runtime" ||
      entry.plan.slotPolicy !== "required" ||
      entry.plan.slotSpace !== "function" ||
      preparedIrDataMismatch(entry.contract.ref, canonical) !== undefined ||
      preparedIrDataMismatch(entry.contract.params, [extern]) !== undefined ||
      preparedIrDataMismatch(entry.contract.results, [extern]) !== undefined ||
      preparedIrDataMismatch(entry.plan.intent.signature, {
        params: [`externref:${JSON.stringify(extern)}`],
        results: [`externref:${JSON.stringify(extern)}`],
      }) !== undefined
    )
      invalid("ReferenceError callable ABI");
    const payload = definitions.get(instruction.args[0]!);
    if (
      instruction.args.length !== 1 ||
      payload?.kind !== "const" ||
      payload.value.kind !== "null" ||
      preparedIrDataMismatch(payload.resultType, extern) !== undefined ||
      preparedIrDataMismatch(instruction.resultType, extern) !== undefined
    )
      unsupported("ReferenceError requires its actual null message and extern result");
    return true;
  }
  if (instruction.kind === "coerce.to_externref") {
    if (
      types.get(instruction.value)?.kind !== "dynamic" ||
      preparedIrDataMismatch(instruction.resultType, { kind: "val", val: { kind: "externref" } }) !== undefined
    )
      unsupported("exception conversion requires an actual tagged JSValue and externref result");
    return true;
  }
  if (instruction.kind === "throw") {
    const producer = definitions.get(instruction.value);
    if (producer?.kind === "coerce.to_externref") {
      checkGlobalAndErrorOperation(producer, types, definitions, domain);
      return true;
    }
    if (
      producer?.kind !== "call" ||
      preparedIrDataMismatch(producer.target, irRuntimeFuncRef("__new_ReferenceError")) !== undefined
    )
      unsupported("noncanonical error throw transport");
    checkGlobalAndErrorOperation(producer, types, definitions, domain);
    return true;
  }
  return false;
}
/** Independent producer. Opaque calls conservatively retain every possible managed argument root. */
export function analyzeNativeJsClass(
  module: IrModule,
  registry: AllocSiteRegistry,
  domain: NativeJsClassEvidenceDomain | undefined,
): boolean {
  assertPreparedIrData(module);
  if (domain !== undefined) assertPreparedIrData(domain);
  let selected = domain !== undefined && domain.definitions.length > 0;
  for (const fn of module.functions)
    visit(fn, (instr) => {
      if ((instr.kind as string).startsWith("js.class.")) selected = true;
    });
  if (!selected) return false;
  if (!domain) invalid("selected population has no current definition domain");
  assertPreparedIrData(domain);
  const definitions = new Set(domain.definitions.map((row) => row.id));
  if (definitions.size !== domain.definitions.length || definitions.size === 0) invalid("definition population");
  if (
    preparedIrDataMismatch(
      domain.unitIds,
      module.functions.map((fn) => fn.unitId),
    ) !== undefined
  )
    invalid("complete unit population");
  const occurrences = new Map<string, number>();
  for (const fn of module.functions)
    visit(fn, (instr) => {
      if (instr.kind === "js.class.define")
        occurrences.set(instr.definition, (occurrences.get(instr.definition) ?? 0) + 1);
    });
  for (const id of definitions) if (occurrences.get(id) !== 1) invalid("definition occurrence census");
  const classBodyUnits = new Set(
    domain.definitions.flatMap(({ definition }) => [
      definition.constructor.unitId,
      ...definition.members.map((member) => member.body.unitId),
      ...definition.instanceElements.flatMap((element) => (element.initializer ? [element.initializer.unitId] : [])),
    ]),
  );
  const sites = new Map<AllocSiteId, { ops: Set<string>; escape: EscapeClass; shared: boolean }>();
  const rows = new Map<IrInstr, AllocSiteId>();
  for (const fn of module.functions) {
    if (fn.blocks.length !== 1 || fn.asyncPlan) unsupported("nonclosed control or async body");
    const valueTypes = new Map(fn.params.map((parameter) => [parameter.value, parameter.type]));
    const actualDefinitions = new Map<IrValueId, IrInstr>();
    visit(fn, (instr) => {
      if (instr.result !== null && instr.resultType !== null) {
        valueTypes.set(instr.result, instr.resultType);
        actualDefinitions.set(instr.result, instr);
      }
    });
    visit(fn, (instr) => {
      if (
        instr.kind === "js.class.property.get" &&
        (instr.resultType?.kind !== "dynamic" || instr.resultType.tag !== undefined)
      )
        unsupported("mutable property read requires an unrefined JSValue");
      if (
        (instr.kind === "js.class.property.set" || instr.kind === "js.class.property.define") &&
        valueTypes.get(instr.value)?.kind !== "dynamic"
      )
        unsupported("stored property requires an existing immutable JSValue");
      if (
        instr.kind === "call" &&
        instr.target.binding.kind === "unit" &&
        classBodyUnits.has(instr.target.binding.unitId)
      )
        unsupported("class-owned callable requires its explicit protocol");
      const effect = nativeJsClassEffects(instr);
      if (effect?.definition && !definitions.has(effect.definition)) invalid("foreign definition operand");
      const scoped = checkGlobalAndErrorOperation(instr, valueTypes, actualDefinitions, domain);
      if (!effect && !scoped && !scalar.has(instr.kind) && !memory.has(instr.kind) && !flow.has(instr.kind))
        unsupported(`instruction ${instr.kind}`);
      if (instr.alloc === undefined) return;
      const site = registry.resolve(instr.alloc);
      if (!site || instr.result === null || instr.resultType === null) invalid("unknown allocation occurrence");
      if (site.id !== instr.alloc || sites.has(site.id)) invalid("reused or aliased allocation occurrence");
      if (
        preparedIrDataMismatch(site.type, instr.resultType) !== undefined ||
        preparedIrDataMismatch(site.origin, instr.site) !== undefined
      )
        invalid("allocation result type or source origin changed");
      const kind =
        effect?.allocationKind ??
        (instr.kind === "box"
          ? "box"
          : instr.kind === "vec.new_fixed"
            ? "array"
            : instr.kind === "refcell.new"
              ? "refcell"
              : instr.kind === "closure.new"
                ? "closure"
                : undefined);
      if (kind === undefined || site.kind !== kind) invalid("allocation kind changed");
      sites.set(site.id, { ops: new Set(), escape: "local", shared: false });
      rows.set(instr, site.id);
    });
  }
  const universe = new Set(sites.keys());
  for (const fn of module.functions) {
    const roots = new Map<IrValueId, Set<AllocSiteId>>();
    const slots = new Map<number, Set<AllocSiteId>>();
    for (const param of fn.params) if (reference(param.type)) roots.set(param.value, new Set(universe));
    const merge = (target: Set<AllocSiteId>, incoming: Iterable<AllocSiteId>): boolean => {
      let changed = false;
      for (const id of incoming)
        if (!target.has(id)) {
          target.add(id);
          changed = true;
        }
      return changed;
    };
    const from = (values: readonly IrValueId[]) => new Set(values.flatMap((id) => [...(roots.get(id) ?? [])]));
    const bind = (id: IrValueId, values: Iterable<AllocSiteId>) => {
      const current = roots.get(id) ?? new Set<AllocSiteId>();
      roots.set(id, current);
      return merge(current, values);
    };
    // The finite body has no backedge. A monotone union closes structured joins and mutable slots.
    for (let iteration = 0; ; iteration++) {
      let changed = false;
      visit(fn, (instr) => {
        const row = instr as unknown as Record<string, unknown>;
        const allocation = rows.get(instr);
        if (allocation !== undefined && instr.result !== null) changed = bind(instr.result, [allocation]) || changed;
        if (instr.kind === "slot.write") {
          const slot = row.slotIndex as number,
            values = from([row.value as IrValueId]);
          const current = slots.get(slot) ?? new Set<AllocSiteId>();
          slots.set(slot, current);
          changed = merge(current, values) || changed;
        }
        if (instr.result === null || (!reference(instr.resultType) && instr.kind !== "coerce.to_externref")) return;
        if (instr.kind === "coerce.to_externref") changed = bind(instr.result, from([instr.value])) || changed;
        else if (instr.kind === "slot.read")
          changed = bind(instr.result, slots.get(row.slotIndex as number) ?? []) || changed;
        else if (instr.kind === "if")
          changed = bind(instr.result, from([row.thenValue as IrValueId, row.elseValue as IrValueId])) || changed;
        else if (allocation === undefined || (instr.kind as string) === "js.class.construct") {
          // A field, captured value, call result, or replacement can designate any compatible
          // managed program allocation. This profile intentionally does not promise local calls.
          changed = bind(instr.result, universe) || changed;
        }
      });
      if (!changed) break;
      if (iteration > module.functions.length + sites.size + roots.size + slots.size + 1)
        invalid("root closure did not converge");
    }
    const touch = (values: readonly IrValueId[], op: string, classification?: EscapeClass) => {
      const targets = from(values);
      for (const id of targets) {
        const site = sites.get(id)!;
        site.ops.add(op);
        if (targets.size > 1) site.shared = true;
        if (classification && escapeOrder.indexOf(classification) > escapeOrder.indexOf(site.escape))
          site.escape = classification;
      }
    };
    visit(fn, (instr) => {
      const effect = nativeJsClassEffects(instr),
        row = instr as unknown as Record<string, unknown>;
      if (effect) {
        touch(effect.reads, "read");
        touch(effect.writes, "write");
        touch(effect.identities, "identity");
        touch(effect.captured, "escape", "captured");
        touch(effect.stored, "escape", "stored");
        touch(effect.opaque, "escape", "opaque");
        if ((instr.kind as string) === "js.class.construct" && instr.result !== null)
          touch([instr.result], "escape", "opaque");
      } else {
        touch(directUses(instr), "read");
        if (instr.kind === "call" || instr.kind === "closure.new")
          touch(directUses(instr), "escape", instr.kind === "call" ? "opaque" : "captured");
        if (instr.kind === "vec.set" || instr.kind === "refcell.set") {
          touch(directUses(instr), "write");
          touch([(instr.kind === "vec.set" ? row.newValue : row.value) as IrValueId], "escape", "stored");
        }
        if (instr.kind === "early.return")
          touch(row.value === null ? [] : [row.value as IrValueId], "escape", "returned");
        if (instr.kind === "throw") touch([instr.value], "escape", "opaque");
      }
    });
    const terminator = fn.blocks[0]!.terminator;
    if (terminator.kind !== "return") unsupported("nonreturn terminal");
    touch(terminator.values, "escape", "returned");
  }
  for (const [id, site] of sites) {
    registry.annotate(id, ALLOC_NAMESPACES.ownership, {
      state: site.escape !== "local" ? "escaped" : site.shared ? "shared" : "owned",
      ops: accessOrder.filter((op) => site.ops.has(op)),
    });
    registry.annotate(id, ALLOC_NAMESPACES.escape, {
      classification: site.escape,
      stackAllocatable: site.escape === "local",
    });
  }
  return true;
}
