// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Computational encoding of fresh, closed producer snapshots; never DATA admission.
import { nativeJsClassValueDataKey as key } from "./data.js";
import type {
  NativeJsValueDomain as Domain,
  NativeJsValueRoot as Root,
  NativeJsClassValueDomainResult as Result,
  NativeJsClassValueDomainObligation as Obligation,
} from "./contracts.js";
import type { IrBindingId, IrUnitId } from "../../../../shared/contracts/ir-identity.js";

type Global = Result["globals"][number];
type Cell = Result["heap"][number];
type Value = Result["values"][number];
type Globals = readonly (readonly [IrBindingId, Global])[];
type Heap = readonly (readonly [string, Cell])[];
type World = readonly [Globals, Heap];
type WorldEntry = readonly [IrUnitId, Globals, Heap];
type Roots = readonly (readonly [string, Root])[];
type Summary = readonly [
  IrUnitId,
  readonly Domain[],
  readonly Domain[],
  boolean,
  boolean,
  readonly IrBindingId[],
  readonly IrBindingId[],
  Roots,
  Roots,
];
export interface ProducerSignatureSnapshot {
  readonly summaries: readonly Summary[];
  readonly reachable: readonly IrUnitId[];
  readonly entries: readonly WorldEntry[];
  readonly normalWorlds: readonly WorldEntry[];
  readonly publicTerminalWorlds: readonly WorldEntry[];
  readonly publicReachable: readonly IrUnitId[];
  readonly observedWorld: World;
  readonly obligations: readonly (readonly [string, Obligation])[];
  readonly values: readonly (readonly [string, Value])[];
  readonly calls: readonly (readonly [string, Result["calls"][number]])[];
}

function record<T>(fragments: Record<keyof T, string>): string {
  return `{${Object.values(fragments).join(",")}}`;
}
function array<T>(values: readonly T[] | null | undefined, encode: (value: T) => string): string {
  if (values == null) return key(values);
  return `[${values.map((value) => encode(value)).join(",")}]`;
}
function tuple<T extends readonly unknown[]>(
  values: T | null | undefined,
  encoders: { readonly [K in keyof T]: (value: T[K]) => string },
): string {
  if (values == null) return key(values);
  return `[${values
    .map((value, index) => {
      const encode = encoders[index]! as (value: T[number]) => string;
      return encode(value);
    })
    .join(",")}]`;
}
function domain(value: Domain | null | undefined): string {
  if (value == null) return key(value);
  switch (value.kind) {
    case "bottom":
    case "unknown":
      return record<typeof value>({ kind: `${JSON.stringify("kind")}:${key(value.kind)}` });
    case "known":
      return record<typeof value>({
        families: `${JSON.stringify("families")}:${array(value.families, key)}`,
        kind: `${JSON.stringify("kind")}:${key(value.kind)}`,
        roots: `${JSON.stringify("roots")}:${array(value.roots, key)}`,
      });
    default: {
      const exhaustive: never = value;
      throw new TypeError("unsupported producer snapshot domain: " + typeof exhaustive);
    }
  }
}
function global(value: Global | null | undefined): string {
  if (value == null) return key(value);
  return record<Global>({
    bindingId: `${JSON.stringify("bindingId")}:${key(value.bindingId)}`,
    domain: `${JSON.stringify("domain")}:${domain(value.domain)}`,
    initialization: `${JSON.stringify("initialization")}:${key(value.initialization)}`,
  });
}
function cell(value: Cell | null | undefined): string {
  if (value == null) return key(value);
  return record<Cell>({
    key: `${JSON.stringify("key")}:${key(value.key)}`,
    presence: `${JSON.stringify("presence")}:${key(value.presence)}`,
    prototypeRoots: `${JSON.stringify("prototypeRoots")}:${array(value.prototypeRoots, key)}`,
    root: `${JSON.stringify("root")}:${key(value.root)}`,
    valueDomain: `${JSON.stringify("valueDomain")}:${domain(value.valueDomain)}`,
  });
}
function valueRow(value: Value | null | undefined): string {
  if (value == null) return key(value);
  return record<Value>({
    domain: `${JSON.stringify("domain")}:${domain(value.domain)}`,
    unitId: `${JSON.stringify("unitId")}:${key(value.unitId)}`,
    value: `${JSON.stringify("value")}:${key(value.value)}`,
  });
}
function obligation(value: Obligation | null | undefined): string {
  if (value == null) return key(value);
  return record<Obligation>({
    location: `${JSON.stringify("location")}:${key(value.location)}`,
    reason: `${JSON.stringify("reason")}:${key(value.reason)}`,
    unitId: `${JSON.stringify("unitId")}:${key(value.unitId)}`,
  });
}
function globals(values: Globals | null | undefined): string {
  return array(values, (entry) => tuple(entry, [key, global]));
}
function heap(values: Heap | null | undefined): string {
  return array(values, (entry) => tuple(entry, [key, cell]));
}
function world(value: World | null | undefined): string {
  return tuple(value, [globals, heap]);
}
function worldEntry(value: WorldEntry | null | undefined): string {
  return tuple(value, [key, globals, heap]);
}
function roots(values: Roots | null | undefined): string {
  return array(values, (entry) => tuple(entry, [key, key]));
}
function summary(value: Summary | null | undefined): string {
  return tuple(value, [
    key,
    (values) => array(values, domain),
    (values) => array(values, domain),
    key,
    key,
    (values) => array(values, key),
    (values) => array(values, key),
    roots,
    roots,
  ]);
}

/** Exact generic-key bytes for a freshly materialized, closed producer snapshot. */
export function signatureKey(snapshot: ProducerSignatureSnapshot): string {
  return record<ProducerSignatureSnapshot>({
    calls: `${JSON.stringify("calls")}:${key(snapshot.calls)}`,
    entries: `${JSON.stringify("entries")}:${array(snapshot.entries, worldEntry)}`,
    normalWorlds: `${JSON.stringify("normalWorlds")}:${array(snapshot.normalWorlds, worldEntry)}`,
    obligations: `${JSON.stringify("obligations")}:${array(snapshot.obligations, (entry) => tuple(entry, [key, obligation]))}`,
    observedWorld: `${JSON.stringify("observedWorld")}:${world(snapshot.observedWorld)}`,
    publicReachable: `${JSON.stringify("publicReachable")}:${array(snapshot.publicReachable, key)}`,
    publicTerminalWorlds: `${JSON.stringify("publicTerminalWorlds")}:${array(snapshot.publicTerminalWorlds, worldEntry)}`,
    reachable: `${JSON.stringify("reachable")}:${array(snapshot.reachable, key)}`,
    summaries: `${JSON.stringify("summaries")}:${array(snapshot.summaries, summary)}`,
    values: `${JSON.stringify("values")}:${array(snapshot.values, (entry) => tuple(entry, [key, valueRow]))}`,
  });
}
