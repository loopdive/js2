---
id: 4302
title: "Async CPS: support the await-inside-try shapes used by Prettier, Axios, and Stylelint"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: async, promises, try-catch
goal: npm-library-support
related: [1032, 1034, 3587, 4000]
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/async-cps.ts::planTryCatchCfg
  - src/codegen/async-cps.ts::buildBody
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/async-frame.ts::buildStateBody
  - src/codegen/async-frame.ts::collectNestedRefsAndAssigns
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
---

# Support residual package `await`-inside-`try` shapes

## Problem

#3587 correctly removed a silent miscompile: async bodies the host-drive engine
cannot represent now fail loudly instead of dropping awaited rejections. Three
real package entries have reached that deliberate refusal and need an
additional generic CFG shape, not a package rewrite or a suppressed diagnostic.

| package | exact command | measured result |
| --- | --- | --- |
| Prettier | `node tests/dogfood/prettier-harness.mjs --json` | 24.907 s; two #3587 diagnostics; no binary |
| Axios | `node tests/dogfood/npm-compat-catalog-harness.mjs --package axios --json` | 13.617 s; one #3587 diagnostic; no binary |
| Stylelint | `node tests/dogfood/npm-compat-catalog-harness.mjs --package stylelint --json` | 82.319 s; five #3587 diagnostics plus the separate #4303 TDZ error; no binary |

The original direct Axios `compileProject` probe located only line 219, column
32 because backend diagnostics dropped the source filename. The diagnostic
provenance slice below closes that observability gap and maps the declarations.

## Diagnostic provenance slice (2026-08-11)

The first implementation slice carries the source filename from `CodegenError`
through `CompileError` and preserves filename, line, column, and severity in the
out-of-process package probe. This is diagnostic-only: it does not weaken the
#3587 refusal or change executable behavior.

The exact current package sites are now visible:

| package | rejected source sites |
| --- | --- |
| Prettier 3.8.1 | bundled `standalone.mjs:21:121` (`await u.parse(...)` in `try/catch`) and `standalone.mjs:22:472` (`await c(...)` in a loop-nested `try/catch`) |
| Axios 1.16.1 | `lib/adapters/fetch.js:219:32` (`const outboundLength = await resolveBodyLength(...)` inside an `if` nested in the adapter's `try/catch`) |
| Jest | `@jest/core/build/index.js:1562:7` (`runWatch`, `await` inside an `if` nested in `try/catch`) |
| Stylelint | `@sindresorhus/merge-streams/index.js:97:3`, `:135:3`; `globby/utilities.js:244:18`; `globby/ignore.js:645:13`, `:700:51` |

The two `merge-streams` sites are canonical top-level `try/finally` awaits.
The remaining sites exercise awaits below conditions/loops or nested in return
and assignment expressions. This split gives the lowering work a generic,
small first target while keeping the more complex residuals loud.

## Suspended handoff (2026-08-09)

The investigation worktree `/private/tmp/js2-async-try-packages-20260809` on
`codex/3587-async-try-packages-20260809` is clean at
`7a50f7fd9a34fd`; it has no tracked edits or commits. No generic lowering was
attempted before suspension.

The likely decision points are `lowerChunk`/`lowerRegionBody` in
`src/codegen/async-cps.ts` and `computeTryCatchSpills` plus host eligibility in
`src/codegen/async-frame.ts`. Resume by retaining source locations in the
diagnostic (or instrumenting the activation decision), mapping the rejected
declarations, and reducing the smallest shared shape. #3587 stays complete:
this issue owns the additional supported shape while preserving #3587's loud
refusal for everything still outside the machine.

## Acceptance criteria

- [x] Every rejected suspension point reports its source file and location.
- [x] Reduced tests cover the shared package shape and rejection delivery
      through `catch`/`finally` on the host lane.
- [ ] Prettier, Axios, and Stylelint advance beyond this refusal without source
      rewriting or a synchronous fallback.
- [x] Any still-unsupported rejection-sensitive shape continues to fail loudly.

## Implementation update (2026-08-13)

The generic structured-CFG implementation now covers assignment awaits,
multiple/conditional declarators, ordinary `for..of` across a suspension, and
nested lexical catch bindings. Promise combinators retain their legacy shortcut
only when there is no finalizer, so `try/finally` still genuinely suspends.

The package run also exposed three independent representation bugs that are
fixed in the same slice:

- optional string calls pad omitted positional arguments;
- contextual tuple inference is retained for concise closure returns;
- async spill fields use the concrete nested-capture cell ABI chosen by the
  just-completed function hoist, including destructured locals.

Destructured lexical bindings are now visible during the TDZ/function hoist,
and local compaction visits shared instruction objects once. The latter avoids
applying a non-idempotent old-to-new local remap twice when an instruction
fragment is reused by two control-flow arms.

Measured pinned Prettier 3.8.1 result:

| metric | result |
| --- | --- |
| command | `node --import tsx tests/dogfood/prettier-harness.mjs --json` |
| compile | success, 0 diagnostics, 106.768 s |
| binary | 7,610,691 bytes |
| validation | valid |
| runtime differential | not implemented by the existing Prettier harness |

This proves package-entry compilation and binary validity. Correctness remains
unverified until Prettier gets a real differential workload; the issue must not
claim runtime compatibility from validation alone.

The same exact-head audit shows the remaining boundary honestly:

- Jest 30.4.2 clears the #3587 refusal and compiles in 33.313 s, then exposes a
  separate invalid `struct.new` in `runJest.ts`.
- Axios 1.16.1 still stops at `lib/adapters/fetch.js:219:32`; that nested
  conditional assignment shape remains outside this CFG slice and continues to
  fail loudly as required.

## Merge-group regression follow-up (2026-08-13)

The first merge-group run exposed several frame-representation regressions. Async
spill inference had reused the activating local type for every binding, even
though ordinary numeric locals can be retyped while the resume frame retains
their declared representation. Live local types are now reused only for
destructuring or names referenced by a nested scope. Nested capture arguments
also resolve through the synthetic resume frame's live `localMap`, rather than
slot numbers recorded against the original activation frame. Read-only
property-derived callables stay by-value so ref-cell boxing does not change
their host `.call`/rejection behavior.

Assignment awaits that reuse one nested function value across two suspension
segments remain on the legacy lane. The nested function's memoized closure is
an activation local and cannot yet survive resume-function reinvocation; moving
that memo into the async frame is a follow-up. The conservative gate preserves
the pre-slice behavior instead of manufacturing a second closure or trapping at
the host constructor boundary.

The authoritative retry then found two additional capture-ABI regressions that
the original four-case probe did not cover:

- `Array.fromAsync/async-iterable-input.js` changed from pass to an empty output
  array because the outer frame boxed `expected`, while the nested host async
  generator still consumed its capture by value. Async-generator declarations
  are now excluded from the named-function cell remap; the exact test passes
  again with the same Wasm hash as current main (`aa2f98495405`).
- `AsyncDisposableStack.prototype.move` grew an `illegal_cast` trap because
  read-only arrow captures were boxed even though anonymous closures retain a
  by-value capture ABI. Read-only cell remapping is now limited to ordinary
  named function declarations; mutable captures still use cells. The exact
  test remains a known baseline failure but no longer traps, so the uncatchable
  trap category does not grow.

Focused runtime tests lock both distinctions: ordinary named-function captures
still remap through the synthetic resume frame, while read-only arrow and async
generator captures remain by-value.
