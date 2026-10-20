// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachNestedBuffer,
  type IrModule,
  type IrFunction,
  type IrInstr,
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
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type {
  NativeNumberUndefinedRequirements,
  NativeNumberUndefinedOccurrence,
} from "./native-number-undefined-body.js";

export type OrdinaryNumberUndefinedFamily = "number-f64" | "undefined";
export interface OrdinaryNumberUndefinedNormal {
  readonly completes: boolean;
  readonly families: readonly OrdinaryNumberUndefinedFamily[];
  readonly roots: readonly AllocSiteId[];
}
export interface OrdinaryNumberUndefinedCensus {
  readonly requirements: NativeNumberUndefinedRequirements;
  readonly functions: readonly { readonly fn: IrFunction; readonly normal: OrdinaryNumberUndefinedNormal }[];
  readonly calls: readonly { readonly at: NativeNumberUndefinedOccurrence; readonly target: IrFunction }[];
  readonly instructions: readonly NativeNumberUndefinedOccurrence[];
}
interface Value {
  type: IrType;
  families: Set<OrdinaryNumberUndefinedFamily>;
  roots: Set<AllocSiteId>;
}
interface Completion {
  families: Set<OrdinaryNumberUndefinedFamily>;
  roots: Set<AllocSiteId>;
  completes: boolean;
}
function bad(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "ordinary Number/Undefined: " + detail);
}
function gap(detail: string): never {
  throw new IrUnsupportedError("array-representation-unsupported", "resolve", "ordinary Number/Undefined: " + detail);
}
function scalar(type: IrType | undefined | null, kind?: "i32" | "f64"): boolean {
  return (
    type?.kind === "val" &&
    !Object.hasOwn(type, "typeRef") &&
    (kind ? type.val.kind === kind : type.val.kind === "f64" || type.val.kind === "i32") &&
    !(type.val.kind === "i32" && type.val.symbol === true) &&
    !(type.val.kind === "f64" && type.val.undefSentinel === true)
  );
}
function dynamic(type: IrType | null | undefined): boolean {
  return (
    type?.kind === "dynamic" &&
    (type.tag === undefined || type.tag === JS_TAG_IDS.NumberF64 || type.tag === JS_TAG_IDS.Undefined)
  );
}
function typeData(type: IrType): void {
  if (!Object.hasOwn(type, "kind")) bad("type lacks own discriminant");
  const fields = type.kind === "val" ? ["kind", "val", "signed"] : type.kind === "dynamic" ? ["kind", "tag"] : [];
  if (!fields.length) gap("nonprimitive type");
  if (Reflect.ownKeys(type).some((key) => typeof key !== "string" || !fields.includes(key))) bad("unknown type fields");
  if (type.kind === "val") {
    if (!Object.hasOwn(type, "val") || !Object.hasOwn(type.val, "kind")) bad("raw type descriptor");
    const keys =
      type.val.kind === "f64"
        ? ["kind", "undefSentinel"]
        : type.val.kind === "i32"
          ? ["kind", "boolean", "symbol", "int32"]
          : [];
    if (!keys.length) gap("raw type family");
    if (Reflect.ownKeys(type.val).some((key) => typeof key !== "string" || !keys.includes(key)))
      bad("unknown raw type fields");
    for (const key of keys.slice(1))
      if (Object.hasOwn(type.val, key) && typeof Object.getOwnPropertyDescriptor(type.val, key)?.value !== "boolean")
        bad("raw type brand");
  }
}
function merge(to: Completion, value: Pick<Value, "families" | "roots">): void {
  to.completes = true;
  for (const family of value.families) to.families.add(family);
  for (const root of value.roots) to.roots.add(root);
}
/** Selection only requests scrutiny; neither a dynamic signature nor a native policy proves a family. */
export function hasOrdinaryNumberUndefinedPopulation(module: IrModule): boolean {
  assertPreparedIrData(module);
  let ordinary = false,
    foreign = false;
  for (const fn of module.functions) {
    const classBody = Object.hasOwn(fn, "sourceClassBody");
    ordinary ||= !classBody && fn.resultTypes.some((type) => type.kind === "dynamic");
    const buffers: (readonly IrInstr[])[] = fn.blocks.map((b) => b.instrs);
    if (fn.asyncPlan) buffers.push(...fn.asyncPlan.states.map((s) => s.body));
    const runtime = (fn as IrFunction & { asyncRuntime?: { states: readonly { body: readonly IrInstr[] }[] } })
      .asyncRuntime;
    if (runtime) buffers.push(...runtime.states.map((s) => s.body));
    const seen = new Set<readonly IrInstr[]>();
    while (buffers.length) {
      const buffer = buffers.pop()!;
      if (seen.has(buffer)) {
        if (buffer.length === 0) continue;
        bad("reused instruction buffer");
      }
      seen.add(buffer);
      for (const instruction of buffer) {
        foreign ||= instruction.kind.startsWith("js.class.") || instruction.kind.startsWith("vec.");
        ordinary ||= !classBody && instruction.kind === "call" && instruction.resultType?.kind === "dynamic";
        forEachNestedBuffer(instruction, (child) => buffers.push(child));
      }
    }
  }
  if (ordinary && foreign) gap("mixed ordinary/class/vector population is not closed");
  return ordinary;
}

class CompletionCensus {
  readonly functions = new Map<IrFunction["unitId"], IrFunction>();
  readonly summaries = new Map<IrFunction, Completion>();
  readonly active = new Set<IrFunction>();
  readonly instructions: NativeNumberUndefinedOccurrence[] = [];
  readonly operations: NativeNumberUndefinedOccurrence[] = [];
  readonly boxes: NativeNumberUndefinedRequirements["boxes"][number][] = [];
  readonly calls: OrdinaryNumberUndefinedCensus["calls"][number][] = [];
  readonly allocations = new Set<AllocSiteId>();
  constructor(
    readonly module: IrModule,
    readonly registry: AllocRegistrySnapshot,
  ) {
    createVerifiedAllocationSnapshot(registry);
    if ((module.declaredGlobals?.size ?? 0) !== 0) gap("global/TDZ transport is not closed");
    for (const fn of module.functions) {
      if (this.functions.has(fn.unitId)) bad("duplicate function unit");
      this.functions.set(fn.unitId, fn);
    }
  }
  function(fn: IrFunction): Completion {
    const old = this.summaries.get(fn);
    if (old) return old;
    if (this.active.has(fn)) gap("recursive call completion is not closed");
    this.active.add(fn);
    if (
      fn.blocks.length !== 1 ||
      fn.slots?.length ||
      fn.asyncPlan ||
      Object.hasOwn(fn, "asyncRuntime") ||
      Object.hasOwn(fn, "captures") ||
      fn.closureSubtype ||
      (fn.funcKind !== undefined && fn.funcKind !== "regular")
    )
      gap("function/state/slot shape");
    if (
      fn.params.some((p) => !scalar(p.type)) ||
      fn.resultTypes.length > 1 ||
      fn.resultTypes.some((t) => !scalar(t) && !dynamic(t))
    )
      gap("signature transport");
    if (!Number.isSafeInteger(fn.valueCount) || fn.valueCount < 0) bad("valueCount");
    for (const type of [...fn.params.map((p) => p.type), ...fn.resultTypes]) typeData(type);
    const block = fn.blocks[0]!;
    if (block.blockArgs.length || block.blockArgTypes.length) gap("CFG argument transport");
    const scope = new Map<IrValueId, Value>(),
      seen = new Set<IrValueId>();
    const define = (id: IrValueId, type: IrType) => {
      if (!Number.isSafeInteger(id) || id < 0 || id >= fn.valueCount || seen.has(id)) bad("parameter identity");
      seen.add(id);
      scope.set(id, { type, families: new Set(), roots: new Set() });
    };
    for (const param of fn.params) define(param.value, param.type);
    const normal: Completion = { completes: false, families: new Set(), roots: new Set() };
    const live = this.buffer(fn, block.instrs, scope, seen, normal, true, []);
    const term = block.terminator;
    if (term.kind === "return") {
      if (term.values.length !== fn.resultTypes.length) bad("return arity");
      for (let i = 0; i < term.values.length; i++) {
        const value = scope.get(term.values[i]!);
        if (!value) bad("return definition");
        this.compatible(value!, fn.resultTypes[i]!);
        if (live) merge(normal, value!);
      }
      if (live && !term.values.length) normal.completes = true;
    } else if (term.kind !== "unreachable") gap("CFG edges are not closed");
    this.active.delete(fn);
    this.summaries.set(fn, normal);
    return normal;
  }
  compatible(value: Value, expected: IrType): void {
    if (expected.kind === "dynamic") {
      if (!dynamic(value.type) || !value.families.size) gap("unknown dynamic value");
      if (
        expected.tag !== undefined &&
        [...value.families].some(
          (f) => (f === "number-f64" ? JS_TAG_IDS.NumberF64 : JS_TAG_IDS.Undefined) !== expected.tag,
        )
      )
        bad("refined result contradicts actual family");
    } else if (!irTypeEquals(value.type, expected)) bad("actual operand/result carrier");
  }
  buffer(
    fn: IrFunction,
    buffer: readonly IrInstr[],
    scope: Map<IrValueId, Value>,
    seen: Set<IrValueId>,
    normal: Completion,
    reachable: boolean,
    parent: NativeNumberUndefinedOccurrence["arms"],
    root?: number,
  ): boolean {
    if (parent.length > 128) gap("nested control resource limit");
    let live = reachable;
    for (let index = 0; index < buffer.length; index++) {
      const instr = buffer[index]!;
      const at: NativeNumberUndefinedOccurrence = {
        unitId: fn.unitId,
        blockId: fn.blocks[0]!.id,
        root: root ?? index,
        arms: parent.length ? [...parent.slice(0, -1), { ...parent[parent.length - 1]!, index }] : [],
        instr,
      };
      this.instructions.push(at);
      if (this.instructions.length > 20000) gap("instruction resource limit");
      const get = (id: IrValueId): Value => scope.get(id) ?? bad("nonlexical SSA operand");
      const put = (value: Omit<Value, "type"> = { families: new Set(), roots: new Set() }) => {
        if (
          instr.result === null ||
          !instr.resultType ||
          !Number.isSafeInteger(instr.result) ||
          instr.result < 0 ||
          instr.result >= fn.valueCount ||
          seen.has(instr.result)
        )
          bad("result identity/type");
        typeData(instr.resultType);
        seen.add(instr.result);
        scope.set(instr.result, { type: instr.resultType, ...value });
      };
      if (instr.kind !== "box" && instr.alloc !== undefined) gap("foreign allocation");
      switch (instr.kind) {
        case "const": {
          if (instr.value.kind === "undefined") {
            if (instr.resultType?.kind !== "dynamic" || instr.resultType.tag !== JS_TAG_IDS.Undefined)
              bad("Undefined tag/carrier");
            put({ families: new Set(["undefined"]), roots: new Set() });
            this.operations.push(at);
          } else {
            if (
              !scalar(instr.resultType) ||
              instr.value.kind !== (instr.resultType?.kind === "val" ? instr.resultType.val.kind : "")
            )
              gap("constant carrier");
            put();
          }
          break;
        }
        case "box": {
          if (
            !scalar(get(instr.value).type, "f64") ||
            instr.toType.kind !== "dynamic" ||
            instr.toType.tag !== JS_TAG_IDS.NumberF64 ||
            !instr.resultType ||
            !irTypeEquals(instr.toType, instr.resultType)
          )
            gap("genuine NumberF64 box required");
          if (instr.alloc === undefined || this.allocations.has(instr.alloc)) bad("missing/duplicate box site");
          const row = this.registry.entries[instr.alloc];
          if (
            row?.state !== "live" ||
            row.site.id !== instr.alloc ||
            row.site.kind !== "box" ||
            !irTypeEquals(row.site.type, instr.resultType) ||
            preparedIrDataMismatch(row.site.origin, instr.site) !== undefined
          )
            bad("box site/type/origin");
          this.allocations.add(instr.alloc);
          this.boxes.push({ unitId: fn.unitId, instr, allocationId: instr.alloc });
          put({ families: new Set(["number-f64"]), roots: new Set([instr.alloc]) });
          this.operations.push(at);
          break;
        }
        case "unary":
          this.numericUnary(instr, get);
          put();
          break;
        case "binary":
          this.numericBinary(instr, get);
          put();
          break;
        case "dyn.eq":
          if (
            instr.loose !== false ||
            typeof instr.negate !== "boolean" ||
            !get(instr.lhs).families.size ||
            !get(instr.rhs).families.size ||
            !scalar(instr.resultType, "i32")
          )
            gap("strict closed dynamic equality");
          put();
          this.operations.push(at);
          break;
        case "tag.test":
          if (
            !get(instr.value).families.size ||
            (instr.tagId !== JS_TAG_IDS.NumberF64 && instr.tagId !== JS_TAG_IDS.Undefined) ||
            !scalar(instr.resultType, "i32")
          )
            gap("closed exact tag probe");
          put();
          this.operations.push(at);
          break;
        case "dyn.to_number":
          if (!get(instr.value).families.size || !scalar(instr.resultType, "f64")) gap("closed numeric conversion");
          put();
          this.operations.push(at);
          break;
        case "call": {
          if (instr.target.binding.kind !== "unit") gap("non-unit callable transport");
          const target = this.functions.get(instr.target.binding.unitId);
          if (!target) bad("missing actual callee");
          if (instr.args.length !== target.params.length) gap("ordinary direct call arity");
          instr.args.forEach((value, i) => this.compatible(get(value), target.params[i]!.type));
          const declared = this.module.declaredSignatures?.get(irBindingKey(instr.target.binding)!);
          if (
            declared &&
            (declared.params.length !== target.params.length ||
              declared.params.some((t, i) => !irTypeEquals(t, target.params[i]!.type)) ||
              preparedIrDataMismatch(declared.result, target.resultTypes[0] ?? null) !== undefined)
          )
            bad("call declaration/body mismatch");
          const result = this.function(target);
          this.calls.push({ at, target });
          if (target.resultTypes.length) {
            if (!instr.resultType || !irTypeEquals(instr.resultType, target.resultTypes[0]!))
              bad("call result/body mismatch");
            put({ families: new Set(result.families), roots: new Set(result.roots) });
          } else if (instr.result !== null || instr.resultType !== null) bad("void call result");
          if (live && !result.completes) live = false;
          break;
        }
        case "if": {
          if (!scalar(get(instr.cond).type, "i32")) bad("if condition");
          const left = new Map(scope),
            right = new Map(scope);
          this.buffer(fn, instr.then, left, seen, normal, live, [...at.arms, { arm: "then", index: 0 }], at.root);
          this.buffer(fn, instr.else, right, seen, normal, live, [...at.arms, { arm: "else", index: 0 }], at.root);
          const a = left.get(instr.thenValue),
            b = right.get(instr.elseValue);
          if (!a || !b || !instr.resultType) bad("if arm/result");
          this.compatible(a!, instr.resultType!);
          this.compatible(b!, instr.resultType!);
          put({ families: new Set([...a!.families, ...b!.families]), roots: new Set([...a!.roots, ...b!.roots]) });
          break;
        }
        case "if.stmt": {
          if (!scalar(get(instr.cond).type, "i32") || instr.result !== null || instr.resultType !== null)
            bad("statement if shape");
          const a = this.buffer(
            fn,
            instr.then,
            new Map(scope),
            seen,
            normal,
            live,
            [...at.arms, { arm: "then", index: 0 }],
            at.root,
          );
          const b = this.buffer(
            fn,
            instr.else,
            new Map(scope),
            seen,
            normal,
            live,
            [...at.arms, { arm: "else", index: 0 }],
            at.root,
          );
          live = a || b;
          break;
        }
        case "early.return": {
          if (
            instr.result !== null ||
            instr.resultType !== null ||
            fn.resultTypes.length !== (instr.value === null ? 0 : 1)
          )
            bad("early return shape");
          if (instr.value !== null) {
            const value = get(instr.value);
            this.compatible(value, fn.resultTypes[0]!);
            if (live) merge(normal, value);
          } else if (live) normal.completes = true;
          live = false;
          break;
        }
        default:
          gap("instruction " + instr.kind);
      }
    }
    return live;
  }
  numericUnary(instr: Extract<IrInstr, { kind: "unary" }>, get: (v: IrValueId) => Value): void {
    const types: Record<string, readonly ["i32" | "f64", "i32" | "f64"]> = {
      "f64.neg": ["f64", "f64"],
      "f64.abs": ["f64", "f64"],
      "f64.sqrt": ["f64", "f64"],
      "f64.floor": ["f64", "f64"],
      "f64.ceil": ["f64", "f64"],
      "f64.trunc": ["f64", "f64"],
      "i32.eqz": ["i32", "i32"],
      "i32.trunc_sat_f64_s": ["f64", "i32"],
      "f64.convert_i32_s": ["i32", "f64"],
      "f64.convert_i32_u": ["i32", "f64"],
    };
    if (!Object.hasOwn(types, instr.op)) gap("unary opcode");
    const [a, b] = types[instr.op]!;
    if (!scalar(get(instr.rand).type, a) || !scalar(instr.resultType, b)) bad("unary carrier");
  }
  numericBinary(instr: Extract<IrInstr, { kind: "binary" }>, get: (v: IrValueId) => Value): void {
    const arithmetic = new Set(["f64.add", "f64.sub", "f64.mul", "f64.div", "f64.min", "f64.max"]),
      comparison = new Set(["f64.eq", "f64.ne", "f64.lt", "f64.le", "f64.gt", "f64.ge"]),
      integer = new Set(["i32.eq", "i32.ne", "i32.and", "i32.or", "i32.lt_u"]);
    const input =
      arithmetic.has(instr.op) || comparison.has(instr.op) ? "f64" : integer.has(instr.op) ? "i32" : undefined;
    if (!input) gap("binary opcode");
    const result = arithmetic.has(instr.op) ? "f64" : "i32";
    if (!scalar(get(instr.lhs).type, input) || !scalar(get(instr.rhs).type, input) || !scalar(instr.resultType, result))
      bad("binary carrier");
  }
}

/** Producer-side equations only. Runtime/canonical-program authority is a separate conjunction. */
export function inspectOrdinaryNumberUndefinedBodies(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): OrdinaryNumberUndefinedCensus | undefined {
  if (!hasOrdinaryNumberUndefinedPopulation(module)) return undefined;
  assertPreparedIrData(registry);
  const model = new CompletionCensus(module, registry);
  for (const fn of module.functions) model.function(fn);
  for (const row of registry.entries)
    if (row.state === "live" && !model.allocations.has(row.site.id)) gap("allocation outside complete ordinary census");
  const unitOrder = new Map(module.functions.map((fn, index) => [fn.unitId, index]));
  const compare = (a: NativeNumberUndefinedOccurrence, b: NativeNumberUndefinedOccurrence): number => {
    const first = unitOrder.get(a.unitId)! - unitOrder.get(b.unitId)! || a.root - b.root;
    if (first) return first;
    for (let i = 0; i < Math.min(a.arms.length, b.arms.length); i++) {
      const left = a.arms[i]!,
        right = b.arms[i]!;
      const arm = (left.arm === "then" ? 0 : 1) - (right.arm === "then" ? 0 : 1);
      if (arm || left.index !== right.index) return arm || left.index - right.index;
    }
    return a.arms.length - b.arms.length;
  };
  model.instructions.sort(compare);
  model.operations.sort(compare);
  model.calls.sort((a, b) => compare(a.at, b.at));
  const location = new Map(model.instructions.map((at, index) => [at.instr, index]));
  model.boxes.sort((a, b) => location.get(a.instr)! - location.get(b.instr)!);
  return {
    requirements: { units: module.functions.map((fn) => fn.unitId), occurrences: model.operations, boxes: model.boxes },
    functions: module.functions.map((fn) => {
      const value = model.summaries.get(fn)!;
      return {
        fn,
        normal: {
          completes: value.completes,
          families: [...value.families].sort(),
          roots: [...value.roots].sort((a, b) => a - b),
        },
      };
    }),
    calls: model.calls,
    instructions: model.instructions,
  };
}
