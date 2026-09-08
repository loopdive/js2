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
import { IR_CLASS_SHAPE_CELL } from "./core/types.js";
import type {
  AllocSite,
  AllocRegistryProvenanceSnapshot,
  AllocRegistryMetadataSnapshot,
  AllocRegistrySnapshot,
} from "./analysis/contracts/allocations.js";
export type {
  AllocSite,
  AllocRegistryProvenanceSnapshot,
  AllocRegistryMetadataSnapshot,
  AllocRegistrySnapshot,
} from "./analysis/contracts/allocations.js";

/**
 * Descriptor-based, graph-preserving capture within the internal preparation-data
 * contract; not authentication of arbitrary live objects.
 */
export function copyIrPreparationData<T>(value: T): T {
  const copies = new Map<object, unknown>();
  const invalid = (detail: string): never => {
    throw new Error(`invalid preparation data: ${detail}`);
  };
  const visit = (value: unknown): unknown => {
    if (typeof value === "function" || typeof value === "symbol") invalid("executable/symbol value");
    if (value === null || typeof value !== "object") return value;
    if (copies.has(value)) return copies.get(value);
    // The intrinsic tests the Date slot without coercion or toStringTag access,
    // even when its prototype was erased. NaN still proves an invalid Date.
    let date = false;
    try {
      Reflect.apply(Date.prototype.getTime, value, []);
      date = true;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // Only the intrinsic's incompatible-receiver error means "not a Date".
    }
    if (date) invalid("unsupported Date instance");
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Map.prototype || prototype === Set.prototype) {
      if (Reflect.ownKeys(value).length) invalid("collection has extra properties");
      if (prototype === Map.prototype) {
        const copy = new Map<unknown, unknown>();
        copies.set(value, copy);
        for (const [key, item] of Map.prototype.entries.call(value)) copy.set(visit(key), visit(item));
        if (!Object.isExtensible(value)) Object.preventExtensions(copy);
        return copy;
      }
      const copy = new Set<unknown>();
      copies.set(value, copy);
      for (const item of Set.prototype.values.call(value)) copy.add(visit(item));
      if (!Object.isExtensible(value)) Object.preventExtensions(copy);
      return copy;
    }
    // Authenticate native collection slots even if somebody erased a prototype.
    for (const has of [Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]) {
      let native = false;
      try {
        Reflect.apply(has, value, [value]);
        native = true;
      } catch {
        /* Not this native collection. */
      }
      if (native) invalid("unsupported collection prototype");
    }
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      invalid("unsupported object instance");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = array ? new Array(descriptors.length!.value) : Object.create(prototype);
    copies.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) invalid(`accessor ${String(key)}`);
      if (array && key === "length") continue;
      if (array && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= descriptors.length!.value))
        invalid(`extra array property ${String(key)}`);
      if (typeof key === "symbol" && (key !== IR_CLASS_SHAPE_CELL || descriptor.value !== true))
        invalid("unsupported symbol property");
      Object.defineProperty(copy, key, { ...descriptor, value: visit(descriptor.value) });
    }
    if (array) Object.defineProperty(copy, "length", descriptors.length!);
    if (!Object.isExtensible(value)) Object.preventExtensions(copy);
    return copy;
  };
  // The checked graph retains T; this assertion does not erase a source carrier.
  return visit(value) as T;
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

/** Structural admission only; final analyses still verify metadata meaning. */
function assertAllocRegistrySnapshot(snapshot: AllocRegistrySnapshot): void {
  const invalid = (detail: string): never => {
    throw new Error(`invalid allocation snapshot: ${detail}`);
  };
  const fields = (value: object, required: readonly string[], optional: readonly string[] = []): void => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)),
      )
    )
      invalid("missing or foreign structural fields");
  };
  const dense = (value: readonly unknown[], label: string): void => {
    if (!Array.isArray(value)) invalid(`${label} is not an array`);
    for (let index = 0; index < value.length; index++)
      if (!Object.hasOwn(value, index)) invalid(`${label} has a missing slot`);
  };
  fields(snapshot, ["size", "entries", "metadata"]);
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0) invalid("denominator");
  dense(snapshot.entries, "entries");
  dense(snapshot.metadata, "metadata");
  if (snapshot.entries.length !== snapshot.size) invalid("denominator");
  const known = (id: number) => Number.isSafeInteger(id) && id >= 0 && id < snapshot.size;
  const kinds = new Set<AllocKind>([
    "object",
    "array",
    "string",
    "closure",
    "refcell",
    "box",
    "extern",
    "iterator",
    "generator",
  ]);
  for (const [index, entry] of snapshot.entries.entries()) {
    if (!entry) invalid(`missing slot ${index}`);
    if (entry.state === "live") {
      fields(entry, ["state", "site"]);
      fields(entry.site, ["id", "kind", "type"], ["origin"]);
      if (
        !entry.site ||
        entry.site.id !== index ||
        !kinds.has(entry.site.kind) ||
        !entry.site.type ||
        typeof entry.site.type !== "object"
      )
        invalid(`foreign live site ${index}`);
    } else if (entry.state === "aliased") {
      fields(entry, ["state", "to"]);
      const seen = new Set<number>([index]);
      let current = entry;
      while (current.state === "aliased") {
        if (!known(current.to) || seen.has(current.to)) invalid(`broken/cyclic alias ${index}`);
        seen.add(current.to);
        const next = snapshot.entries[current.to];
        if (!next) invalid(`missing alias target ${current.to}`);
        if (next.state !== "aliased") break;
        current = next;
      }
    } else if (entry.state === "retired") fields(entry, ["state"]);
    else invalid(`unknown state ${index}`);
  }
  const rows = new Set<number>();
  for (const row of snapshot.metadata) {
    fields(row, ["id", "entries"]);
    if (!row || !known(row.id) || rows.has(row.id)) invalid("foreign/duplicate metadata row");
    rows.add(row.id);
    dense(row.entries, "metadata entries");
    const namespaces = new Set<string>();
    for (const pair of row.entries) {
      dense(pair, "metadata pair");
      if (pair.length !== 2 || typeof pair[0] !== "string" || namespaces.has(pair[0]))
        invalid("invalid/duplicate namespace");
      namespaces.add(pair[0]);
    }
  }
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
  /** Restored packets may carry a non-index metadata row order. */
  private metadataOrder: readonly number[] | undefined;

  /** Capture related semantic data and registry evidence with ONE graph identity map. */
  capturePreparationData<T>(data: T): { readonly data: T; readonly allocations: AllocRegistrySnapshot } {
    const captured = copyIrPreparationData({
      data,
      allocations: { size: this.sites.length, entries: this.sites, metadata: this.metadataSnapshot() },
    });
    assertAllocRegistrySnapshot(captured.allocations);
    return captured;
  }

  /** Unlike historical snapshot(), this owns all site types, origins and metadata. */
  captureSnapshot(): AllocRegistrySnapshot {
    return this.capturePreparationData(undefined).allocations;
  }

  /** Restore related data jointly so site/IR/shared metadata identities stay joined. */
  static restorePreparationData<T>(
    snapshot: AllocRegistrySnapshot,
    data: T,
  ): {
    readonly data: T;
    readonly allocations: AllocSiteRegistry;
  } {
    const captured = copyIrPreparationData({ snapshot, data });
    assertAllocRegistrySnapshot(captured.snapshot);
    const allocations = new AllocSiteRegistry();
    for (const entry of captured.snapshot.entries) allocations.sites.push(entry);
    allocations.metadataOrder = captured.snapshot.metadata.map((row) => row.id);
    for (const row of captured.snapshot.metadata) allocations.meta[row.id] = new Map(row.entries);
    return { data: captured.data, allocations };
  }

  static fromSnapshot(snapshot: AllocRegistrySnapshot): AllocSiteRegistry {
    return AllocSiteRegistry.restorePreparationData(snapshot, undefined).allocations;
  }

  private metadataSnapshot(): AllocRegistryMetadataSnapshot[] {
    const rows: AllocRegistryMetadataSnapshot[] = [];
    const order = [...(this.metadataOrder ?? [])];
    const present = new Set(order);
    for (let index = 0; index < this.meta.length; index++) if (!present.has(index)) order.push(index);
    for (const index of order) {
      const row = this.meta[index];
      if (row) rows.push({ id: asAllocSiteId(index), entries: [...row.entries()] });
    }
    return rows;
  }

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
    const metadata = this.metadataSnapshot();
    return { size: this.sites.length, entries, metadata };
  }
}
