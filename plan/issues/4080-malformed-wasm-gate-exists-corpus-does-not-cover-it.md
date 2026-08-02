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
| #4065 | **four** independent walks over a runtime RegExp pattern, each re-deriving the character semantics; only the emitter knew `.` is `ReOp.ANY` |

The first framing was *"a hand-maintained type/op case list that one consumer
keeps in sync and another does not."* The fourth instance **sharpened it**, and
the sharper version is the one to design against:

> **A duplicated emission sequence, where one copy carries the type handling and
> another does not.**

### #4065 sharpens it again: the invariant can have NO HOME AT ALL

#4081 showed the invariant surviving as a **comment** in one copy and a silent
assumption in the other. #4065 is strictly worse — there is **no place where
the assumption is written down at all**.

`ensureDynamicStandaloneRegExpCompiler` walks a runtime-built pattern four
times (count records, find next `|`, emit records, anchored-alternations fast
path). The load-bearing invariant is *"one source code unit produces one
program record."* It appears nowhere as prose. It exists as **two independent
derivations of the same number**:

- walk 1 **counts** it into `CHARS`, which sizes the program array;
- walk 3 **recomputes** it as the expression `J - I`, a source-unit distance,
  to target a `SPLIT`.

They agreed only because every construct the runtime grammar accepted happened
to be one unit wide. Nothing enforced that, nothing stated it, and no lint over
source shape could find it — the two halves are in different loops, spelled
differently, and neither mentions the other.

**Consequence for the family:** the shape is not only *"a copy missed the
treatment."* It is also *"the same quantity is derived twice, by different
means, and the equality is load-bearing."* A design response has to cover both,
which argues for **making the quantity have one owner** (here: a single
tokeniser both walks call) rather than for detecting divergent copies.

**It was already producing a user-visible wrong answer on `main`**, unrelated to
the escape work that found it — the fast path copies the pattern's *source
text* as its match payload, so:

```
^(?:a.c|zz)$  ~  "abc"    Node: "abc"    standalone: NO MATCH   <-- wrong
a.c           ~  "abc"    Node: "abc"    standalone: "abc"      <-- right
```

Same construct, two answers, decided only by whether the pattern is anchored.
That is silent incorrectness, not a conformance corner, and no test262 file in
the population pointed at it — it fell out of reading the fourth walk.

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
2. **(new, and probably the larger)** a **value-level differential oracle**
   — ⚠ **against a REAL ENGINE, not the other lane. See the second correction
   below before building this.** The originally-proposed gc-vs-standalone
   comparison is refuted. Every silent-wrong-answer instance above is
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

## ⚠⚠ SECOND CORRECTION 2026-08-02 — the gc-vs-standalone oracle is REFUTED

The correction above proposed a **gc-vs-standalone** differential for the
valid-Wasm/wrong-value half. **That reference is wrong**, refuted by the
`L-descriptor` lane with a measured table. Recording it here **before the oracle
gets built against a reference that cannot see the family it is for.**

Measured on `trimEnd`, per coercion shape
(`0` = nothing thrown · `1` = the user's sentinel, by identity · `2` = threw
something else):

| shape | Node (truth) | standalone | gc (host) |
| --- | :--: | :--: | :--: |
| user `toString` throws | 1 | **1** ✓ | **0** ✗ |
| user `valueOf` throws | 1 | **1** ✓ | **2** ✗ |
| user `@@toPrimitive` throws | 1 | **0** ✗ | **2** ✗ |
| `@@toPrimitive` returns an object (spec TypeError) | 2 | **0** ✗ | 2 ✓ |
| Symbol receiver (spec TypeError) | 2 | **0** ✗ | 2 ✓ |
| **argument** `valueOf` throws (`charAt` pos) | 1 | **0** ✗ | **0** ✗ |

**Two independent failure modes, both fatal to a lane-vs-lane oracle:**

1. **Rows 1 and 6 — both lanes are wrong.** A differential reports **AGREE** and
   stays **silent** on a genuine defect. This is the majority case in the
   coercion family, so the oracle would be quietest exactly where the bugs are.
2. **Rows 2 and 3 — the host is wrong in a *different* way.** The differential
   fires, but the divergence points at the wrong lane. Acting on it would send
   someone to "fix" standalone toward a host answer that is itself incorrect.

**The host lane is not ground truth.** It silently swallows a throwing user
`toString` on a reflective `String` method (row 1: Node throws the sentinel, gc
throws nothing at all). Any instrument that treats one of our own lanes as the
reference inherits that lane's bugs as its definition of correct — the
[[reference_broken_instrument_can_still_give_right_answer]] shape, promoted to
infrastructure.

**Requirement, therefore:** the oracle's reference must be a **real engine**
(Node), and each comparison needs **three axes**, not one:

- **capability** — the non-throwing path still works (catches "gave up loudly",
  i.e. satisfying a throw-assertion by refusing the whole operation);
- **propagation** — a user throw escapes at all;
- **identity** — `caught === sentinel` (catches a TypeError *manufactured at the
  wrong step*, which satisfies the test while testing nothing).

That design was validated in-lane before use: a positive control (`throw
sentinel` direct / via a callee / via a builtin callback) scored **21/21 in both
lanes**, so an identity MISS is the coercion path and not the instrument.

**Precedent that a real-engine differential is tractable:** the #4065 lane
hand-ran a 37-case differential against Node (29 agree / 8 loud refusals /
**0 wrong / 0 miss**). The proposal is to make that standing rather than
per-lane improvisation.

**Corollary already paid for:** a bucket named "missing throw" is satisfied by
*any* throw. In the #2875 partition, shapes 4 and 5 above would have booked
flips without touching the three propagation shapes that actually need identity
— i.e. a real conformance gain that leaves the defect in place. Size and audit
such buckets on identity, never on "an exception appeared".
