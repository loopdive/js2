---
id: 4235
title: "generateMultiModule never assigns ctx.fnctorEscapeGate — the entire fnctor pipeline (per-type layouts included) is silently inert on every multi-file compile"
status: done
completed: 2026-08-09
assignee: ttraenkler/opus-4235-multifile
created: 2026-08-08
updated: 2026-08-09
loc-budget-allow:
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::generateModule
  - src/codegen/fnctor-escape-gate.ts::analyzeProtoMethodWriteOnce
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, objects
goal: performance
related: [3927, 4157, 4211, 4074]
origin: "2026-08-08 second-corpus layout census (lead's measurement subagent): the positive control — identical options, compile() vs compileMulti() on a two-site fixture — separated compile path from options after a first pass reported zeros for acorn through compileProject."
---

# #4235 — multi-file compiles silently skip the whole fnctor pipeline

## Problem

`analyzeFnctorEscapeGate` is called **only** at `src/codegen/index.ts:3536`,
inside `generateModule` — the single-file path. `generateMultiModule`
(`src/codegen/index.ts:6206`), which `compileProject`/`compileMulti` dispatch
to via `src/compiler.ts:975`, never assigns `ctx.fnctorEscapeGate`.

Consequence: on any multi-file compile the entire fnctor pipeline is inert —
escape-gate analysis, presence bits/hot-cold split (#4211/#4217), and the
per-type layout analysis + emission (#3927/PR #4230). No error, no fallback
telemetry: the compile succeeds with the unsplit union representation, which
is a **silent-empty** — a zero from this path is indistinguishable from "no
fnctors in the package".

Line numbers verified 2026-08-08 on main @ `5d661603f`; re-verify before
fixing — this file cites a moving target.

## Why it matters

- Most of the npm-compat corpus compiles through `compileProject`. Every
  fnctor-pipeline measurement or optimization validated on single-file
  `compile()` (acorn's lane) has never run on those packages at all.
- The 2026-08-08 second-corpus census had to fall back to single-file
  `compile()` for every package; its acorn numbers were validated against CI
  (binary 621,552 B == npm-compat.json) only via that path.
- Any future default-ON of `JS2WASM_FNCTOR_LAYOUT_EMIT` (#3927 §6) will look
  like it shipped to the whole corpus while actually engaging only on
  single-file compiles.

## Evidence (reproducible)

Two-site fnctor fixture (`TWO_SITE`), identical options:

- `compile()` (single-file): `[alloc-labels]` stderr reports the family,
  verdicts, and labels.
- `compileMulti()`: zero fnctor analysis output; `ctx.fnctorEscapeGate`
  undefined throughout codegen.

The census subagent's first acorn-through-`compileProject` pass reported
zeros for everything — only the positive control exposed the path
difference. (The report's `.tmp` copy was lost to worktree auto-cleanup;
the table below is the durable record, transcribed 2026-08-08.)

## The second-corpus census (what the single-file path measured)

Instrument: `[alloc-labels]` stderr, single-file `compile()`, main @
`5d661603f`. Verdict names are the code's (`split` = proved per-type
layouts; `too-many-shapes` etc. are bail verdicts). The site-count column is
a static proxy, NOT volume; the alloc-share column needs a runnable module
and only acorn compiles standalone of this set.

| package | families | proved (`split`) | bail verdicts | labels proved/all | alloc share |
| --- | ---: | ---: | --- | ---: | --- |
| acorn 8.16.0 | 6 | **1** (`Node`) | 1 single-site, 1 not-sep, 3 no-sites | 59/68 (87%) | ≥77.5% of struct bytes (runtime census) |
| lodash 4.18.1 | 7 | 2 | 5 no-sites | 13/25 (52%) | no data — doesn't compile |
| three 0.185.1 | 33 | **0** | 3 single-site, 2 not-sep, 28 no-sites | 0/36 (0%) | no data — doesn't compile |
| moment 2.30.1 | 3 | 1 (`Moment`) | 2 single-site | 3/5 (60%) | no data — doesn't compile |
| styled-components, marked, redux, cookie, clsx | 0 | — | — | — | no fnctors at all |
| react-dom, jest, uuid, lit | 0 | — | — | — | no data — barrel entries (157–1,359 B stubs) |

Union widths of proved families: acorn `Node` 62 fields (mean 6.3) vs
`Moment` 17, `LazyWrapper` 10, `LodashWrapper` 5.

**Conclusion (2026-08-08): k=1 labeling generalizes as a MECHANISM, not as a
payoff — acorn is the best case by a wide margin.** Every second-corpus
union is 5–17 fields against acorn's 62; three.js (largest family count, 33)
yields zero splits. **Keep the #4211/#4217 cold split**: its value lives in
the bail-verdict families, which dominate everywhere (32/33 three.js, 5/7
lodash, 5/6 acorn itself). And the headline caveat stands: most of this
corpus compiles through `compileProject`, which this analysis has NEVER
measured — fixing this issue is the precondition for a real corpus-wide
census.

## Acceptance criteria

- [x] `generateMultiModule` runs the same fnctor pipeline (escape gate →
      presence/cold analysis → layout analysis when flagged) with
      whole-program visibility across the module graph, or an explicit,
      TELEMETERED refusal (a counted fallback reason, not silence) where
      cross-module analysis is genuinely not yet supported.
- [x] A regression test pins the parity: the `TWO_SITE` fixture compiled via
      `compile()` and `compileMulti()` yields the same fnctor analysis
      verdicts (or the telemetered refusal on the multi path).
- [x] The alloc-labels diagnostic prints which compile path it ran under, so
      a zero can never again be read without its provenance.

## Resolution (2026-08-09)

**The whole-program arm landed, not the refusal arm** — with one narrow,
counted refusal inside it. Line numbers re-verified against main @ `49cab5c82`
(the filed `:3536` / `:6206` had drifted to `:3548` / `:6241`).

### What changed

`analyzeFnctorEscapeGate` now takes the graph's source files instead of one
file, and every sub-pass walks all of them:
`analyzeProtoMethodWriteOnce`, `buildProtoMethodIndex`,
`buildReceiverStructMap`, and `analyzeFnctorAllocLabels`/`indexSourceFile`.
`generateMultiModule` calls it at the same point in the pass that
`generateModule` does, and gained the matching
`collectDynamicObjectReturnCarrierTypes` + `reserveFnctorStructTypes`
reservation (same relative position — after `$ObjVecArr`, before
`collectDeclarations`).

Widening the walk is monotone toward SAFETY in every pass, which is why the
whole-program arm was landable rather than the refusal arm:

- Site classification: more visible uses can only ADD `sawTyped`/`sawDynamic`
  evidence, and clause B (`sawTyped` ⇒ `keep-typed`) is absolute. A use still
  missed leaves the site `keep-static`, which no lowering consumes.
- `analyzeProtoMethodWriteOnce` admits a slot precisely BECAUSE it saw no
  second write — so a one-file view of a graph would admit a slot another
  module overwrites (a real miscompile). Unioning across files only ever adds
  writes and poison.
- `buildProtoMethodIndex`: more bodies for a name make it ambiguous
  (≥2 ⇒ unresolved), never resolve it to a wrong callee.

### The two genuinely cross-module hazards, and what was done

1. **Import-alias symbol identity.** A use in module B of a binding declared
   in A keys under the import-alias symbol, so A's binding looked unused.
   Fixed by resolving through `checker.getAliasedSymbol`. (Left unfixed this
   was inert rather than wrong — no uses ⇒ `keep-static` — but it forfeited
   exactly the cross-module escapes this change exists to see.)
2. **Cross-module fnctor NAME collision — REFUSED and COUNTED.** Everything
   downstream is keyed by bare name (`__fnctor_<Name>` struct key,
   `approvedNames`, the write-once ledger). One source made that safe by
   construction; a graph does not — #4133 measured 55 colliding top-level
   names across the 146-file ESLint graph. `first-seen wins` would reserve one
   module's constructor shape and apply it to another module's same-named,
   differently-shaped fnctor: a wrong field set, not a missed optimization.
   Such families are dropped and counted under
   `provenance.refusals["multi-module-name-collision"]`. The refusal is
   per-family, not a blanket bail — a non-colliding fnctor in the same graph is
   still analysed (pinned by test).

### Evidence

Positive control, identical source and options, `target: "standalone"`:

| | before | after |
| --- | --- | --- |
| `compile()` | `path=single files=1 … reconstruct=2`; `Node: verdict=split labels=2`; 3 layouts emitted | unchanged |
| `compileMulti()` | **no output at all** | `path=multi files=1 … reconstruct=2`; `Node: verdict=split labels=2`; 3 layouts emitted |

`tests/issue-4235-multifile-fnctor-parity.test.ts` — 8 tests. The 6 analysis
tests pin verdict parity, provenance, cross-module visibility, the counted
refusal and whole-graph write-once closure; the 2 end-to-end tests drive the
real compilers and pin the WIRING. **Negative control run:** with the one
`ctx.fnctorEscapeGate = …` line removed from `generateMultiModule`, the 6
analysis tests still pass and exactly the 2 wiring tests fail — so the wiring
tests genuinely defend this defect rather than restating the analysis.

### Deliberately NOT included

`applyNumericPropertyAnalysis` (#3683 S4a) is also single-path-only and reads
`fnctorEscapeGate.receiverStruct`, so it is fnctor-adjacent — but it changes
numeric field REPRESENTATION graph-wide, which is a separate blast radius from
wiring up the pipeline, and it is not needed for verdict parity (it affects
derived field types, not verdicts). Recorded in #4256 with the rest of the
audit.

## Audit — what ELSE is single-path-only (per the implementer note)

Diffed `generateModule`'s prologue against `generateMultiModule`'s. **Thirteen**
setup steps run only on the single-file path; the escape gate was not the only
one. Everything below is ABSENT from `generateMultiModule` on main @ `49cab5c82`
(verified by name search across the whole function body, not just the prologue):

| single-path-only step | sets | scope |
| --- | --- | --- |
| `analyzeFnctorEscapeGate` | `ctx.fnctorEscapeGate` | **fixed here** |
| `collectDynamicObjectReturnCarrierTypes` | `ctx.dynamicObjectReturnFunctions` | **fixed here** |
| `reserveFnctorStructTypes` | `$__fnctor_<Name>` type slots | **fixed here** |
| `applyNumericPropertyAnalysis` | `ctx.numericPropertyNames` etc. | #4256 |
| `collectUserMethodNames` | `ctx.userMethodNames` | #4256 |
| `scanModuleMemberDeletes` | `ctx.moduleUsesDelete`, `memberDeleteReceiverNames` | #4256 |
| `sourceUsesRuntimeEvalBoundary` | `ctx.runtimeEvalCallableBoundaryEnabled` | #4256 |
| top-level `function` pre-scan | `ctx.topLevelFunctionNames` | #4256 |
| `sourceHasDynamicTaConstruct` | `ctx.moduleUsesDynTaView` | #4256 |
| `reserveTypedArraySubviewTypes` | `$__subview_<elem>` type slots | #4256 |
| `analyzeLinearUint8` + `reserveLinearU8AllocType` | `ctx.linearUint8` | #4256 (WASI) |
| `registerJsxRuntimeImports` | JSX runtime imports | #4256 |
| `addStringImports` | string helper imports | #4256 |

**Plus a live correctness defect found while validating, PRE-EXISTING and
independent of this change** (#4256): a fnctor prototype method's
`this.<field> = …` writes do not take effect through `generateMultiModule`.
Same source, same options, `target: "standalone"` — `compile()` returns 1 for
both `a.end === 5` and `a.type === "A"` after `a.finish("A", 5)`;
`compileMulti()` returns 0 for both, while a plain own-field read
(`b.extraC === 3`) passes on both. Established by a full-tree A/B (all three
changed files reverted to `HEAD` via file copies, not `git stash`): the
baseline fails identically, so this change is exactly neutral on it. Two audit
items were excluded as the cause by direct experiment — wiring
`collectUserMethodNames` into the multi path did not flip it, and neither did
`applyNumericPropertyAnalysis`.
