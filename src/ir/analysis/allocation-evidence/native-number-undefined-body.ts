// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  directUses,
  forEachNestedBuffer,
  type IrInstr,
  type IrModule,
  type IrFunction,
  type IrValueId,
  type AllocSiteId,
} from "../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../core/types.js";
import { preparedIrDataMismatch, assertPreparedIrData } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { createVerifiedAllocationSnapshot } from "../allocations/snapshot.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type { IrUnitId } from "../../../shared/contracts/ir-identity.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

export interface NativeNumberUndefinedOccurrence {
  readonly unitId: IrUnitId;
  readonly blockId: number;
  readonly root: number;
  readonly arms: readonly { readonly arm: string; readonly index: number }[];
  readonly instr: IrInstr;
}
export interface NativeNumberUndefinedRequirements {
  readonly units: readonly IrUnitId[];
  readonly occurrences: readonly NativeNumberUndefinedOccurrence[];
  readonly boxes: readonly {
    readonly unitId: IrUnitId;
    readonly instr: Extract<IrInstr, { kind: "box" }>;
    readonly allocationId: AllocSiteId;
  }[];
}

import type { TagId } from "../../core/tag-domain.js";

type Partition = "number" | "undefined";
interface Value {
  readonly type: IrType;
  readonly partitions?: ReadonlySet<Partition>;
  readonly roots?: ReadonlySet<AllocSiteId>;
}
const scalar = (type: IrType | null | undefined, kind?: "i32" | "f64") =>
  type?.kind === "val" &&
  !Object.hasOwn(type, "typeRef") &&
  (kind ? type.val.kind === kind : type.val.kind === "i32" || type.val.kind === "f64");
const vector = (type: IrType | null | undefined) =>
  type?.kind === "vec" && type.nullable === false && scalar(type.elementType, "f64");

function unsupported(message: string): never {
  throw new IrUnsupportedError("array-representation-unsupported", "build", `native Number/Undefined: ${message}`);
}
function invalid(message: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native Number/Undefined: ${message}`);
}

export function hasNativeNumberUndefinedPopulation(module: IrModule): boolean {
  assertPreparedIrData(module);
  for (const fn of module.functions) {
    if (
      (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
      fn.asyncPlan !== undefined ||
      Object.hasOwn(fn, "asyncRuntime")
    )
      continue;
    if (
      !fn.blocks.some((block) =>
        block.instrs.some((instr) => instr.kind === "vec.new_fixed" && vector(instr.resultType)),
      )
    )
      continue;
    let numericRead = false,
      number = false;
    const pending = fn.blocks.map((block) => block.instrs),
      seen = new Set<readonly IrInstr[]>();
    while (pending.length) {
      const buffer = pending.pop()!;
      if (seen.has(buffer)) continue;
      seen.add(buffer);
      for (const instr of buffer) {
        if (instr.kind === "const" && instr.value.kind === "undefined" && instr.resultType?.kind === "dynamic")
          return true;
        numericRead ||= instr.kind === "vec.get" && scalar(instr.resultType, "f64");
        number ||= instr.kind === "box" && instr.resultType?.kind === "dynamic" && instr.resultType.tag !== undefined;
        if (numericRead && number) return true;
        forEachNestedBuffer(instr, (child) => pending.push(child));
      }
    }
  }
  return false;
}
function guardedRead(
  instr: Extract<IrInstr, { kind: "vec.get" }>,
  condition: IrValueId,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): boolean {
  const guard = definitions.get(condition);
  const terms = guard?.kind === "binary" && guard.op === "i32.and" ? [guard.lhs, guard.rhs] : [condition];
  const range = terms.some((value) => {
    const term = definitions.get(value);
    if (term?.kind !== "binary" || term.op !== "i32.lt_u" || term.lhs !== instr.index) return false;
    const length = definitions.get(term.rhs);
    return length?.kind === "vec.len" && length.integer === true && length.vec === instr.vec;
  });
  if (!range) return false;
  const index = definitions.get(instr.index);
  const indexType = index?.resultType;
  if (indexType?.kind === "val" && indexType.val.kind === "i32" && indexType.val.boolean === true) return false;
  if (index?.kind !== "unary" || index.op !== "i32.trunc_sat_f64_s") return true;
  return terms.some((value) => {
    const term = definitions.get(value);
    if (term?.kind !== "binary" || term.op !== "f64.eq") return false;
    const converted = definitions.get(term.rhs);
    return (
      term.lhs === index.rand &&
      converted?.kind === "unary" &&
      converted.op === "f64.convert_i32_s" &&
      converted.rand === instr.index
    );
  });
}

function allocation(
  instr: IrInstr,
  kind: "box" | "array",
  registry: AllocRegistrySnapshot,
  allocated: Set<AllocSiteId>,
  effects: Map<AllocSiteId, boolean> | undefined,
) {
  if (instr.alloc === undefined || allocated.has(instr.alloc)) invalid("missing or reused allocation site");
  const row = registry.entries[instr.alloc!];
  if (
    !row ||
    row.state !== "live" ||
    row.site.id !== instr.alloc ||
    row.site.kind !== kind ||
    !instr.resultType ||
    !irTypeEquals(row.site.type, instr.resultType)
  )
    invalid("allocation provenance");
  if (row.state === "live" && preparedIrDataMismatch(row.site.origin, instr.site) !== undefined)
    invalid("allocation origin");
  allocated.add(instr.alloc!);
  effects?.set(instr.alloc!, false);
}

function define(
  scope: Map<IrValueId, Value>,
  instr: IrInstr,
  seen: Set<IrValueId>,
  definitions: Map<IrValueId, IrInstr>,
  partitions?: ReadonlySet<Partition>,
  roots?: ReadonlySet<AllocSiteId>,
) {
  if (instr.result === null || !instr.resultType || seen.has(instr.result)) invalid("duplicate or absent definition");
  seen.add(instr.result!);
  definitions.set(instr.result!, instr);
  scope.set(instr.result!, {
    type: instr.resultType!,
    ...(partitions ? { partitions } : {}),
    ...(roots ? { roots } : {}),
  });
}

/** Neutral closed-partition grammar; this pair carries no ECMAScript semantic authority. */
export function nativeNumberUndefinedTags(module: IrModule): { numeric: TagId; singleton: TagId } {
  let numeric: TagId | undefined, singleton: TagId | undefined;
  const seen = new Set<readonly IrInstr[]>();
  const pending = module.functions.flatMap((fn) => fn.blocks.map((block) => block.instrs));
  while (pending.length) {
    const buffer = pending.pop()!;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    for (const instr of buffer) {
      if (instr.kind === "box" && instr.toType.kind === "dynamic" && instr.toType.tag !== undefined) {
        if (numeric !== undefined && numeric !== instr.toType.tag) unsupported("inconsistent numeric partition");
        numeric = instr.toType.tag;
      }
      if (instr.kind === "const" && instr.value.kind === "undefined" && instr.resultType?.kind === "dynamic") {
        if (singleton !== undefined && singleton !== instr.resultType.tag)
          unsupported("inconsistent singleton partition");
        singleton = instr.resultType.tag;
      }
      forEachNestedBuffer(instr, (nested) => pending.push(nested));
    }
  }
  const valid = (tag: TagId | undefined): tag is TagId =>
    typeof tag === "number" && Number.isInteger(tag) && tag >= 0 && tag <= 0x7fffffff;
  if (!valid(numeric) || !valid(singleton) || numeric === singleton) unsupported("distinct opaque partitions");
  return { numeric, singleton };
}

export function assertNativeNumberUndefinedModulePrelude(module: IrModule, registry: AllocRegistrySnapshot): void {
  assertPreparedIrData(module);
  assertPreparedIrData(registry);
  try {
    createVerifiedAllocationSnapshot(registry);
  } catch (error) {
    invalid(String(error));
  }
  if ((module.declaredSignatures?.size ?? 0) || (module.declaredGlobals?.size ?? 0))
    unsupported("declaration population");
}

export function assertNativeNumberUndefinedFunctionShape(fn: IrFunction): void {
  if (
    fn.blocks.length !== 1 ||
    fn.slots?.length ||
    (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
    ["captures", "closureSubtype", "asyncPlan", "asyncRuntime"].some((key) => Object.hasOwn(fn, key))
  )
    unsupported("function shape");
  if (fn.params.some((p) => !scalar(p.type)) || fn.resultTypes.some((t) => !scalar(t)))
    unsupported("unclosed dynamic signature");
  for (const type of fn.resultTypes) checkClosedType(type);
  if (!Number.isSafeInteger(fn.valueCount) || fn.valueCount < 0) invalid("value count");
  assertPreparedIrData(fn);
}
function checkValueId(value: IrValueId | null, count: number): void {
  if (value === null || !Number.isSafeInteger(value) || value < 0 || value >= count) invalid("value identity");
}
function checkClosedType(type: IrType): void {
  const keys = (value: object, allowed: readonly string[]) => {
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)))
      invalid("symbolic or physical type domain");
  };
  if (type.kind === "val") {
    keys(type, ["kind", "val", "signed"]);
    if (type.signed !== undefined && typeof type.signed !== "boolean") invalid("signed type domain");
    if (type.val.kind === "f64") keys(type.val, ["kind"]);
    else if (type.val.kind === "i32") {
      keys(type.val, ["kind", "boolean", "int32"]);
      if (
        (type.val.boolean !== undefined && type.val.boolean !== true) ||
        (type.val.int32 !== undefined && type.val.int32 !== true)
      )
        invalid("i32 refinement domain");
    } else unsupported("scalar type domain");
  } else if (type.kind === "vec") {
    keys(type, ["kind", "elementType", "nullable"]);
    if (type.nullable !== false) unsupported("nullable vector");
    checkClosedType(type.elementType);
  } else if (type.kind === "dynamic") keys(type, ["kind", "tag"]);
  else unsupported("type domain");
}
function checkClosedInstruction(instr: IrInstr, typeOf: (value: IrValueId) => IrType): void {
  const want = (value: IrValueId, kind: "i32" | "f64") => {
    if (!scalar(typeOf(value), kind)) invalid("operand carrier");
  };
  const result = (kind: "i32" | "f64") => {
    if (!scalar(instr.resultType, kind)) invalid("result carrier");
  };
  if (instr.resultType) checkClosedType(instr.resultType);
  if (instr.kind === "box") checkClosedType(instr.toType);
  if (instr.kind === "binary") {
    const rules: Record<string, readonly ["i32" | "f64", "i32" | "f64"]> = {
      "i32.lt_u": ["i32", "i32"],
      "i32.and": ["i32", "i32"],
      "i32.eq": ["i32", "i32"],
      "i32.ne": ["i32", "i32"],
      "f64.eq": ["f64", "i32"],
      "f64.ne": ["f64", "i32"],
      "f64.gt": ["f64", "i32"],
      "f64.add": ["f64", "f64"],
      "f64.mul": ["f64", "f64"],
    };
    const rule = rules[instr.op];
    if (!rule) unsupported("numeric opcode");
    want(instr.lhs, rule[0]);
    want(instr.rhs, rule[0]);
    result(rule[1]);
  } else if (instr.kind === "unary") {
    const rules: Record<string, readonly ["i32" | "f64", "i32" | "f64"]> = {
      "i32.trunc_sat_f64_s": ["f64", "i32"],
      "f64.convert_i32_s": ["i32", "f64"],
      "i32.eqz": ["i32", "i32"],
      "f64.neg": ["f64", "f64"],
      "f64.abs": ["f64", "f64"],
    };
    const rule = rules[instr.op];
    if (!rule) unsupported("numeric opcode");
    want(instr.rand, rule[0]);
    result(rule[1]);
  } else if (instr.kind === "const" && instr.value.kind !== "undefined") {
    const literal = instr.value;
    if (literal.kind === "bool") {
      if (typeof literal.value !== "boolean") invalid("boolean literal");
      result("i32");
    } else if (literal.kind === "f64") {
      if (typeof literal.value !== "number") invalid("numeric literal");
      result("f64");
    } else if (literal.kind === "i32") {
      if (!Number.isInteger(literal.value) || literal.value < -0x80000000 || literal.value > 0x7fffffff)
        invalid("i32 literal");
      result("i32");
    } else unsupported("constant partition");
  } else if (instr.kind === "vec.new_fixed") {
    if (
      !scalar(instr.elementType, "f64") ||
      !vector(instr.resultType) ||
      !irTypeEquals(instr.elementType, (instr.resultType as Extract<IrType, { kind: "vec" }>).elementType)
    )
      invalid("constructor element type");
    const capacity = instr.capacity ?? instr.elements.length;
    if (!Number.isSafeInteger(capacity) || capacity < instr.elements.length) invalid("constructor capacity");
    for (const value of instr.elements) want(value, "f64");
  } else if (instr.kind === "vec.get") {
    want(instr.index, "i32");
    result("f64");
  } else if (instr.kind === "vec.len") {
    if (instr.integer !== undefined && typeof instr.integer !== "boolean") invalid("length mode");
    result(instr.integer === true ? "i32" : "f64");
  }
}

/** Complete lexical/partition census; no source fact or producer annotation is an admission token. */
export function inspectNativeNumberUndefinedBodies(
  module: IrModule,
  registry: AllocRegistrySnapshot,
  effects?: Map<AllocSiteId, boolean>,
): NativeNumberUndefinedRequirements | undefined {
  const occurrences: NativeNumberUndefinedOccurrence[] = [],
    boxes: NativeNumberUndefinedRequirements["boxes"][number][] = [];
  const units: NativeNumberUndefinedRequirements["units"][number][] = [];
  let instructionCount = 0;
  const allocated = new Set<AllocSiteId>(),
    allUnits = new Set<string>();
  if (!hasNativeNumberUndefinedPopulation(module)) return undefined;
  assertNativeNumberUndefinedModulePrelude(module, registry);
  const tags = nativeNumberUndefinedTags(module);
  for (const fn of module.functions) {
    if (allUnits.has(fn.unitId)) invalid("duplicate unit");
    allUnits.add(fn.unitId);
    assertNativeNumberUndefinedFunctionShape(fn);
    const block = fn.blocks[0]!;
    if (block.id !== 0) invalid("entry block identity");
    if (block.blockArgs.length || block.blockArgTypes.length || block.terminator.kind !== "return")
      unsupported("block shape");
    const definitions = new Map<IrValueId, IrInstr>();
    const seen = new Set<IrValueId>(),
      active = new Set<readonly IrInstr[]>();
    const initial = new Map<IrValueId, Value>();
    for (const param of fn.params) {
      checkValueId(param.value, fn.valueCount);
      if (seen.has(param.value)) invalid("duplicate parameter");
      seen.add(param.value);
      checkClosedType(param.type);
      initial.set(param.value, { type: param.type });
    }
    const get = (scope: Map<IrValueId, Value>, value: IrValueId): Value =>
      scope.get(value) ?? invalid("missing lexical value");
    const read = (scope: Map<IrValueId, Value>, value: IrValueId) => {
      for (const id of get(scope, value).roots ?? []) effects?.set(id, true);
    };
    const visit = (
      buffer: readonly IrInstr[],
      scope: Map<IrValueId, Value>,
      root: number,
      arms: NativeNumberUndefinedOccurrence["arms"],
      depth: number,
      conditions: readonly IrValueId[] = [],
    ): void => {
      if (depth > 128 || active.has(buffer)) invalid("cyclic nested population");
      active.add(buffer);
      for (const [index, instr] of buffer.entries()) {
        if (++instructionCount > 20000) unsupported("resource limit");
        const position = arms.length ? [...arms.slice(0, -1), { ...arms[arms.length - 1]!, index }] : [];
        const at = {
          unitId: fn.unitId,
          blockId: block.id,
          root: arms.length ? root : index,
          arms: position,
          instr,
        };
        checkValueId(instr.result, fn.valueCount);
        checkClosedInstruction(instr, (value) => get(scope, value).type);
        for (const operand of directUses(instr)) checkValueId(operand, fn.valueCount);
        if (instr.kind !== "if") for (const operand of directUses(instr)) get(scope, operand);
        switch (instr.kind) {
          case "const":
            if (
              instr.value.kind === "undefined" &&
              instr.resultType?.kind === "dynamic" &&
              instr.resultType.tag === tags.singleton
            ) {
              define(scope, instr, seen, definitions, new Set(["undefined"]));
              occurrences.push(at);
            } else {
              if (
                !scalar(instr.resultType) ||
                (instr.value.kind !== "f64" && instr.value.kind !== "i32" && instr.value.kind !== "bool")
              )
                unsupported("constant partition");
              define(scope, instr, seen, definitions);
            }
            break;
          case "box":
            if (!instr.resultType || !irTypeEquals(instr.toType, instr.resultType)) invalid("box result type");
            if (
              !scalar(get(scope, instr.value).type, "f64") ||
              instr.toType.kind !== "dynamic" ||
              instr.toType.tag !== tags.numeric ||
              !instr.resultType ||
              !irTypeEquals(instr.toType, instr.resultType)
            )
              unsupported("box partition");
            allocation(instr, "box", registry, allocated, effects);
            define(scope, instr, seen, definitions, new Set(["number"]), new Set([instr.alloc!]));
            occurrences.push(at);
            boxes.push({
              unitId: fn.unitId,
              instr,
              allocationId: instr.alloc!,
            });
            break;
          case "tag.test":
            if (
              !get(scope, instr.value).partitions ||
              !scalar(instr.resultType, "i32") ||
              instr.tag !== undefined ||
              (instr.tagId !== tags.numeric && instr.tagId !== tags.singleton)
            )
              unsupported("tag partition");
            read(scope, instr.value);
            define(scope, instr, seen, definitions);
            occurrences.push(at);
            break;
          case "dyn.eq":
            if (typeof instr.loose !== "boolean" || typeof instr.negate !== "boolean") invalid("equality mode domain");
            if (
              instr.loose ||
              !get(scope, instr.lhs).partitions ||
              !get(scope, instr.rhs).partitions ||
              !scalar(instr.resultType, "i32")
            )
              unsupported("dynamic equality");
            read(scope, instr.lhs);
            read(scope, instr.rhs);
            define(scope, instr, seen, definitions);
            occurrences.push(at);
            break;
          case "dyn.to_number":
            if (!get(scope, instr.value).partitions || !scalar(instr.resultType, "f64"))
              unsupported("numeric coercion");
            read(scope, instr.value);
            define(scope, instr, seen, definitions);
            occurrences.push(at);
            break;
          case "if": {
            if (!scalar(get(scope, instr.cond).type, "i32")) invalid("if condition");
            const left = new Map(scope),
              right = new Map(scope);
            visit(instr.then, left, at.root, [...position, { arm: "then", index: 0 }], depth + 1, [
              ...conditions,
              instr.cond,
            ]);
            visit(instr.else, right, at.root, [...position, { arm: "else", index: 0 }], depth + 1, conditions);
            const a = get(left, instr.thenValue),
              b = get(right, instr.elseValue);
            if (instr.resultType?.kind === "dynamic") {
              if (instr.resultType.tag !== undefined) invalid("refined dynamic join");
              if (!a.partitions || !b.partitions) invalid("unclosed dynamic join");
              define(
                scope,
                instr,
                seen,
                definitions,
                new Set([...a.partitions!, ...b.partitions!]),
                new Set([...(a.roots ?? []), ...(b.roots ?? [])]),
              );
            } else {
              if (
                !scalar(instr.resultType) ||
                !irTypeEquals(a.type, instr.resultType!) ||
                !irTypeEquals(b.type, instr.resultType!)
              )
                unsupported("if result");
              define(scope, instr, seen, definitions);
            }
            break;
          }
          case "vec.new_fixed":
            if (!vector(instr.resultType)) unsupported("constructor population");
            allocation(instr, "array", registry, allocated, effects);
            define(scope, instr, seen, definitions, undefined, new Set([instr.alloc!]));
            break;
          case "vec.get":
          case "vec.len":
            if (instr.kind === "vec.get") {
              const indexType = get(scope, instr.index).type;
              if (indexType.kind === "val" && indexType.val.kind === "i32" && indexType.val.boolean === true)
                invalid("boolean property index");
            }
            if (instr.kind === "vec.get" && !conditions.some((condition) => guardedRead(instr, condition, definitions)))
              invalid("indexed read lacks current index/length guard");
            if (!vector(get(scope, instr.vec).type) || !scalar(instr.resultType)) unsupported("vector read");
            read(scope, instr.vec);
            define(scope, instr, seen, definitions);
            break;
          case "binary":
          case "unary":
            if (
              instr.kind === "binary" &&
              !["i32.lt_u", "i32.and", "i32.eq", "i32.ne", "f64.eq", "f64.ne", "f64.add", "f64.mul", "f64.gt"].includes(
                instr.op,
              )
            )
              unsupported("numeric opcode");
            if (
              instr.kind === "unary" &&
              !["i32.trunc_sat_f64_s", "f64.convert_i32_s", "i32.eqz", "f64.neg", "f64.abs"].includes(instr.op)
            )
              unsupported("numeric opcode");
            if (!scalar(instr.resultType) || directUses(instr).some((v) => !scalar(get(scope, v).type)))
              unsupported("numeric operation");
            define(scope, instr, seen, definitions);
            break;
          default:
            unsupported(`instruction ${instr.kind}`);
        }
      }
      active.delete(buffer);
    };
    visit(block.instrs, initial, 0, [], 0);
    const returns = (block.terminator as Extract<typeof block.terminator, { kind: "return" }>).values;
    if (returns.length !== fn.resultTypes.length) invalid("return arity");
    for (const [index, value] of returns.entries()) {
      checkValueId(value, fn.valueCount);
      if (!scalar(get(initial, value).type)) unsupported("escaping carrier");
      if (!irTypeEquals(get(initial, value).type, fn.resultTypes[index]!)) invalid("return type");
    }
    units.push(fn.unitId);
  }
  return { units, occurrences, boxes };
}
