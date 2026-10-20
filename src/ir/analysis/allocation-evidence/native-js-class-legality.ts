// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachInstrDeep,
  directUses,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrValueId,
} from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { irRuntimeFuncRef } from "../../core/callable-bindings.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import type { NativeJsClassEvidenceDomain } from "./native-js-class-effects.js";
import { inspectNativeJsClassNamespaces } from "./native-js-class-profile.js";
import { copyIrPreparationData } from "../alloc-registry.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

/** Neutral physical representability only. Canonical runtime JS proof is mandatory in the physical owner. */
export interface NativeJsClassLegalityContext {
  readonly original: IrModule;
  readonly selected: IrModule;
  readonly registry: AllocRegistrySnapshot;
  readonly domain: NativeJsClassEvidenceDomain;
  readonly function: IrFunction;
  readonly backend: "wasmgc" | "linear";
}
export interface NativeJsClassRepresentability {
  readonly kind: "native-js-class-representability";
}
export interface NativeJsClassLegalityUse {
  readonly proof: NativeJsClassRepresentability;
  readonly context: NativeJsClassLegalityContext;
}
interface CurrentInspection {
  readonly context: NativeJsClassLegalityContext;
  readonly instructions: ReadonlySet<IrInstr>;
  readonly types: ReadonlyMap<IrValueId, IrType>;
}
interface Owner extends CurrentInspection {
  readonly snapshot: NativeJsClassLegalityContext;
}
const dateIntrinsics = {
  apply: Reflect.apply,
  getTime: Date.prototype.getTime,
  hasInstance: Function.prototype[Symbol.hasInstance],
  incompatible: TypeError,
  ownKeys: Reflect.ownKeys,
  descriptor: Object.getOwnPropertyDescriptor,
  hasOwn: Object.hasOwn,
  Set,
  has: Set.prototype.has,
  add: Set.prototype.add,
};
const owners = new WeakMap<NativeJsClassRepresentability, Owner>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native class representability: " + detail);
}
function equal(a: unknown, b: unknown): boolean {
  return preparedIrDataMismatch(a, b) === undefined;
}
/** Preserve the copier's Date-slot refusal without copying current caller DATA. */
function assertNoDateSlots(value: unknown): void {
  const seen = new dateIntrinsics.Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object" || dateIntrinsics.apply(dateIntrinsics.has, seen, [item])) return;
    dateIntrinsics.apply(dateIntrinsics.add, seen, [item]);
    let date = false;
    try {
      dateIntrinsics.apply(dateIntrinsics.getTime, item, []);
      date = true;
    } catch (error) {
      if (!dateIntrinsics.apply(dateIntrinsics.hasInstance, dateIntrinsics.incompatible, [error])) throw error;
    }
    if (date) throw new Error("invalid preparation data: unsupported Date instance");
    for (const key of dateIntrinsics.ownKeys(item)) {
      const descriptor = dateIntrinsics.descriptor(item, key);
      if (!descriptor || !dateIntrinsics.hasOwn(descriptor, "value")) invalid("missing or accessor DATA descriptor");
      visit(descriptor.value);
    }
  };
  visit(value);
}
/** Local exception transport has no general externref type or instruction exemption. */
function closedExceptionValues(
  fn: IrFunction,
  instructions: ReadonlySet<IrInstr>,
  types: ReadonlyMap<IrValueId, IrType>,
): ReadonlySet<IrValueId> {
  const producers = new Map<IrValueId, IrInstr>();
  const uses = new Map<IrValueId, { instruction: IrInstr | undefined; index: number }[]>();
  const add = (value: IrValueId, instruction: IrInstr | undefined, index: number) => {
    const rows = uses.get(value) ?? [];
    rows.push({ instruction, index });
    uses.set(value, rows);
  };
  for (const instruction of instructions) {
    if (instruction.result !== null) producers.set(instruction.result, instruction);
    directUses(instruction).forEach((value, index) => add(value, instruction, index));
  }
  for (const block of fn.blocks) {
    const terminal = block.terminator;
    switch (terminal.kind) {
      case "return":
        terminal.values.forEach((value, index) => add(value, undefined, index));
        break;
      case "br":
        terminal.branch.args.forEach((value, index) => add(value, undefined, index));
        break;
      case "br_if":
        add(terminal.condition, undefined, 0);
        [...terminal.ifTrue.args, ...terminal.ifFalse.args].forEach((value, index) => add(value, undefined, index + 1));
        break;
      case "unreachable":
        break;
    }
  }
  const external = (type: IrType | null | undefined) => equal(type, { kind: "val", val: { kind: "externref" } });
  const canonical = irRuntimeFuncRef("__new_ReferenceError");
  const onlyThrown = (value: IrValueId) => {
    const rows = uses.get(value);
    return !!rows?.length && rows.every(({ instruction, index }) => instruction?.kind === "throw" && index === 0);
  };
  const nullMessage = (value: IrValueId) => {
    const producer = producers.get(value);
    return (
      producer?.kind === "const" &&
      producer.value.kind === "null" &&
      external(producer.resultType) &&
      external(producer.value.ty)
    );
  };
  const referenceError = (instruction: IrInstr | undefined) =>
    instruction?.kind === "call" &&
    equal(instruction.target, canonical) &&
    instruction.args.length === 1 &&
    nullMessage(instruction.args[0]!) &&
    instruction.result !== null &&
    external(instruction.resultType) &&
    onlyThrown(instruction.result);
  const admitted = new Set<IrValueId>();
  for (const instruction of instructions) {
    const value = instruction.result;
    if (value === null || !external(instruction.resultType)) continue;
    if (referenceError(instruction)) admitted.add(value);
    else if (
      instruction.kind === "coerce.to_externref" &&
      types.get(instruction.value)?.kind === "dynamic" &&
      onlyThrown(value)
    )
      admitted.add(value);
    else if (nullMessage(value)) {
      const rows = uses.get(value);
      if (rows?.length && rows.every(({ instruction, index }) => index === 0 && referenceError(instruction)))
        admitted.add(value);
    }
  }
  return admitted;
}
function inspect(context: NativeJsClassLegalityContext): CurrentInspection {
  assertPreparedIrData(context);
  if (
    !context ||
    Reflect.ownKeys(context).length !== 6 ||
    !context.selected.functions.includes(context.function) ||
    !["wasmgc", "linear"].includes(context.backend)
  )
    invalid("foreign or incomplete context");
  for (const module of [context.original, context.selected]) {
    const report = inspectNativeJsClassNamespaces(module, context.registry, context.domain);
    if (report?.kind !== "representable" || report.namespaces !== "ownership-and-escape")
      invalid("incomplete independent evidence");
  }
  const definitions = new Map(context.domain.definitions.map((row) => [row.id, row.definition]));
  const roleIds = new Set(
    context.domain.definitions.flatMap((row) =>
      Object.values(row.definition.roles).map((role) => role.binding.bindingId),
    ),
  );
  const physical = (type: IrType): boolean => {
    if (type.kind === "dynamic") return true;
    if (type.kind === "support-ref") return roleIds.has(type.ref.binding.bindingId);
    return (
      type.kind === "val" && !type.typeRef && (type.val.kind === "f64" || (type.val.kind === "i32" && !type.val.symbol))
    );
  };
  const fn = context.function,
    types = new Map<IrValueId, IrType>(),
    instructions = new Set<IrInstr>();
  if (![...fn.params.map((parameter) => parameter.type), ...fn.resultTypes].every(physical))
    invalid("unmapped signature");
  for (const parameter of fn.params) types.set(parameter.value, parameter.type);
  for (const slot of fn.slots ?? [])
    if (slot.type.kind !== "f64" && (slot.type.kind !== "i32" || slot.type.symbol)) invalid("unmapped slot");
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (instruction) => {
        instructions.add(instruction);
        if (instruction.result !== null) {
          if (!instruction.resultType) invalid("unmapped result");
          types.set(instruction.result, instruction.resultType);
        }
      });
  const exceptions = closedExceptionValues(fn, instructions, types);
  for (const instruction of instructions)
    if (instruction.result !== null && !physical(instruction.resultType!) && !exceptions.has(instruction.result))
      invalid("unmapped result");
  const type = (value: IrValueId): IrType => {
    const found = types.get(value);
    if (!found || (!physical(found) && !exceptions.has(value))) invalid("unmapped operand");
    return found;
  };
  const managed = (value: IrValueId) => {
    if (type(value).kind !== "support-ref") invalid("expected managed role");
  };
  const role = (value: IrValueId, name: keyof (typeof context.domain.definitions)[number]["definition"]["roles"]) => {
    const found = type(value);
    if (
      found.kind !== "support-ref" ||
      !context.domain.definitions.some((row) => equal(found.ref, row.definition.roles[name]))
    )
      invalid("wrong managed role");
  };
  const resultRole = (
    instruction: IrInstr,
    name: keyof (typeof context.domain.definitions)[number]["definition"]["roles"],
  ) => {
    const found = instruction.resultType;
    if (
      found?.kind !== "support-ref" ||
      !context.domain.definitions.some((row) => equal(found.ref, row.definition.roles[name]))
    )
      invalid("wrong result role");
  };

  for (const instruction of instructions) {
    for (const operand of directUses(instruction)) type(operand);
    if (instruction.kind === "box") {
      if (
        instruction.alloc === undefined ||
        instruction.toType.kind !== "dynamic" ||
        !equal(instruction.resultType, instruction.toType)
      )
        invalid("box site/result");
      const input = type(instruction.value);
      if (input.kind !== "val" || !["i32", "f64"].includes(input.val.kind)) invalid("unmapped box payload");
    }
    if (!instruction.kind.startsWith("js.class.")) continue;
    switch (instruction.kind) {
      case "js.class.define": {
        const definition = definitions.get(instruction.definition);
        if (
          !definition ||
          instruction.resultType?.kind !== "support-ref" ||
          !equal(instruction.resultType.ref, definition.roles.constructor)
        )
          invalid("definition role");
        break;
      }
      case "js.class.construct":
        role(instruction.constructor, "constructor");
        role(instruction.newTarget, "constructor");
        resultRole(instruction, "object");
        break;
      case "js.class.binding.init":
      case "js.class.binding.write":
        role(instruction.value, "constructor");
        break;
      case "js.class.property.get":
        managed(instruction.receiver);
        if (instruction.resultType?.kind !== "dynamic") invalid("property snapshot result");
        break;
      case "js.class.property.define":
      case "js.class.property.set":
        managed(instruction.receiver);
        if (type(instruction.value).kind !== "dynamic") invalid("raw property storage requires original box");
        break;
      case "js.class.frame.new":
        for (const value of [
          instruction.environment,
          instruction.thisValue,
          instruction.homeObject,
          instruction.newTarget,
        ])
          managed(value);
        break;
      case "js.class.frame.get":
        role(instruction.frame, "frame");
        break;
      case "js.class.invoke":
        if (type(instruction.callable).kind !== "dynamic") invalid("invocation requires tagged callable transport");
        managed(instruction.receiver);
        if (
          instruction.args.length !== instruction.signature.params.length ||
          instruction.args.some(
            (value, index) =>
              type(value).kind !== "dynamic" || !equal(type(value), instruction.signature.params[index]),
          )
        )
          invalid("invocation signature");
        if (
          instruction.resultType?.kind !== "dynamic" ||
          instruction.resultType.tag !== undefined ||
          instruction.signature.result?.kind !== "dynamic" ||
          instruction.signature.result.tag !== undefined ||
          !equal(instruction.resultType, instruction.signature.result)
        )
          invalid("invocation result");
        break;
      case "js.class.constructor.complete":
        role(instruction.self, "object");
        resultRole(instruction, "object");
        break;
      case "js.class.identity":
        managed(instruction.left);
        managed(instruction.right);
        break;
      case "js.class.instanceof":
        managed(instruction.value);
        role(instruction.constructor, "constructor");
        break;
      case "js.class.binding.new":
        resultRole(instruction, "binding-cell");
        break;
      case "js.class.binding.read":
        resultRole(instruction, "constructor");
        break;
      default:
        invalid("unmapped class operation");
    }
    if (
      (instruction.kind === "js.class.identity" || instruction.kind === "js.class.instanceof") &&
      (instruction.resultType?.kind !== "val" || instruction.resultType.val.kind !== "i32")
    )
      invalid("identity result");
    if (
      (instruction.kind === "js.class.property.get" ||
        instruction.kind === "js.class.property.define" ||
        instruction.kind === "js.class.property.set") &&
      instruction.key.kind === "computed"
    )
      invalid("computed property requires a declared key carrier");
  }
  // Generic scalar instruction semantics remain the canonical runtime verifier's
  // obligation; this proof never grants them a new backend exemption.
  return { context, instructions, types };
}
export function createNativeJsClassRepresentability(context: NativeJsClassLegalityContext): NativeJsClassLegalityUse {
  const current = inspect(context),
    snapshot = copyIrPreparationData(context),
    owner: Owner = { context, snapshot, instructions: current.instructions, types: current.types },
    proof = Object.freeze({ kind: "native-js-class-representability" as const });
  owners.set(proof, owner);
  return Object.freeze({ proof, context });
}
export function assertNativeJsClassLegalityCurrent(
  use: NativeJsClassLegalityUse,
  fn: IrFunction,
  backend: string,
): void {
  assertPreparedIrData(use);
  if (Reflect.ownKeys(use).length !== 2) invalid("unknown use fields");
  const owner = owners.get(use.proof);
  if (!owner || owner.context !== use.context || use.context.function !== fn || use.context.backend !== backend)
    invalid("unissued or foreign use");
  assertPreparedIrData(use.context);
  if (!equal(owner.snapshot, use.context)) invalid("changed context");
  const current = inspect(use.context);
  assertNoDateSlots(use.context);
  if (
    current.instructions.size !== owner.instructions.size ||
    [...current.instructions].some((instruction) => !owner.instructions.has(instruction))
  )
    invalid("changed instruction identities");
}
export function nativeJsClassInstructionIsAdmitted(
  use: NativeJsClassLegalityUse,
  fn: IrFunction,
  backend: string,
  instruction: IrInstr,
): boolean {
  assertNativeJsClassLegalityCurrent(use, fn, backend);
  return (
    owners.get(use.proof)!.instructions.has(instruction) &&
    (instruction.kind.startsWith("js.class.") || instruction.kind === "box")
  );
}
export function nativeJsClassTypeIsAdmitted(
  use: NativeJsClassLegalityUse,
  fn: IrFunction,
  backend: string,
  instruction: IrInstr | undefined,
  type: IrType,
): boolean {
  assertNativeJsClassLegalityCurrent(use, fn, backend);
  const owner = owners.get(use.proof)!;
  if (instruction && !owner.instructions.has(instruction)) return false;
  if (type.kind !== "support-ref" && type.kind !== "dynamic") return false;
  return [...owner.types.values(), ...fn.resultTypes].some((candidate) => candidate === type);
}
