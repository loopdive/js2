---
id: 6781
title: "codegen: a generator whose consumer calls `.throw()`/`.return()` silently takes the eager host-buffer path — body and `finally` run at creation, `throw` escapes the generator's own `catch`"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6781"
branch: "claude/issue-6781-generator-eager-refuse"
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: generators
goal: generator-model
related: [1687, 1691, 1344, 2035]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H2"
# 2026-10-01 (#6781): the refusal lives in its own module; the collector gains
# only the one-line per-source call + import, and the eager runtime's
# return()/throw() each gain the field resets that complete the generator.
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
  - src/runtime/iterator-polyfills.ts
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
---

# #6781 — refuse, do not silently demote, generators that need `.throw()` / `.return()`

## Problem

#1687 records that the eager generator model cannot thread `.throw()` /
`.return()` into a `yield`. This issue is about what happens **today** when a
program does it anyway: the compiler silently falls back to the eager
host-buffer path and the program runs with different semantics.

Reproduced 2026-09-30 (JS-host lane):

| probe | wasm | JS |
|---|---|---|
| generator with `try { yield 1 } catch (e) { log("caught:" + e) }`, consumer calls `it.next(); it.throw("boom")` | `boom` escapes uncaught | `caught:boom`, then `{value:2,done:false}` … |
| `let created = 0; function* g() { created = 100; try { yield 1 } finally { created += 2 } }; const it = g();` then read `created` before `.next()` | `102` | `0` |
| `throw` after the first `yield`, consumer inside `try/catch` | raw `WebAssembly.Exception` escapes the caller's `catch` | caught |

## Root cause

`src/codegen/generators-native.ts:3780` gates the lazy lowering on
`resultConsumptionIsSafe`; when the consumer touches `next | return | throw`
in a way the gate does not accept, `:4302-4308` "falls to the eager-buffer
host path" — the whole body is executed at construction and buffered.
Nothing is reported: no warning, no error.

## Correction (this issue)

1. Make the fallback a **compile error** with a clear message
   (`generator-eager-unsupported: consumer calls .throw()/.return(); see #1687`),
   the same policy #3587 adopted for async shapes the lane cannot lower.
2. Keep the eager path only for generators whose consumption is provably
   `next()`-only (the current safe gate) — that path is observably correct
   there (verified: lazy `finally` timing matches Node for `next`-only use).
3. Wire the diagnostic through `ctx.errors` so #6776's validation and the CLI
   both show it.

The real fix — threading `.throw()`/`.return()` into the suspended frame —
stays with #1687 / #1691; this issue only removes the silent miscompile.

## Acceptance

- The three probes above fail to compile with the named diagnostic (until
  #1687 lands, after which they must pass and this gate becomes dead).
- `next()`-only generators are unaffected: no new compile errors in
  `tests/equivalence/` or the pinned issue tests.
- test262 `GeneratorPrototype/throw|return` rows move from `fail` to
  `compile_error` (report the count in the PR; a compile_error is the honest
  verdict).

## Implementation Plan

What routes to the eager path today (JS-host lane): every sync generator for
which `isNativeGeneratorCandidate` is false — class / object-literal generator
methods and generator function expressions (always, in this lane), exported
declarations, `yield`-in-`yield` operands, nested `yield*`, bodies with an
unresolvable identifier, bodies the plan builder rejects, and any declaration
whose instance or `{value, done}` result leaves the allowlisted consumers
(`hostLaneGeneratorUsesAreSafe` / `resultConsumptionIsSafe`: e.g. a result
passed to `JSON.stringify`, an instance pushed into an array or passed to a
function). The IR lane is no alternative: its generator lowering
(`src/ir/from-ast.ts`, Slice 7a) is the same eager buffer
(`__gen_create_buffer` + `gen.push`), and it only claims generators whose
legacy slot is already the eager `externref` result
(`r2SignatureMatchesAllocatedSlot`), so nothing could be routed there instead.

Which of those are observably wrong under `.throw()` / `.return()`: a resumption
that lands on a `yield` inside a `try` block (or inside a `catch` whose `try`
has a `finally`) — the eager body already ran the `catch`/`finally` (or never
will), so the throw escapes the generator's own `catch` and the `finally` runs
at creation. At an unguarded `yield` an abrupt resumption simply completes the
generator, which the buffer reproduces — except for two eager-runtime defects,
fixed here: `return()`/`throw()` left the body's deferred throw (#928
`pendingThrow`) to surface on a later `next()`, and `throw()` left the body's
`return` value to surface there too.

1. `src/codegen/generator-eager-refusal.ts` (new):
   `reportEagerGeneratorAbruptResumptions(ctx, sourceFile)`, JS-host lane only.
   Collects sync generators (decl / fn-expr / method) with a guarded `yield`;
   if any, traces every `<recv>.throw(…)` / `<recv>.return(…)` receiver back to
   its generator (direct call `g()` / `obj.m()` / IIFE, or a `var`/`let`/`const`
   binding through its initializer and plain `=` writes, via `ctx.oracle`);
   when the traced generator is not a native candidate, reports
   `generator-eager-unsupported: .throw()/.return() on generator \`g\` …
   (#1687, #6781)` at the call through `reportError` (severity error, sticky).
   The candidate gate is consulted only for generators that already have a
   guarded yield AND a traced call, so every other program is byte-identical.
2. `src/codegen/declarations/import-collector.ts`: call it once per source from
   the generator-imports finalize (where `sourceNeedsGeneratorHostImports`
   already asks the same gate for standalone).
3. `src/runtime/iterator-polyfills.ts`: `%GeneratorPrototype%.return` clears
   `pendingThrow`; `.throw` clears `pendingThrow` and sets `retDone`.
4. `scripts/compiler-boundaries.json`: classify the new module like its
   generator siblings.

Decisions:
- `.return()` called only after exhaustion is refused too (when the body has a
  guarded yield): exhaustion is not provable from the source. Without a guarded
  yield it is not refused, and it is correct.
- Implicit closes (for-of `break`, destructuring) and untraceable instances (a
  parameter, a property, an exported generator driven from JS) are not refused;
  they stay #1687's. Standalone/WASI are out of scope, as for #3587.

## Resolution

Probes (JS-host lane; base = `3d3dfda3`, the fork point):

| probe | before | after | Node |
|---|---|---|---|
| `try{yield}catch` + `it.throw("boom")`, result to `JSON.stringify` | `boom` escapes uncaught | compile error `generator-eager-unsupported` | `caught:boom`, `{value:2}` |
| `created` counter + `try/finally`, `it.return(7)` before `next()` | `102;102;…` | compile error | `0;0;{value:7,done:true}` |
| `try/finally` + `it.throw(...)` inside caller `try` | `finally,created,…` | compile error | `created,…,finally,caught:boom` |
| class `*items()` with `try/catch`, `.throw()` | Error escapes `run()` | compile error | `1,true,99` |
| `const gen = function*(){try…finally}`, `.return(5)` | `1,1,5,true,1` | compile error | `1,0,5,true,1` |
| no try; `yield 1; throw`; `.return(5)` then `.next()` | `caught:late` | `{"done":true}` | `{"done":true}` |
| same try/catch shape, results read via `.value`/`.done` (lazy) | matches Node | matches Node (unchanged) | — |

The issue's third probe as worded (a `throw` after the first `yield` escaping
the caller's `try` as a raw `WebAssembly.Exception`) did not reproduce on this
base in any shape tried (top-level, nested capturing, class method, module-init
consumer); the throw-through-`finally` and deferred-throw-after-`return()`
probes above are the observable variants.

Byte identity: the 11 non-refused probe programs that compile at all are sha256-identical
before/after (the import-collector hook alone A/B'd).

test262, measured with the runner itself (`scripts/run-test262-paths.mts`
logic, `TEST262_ORACLE_MODE=linked`) over every test262 file with a generator,
a `yield` and a `.throw(`/`.return(` call, plus all of `GeneratorPrototype`
(225 rows), before vs after on the same box:

- host: **1 row changed** — `built-ins/GeneratorPrototype/return/try-finally-set-property-within-try.js`
  `fail → compile_error` (89 pass before and after).
- standalone: **0 rows changed** (120 pass before and after).
- static cross-check against the baseline JSONL (eager rows = `env::__create_generator`
  / `env::__gen_create_buffer` imports): the only sync-generator row that is
  eager, has a `try` and calls `.throw(`/`.return(` is that same file.

Net gate: `scripts/diff-test262.ts` counts only `pass → other` as a
regression and `other → pass` as an improvement; `fail → compile_error` lands
in `otherChanges`, which is printed and gates nothing — no risk.

Tests: `tests/issue-6781-generator-eager-refuse.test.ts` (14 cases; 8 fail on
the base sources): the three probes plus method, fn-expr and post-exhaustion
refusals; Node parity for lazy `.throw()`/`.return()`, next()-only consumption
(manual loop with `finally` timing, for-of, spread, `Array.from`), eager
next()-only, the two runtime completion fixes, and the untraced-parameter
residual.

Gates (all exit 0): check-loc-budget, check-func-budget (also with
`LOC_GATE_BASE=origin/main`), check-coercion-sites, check:oracle-ratchet,
check:dead-exports, typecheck, format:check, compiler-boundaries inventory,
check:ir-dialect, check:ir-kind-neutrality, check:jstag-seam, check:ir-layering,
check:codegen-fallbacks, check:any-box-sites, check:speculative-rollback,
check:stack-balance, check:pushraw, check:host-import-policy, check:ir-only,
check:ir-adoption, check:issues, check:done-status-integrity,
check:issue-spec-coverage, check:harness-compile-budget, check:verdict-oracle,
lint, check:ir-fallbacks, test:guard (20 files / 255 tests). Generator/yield
suites (17 files, 101 tests) pass single-fork; the 26 test files that use
`.throw()`/`.return()` on generators show only failures that reproduce
identically on the base sources (#986's `/workspace/test262` path, #2173 /
#2864 / #6651-SG1 standalone pins, #3123).

Left for #1687: implicit-close consumers, untraceable instances,
standalone/WASI, and the creation-time side effects of eager next()-only
consumption (the body still runs before the first `next()` there).
