// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrInstr, IrValueId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { irTypeEquals } from "../../core/types.js";
import { ALLOC_NAMESPACES, type AllocRegistrySnapshot } from "../contracts/allocations.js";
import { AccessSet } from "../lattice.js";
import { primitiveKind } from "./effect-rules.js";
import { indexRegistryEvidence } from "./metadata.js";
import type { AllocationEvidenceFailure } from "./contracts.js";

export function numericVector(type: IrType | null | undefined): boolean {
  return type?.kind === "vec" && type.layout === undefined && primitiveKind(type.elementType) === "f64";
}
export function vectorAssignable(actual: IrType, expected: IrType): boolean {
  return (
    irTypeEquals(actual, expected) ||
    (numericVector(actual) &&
      numericVector(expected) &&
      actual.kind === "vec" &&
      expected.kind === "vec" &&
      !actual.nullable &&
      expected.nullable &&
      irTypeEquals(actual.elementType, expected.elementType))
  );
}
interface Effect {
  access: AccessSet;
  shared: boolean;
}
interface Site {
  value: IrValueId;
  effect: Effect;
  escape: "local" | "returned" | "opaque";
}

/** Independent body-derived may-alias/effect replay; no producer result is consumed. */
export class StructuredVectorFacts {
  readonly sites = new Map<AllocSiteId, Site>();
  private readonly effects = new Map<IrValueId, Effect>();
  private readonly inputs = new Map<IrValueId, readonly IrValueId[]>();
  private readonly edges: [IrValueId, IrValueId][] = [];
  private readonly escapes: [IrValueId, "returned" | "opaque"][] = [];
  parameter(value: IrValueId): void {
    this.effects.set(value, { access: AccessSet.of("read"), shared: true });
  }
  allocation(instr: Extract<IrInstr, { kind: "vec.new_fixed" }>): void {
    const effect = { access: AccessSet.empty(), shared: false };
    this.effects.set(instr.result!, effect);
    this.sites.set(instr.alloc!, { value: instr.result!, effect, escape: "local" });
  }
  alias(result: IrValueId, left: IrValueId, right: IrValueId): void {
    this.inputs.set(result, [left, right]);
    this.edges.push([result, left], [result, right]);
  }
  touch(value: IrValueId, op: "read" | "write" | "escape"): void {
    const effect = this.effects.get(value) ?? { access: AccessSet.empty(), shared: false };
    effect.access = effect.access.with(op);
    this.effects.set(value, effect);
  }
  escape(value: IrValueId, kind: "returned" | "opaque"): void {
    this.touch(value, "escape");
    this.escapes.push([value, kind]);
  }
  finish(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [left, right] of this.edges) {
        const a = this.effects.get(left) ?? { access: AccessSet.empty(), shared: false };
        const b = this.effects.get(right) ?? { access: AccessSet.empty(), shared: false };
        const joined = { access: a.access.union(b.access), shared: a.shared || b.shared };
        if (
          !a.access.equals(joined.access) ||
          a.shared !== joined.shared ||
          !b.access.equals(joined.access) ||
          b.shared !== joined.shared
        )
          changed = true;
        this.effects.set(left, joined);
        this.effects.set(right, joined);
      }
    }
    const byValue = new Map([...this.sites.values()].map((site) => [site.value, site]));
    for (const [value, kind] of this.escapes) {
      const pending = [value],
        seen = new Set<IrValueId>();
      while (pending.length) {
        const next = pending.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        const site = byValue.get(next);
        if (site && (kind === "opaque" || site.escape === "local")) site.escape = kind;
        pending.push(...(this.inputs.get(next) ?? []));
      }
    }
    for (const site of this.sites.values()) {
      site.effect = this.effects.get(site.value)!;
      if (site.escape === "local" && (site.effect.shared || site.effect.access.has("escape"))) site.escape = "opaque";
    }
  }
}
function sameRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => {
      const a = (actual as Record<string, unknown>)[key],
        b = expected[key];
      return Array.isArray(b) ? Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
    })
  );
}
export function compareStructuredVectorFacts(
  registry: AllocRegistrySnapshot,
  sites: ReadonlyMap<AllocSiteId, Site>,
): AllocationEvidenceFailure | undefined {
  const index = indexRegistryEvidence(registry);
  for (let id = 0; id < registry.size; id++) {
    const site = sites.get(id as AllocSiteId),
      row = index.rows.get(id as AllocSiteId);
    const at = { kind: "site" as const, site: id as AllocSiteId };
    if (!site) {
      if (
        row?.has(ALLOC_NAMESPACES.ownership) ||
        row?.has(ALLOC_NAMESPACES.escape) ||
        row?.has(ALLOC_NAMESPACES.encoding)
      )
        return { kind: "invalid", code: "unused-site-evidence", at };
      continue;
    }
    if (row?.has(ALLOC_NAMESPACES.encoding)) return { kind: "invalid", code: "namespace-presence", at };
    const ownership = {
      state: site.effect.access.has("escape") ? "escaped" : site.effect.shared ? "shared" : "owned",
      ops: site.effect.access.toArray(),
    };
    const escapeFacts = { classification: site.escape, stackAllocatable: site.escape === "local" };
    for (const [enabled, namespace, expected] of [
      [index.ownership, ALLOC_NAMESPACES.ownership, ownership],
      [index.escape, ALLOC_NAMESPACES.escape, escapeFacts],
    ] as const)
      if (enabled && !sameRecord(row?.get(namespace), expected))
        return { kind: "invalid", code: row?.has(namespace) ? "namespace-value" : "namespace-presence", at };
  }
  return undefined;
}
