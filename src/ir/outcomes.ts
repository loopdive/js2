// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Typed terminal outcomes for the AST -> IR preparation boundary.
 *
 * Diagnostic text is deliberately not policy-bearing. Callers decide whether
 * a unit may retain its legacy body from the discriminant and stable code; the
 * detail remains available only to make failures actionable.
 */
import type { IrFallbackReason } from "./select.js";
import type { IrSourceId, IrUnitId } from "./identity.js";

export type IrPreparationStage = "select" | "resolve" | "build" | "verify" | "lower" | "backend-legality" | "patch";

export type IrUnsupportedCode =
  | IrFallbackReason
  | "anonymous-class"
  | "static-class-initialization"
  | "void-call-expression"
  | "array-representation-unsupported"
  | "nullish-value-unsupported"
  | "operand-coercion-unsupported"
  | "property-write-unsupported"
  // (#680) A method call whose receiver/method the IR method-call lowering does
  // not yet handle (`.m(...) on <type> not in slice 4`) — the sibling of
  // `property-write-unsupported`. A not-yet-adopted construct, NOT a bug, so it
  // demotes to the legacy path as a warning; it must NOT fall into the untyped
  // `unexpected-internal-throw` invariant (which #3341/#3519 hard-error).
  | "method-call-unsupported"
  // (#4502) The READ sibling of `property-write-unsupported`: a `.p` access on
  // a receiver/property shape the IR property-access lowering does not yet
  // cover (a receiver IrType outside slice 2, an object/class shape with no
  // such field, an extern class with no registered property). The write side
  // and the method-call side each already had a code; the read side did not,
  // so its arms threw a bare `Error` and hard-failed a CLAIMED unit. The ONLY
  // new code added by the #4502 sweep — every other converted arm reuses an
  // existing sibling code.
  | "property-access-unsupported"
  // (#3565) Three DESIGNED demote-to-legacy sites that #3341/#3519 silently
  // promoted to hard `invariant` compile errors, contradicting their own
  // documented "clean throw → legacy" / "demotes the function to legacy"
  // contracts. Typed distinctly so they demote (warning → legacy body) while a
  // GENERIC `invariant` (a real builder↔finalize desync / invalid-Wasm emission,
  // the class #3341 rightly hard-fails) stays a hard error:
  //   - `element-store-unsupported`  — `lowerElementStore` TypedArray-view / packed
  //     receiver (from-ast.ts): the per-view value conversions are legacy-only.
  //   - `element-access-unsupported` — `lowerElementAccess` slice-12 residual
  //     (from-ast.ts): element read on a receiver/index shape not yet in IR scope.
  //   - `return-type-legacy-coupling` — the verify.ts #1798 return-value gate:
  //     a return/early.return whose value type or arity would emit invalid Wasm;
  //     the gate exists PRECISELY to demote to the legacy body (see verify.ts).
  //   - `compound-assign-unsupported` — `x += v` on an f64 slot whose RHS lowers
  //     to a non-f64 (e.g. an externref generator value): the numeric coercion
  //     is legacy-only. Measured casualty: tests/issue-2079 (a for-of over a
  //     generator, `s += v`) hard-erroring where legacy compiles+runs (=3).
  // A FIFTH site in this same class, found 2026-07-29 (#3784):
  //   - `unboxed-number-local-unprovable` — the #2782/#2790 no-box NUMBER-local
  //     proof gate in `lowerVarDecl` (from-ast.ts). Its own comment states the
  //     contract: "anything unprovable — `any` / `unknown` / a MIXED
  //     `number | string` union — demotes to the SAFE boxed legacy lowering".
  //     It threw a PLAIN `Error`, so `classifyIrFailure` bucketed it as
  //     `unexpected-internal-throw` and the documented demotion became a hard
  //     compile error. Latent until #3783 adopted function-local `var`s into the
  //     IR path: that made the selector CLAIM functions whose locals reach this
  //     gate, so `function g(s){ var c = s.charCodeAt(0); return f(c); }` — an
  //     `any`-typed receiver, i.e. ordinary untyped JS — stopped compiling at
  //     all (empty binary) on every target. `let` was equally affected.
  | "unboxed-number-local-unprovable"
  // (#4035) Two MORE sites in the same #3565/#3784 class, found 2026-08-02 while
  // the #3008 fix-on-touch ratchet surfaced `tests/issue-2877.test.ts` (rotted
  // 3/7 red on main — untouched root tests never run at PR time, so nothing
  // reported it). Both are DESIGNED demotes whose own comments say so, and both
  // threw a PLAIN `Error`, so `classifyIrFailure` bucketed them as the untyped
  // `unexpected-internal-throw` invariant and the documented demotion became a
  // hard compile error on every target:
  //   - `throw-value-unsupported`   — `lowerThrowStatement` (from-ast.ts). Its
  //     own comment: "Slice 9 defers — fall back to legacy by throwing here so
  //     the function compilation aborts cleanly and the legacy path takes
  //     over." Covers the numeric (`throw 42`) and bare-`throw` arms.
  //   - `unknown-class-construction` — the `new X(...)` arm of from-ast.ts with
  //     neither a class shape nor extern metadata. `KNOWN_EXTERN_CLASSES`
  //     (select.ts) states the contract for its own deliberate over-claim: "the
  //     actual lowering throws cleanly if the resolver doesn't carry metadata
  //     for the class, falling the function back to legacy via `safeSelection`".
  //     Measured casualty: `throw new SyntaxError("…")` — SyntaxError is
  //     selector-claimed but carries no metadata (TypeError/RangeError are
  //     selector-REJECTED, which is why only some error classes broke).
  | "throw-value-unsupported"
  | "unknown-class-construction"
  | "element-store-unsupported"
  | "element-access-unsupported"
  | "return-type-legacy-coupling"
  | "compound-assign-unsupported"
  | "string-evidence-unsupported"
  | "type-resolution-unsupported"
  | "imported-call-planning-unsupported"
  | "late-preparation-unsupported"
  | "timer-component-not-isolated"
  // (#3536) The IR-lowered function's interned typeIdx differs from the
  // collect-time registered signature that legacy-compiled callers already
  // baked their call-argument coercions against (e.g. an implicit-`any`
  // param call-site-narrowed to a shape struct that the IR re-types as
  // externref). Patching would strand those callers on a stale ABI —
  // invalid Wasm or silent null/undefined params — so the claim is
  // withdrawn and the legacy body kept.
  | "abi-signature-parity"
  | "new-target-threading"
  | "static-class-member"
  | "module-init-legacy-coupling";
export type IrInvariantCode =
  | "unknown-function-ref"
  | "unknown-global-ref"
  | "unknown-type-ref"
  | "verifier-failure"
  | "backend-legality-failure"
  | "missing-function-slot"
  | "unpatched-slot"
  | "abi-type-index-mismatch"
  | "selection-preparation-mismatch"
  | "type-map-failure"
  | "duplicate-unit-outcome"
  | "missing-terminal-outcome"
  | "allocation-provenance-failure"
  | "tagged-union-validation-failure"
  | "synthetic-owner-missing"
  | "pass-output-mismatch"
  | "unexpected-internal-throw";

export type IrPreparationFailure =
  | {
      readonly kind: "unsupported";
      readonly code: IrUnsupportedCode;
      // (#3565) "verify" added: the #1798 return-value gate is a DESIGNED
      // demote-to-legacy that legitimately produces an `unsupported` outcome at
      // the verify stage (see verify.ts / integration-report.ts).
      readonly stage: "select" | "resolve" | "build" | "verify";
      readonly detail: string;
      readonly cause?: unknown;
    }
  | {
      readonly kind: "invariant";
      readonly code: IrInvariantCode;
      readonly stage: Exclude<IrPreparationStage, "select">;
      readonly detail: string;
      readonly cause?: unknown;
    };

export class IrUnsupportedError extends Error {
  readonly kind = "unsupported" as const;

  constructor(
    readonly code: IrUnsupportedCode,
    readonly stage: "select" | "resolve" | "build",
    detail: string,
    readonly cause?: unknown,
  ) {
    super(detail);
    this.name = "IrUnsupportedError";
  }
}

export class IrInvariantError extends Error {
  readonly kind = "invariant" as const;

  constructor(
    readonly code: IrInvariantCode,
    readonly stage: Exclude<IrPreparationStage, "select">,
    detail: string,
    readonly cause?: unknown,
  ) {
    super(detail);
    this.name = "IrInvariantError";
  }
}

/**
 * (#4035) Throw a DESIGNED demote-to-legacy at a build-stage site.
 *
 * Lives here rather than at the call sites because `src/ir/from-ast.ts` is a
 * god-file pinned at its LOC ceiling, and because the whole point of this
 * helper is that the demote must be TYPED: a plain `throw new Error` is
 * classified as `unexpected-internal-throw`, which #3341/#3519 hard-error, so
 * the documented "clean throw → legacy" contract silently became a compile
 * failure. Always use this rather than a bare `Error` for a not-yet-adopted
 * construct.
 *
 * (#4502) That advice used to be enforced only site by site, and the same bug
 * was rediscovered every time an adoption WIDENED the selector's claim set:
 * an arm that had never been reachable on a claimed unit suddenly was, and its
 * bare `Error` took the whole function down instead of demoting. It fired four
 * times on 2026-08-15 alone (#4578 string slice-1 arms, #4486 prepared-vec
 * allowlist, #4487's three `lowerArrayLiteral` shapes, plus two more observed
 * sites). #4502 therefore swept `src/ir/from-ast.ts` and the build-stage
 * lowering helpers it dispatches into wholesale: every arm was classified
 * CAPABILITY GAP (legit JS the IR cannot lower yet -> `demoteToLegacy`) or
 * PRODUCER PROMISE (a plan/helper/selector contract violation -> stays a bare
 * `Error`, i.e. `invariant`, and now carries an `// invariant
 * (producer-promise):` comment naming the promise). A new bare `Error` in
 * those files is therefore a deliberate invariant claim, not an oversight.
 */
export function demoteToLegacy(code: IrUnsupportedCode, detail: string): never {
  throw new IrUnsupportedError(code, "build", detail);
}

/** Preserve a typed failure; unknown throws are compiler invariants. */
export function classifyIrFailure(error: unknown, stage: Exclude<IrPreparationStage, "select">): IrPreparationFailure {
  if (error instanceof IrUnsupportedError) {
    return {
      kind: "unsupported",
      code: error.code,
      stage: error.stage,
      detail: error.message,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    };
  }
  if (error instanceof IrInvariantError) {
    return {
      kind: "invariant",
      code: error.code,
      stage: error.stage,
      detail: error.message,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    };
  }
  return {
    kind: "invariant",
    code: "unexpected-internal-throw",
    stage,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

export type IrObservedUnitKind = "function" | "class-member" | "module-init";
export type IrObservedBackend = "wasmgc" | "linear";
export type IrObservedTarget = "gc" | "linear" | "standalone" | "wasi";

interface IrObservedOutcomeBase {
  /** Observational label only. R1 replaces this with source-qualified identity. */
  readonly key: string;
  /** R1 structural source identity. Compiler-produced rows always populate it. */
  readonly sourceId?: IrSourceId;
  /** R1 structural terminal-unit identity. Compiler-produced rows always populate it. */
  readonly unitId?: IrUnitId;
  readonly file: string;
  readonly unitKind: IrObservedUnitKind;
  readonly displayName: string;
  readonly ordinal: number;
  readonly line: number;
  readonly column: number;
  readonly backend: IrObservedBackend;
  readonly target: IrObservedTarget;
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
  /** R2 component whose ABI was dependency-derived and sealed before lowering. */
  readonly preparedComponentId?: string;
}

export type IrObservedOutcome =
  | (IrObservedOutcomeBase & {
      readonly kind: "emitted";
      readonly stage: "patch";
    })
  | (IrObservedOutcomeBase & IrPreparationFailure);

export type IrOutcomePolicy = "hybrid" | "ir-only";

export interface IrOutcomePolicyVerdict {
  readonly policy: IrOutcomePolicy;
  readonly ready: boolean;
  readonly blockers: readonly IrObservedOutcome[];
}

/** Evaluate policy over the exact observed ledger; never re-run selection. */
export function evaluateIrOutcomePolicy(
  outcomes: readonly IrObservedOutcome[],
  policy: IrOutcomePolicy,
): IrOutcomePolicyVerdict {
  const blockers = outcomes.filter((outcome) => {
    if (outcome.kind === "invariant") return true;
    // The discriminant and body evidence are one contract. Hybrid may retain
    // a typed Unsupported unit only when its direct body actually exists; an
    // unsupported skipped slot has no executable implementation to fall back
    // to. Likewise, an emitted row without an IR body (or a non-emitted row
    // claiming one) is malformed evidence and must fail both policies.
    if (outcome.kind === "emitted" && !outcome.irBodyEmitted) return true;
    if (outcome.kind !== "emitted" && outcome.irBodyEmitted) return true;
    if (outcome.kind === "unsupported" && !outcome.legacyBodyEmitted) return true;
    if (policy === "hybrid") return false;
    return outcome.kind === "unsupported" || outcome.legacyBodyEmitted || !outcome.irBodyEmitted;
  });
  return { policy, ready: blockers.length === 0, blockers };
}
