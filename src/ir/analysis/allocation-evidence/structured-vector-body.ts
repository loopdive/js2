// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { directUses, type IrFunction, type IrInstr, type IrValueId } from "../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../core/types.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import { primitiveKind, profileInstructionExclusion } from "./effect-rules.js";
import { numericVector, vectorAssignable, StructuredVectorFacts } from "./structured-vector-facts.js";
import type { NativeModuleGlobalEvidence } from "./module-vector-globals.js";
import { irGlobalBindingKey } from "../../core/global-binding-keys.js";
import type { AllocationEvidenceCensus, AllocationEvidenceFailure } from "./contracts.js";
export interface StructuredScope {
  values: Map<IrValueId, IrType>;
  initialized: Set<number>;
  normal: boolean;
}
export function copyStructuredScope(scope: StructuredScope): StructuredScope {
  return { values: new Map(scope.values), initialized: new Set(scope.initialized), normal: scope.normal };
}
export class StructuredEvidenceRefusal extends Error {
  constructor(readonly report: AllocationEvidenceFailure) {
    super(report.kind);
  }
}
const binary =
  /^(?:i32\.(?:add|sub|mul|and|or|xor|eq|ne|lt_s|lt_u|le_s|le_u|gt_s|gt_u|ge_s|ge_u)|f64\.(?:add|sub|mul|div|min|max|eq|ne|lt|le|gt|ge))$/;
const unaryInputs: Readonly<Record<string, "i32" | "f64">> = {
  "f64.convert_i32_s": "i32",
  "f64.convert_i32_u": "i32",
  "i32.trunc_sat_f64_s": "f64",
  "i32.trunc_sat_f64_u": "f64",
  "i32.eqz": "i32",
  "f64.neg": "f64",
  "f64.abs": "f64",
};
/** Lexical body walk with definite scalar-slot initialization and isolated child scopes. */
export class StructuredVectorBody {
  readonly seen = new Set<IrValueId>();
  readonly facts = new StructuredVectorFacts();
  private readonly buffers = new Set<readonly IrInstr[]>();
  constructor(
    readonly fn: IrFunction,
    private readonly functions: ReadonlyMap<IrFunction["unitId"], IrFunction>,
    private readonly registry: AllocRegistrySnapshot,
    readonly census: { -readonly [K in keyof AllocationEvidenceCensus]: number },
    private readonly globals?: ReadonlyMap<string, NativeModuleGlobalEvidence>,
  ) {}
  fail(code: Extract<AllocationEvidenceFailure, { kind: "invalid" }>["code"]): never {
    throw new StructuredEvidenceRefusal({ kind: "invalid", code, at: { kind: "function", unitId: this.fn.unitId } });
  }
  refuse(reason: Extract<AllocationEvidenceFailure, { kind: "not-covered" }>["reason"] = "instruction-kind"): never {
    throw new StructuredEvidenceRefusal({
      kind: "not-covered",
      reason,
      at: { kind: "function", unitId: this.fn.unitId },
    });
  }
  define(value: IrValueId, type: IrType, scope: StructuredScope): void {
    if (!Number.isSafeInteger(value) || value < 0 || value >= this.fn.valueCount || this.seen.has(value))
      this.fail("lexical-definition");
    this.seen.add(value);
    scope.values.set(value, type);
  }
  returns(values: readonly IrValueId[], scope: StructuredScope): void {
    if (values.length !== this.fn.resultTypes.length) this.fail("lexical-definition");
    values.forEach((value, index) => {
      const actual = scope.values.get(value);
      if (!actual || !vectorAssignable(actual, this.fn.resultTypes[index]!)) this.fail("lexical-definition");
      this.facts.escape(value, "returned");
    });
  }
  visit(buffer: readonly IrInstr[], scope: StructuredScope, depth = 0): void {
    if (this.buffers.has(buffer)) this.fail("occurrence-mismatch");
    if (depth > 128 || this.census.instructions > 100000) this.refuse("resource-limit");
    this.buffers.add(buffer);
    this.census.buffers++;
    for (const instr of buffer) {
      this.census.instructions++;
      const control =
        instr.kind === "if" || instr.kind === "if.stmt" || instr.kind === "for.loop" || instr.kind === "while.loop";
      if (!control && directUses(instr).some((value) => !scope.values.has(value))) this.fail("lexical-definition");
      if (instr.kind !== "vec.new_fixed" && instr.alloc !== undefined) this.refuse();
      if (control) this.control(instr, scope, depth);
      else this.leaf(instr, scope);
      if (instr.result !== null) {
        if (instr.resultType === null) this.fail("lexical-definition");
        this.define(instr.result, instr.resultType, scope);
      } else if (instr.resultType !== null) this.fail("lexical-definition");
    }
    this.buffers.delete(buffer);
  }
  private control(
    instr: Extract<IrInstr, { kind: "if" | "if.stmt" | "for.loop" | "while.loop" }>,
    scope: StructuredScope,
    depth: number,
  ): void {
    if (instr.kind === "if" || instr.kind === "if.stmt") {
      if (primitiveKind(scope.values.get(instr.cond)) !== "i32") this.fail("lexical-definition");
      const left = copyStructuredScope(scope),
        right = copyStructuredScope(scope);
      this.visit(instr.then, left, depth + 1);
      this.visit(instr.else, right, depth + 1);
      if (instr.kind === "if") {
        if (
          instr.result === null ||
          !instr.resultType ||
          (!primitiveKind(instr.resultType) && !numericVector(instr.resultType)) ||
          !left.normal ||
          !right.normal
        )
          this.refuse();
        for (const [child, value] of [
          [left, instr.thenValue],
          [right, instr.elseValue],
        ] as const) {
          const actual = child.values.get(value);
          if (!actual || !vectorAssignable(actual, instr.resultType)) this.fail("lexical-definition");
        }
        if (numericVector(instr.resultType)) this.facts.alias(instr.result, instr.thenValue, instr.elseValue);
      } else if (instr.result !== null || instr.resultType !== null) this.fail("lexical-definition");
      const exits = [left, right].filter((child) => child.normal);
      if (exits.length)
        scope.initialized = new Set(
          [...exits[0]!.initialized].filter((slot) => exits.every((child) => child.initialized.has(slot))),
        );
      scope.normal = scope.normal && exits.length > 0;
      return;
    }
    if (instr.result !== null || instr.resultType !== null) this.fail("lexical-definition");
    const condition = copyStructuredScope(scope),
      body = copyStructuredScope(scope);
    if (instr.kind === "while.loop" && instr.postCond) {
      this.visit(instr.body, body, depth + 1);
      condition.initialized = new Set(body.initialized);
      this.visit(instr.cond, condition, depth + 1);
    } else {
      this.visit(instr.cond, condition, depth + 1);
      body.initialized = new Set(condition.initialized);
      this.visit(instr.body, body, depth + 1);
    }
    if (primitiveKind(condition.values.get(instr.condValue)) !== "i32") this.fail("lexical-definition");
    if (!condition.normal && scope.normal) this.refuse();
    if (instr.kind === "for.loop") {
      const update = copyStructuredScope(scope);
      update.initialized = new Set(body.normal ? body.initialized : condition.initialized);
      update.normal = body.normal;
      this.visit(instr.update, update, depth + 1);
    }
    // Only guaranteed first-condition effects establish initialization after a pre-test loop.
    if (!(instr.kind === "while.loop" && instr.postCond)) scope.initialized = condition.initialized;
    else scope.normal = scope.normal && body.normal;
  }
  private leaf(instr: IrInstr, scope: StructuredScope): void {
    if (instr.kind === "global.get" || instr.kind === "global.set") {
      if (instr.target.binding.kind !== "source") this.refuse();
      const contract = this.globals?.get(irGlobalBindingKey(instr.target.binding));
      if (!contract) this.refuse();
      if (instr.kind === "global.get") {
        if (!instr.resultType || !irTypeEquals(instr.resultType, contract.type)) this.fail("lexical-definition");
        if (!primitiveKind(instr.resultType) && !numericVector(instr.resultType)) this.refuse("reference-carrier");
        if (numericVector(instr.resultType)) this.facts.parameter(instr.result!);
      } else {
        const type = scope.values.get(instr.value);
        if (!type || !irTypeEquals(type, contract.type)) this.fail("lexical-definition");
        if (numericVector(type) && this.fn.unitId !== contract.owner) this.fail("allocation-provenance");
        if (!primitiveKind(type) && !numericVector(type)) this.refuse("reference-carrier");
        this.facts.escape(instr.value, "opaque");
      }
      return;
    }
    const extern = (type: IrType | null | undefined): boolean => type?.kind === "val" && type.val.kind === "externref";
    if (
      instr.kind === "const" &&
      instr.value.kind === "null" &&
      extern(instr.resultType) &&
      irTypeEquals(instr.value.ty, instr.resultType!)
    )
      return;
    if (instr.kind === "throw" && extern(scope.values.get(instr.value))) return;
    if (instr.kind === "slot.read" || instr.kind === "slot.write") {
      this.slot(instr, scope);
      return;
    }
    if (instr.kind === "early.return") {
      if (instr.result !== null || instr.resultType !== null) this.fail("lexical-definition");
      this.returns(instr.value === null ? [] : [instr.value], scope);
      scope.normal = false;
      return;
    }
    if (instr.kind === "call") {
      this.call(instr, scope);
      return;
    }
    if (instr.kind === "binary" || instr.kind === "unary") {
      this.numeric(instr, scope);
      return;
    }
    if (instr.kind === "const" && instr.value.kind === "bool" && primitiveKind(instr.resultType) === "i32") return;
    const exclusion = profileInstructionExclusion(instr);
    if (exclusion) this.refuse(exclusion);
    if (instr.kind === "vec.new_fixed") {
      if (instr.elements.length > 2147483647) this.refuse();
      if (instr.result === null || instr.alloc === undefined || this.facts.sites.has(instr.alloc))
        this.fail("occurrence-mismatch");
      const entry = this.registry.entries[instr.alloc];
      if (entry?.state !== "live" || entry.site.kind !== "array" || !irTypeEquals(entry.site.type, instr.resultType!))
        this.fail("allocation-provenance");
      if (instr.elements.some((value) => primitiveKind(scope.values.get(value)) !== "f64"))
        this.fail("lexical-definition");
      this.facts.allocation(instr);
      this.census.allocations++;
    } else if (instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set") {
      if (!numericVector(scope.values.get(instr.vec))) this.refuse("reference-carrier");
      this.facts.touch(instr.vec, instr.kind === "vec.set" ? "write" : "read");
      if (instr.kind !== "vec.len" && primitiveKind(scope.values.get(instr.index)) !== "i32")
        this.fail("lexical-definition");
      if (instr.kind === "vec.set") {
        if (primitiveKind(scope.values.get(instr.newValue)) !== "f64") this.fail("lexical-definition");
        this.census.vectorWrites++;
      } else this.census.vectorReads++;
    }
  }
  private slot(instr: Extract<IrInstr, { kind: "slot.read" | "slot.write" }>, scope: StructuredScope): void {
    const slot = this.fn.slots?.[instr.slotIndex];
    if (!slot || slot.index !== instr.slotIndex) this.fail("lexical-definition");
    const expected: IrType = { kind: "val", val: slot.type };
    if (!primitiveKind(expected)) this.refuse("reference-carrier");
    if (instr.kind === "slot.read") {
      if (
        !scope.initialized.has(slot.index) ||
        instr.result === null ||
        !instr.resultType ||
        !irTypeEquals(instr.resultType, expected)
      )
        this.fail("lexical-definition");
    } else {
      if (instr.result !== null || instr.resultType !== null || !irTypeEquals(scope.values.get(instr.value)!, expected))
        this.fail("lexical-definition");
      scope.initialized.add(slot.index);
    }
  }
  private call(instr: Extract<IrInstr, { kind: "call" }>, scope: StructuredScope): void {
    if (
      instr.target.binding.kind === "runtime" &&
      instr.target.binding.symbol === "__new_ReferenceError" &&
      instr.args.length === 1 &&
      scope.values.get(instr.args[0]!)?.kind === "val" &&
      (scope.values.get(instr.args[0]!) as Extract<IrType, { kind: "val" }>).val.kind === "externref" &&
      instr.result !== null &&
      instr.resultType?.kind === "val" &&
      instr.resultType.val.kind === "externref"
    )
      return;
    const target = instr.target.binding.kind === "unit" ? this.functions.get(instr.target.binding.unitId) : undefined;
    if (!target || target.params.length !== instr.args.length || target.resultTypes.length > 1) this.refuse();
    if (
      instr.args.some((value, i) => !vectorAssignable(scope.values.get(value)!, target.params[i]!.type)) ||
      (target.resultTypes.length
        ? !instr.resultType || !irTypeEquals(instr.resultType, target.resultTypes[0]!)
        : instr.result !== null || instr.resultType !== null)
    )
      this.fail("lexical-definition");
    for (const value of instr.args) this.facts.escape(value, "opaque");
    if (instr.result !== null && numericVector(instr.resultType)) this.facts.parameter(instr.result);
  }
  private numeric(instr: Extract<IrInstr, { kind: "binary" | "unary" }>, scope: StructuredScope): void {
    const result = primitiveKind(instr.resultType);
    if (instr.kind === "unary") {
      const input = unaryInputs[instr.op];
      if (!input) this.refuse("numeric-opcode");
      if (primitiveKind(scope.values.get(instr.rand)) !== input || result !== instr.op.slice(0, 3))
        this.fail("lexical-definition");
    } else {
      if (!binary.test(instr.op)) this.refuse("numeric-opcode");
      const input = instr.op.slice(0, 3),
        comparison = /\.(?:eq|ne|lt|le|gt|ge)(?:_[su])?$/.test(instr.op);
      if (
        primitiveKind(scope.values.get(instr.lhs)) !== input ||
        primitiveKind(scope.values.get(instr.rhs)) !== input ||
        result !== (comparison ? "i32" : input)
      )
        this.fail("lexical-definition");
    }
  }
}
