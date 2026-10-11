// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrSourceRecord } from "../../shared/contracts/ir-unit-inventory.js";
import type { PreparedAsyncHostCapabilityId } from "../../runtime/contracts/async-provider-schema.js";
import { irSupportRef, irTypeEquals, irVal } from "../core/types.js";
import type { IrInstr } from "../core/nodes.js";
import { assertIrAsyncPlan } from "../analysis/async-plan.js";
import {
  assertPreparedIrAsyncRuntimeCurrent,
  preparedIrAsyncFrameCapabilityFailure,
} from "../runtime/async-attachment.js";
import type { CurrentPreparedIrAsyncRuntime, PreparedIrFunction as IrFunction } from "../runtime/contracts/prepared.js";
import {
  irCallableBindingKey,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../core/callable-bindings.js";
import { irSupportTypeRef } from "../core/type-references.js";
import { irTypeBindingKey } from "../core/type-binding-keys.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import { preparedIrCallableSignature, preparedIrDataKey } from "./abi-signatures.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrFuncRef } from "../core/value-references.js";
import type { IrType, IrTypeRef } from "../core/types.js";
import { planPreparedHostImport } from "./host-import-plan.js";
import { preparedHostAsyncDynamicCarrier } from "./host-async-dynamic.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";

export type PreparedAsyncFrameSignatureType = ValType | Extract<IrType, { kind: "support-ref" }>;

export interface PreparedAsyncFrameCallable {
  readonly reference: IrFuncRef;
  readonly bindingId: IrBindingId;
  readonly params: readonly PreparedAsyncFrameSignatureType[];
  readonly results: readonly PreparedAsyncFrameSignatureType[];
  readonly entry: ProgramAbiPlanEntry;
}

export interface PreparedHostAsyncFramePlan {
  readonly owner: IrUnitId;
  readonly kind: "host";
  readonly frame: {
    readonly reference: IrTypeRef;
    readonly entry: ProgramAbiPlanEntry;
    readonly fields: readonly {
      readonly name: string;
      readonly type: ValType;
      readonly mutable: boolean;
    }[];
  };
  readonly resultField: number;
  readonly values: readonly {
    readonly id: number;
    readonly type: ValType;
    readonly param?: number;
    readonly spill?: number;
  }[];
  readonly primary: PreparedAsyncFrameCallable;
  readonly auxiliaries: {
    readonly resume: PreparedAsyncFrameCallable;
    readonly fulfillStep: PreparedAsyncFrameCallable;
    readonly rejectStep: PreparedAsyncFrameCallable;
  };
  readonly imports: readonly (PreparedAsyncFrameCallable & {
    readonly capability: PreparedAsyncHostCapabilityId;
    readonly module: string;
    readonly field: string;
    readonly referenceKey: string;
  })[];
  readonly calls: readonly {
    readonly referenceKey: string;
    readonly bindingId: IrBindingId;
    readonly params: readonly ValType[];
    readonly results: readonly ValType[];
  }[];
  readonly conversions: readonly {
    readonly from: ValType;
    readonly to: ValType;
    readonly operation:
      | {
          readonly kind: "numeric";
          readonly op: "f64.convert_i32_s" | "i32.trunc_sat_f64_s" | "f64.promote_f32";
        }
      | { readonly kind: "helper"; readonly bindingId: IrBindingId };
  }[];
  readonly undefinedSource:
    | { readonly kind: "not-required" }
    | { readonly kind: "helper"; readonly bindingId: IrBindingId };
  readonly callbacks: readonly {
    readonly id: number;
    readonly externalName: string;
    readonly targetBindingId: IrBindingId;
    readonly entry: ProgramAbiPlanEntry;
  }[];
  /** Complete supplemental ABI rows, in caller-reserved declaration order. */
  readonly entries: readonly ProgramAbiPlanEntry[];
}

export interface PreparedHostAsyncFrameInput {
  readonly fn: IrFunction;
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  readonly abiEntries: readonly PreparedIrAbiEntry[];
  readonly anchor: IrSourceRecord;
  readonly declarationOrderStart: number;
  readonly callbacks: {
    readonly fulfill: number;
    readonly reject: number;
    readonly occupiedIds: readonly number[];
    readonly occupiedNames: readonly string[];
  };
}

export type PreparedHostAsyncFrameOutcome =
  | { readonly kind: "planned"; readonly plan: PreparedHostAsyncFramePlan }
  | {
      readonly kind: "unsupported";
      readonly unitId: IrUnitId;
      readonly feature: "prepared-host-async-frame";
      readonly detail: string;
      readonly stateId?: number;
      readonly valueId?: number;
    };

const ext: ValType = { kind: "externref" };
const i32: ValType = { kind: "i32" };
type PlannedImport = PreparedHostAsyncFramePlan["imports"][number];
type FrameValue = PreparedHostAsyncFramePlan["values"][number];

class FrameGap extends Error {
  constructor(
    message: string,
    readonly stateId?: number,
    readonly valueId?: number,
  ) {
    super(message);
  }
}

function gap(detail: string, stateId?: number, valueId?: number): never {
  throw new FrameGap(detail, stateId, valueId);
}

/** The adapter's kind-only conversions cannot preserve branded/unsigned domains. */
function scalar(type: IrType, where: string): ValType {
  const dynamic = preparedHostAsyncDynamicCarrier(type);
  if (dynamic) return dynamic;
  if (
    type.kind !== "val" ||
    type.typeRef ||
    type.signed === false ||
    !["i32", "i64", "f32", "f64", "externref"].includes(type.val.kind) ||
    Reflect.ownKeys(type.val).some((key) => key !== "kind")
  )
    return gap(`${where} requires an unsupported scalar/domain mapping`);
  return { ...type.val };
}

function abiCallable(entry: PreparedIrAbiEntry): Extract<PreparedIrAbiEntry["contract"], { kind: "callable" }> {
  const contract = entry.contract;
  if (
    contract.kind !== "callable" ||
    entry.plan.intent.kind !== "callable" ||
    entry.plan.structuralReferenceKey !== irCallableBindingKey(contract.ref.binding) ||
    preparedIrDataMismatch(entry.plan.intent.signature, preparedIrCallableSignature(contract.params, contract.results))
  )
    return gap(`callable ABI contract mismatch for ${entry.plan.displayName}`);
  return contract;
}

function authenticatedRuntime(input: PreparedHostAsyncFrameInput): CurrentPreparedIrAsyncRuntime {
  const { fn } = input;
  if (input.backend !== "wasmgc" || input.target !== "host")
    gap(`async frames do not support ${input.backend}:${input.target}`);
  const runtime = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
  assertIrAsyncPlan(runtime.plan);
  if (
    runtime.kind !== "host-wasmgc" ||
    fn.funcKind !== "async" ||
    runtime.plan.entry !== 0 ||
    runtime.plan.handlers.length ||
    !runtime.plan.states.length ||
    runtime.states.length !== runtime.plan.states.length
  )
    gap("unsupported async state graph or handlers");
  const missing = preparedIrAsyncFrameCapabilityFailure(runtime);
  if (missing) gap(missing);
  if (
    fn.params.length !== runtime.plan.params.length ||
    fn.params.some((p, index) => {
      const expected = runtime.plan.params[index]!;
      return p.value !== expected.value || !irTypeEquals(p.type, expected.type);
    })
  )
    gap("physical function parameter mapping differs from the semantic plan");
  return runtime;
}

function frameLayout(runtime: CurrentPreparedIrAsyncRuntime) {
  const semantic = runtime.plan;
  const fields = ["state", "sent", "mode", "abrupt", "error"].map((name, index) => ({
    name,
    type: index === 0 || index === 2 ? i32 : ext,
    mutable: true,
  }));
  const params = new Map(semantic.params.map((p, index) => [Number(p.value), index]));
  for (const [index, p] of semantic.params.entries())
    fields.push({
      name: `param_${index}`,
      type: scalar(p.type, `parameter ${index}`),
      mutable: false,
    });
  const spills = new Map<number, number>();
  for (const spill of semantic.spills) {
    if (spill.storage !== "ssa" && spill.storage !== "slot")
      gap(`spill ${spill.value} requires ${spill.storage} semantics`);
    if (params.has(Number(spill.value))) continue;
    if (scalar(spill.type, `spill ${spill.value}`).kind === "f32") gap(`spill ${spill.value} has no f32 frame default`);
    spills.set(Number(spill.value), fields.length);
    fields.push({
      name: `spill_${spill.value}`,
      type: scalar(spill.type, `spill ${spill.value}`),
      mutable: true,
    });
  }
  const values: FrameValue[] = semantic.values.map((value) => ({
    id: Number(value.value),
    type: scalar(value.type, `value ${value.value}`),
    ...(params.has(Number(value.value)) ? { param: params.get(Number(value.value))! } : {}),
    ...(spills.has(Number(value.value)) ? { spill: spills.get(Number(value.value))! } : {}),
  }));
  const resultField = fields.length;
  fields.push({ name: "result", type: ext, mutable: true });
  return { fields, values, resultField };
}

/** Supplementary declarations use the same canonical constructors as the main ABI. */
class Declarations {
  readonly entries: ProgramAbiPlanEntry[] = [];
  private next: number;
  constructor(readonly input: PreparedHostAsyncFrameInput) {
    this.next = input.declarationOrderStart;
    if (
      input.anchor.kind !== "entry" ||
      !Number.isSafeInteger(this.next) ||
      this.next < 0 ||
      !Number.isSafeInteger(input.anchor.order) ||
      input.anchor.order < 0
    )
      gap("invalid ABI anchor or declaration order");
  }
  order() {
    return {
      sourceOrder: this.input.anchor.order,
      declarationOrder: this.next++,
    };
  }
  add(entry: ProgramAbiPlanEntry): ProgramAbiPlanEntry {
    const existing = this.input.abiEntries.find((row) => row.plan.id === entry.id)?.plan;
    if (existing) {
      const { order: _oldOrder, displayName: _oldName, ...old } = existing;
      const { order: _newOrder, displayName: _newName, ...next } = entry;
      if (preparedIrDataMismatch(old, next)) gap(`supplementary ABI collision for ${entry.displayName}`);
      return existing;
    }
    if (
      this.entries.some((row) => row.id === entry.id) ||
      [...this.input.abiEntries.map((row) => row.plan), ...this.entries].some(
        (row) =>
          row.order.sourceOrder === entry.order.sourceOrder &&
          row.order.declarationOrder === entry.order.declarationOrder,
      )
    )
      gap(`supplementary ABI identity/order collision for ${entry.displayName}`);
    this.entries.push(entry);
    return entry;
  }
  callable(
    reference: IrFuncRef,
    bindingId: IrBindingId,
    params: readonly PreparedAsyncFrameSignatureType[],
    results: readonly PreparedAsyncFrameSignatureType[],
    origin: "import" | "support",
  ): PreparedAsyncFrameCallable {
    const logical = (type: PreparedAsyncFrameSignatureType): IrType =>
      type.kind === "support-ref" ? type : irVal(type);
    const entry = this.add({
      id: bindingId,
      order: this.order(),
      displayName: reference.name,
      structuralReferenceKey: irCallableBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin,
        ...(origin === "support" ? { unitId: this.input.fn.unitId } : {}),
        signature: preparedIrCallableSignature(params.map(logical), results.map(logical)),
      },
    });
    return { reference, bindingId, params, results, entry };
  }
  imports(runtime: CurrentPreparedIrAsyncRuntime): PlannedImport[] {
    if (runtime.kind !== "host-wasmgc") return gap("host adapters are absent");
    return runtime.adapters.map((adapter) => {
      const imported = planPreparedHostImport(this.input.anchor, this.next, adapter.record);
      this.next++;
      if (preparedIrDataMismatch(imported.reference.binding, adapter.target.binding) !== undefined)
        return gap("async adapter target differs from canonical host capability");
      return { ...imported, capability: adapter.capability, entry: this.add(imported.entry) };
    });
  }
}

function primary(
  input: PreparedHostAsyncFrameInput,
  runtime: CurrentPreparedIrAsyncRuntime,
): PreparedAsyncFrameCallable {
  const bindingId = irUnitCallableBindingId(input.fn.unitId);
  const own = input.abiEntries.find((row) => row.plan.id === bindingId);
  if (!own || own.plan.slotPolicy !== "required" || own.plan.slotSpace !== "function")
    return gap("missing primary callable ABI");
  const contract = abiCallable(own);
  if (
    contract.ref.binding.kind !== "unit" ||
    contract.ref.binding.unitId !== input.fn.unitId ||
    contract.params.length !== input.fn.params.length ||
    contract.params.some((p, i) => !irTypeEquals(p, input.fn.params[i]!.type)) ||
    preparedIrDataMismatch(contract.promise, runtime.plan.abi) ||
    contract.results.length !== 1 ||
    scalar(contract.results[0]!, "primary Promise result").kind !== "externref"
  )
    return gap("primary callable ABI is not the exact Promise signature");
  return {
    reference: irUnitFuncRef(input.fn),
    bindingId,
    entry: own.plan,
    params: contract.params.map((p) => scalar(p, "primary parameter")),
    results: [ext],
  };
}

/** Validate every operation before the detached emitter can be called. */
class Operations {
  readonly calls = new Map<string, PreparedHostAsyncFramePlan["calls"][number]>();
  readonly conversions: PreparedHostAsyncFramePlan["conversions"][number][] = [];
  undefinedSource: PreparedHostAsyncFramePlan["undefinedSource"] = {
    kind: "not-required",
  };
  private readonly values: Map<number, FrameValue>;
  constructor(
    readonly input: PreparedHostAsyncFrameInput,
    readonly runtime: CurrentPreparedIrAsyncRuntime,
    values: readonly FrameValue[],
    readonly imports: readonly PlannedImport[],
  ) {
    this.values = new Map(values.map((value) => [value.id, value]));
  }
  type(id: number, state: number): ValType {
    return this.values.get(id)?.type ?? gap(`unknown value ${id}`, state, id);
  }
  helper(capability: PreparedAsyncHostCapabilityId): PlannedImport {
    return this.imports.find((row) => row.capability === capability) ?? gap(`missing selected ${capability} adapter`);
  }
  convert(from: ValType, to: ValType, state: number): void {
    if (from.kind === to.kind || this.conversions.some((row) => row.from.kind === from.kind && row.to.kind === to.kind))
      return;
    let operation: PreparedHostAsyncFramePlan["conversions"][number]["operation"];
    if (from.kind === "f64" && to.kind === "externref")
      operation = {
        kind: "helper",
        bindingId: this.helper("number.box").bindingId,
      };
    else if (from.kind === "externref" && to.kind === "f64")
      operation = {
        kind: "helper",
        bindingId: this.helper("number.unbox").bindingId,
      };
    else if (from.kind === "i32" && to.kind === "f64") operation = { kind: "numeric", op: "f64.convert_i32_s" };
    else if (from.kind === "f64" && to.kind === "i32") operation = { kind: "numeric", op: "i32.trunc_sat_f64_s" };
    else if (from.kind === "f32" && to.kind === "f64") operation = { kind: "numeric", op: "f64.promote_f32" };
    else gap(`unsupported conversion ${from.kind} -> ${to.kind}`, state);
    this.conversions.push({ from, to, operation });
  }
  undefined(): void {
    this.undefinedSource = {
      kind: "helper",
      bindingId: this.helper("async.value.undefined").bindingId,
    };
  }
  result(instr: IrInstr, state: number): number {
    const logical = this.runtime.plan.values.find((row) => row.value === instr.result);
    if (instr.result === null || !instr.resultType || !logical || !irTypeEquals(logical.type, instr.resultType))
      return gap("untyped or foreign instruction result", state);
    scalar(instr.resultType, "instruction result");
    return Number(instr.result);
  }
  call(instr: Extract<IrInstr, { kind: "call" }>, state: number): void {
    const key = irCallableBindingKey(instr.target.binding);
    const rows = this.input.abiEntries.filter(
      (row) => row.plan.structuralReferenceKey === key && row.contract.kind === "callable",
    );
    if (rows.length !== 1) gap(`missing or ambiguous accepted call binding ${instr.target.name}`, state);
    let row = rows[0]!;
    const contract = abiCallable(row);
    const seen = new Set<IrBindingId>();
    while (row.plan.slotPolicy === "alias") {
      if (seen.has(row.plan.id)) gap("cyclic call alias", state);
      seen.add(row.plan.id);
      const targetId = row.plan.aliasOf;
      const next = this.input.abiEntries.find((candidate) => candidate.plan.id === targetId);
      if (!next) gap("missing call alias target", state);
      const target = abiCallable(next);
      if (
        preparedIrDataMismatch(
          preparedIrCallableSignature(target.params, target.results),
          preparedIrCallableSignature(contract.params, contract.results),
        )
      )
        gap("call alias signature mismatch", state);
      row = next;
    }
    if (
      row.plan.slotPolicy !== "required" ||
      row.plan.slotSpace !== "function" ||
      contract.params.length !== instr.args.length ||
      contract.results.length > 1
    )
      gap("unsupported call signature", state);
    const params = contract.params.map((type) => scalar(type, "call parameter"));
    const results = contract.results.map((type) => scalar(type, "call result"));
    instr.args.forEach((id, index) => this.convert(this.type(Number(id), state), params[index]!, state));
    if (instr.result !== null) {
      if (results.length !== 1) gap("missing call result", state);
      this.convert(results[0]!, this.type(this.result(instr, state), state), state);
    } else if (instr.resultType !== null) gap("discarded call retains a result type", state);
    this.calls.set(key, {
      referenceKey: key,
      bindingId: row.plan.id,
      params,
      results,
    });
  }
  instruction(instr: IrInstr, state: number): void {
    if (instr.kind === "call") {
      this.call(instr, state);
      return;
    }
    if (instr.kind !== "const") gap(`unsupported instruction ${instr.kind}`, state);
    const to = this.type(this.result(instr, state), state);
    const literal = instr.value;
    let from: ValType;
    switch (literal.kind) {
      case "undefined":
        this.undefined();
        from = ext;
        break;
      case "null":
        from = ext;
        break;
      case "bool":
        from = i32;
        break;
      case "i32":
      case "i64":
      case "f32":
      case "f64":
        from = { kind: literal.kind };
        break;
      default:
        gap("unsupported constant", state);
    }
    this.convert(from, to, state);
  }
  states(): void {
    const semantic = this.runtime.plan;
    const resumes = new Set<number>();
    for (const state of semantic.states)
      if (state.terminator.kind === "suspend") {
        const term = state.terminator;
        const next = semantic.states[Number(term.resume.state)];
        if (
          term.rejected.kind !== "reject" ||
          next?.resume?.source !== "fulfilled" ||
          next.resume.value !== term.resume.value
        )
          gap("unsupported suspend edge", Number(state.id));
        resumes.add(Number(term.resume.state));
        for (const id of term.live) {
          const value = this.values.get(Number(id));
          if (!value || (value.param === undefined && value.spill === undefined))
            gap("missing live spill", Number(state.id), Number(id));
        }
      }
    const direct = (id: number, state: number): void => {
      if (!semantic.states[id] || semantic.states[id]!.resume) gap("invalid direct successor", state);
    };
    semantic.states.forEach((state, index) => {
      const projected = this.runtime.states[index]!;
      const { body: _semanticBody, ...metadata } = state;
      const { body: _physicalBody, ...physicalMetadata } = projected;
      if (state.id !== index || preparedIrDataMismatch(metadata, physicalMetadata))
        gap("state identity/edge mismatch", index);
      for (const instr of projected.body) this.instruction(instr, index);
      for (const update of state.updates ?? []) {
        if (this.values.get(Number(update.target))?.param !== undefined)
          gap("parameter update requires mutable carrier", index);
        this.convert(this.type(Number(update.value), index), this.type(Number(update.target), index), index);
      }
      if (state.resume) {
        if (state.resume.source !== "fulfilled" || !resumes.has(index)) gap("unbound resume state", index);
        this.convert(ext, this.type(Number(state.resume.value), index), index);
      }
      const term = state.terminator;
      switch (term.kind) {
        case "suspend":
          this.convert(this.type(Number(term.awaited), index), ext, index);
          break;
        case "resolve":
          if (term.value === undefined) this.undefined();
          else this.convert(this.type(Number(term.value), index), ext, index);
          break;
        case "goto":
          direct(Number(term.target), index);
          break;
        case "branch":
          if (this.type(Number(term.condition), index).kind !== "i32") gap("branch condition is not i32", index);
          direct(Number(term.ifTrue), index);
          direct(Number(term.ifFalse), index);
          break;
        default:
          gap(`unsupported terminator ${term.kind}`, index);
      }
    });
  }
}

function machinery(declarations: Declarations, fields: PreparedHostAsyncFramePlan["frame"]["fields"]) {
  const { input } = declarations;
  const reference = irSupportTypeRef(input.fn.unitId, "prepared-async-frame", `${input.fn.name}__frame`);
  const frame = {
    reference,
    fields,
    entry: declarations.add({
      id: reference.binding.bindingId,
      order: declarations.order(),
      displayName: reference.name,
      structuralReferenceKey: irTypeBindingKey(reference.binding),
      slotPolicy: "required",
      slotSpace: "type",
      intent: {
        kind: "type",
        shapeKey: preparedIrDataKey({ kind: "struct", fields }),
      },
    }),
  };
  const helper = (role: string, params: readonly PreparedAsyncFrameSignatureType[], results: readonly ValType[]) => {
    const ref = irSupportFuncRef(input.fn.unitId, `prepared-async-frame:${role}`, `${input.fn.name}__${role}`);
    if (ref.binding.kind !== "support") return gap("support constructor lost its binding");
    return declarations.callable(ref, ref.binding.bindingId, params, results, "support");
  };
  const auxiliaries = {
    resume: helper("resume", [irSupportRef(reference, false)], []),
    fulfillStep: helper("fulfill", [ext, ext], [ext]),
    rejectStep: helper("reject", [ext, ext], [ext]),
  };
  const ids = [input.callbacks.fulfill, input.callbacks.reject];
  const existingNames = input.abiEntries.flatMap((row) =>
    row.contract.kind === "export" ? [row.contract.externalName] : [],
  );
  if (
    ids[0] === ids[1] ||
    ids.some(
      (id) =>
        !Number.isSafeInteger(id) ||
        id < 0 ||
        id > 0x7fffffff ||
        input.callbacks.occupiedIds.includes(id) ||
        [...input.callbacks.occupiedNames, ...existingNames].includes(`__cb_${id}`),
    )
  )
    gap("callback IDs/names are invalid or occupied");
  const callbacks = ids.map((id, index) => {
    const externalName = `__cb_${id}`;
    const targetBindingId = index === 0 ? auxiliaries.fulfillStep.bindingId : auxiliaries.rejectStep.bindingId;
    return {
      id,
      externalName,
      targetBindingId,
      entry: declarations.add({
        id: createIrBindingId({
          ownerId: input.fn.unitId,
          domain: "export",
          role: `prepared-async-frame:callback:${index}`,
        }),
        order: declarations.order(),
        displayName: externalName,
        slotPolicy: "alias",
        aliasOf: targetBindingId,
        intent: { kind: "export", externalName, targetId: targetBindingId },
      }),
    };
  });
  return { frame, auxiliaries, callbacks };
}

/** Data-only preflight. Acceptance must rederive it against its exact current projection before allocation. */
export function planPreparedHostAsyncFrame(input: PreparedHostAsyncFrameInput): PreparedHostAsyncFrameOutcome {
  try {
    const runtime = authenticatedRuntime(input);
    const entry = primary(input, runtime);
    const layout = frameLayout(runtime);
    const declarations = new Declarations(input);
    const imports = declarations.imports(runtime);
    const operations = new Operations(input, runtime, layout.values, imports);
    operations.states();
    const resources = machinery(declarations, layout.fields);
    const plan: PreparedHostAsyncFramePlan = {
      owner: input.fn.unitId,
      kind: "host",
      ...resources,
      resultField: layout.resultField,
      values: layout.values,
      primary: entry,
      imports,
      calls: [...operations.calls.values()],
      conversions: operations.conversions,
      undefinedSource: operations.undefinedSource,
      entries: declarations.entries,
    };
    return {
      kind: "planned",
      plan: freezePreparedIrValue(plan) as PreparedHostAsyncFramePlan,
    };
  } catch (error) {
    if (!(error instanceof FrameGap)) throw error;
    return {
      kind: "unsupported",
      unitId: input.fn.unitId,
      feature: "prepared-host-async-frame",
      detail: error instanceof Error ? error.message : String(error),
      ...(error instanceof FrameGap && error.stateId !== undefined ? { stateId: error.stateId } : {}),
      ...(error instanceof FrameGap && error.valueId !== undefined ? { valueId: error.valueId } : {}),
    };
  }
}
