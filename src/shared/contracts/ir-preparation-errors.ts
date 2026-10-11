// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type {
  IrPreparationStage,
  IrUnsupportedCode,
  IrInvariantCode,
  IrPreparationFailure,
} from "./ir-preparation-failure.js";

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
