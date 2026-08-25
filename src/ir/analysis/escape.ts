// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Escape analysis for stack allocation (#747, Phase 1).
//
// Built directly on the #1587 ownership/access analysis: that pass already
// decides *whether* an allocation escapes (ownership `escaped` / access
// `escape`); this consumer decides *how* it escapes so downstream
// optimizations (scalar replacement, stack allocation, #652 compile-time ARC)
// can act on the classification.
//
// Classification (ECMA-agnostic; see the issue #747 "What escape means"):
//   - `local`    — never escapes; lifetime bounded by the function. Candidate
//                  for scalar replacement / stack allocation.
//   - `returned` — flows to a `return` terminator (or `async.return`).
//   - `stored`   — written into a heap-reachable field of another object/array
//                  (object.set / class.set / refcell.set newValue).
//   - `captured` — closed over by a `closure.new` capture list.
//   - `opaque`   — passed to an opaque call / extern / coercion / await / throw;
//                  the callee may retain it. The most conservative escape.
//
// Like #1587 this pass is *inference*, default-OFF, and inert: it writes to the
// `AllocSiteRegistry` `escape` namespace (reserved by ADR-0013 for this issue)
// and NEVER mutates the IR. Removing it cannot change emitted Wasm. Scalar
// replacement / stack allocation itself is a follow-up that consumes this
// classification; Phase 1 only produces it (matching #1587's "annotation-only
// demonstration consumer" discipline).

import type { AllocSiteRegistry } from "../alloc-registry.js";
import { ALLOC_NAMESPACES } from "../alloc-registry.js";
import type { IrFunction, IrInstr, IrTerminator, IrValueId } from "../nodes.js";
import { analyzeOwnership, type OwnershipResult } from "./ownership.js";

/**
 * How an allocation escapes its defining function. Ordered most-precise →
 * most-conservative; `local` is the only stack-allocatable classification.
 */
export type EscapeClass = "local" | "returned" | "stored" | "captured" | "opaque";

export interface EscapeInfo {
  readonly classification: EscapeClass;
  /** True iff `classification === "local"` — safe for scalar replacement. */
  readonly stackAllocatable: boolean;
}

/** Severity order — a value flowing through several escape edges takes the max. */
const ESCAPE_RANK: Readonly<Record<EscapeClass, number>> = {
  local: 0,
  returned: 1,
  stored: 2,
  captured: 3,
  opaque: 4,
};

function worse(a: EscapeClass, b: EscapeClass): EscapeClass {
  return ESCAPE_RANK[a] >= ESCAPE_RANK[b] ? a : b;
}

/** Per-function escape-analysis result, keyed by allocation result value. */
export class EscapeResult {
  constructor(private readonly infos: ReadonlyMap<IrValueId, EscapeInfo>) {}

  /** Escape info for an allocation value, or `undefined` if it is not an alloc. */
  of(value: IrValueId): EscapeInfo | undefined {
    return this.infos.get(value);
  }

  classOf(value: IrValueId): EscapeClass | undefined {
    return this.infos.get(value)?.classification;
  }

  /** Allocation values proven `local` — the stack-allocation candidates. */
  localAllocations(): IrValueId[] {
    const out: IrValueId[] = [];
    for (const [v, info] of this.infos) {
      if (info.classification === "local") out.push(v);
    }
    return out;
  }

  entries(): Iterable<[IrValueId, EscapeInfo]> {
    return this.infos.entries();
  }
}

/**
 * Run escape analysis on `fn`. Uses the #1587 ownership result (computed fresh
 * when not supplied) as the escape oracle, then walks the IR to attribute the
 * strongest escape edge per allocation. When `registry` is supplied, each
 * allocation's classification is written under the `escape` namespace keyed by
 * the defining instr's alloc id.
 */
export function analyzeEscape(
  fn: IrFunction,
  registry?: AllocSiteRegistry,
  precomputedOwnership?: OwnershipResult,
): EscapeResult {
  const ownership = precomputedOwnership ?? analyzeOwnership(fn, registry);

  // value -> (allocId, defining instr kind) for every allocation site.
  const allocs = new Map<IrValueId, number>();
  collectAllocs(fn, allocs);

  // Seed every allocation as `local`; escape edges only ever raise the class.
  const cls = new Map<IrValueId, EscapeClass>();
  for (const v of allocs.keys()) cls.set(v, "local");

  const raise = (v: IrValueId, c: EscapeClass): void => {
    if (!cls.has(v)) return; // only classify known allocations
    cls.set(v, worse(cls.get(v)!, c));
  };

  // Attribute escape edges by walking every instr + terminator.
  const visitInstr = (instr: IrInstr): void => {
    switch (instr.kind) {
      case "object.set":
      case "class.set":
        raise(instr.newValue, "stored");
        break;
      case "fnctor.new":
        // Constructor captures/arguments cross an opaque synthesized-body
        // boundary and may be retained in the returned heap object.
        for (const value of instr.captureArgs) raise(value, "opaque");
        for (const value of instr.args) raise(value, "opaque");
        if (instr.constructorIdentity !== null) raise(instr.constructorIdentity, "opaque");
        break;
      case "refcell.set":
        raise(instr.value, "stored");
        break;
      case "closure.new":
        for (const cap of instr.captures) raise(cap, "captured");
        break;
      case "call":
        for (const a of instr.args) raise(a, "opaque");
        break;
      case "class.call":
        raise(instr.receiver, "opaque");
        for (const a of instr.args) raise(a, "opaque");
        break;
      // #3000-E: super(...) / super.method() pass `self`/receiver + args into an
      // opaque parent function (`<parent>_init` / `<parent>_<method>`), so every
      // operand escapes — same as a plain class.call.
      case "class.super_init":
        raise(instr.self, "opaque");
        for (const a of instr.args) raise(a, "opaque");
        break;
      case "class.super_call":
        raise(instr.receiver, "opaque");
        for (const a of instr.args) raise(a, "opaque");
        break;
      // (#3144): static method call — opaque callee body, args escape.
      // class.instanceof only READS the receiver's tag (no escape), so it
      // deliberately has no case here (falls to the default read handling).
      case "class.static_call":
        for (const a of instr.args) raise(a, "opaque");
        break;
      case "closure.call":
        raise(instr.callee, "opaque");
        for (const a of instr.args) raise(a, "opaque");
        break;
      case "extern.call":
      case "extern.new":
      case "extern.prop":
      case "extern.propSet":
        for (const v of refOperands(instr)) raise(v, "opaque");
        break;
      case "iter.new":
        raise(instr.iterable, "opaque");
        break;
      case "coerce.to_externref":
        raise(instr.value, "opaque");
        break;
      case "await":
        raise(instr.operand, "opaque");
        break;
      case "async.return":
        raise(instr.value, "returned");
        break;
      case "async.throw":
        raise(instr.reason, "opaque");
        break;
      case "throw":
        raise((instr as { value: IrValueId }).value, "opaque");
        break;
      case "if":
        for (const sub of instr.then) visitInstr(sub);
        for (const sub of instr.else) visitInstr(sub);
        break;
      case "forof.vec":
      case "forof.iter":
      case "forof.string":
        for (const sub of (instr as { body: readonly IrInstr[] }).body) visitInstr(sub);
        break;
      case "while.loop":
      case "for.loop":
      case "try":
        for (const sub of nestedInstrs(instr)) visitInstr(sub);
        break;
      default:
        break;
    }
  };

  const visitTerminator = (term: IrTerminator): void => {
    if (term.kind === "return") {
      for (const v of term.values) raise(v, "returned");
    }
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) visitInstr(instr);
    visitTerminator(block.terminator);
  }

  // Soundness backstop: if #1587 proved a value escaped but our edge walk found
  // no specific edge (e.g. an escape path the edge attribution doesn't model),
  // never report it as `local`. Fall back to `opaque` — the safe default.
  for (const v of allocs.keys()) {
    const c = cls.get(v)!;
    if (c === "local" && !ownership.isStackAllocatable(v)) {
      cls.set(v, "opaque");
    }
  }

  const infos = new Map<IrValueId, EscapeInfo>();
  for (const [v, allocId] of allocs) {
    const classification = cls.get(v)!;
    const info: EscapeInfo = { classification, stackAllocatable: classification === "local" };
    infos.set(v, info);
    if (registry) {
      registry.annotate(allocId as never, ALLOC_NAMESPACES.escape, {
        classification,
        stackAllocatable: info.stackAllocatable,
      });
    }
  }

  return new EscapeResult(infos);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectAllocs(fn: IrFunction, out: Map<IrValueId, number>): void {
  const walk = (instr: IrInstr): void => {
    if (instr.result !== null && instr.alloc !== undefined) {
      out.set(instr.result, instr.alloc as unknown as number);
    }
    for (const sub of nestedInstrs(instr)) walk(sub);
  };
  for (const block of fn.blocks) {
    for (const instr of block.instrs) walk(instr);
  }
}

const REF_OPERAND_FIELDS = new Set([
  "value",
  "newValue",
  "receiver",
  "callee",
  "cell",
  "operand",
  "reason",
  "iterable",
  "self",
]);

function* refOperands(instr: IrInstr): Iterable<IrValueId> {
  for (const [key, value] of Object.entries(instr as unknown as Record<string, unknown>)) {
    if (key === "result") continue;
    if (typeof value === "number" && REF_OPERAND_FIELDS.has(key)) {
      yield value as unknown as IrValueId;
    } else if (Array.isArray(value)) {
      for (const el of value) if (typeof el === "number") yield el as unknown as IrValueId;
    }
  }
}

function* nestedInstrs(instr: IrInstr): Iterable<IrInstr> {
  for (const value of Object.values(instr as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const el of value) if (isInstrLike(el)) yield el as IrInstr;
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(inner)) {
          for (const el of inner) if (isInstrLike(el)) yield el as IrInstr;
        }
      }
    }
  }
}

function isInstrLike(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    "result" in (v as object)
  );
}
