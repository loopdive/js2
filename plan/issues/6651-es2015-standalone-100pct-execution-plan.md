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
