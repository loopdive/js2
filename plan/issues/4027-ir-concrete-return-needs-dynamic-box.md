---
horizon: m
id: 4027
title: "ESLint frontier: ir/from-ast 'concrete return needs a dynamic box' aborts the compile"
status: done
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-01
assignee: ttraenkler/claude
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, ir
language_feature: type-mapping
goal: npm-library-support
sprint: 78
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2855, 3672, 4001, 4018, 4019]
---

# #4027 — `concrete return needs a dynamic box in getPlaceholderMatcher`

## Problem

One of the two hard errors now blocking the ESLint `linter.js` graph, reachable
only after #4001, #4018 and #4019:

```text
Codegen error: IR path failed for getPlaceholderMatcher:
ir/from-ast: concrete return needs a dynamic box in getPlaceholderMatcher
[IR-FALLBACK]
```

## Why it is FATAL rather than a fallback

The `[IR-FALLBACK]` suffix is misleading. `formatIrPathFallbackDiagnostic`
(`src/codegen/index.ts`) classifies a failure as **hard** when
`err.outcome.kind === "invariant"`, and this one is an invariant — so instead of
demoting to the legacy path it aborts the entire compile.

Two separable questions, and they should not be conflated:

1. **Should this be an invariant at all?** If the IR genuinely cannot lower this
   return shape, demoting to legacy is the documented behaviour of the IR
   overlay (see the IR fallback budget in `CLAUDE.md`), and a whole-program
   abort for one function is disproportionate.
2. **The underlying gap** — a function returning a concrete value where the IR
   requires a dynamically boxed one, with no boxing inserted.

Fixing (1) alone would unblock the graph but silently widen the legacy surface,
which #2855 is actively trying to shrink; it should be a deliberate decision,
recorded, not a side effect.

## Acceptance criteria

- A reduced fixture reproduces the invariant without ESLint.
- An explicit decision on (1), recorded here with reasoning — demote to
  warning, or keep fatal and fix the lowering.
- If the lowering is fixed: the concrete→dynamic boxing is inserted and the
  function is IR-emitted, with the IR fallback baseline updated if any bucket
  moves.
- ESLint `linter.js` advances past this diagnostic.

## Root cause (2026-08-01) — a classification bug, not a lowering gap

`classifyIrFailure` (`src/ir/outcomes.ts`) is explicit: *"Preserve a typed
failure; unknown throws are compiler invariants."* An untyped `Error` becomes
`kind: "invariant", code: "unexpected-internal-throw"`, and
`formatIrPathFallbackDiagnostic` reports any invariant as a **hard** error.

`coerceReturnValue` threw a **plain `Error`** while its own doc comment
described the intent as *"throw a clean 'not in slice' fallback … Deferring
mirrors the existing numeric-throw deferral in `lowerThrowStatement`"*. So the
documented demotion became a whole-compile abort.

The deferral it claims to mirror had the identical defect. Measured on the
unfixed base — four lines of ordinary TypeScript that did not compile at all:

```ts
export function f(): number { throw 42; }
```

```text
Codegen error: IR path failed for f: ir/from-ast: throw of numeric type (f64)
not in slice 9 (f) [IR-FALLBACK]
… [unexpected-internal-throw; …]
```

Note the contradiction in one line: a message reading **"not in slice 9"**
classified as **"unexpected-internal-throw"**.

This is the **sixth** recorded instance of this exact mistake — #3565 documents
four, #3784 a fifth, each with the same shape: a documented demote site
throwing an untyped `Error`.

## Fix

Three sites in `src/ir/from-ast.ts` now throw `IrUnsupportedError`:

- `coerceReturnValue`'s dynamic-box deferral → `return-type-legacy-coupling`
  (the existing code for the verify-side half of the same #1798 return-value
  concern),
- `lowerThrowStatement`'s two "not in slice 9" arms → a new
  `throw-statement-unsupported`.

Answering question (1) from the original write-up: **these should never have
been invariants.** No fallback surface is widened — the affected functions were
not compiling by *any* path before, they were killing the whole compile. So this
does not work against #2855; it restores the behaviour #2855 measures against.

## Scope — what is NOT done

`src/ir/from-ast.ts` still contains **~194 other bare `throw new Error(...)`
sites**, against 46 typed ones. An unknown number are deferrals carrying the
same latent defect, each a hard compile failure waiting for the right input.
They were **not** audited. A systematic pass — or a lint rule forbidding untyped
throws in `from-ast.ts` — is the durable fix and needs its own issue.

## Verification

`tests/issue-4027-ir-deferrals-demote-not-abort.test.ts` — 3 passed with the
fix, **3 failed on the unfixed base**. Rungs assert behaviour (no hard error,
`success`, non-empty binary, and the demoted function still returns the right
value) rather than error text, and additionally assert the demotion stays
VISIBLE as a warning so IR coverage gaps do not become silent.

A fourth rung was drafted for the sibling bare-`throw` arm and **removed**:
`throw;` is a SyntaxError in JavaScript, so no valid source reaches it, and the
rung compiled an unrelated construct and passed on both sides. It is called out
in the test file so nobody re-adds it.

ESLint `linter.js` advanced past this diagnostic.
