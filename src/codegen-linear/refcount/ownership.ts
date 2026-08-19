// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — the ownership summary of an engine C-API import.
//
// This is the DECLARED INPUT to the handle-scope pass. It is a hand-written
// summary because the callee is foreign code the analysis cannot see (the
// reasoning is recorded on `ExternCImportSpec.ownership` in `../c-abi.ts`).
//
// ── Why the declared field grew four axes ───────────────────────────────
//
// `ExternCImportSpec.ownership?: "borrows" | "consumes"` answers exactly one
// question: does the callee take ownership of the handles we pass IN. A
// destructor-insertion pass needs three more before it can place a single
// `JS_FreeValue` correctly, and each of the three is a distinct failure if
// guessed:
//
//   * RESULT ownership — `JS_GetPropertyStr` hands back a reference we own
//     (+1); an accessor that merely exposes an interior slot hands back a
//     borrow. Free the second and the engine underflows; retain the first
//     without freeing and it leaks. The argument axis cannot express this.
//   * THROWS — whether the call can reach an unwind path. The pass only wraps
//     a scope in a cleanup handler when something inside it can throw, so this
//     decides whether the exceptional path is covered at all.
//   * RELEASES-CONTAINER-SLOTS — whether the call can drop a reference held in
//     an engine-visible object slot. This is the second consumer the issue's
//     "Elision safety condition (agreed 2026-08-18)" names explicitly: the
//     rule it states is unimplementable unless the annotation can express it.
//
// The two safety-only axes (`throws`, `releasesContainerSlots`) are the only
// ones that may be DERIVED when absent, and only ever toward `true` — a
// conservative value there costs a redundant cleanup handler or a retained
// dup/free pair, which is the direction the issue's own rule ("when in doubt,
// keep the pair") chooses. The two correctness axes (`args`, `result`) are
// never derived: an unset value stays distinguishable from `"borrows"`, and
// asking for one that was not declared is a compile error.

import type { ExternCImportSpec, ExternCValType } from "../c-abi.js";

/**
 * Does the callee take ownership of a handle passed in this position?
 *
 * `"consumes"` means the callee takes the reference on EVERY outcome,
 * including failure — the QuickJS convention (`JS_SetPropertyStr` frees the
 * value whether or not the store succeeds). The pass relies on this: it emits
 * the dup for a consumed argument BEFORE the call, so an "only on success"
 * callee would leak that dup on the throwing path. If an import ever violates
 * the convention it needs its own annotation, not a re-reading of this one.
 */
export type ArgOwnership = "borrows" | "consumes";

/**
 * Does a handle-typed RESULT arrive with a reference the caller owns?
 *
 * - `"owned"` — a `+1` the caller must eventually release (QuickJS
 *   `JS_GetPropertyStr`, `JS_Call`, `JS_NewObject`).
 * - `"borrowed"` — a bare handle whose reference belongs to someone else. Safe
 *   to read through immediately; must be duplicated before it is retained past
 *   any point where the real owner could drop it.
 * - `"none"` — the import returns no handle.
 */
export type ResultOwnership = "owned" | "borrowed" | "none";

/**
 * The full ownership summary. Supplying this record (rather than the
 * `"borrows"` / `"consumes"` shorthand) is REQUIRED whenever the import
 * returns a handle, because the shorthand cannot say what the result is.
 */
export interface ImportOwnership {
  /**
   * Per-parameter, or one value applied to every handle-typed parameter.
   * When an array is given it must have exactly one entry per declared
   * parameter — including non-handle ones, which must be `"borrows"`. Padding
   * the array is deliberate: a positional annotation that silently skips
   * positions is how a `consumes` ends up attached to the wrong argument.
   */
  readonly args: ArgOwnership | readonly ArgOwnership[];
  /** Ownership of the handle-typed result, if any. */
  readonly result: ResultOwnership;
  /**
   * Can this call transfer control to an unwind path? Omitted means `true`
   * (conservative: an extra cleanup handler, never a missed one).
   */
  readonly throws?: boolean;
  /**
   * Can this call drop a reference held in an engine-visible container slot?
   * Omitted means `true`. Consumed by the elision follow-up, not by insertion.
   */
  readonly releasesContainerSlots?: boolean;
}

/** An ownership summary with every axis resolved. */
export interface ResolvedOwnership {
  /** One entry per declared parameter. */
  readonly args: readonly ArgOwnership[];
  readonly result: ResultOwnership;
  readonly throws: boolean;
  readonly releasesContainerSlots: boolean;
  /** Positions of the handle-typed parameters, for diagnostics. */
  readonly handleParams: readonly number[];
}

/** Is this declared extern type a JSValue handle? */
export function isHandleType(t: ExternCValType): boolean {
  return "address" in t && t.address === "handle";
}

/** Positions of a spec's handle-typed parameters. */
export function handleParamPositions(spec: ExternCImportSpec): number[] {
  const out: number[] = [];
  for (let i = 0; i < spec.params.length; i++) if (isHandleType(spec.params[i])) out.push(i);
  return out;
}

/** Does the spec return a handle? */
export function returnsHandle(spec: ExternCImportSpec): boolean {
  return spec.results.some(isHandleType);
}

/**
 * Does this import traffic in JSValue handles at all?
 *
 * Imports that do not are outside the refcount pass's remit entirely: there is
 * no reference to own, so there is nothing an annotation could say. This is
 * the scope of the "an import without one is a compile error" rule — see
 * {@link requireOwnershipAnnotations}.
 */
export function trafficsInHandles(spec: ExternCImportSpec): boolean {
  return handleParamPositions(spec).length > 0 || returnsHandle(spec);
}

export class OwnershipAnnotationError extends Error {
  constructor(
    readonly spec: Pick<ExternCImportSpec, "module" | "name">,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipAnnotationError";
  }
}

function fail(spec: ExternCImportSpec, message: string): never {
  throw new OwnershipAnnotationError(spec, `extern import '${spec.module}.${spec.name}': ${message}`);
}

/**
 * Resolve a spec's ownership annotation, or REFUSE.
 *
 * Refusal, not a default, is the whole point: a wrong default is a leak in one
 * direction and a use-after-free in the other, and both surface far from here.
 */
export function resolveImportOwnership(spec: ExternCImportSpec): ResolvedOwnership {
  const handleParams = handleParamPositions(spec);
  const hasHandleResult = returnsHandle(spec);

  const declared = spec.ownership;

  if (handleParams.length === 0 && !hasHandleResult && declared === undefined) {
    // Nothing refcounted crosses this boundary and nothing was claimed about
    // it. There is no reference to own, so there is nothing to annotate and
    // nothing for the pass to emit. (An import that DOES carry an annotation
    // still gets validated below, even with no handles — a `consumes` on a
    // handle-free signature is a mistake worth naming, not a harmless no-op.)
    return {
      args: spec.params.map(() => "borrows" as const),
      result: "none",
      throws: false,
      releasesContainerSlots: false,
      handleParams,
    };
  }

  if (declared === undefined) {
    fail(
      spec,
      "no ownership annotation. This import carries JSValue handles " +
        `(${handleParams.length} handle parameter(s)${hasHandleResult ? ", handle result" : ""}), so the ` +
        "refcount pass cannot place JS_DupValue/JS_FreeValue without knowing whether the callee " +
        'consumes or borrows them. Declare `ownership: "borrows"` / `"consumes"`, or the full ' +
        "record `{ args, result, throws?, releasesContainerSlots? }`. There is deliberately no default: " +
        "guessing wrong leaks in one direction and double-frees in the other.",
    );
  }

  // A `consumes` claim about a signature with no handle in it cannot be true,
  // and silently ignoring it hides a real mistake — usually a parameter that
  // was meant to be `{ address: "handle" }` and was written as a plain `i32`.
  const uniform = typeof declared === "string" ? declared : typeof declared.args === "string" ? declared.args : null;
  if (uniform === "consumes" && handleParams.length === 0) {
    fail(
      spec,
      'ownership declares "consumes" but no parameter is a handle. Only a JSValue carries a reference ' +
        'that could be transferred — check whether a parameter should be `{ address: "handle" }`.',
    );
  }

  if (typeof declared === "string") {
    if (hasHandleResult) {
      fail(
        spec,
        `the shorthand ownership: "${declared}" cannot be used here — this import RETURNS a handle, ` +
          "and the shorthand only states what happens to the arguments. Declare the record form so the " +
          'result axis is explicit: `ownership: { args: "' +
          declared +
          '", result: "owned" | "borrowed" }`.',
      );
    }
    return {
      args: spec.params.map((p) => (isHandleType(p) ? declared : "borrows")),
      result: "none",
      throws: true,
      releasesContainerSlots: true,
      handleParams,
    };
  }

  let args: ArgOwnership[];
  if (typeof declared.args === "string") {
    args = spec.params.map((p) => (isHandleType(p) ? (declared.args as ArgOwnership) : "borrows"));
  } else {
    const given = declared.args;
    if (given.length !== spec.params.length) {
      fail(
        spec,
        `ownership.args has ${given.length} entr${given.length === 1 ? "y" : "ies"} but the import declares ` +
          `${spec.params.length} parameter(s). A positional annotation must cover every position — a short ` +
          "array silently shifts `consumes` onto the wrong argument.",
      );
    }
    for (let i = 0; i < given.length; i++) {
      if (given[i] === "consumes" && !isHandleType(spec.params[i])) {
        fail(
          spec,
          `ownership.args[${i}] is "consumes" but parameter ${i} is not a handle ` +
            "(only a JSValue carries a reference that could be transferred).",
        );
      }
    }
    args = [...given];
  }

  if (hasHandleResult && declared.result === "none") {
    fail(spec, 'ownership.result is "none" but the import returns a handle-typed result.');
  }
  if (!hasHandleResult && declared.result !== "none") {
    fail(
      spec,
      `ownership.result is "${declared.result}" but the import returns no handle ` +
        `(results: ${spec.results.map((r) => ("address" in r ? r.address : r.kind)).join(", ") || "none"}).`,
    );
  }

  return {
    args,
    result: declared.result,
    // Conservative toward `true` — see the header note on derived axes.
    throws: declared.throws ?? true,
    releasesContainerSlots: declared.releasesContainerSlots ?? true,
    handleParams,
  };
}

/**
 * Validate a whole import table up front, so a missing annotation is one loud
 * error at declaration time rather than a surprise in the middle of lowering.
 *
 * Scope note (a refinement of the issue's wording, recorded because it is
 * load-bearing): the rule applies to every import that TRAFFICS IN HANDLES.
 * An import with no JSValue in its signature — `int c_double(int)` — owns
 * nothing, and demanding an annotation there would be noise that trains people
 * to write one without thinking, which is worse than not asking.
 */
export function requireOwnershipAnnotations(specs: readonly ExternCImportSpec[]): Map<string, ResolvedOwnership> {
  const out = new Map<string, ResolvedOwnership>();
  for (const spec of specs) {
    const resolved = resolveImportOwnership(spec);
    out.set(`${spec.module}.${spec.name}`, resolved);
    out.set(spec.name, resolved);
  }
  return out;
}
