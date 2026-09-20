---
id: 6651
title: "ES2015 standalone → 100%: cluster execution plan from the 2026-09-20 census"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-20
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, runtime, conformance
es_edition: ES2015
goal: standalone-mode
parent: 4444
related: [4444, 5199, 5198, 5152, 5269, 5318, 5350, 6484, 6485, 6494, 1665, 2867, 4119]
assignee: "ttraenkler/fable-es2015-plan"
# 2026-09-20 — cluster A (native generator lowering, standalone). Two gate
# widenings in `generators-native.ts` (`this` in a generator function
# EXPRESSION; a generator-valued destructuring-param default in a zero-suspend
# method lane). +61 manifest rows pass, 0 regressions across a 617-row
# generator neighbourhood on BOTH targets. The growth is ~80 % comment: each
# widening reverses a bail whose prior rationale is recorded in place, so the
# measurement that overturns it is recorded next to it rather than in a commit
# message nobody reads at the bail site.
loc-budget-allow:
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::registerNativeGenerator
---

# #6651 — ES2015 standalone → 100%: cluster execution plan

**Why a new file.** #4444 is the umbrella and its 2,800-line log is the
history. This file is the *dispatchable* plan: one census, nine clusters with
frozen row manifests, one owner/model/effort per cluster, and a uniform
acceptance recipe. Progress notes go under "Cluster status" below; narrative
stays in #4444.

## Census (authoritative, 2026-09-20)

Source: `loopdive/js2wasm-baselines` `test262-standalone-current.jsonl`,
fetched `--force` 2026-09-20 19:28 UTC, internal timestamp 2026-09-20 17:39,
`oracle_version: 14`, `oracle_lane: honest`, 48,735 rows, baseline_sha
`9dc2fa2e`. Edition classification:
`website/public/benchmarks/results/test262-file-editions.json` (index of
`ES2015` in its `editions` array).

| ES2015 standalone | rows |
| --- | ---: |
| total | 11,704 |
| pass | **10,384** (88.7 %) |
| fail | 1,034 |
| compile_error | 286 |
| **gap to 100 %** | **1,320** |

Edition-ratchet floor (`scripts/test262-edition-ratchet-baseline.json`,
2026-09-04): 10,131 — the baseline above is +253 over the floor.

### Top error signatures across the 1,320

| rows | status | signature |
| ---: | --- | --- |
| 129 | CE | `standalone target emitted host imports: env::__create_generator, env::__gen_create_buffer, …` |
| 53 | CE | `native generator lowering currently supports only sequential numeric yields in standalone/WASI (#680)` |
| 79 | fail | `TypeError: Cannot access property on null or undefined` |
| 76 | fail | `Expected a TypeError to be thrown but no exception was thrown` |
| 47 | fail | `Expected a Test262Error to be thrown but no exception was thrown` |
| 42 | fail | `Expected a Test262Error but got a TypeError` |
| 48 | CE | `host imports: env::Promise_all / Promise_race / allSettled / any …` |
| 18 | fail | `Method called on incompatible receiver (RegExp brand check failed)` |
| 17 | fail | `Object.prototype.toString is not yet implemented in --target standalone` |
| 7 | CE | `host imports: env::Object_set_constructor` |
| 6 | CE | `standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget` |

## Clusters — manifests, owners, models

Every cluster has a frozen path manifest under `plan/agent-context/6651/`
(one `test/`-relative path per line, derived mechanically from the census
above — see the partition rule in the manifest generator note at the bottom).
A cluster is done when **every** row in its manifest passes on the isolated
standalone runner and the acceptance recipe below is met.

| # | cluster | manifest | rows | CE / fail | owner lane | model / effort | blocking dependency |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| A | Native generator lowering: non-numeric yields, `yield` in destructuring/class/object bodies, `yield*`, try/catch | `A-generators-standalone.txt` | 197 | 197 / 0 | senior-developer | Opus, **max** | none — this is the largest single lever; unblocks ~60 more rows in C/G that currently hit the same gate |
| B | RegExp `Symbol.{match,replace,search,split}` protocol, `flags`, `exec` override, Annex B RegExp, `String.prototype.{match,search,split,replace}` dispatch | `B-regexp-protocol.txt` | 147 | 11 / 136 | senior-developer | Opus, high | coordinate with #5198 (in-progress, drafts #5393/#6014, held #5996) — read its handoff first, do not duplicate the `lastIndex` reader work |
| C | Class / object-literal / `super` semantics: class-call TypeError, `new.target`, method descriptors, subclass constructor return, computed keys | `C-class-object-super.txt` | 177 | 6 / 171 | senior-developer | Opus, high | #5318 / #5350 in-progress; draft #5839 documents the object-literal `super` blocker #6420 |
| D | Native Promise combinators: `Promise.all/race/allSettled/any` for non-literal/iterable args, `then` residuals, subclass ctor | `D-promise-combinators.txt` | 101 | 48 / 53 | developer | Opus, high | held PR #5883 (observable combinator protocol) — read, do not re-implement |
| E | TypedArray / ArrayBuffer / DataView: species, detached checks, `object-arg` ctors, `toLocaleString`, internals `[[Set]]`/`[[DefineOwnProperty]]`/`[[OwnPropertyKeys]]` | `E-typedarray-buffers.txt` | 144 | 1 / 143 | developer | Opus, high | none (#5317 done) |
| F | Proxy / Reflect: invariant must-throw, `Reflect.construct` distinct NewTarget, trap receiver/realm args | `F-proxy-reflect.txt` | 89 | 5 / 84 | senior-developer | Opus, high | #6494 in-review; drafts #5400 (NewTarget design) / #5397 (Reflect.set receiver) |
| G | for-of / destructuring runtime residuals, generator prototype objects, `Iterator.prototype.{chunks,windows}` (ES2015-tagged via `generators`) | `G-forof-destructuring-iterators.txt` | 134 | 2 / 132 | developer | Opus, high | after A lands (≈20 rows here are generator-shaped fails) |
| H | Builtins misc: `Array.prototype.concat` (isConcatSpreadable, #6485), `slice/splice/map` species, `Object.prototype.toString` runtime tag (#4119 gap), `Function.prototype.{toString,bind,@@hasInstance}`, `Error.prototype.stack`, `Symbol.prototype.@@toPrimitive`, `__proto__` | `H-builtins-misc.txt` | 217 | 6 / 211 | developer | Opus, high | #6485 in-progress (concat) |
| I | Language misc: module namespace internals (12), `with` + unscopables, `eval` spread, TCO rows, global-code var collision | `I-language-misc.txt` | 114 | 10 / 104 | developer | Opus, medium | several rows are eval/with (see #1066); triage first, file wont-fix with reason where standalone cannot honour |

Rows: 197+147+177+101+144+89+134+217+114 = 1,320. The manifests partition the
gap exactly; no row is in two clusters.

### Dispatch order and concurrency

The container that produced this plan has 4 cores, so at most 3 clusters run
concurrently. Order by rows-unlocked-per-effort:

1. **Wave 1 (now):** A (generators), D (promise combinators), H (builtins misc).
2. **Wave 2:** E (typed arrays), C (class/object/super), B (RegExp).
3. **Wave 3:** F (proxy/reflect), G (for-of, after A), I (language misc).

Every owner first re-runs its manifest on its branch base to get a **measured**
before-state (never quote this file's counts as the before-state — a base
moved under you is the #2916/#4433 defect).

## Acceptance recipe (every cluster, no exceptions)

```bash
# 1. before-state on the branch base, isolated standalone runner
npx tsx scripts/run-test262-paths.mts plan/agent-context/6651/<cluster>.txt \
  --standalone --isolate > .tmp/6651/<cluster>-before.log 2>&1; echo $?
# 2. implement; keep .tmp/base copies of every edited file at first edit
# 3. after-state, same command → <cluster>-after.log; both logs are the receipt
# 4. neighbourhood regression control: the sibling directories of every row
#    you changed behaviour for (e.g. all of built-ins/Promise/** for D), host
#    (default target) AND standalone, before vs after — zero pass→non-pass
# 5. gates, chained, before the commit (never --no-verify)
node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
  && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
  && npm run -s check:dead-exports && npx vitest run tests/equivalence.test.ts
```

- **No new host imports without a standalone fallback** (dual-mode rule).
  A cluster fix that converts a CE into a fail is progress only if the fail
  is a narrower, documented residual — record it.
- Growth allowances (LOC / func budget) go in this file's frontmatter, dated.
- Commits carry `Model:` and `Co-authored-by:` trailers per `AGENTS.md`.
- The owner writes its receipts (before/after counts, log paths, SHA of the
  manifest) under **Cluster status** below, not in #4444.

## Definition of done for #6651

- ES2015 standalone `pass == total` (11,704 / 11,704) on a full authoritative
  standalone run, or every remaining row has a `wont-fix` issue naming the
  spec-level reason (e.g. direct `eval` of dynamic text in a no-host target).
- `scripts/test262-edition-ratchet-baseline.json` ES2015 floor banked to the
  new number via `check:edition-ratchet:update` from a **full** run.
- #4444 gets a one-paragraph closing note pointing here.

## Cluster status

_(owners append here: date, branch, before → after, log paths, residuals)_

### 2026-09-20 — Cluster A (native generator lowering, standalone), slice 1

- **Branch** `worktree-agent-ad71a322a90a0a605`, based on
  `claude/es2015-test262-plan-54tooh` @ `905dca75`.
  **Worktree** `/home/user/js2/.claude/worktrees/agent-ad71a322a90a0a605`.
  A second, source-clean worktree `/home/user/js2/.claude/worktrees/measure-6651-A`
  (detached at the same commit) held every before-run — the first attempt
  measured the base with the runner reading the *edited* tree underneath it,
  which is not a before-state.
- **Manifest** `plan/agent-context/6651/A-generators-standalone.txt`, 197 rows,
  sha256 `5fc1a7c0c1d5672aba427f347ea225633e0c95cfa6e9547240fcc2cda2d62d77`.

| standalone, `--isolate` | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| before (`.tmp/6651/A-before.log`) | **1** | 1 | 195 |
| after (`.tmp/6651/A-after.log`) | **62** | 2 | 133 |

**+61 rows pass, 0 pass → non-pass.** The one other movement is
`language/expressions/yield/star-in-rltn-expr.js`, compile_error → fail — a
narrower, documented residual (it now builds and gets a wrong first `value`).

#### What changed, and why it was bailed before

Both edits are in `src/codegen/generators-native.ts`; both reverse a *bail*, and
neither adds a host import.

1. **A1 — `this` inside a generator function EXPRESSION (41 rows).**
   `isNativeGeneratorExpressionShape` refused any `this` in the body, so
   `Array.prototype[Symbol.iterator] = function*(){ … this.length … }` — the
   shape the whole `dstr/*-array-prototype` fixture family is built on — fell to
   the eager-buffer host path and leaked `env::__gen_*` into a standalone
   binary. #5255 had already solved the same problem for free *declarations*:
   snapshot the receiver into a frame field (`dynamic_this`) in the FACTORY and
   restore it as the resume function's `this` local. The bail's own comment said
   fn-exprs were excluded because "their closure ABI supplies a different
   capture carrier" — but `this` is not a capture (a non-arrow function
   expression rebinds it per call), so the `__self` struct and the receiver
   never compete. The factory here IS the lifted closure, whose `this` resolves
   through the `__current_this` global that `__call_fn_method_N` installs around
   the dispatch, i.e. exactly where §10.2.1 binds it.
   The load-bearing property is the *snapshot*, not "it compiles": a generator
   body runs on a later `.next()`, long after that global is restored. The
   `tests/issue-6651-generator-expression-this.test.ts` case "the receiver
   SURVIVES a suspension" is the one that fails if the receiver is read lazily.
   `super` keeps the bail (no [[HomeObject]] slot in the frame), and the two
   `this`-scans must agree before admitting — `fnExprBodyReferencesThis`
   descends into class bodies while `bodyReferencesOwnThis`, which arms the
   snapshot, stops there.
2. **A2 — a generator-valued destructuring-param default in a zero-suspend
   method lane (20 rows).** `buildNativeGeneratorPlan` bailed on every
   `[g = function*(){}]` param default. #4769 had already admitted a
   *class*-valued default on exactly one precondition — the method must not
   yield, so the value never crosses a suspension — and the #3952 note left the
   generator arm as "a measured, bounded follow-up", declining to admit it on
   lane identity alone. This is that measurement. A **yielding** method still
   takes the host path, and the generator function-expression host keeps its
   blanket bail for the reason recorded there (that lane mishandles element
   defaults with no closure involved at all, so admitting would swap a loud
   leak for a silent wrong value). Both halves are pinned by tests.

#### Neighbourhood regression control — zero pass → non-pass

617 rows: all of `language/expressions/generators`,
`language/statements/generators`, `built-ins/GeneratorPrototype`. The 8
`*array-prototype*` rows poison the realm, so they ran `--isolate`; the other
609 ran in-process, before and after, on both targets.

| lane | before | after | flips |
| --- | --- | --- | --- |
| standalone, 609 in-process | 512 / 56 / 41 | 512 / 56 / 41 | none |
| host (default), 609 in-process | 521 pass / 88 fail | 521 / 88 | none |
| standalone, 8 isolated | 4 pass / 4 CE | **8 pass** | +4, none lost |
| host, 8 isolated | 4 pass / 4 fail | 4 / 4 | none |

Logs: `.tmp/6651/nb-{sa,host}-{before,after}.log`,
`.tmp/6651/nbiso-{sa,host}-{before,after}.log`.

Also green: `npm run -s typecheck`; the 11 generator-adjacent unit suites
(`generators`, `generator-iife`, `generator-method-destructuring`,
`generator-yield-contexts`, `issue-3032`, `issue-3164`, `issue-3302`,
`issue-3386`, `issue-3952`, `issue-4769`, `issue-5255`) — 94/94; and
`tests/equivalence`, 217 of its 218 files (run in small batches — the whole
suite OOMs on this box, and `multi-file-compilation.test.ts` OOMs on its own,
**identically on the base commit**, so it is an environment limit, not a
finding). Equivalence has **22 failing cases, every one of which reproduces on
the base commit** in the clean worktree: `arguments-nested-and-loops` (1),
`array-inline-return` (1), `delete-sentinel` (1), `logical-conditional-identity`
(3), `new-non-constructor` (2), `null-dereference-guards` (5), `reflect-api`
(1), `tdz-reference-error` (6), `yield-as-expression` (1),
`misc-small-patterns` (1). None is attributable here. The last two were
re-checked individually rather than assumed, because both name shapes this
change touches (`yield`; a named function expression's own-name binding).

#### Residual sub-buckets (135 rows), with signatures

| rows | signature | what it needs |
| ---: | --- | --- |
| 74 | `standalone target emitted host imports: env::__gen_*` | see split below |
| 53 | `native generator lowering currently supports only sequential numeric yields … (#680)` | `yield` nested inside an assignment PATTERN |
| 6 | `'yield' is a reserved word …` | decorator-syntax rows; not a generator gap |
| 1 | `fail` — wrong first `value` | `language/expressions/yield/star-in-rltn-expr.js` (was CE) |
| 1 | `fail` — invalid module, `__gen_resume_g` `local.tee` type | `yield-star-before-newline.js`; **pre-existing, byte-identical before and after** |

The 53 `#680` rows plus 37 of the 74 leaks are **one family, 90 rows**:
`[ x = yield ] = vals` / `for ([ {} = yield ] of …)` — a `yield` suspension
*inside* a destructuring-assignment pattern, which `lowerStatements` reaches as
an unmodeled `ExpressionStatement` (17) or `ForOfStatement` (20). **Do not
start here expecting passes:** a host-lane probe of 8 of these rows failed
8/8, so the generator lowering is not their only blocker. (Same probe: 8/8 of
the A1 family and 8/8 of the A2 family passed on the host — which is exactly
why those two were picked first, and it is the cheapest triage available: a
row that fails on the host cannot be made to pass by fixing standalone-only
lowering.)

The other 37 leaks are small, independent gates in
`isNativeGeneratorExpressionShape` / `isNativeGeneratorCandidate`:

| rows | gate |
| ---: | --- |
| 16 | generator function-expression host, ANY closure-valued param default (the `ts.isFunctionExpression(decl)` arm — blocked by that lane's pre-existing plain-numeric-default defect, #3952, which must be fixed first) |
| 9 | named fn-expr whose body references its OWN name (`bodyReferencesOwnName`) — needs the immutable self-name binding, incl. its strict-mode TypeError on reassignment |
| 5 | computed-name generator methods (`{ [k]*(){} }`) — blocked on a stable emitted-name derivation |
| 4 | rest / optional params (2 in the object-method gate, 2 in the fn-expr gate) |
| 2 | `super` or an outer-scope capture in an object-literal method |
| 1 | duplicate method name within one class/object literal |

Method used, for the next owner: `isNativeGeneratorCandidate` /
`buildNativeGeneratorPlan` were temporarily instrumented (every `return
false`/`null` tagged with its line, `fail()` tagged with its caller from the
stack, plus the unmodeled statement's `SyntaxKind` + source text) and the
manifest was run through a **compile-only** probe. That turns "197 compile
errors" into a per-gate histogram in ~8 minutes instead of a 40-minute runner
pass, and it is how the three buckets above were sized before any code changed.
The instrumentation is not committed.

## Manifest generator note

Partition rule applied to the 1,320 non-pass rows, first match wins:
A = `status == compile_error` and error mentions generator/`__gen_`/yield;
D = path or error mentions Promise; B = `built-ins/RegExp`, `annexB/built-ins/RegExp`,
`String.prototype.{match,search,split,replace}`; E = `TypedArray*`,
`ArrayBuffer`, `DataView`; F = `Proxy`, `Reflect`; C = `statements/class`,
`expressions/class`, `expressions/super`, `new.target`, `expressions/object`,
computed-property-names; G = `for-of`, `expressions/assignment`, `for/`,
generators (runtime), `GeneratorPrototype`, `GeneratorFunction`, `Iterator`,
`ArrayIteratorPrototype`; H = remaining `built-ins/*`; I = the rest.
Manifest SHA-256s are in the commit that added them.
