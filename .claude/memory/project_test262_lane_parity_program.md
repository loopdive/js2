---
name: project_test262_lane_parity_program
description: "Active program to bring test262 js-host and standalone lanes to the same pass rate by fixing BOTH lanes' real defects (user directive 2026-07-19)"
metadata: 
  node_type: memory
  type: project
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
  modified: 2026-07-23T11:58:29.375Z
---

**User directive (2026-07-19): "fix both lanes."** Goal = js-host and standalone test262 lanes reach the same pass rate via TRUTH — fix each lane's real defects, not by leaving bugs in to keep numbers matched.

**CURRENT NUMBERS (2026-07-21 baseline, oracle v9 — supersede the stale 24,883/57.7%):
standalone official lane = 28,138 / 43,106 (65.3%)**, up from 24,883 after F2 landed
(24,883 → 27,378 at the #3469 promote, of which +2,284 came from the async cohort).
Host ≈ 28,373. The gap is now much smaller than the original "~14,600 divergent" framing.

Root-caused via 3 investigation agents (full detail: `.tmp/parity-findings.md`). ~14,600 divergent tests collapse to ~4 concentrated fixes + a long tail:
- **F1 (DIAGNOSED, issue #3468 `blocked` → architect-spec):** NOT an exception-swallow (that hypothesis is a NO-OP). Real cause: standalone function objects can't carry own properties → `assert.*` methods read undefined → never invoked → assert failures pass vacuously → SA floor INFLATED. Fix is a FEATURE (approaches A/B/C in #3468); floor impact MIXED, flip count uncomputable until built; needs stakeholder floor-rebaseline. See [[reference_standalone_floor_inflated_by_exception_swallow]].
- **F2 — ✅ DONE (landed #3469 / PR #3416, merged 2026-07-19).** Do NOT re-dispatch it (a
  2026-07-23 dispatch nearly rebuilt it; the agent verify-first caught it). Standalone stdout
  sink (`__stdout_prepare`/`__stdout_char`) + `__drain_microtasks()` drive, wired in
  `scripts/test262-worker.mjs`, `tests/test262-runner.ts`, `tests/test262-shared.ts`.
  **Measured honest split** (cohort = 3,258 formerly-unscorable "async completion marker not
  observed" tests — the old "~2,024" was an UNDER-count): **2,271 pass / 985 fail / 2 CE / 8
  marker** on the 07-21 baseline. Marker bucket collapsed 3,258 → 8.
  **The 985 honest FAILs route to existing trackers** (this is the standalone work queue):
  280 "value is not iterable" (#3178 family) · 159 null_deref async continuation (#3442/#2865) ·
  111 Cannot destructure/access · 88 module-init trap (#1781) · 69 own-property (#3468/F1) ·
  33 illegal_cast (#3443) · ~27 promise_error (#2903/#3390). Residual 8 = never-settle Promise
  semantics (#3390/#2903), channel not at fault.
- **F3 — ✅ LANDED 2026-07-23 (PR #3501, child issue #3535, under #2860).** Standalone lane now
  compiles with `deferTopLevelInit` so `(start)` throws render via the #2962 path.
  **The masked bucket was 8,610 rows, NOT ~2,400** — the old figure was only the
  host-pass∩SA-fail slice. Validation: 152-row stratified masked sample → 0 verdict flips,
  152/152 un-masked to real signatures; 7 runtime-negative masked rows → 6 honest fail→pass;
  101-row sample of the 29,410 PASSING rows → 0 pass→fail (floor safe). Oracle-version-EXEMPT
  (same precedent as the #3123 host arm; `check-verdict-oracle-bump` passes) — no
  ORACLE_VERSION bump, cf. [[reference_verdict_logic_change_must_bump_oracle_version]].
- **F4 (in flight, `fix-host-nameLength`):** host verifyProperty name/length realm-restore, ~370 clean host flips. Extends #3318.

## ⚠️ BROAD-IMPACT DEFECT found 2026-07-23 — under-applied + literal-applied params (#3548)

`function d(x){...}; d('m'); d();` **TRAPS in standalone.** When a module function is called
BOTH with a string literal AND with zero args, the param is inferred as a **non-nullable**
native-string ref, and the zero-arg call site fills the missing argument with
`ref.null` + `ref.as_non_null` → an **unconditional trap on the ZERO-ARG (usually PASS) path**.
Two-line module-scope repro above; RuntimeError in `__module_init`.

This is **optional arguments** — among the most common shapes in JS — and the lead PREDICTED it
would be "the largest defect on the board". **MEASURED: it is not.** A static candidate scan over
ALL 18,570 failing standalone rows found **~106 candidates**, 98 of them in `built-ins/Promise`
(the `$DONE('msg')`/`$DONE()` harness template); realistic ceiling ≈ the 193 async cluster plus a
small tail. **Hundreds, not thousands** — most non-async shapes never call zero-arg. Worth fixing
anyway on SOUNDNESS grounds (a documented-but-false assumption emitting a guaranteed trap; and
optional args are ubiquitous in real user code even where the corpus doesn't exercise them) — but
justify it that way, never by corpus yield. **Lesson: the lead's hypotheses need measuring too;
this one was corrected by the agent, not the reverse.** Fix-direction caution:
"make the fill nullable" vs "don't narrow the param to non-nullable" have very different blast
radii — the latter is adjacent to the closure never-narrow principle, which is deliberately
scoped to closure VALUES only (declared-function param narrowing is a hot-path optimisation;
see the #3536 arbitration).

## 🔑 "ECHO-SIGNATURE" — why cluster labels keep pointing at the wrong subsystem

**The reported error signature is frequently produced DOWNSTREAM, by whatever code reacts to the
defect — not by the defect itself.** Confirmed repeatedly on 2026-07-23:
- "Cannot destructure/access" (~130 rows) — manufactured by the TEST TEMPLATE's rejection
  handler destructuring a **null rejection reason**; real bug = an unfinished #1326 `catch_all`.
- "async continuation threw / null deref in `__then_*`" (~193 rows) — looked like promise
  machinery; real bug = the arity-fill trap above, which merely SURFACES wherever the zero-arg
  call happens to sit.
- "regexp `.index`" — `exec().index` provably works; label was a mirage.
- error-ctor-identity "mega-lever" — the dynamic `assert.throws` path is fine; only a narrow
  static-reference shape breaks.

**Practical rule:** never dispatch or size off a cluster LABEL. Trace to the emitting site
(WAT/instrumentation) first; expect the subsystem named in the message to be innocent.

## De-masked signature census (2026-07-23, post-F3) — THE standalone dispatch queue

Stride-8 sample (1,077 rows) of the 8,610-row masked bucket, ×8 extrapolation. Weighted by
**addressable fail→PASS potential**, NOT raw count (skips sit in the landing-% denominator, so
fail→skip is %-NEUTRAL — never rank a ladder by raw cluster size):
- **addressable ~4,125** · zero-value skip-feature ~2,390 (Temporal, eval #2928, `with`/annexB
  eval-code, SAB, ShadowRealm, `$262.*`) · routed→#3468 own-property ~1,591 ·
  routed→async ~480 · now-pass drift ~24.
- **Addressable ladder:** Array/prototype ~664 (#3169/#3170/#3180/#3185) · TypedArray/prototype
  ~520 (#2872/#3177) · **RegExp/property-escapes ~311 (single signature, was UNOWNED)** ·
  TypedArrayCtors ~168 (#3177) · defineProperty ~160 + defineProperties ~144 + create ~64
  (#3251/#2984/#2992) · String/prototype ~104 (#2875) · Iterator/prototype ~80 · class ~128 (#2873).

**RESOLVED 2026-07-23 → PR #3503 (#3536), plus a CRITICAL measurement lesson.** The bug:
standalone-only, a top-level `function f(args){ args.x }` **DECLARATION** called with an
**object-literal argument** read `args` as **null** (function-EXPRESSION form passed; host
passed). Two defects: (a) narrowed-param vs dynamic-literal-arg mismatch — fixed by forwarding
`expectedType` into `compileObjectLiteral` (literals.ts + expressions.ts only); (b) the
invalid-Wasm mirror was the **IR overlay patching a top-level function's SIGNATURE after legacy
callers had baked coercions** — the patch-time parity guard had a documented-but-FALSE exemption
for top-level FunctionDeclarations.

⚠️ **THE LESSON — NEVER size a claim by extrapolating a signature share.** The
"positional null-deref signature = 149/516 of the addressable sample (~29%)" reading projected
**~1,190 flips**. Measured reality: **2 direct flips out of 198** — a ~600× over-estimate. A
shared error SIGNATURE says nothing about a shared ROOT CAUSE. Always re-run the real files
post-fix and count actual flips before sizing. (Same family as
[[reference_host_restore_triage_verify_first_measure]] — cluster labels over-count.)

## 🔑 "LAYERED GATES" — a MEASURED gate still does not predict flips (2026-07-23)

Even when you have *measured* that every row in a cluster executes one defective function, fixing
it may yield **zero flips** — because the next layer down is also broken. Property-escapes proved
this twice in one day: 311 rows → gated on #3536 (param/arg boundary) → fixed → gated on #3541
(`String.fromCodePoint.apply`) → fixed, verifiably (7/7 probes, 8/8 tests) → **0/311 flips**,
because 304 now die deeper at `RangeError: regular expression step limit exceeded` in the native
RegExp engine (`^\p{…}+$` over multi-thousand-char subjects; #3549).

**Rule:** "gates N rows" ≠ "will flip N rows". Only a post-fix re-measure settles it. Budget
multi-layer families as a CHAIN of unknown length, and never promise the row count of the
outermost layer. Each layer can still be a genuine correctness fix with value outside the family
(both #3536 and #3541 were) — so this is not wasted work, but it must not be sold as flips.

**The 311 property-escapes rows were gated on #3541** —
`String.fromCodePoint.apply(null, vec)` returns null (`__str_concat` null-deref; reproduces at
plain top level on main, no functions involved) + an illegal-cast sibling in the same
`buildString` harness function. All 311 rows execute that one function, so this is a MEASURED
gate, not an estimate. The other 138 re-measured null-deref rows are TypedArray-internals
(#2872/#3177 lane).

**#3468 family is BIGGER than its 3,608 cliff — and the fix nets POSITIVE.** On top of the
3,540 exposed failures, the family also gates ~1,591 masked own-property rows (now visible
post-F3) and ~368 "Cannot convert undefined or null to object" rows (shapes
`prop-desc/name/length.js` — builtin METHOD-AS-VALUE reads feeding `verifyProperty`; fixing
their own edge merely converts them INTO the own-property signature = fail→fail, %-neutral).
So judge #3468 on cliff-cost vs family-upside, never on the drop alone.

**Sequencing:** F2+F3 are observability fixes — they UN-MASK/UN-BLOCK ~4,447 tests, after which the REAL standalone signatures become visible. Triage the tail (~4,600 heterogeneous real HOST bugs → #3417; remaining SET-2 standalone feature gaps: host_import_leak/null_deref/illegal_cast/Reflect → #2860 children) AFTER the observability fixes land, so triage works off honest signatures. Trackers: #2860 (standalone-gap umbrella), #3417 (oracle-v8 reclassification), #3178 (async retirement).

v0.61.0 release notes were CORRECT at release (standalone genuinely ~10% / 4,312 then); standalone has been genuinely fixed up to ~57.7% since (user-confirmed 2026-07-19). No release-notes correction needed. NOTE: current 57.7% is itself partly inflated by the F1 exception-swallow vacuous passes — fixing F1 lowers it toward the true number.
