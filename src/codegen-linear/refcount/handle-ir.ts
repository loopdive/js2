// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — the handle IR the refcount / handle-scope pass rewrites.
//
// ── Why this is its own IR and not `IrInstr` ────────────────────────────
//
// The pass needs exactly four facts about a program and nothing else: where a
// JSValue handle is produced, where it is used, where control leaves a scope,
// and where control can leave a scope EXCEPTIONALLY. `IrInstr` carries none of
// those explicitly today — the boxed tier that produces handles is #4541, which
// is not landed. Bolting handle ops onto `IrInstr` before that lowering exists
// would fix the wrong shape and force #4541 to redo it.
//
// So this is the CONTRACT between the two: #4541's `LinearEmitter` lowering
// produces handle IR for the dynamic residue; this pass rewrites it; the
// rewritten form lowers to `Instr[]` (see `lower.ts`). The pass can be built,
// specified and — importantly, given the engine artifact is not available in
// every environment — TESTED on its own terms.
//
// ── Structured control flow only ────────────────────────────────────────
//
// A region tree, not a CFG. That is not a simplification: Wasm's control flow
// IS structured, and a destructor-insertion pass over a region tree gets its
// central property for free — the set of scopes an edge leaves is a suffix of
// the scope stack, so "release everything between here and the target" is a
// stack slice rather than a dataflow problem.

import type { ResultOwnership } from "./ownership.js";

/** A JSValue-valued SSA name within one function body. */
export type HandleId = number;

/** Why the pass inserted a `JS_DupValue`. */
export type DupReason =
  /** An owned handle is being handed to a `consumes` parameter. */
  | "consume-arg"
  /** A borrowed handle is being handed to a `consumes` parameter. */
  | "consume-arg-borrowed"
  /** A borrowed result is being retained past the point its owner could drop it. */
  | "retain-borrowed"
  /** The value is being handed to our caller as an owned result. */
  | "return-transfer"
  /** The value is being handed to the unwind path. */
  | "throw-transfer";

/** Why the pass inserted a `JS_FreeValue`. */
export type FreeReason =
  /** Normal fall-through off the end of the scope that owns the handle. */
  | "scope-exit"
  /** A `return` crossing the owning scope. */
  | "return"
  /** A `break` crossing the owning scope. */
  | "break"
  /** A `continue` crossing the owning scope. */
  | "continue"
  /** The unwind path — inside a `catch_all` cleanup handler. */
  | "unwind";

/** A call to a declared engine import. */
export interface HandleCall {
  kind: "call";
  /** Key into the resolved ownership table (`name` or `module.name`). */
  callee: string;
  /**
   * One entry per declared parameter. `null` marks a position this pass does
   * not track (a context pointer, a length, an atom) — positional, so a
   * `consumes` annotation can never drift onto the wrong argument.
   */
  args: readonly (HandleId | null)[];
  /** Present iff the import returns a handle. */
  dest?: HandleId;
  /**
   * `dest` is a NAMED BINDING: it must stay valid until its scope ends, so a
   * borrowed result has to be duplicated into an owned one. Without this flag a
   * handle is a TEMPORARY — the issue's fourth bullet — and a borrowed
   * temporary can be read through directly.
   */
  binding?: boolean;
  note?: string;
}

export type HandleStmt =
  | HandleCall
  /** Read through a handle without calling anything (a pure borrow). */
  | { kind: "use"; value: HandleId; note?: string }
  /** An explicit lexical scope with no control-flow meaning of its own. */
  | { kind: "scope"; body: readonly HandleStmt[]; note?: string }
  | {
      kind: "if";
      then: readonly HandleStmt[];
      else?: readonly HandleStmt[];
      note?: string;
    }
  /** A `break`-able region. */
  | { kind: "block"; label: string; body: readonly HandleStmt[] }
  /** A `break`-able and `continue`-able region. */
  | { kind: "loop"; label: string; body: readonly HandleStmt[] }
  | { kind: "break"; label: string }
  | { kind: "continue"; label: string }
  | { kind: "return"; value?: HandleId }
  | { kind: "throw"; value?: HandleId }
  /**
   * Work this pass does not model. `throws` says whether it can reach the
   * unwind path — the one property that still matters here.
   */
  | { kind: "opaque"; throws?: boolean; note?: string }
  // ── Inserted BY the pass. Never present in its input. ──
  /**
   * Take a second reference to `value`, naming it `dest`.
   *
   * `dest` is a genuinely new name, NOT an alias, because that is what the
   * pinned artifact does: `qjs_dup(ctx, h)` boxes the duplicated `JSValue` into
   * a FRESH cell and returns a new handle (`scripts/quickjs-artifact/qjs_shim.c`,
   * `box(JS_DupValue(...))`). A cell is released exactly once by
   * `qjs_free_value`, which frees the reference AND the cell — so under the
   * shim a handle is a linear resource with count 0 or 1, never 2.
   *
   * Modelling it as an in-place `+1` on the same name (which is what the RAW
   * QuickJS C API does — `JS_DupValue` returns the same `JSValue`) would emit
   * one release for two cells and leak the second one on every dup. The
   * fresh-name model is correct for BOTH ABIs: against a raw-API build, bind
   * `value` and `dest` to the same Wasm local and the two releases become the
   * two decrements that API wants.
   */
  | { kind: "dup"; value: HandleId; dest: HandleId; reason: DupReason }
  /** Release `value` — one reference and, under the shim ABI, its cell. */
  | { kind: "free"; value: HandleId; reason: FreeReason }
  /**
   * A cleanup region: run `body`; if it unwinds, run `unwind` and re-raise.
   * Lowers to `try body catch_all unwind; rethrow`.
   *
   * `owner` is the single handle this region protects. One region per owned
   * handle is deliberate — see the "why one region per handle" note in
   * `handle-scope.ts`. Nesting them is what makes the cleanup list at any throw
   * point EXACTLY the set of handles that have actually been acquired.
   */
  | {
      kind: "cleanup";
      owner: HandleId;
      body: readonly HandleStmt[];
      unwind: readonly HandleStmt[];
    };

/** A handle that arrives as a function parameter. */
export interface HandleParam {
  id: HandleId;
  /**
   * `"borrowed"` — the caller retains ownership (the ordinary QuickJS C
   * convention for a `JSValueConst`). `"owned"` — this frame must release it,
   * so it joins the function's root scope like any acquired handle.
   */
  ownership: "borrowed" | "owned";
  name?: string;
}

export interface HandleFunction {
  name: string;
  params: readonly HandleParam[];
  /** What `return v` hands the caller. `"owned"` means a `+1` transfers out. */
  result: ResultOwnership;
  body: readonly HandleStmt[];
}

// ── Small structural helpers ────────────────────────────────────────────

/** Every nested statement list of a statement, in emission order. */
export function nestedBodies(s: HandleStmt): readonly (readonly HandleStmt[])[] {
  switch (s.kind) {
    case "scope":
      return [s.body];
    case "if":
      return s.else ? [s.then, s.else] : [s.then];
    case "block":
    case "loop":
      return [s.body];
    case "cleanup":
      return [s.body, s.unwind];
    default:
      return [];
  }
}

/**
 * Can this statement list reach an unwind path?
 *
 * Deliberately conservative and syntactic. A `cleanup` counts as throwing
 * because it re-raises — an inner handler does not stop the exception, it only
 * adds a release to it, so an outer scope still needs its own.
 */
export function canThrow(stmts: readonly HandleStmt[], throwsOf: (callee: string) => boolean): boolean {
  for (const s of stmts) {
    if (s.kind === "throw") return true;
    if (s.kind === "call" && throwsOf(s.callee)) return true;
    if (s.kind === "opaque" && s.throws !== false) return true;
    for (const body of nestedBodies(s)) if (canThrow(body, throwsOf)) return true;
  }
  return false;
}

/** Walk every statement in a body, depth-first, including nested bodies. */
export function* walk(stmts: readonly HandleStmt[]): Iterable<HandleStmt> {
  for (const s of stmts) {
    yield s;
    for (const body of nestedBodies(s)) yield* walk(body);
  }
}

/** Count statements matching a predicate — the shape most tests assert on. */
export function count(stmts: readonly HandleStmt[], pred: (s: HandleStmt) => boolean): number {
  let n = 0;
  for (const s of walk(stmts)) if (pred(s)) n++;
  return n;
}

/** A compact, diffable rendering of a body. Used by tests and diagnostics. */
export function formatHandleStmts(stmts: readonly HandleStmt[], indent = ""): string[] {
  const out: string[] = [];
  for (const s of stmts) {
    switch (s.kind) {
      case "call":
        out.push(
          `${indent}call ${s.callee}(${s.args.map((a) => (a === null ? "_" : `h${a}`)).join(", ")})` +
            (s.dest !== undefined ? ` -> h${s.dest}${s.binding ? " [binding]" : ""}` : ""),
        );
        break;
      case "use":
        out.push(`${indent}use h${s.value}`);
        break;
      case "dup":
        out.push(`${indent}dup h${s.value} -> h${s.dest} (${s.reason})`);
        break;
      case "free":
        out.push(`${indent}free h${s.value} (${s.reason})`);
        break;
      case "return":
        out.push(`${indent}return${s.value !== undefined ? ` h${s.value}` : ""}`);
        break;
      case "throw":
        out.push(`${indent}throw${s.value !== undefined ? ` h${s.value}` : ""}`);
        break;
      case "break":
        out.push(`${indent}break ${s.label}`);
        break;
      case "continue":
        out.push(`${indent}continue ${s.label}`);
        break;
      case "opaque":
        out.push(`${indent}opaque${s.throws === false ? "" : " (throws)"}${s.note ? ` // ${s.note}` : ""}`);
        break;
      case "scope":
        out.push(`${indent}scope {`, ...formatHandleStmts(s.body, `${indent}  `), `${indent}}`);
        break;
      case "if":
        out.push(`${indent}if {`, ...formatHandleStmts(s.then, `${indent}  `));
        if (s.else) out.push(`${indent}} else {`, ...formatHandleStmts(s.else, `${indent}  `));
        out.push(`${indent}}`);
        break;
      case "block":
      case "loop":
        out.push(`${indent}${s.kind} ${s.label} {`, ...formatHandleStmts(s.body, `${indent}  `), `${indent}}`);
        break;
      case "cleanup":
        out.push(
          `${indent}cleanup h${s.owner} {`,
          ...formatHandleStmts(s.body, `${indent}  `),
          `${indent}} unwind {`,
          ...formatHandleStmts(s.unwind, `${indent}  `),
          `${indent}}`,
        );
        break;
    }
  }
  return out;
}
