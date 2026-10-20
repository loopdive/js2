// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachNestedBuffer,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrValueId,
  type AllocSiteId,
} from "../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../core/types.js";
import { irBindingKey } from "../../core/declared-types.js";
import { JS_TAG_IDS } from "../../core/js-value-tag-identities.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";
import { createVerifiedAllocationSnapshot } from "../allocations/snapshot.js";
import { ALLOC_NAMESPACES, type AllocRegistrySnapshot } from "../contracts/allocations.js";
import { indexRegistryEvidence, checkRegistryEvidenceMetadataDomain } from "./metadata.js";
import type { AllocationEvidenceCheck, AllocationEvidenceCensus } from "./contracts.js";

// This replay does not import either the body interpreter or an annotation producer.
type Family = "number-f64" | "undefined";
type Partition = Set<Family>;
interface IndexedUnit {
  fn: IrFunction;
  definitions: Map<IrValueId, IrInstr>;
  types: Map<IrValueId, IrType>;
  aliases: Map<IrValueId, readonly IrValueId[]>;
  returns: Set<IrValueId>;
}
interface Result {
  normal: boolean;
  values: Partition;
}
function invalid(message: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "ordinary independent replay: " + message);
}
function unknown(message: string): never {
  throw new IrUnsupportedError(
    "array-representation-unsupported",
    "resolve",
    "ordinary independent replay: " + message,
  );
}
function raw(type: IrType | null | undefined, value?: "f64" | "i32"): boolean {
  if (type?.kind !== "val" || Object.hasOwn(type, "typeRef")) return false;
  return (
    (value ? type.val.kind === value : type.val.kind === "f64" || type.val.kind === "i32") &&
    !(type.val.kind === "i32" && type.val.symbol === true) &&
    !(type.val.kind === "f64" && type.val.undefSentinel === true)
  );
}
function tagged(type: IrType | null | undefined): boolean {
  return (
    type?.kind === "dynamic" &&
    (type.tag === undefined || type.tag === JS_TAG_IDS.NumberF64 || type.tag === JS_TAG_IDS.Undefined)
  );
}
function typeDomain(type: IrType): void {
  if (!Object.hasOwn(type, "kind")) invalid("type discriminant");
  const allowed = type.kind === "dynamic" ? ["kind", "tag"] : type.kind === "val" ? ["kind", "val", "signed"] : [];
  if (!allowed.length || Reflect.ownKeys(type).some((k) => typeof k !== "string" || !allowed.includes(k)))
    unknown("type fields");
  if (type.kind === "val") {
    if (
      !raw(type) ||
      Reflect.ownKeys(type.val).some(
        (k) =>
          typeof k !== "string" ||
          !(type.val.kind === "f64" ? ["kind", "undefSentinel"] : ["kind", "boolean", "int32", "symbol"]).includes(k),
      )
    )
      unknown("raw carrier");
    for (const key of ["boolean", "int32", "symbol", "undefSentinel"])
      if (Object.hasOwn(type.val, key) && typeof Object.getOwnPropertyDescriptor(type.val, key)?.value !== "boolean")
        invalid("carrier brand DATA");
  } else if (!tagged(type)) unknown("tag family");
}
function scrutiny(module: IrModule): boolean {
  assertPreparedIrData(module);
  let claimed = false,
    mixed = false;
  for (const fn of module.functions) {
    const classOwned = Object.hasOwn(fn, "sourceClassBody");
    if (!classOwned && fn.resultTypes.some((t) => t.kind === "dynamic")) claimed = true;
    const queue: (readonly IrInstr[])[] = fn.blocks.map((b) => b.instrs);
    if (fn.asyncPlan) queue.push(...fn.asyncPlan.states.map((s) => s.body));
    const attachment = (fn as IrFunction & { asyncRuntime?: { states: readonly { body: readonly IrInstr[] }[] } })
      .asyncRuntime;
    if (attachment) queue.push(...attachment.states.map((s) => s.body));
    const unique = new Set<readonly IrInstr[]>();
    while (queue.length) {
      const buffer = queue.shift()!;
      if (unique.has(buffer)) {
        if (buffer.length === 0) continue;
        invalid("shared instruction buffer");
      }
      unique.add(buffer);
      for (const instr of buffer) {
        if (instr.kind.startsWith("js.class.") || instr.kind.startsWith("vec.")) mixed = true;
        if (!classOwned && instr.kind === "call" && instr.resultType?.kind === "dynamic") claimed = true;
        forEachNestedBuffer(instr, (b) => queue.push(b));
      }
    }
  }
  if (claimed && mixed) unknown("mixed ordinary population");
  return claimed;
}
class Replay {
  readonly units = new Map<IrFunction["unitId"], IndexedUnit>();
  readonly allocations = new Map<AllocSiteId, { unit: IndexedUnit; instruction: Extract<IrInstr, { kind: "box" }> }>();
  readonly summaries = new Map<IndexedUnit, Result>();
  readonly solving = new Set<IndexedUnit>();
  readonly partitions = new Map<IrInstr, Partition>();
  readonly partitioning = new Set<IrInstr>();
  census: AllocationEvidenceCensus;
  constructor(
    readonly module: IrModule,
    readonly registry: AllocRegistrySnapshot,
  ) {
    createVerifiedAllocationSnapshot(registry);
    this.census = {
      functions: module.functions.length,
      buffers: 0,
      instructions: 0,
      allocations: 0,
      vectorReads: 0,
      vectorWrites: 0,
      registrySlots: registry.size,
    };
    if (module.declaredGlobals?.size) unknown("global population");
    for (const fn of module.functions) {
      if (this.units.has(fn.unitId)) invalid("duplicate unit");
      const unit: IndexedUnit = {
        fn,
        definitions: new Map(),
        types: new Map(),
        aliases: new Map(),
        returns: new Set(),
      };
      this.units.set(fn.unitId, unit);
      if (
        fn.blocks.length !== 1 ||
        fn.slots?.length ||
        fn.asyncPlan ||
        Object.hasOwn(fn, "asyncRuntime") ||
        fn.closureSubtype ||
        Object.hasOwn(fn, "captures") ||
        (fn.funcKind !== undefined && fn.funcKind !== "regular")
      )
        unknown("function shape");
      if (fn.resultTypes.length > 1 || fn.params.some((p) => !raw(p.type))) unknown("signature");
      if (!Number.isSafeInteger(fn.valueCount) || fn.valueCount < 0) invalid("valueCount");
      for (const type of [...fn.params.map((p) => p.type), ...fn.resultTypes]) typeDomain(type);
      const seen = new Set<IrValueId>();
      for (const param of fn.params) {
        this.declare(unit, seen, param.value, param.type);
      }
      const block = fn.blocks[0]!;
      if (block.blockArgs.length || block.blockArgTypes.length) unknown("block argument");
      const visible = new Set(unit.types.keys());
      this.index(unit, block.instrs, visible, seen);
      const term = block.terminator;
      if (term.kind === "return") {
        if (term.values.length !== fn.resultTypes.length) invalid("return arity");
        for (let i = 0; i < term.values.length; i++) {
          this.require(visible, term.values[i]!);
          this.assignable(unit, term.values[i]!, fn.resultTypes[i]!);
          unit.returns.add(term.values[i]!);
        }
      } else if (term.kind !== "unreachable") unknown("CFG control");
    }
    for (const row of registry.entries)
      if (row.state === "live" && !this.allocations.has(row.site.id)) unknown("uncensused live allocation");
    this.census = { ...this.census, allocations: this.allocations.size };
  }
  declare(unit: IndexedUnit, seen: Set<IrValueId>, id: IrValueId, type: IrType): void {
    if (!Number.isSafeInteger(id) || id < 0 || id >= unit.fn.valueCount || seen.has(id))
      invalid("duplicate/outside SSA");
    typeDomain(type);
    seen.add(id);
    unit.types.set(id, type);
  }
  require(scope: Set<IrValueId>, id: IrValueId): void {
    if (!scope.has(id)) invalid("nonlexical operand");
  }
  assignable(unit: IndexedUnit, id: IrValueId, type: IrType): void {
    const actual = unit.types.get(id);
    if (!actual) invalid("undefined type");
    if (type.kind === "dynamic") {
      if (!tagged(actual)) invalid("dynamic assignment carrier");
    } else if (!irTypeEquals(actual!, type)) invalid("assignment carrier");
  }
  index(unit: IndexedUnit, buffer: readonly IrInstr[], scope: Set<IrValueId>, seen: Set<IrValueId>): void {
    this.census = { ...this.census, buffers: this.census.buffers + 1 };
    for (const instr of buffer) {
      this.census = { ...this.census, instructions: this.census.instructions + 1 };
      const need = (v: IrValueId) => this.require(scope, v);
      if (instr.alloc !== undefined && instr.kind !== "box") unknown("nonbox allocation");
      switch (instr.kind) {
        case "const":
          if (instr.value.kind === "undefined") {
            if (instr.resultType?.kind !== "dynamic" || instr.resultType.tag !== JS_TAG_IDS.Undefined)
              invalid("Undefined carrier/tag");
          } else if (
            !raw(instr.resultType) ||
            instr.value.kind !== (instr.resultType?.kind === "val" ? instr.resultType.val.kind : null)
          )
            unknown("constant carrier");
          break;
        case "box": {
          need(instr.value);
          if (
            !raw(unit.types.get(instr.value), "f64") ||
            instr.toType.kind !== "dynamic" ||
            instr.toType.tag !== JS_TAG_IDS.NumberF64 ||
            !instr.resultType ||
            !irTypeEquals(instr.toType, instr.resultType)
          )
            unknown("box carrier/tag");
          if (instr.alloc === undefined || this.allocations.has(instr.alloc)) invalid("box site identity");
          const row = this.registry.entries[instr.alloc];
          if (
            row?.state !== "live" ||
            row.site.id !== instr.alloc ||
            row.site.kind !== "box" ||
            !irTypeEquals(row.site.type, instr.resultType) ||
            preparedIrDataMismatch(row.site.origin, instr.site) !== undefined
          )
            invalid("box provenance/type/origin");
          this.allocations.set(instr.alloc, { unit, instruction: instr });
          break;
        }
        case "unary":
          need(instr.rand);
          this.numeric(unit, instr);
          break;
        case "binary":
          need(instr.lhs);
          need(instr.rhs);
          this.numeric(unit, instr);
          break;
        case "call":
          instr.args.forEach(need);
          break;
        case "tag.test":
          need(instr.value);
          if (
            !raw(instr.resultType, "i32") ||
            (instr.tagId !== JS_TAG_IDS.NumberF64 && instr.tagId !== JS_TAG_IDS.Undefined)
          )
            unknown("tag probe");
          break;
        case "dyn.to_number":
          need(instr.value);
          if (!raw(instr.resultType, "f64")) invalid("number conversion result");
          break;
        case "dyn.eq":
          need(instr.lhs);
          need(instr.rhs);
          if (instr.loose !== false || typeof instr.negate !== "boolean" || !raw(instr.resultType, "i32"))
            unknown("strict equality");
          break;
        case "if": {
          need(instr.cond);
          if (!raw(unit.types.get(instr.cond), "i32")) invalid("if condition");
          const a = new Set(scope),
            b = new Set(scope);
          this.index(unit, instr.then, a, seen);
          this.index(unit, instr.else, b, seen);
          this.require(a, instr.thenValue);
          this.require(b, instr.elseValue);
          if (!instr.resultType) invalid("if result");
          this.assignable(unit, instr.thenValue, instr.resultType!);
          this.assignable(unit, instr.elseValue, instr.resultType!);
          unit.aliases.set(instr.result!, [instr.thenValue, instr.elseValue]);
          break;
        }
        case "if.stmt":
          need(instr.cond);
          if (!raw(unit.types.get(instr.cond), "i32")) invalid("if condition");
          this.index(unit, instr.then, new Set(scope), seen);
          this.index(unit, instr.else, new Set(scope), seen);
          break;
        case "early.return":
          if (unit.fn.resultTypes.length !== (instr.value === null ? 0 : 1)) invalid("early return arity");
          if (instr.value !== null) {
            need(instr.value);
            this.assignable(unit, instr.value, unit.fn.resultTypes[0]!);
            unit.returns.add(instr.value);
          }
          break;
        default:
          unknown("instruction " + instr.kind);
      }
      const voidOperation = instr.kind === "early.return" || instr.kind === "if.stmt";
      if (voidOperation) {
        if (instr.result !== null || instr.resultType !== null) invalid("void result");
      } else if (instr.kind !== "call" || instr.result !== null || instr.resultType !== null) {
        if (instr.result === null || !instr.resultType) invalid("missing result");
        this.declare(unit, seen, instr.result!, instr.resultType!);
        unit.definitions.set(instr.result!, instr);
        scope.add(instr.result!);
      }
    }
  }
  numeric(unit: IndexedUnit, instr: Extract<IrInstr, { kind: "unary" | "binary" }>): void {
    const binary = instr.kind === "binary",
      op = instr.op;
    const floatArithmetic = ["f64.add", "f64.sub", "f64.mul", "f64.div", "f64.min", "f64.max"],
      floatCompare = ["f64.eq", "f64.ne", "f64.lt", "f64.le", "f64.gt", "f64.ge"],
      integer = ["i32.eq", "i32.ne", "i32.and", "i32.or", "i32.lt_u"];
    const unaryFloat = ["f64.neg", "f64.abs", "f64.sqrt", "f64.floor", "f64.ceil", "f64.trunc"];
    let input: "f64" | "i32", output: "f64" | "i32";
    if (binary) {
      if (floatArithmetic.includes(op)) {
        input = "f64";
        output = "f64";
      } else if (floatCompare.includes(op)) {
        input = "f64";
        output = "i32";
      } else if (integer.includes(op)) {
        input = "i32";
        output = "i32";
      } else unknown("binary opcode");
      if (!raw(unit.types.get(instr.lhs), input) || !raw(unit.types.get(instr.rhs), input))
        invalid("binary actual carrier");
    } else {
      if (unaryFloat.includes(op)) {
        input = "f64";
        output = "f64";
      } else if (op === "i32.eqz") {
        input = "i32";
        output = "i32";
      } else if (op === "i32.trunc_sat_f64_s") {
        input = "f64";
        output = "i32";
      } else if (op === "f64.convert_i32_s") {
        input = "i32";
        output = "f64";
      } else unknown("unary opcode");
      if (!raw(unit.types.get(instr.rand), input)) invalid("unary actual carrier");
    }
    if (!raw(instr.resultType, output)) invalid("numeric result carrier");
  }
  target(unit: IndexedUnit, instr: Extract<IrInstr, { kind: "call" }>): IndexedUnit {
    if (instr.target.binding.kind !== "unit") unknown("indirect/imported call");
    const target = this.units.get(instr.target.binding.unitId);
    if (!target) invalid("actual target missing");
    if (instr.args.length !== target!.fn.params.length) unknown("direct arity");
    instr.args.forEach((value, i) => this.assignable(unit, value, target!.fn.params[i]!.type));
    const declared = this.module.declaredSignatures?.get(irBindingKey(instr.target.binding)!);
    if (
      declared &&
      (declared.params.length !== target!.fn.params.length ||
        declared.params.some((v, i) => !irTypeEquals(v, target!.fn.params[i]!.type)) ||
        preparedIrDataMismatch(declared.result, target!.fn.resultTypes[0] ?? null) !== undefined)
    )
      invalid("declaration/body contradiction");
    if (target!.fn.resultTypes.length === 0) {
      if (instr.result !== null || instr.resultType !== null) invalid("void call carrier");
    } else if (!instr.resultType || !irTypeEquals(instr.resultType, target!.fn.resultTypes[0]!))
      invalid("call result/body contradiction");
    return target!;
  }
  value(unit: IndexedUnit, id: IrValueId): Partition {
    const definition = unit.definitions.get(id);
    if (!definition) {
      if (!unit.types.has(id)) invalid("unknown value");
      return new Set();
    }
    const old = this.partitions.get(definition);
    if (old) return old;
    if (this.partitioning.has(definition)) unknown("cyclic value equation");
    this.partitioning.add(definition);
    const out: Partition = new Set();
    if (definition.kind === "box") out.add("number-f64");
    else if (definition.kind === "const" && definition.value.kind === "undefined") out.add("undefined");
    else if (definition.kind === "call") for (const v of this.summary(this.target(unit, definition)).values) out.add(v);
    else for (const alias of unit.aliases.get(id) ?? []) for (const family of this.value(unit, alias)) out.add(family);
    const type = unit.types.get(id)!;
    if (
      type.kind === "dynamic" &&
      type.tag !== undefined &&
      [...out].some((f) => (f === "number-f64" ? JS_TAG_IDS.NumberF64 : JS_TAG_IDS.Undefined) !== type.tag)
    )
      invalid("family contradicts result refinement");
    this.partitioning.delete(definition);
    this.partitions.set(definition, out);
    return out;
  }
  summary(unit: IndexedUnit): Result {
    const old = this.summaries.get(unit);
    if (old) return old;
    if (this.solving.has(unit)) unknown("recursive completion");
    this.solving.add(unit);
    const result: Result = { normal: false, values: new Set() };
    const add = (id: IrValueId | null) => {
      result.normal = true;
      if (id !== null) for (const family of this.value(unit, id)) result.values.add(family);
    };
    const flow = (buffer: readonly IrInstr[], reachable: boolean): boolean => {
      let live = reachable;
      for (const instr of buffer) {
        if (instr.kind === "call") {
          const called = this.summary(this.target(unit, instr));
          if (live && !called.normal) live = false;
        } else if (instr.kind === "if.stmt") {
          const a = flow(instr.then, live),
            b = flow(instr.else, live);
          live = a || b;
        } else if (instr.kind === "if") {
          const a = flow(instr.then, live),
            b = flow(instr.else, live);
          live = a || b;
        } else if (instr.kind === "early.return") {
          if (live) add(instr.value);
          live = false;
        }
      }
      return live;
    };
    const block = unit.fn.blocks[0]!,
      live = flow(block.instrs, true);
    if (live && block.terminator.kind === "return") add(block.terminator.values[0] ?? null);
    this.solving.delete(unit);
    this.summaries.set(unit, result);
    return result;
  }
  checkPartitions(): void {
    for (const unit of this.units.values()) {
      this.summary(unit);
      for (const [id, instr] of unit.definitions) {
        if (instr.resultType?.kind === "dynamic") {
          const family = this.value(unit, id);
          if (!family.size) unknown("unproved dynamic value");
        }
        if (instr.kind === "dyn.eq" && (!this.value(unit, instr.lhs).size || !this.value(unit, instr.rhs).size))
          unknown("equality operands");
        if ((instr.kind === "tag.test" || instr.kind === "dyn.to_number") && !this.value(unit, instr.value).size)
          unknown("dynamic operand");
      }
    }
  }
  roots(unit: IndexedUnit, id: IrValueId, active = new Set<IrValueId>()): Set<AllocSiteId> {
    if (active.has(id)) unknown("alias cycle");
    active.add(id);
    const out = new Set<AllocSiteId>(),
      instr = unit.definitions.get(id);
    if (instr?.kind === "box") out.add(instr.alloc!);
    for (const child of unit.aliases.get(id) ?? [])
      for (const root of this.roots(unit, child, new Set(active))) out.add(root);
    return out;
  }
  namespaces(): Exclude<AllocationEvidenceCheck, { kind: "verified" }> | undefined {
    const allowed = new Set<string>([ALLOC_NAMESPACES.ownership, ALLOC_NAMESPACES.escape, ALLOC_NAMESPACES.encoding]);
    for (const row of this.registry.metadata)
      for (const [namespace] of row.entries)
        if (!allowed.has(namespace))
          return { kind: "invalid", code: "namespace-presence", at: { kind: "site", site: row.id } };
    const index = indexRegistryEvidence(this.registry),
      domain = checkRegistryEvidenceMetadataDomain(index);
    if (domain) return domain;
    for (let number = 0; number < this.registry.size; number++) {
      const id = number as AllocSiteId,
        allocation = this.allocations.get(id),
        metadata = index.rows.get(id),
        at = { kind: "site" as const, site: id };
      if (!allocation) {
        if (metadata?.size) return { kind: "invalid", code: "unused-site-evidence", at };
        continue;
      }
      const { unit, instruction } = allocation;
      let escaped = false,
        direct = false;
      for (const value of unit.returns) {
        if (value === instruction.result) direct = true;
        if (this.roots(unit, value).has(id)) escaped = true;
      }
      const ownership: { state: string; ops: string[]; stackCandidate?: true } = {
        state: escaped ? "escaped" : "owned",
        ops: escaped ? ["escape"] : [],
      };
      const actual = metadata?.get(ALLOC_NAMESPACES.ownership);
      if (actual && Object.hasOwn(actual as object, "stackCandidate")) {
        if (escaped || Object.getOwnPropertyDescriptor(actual, "stackCandidate")?.value !== true)
          return { kind: "invalid", code: "noncanonical-ownership-marker", at };
        ownership.stackCandidate = true;
      }
      const escapeFact = {
        classification: escaped ? (direct ? "returned" : "opaque") : "local",
        stackAllocatable: !escaped,
      };
      if (metadata?.has(ALLOC_NAMESPACES.encoding)) return { kind: "invalid", code: "namespace-presence", at };
      for (const [enabled, key, expected] of [
        [index.ownership, ALLOC_NAMESPACES.ownership, ownership],
        [index.escape, ALLOC_NAMESPACES.escape, escapeFact],
      ] as const)
        if (enabled && preparedIrDataMismatch(metadata?.get(key), expected) !== undefined)
          return { kind: "invalid", code: metadata?.has(key) ? "namespace-value" : "namespace-presence", at };
    }
    return undefined;
  }
}
/** Independent def/use graph, completion equations and generic-fact replay; no report grants authority. */
export function inspectOrdinaryNumberUndefinedNamespaces(
  module: IrModule,
  registry: AllocRegistrySnapshot,
):
  | Exclude<AllocationEvidenceCheck, { kind: "verified" }>
  | {
      kind: "representable";
      namespaces: ReturnType<typeof indexRegistryEvidence>["mode"];
      census: AllocationEvidenceCensus;
    }
  | undefined {
  try {
    if (!scrutiny(module)) return undefined;
    assertPreparedIrData(registry);
    const replay = new Replay(module, registry);
    replay.checkPartitions();
    const failure = replay.namespaces();
    if (failure) return failure;
    return { kind: "representable", namespaces: indexRegistryEvidence(registry).mode, census: replay.census };
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return { kind: "not-covered", reason: "reference-carrier", at: { kind: "module" } };
    if (error instanceof PreparedIrProgramInvariantError)
      return { kind: "invalid", code: "lexical-definition", at: { kind: "module" } };
    throw error;
  }
}
