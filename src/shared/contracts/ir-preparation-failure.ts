// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * #1169q telemetry — record why a top-level FunctionDeclaration didn't make
 * it into the IR claim set. The intent is to drive the legacy retirement:
 * once the count of unintended fallbacks (excluding deferred features) is
 * zero against the test262 corpus, the legacy expression / statement
 * emitters can be retired.
 */
export type IrFallbackReason =
  | "unnamed"
  | "type-parameters"
  | "non-export-modifier"
  | "async-generator"
  // (#1373) `async function` (without an asterisk) — distinguished from
  // `async-generator` (`async function*`) and from generic
  // `non-export-modifier` / `deferred-feature` so the IR-claim gate can
  // conditionally accept async functions when the standalone
  // `$Promise` + microtask-queue infra (#1326) is fully wired. Phase A
  // (this slice) just buckets them; Phase C wires the lowering.
  | "async-function"
  | "return-type-not-resolvable"
  | "param-type-not-resolvable"
  | "param-shape-rejected" // optional/rest/initializer/non-identifier/duplicate
  // #1372 — binding-pattern param shape too complex for slice 8a destructuring
  // (rest, defaults, nested patterns, computed keys). Distinguished from
  // `param-shape-rejected` so the param-shape bucket continues to track only
  // optional/rest/initializer/duplicate cases.
  | "destructuring-param-complex"
  | "body-shape-rejected"
  // #3529 P1 — checker/syntax-known producer gaps. These are selector-owned
  // Unsupported outcomes: the legacy body is intentionally retained before
  // AST -> IR construction starts, rather than relying on a builder throw.
  | "string-method-unsupported"
  | "array-method-unsupported"
  | "primitive-method-unsupported"
  | "function-invocation-method-unsupported"
  | "logical-value-unsupported"
  | "operand-coercion-unsupported"
  | "template-substitution-unsupported"
  | "error-constructor-unsupported"
  | "typed-array-constructor-unsupported"
  | "date-constructor-unsupported"
  | "regexp-constructor-unsupported"
  | "call-resolution-unsupported"
  | "call-arity-unsupported"
  | "constructor-resolution-unsupported"
  | "constructor-arity-unsupported"
  | "class-projection-unsupported"
  | "class-member-unsupported"
  | "external-call" // calls a non-local identifier (parseInt, etc.)
  | "call-graph-closure" // local caller/callee not claimed
  | "recursive-type-evidence" // recursive SCC failed conservative ABI certification
  | "type-resolution-failure" // overrideMap couldn't be built (set externally)
  // #1370 Phase A — class method / constructor of a shape the IR selector
  // doesn't yet handle. Examples: methods on a class with an `extends`
  // clause (Phase E — inheritance), get/set accessors, abstract methods,
  // computed property names. Distinguished from `body-shape-rejected` so a
  // future slice can tell "method-specific gate failure" apart from generic
  // body-shape rejections that apply to top-level FunctionDeclarations too.
  | "class-method"
  | "string-builder-candidate" // (#3740/#3744) kill-switch-forced legacy — see ./string-builder-shape.ts
  // (#4457) The unit references an ambient HOST surface (`document`, `console`,
  // `window`, …) in a target whose capability policy has no ambient JS host:
  // standalone / wasi / strictNoHostImports, i.e. `hostExternCapability` →
  // "defer". The label names the MECHANISM (the IR's host-extern surface is
  // capability-deferred for this target), which is why it is not
  // `body-shape-rejected`: no amount of IR *shape* coverage claims these, and
  // bucketing them as *unintended* overstated what shape work could fix by 6
  // of 11 units on the #3518 standalone reference corpus.
  //
  // The bucket held two kinds of member. One has since been retired:
  //   - PERMANENT here: DOM (`document.*`). Legacy's own `--target standalone`
  //     body for those units still leaks `env.Document_createElement`,
  //     `env.Node_appendChild` & co. past the #2961 import-leak gate, so there
  //     is genuinely nothing host-free to lower to.
  //   - RETIRED (#4462): `console.*`. Standalone always had a host-free sink
  //     (`__stdout_append` / `ensureStandaloneStdoutSink`, #3469) that legacy
  //     uses; the IR's console arm knew only the host-import form. It now has
  //     its own capability row (`consoleSurfaceCapability`) and a host-free
  //     lowering, so a `console.*` unit is claimed rather than bucketed here.
  //     A console call STILL lands here when this target has no sink at all, or
  //     when the call shape is outside the lowered slice (multi-arg, expression
  //     position, a method the IR does not lower) — a pre-claim rejection, which
  //     is the point: the alternative is a post-claim demote.
  | "host-surface-unavailable"
  | "deferred-feature";

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
  /** Exact production body receipts were absent, foreign, duplicated, or impossible. */
  | "body-emission-evidence"
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
