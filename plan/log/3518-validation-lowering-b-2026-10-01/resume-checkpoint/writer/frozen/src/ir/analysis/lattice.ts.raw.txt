// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Ownership + access lattices (#1587).
//
// Two independent lattices the ownership analysis (`ownership.ts`) computes per
// IR value. Both are *inference* results, not declarations — see ADR-0014. A
// value the analysis cannot reason about gets the TOP (most permissive)
// element of each lattice, which is correctness-preserving for every consumer.
//
// The Rust-borrow-checker framing is deliberately disclaimed: "ownership" here
// is a discovered classification, never a rejected program property.

/**
 * Ownership state — a totally ordered lattice from most-precise (`owned`) to
 * most-permissive (`escaped`). Higher = more conservative = safer default.
 *
 *   owned  ⊑ borrowed ⊑ shared ⊑ escaped
 *
 * - `owned`    — exactly one live reference (this one) for its liveness.
 * - `borrowed` — referenced elsewhere; this ref must not deallocate/invalidate.
 * - `shared`   — multiple references; mutation must be observable to all.
 * - `escaped`  — lifetime extends beyond this function (return, capture,
 *                store-to-heap, pass to opaque code).
 */
export type Ownership = "owned" | "borrowed" | "shared" | "escaped";

/** Lattice rank — index into the total order. Lower = more precise. */
const OWNERSHIP_RANK: Readonly<Record<Ownership, number>> = {
  owned: 0,
  borrowed: 1,
  shared: 2,
  escaped: 3,
};

const OWNERSHIP_BY_RANK: readonly Ownership[] = ["owned", "borrowed", "shared", "escaped"];

/** Top of the ownership lattice — the conservative default. */
export const OWNERSHIP_TOP: Ownership = "escaped";

/**
 * Join (least upper bound) of two ownership states. Used at control-flow merge
 * points and whenever an operation widens a value's classification: the result
 * is the *more conservative* of the two. Commutative, associative, idempotent.
 */
export function joinOwnership(a: Ownership, b: Ownership): Ownership {
  return OWNERSHIP_BY_RANK[Math.max(OWNERSHIP_RANK[a], OWNERSHIP_RANK[b])]!;
}

/** True iff `a` is at least as precise as `b` (`a ⊑ b`). */
export function ownershipLeq(a: Ownership, b: Ownership): boolean {
  return OWNERSHIP_RANK[a] <= OWNERSHIP_RANK[b];
}

/**
 * Access operation — how a reference is used. The access lattice is the
 * powerset of these tags ordered by ⊆; join is set union, bottom is `{}`, top
 * is the full set. A value that escapes to opaque code conservatively widens
 * to the full set (the callee may do anything).
 */
export type AccessOp = "read" | "write" | "mutate" | "identity" | "escape";

const ALL_ACCESS_OPS: readonly AccessOp[] = ["read", "write", "mutate", "identity", "escape"];

/**
 * An access set — a small immutable wrapper over `Set<AccessOp>` with union
 * (join) and subset (⊑) operations. Kept as a class so the query API can hand
 * consumers a value they cannot accidentally mutate.
 */
export class AccessSet {
  private readonly ops: ReadonlySet<AccessOp>;

  private constructor(ops: ReadonlySet<AccessOp>) {
    this.ops = ops;
  }

  /** Bottom — no observed access. */
  static empty(): AccessSet {
    return new AccessSet(new Set());
  }

  /** Top — the conservative full access set. */
  static full(): AccessSet {
    return new AccessSet(new Set(ALL_ACCESS_OPS));
  }

  static of(...ops: readonly AccessOp[]): AccessSet {
    return new AccessSet(new Set(ops));
  }

  has(op: AccessOp): boolean {
    return this.ops.has(op);
  }

  /** Join — set union. Returns `this` unchanged when `op` is already present. */
  with(op: AccessOp): AccessSet {
    if (this.ops.has(op)) return this;
    const next = new Set(this.ops);
    next.add(op);
    return new AccessSet(next);
  }

  /** Join — set union of two access sets. */
  union(other: AccessSet): AccessSet {
    let needsCopy = false;
    for (const op of other.ops) {
      if (!this.ops.has(op)) {
        needsCopy = true;
        break;
      }
    }
    if (!needsCopy) return this;
    const next = new Set(this.ops);
    for (const op of other.ops) next.add(op);
    return new AccessSet(next);
  }

  /** True iff `this ⊆ other`. */
  subsetOf(other: AccessSet): boolean {
    for (const op of this.ops) {
      if (!other.ops.has(op)) return false;
    }
    return true;
  }

  equals(other: AccessSet): boolean {
    return this.ops.size === other.ops.size && this.subsetOf(other);
  }

  /** Stable, sorted array view — for annotations, tests, and diagnostics. */
  toArray(): AccessOp[] {
    return ALL_ACCESS_OPS.filter((op) => this.ops.has(op));
  }
}

/**
 * The full classification the analysis attaches to a value. This is the shape
 * stored in the registry `ownership` namespace and the parallel `ValueAnnot`
 * map. Consumers must treat it as the analysis's *tightest provable* result
 * and fall back to their conservative path when it is not tight enough — they
 * may never assume a tighter classification than this carries (ADR-0014).
 */
export interface OwnershipAnnotation {
  readonly ownership: Ownership;
  readonly access: AccessSet;
}

/** The conservative TOP annotation — used for anything not provably tighter. */
export function topAnnotation(): OwnershipAnnotation {
  return { ownership: OWNERSHIP_TOP, access: AccessSet.full() };
}

/** Join two annotations component-wise (used at CFG merges). */
export function joinAnnotations(a: OwnershipAnnotation, b: OwnershipAnnotation): OwnershipAnnotation {
  return {
    ownership: joinOwnership(a.ownership, b.ownership),
    access: a.access.union(b.access),
  };
}

export function annotationsEqual(a: OwnershipAnnotation, b: OwnershipAnnotation): boolean {
  return a.ownership === b.ownership && a.access.equals(b.access);
}
