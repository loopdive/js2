// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrInstr } from "../core/nodes.js";
import { irTypeEquals } from "../core/types.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import type { CurrentPreparedIrAsyncRuntime } from "../runtime/contracts/prepared.js";
import type { ValType } from "../../wasm/model/instructions.js";
import { preparedIrCallableSignature } from "./abi-signatures.js";
import { preparedIrDataMismatch } from "./data.js";
import { gap, scalar, abiCallable } from "./prepared-async-frame-layout.js";
import type {
  PreparedFrameInput,
  PreparedHostAsyncFramePlan,
  FrameValue,
  FrameBridge,
  FrameNumericConversion,
  NativeFrameBridge,
} from "./prepared-async-frame-contracts.js";
const ext: ValType = { kind: "externref" };
const i32: ValType = { kind: "i32" };

/** Validate every operation before the detached emitter can be called. */
export class FrameOperations<B extends FrameBridge> {
  readonly calls = new Map<string, PreparedHostAsyncFramePlan["calls"][number]>();
  readonly conversions: { from: ValType; to: ValType; operation: FrameNumericConversion | B }[] = [];
  undefinedSource: { readonly kind: "not-required" } | B = {
    kind: "not-required",
  };
  private readonly values: Map<number, FrameValue>;
  constructor(
    readonly input: PreparedFrameInput,
    readonly runtime: CurrentPreparedIrAsyncRuntime,
    values: readonly FrameValue[],
    readonly bridge: (capability: NativeFrameBridge["role"]) => B,
    readonly mode: "host" | "native" = "host",
  ) {
    this.values = new Map(values.map((value) => [value.id, value]));
  }
  type(id: number, state: number): ValType {
    return this.values.get(id)?.type ?? gap(`unknown value ${id}`, state, id);
  }
  convert(from: ValType, to: ValType, state: number): void {
    if (from.kind === to.kind || this.conversions.some((row) => row.from.kind === from.kind && row.to.kind === to.kind))
      return;
    let operation: FrameNumericConversion | B;
    if (from.kind === "f64" && to.kind === "externref") operation = this.bridge("number.box");
    else if (from.kind === "externref" && to.kind === "f64") operation = this.bridge("number.unbox");
    else if (from.kind === "i32" && to.kind === "f64") operation = { kind: "numeric", op: "f64.convert_i32_s" };
    else if (from.kind === "f64" && to.kind === "i32") operation = { kind: "numeric", op: "i32.trunc_sat_f64_s" };
    else if (from.kind === "f32" && to.kind === "f64") operation = { kind: "numeric", op: "f64.promote_f32" };
    else gap(`unsupported conversion ${from.kind} -> ${to.kind}`, state);
    this.conversions.push({ from, to, operation });
  }
  undefined(): void {
    this.undefinedSource = this.bridge("async.value.undefined");
  }
  result(instr: IrInstr, state: number): number {
    const logical = this.runtime.plan.values.find((row) => row.value === instr.result);
    if (instr.result === null || !instr.resultType || !logical || !irTypeEquals(logical.type, instr.resultType))
      return gap("untyped or foreign instruction result", state);
    scalar(instr.resultType, "instruction result", this.mode);
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
    const params = contract.params.map((type) => scalar(type, "call parameter", this.mode));
    const results = contract.results.map((type) => scalar(type, "call result", this.mode));
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
