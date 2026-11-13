---
id: 7091
title: "IR: claim and lower host-extern (DOM/declared-class) calls under native strings in a JavaScript environment"
status: done
created: 2026-10-19
updated: 2026-10-19
completed: 2026-10-19
assignee: ttraenkler/opus-7091-ir-dom
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: current
parent: 5385
related: [6708, 6979, 3214, 1376]
# 2026-10-19 (#7091): the platform-extern lane threads one predicate through
# the IR projection (planIrOverlay), the selector's host-global arm, the
# from-ast host-extern arms + the from-ast resolver, the extern position-type
# arm and the multi-source imported-call surface. Each site grows by a guard
# line or a short helper; the predicate itself lives in src/ir/host-extern.ts.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/codegen/index.ts
  - src/codegen/extern-declarations.ts
  - src/ir/integration.ts
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/select.ts::isPhase1Expr
import-cycles-allow:
  - codegen->ir: 300 # 2026-10-19 (#7091, measured against upstream main c81913c1f2): ir-overlay-finalize.ts and multi-prepared-callable-orchestration.ts import the lane predicate from src/ir/host-extern.ts (a leaf), so the callback finalizer and the callable-component census answer the same lane question as the selector
---

# #7091 — IR host-extern lowering with native strings

Found during the #6708 flip (2026-10-16). The IR path has never claimed or
lowered calls to host externs (DOM capabilities such as `document`,
`CSSStyleDeclaration`, and user `declare function` imports) when the
module uses native strings: production selection sets `jsHostExterns =
irTargetProfile.allowHostImports`, which the regime projects as false, and
every IR host-extern switch is also gated `&& !ctx.nativeStrings`
(`allowHostExterns`/`allowBuiltinMapExtern`, `supportsHostPromiseDelay`,
`resolveAmbientClassCall` in `src/codegen/index.ts`; `jsHostExterns()` in
`src/ir/integration.ts`; six DOM arms in `src/ir/from-ast.ts`). With
`trackIrOutcomes`, the playground benchmark's `el`, `bench_dom` and `main`
are rejected at select with `host-surface-unavailable` and `bench_style`
follows as `call-graph-closure`. This is not regime-specific:
`host-assisted` + fast strings declines the same functions.

Consequence today: on the default (regime) build those functions compile
through the legacy direct-AST path, which still works, so the IR-fallback
gate's `#3214 A+B1` invariant (`benchmarks.ts::main` emitted through IR)
is measured with the explicit `host-assisted` spelling
(`scripts/check-ir-fallbacks.ts`, decision (B) in the #6708 checkpoint).
S7-a (#6979) deletes that spelling, so this issue is an entry condition for
the gate to keep measuring production.

## Plan

1. Measure: the exact IR rejection reasons for the 13 playground examples
   and the equivalence-suite programs that declare host functions or touch
   DOM, under the default profile (`trackIrOutcomes`), and the
   `check:ir-fallbacks` bucket counts.
2. Lower host-extern calls in the IR under native strings in a JavaScript
   environment: string and closure arguments cross as carriers that the
   runtime's platform-arg marshal (`src/runtime/platform-arg-marshal.ts`,
   from #6708) converts; results come back through the value adapter.
   Touches `src/ir/select.ts`, `src/ir/from-ast.ts`, `src/codegen/index.ts`
   (`jsHostExterns` projection), `src/ir/integration.ts`. Capability
   classification is unchanged (platform-capability).
3. Flip `scripts/check-ir-fallbacks.ts` back to the production profile and
   keep the `#3214 A+B1` invariant; bank the bucket decreases.
4. Acceptance: `check:ir-fallbacks` green on the default profile with
   `benchmarks.ts::main` IR-emitted; `tests/playground-example.test.ts` green;
   equivalence gate "No new equivalence regressions"; IR lowering tests for a
   DOM call with string + closure arguments under native-first. This is IR
   producer/lowerer work, which the direct-AST freeze explicitly allows.

## Implementation notes (2026-10-19)

### Measured before (upstream main c81913c1f2, default profile, `trackIrOutcomes`)

Per-function terminal outcome for the 13 `website/playground/examples/*.ts`
(entry compiled with `compileFiles`, so `helpers.ts` rows appear under every
benchmark entry; listed once):

| Entry | IR-emitted | Not emitted (stage/code) |
| --- | --- | --- |
| benchmarks.ts | bench_array, fib, bench_fib, bench_loop, bench_string | bench_dom, bench_style, main: select/host-surface-unavailable |
| benchmarks/helpers.ts | — | el: select/host-surface-unavailable; bcrd: select/call-graph-closure; addBenchCard: select/body-shape-rejected |
| benchmarks/array.ts | bench_array | main: select/host-surface-unavailable |
| benchmarks/dom.ts | — | bench_dom, main: select/host-surface-unavailable |
| benchmarks/fib.ts | fib, bench_fib | main: select/host-surface-unavailable |
| benchmarks/loop.ts | bench_loop | main: select/host-surface-unavailable |
| benchmarks/string.ts | bench_string | main: select/host-surface-unavailable |
| benchmarks/style.ts | — | bench_style, main: select/host-surface-unavailable |
| dom/calendar.ts | mname, dimOf, fdow, priceOf | el, main: select/host-surface-unavailable; renderCal, onDay, updFoot: select/body-shape-rejected; module-init: constructor-resolution-unsupported |
| js/algorithms.ts | fibIter, binarySearch, quicksort, joinNums | fibMemo: body-shape-rejected; main: host-surface-unavailable (`console`) |
| js/async.ts | — | delay: constructor-resolution-unsupported; 4× async-function |
| js/builtins.ts | — | el, main: host-surface-unavailable; crd, rw: call-graph-closure |
| js/classes.ts | — | 10 class members: resolve/late-preparation-unsupported; main: host-surface-unavailable (`console`) |

`host-assisted` + `nativeStrings: true` claims the same DOM functions at
select (its `jsHostExterns` is true) and then fails every one at build with
`operand-coercion-unsupported` ("arg 0 of Document.createElement expects
externref but got string") — the string carrier had no crossing.

Equivalence suite: 2 of the 2,027 recorded sources declare host functions or
touch the DOM; all 14 of their units were already IR-emitted, before and
after.

`check:ir-fallbacks` (baseline: unintended none, deferred
`string-builder-candidate` 2):

| Production call | unintended | deferred | post-claim | `#3214 A+B1` |
| --- | --- | --- | --- | --- |
| before, `host-assisted` (committed spelling) | none | async-function 4, string-builder-candidate 2 | none | holds |
| before, default profile | none | async-function 4, string-builder-candidate 1 | none | **fails for all 7 benchmark entries** |
| after, default profile (committed) | none | async-function 4, string-builder-candidate 2 | none | holds for all 7 |

No bucket decreases against the baseline, so `--update-on-decrease` has
nothing to bank; `scripts/ir-fallback-baseline.json` is unchanged.

### Measured after (same table, default profile)

| Entry | IR-emitted | Not emitted |
| --- | --- | --- |
| benchmarks.ts | bench_array, fib, bench_fib, bench_loop, bench_dom, bench_string, bench_style, **main** | — (helpers below) |
| benchmarks/helpers.ts | — | el, bcrd: select/call-graph-closure; addBenchCard: select/host-surface-unavailable (`performance`) |
| benchmarks/array.ts | bench_array, **main** | — |
| benchmarks/dom.ts | **bench_dom, main** | — |
| benchmarks/fib.ts | fib, bench_fib, **main** | — |
| benchmarks/loop.ts | bench_loop, **main** | — |
| benchmarks/string.ts | **main** | bench_string: select/string-builder-candidate |
| benchmarks/style.ts | **bench_style, main** | — |
| dom/calendar.ts | unchanged 4 | el: call-graph-closure; main: body-shape-rejected (`nontail-assign-nonprop-lhs`); rest unchanged |
| js/builtins.ts | — | el, crd, rw: call-graph-closure; main: body-shape-rejected |
| js/algorithms.ts, js/async.ts, js/classes.ts | unchanged | unchanged (`console` stays off the lane) |

### What changed and why

The native regime projects `allowHostImports: false` — correctly, for
SEMANTIC host imports. The bug was that the IR read that one flag as "no
host externs at all", while legacy keeps the JS environment's platform
capabilities (#6708: `global_document`, `Document_createElement`, …) and the
runtime's platform-arg marshal converts their native-string / closure
carriers. The fix adds a second, narrower fact instead of widening
`jsHostExterns` (which also gates generators, host Promise delay, indirect
eval, host Date snapshots and the legacy-caller policy — all semantic):

- `irPlatformExternClassPredicate(lane)` (`src/ir/host-extern.ts`): on iff
  `nativeRegime && target gc && environment javascript && ambient-js &&
  hostValueInterop required (jsValueBoundary) && nativeStrings && !fast`;
  admits a class iff it is not an ECMAScript builtin
  (`isEcmascriptExternClass`, the set `classifyHostImport` already uses) and
  not `Console`. Standalone / WASI / host-assisted never see it, so their
  lanes are untouched.
- Selector: the host-global resolver is split by class AND by the names the
  lane registers (`isJsEnvironmentPlatformGlobalName` = legacy's
  `DOM_ONLY_GLOBALS`); everything else stays on the deferred resolver, so
  `console`'s host-free sink and `performance`'s honest
  `host-surface-unavailable` are unchanged. (Without the name filter
  `performance` was claimed and post-claim demoted: the regime lowers it
  natively and registers no `global_performance`.)
- from-ast: the five DOM arms assert `hostExternSurfaceAdmits(cx, class)`; a
  string argument / setter value crosses as `coerce.to_externref` (the
  existing `native-string` boundary, previously dom@1-only) and the
  `addEventListener` closure is passed as the packed carrier — exactly what
  the legacy body passes and what `marshalPlatformArgs` converts. No new
  host import: the import surface stays `platform-capability`.
- Extern position types (`: HTMLElement`) resolve on the lane, gated
  additionally on the type's own declarations not living in a `lib.es*`
  file, so `Function`/`String`/`PropertyDescriptor`-typed parameters can
  never enter the lane by name.
- `declare function` calls in class members (#3657 certification): a
  `string` param is planned as the externref carrier and coerced at the call;
  a `string` RESULT is refused at resolve (`imported-call-planning-unsupported`)
  because the IR has no extern→native-string carrier conversion.
- Multi-source: a source that names a platform global gets the certified
  imported-call surface its host-assisted twin has (early prepared routes and
  overlay loop alike, so both plan it identically); a certified imported
  higher-order call (`addBenchCard(..., bench_fib)`) stays on the imported
  plan instead of the fixed-target program-callable route, which has no
  function-argument carrier; and the callable-component census drops whole
  groups containing a platform-global owner (dropping a whole group equals
  the group never forming, so the census stays closed). Sources that touch no
  platform global keep their existing native-regime routes.
- `scripts/check-ir-fallbacks.ts` measures the default profile again.

### Byte identity

All 2,027 distinct `compile()` calls the equivalence suite makes were
recorded and compiled before/after under the recorded options and forced
`gc`, `standalone` and `wasi` targets: 7,656 binaries, 7,656 identical
sha256 digests.

### Left out (and why)

- `console` is not on the lane: it has its own host-free sink path on the
  regime; moving it would change every console-using binary.
- `helpers.ts::el/bcrd` stay legacy on the default profile: `addBenchCard`
  is not claimable (`performance`), and the regime's caller-direction policy
  (#4521, host-free lanes demote a claimed callee with a legacy caller)
  closes the component. Relaxing that policy is not platform-extern work.
- `string.ts::bench_string` moves from IR (the multi-source string-leaf
  route, which requires its function-value caller to stay legacy) to legacy,
  while `main` moves to IR — the `host-assisted` shape the gate measured
  before; the bucket equals the baseline.
- Module-scope extern bindings (`allowHostExterns` in the module-binding
  resolver) stay host-lane only: that flag also gates
  `supportsHostNumberToString`, a semantic host lane.
- Finding, not fixed here: on the regime a user `declare function` receives
  the raw native-string carrier (an opaque object) — legacy and IR alike —
  because `marshalPlatformArgs` wraps only `extern_class` imports. That is a
  runtime-marshal gap for #6708's follow-ups, not an IR one.
- Pre-existing: `tests/issue-3214-*.test.ts`, `issue-2856-*.test.ts`,
  `issue-3657.test.ts` carry host-lane expectations that already fail on
  upstream main under the native default; this change makes several of them
  pass and moves the two `__make_callback` cases to an explicit
  `host-assisted` profile (the maker import is the host lane's crossing).
- `tests/issue-3214-void-host-callback.test.ts` is fully green on the default
  profile (fix-on-touch, #3008). The rows asserting the B2 host-bridge shape
  (`i32.const -2` + `__make_callback`, the generic `__call_fn_*` bridges,
  listener return `undefined`, cross-overlay closure subtype naming) pin
  `semanticProviders: "host-assisted"` through one shared constant; S7 (#6979)
  retires the pin. "rejects non-void" was a real post-claim build demote in
  both lanes (bare closure reaching the extern arg coercion): the selector now
  declines an uncertified function argument to `addEventListener`
  (`call-resolution-unsupported` / `expr-host-callback-uncertified`).
- Finding, not fixed here: on the regime a marshalled void listener returns
  a null-prototype object instead of `undefined` (legacy and IR alike, via
  `_wrapWasmClosureUnknownArity`). Runtime-marshal gap for #6708 follow-ups.
