---
id: 2141
title: "Retire the tag-5 box-the-externref ABI: make consumers tag-agnostic, then allow honest generic boxing"
status: ready
sprint: current
created: 2026-06-12
updated: 2026-07-17
unblocked_note: "2026-07-02: blocked_by #2167 (Fable disabled) is done — Fable restored; flipped on claim per owner directive (task #32)."
priority: high
feasibility: hard
reasoning_effort: max
model: fable
fable_role: spec
task_type: architecture
area: compiler
language_feature: any-type
goal: correctness
related: [2072, 2080, 1987, 2104, 1888, 1624]
origin: "2026-06-12 sprint-62 architecture analysis (value-rep workstream N2)"
---

# #2141 — tag fidelity can never be established while the box site must lie

## Problem

Generic boxing (`type-coercion.ts:1207-1219`) deliberately mis-tags
externrefs as tag 5 (string) because honest tag recovery at the boxing site
flipped **−794 standalone test262** (the #1888 incident): the harness
comparator (`isSameValue` over externref-ABI `any` params) was tuned
against the lie. This freezes invariant V1 (producer honesty) out of reach:
#2104's `boxToAny` "unknown externref → runtime classify" arm and the
#1624-endgame (host-import retirement) are both blocked on it.

## Approach

1. Characterize exactly which equality/`__any_*` paths encode the tag-5
   assumption (the #1776/#1914 blocks, `binary-ops.ts:1833-2028`).
2. Make those consumers tag-agnostic first.
3. Flip honest boxing behind a flag with a measured standalone test262 run.

Sprint 62 delivers the characterization + consumer migration spec (Fable
architect); implementation lands 62-stretch/63.

## Acceptance criteria

- `String(undefined as any)` ≠ `"[object Object]"` via the _generic_ path
  (#2072 residue).
- `typeof (true as any) === "boolean"`.
- `isSameValue` test262 buckets unchanged (no −794 repeat).

## Notes

Symptom anchors: #2072, #2080, #1987. Hard constraint: the merged
anyvalue-tag-recovery spec's rule "never re-tag at the box site" holds
until step 2 completes.

## Implementation Plan (dev-evalf/Fable, 2026-07-02 — characterization + staged migration)

### A. Characterization (complete — full-source sweep)

**The lie has exactly two producer sites:**

1. `src/codegen/value-tags.ts:162-170` — `boxToAny`'s externref arm →
   `__any_box_string` (tag 5). Everything externref-shaped flows here:
   genuine strings, `undefined`/`null` (both lower to `ref.null extern`
   pre-#2106), `$BoxedNumber`/`$BoxedBoolean` host carriers, open objects,
   closures.
2. `src/codegen/any-helpers.ts:260-267,320` — `__any_from_extern`'s
   fallback arm: everything it cannot positively classify (incl. all
   objects) → tag 5. Its honest arms (null→1, `$BoxedNumber`→3,
   `$BoxedBoolean`→4) already exist; `__extern_strict_eq`'s object-identity
   `ref.eq` fast-path (`:363-401`, #2734) exists ONLY to work around this
   fold.

**Consumer census — three maturity classes:**

- **Already tag-agnostic (guarded / classifying):** `tag5StringEqThen`
  (`any-helpers.ts:685-736`, `ref.test $AnyString` both operands, else
  legacy 0); `__any_to_f64` tag-5 `$BoxedNumber`/`$BoxedBoolean` recovery
  (`:1047-1111`); `tag5ToNumber` (`:1165-1184`); `stringyOperand` in
  `__any_add` (`:1328-1372`); `__any_to_string` tag-5 arm
  (`native-strings.ts:6497-6529`, guard + `recoverNonStringExtern`);
  AnyValue→native-string unbox (`type-coercion.ts:1383-1411`).
- **Still trusting tag 5 = string (raw readers):**
  `__json_stringify` AnyValue arm (`json-codec-native.ts:352-364` — field-4
  straight into `__json_quote_string`); `__any_typeof` tag-5 arm
  (`any-helpers.ts:2116-2122` — answers "string" for every lie-boxed
  object/undefined/number); `typeof-delete.ts:1422-1443` direct tag-list
  compare (`"string"→[5]`); `__any_unbox_extern` (`any-helpers.ts:1000`,
  raw field-4 — returns null payload for tag-6 refval boxes);
  `dyn-read.ts:117-131` tag-5 string routing.
- **Deferred-by-regression (the crux):** the both-tags-5 arms of
  `__any_eq` (`:1758-1782`) and `__any_strict_eq` (`:1934-1958`) answer
  legacy `0` for non-string tag-5 pairs. The #2040/#2585 classifier
  (numeric `f64.eq` + object `ref.eq` arms) was ejected at −162 standalone
  (class/dstr/generator-destructuring cluster) — BOTH arms independently
  re-break the `meth-dflt-ary-ptrn-empty` canary (empty `[]=genDefault`
  must not iterate; it went 0→2 next() calls). The relying site is a
  destructuring default-parameter `undefined`-check that routes
  `__any_strict_eq(arg, <non-string tag-5 box>)` and depends on
  always-false. Root cause NOT yet traced to the emitting line — that
  tracing is slice S2, and it gates S3. (History: #1888 eject,
  reshape record in memory `project_2040_tag5_classifier_dstr_default_regression`;
  successor issues #2626/#2580 M2.)

**Why honest boxing alone flipped −794 (#1888 incident mechanics):** with
the lie, every externref-boxed value lands in ONE tag bucket, so eq/typeof
consumers only ever see both-tags-5 and are (accidentally or deliberately)
tuned for it — including the compiled test262 harness comparator
(`isSameValue` shapes; native `===` tag-dispatch `binary-ops.ts:2255-2320`,
#1776). Honest boxing splits the bucket: the same JS value boxed via two
routes (literal fast-path vs generic vs `__any_from_extern`) lands in
different tags, and every `tagA != tagB → 0` gate flips answers wholesale.
Mixed-regime incoherence — not honesty itself — is the −794. Hence the
ordering law: **consumers first, one flip, then retire.**

### B. Design — true-tag discipline (the #1916 two-regime model)

Normative rule: a consumer of `$AnyValue` may trust tags
`{0,1,2,3,4,6,7}` (only honest producers write them). Tag 5 is the
AMBIGUOUS tag until S4; its true class is a runtime function of field-4:

```
trueClass(box.tag==5, x = box.externval):
  x == null                → Undefined   (null/undefined merged pre-#2106)
  ref.test $BoxedNumber x  → Number
  ref.test $BoxedBoolean x → Boolean
  ref.test $AnyString x    → String      (native-strings; host mode: js-string)
  else                     → Object      (host-opaque / GC object / closure)
```

One emitter, `emitTag5TrueClass` (any-helpers.ts, shared by all consumers;
the generalization of the guards that already exist piecemeal in
`tag5StringEqThen`/`stringyOperand`/`__any_to_f64`). Consumers dispatch on
the true class; when producers become honest the tag-5 arm sees only real
strings and the classification arms become dead — retired in S5, restoring
plain tag dispatch (V1 established).

The two regimes coexist from S1 (like #1916's dual-regime id spaces):
`honestAnyBoxing` OFF = today's lie (default until S4); ON = HONEST
classification at box time writing the true tag (null→`$undefined` tag-1
singleton, `$BoxedNumber`→tag 3 unboxed f64, `$BoxedBoolean`→tag 4,
`$AnyString`→tag 5, other eq-castable GC ref→tag 6 identity in refval, else
tag 6 with the externref parked in externval — note: tag-6-with-externval
is today only produced by hosts; consumers of tag 6 must read
refval-else-externval, audited in S3). As-built (S1): rather than a new
helper, the honest arms live as a flag-gated regime branch INSIDE
`__any_from_extern` (null + fallback arms), and `boxToAny`'s externref arm
calls it under the flag — one helper covers BOTH producer chokepoints, and
the plain-standalone runtime-recovery path becomes honest under the same
flag for free. Every consumer slice must keep BOTH regimes green;
per-slice merge_group proof is the gate.

### C. Slices (each an independently green PR with its own proof)

- **S1 (landed in this PR):** design (this section) + `honestAnyBoxing`
  plumbing (CompileOptions → compiler.ts → create-context.ts →
  context/types.ts, default off) + the honest `__any_from_extern` regime
  arms + probe suite `tests/value-repr-tag5-abi.test.ts` (44): (a)
  flag-absent vs flag-false SHA-identical binaries per lane (inertness);
  (b) flag-on exercised proof; (c) a 10-shape × {legacy,honest} ×
  {fast,plain} measured behavior-PIN matrix — known-wrong pins are the
  migration ratchet that flips as S2-S4 land; (d) the "honesty may only
  fix, never break" pin-table invariant. Measured S1 win:
  `typeof (obj as any)` through the generic path answers "object" under
  the honest regime in fast standalone (legacy: "string"). Documented
  pre-existing wrongs (both regimes, S3 backlog): `undefined===undefined`
  via any locals in plain standalone → false; laundered
  `undefined === undefined` in fast → false (mixed-provenance cross-tag).
  `emitTag5TrueClass` (the shared consumer-side classifier) deferred to
  S3 where its first consumers land.
- **S2 (verification slice — LANDED 2026-07-04, fable-tag5): root cause
  REWRITTEN by the evidence.** The presumed "dstr default-parameter
  undefined-check relying on always-false tag-5 eq" DOES NOT EXIST. WAT
  trace of the compiled canary: the ONLY `__any_strict_eq` callers in the
  module are the three `isSameValue` sites of the test262 harness — nothing
  in the dstr/generator lowering calls it. Actual mechanism (probe-verified):
  1. The dstr fixture `var iter = function*() { iterations += 1; }();` is an
     anonymous generator EXPRESSION — excluded from the native lazy lowering
     (`isNativeGeneratorCandidate` requires `decl.name`; the test262 wrapper
     additionally makes every generator nested+capturing, #2203) — so it
     takes the EAGER-BUFFER path, which runs the whole body AT CREATION.
     `iterations` is already 1 before any `next()` (probe: `return
     iterations*100+7` right after the fixture → 107). The test is latently
     failing.
  2. The harness comparator masks it: `isSameValue(a: any, b: any)` params
     ride the externref ABI and are boxed per-use via `__any_box_string`
     (the tag-5 lie). Legacy tag-5 non-string eq = `0` ⇒ every lie-boxed
     value is SELF-unequal (fake NaN) ⇒ `a === b || (a !== a && b !== b)`
     is TRUE for EVERY pair of lie-boxed operands — a vacuous pass
     regardless of values.
  3. The classifier arms make self-compare honest (bisect re-confirmed:
     numeric `f64.eq` AND object `ref.eq` EACH independently flip the
     canary), closing the vacuity escape and UNMASKING the latent failure.
     The −162 was never eq breaking dstr; it was honesty revealing an
     eager-generator bug.
  Relying-site fix = **#3032 lazy-first-resume generator thunks** (landed
  with this slice, zero-param expression wave): the eager sequence is
  flag-wrapped; creation returns a lazy thunk generator
  (`__create_generator(<self closure>, null)`); the host materializes on
  first `next()` via `__gen_set_eager`/`__call_fn_0`; `return`/`throw`
  before first resume never run the body (§27.5.3.2). Deliverable MET:
  canary + siblings green with the classifier force-enabled, and the
  24-file class/dstr `dflt` sample behavior-identical under the default
  legacy comparator (18 pass / 6 fail before and after the lazy fix).
- **S3:** eq true-class arms — **classifier now IN-TREE behind
  `tag5ValueEqClassifier` (CompileOptions, default OFF; env
  `JS2WASM_TAG5_CLASSIFIER=1` defaults it on for whole-runner A/B), landed
  with S2**: both-tags-5 arm dispatches Number×Number → `__any_to_f64` +
  `f64.eq` (NaN self-false preserved); String×String → content eq (existing
  `tag5StringEqThen` core); Object×Object → `ref.eq` (identity,
  #2585/#2734); else legacy `0`. S3-remaining:
  (a) flip the default ON — gated on enough #3032 waves that the standalone
  floor A/B clears (the flip's "regressions" are unmaskings of still-eager
  generator shapes; `gen-meth-*` method generators are the known residue,
  #3032 W4 — the 24-sample flip delta is 4 fails / 2 fixes, all gen-meth);
  (b) the OTHER tag-trusting consumers (`__any_typeof` tag-5 arm,
  `typeof-delete.ts` direct tag-list, `__json_stringify` tag-5 arm,
  `dyn-read.ts` routing) via a shared `emitTag5TrueClass`;
  (c) NEW S2 finding — mixed-provenance equal numbers (tag-5 `$BoxedNumber`
  × honest tag-2/3) compare UNEQUAL in strict eq: the classifier fixes the
  both-tags-5 cell only; the cross-tag cell needs the Number true-class
  admitted into `__any_strict_eq`'s numeric-class gate (the other half of
  isSameValue honesty — measure as its own slice; the historical "14
  regressions" verdict against cross-tag broadening predates the lazy fix).
  Full merge_group + standalone floor + the −162 canary cluster explicitly
  re-run on the flip.
- **S4 (the flip):** `honestAnyBoxing` default ON for standalone/wasi +
  `__any_from_extern` fallback honesty (objects → tag 6; the
  `__extern_strict_eq` identity fast-path becomes redundant, kept one
  release). Proof: full standalone test262 A/B vs baseline — the issue's
  acceptance run. Host/gc mode unchanged (externref stays host-owned).
- **S5 (retire):** classification arms removed from consumers (tag
  trustworthy = V1), flag removed, `__extern_strict_eq` workaround +
  `dyn-read.ts` partial tag table cleaned, spec §2.1 marked satisfied,
  drift gate: a `check:`-style assert that no `__any_box_string` call
  site receives a non-string-typed operand (grep ratchet à la
  `check:any-box-sites`).

### D. Verification protocol (half the work)

- Flag-off byte-identity (S1) — the compile probe asserts SHA equality on
  a corpus of representative programs, proving zero dark-launch risk.
- Per-slice merge_group (never scoped-sweep-only — the −162 lived in a
  cluster the scoped A/B missed; memory `project_broad_impact_validate_full_ci`).
- The `it.fails` ratchet in `tests/value-repr-tag5-abi.test.ts` — every
  slice flips its probes to passing; a probe that UN-flips is an instant
  local regression signal.
- Acceptance (issue header): `String(undefined as any)`,
  `typeof (true as any) === "boolean"` (needs the P2 boolean-brand hint at
  the generic boxing site — S4 acceptance includes it via `jsType` seam),
  `isSameValue` buckets unchanged.

## Implementation Plan addendum (Fable, 2026-07-18) — re-ground: S3a is DONE; S3b/S3c/S4 are the remainder, and three consumers now wait on S4

### Verified flag state (current main, `context/types.ts`)

- `tag5ValueEqClassifier` — **default TRUE** (`:121`): the S3(a) "flip the
  default ON" landed via **#2040 A1** (`46be13726d`), enabled by the #3032
  lazy-generator waves (W4 method generators included). The −162 canary
  cluster is history; the classifier is production.
- `honestAnyBoxing` — **default false** (`:2404`): S4 (the flip) has NOT
  happened. This is now the single remaining regime flag on this issue.
- `undefinedSingleton` — **default TRUE** (#2106 flipped; the #3331 audit of
  the singleton null-guard bug class is `done`): the S1 design's
  "null/undefined merged pre-#2106" premise in `trueClass` is STALE — under
  the shipped regime undefined is the tag-1 `$undefined` singleton and null
  is `ref.null.extern`. The S4 honest-boxing arms must classify against the
  singleton (∨ UNDEF_F64 box), not `x == null` alone — re-verify the
  `__any_box_extern_s1` nullish arms compose with full honesty.

### Remaining ladder (unchanged structure, re-scoped content)

1. **S3b (M)** — the shared `emitTag5TrueClass` consumer sweep, exactly as
   spec'd in §C: `__any_typeof` tag-5 arm, `typeof-delete.ts` direct
   tag-list, `__json_stringify` AnyValue arm, `dyn-read.ts` routing,
   `__any_unbox_extern`. Each conversion is flag-independent (true-class
   dispatch is correct under BOTH regimes) — land before S4 so the flip
   changes producer tags only, never consumer behavior.
2. **S3c (M, own slice + own measurement)** — the cross-tag numeric cell:
   admit the tag-5 `$BoxedNumber` true-class into `__any_strict_eq`'s
   numeric-class gate so mixed-provenance equal numbers compare equal. The
   historical "14 regressions" verdict predates the lazy-generator fix —
   re-measure, don't trust it.
3. **S4 (the flip)** — `honestAnyBoxing` default ON for standalone/wasi.
   Full standalone A/B vs the 2026-07-18 baseline (24,726). Note the
   census signal: the `assert.sameValue(rest.x, undefined)` signature family
   (~109 gap rows, #2860 census) is a candidate direct beneficiary —
   tag them as the flip's expected-win list so the A/B is judged against
   named rows, not just the net.
4. **S5 (retire)** — unchanged, plus retire `tag5ValueEqClassifier` as a
   flag (its OFF regime becomes dead once tags are trustworthy).

### Downstream dependents now blocked on S4 (coordination — reference, do not fork)

- **#745 S5** (default-lane `unionAnyRep` flip) is HARD-GATED on this issue
  (recorded in #745's Design Decision). #745 S2–S4 landed 2026-07-16 — the
  standalone-lane union carrier is proven, so this issue is the critical
  path for the default-lane half.
- **#3053 U3b** (harness-comparator param-carrier migration) targets the
  same comparator seam this issue's −788 lesson protects; if S4 lands
  first, U3b's operands arrive honestly tagged and its scope shrinks —
  sequence-check with the #3053 owner before either lands.
- **#2763** (instanceof value-rep) consumes only the carrier, not the flip
  — no gate, see its 2026-07-18 plan.

The four-seam do-not-touch table in
`plan/issues/3053-unified-dynamic-reader-carrier-substrate.md` remains the
normative hazard map for every slice here; S4's flip is the ONE sanctioned
change to seam 1, taken as a producer-side regime change with S3b/S3c
already making consumers regime-agnostic.
