---
id: 2086
title: "single implicit-derived-ctor synthesis shared by all three representation paths (externref / WasmGC struct / standalone)"
status: done
completed: 2026-06-16
assignee: ttraenkler/dv3
sprint: 62
created: 2026-06-11
updated: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: classes
goal: core-semantics
related: [1833, 2082, 2078, 2020, 2021]
origin: "2026-06-11 analysis program (report 05 §2a); stub 08-A1"
---

# #2086 — one rule, three drifting implementations

## Problem

The rule "implicit derived ctor forwards all args to super" is implemented
three times: externref path (class-bodies.ts:1263-1289, fixed by #1833),
WasmGC-struct path (:1292-1356, synthesized ZERO params until #2082's
point fix), and the standalone variant (zeroed base fields, #2078). Each
fix landed in one twin while the others stayed broken — the defining drift
pair of the June corpus.

## Root cause

`src/codegen/class-bodies.ts:1263-1356` — per-representation
re-implementation with no shared `synthesizeImplicitDerivedCtor(repr)`.

## Fix direction

Extract one synthesis function parameterized by representation; the three
paths become thin wrappers. Full analysis:
plan/log/analysis-2026-06/05-structure-review.md §2a.

## Acceptance criteria

- #1833/#2082/#2078 test suites all green from ONE implementation
- A deliberately-injected forwarding bug fails in all three lanes

## Dupe check

#1833 (externref fix, merged), #2082 (struct fix, merged), #2078
(standalone, suspended) are the point fixes; no issue owns the
consolidation. New (analysis program).

## Resolution (2026-06-16, dv3)

**Consolidated the synthesized parameter-prefix rule onto one source.** The
externref-forwarder (#1833) and forwarded-ancestor-ctor-param (#2082) prefixes
were computed twice — once in the func-type registration phase
(`class-bodies.ts` ~612) and again in the `FunctionContext`-build phase
(~1280) — and the two copies were the exact drift pair the issue describes.
Both phases now call a single helper
`computeImplicitDerivedCtorPrefix(ctx, decl, className, ctor)` that returns
`{ implicitBuiltinParent, implicitForwarderArity, implicitStructCtorParams,
prefixParams }`; the type phase maps `prefixParams.map(p => p.type)` and the
fctx phase spreads `prefixParams` directly. The two lanes can no longer
disagree about arity, names, or `ref→ref_null` widening.

**Cross-lane regression guard (acceptance (2)).** `tests/issue-2086.test.ts`
runs the *same* implicit-derived-ctor forwarding scenario through all three
representation lanes in one file — Lane A (WasmGC-struct, host), Lane B
(externref-backed `DataView`), Lane C (standalone, asserting no `env::` leak).
Verified it has teeth: deleting the synthesized prefix from the fctx-build
phase fails **all three** Lane A/B/C cases (Dog_init arity mismatch, Sub_new
local-index error, standalone numeric-forward). #1833/#2082/#2078 suites all
stay green (21 tests across the 4 files); `tsc --noEmit` clean.

**Finding (informs the follow-up below).** Injecting the same bug into the
*func-type-registration* prefix alone did NOT break forwarding, because the
fctx-build phase re-registers the ctor/init func types via `addFuncType`
(~1324), which overrides the earlier registration. So the fctx-build prefix is
the authoritative one; the type-registration prefix is effectively belt-and-
braces. Folding both onto the shared helper removes the chance they diverge,
which is the point — but it confirms the body-emission phase is where the real
behaviour lives.

**Carried forward (follow-up, not done here).** The deeper unification — a
single `synthesizeImplicitDerivedCtor(repr)` that also owns the *body-emission*
divergence (struct-default fill vs externref host-alloc vs standalone zeroed
base fields, ~1340–1530) — is a high-blast-radius refactor of the most fragile
class-construction code and was scoped out to avoid a class-ctor regression
mid-sprint. The param-prefix consolidation + the cross-lane guard close the
named drift pair and lock the three lanes; the body-emit unification can land
later against the guard now in place.
