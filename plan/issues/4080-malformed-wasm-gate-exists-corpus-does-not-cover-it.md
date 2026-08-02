---
id: 4080
title: "The `malformed_wasm` invariant already catches the compiler-emits-invalid-Wasm class — the gap is diff-test CORPUS COVERAGE, not a missing gate"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: testing
language_feature: n/a
goal: dogfood
related: [2143, 3989, 4077, 4079]
---

# The gate already exists; the corpus does not reach it

Reframed 2026-08-02 by the `H-crashes` agent, after it **disproved its own first
instrument** rather than reporting its number. Recorded here because the
reframing is the deliverable and the negative result is load-bearing.

## The pattern that prompted it — three independent instances, one shape

| issue | the two halves that disagreed |
| --- | --- |
| #3989 | slot type known in one place, not the other |
| #4077 | `fixupExternConvertAny`'s backward walk vs a hand-list of exceptions missing `extern.convert_any` |
| #4079 | eight hand-rolled inc/dec arms each handling `externref` + `ref`/`ref_null` and each forgetting `i32` |
| #4081 | a third `__call_fn_method_N` dispatch arm inlining the return sequence with no i32 boxing, while two sibling arms box correctly |

The first framing was *"a hand-maintained type/op case list that one consumer
keeps in sync and another does not."* The fourth instance **sharpened it**, and
the sharper version is the one to design against:

> **A duplicated emission sequence, where one copy carries the type handling and
> another does not.**

#4079 and #4081 are both that. And #4081 adds the detail that makes it
undetectable by construction: the invariant is written down as a **comment** in
one copy (`"Stack at this point: [result : externref]"`) and **silently assumed**
in the other — so nothing can keep the two copies honest.

#4079 is the sharpest cautionary case: a correct implementation
(`compileStaticPropIncDec`, #2019) was **already in the same file**, merely
unwired, while eight copies each independently missed `i32`. Generalising it to
`compileGlobalIncDec` was **net −25 LOC** — the duplication was pure cost.

## ⚠ The source-shape lint was REFUTED — do not rebuild it

The obvious response is a lint for the shape. It was built and it **failed its
own positive control**:

> A screen for sites testing `kind === "externref"` that also test
> `ref`/`ref_null` but never `i32` within ±40 lines reported **507 externref
> sites, 159 matching**. Run against the **pre-fix** `unary-updates.ts` and the
> **post-fix** version:
>
> | source | screen total | hits in `unary-updates.ts` |
> | --- | ---: | ---: |
> | pre-fix (known bug present) | 159 | 6 |
> | post-fix (bug gone) | 159 | 6 |
>
> **Identical.** The screen cannot distinguish broken from fixed.

**So 159 is not a population estimate of anything and must never be quoted as
one.** The reason is instructive: the 6 hits are the `externref`/`ref` arms,
which still exist after the fix and are *correct*; the defect lived in the
**fallback after them**, which the fix replaced with a helper call the window
cannot see. A source-shape lint is the wrong instrument for this class.

## The gate already exists

`scripts/diff-test-gate.ts` / `scripts/diff-test.ts` already carry a
**`malformed_wasm`** verdict (#2143):

> *"compiler reported success but `WebAssembly.validate` rejected the binary"* —
> and `malformed_wasm` **fails the gate loudly**.

Verified present in both files. That invariant catches **all three** instances
**by construction**, because all three emitted invalid Wasm while the compiler
reported success. No new gate is needed.

**The gap is corpus coverage.** The triggering shapes are simply not in the
diff-test corpus:

- a `null` argument positioned before a closure argument (#4077)
- `++`/`--` on a boolean-initialised (i32-slot) global (#4079)
- a string `+=` into an externref slot (#3989)

## ⚠ CORRECTION 2026-08-02 — the thesis above covers only HALF the family

**Refuted in part by the `L-enum` lane, and the refutation is accepted.** The
"`malformed_wasm` already catches it, the gap is only corpus coverage" claim
holds for the instances that emit **invalid Wasm** — and **not at all** for the
ones that emit **valid Wasm with a wrong value**.

The family splits in two, and the two halves need **different instruments**:

| half | instances | what would catch it |
| --- | --- | --- |
| **invalid Wasm**, compiler reports success | #3989, #4077, #4079, #4081 | `malformed_wasm` (#2143) — **exists**; gap is corpus coverage |
| **valid Wasm, WRONG VALUE** | `__object_keys` (#4071), `__hasOwnProperty` (#4055), the RegExp anchoring bug in #4065 | **nothing today** — needs a value-level gc-vs-standalone differential oracle |

`Object.keys([10,20,30])` returning `[]`, `hasOwnProperty` answering false for a
property that was just written, and `^(?:a.c|zz)$` failing to match while `a.c`
matches — all produce **perfectly valid modules**. `WebAssembly.validate` is
`true`. A validity invariant is structurally incapable of seeing them.

**So this issue's scope is now two pieces of work, not one:**

1. **(as originally filed)** measure and extend the `malformed_wasm` diff-test
   corpus, for the invalid-Wasm half.
2. **(new, and probably the larger)** a **value-level differential oracle**:
   run the same program through the **gc** lane and the **standalone** lane and
   compare *results*, not validity. Every silent-wrong-answer instance above is
   a gc/standalone divergence and would fall out of such an oracle immediately.

Precedent that this is tractable: the #4065 lane already ran a **37-case
differential against Node** (29 agree / 8 loud refusals / **0 wrong / 0 miss**)
by hand. The proposal is to make that a standing instrument rather than a
per-lane improvisation.

**Do not size either piece from the anecdotes.** Neither corpus has been
measured, and the one screen attempted for this family was refuted (above).

## Work — sizing FIRST, shape second

1. **Measure what the `malformed_wasm` corpus actually covers.** This has
   **NOT** been done. No population figure exists for this issue and none should
   be invented; the one number produced so far was disproved above.
2. Only then propose how to extend it — driven by the measured gap, not by the
   three anecdotes.
3. Any detector added here **must ship a positive control** proving it fires on
   a known instance (e.g. pre-fix `unary-updates.ts`). The refuted screen above
   is exactly why: it looked plausible, produced a confident number, and could
   not tell broken from fixed.

## Why this is worth doing rather than fixing case lists one at a time

Three instances in one cluster in one session, each found only because a
conformance test happened to exercise the shape. The invariant that would have
caught all three at authoring time already runs — it just never sees these
inputs.
