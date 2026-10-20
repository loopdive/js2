// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId, AllocSiteId } from "../../core/nodes.js";
import type { IrBindingId, IrUnitId } from "../../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../../shared/contracts/ir-unit-inventory.js";
import type { IrJsClassDefinition, IrJsClassFrameAccess } from "../../core/js-class-contracts.js";
import { assertPreparedIrData } from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";

/** A fresh projection of actual support descriptors and original units, never an approval report. */
export interface NativeJsClassEvidenceDomain {
  readonly definitions: readonly { readonly id: IrBindingId; readonly definition: IrJsClassDefinition }[];
  readonly unitIds: readonly IrUnitId[];
  /** Original DATA captured from the actual complete program, never an approval flag. */
  readonly programData?: {
    readonly inventory: IrUnitInventory;
    readonly abiEntries: readonly unknown[];
    readonly startup: readonly unknown[] | null;
    readonly phase: "source" | "sealed";
    readonly runtimeManifests?: readonly {
      readonly backend: string;
      readonly target: string;
      readonly manifest: unknown;
    }[];
  };
}

/** Conservative lifetime aliases. Site IDs never stand for JavaScript runtime identity. */
export interface NativeJsClassValueAliases {
  readonly unitId: IrUnitId;
  readonly value: IrValueId;
  readonly possibleSites: readonly AllocSiteId[];
  readonly mayReferenceExternalRoot: boolean;
}

export interface NativeJsClassImplicitError {
  readonly error: "ReferenceError" | "TypeError";
  readonly partition:
    | "uninitialized-binding"
    | "read-only-binding"
    | "nonconstructible-target"
    | "invalid-receiver"
    | "failed-strict-mutation"
    | "noncallable-after-arguments"
    | "invalid-instanceof-target";
}

export interface NativeJsClassEffects {
  /** A declared fresh provider aggregate on the exceptional arm, never a fake AllocSite. */
  readonly implicitErrors: readonly NativeJsClassImplicitError[];
  readonly reads: readonly IrValueId[];
  readonly writes: readonly IrValueId[];
  readonly identities: readonly IrValueId[];
  readonly captured: readonly IrValueId[];
  readonly stored: readonly IrValueId[];
  readonly opaque: readonly IrValueId[];
  readonly aliases: readonly IrValueId[];
  readonly allocationKind?: "object" | "refcell";
  readonly binding?: IrBindingId;
  readonly definition?: IrBindingId;
  readonly frameAccess?: IrJsClassFrameAccess;
}

function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class effects: ${detail}`);
}
function value(input: unknown): IrValueId {
  if (!Number.isSafeInteger(input) || (input as number) < 0) invalid("invalid SSA operand");
  return input as IrValueId;
}
function values(input: unknown): readonly IrValueId[] {
  if (!Array.isArray(input)) invalid("operand array required");
  return input.map(value);
}
function identity(input: unknown): IrBindingId {
  if (typeof input !== "string" || !input.length) invalid("binding identity required");
  return input as IrBindingId;
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("record required");
  return input as Record<string, unknown>;
}
function keyValues(input: unknown): readonly IrValueId[] {
  const key = record(input);
  if (key.kind === "computed") return [value(key.value)];
  if (key.kind !== "string" || typeof key.value !== "string") invalid("property key required");
  return [];
}
function storage(input: unknown): { binding: IrBindingId; cell: readonly IrValueId[] } {
  const storage = record(input),
    binding = identity(storage.bindingId);
  if (storage.kind === "module") return { binding, cell: [] };
  if (storage.kind !== "cell") invalid("binding storage required");
  return { binding, cell: [value(storage.cell)] };
}

/** Only operand grammar is shared. Producer and replay compute their own root graphs. */
export function nativeJsClassEffects(instruction: IrInstr): NativeJsClassEffects | undefined {
  assertPreparedIrData(instruction);
  const instr = instruction as unknown as Record<string, unknown>;
  const kind = instr.kind;
  if (typeof kind !== "string" || !kind.startsWith("js.class.")) return undefined;
  let reads: readonly IrValueId[] = [],
    writes: readonly IrValueId[] = [],
    identities: readonly IrValueId[] = [];
  let captured: readonly IrValueId[] = [],
    stored: readonly IrValueId[] = [],
    opaque: readonly IrValueId[] = [];
  let aliases: readonly IrValueId[] = [];
  let allocationKind: "object" | "refcell" | undefined, binding: IrBindingId | undefined;
  let definition: IrBindingId | undefined, frameAccess: IrJsClassFrameAccess | undefined;
  let implicitErrors: readonly NativeJsClassImplicitError[] = [];
  switch (kind) {
    case "js.class.define":
      definition = identity(instr.definition);
      reads = values(instr.captures);
      captured = reads;
      allocationKind = "object";
      break;
    case "js.class.binding.new":
      binding = identity(instr.binding);
      allocationKind = "refcell";
      break;
    case "js.class.binding.init":
    case "js.class.binding.write": {
      const place = storage(instr.storage);
      if (kind === "js.class.binding.write")
        implicitErrors = [
          { error: "ReferenceError", partition: "uninitialized-binding" },
          { error: "TypeError", partition: "read-only-binding" },
        ];
      binding = place.binding;
      writes = place.cell;
      stored = [value(instr.value)];
      reads = stored;
      break;
    }
    case "js.class.binding.read": {
      implicitErrors = [{ error: "ReferenceError", partition: "uninitialized-binding" }];
      const place = storage(instr.storage);
      binding = place.binding;
      reads = place.cell;
      aliases = place.cell;
      break;
    }
    case "js.class.construct":
      implicitErrors = [{ error: "TypeError", partition: "nonconstructible-target" }];
      reads = [value(instr.constructor), value(instr.newTarget), ...values(instr.args)];
      // A closed known constructor may improve this in a later summary profile.
      // Passing references to the actual constructor conservatively extends their lifetime.
      opaque = reads;
      aliases = reads;
      allocationKind = "object";
      break;
    case "js.class.frame.new":
      definition = identity(instr.definition);
      reads = [value(instr.environment), value(instr.thisValue), value(instr.homeObject), value(instr.newTarget)];
      captured = reads;
      allocationKind = "object";
      break;
    case "js.class.frame.get": {
      reads = [value(instr.frame)];
      aliases = reads;
      const access = record(instr.access);
      if (!["this", "environment", "home-object", "new-target", "capture"].includes(access.kind as string))
        invalid("frame access required");
      if (access.kind === "capture") {
        identity(access.definitionId);
        value(access.index);
      }
      frameAccess = instr.access as IrJsClassFrameAccess;
      break;
    }
    case "js.class.property.get":
      implicitErrors = [{ error: "TypeError", partition: "invalid-receiver" }];
      reads = [value(instr.receiver), ...keyValues(instr.key)];
      opaque = keyValues(instr.key);
      aliases = [value(instr.receiver)];
      break;
    case "js.class.property.define":
    case "js.class.property.set":
      implicitErrors = [
        { error: "TypeError", partition: "invalid-receiver" },
        { error: "TypeError", partition: "failed-strict-mutation" },
      ];
      writes = [value(instr.receiver)];
      reads = [value(instr.value), ...keyValues(instr.key)];
      opaque = keyValues(instr.key);
      stored = [value(instr.value)];
      break;
    case "js.class.invoke":
      implicitErrors = [{ error: "TypeError", partition: "noncallable-after-arguments" }];
      reads = [value(instr.callable), value(instr.receiver), ...values(instr.args)];
      opaque = reads;
      aliases = reads;
      break;
    case "js.class.constructor.complete": {
      const completion = record(instr.completion);
      reads = [value(instr.self)];
      if (completion.kind === "return") reads = [...reads, value(completion.value)];
      else if (completion.kind !== "normal") invalid("constructor completion required");
      if (instr.constructorKind !== "base") invalid("constructor kind required");
      aliases = reads;
      break;
    }
    case "js.class.identity":
      identities = [value(instr.left), value(instr.right)];
      break;
    case "js.class.instanceof":
      implicitErrors = [{ error: "TypeError", partition: "invalid-instanceof-target" }];
      reads = [value(instr.value), value(instr.constructor)];
      opaque = reads;
      break;
    default:
      invalid(`unknown instruction ${kind}`);
  }
  if (allocationKind !== undefined) {
    value(instr.alloc);
    value(instr.result);
    if (record(instr.resultType).kind !== "support-ref") invalid("allocation requires actual managed support type");
  } else if (instr.alloc !== undefined) invalid("nonallocating class instruction carries an allocation site");
  return {
    implicitErrors,
    reads,
    writes,
    identities,
    captured,
    stored,
    opaque,
    aliases,
    ...(allocationKind === undefined ? {} : { allocationKind }),
    ...(binding === undefined ? {} : { binding }),
    ...(definition === undefined ? {} : { definition }),
    ...(frameAccess === undefined ? {} : { frameAccess }),
  };
}
