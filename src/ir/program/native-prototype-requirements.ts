// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstrCall, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { BUILTIN_BRAND_TABLE } from "../../runtime/contracts/builtin-brands.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
  type NativeObjectAccessUse,
} from "./native-object-access-requirements.js";
import type { NativeStringValueView } from "./native-string-value-demands.js";

export interface NativePrototypeChain {
  /** Ordered actual creation occurrences, starting at the lookup target/receiver. */
  readonly creations: readonly number[];
  readonly end:
    | { readonly kind: "null" }
    | { readonly kind: "builtin"; readonly name: "Object"; readonly brand: number }
    | { readonly kind: "unresolved"; readonly value: IrValueId };
}
export interface NativePrototypeUse {
  readonly occurrence: number;
  readonly semanticOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly feature: NativeObjectAccessUse["feature"];
  readonly target: NativePrototypeChain;
  /** Get's original receiver is independent of its lookup cursor. Has has no receiver invocation. */
  readonly receiver?: { readonly value: IrValueId; readonly chain: NativePrototypeChain };
}
export interface NativePrototypeRequirements {
  readonly key: string;
  readonly access: NativeObjectAccessRequirements;
  readonly uses: readonly NativePrototypeUse[];
  readonly builtins: readonly {
    readonly name: "Object";
    readonly brand: number;
    readonly creationOccurrences: readonly number[];
  }[];
  readonly gaps: NativeObjectAccessRequirements["gaps"];
  /** Descriptive source authority only; constructors/member providers still need an issued physical owner. */
  readonly completionScope: "prototype-provenance";
}
type Data = Pick<NativePrototypeRequirements, "uses" | "builtins" | "gaps">;
const issued = new WeakMap<NativePrototypeRequirements, { access: NativeObjectAccessRequirements; data: Data }>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native prototype requirements: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) invalid(detail);
}
function callAt(access: NativeObjectAccessRequirements, occurrence: number): IrInstrCall {
  const instruction = access.demands.occurrences[occurrence]?.instruction;
  if (instruction?.kind !== "call") invalid("property occurrence lost its actual call");
  return instruction;
}

function chainReader(access: NativeObjectAccessRequirements, unitId: IrUnitId, view: NativeStringValueView) {
  const definitions = new Map<IrValueId, number>();
  for (const [occurrence, row] of access.demands.occurrences.entries()) {
    const buffer = access.demands.buffers[row.bufferIndex]!;
    if (buffer.ownerUnitId !== unitId || buffer.view !== view || row.instruction.result === null) continue;
    if (definitions.has(row.instruction.result)) invalid("ambiguous prototype SSA definition");
    definitions.set(row.instruction.result, occurrence);
  }
  return (initial: IrValueId): NativePrototypeChain => {
    const creations: number[] = [],
      seen = new Set<IrValueId>();
    let value = initial;
    for (;;) {
      if (seen.has(value)) invalid("cyclic prototype creation or representation alias");
      seen.add(value);
      const occurrence = definitions.get(value);
      const instruction = occurrence === undefined ? undefined : access.demands.occurrences[occurrence]!.instruction;
      if (instruction?.kind === "coerce.to_externref") {
        value = instruction.value;
        continue;
      }
      if (instruction?.kind === "const" && instruction.value.kind === "null")
        return { creations, end: { kind: "null" } };
      if (instruction?.kind !== "call") return { creations, end: { kind: "unresolved", value } };
      const feature = irOrdinaryObjectCallableDeclaration(instruction.target)?.feature;
      if (!feature?.startsWith("js.object.create-")) return { creations, end: { kind: "unresolved", value } };
      creations.push(occurrence!);
      if (feature === "js.object.create-null") return { creations, end: { kind: "null" } };
      if (feature === "js.object.create-default")
        return { creations, end: { kind: "builtin", name: "Object", brand: BUILTIN_BRAND_TABLE.Object! } };
      if (instruction.args[0] === undefined) invalid("explicit prototype call lost its parent operand");
      value = instruction.args[0];
    }
  };
}

function calculate(access: NativeObjectAccessRequirements): Data {
  const pairs = new Map(access.uses.map((use) => [use.occurrence, use.semanticOccurrence]));
  const uses: NativePrototypeUse[] = [],
    gaps = [...access.gaps],
    builtinCreations = new Set<number>();
  for (const owner of access.demands.owners) {
    const projected = chainReader(access, owner.unitId, "projection");
    const semantic = chainReader(access, owner.unitId, "program");
    const compare = (current: NativePrototypeChain, original: NativePrototypeChain, use: NativeObjectAccessUse) => {
      const mapped = current.creations.map((occurrence) => {
        const paired = pairs.get(occurrence);
        if (paired === undefined) invalid("prototype creation lacks its semantic occurrence");
        return paired;
      });
      same(mapped, original.creations, "prototype creation chain changed across projection");
      // An unresolved flow has no proved source identity; keep it a gap, never an empty successful chain.
      if (current.end.kind === "unresolved" || original.end.kind === "unresolved") {
        if (current.end.kind !== original.end.kind) invalid("prototype endpoint changed across projection");
        gaps.push({
          occurrence: use.occurrence,
          unitId: use.ownerUnitId,
          detail: "prototype chain requires actual external/slot/carrier provenance",
        });
      } else same(current.end, original.end, "prototype endpoint changed across projection");
      if (current.end.kind === "builtin") {
        const creation = current.creations.at(-1);
        if (creation === undefined) invalid("builtin prototype demand lacks a creation witness");
        builtinCreations.add(creation);
      }
    };
    for (const use of access.uses.filter((candidate) => candidate.ownerUnitId === owner.unitId)) {
      const current = callAt(access, use.occurrence),
        original = callAt(access, use.semanticOccurrence);
      const creation = use.feature.startsWith("js.object.create-");
      const currentValue = creation ? current.result : current.args[0];
      const originalValue = creation ? original.result : original.args[0];
      if (currentValue == null || originalValue == null) invalid("property operation lost its target");
      const target = projected(currentValue);
      compare(target, semantic(originalValue), use);
      let receiver: NativePrototypeUse["receiver"];
      if (use.feature === "js.object.get") {
        const value = current.args[2],
          prior = original.args[2];
        if (value === undefined || prior === undefined) invalid("Get lost its original receiver");
        receiver = { value, chain: projected(value) };
        compare(receiver.chain, semantic(prior), use);
      }
      uses.push({
        occurrence: use.occurrence,
        semanticOccurrence: use.semanticOccurrence,
        ownerUnitId: use.ownerUnitId,
        feature: use.feature,
        target,
        ...(receiver === undefined ? {} : { receiver }),
      });
    }
  }
  const creationOccurrences = [...builtinCreations];
  for (const occurrence of creationOccurrences) {
    const unitId = access.demands.buffers[access.demands.occurrences[occurrence]!.bufferIndex]!.ownerUnitId;
    gaps.push({
      occurrence,
      unitId,
      detail: "Object.prototype requires its canonical constructor/member descriptors and executable provider closure",
    });
  }
  return {
    uses,
    gaps,
    builtins: creationOccurrences.length
      ? [{ name: "Object", brand: BUILTIN_BRAND_TABLE.Object!, creationOccurrences }]
      : [],
  };
}

/** Derive only from an authentic, current source/selected-projection census. Never accept caller-authored chains. */
export function deriveNativePrototypeRequirements(access: NativeObjectAccessRequirements): NativePrototypeRequirements {
  assertNativeObjectAccessRequirementsCurrent(access);
  const data = freezePreparedIrValue(calculate(access)) as Data;
  const pack = Object.freeze({
    key: `${access.key}:prototypes`,
    access,
    ...data,
    completionScope: "prototype-provenance" as const,
  });
  issued.set(pack, { access, data });
  return pack;
}
export function assertNativePrototypeRequirementsCurrent(pack: NativePrototypeRequirements): void {
  const record = issued.get(pack);
  if (!record || pack.access !== record.access) invalid("unissued or detached prototype requirements");
  assertNativeObjectAccessRequirementsCurrent(record.access);
  same(
    { uses: pack.uses, builtins: pack.builtins, gaps: pack.gaps },
    record.data,
    "issued prototype requirements changed",
  );
  same(calculate(record.access), record.data, "current prototype requirements differ");
}
