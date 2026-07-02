---
id: 2141
title: "Retire the tag-5 box-the-externref ABI: make consumers tag-agnostic, then allow honest generic boxing"
status: in-progress
assignee: ttraenkler/dev-evalf
sprint: current
created: 2026-06-12
updated: 2026-07-02
unblocked_note: "2026-07-02: blocked_by #2167 (Fable disabled) is done — Fable restored; flipped on claim per owner directive (task #32)."
priority: high
feasibility: hard
reasoning_effort: max
model: fable
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
- **S2 (verification slice):** root-cause the dstr reliance. Faithful
  `runTest262File` standalone canary
  (`language/statements/class/dstr/meth-dflt-ary-ptrn-empty` + siblings),
  WAT trace of the `__any_strict_eq(arg, non-string-tag-5)` call, identify
  the emitting lowering line. Fix the RELYING SITE (dedicated
  is-undefined test or honest producer at that lowering), NOT by keeping
  eq wrong. Deliverable: canary green with the numeric+object eq arms
  force-enabled locally. PITFALL (memory): trust the faithful runner, not
  hand-rolled repros; the floor only runs in merge_group.
- **S3:** eq true-class arms — both-tags-5 arm of `__any_eq`/`__any_strict_eq`
  dispatch on `emitTag5TrueClass` pairs: Number×Number → `__any_to_f64` +
  `f64.eq` (NaN self-false preserved); String×String → content eq (existing
  `tag5StringEqThen` core); Object×Object → `ref.eq` on
  `any.convert_extern` (identity, #2585/#2734); Undefined×Undefined →
  true; mixed → false (strict) / loose-eq coercion rules unchanged.
  Also: `__any_typeof` tag-5 arm, `typeof-delete.ts` direct tag-list,
  `__json_stringify` tag-5 arm, `dyn-read.ts` routing → same classifier.
  Requires S2 landed. Full merge_group + standalone floor + the −162
  canary cluster explicitly re-run.
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
