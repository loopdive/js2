// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Allocation-site registry (#1586).
//
// Gives every value-creating IR instruction a stable, module-global identity
// (`AllocSiteId`) that survives inlining, monomorphization, constant folding,
// and dead-code elimination, plus a namespaced metadata channel that future
// analyses (#1587 ownership, #1588 encoding, #1585 lifetime, escape analysis
// for closure capture / #747) attach annotations to without touching the IR
// core.
//
// Design — see docs/adr/0013-ir-allocation-sites.md:
//   - Identity lives on the instruction (`IrInstrBase.alloc`), NOT on the
//     `IrValueId`, because instrs are what passes clone/rewrite and an
//     `IrValueId` is renumbered by inline + monomorphize.
//   - The registry is a flat array indexed by id (O(1) fresh/resolve), not a
//     Map — it is consulted on every IR transformation (Risks: registry
//     overhead).
//   - Provenance has three states: live, aliased (folded into another site by
//     fusion), retired (proven dead and removed).
//
// This issue adds the hooks only. No analysis is performed here; the namespace
// table below is reserved by convention for the follow-up issues.

import type { AllocKind, AllocSiteId, IrSiteId, IrType } from "./nodes.js";
import { asAllocSiteId } from "./nodes.js";

/**
 * A live allocation site. `metadata` is stored out-of-band in the registry
 * (keyed by id + namespace), not on this record, so analyses can annotate
 * without mutating the IR.
 */
export interface AllocSite {
  readonly id: AllocSiteId;
  readonly kind: AllocKind;
  readonly type: IrType;
  /** Reuses the defining instr's source location, when present. */
  readonly origin?: IrSiteId;
}

/**
 * Reserved metadata namespaces. Each analysis owns exactly one and may not
 * write to another's. Enforced by convention in this issue (#1586); the ADR
 * documents the ownership table.
 */
export const ALLOC_NAMESPACES = {
  /** #1587 — ownership and access-semantics analysis. */
  ownership: "ownership",
  /** #1588 — string encoding tracking. */
  encoding: "encoding",
  /** #1585 — dual-target IR / lifetime analysis. */
  lifetime: "lifetime",
  /** Closure-capture escape analysis (#747). */
  escape: "escape",
} as const;

type Provenance =
  | { state: "live"; site: AllocSite }
  /** This id was folded into `to` by fusion (e.g. a future CSE pass). */
  | { state: "aliased"; to: AllocSiteId }
  /** This allocation was proven dead and removed. */
  | { state: "retired" };

/** A detached, read-only projection of one registry slot. */
export type AllocRegistryProvenanceSnapshot =
  | { readonly state: "live"; readonly site: AllocSite }
  | { readonly state: "aliased"; readonly to: AllocSiteId }
  | { readonly state: "retired" };

/** A metadata row retains an explicit `undefined` value when it was written. */
export interface AllocRegistryMetadataSnapshot {
  readonly id: AllocSiteId;
  readonly entries: readonly (readonly [namespace: string, value: unknown])[];
}

/**
 * Complete allocation-registry evidence for an immutable preparation batch.
 * Missing metadata rows and present rows whose value is `undefined` are
 * intentionally represented differently.
 */
export interface AllocRegistrySnapshot {
  readonly size: number;
  readonly entries: readonly AllocRegistryProvenanceSnapshot[];
  readonly metadata: readonly AllocRegistryMetadataSnapshot[];
}

/**
 * Module-global allocation-site registry. One per `IrModule` compile, threaded
 * through every pass invocation (see integration.ts). Not a per-function
 * singleton — inlining merges functions, so ids must be module-stable.
 */
export class AllocSiteRegistry {
  /** index === AllocSiteId. */
  private readonly sites: Provenance[] = [];
  /** metadata[id] = Map<namespace, value>. Sparse — created lazily. */
  private readonly meta: (Map<string, unknown> | undefined)[] = [];

  /** Mint a fresh, live allocation-site id. */
  fresh(kind: AllocKind, type: IrType, origin?: IrSiteId): AllocSiteId {
    const id = asAllocSiteId(this.sites.length);
    this.sites.push({ state: "live", site: { id, kind, type, origin } });
    return id;
  }

  /** True iff `id` indexes a known site (any state). */
  isKnown(id: AllocSiteId): boolean {
    const idx = id as number;
    return idx >= 0 && idx < this.sites.length;
  }

  /**
   * Resolve through alias chains to the canonical live site, or `null` if the
   * id is unknown, retired, or its chain terminates in a non-live entry. The
   * `seen` guard makes a malformed cycle resolve to `null` rather than loop.
   */
  resolve(id: AllocSiteId): AllocSite | null {
    let cur = this.sites[id as number];
    const seen = new Set<number>();
    seen.add(id as number);
    while (cur && cur.state === "aliased") {
      const to = cur.to as number;
      if (seen.has(to)) return null;
      seen.add(to);
      cur = this.sites[to];
    }
    return cur && cur.state === "live" ? cur.site : null;
  }

  /**
   * Resolve `id` to the index of its canonical entry (following alias chains),
   * or `null` on a broken/cyclic/unknown chain. Used internally so metadata
   * writes after fusion land on the canonical site.
   */
  private canonicalIndex(id: AllocSiteId): number | null {
    let idx = id as number;
    let cur = this.sites[idx];
    const seen = new Set<number>();
    seen.add(idx);
    while (cur && cur.state === "aliased") {
      const to = cur.to as number;
      if (seen.has(to)) return null;
      seen.add(to);
      idx = to;
      cur = this.sites[idx];
    }
    return cur ? idx : null;
  }

  /**
   * Record that `from` was fused into `to` (rule 2 — alias). Any metadata on
   * `from` is merged onto the canonical site `to` (existing keys on `to` win,
   * so a deliberate annotation is never clobbered by a fused-in default).
   * No-op if either id is unknown.
   */
  alias(from: AllocSiteId, to: AllocSiteId): void {
    const fromIdx = from as number;
    if (!this.isKnown(from) || !this.isKnown(to)) return;
    const toCanon = this.canonicalIndex(to);
    if (toCanon === null) return;
    // Merge metadata from `from` onto the canonical `to` before aliasing.
    const fromMeta = this.meta[fromIdx];
    if (fromMeta) {
      let toMeta = this.meta[toCanon];
      if (!toMeta) {
        toMeta = new Map();
        this.meta[toCanon] = toMeta;
      }
      for (const [ns, value] of fromMeta) {
        if (!toMeta.has(ns)) toMeta.set(ns, value);
      }
      this.meta[fromIdx] = undefined;
    }
    this.sites[fromIdx] = { state: "aliased", to: asAllocSiteId(toCanon) };
  }

  /** Mark an allocation dead and removed (rule 3 — retire). No-op if unknown. */
  retire(id: AllocSiteId): void {
    const idx = id as number;
    if (!this.isKnown(id)) return;
    this.sites[idx] = { state: "retired" };
    this.meta[idx] = undefined;
  }

  // --- metadata API (namespaced; each analysis owns one namespace) ---

  /**
   * Attach `value` under `ns` to the canonical site behind `id`. No-op if the
   * id resolves to nothing live (retired/unknown/broken chain).
   */
  annotate<T>(id: AllocSiteId, ns: string, value: T): void {
    const idx = this.canonicalIndex(id);
    if (idx === null) return;
    if (this.sites[idx].state !== "live") return;
    let m = this.meta[idx];
    if (!m) {
      m = new Map();
      this.meta[idx] = m;
    }
    m.set(ns, value);
  }

  /** Read the `ns` annotation on the canonical site behind `id`. */
  read<T>(id: AllocSiteId, ns: string): T | undefined {
    const idx = this.canonicalIndex(id);
    if (idx === null) return undefined;
    return this.meta[idx]?.get(ns) as T | undefined;
  }

  /** Number of sites ever minted (including aliased/retired). For diagnostics. */
  get size(): number {
    return this.sites.length;
  }

  /** Snapshot of live sites — for debugging / tooling, not hot paths. */
  liveSites(): AllocSite[] {
    const out: AllocSite[] = [];
    for (const p of this.sites) {
      if (p && p.state === "live") out.push(p.site);
    }
    return out;
  }

  /**
   * Return all minted provenance and metadata without retaining this registry.
   * Callers that publish the snapshot must defensively own it before exposing
   * it across a backend boundary.
   */
  snapshot(): AllocRegistrySnapshot {
    const entries = this.sites.map((provenance): AllocRegistryProvenanceSnapshot => {
      if (provenance.state === "live") {
        return {
          state: "live",
          site: { ...provenance.site },
        };
      }
      if (provenance.state === "aliased") return { state: "aliased", to: provenance.to };
      return { state: "retired" };
    });
    const metadata: AllocRegistryMetadataSnapshot[] = [];
    for (let index = 0; index < this.meta.length; index++) {
      const row = this.meta[index];
      if (!row) continue;
      metadata.push({
        id: asAllocSiteId(index),
        entries: [...row.entries()].map(([namespace, value]) => [namespace, value] as const),
      });
    }
    return { size: this.sites.length, entries, metadata };
  }
}
