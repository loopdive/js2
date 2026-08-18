---
name: project_next_session
description: Sprint 78 closed 2026-08-18 (see the handoff section at the top). RESOLVED 2026-07-24 — fable-tier backlog UNBLOCKED by Opus 5 (frontier tier), dispatched in sprint 77. This file remains the authoritative fable-tier backlog + priority order; the "suspended" framing below is historical.
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-18T19:20:00.000Z
  originSessionId: a3d6eeff-28b8-4096-ad2f-4e98df2f82bf
---

# SPRINT 78 HANDOFF — 2026-08-18

**Git**: window frozen at `1e6deeefe` (branch `claude/pull-from-origin-un3eun`,
draft PR loopdive/js2wasm#4647). Main tip at freeze: `9896af5d7`.

**test262**: 32,615 / 43,621 (74.8%), from `benchmarks/results/test262-current.json`.
**No window delta is on record** — the wrap-up ran in a shallow clone
(2026-08-15 → 2026-08-18) and the window opened 2026-07-30, so the start value
was unreachable. Do not synthesise one; take it from a full clone if needed.

**Window**: 293 done, 490 rolled forward as `sprint: current`. Nineteen days
against sprint 77's 79 completed.

## Still open after this wrap-up

- **`sprint/78` tag is NOT pushed.** It exists locally at `1e6deeefe`. The push
  is rejected **HTTP 403** — not the egress proxy (`recentRelayFailures: []`),
  so this session's credentials permit branch pushes but not tag creation.
  `wrap_checklist.end_tag_pushed` is `false` and accurate. Needs someone with
  tag permission.
- **PR #4647 is a DRAFT**, and `auto-refresh-prs` skips drafts while
  `auto-enqueue` never takes them — it will not reach the merge queue until it
  is marked ready for review.
- **#3764 is still `complete`, not `done`**, deliberately. Its suite fails 2/3
  on main; one failure is real (standalone `importObject` is not `{}` — it
  carries `env` plus a populated `string_constants`). Either fix it or demote
  the issue, but do not promote it on the status token.
- **The freeze-script frontmatter bug is only patched, not fixed.**
  `freeze-sprint.mjs` writes sprint docs with no frontmatter, so the next window
  reintroduces `isClosed=false`. Sprint 78's doc got `status: closed` by hand.

## Key learnings

- **`complete` is not a status any tool understands.** `build-data.js`
  normalises `in_progress`, but nothing normalises `complete`, and
  `freeze-sprint.mjs` matches `status === "done"` exactly — so a finished issue
  spelled `complete` rolls forward as unfinished, every window, invisibly.
  Five were found this window; four were verified and promoted.
- **Three separate defects, one absence:** nothing validates issue or sprint
  frontmatter against `SCHEMA.md`. CI already walks every issue file for
  `check:issue-ids:against-main`. Reconcile the schema first — it lists
  `review` while practice and 17 live issues use `in-review`, and `suspended`
  is unlisted.
- **`sync-sprint-issue-tables.mjs` has no owner.** It rewrote 16 docs (+752
  lines) of accumulated drift. No workflow calls it, so unlike the test262
  baseline or `npm-compat.json` it never self-heals.
- **The budget trigger cannot fire off-host.** `freeze-sprint.mjs` reads the
  statusline's weekly cache, which does not exist in a remote container, so it
  always reports a fresh window and always refuses. Any off-host freeze is a
  `--force` judgement call — worth an elapsed-time trigger alongside it.

---

# FABLE-TIER WORK — UNBLOCKED 2026-07-24 (sprint 77, Opus 5)

> **RESOLVED.** The suspension below is historical. Opus 5 is frontier-tier and claims
> `model: fable` issues directly ([[feedback_opus5_is_frontier_tier_claims_fable_tasks]]),
> so this backlog no longer waits on a Fable restore. Sprint 77 (tag `sprint-77/begin`,
> `bb5b414`) dispatched **#2984 descriptor-MOP slice** and **#2864 D4** to Opus 5 senior devs.
> Budget bound at dispatch: ~20% weekly remaining / 5.6d ⇒ XL epics ship as SLICES, fleet
> capped at 2. The backlog + priority order below remains authoritative for what comes next.

## (historical) FABLE WORK — SUSPENDED 2026-07-24

**Why:** Fable 5 hit its account-wide rate limit ~2026-07-23 23:45. The two Fable agents
(dev-laneB-1, f1-deinflation) died mid-flight; the Opus fleet carried the lighter Lane-A/
hygiene queue after. User: **Fable work resumes tomorrow in a new session.**

## ✅ NOTHING STRANDED — verified before suspend
- **dev-laneB-1** worktree `agent-a42de41e26f735261`: branch `issue-2864-d4-yieldstar-catch-regions`
  exists but **0 commits ahead, 0 uncommitted** — it died at the verify-first step, before writing
  any D4 code. The branch is an empty reservation; resume by branching FRESH off origin/main.
- **f1-deinflation** worktree `agent-a4bf4b12b352cec41`: branch `issue-3468-f1-harness-routing`
  fully merged (F1 LANDED #3523). Nothing to preserve.
- No unpushed Fable branches. All Fable work is either LANDED or NOT-YET-STARTED. Resume is
  from the issue files (which carry the grounding/measurements) + this backlog.

## FABLE-TIER RESUME BACKLOG (priority order, all measured this session)
1. **#2864 D4** [ready/fable] — sync-generator **try/CATCH across yield** convergence onto the
   CFG machine (the planner-convergence trigger; F2-deferral). Grounded in the issue (`## D4`
   section). Branch name `issue-2864-d4-yieldstar-catch-regions` was reserved (empty).
   **START with verify-first** (dev-laneB-1's last words): "what do sync generators with
   try/catch-across-yield actually do on the current stack — the F2-deferral note may be STALE
   given #3050's machinery." Prereq (#2906 3c async try/catch stack) is COMPLETE (#3522/#3524/
   #3526/#3527 all landed), so D4 is unblocked.
2. **#2773** [ready/fable] — [EPIC][ARCH] value-rep substrate. The umbrella for the "any-passage"
   family below. Likely needs an architect pass first.
3. **#3557 residual** [in-progress/opus — but residual is #2773/Fable] — the boolean-i32 contained
   fix LANDED (#3529, −44% on the quirk). RESIDUAL = brand-loss through `&&`/`||` with any-typed
   method-call operands + boolean-local storage: `optional` 6,427 + `generator` 354. This is the
   #2773 "any-passage" slice. Kept #3557 open tracking it.
3. **#2001** [ready] — sparse holes S3. MEASURED: headline unfixable (`[1] as any[]` lowers to an
   f64 vec, not externref = accepted-divergence typed bucket); the reachable externref case is a
   #2773 index-grow type-flip (assignment.ts rebuilds vec as f64). #2773 substrate.
4. **#3420** [ready/fable] — frozen-array element write. RE-SCOPED (#3535): tractable slice = the
   2-test filter/map `Symbol.species` result-backing bug; general frozen-array-write needs the
   **#2744 extensibility-slot substrate** on the vec rep.
5. **#3559** [ready] — F1's exposed 4-CE bug: nested-lifted-fn call from a method-call-arg callback
   corrupts the callback's capture prologue (cross-fctx `local.get cap.outerLocalIdx` in
   `call-identifier.ts`). The **#1177-revert minefield** (naive localMap-first fix caused 100+
   regressions historically). Repro in the F1 worktree's `.tmp/repro-min.mjs`.
6. **Other substrate** [ready]: #3406 (dynamic any-callee zero closure candidates, reasoning_effort
   max, high-conflict), #3475 (defineProperty externref/dynamic-shape prop, contested senior-dev
   lock), #2933 (standalone Math/JSON/Reflect/Atomics namespace static), #3166 (class fields with
   runtime computed properties), #3024 residual (invalid-Wasm emission residual).

Full recipe for the F1-style baseline landings: [[reference_f1_honest_floor_deinflation_landing_recipe]].
Measure-discipline reminder: [[feedback_measure_never_extrapolate]] (validated 3× this session —
every regression bisect refuted the "landed today" hypothesis).

## LANDED THIS SESSION (13+ PRs) — for context
F1 honest floor de-inflation (#3523, 31,188→27,557 @ oracle v10) · acorn regression fix (#3520) ·
#2906 async try/catch 3c-i/ii/ii-b/iii (#3522/#3524/#3526/#3527) · #2864 D2 (#3519) · boolean-i32
contained fix (#3529/#3557) · 2 stale guard tests (#3525) · guard suite (#3514) · #3468→done
(#3528) · hygiene reconcile #3379/#3375→done, #3466→superseded, #3420 re-scope (#3535).

## OPUS FLEET (as of suspend) — lighter Lane-A/hygiene queue
- dev-opus-2 → #3439 (classify 186 standalone fails + ratchet unclassified gate 300→0, Lane-A).
- dev-opus-3 → #3437 (deterministic pre-merge compile-time budget gate, Lane-A/ci.yml).
- dev-opus-1 → winding down after #3531(merged)/#3534/#3535 land + the #3105 re-scope follow-up.
- In-flight PRs to shepherd to merge: #3530/#3532/#3533 (queue), #3534/#3535/#3439/#3437.

## RESUME-DAY WATCH ITEMS (landed/landing at wind-down)
- **#3439 flipped the unclassified-root-causes gate to hard-0** (test262-sharded.yml:855, PR #3537).
  Zero margin: any NEW/transient unclassified standalone signature will PARK a merge_group PR
  (designed — fix by CLASSIFYING the new signature into STANDALONE_ROOT_CAUSE_BUCKETS in
  `scripts/build-test262-report.mjs`, NOT by reverting). If a PR parks on this tomorrow, that's why.
- **Pre-existing guard-test failures to reconcile** (not regressions, flagged this session):
  `tests/issue-2961.test.ts` ×4 (standalone host-import leak-scan: `__str_from_mem`/
  `console_log_string` emission). Same "vacuous/stale/invisible guard test" family as #3558.
- **Stale-status reconcile — mostly DONE this session:** #3375/#3379→done + #3466→superseded
  (via #3535); #3392→done (via #3538); #2043 false-DONE→reopened (via #3541). **Remaining:**
  **#3449** (false-READY: fix `9761b20` landed but didn't cite it → issue still `ready`).
  Note the GAP: the #3474 done-status gate catches false-**done** (done but tests fail), NOT
  false-**ready** (ready but fix landed) — a complementary "false-ready" detector (issues `ready`
  whose acceptance is met / no failing cites) is a worthwhile future enhancement.
- In-flight at wind-down (should be merged by resume): #3534/#3535 (dev-opus-1), #3537 (#3439),
  #3536 (#3437), #3532 (#3404). #3105 re-scope follow-up lands after #3534.

## STANDALONE PASS-RATE SPRINT (2026-07-24, user-directed 4-Opus team) — DEFINITIVE FINDING
**All 4 standalone lanes independently MEASURED their contained-surface exhaustion, converging on
ONE root: the value-rep substrate family (fable-tier).** This is the empirical answer to "biggest
gaps + how much can Opus lift standalone."
- **Delivered (Opus, measured/clean) — SPRINT COMPLETE, ~+47 contained flips, 0 regressions:**
  #2875 String-ROC +6 (#3544), #3177 TypedArray of/from +12 (#3546), #3570 Number `+`-radix parse +3
  (#3552), #3569 JSON well-formed stringify +1 (#3553), issue-2079 +1 (#3550), #3554 WeakMap/WeakSet
  iterable-ctor +18 (biggest slice), #3555 Set/Map.forEach non-callable +5, #3556 Promise instanceof +1
  (queue pos 1). Plus #3015 (Array dyn-callback #3545), #1325 Date/RegExp instanceof (#3547), #680
  generator restoration, #3562 Array.isArray byte-carrier (#3549). Reconcile #3548. **Every one of the 9
  built-in lanes measured to exhaustion (Array/TypedArray/Number/String/Date/Math/JSON/Object/Reflect/
  Map/Set/Symbol) — the +47 IS the measured ceiling of Opus-contained standalone lift above the substrate.
  Fleet fully wound down on measured exhaustion (not premature — all lanes swept).**
- **The WALL (measured by 4 lanes):** dev-std-1 Array, dev-std-2 TypedArray+Number, dev-std-4 String
  all bottom out at the SAME substrate: **#2862** (boxed-primitive/ToPrimitive — `new Object(true).toLowerCase()`,
  `Cannot convert object to primitive value`), **#2868** (RegExp-carrier reflective value-reads,
  ~95 tests), **#2773** (value-rep/any-passage). RegExp-arg family alone = 182 fail, dominantly #2868.
- **Opus contained surface is MEASURED-EXHAUSTED** (dev-std-1/2/4 stood down on verified exhaustion;
  only dev-std-3 instanceof-per-rep has a little runway via #1325b Promise). Remaining Opus-doable is
  ~15-25 fragmented marginal tests. **The bulk of the ~3,000-test standalone gap IS the fable-tier
  value-rep substrate.** → FABLE-RESTORE is the lever for the step-change; Opus harvested the arms above it.
- **MEASURED SUBSTRATE LEVERS (sized per-lane 2026-07-24; census-pending for corpus-wide totals — do
  NOT extrapolate the cross-cutting ones without measuring):** the standalone gap is a FAMILY of
  substrate root-causes, not one. Biggest, by measured size:
  1. **#2773 dynamic-shape descriptors** — defineProperty 476 + defineProperties 326 + create 122 +
     getOwnPropertyDescriptor 34 + hasOwn 14 ≈ **~924 in the Object lane ALONE** (dev-std-6). The single
     largest lever. Real property tables on objects.
  2. **#2984 descriptor-MOP** [XL/hard/fable-spec] — builtin own-property + prototype-method reflection
     (`getOwnPropertyDescriptor(Date.prototype,"getFullYear")`→undefined; prop-desc/name/length).
     **CENSUS DONE (dev-std-6, 4461 propertyHelper.js tests): ~881 HIGH-CONFIDENCE built-in tests**
     (a1 own-prop-absent + a2 desc-attr-wrong), + a ~992 LANGUAGE-test AMBIGUOUS ceiling that must NOT
     be banked on #2984 (there verifyProperty is just the assert harness; the real failure is the
     language feature — class/dstr/async-gen). Top built-in areas: Object 350, TypedArrayCtors 68,
     Array 59, Math 47, NativeErrors 37. **THE single highest-leverage standalone lever** — dwarfs every
     method-family lever (those were ~5 tests each).
  3. **#2744 extensibility-slot** — freeze/seal/isFrozen/isSealed/isExtensible/preventExtensions +
     Reflect.* ≈ **~117 in Object/Reflect** (dev-std-6). Extensibility bit on the vec/object rep.
  4. **Function.prototype.call/apply/bind on builtin methods (uncurryThis / propertyHelper.js blocker)**
     — `Function.prototype.call.bind(Object.prototype.hasOwnProperty)` invocation throws "Cannot convert
     undefined or null to object" in standalone. **CENSUS: 395 total (320 built-in + 75 language), the
     clear #2 lever** (dev-std-6). Top built-in areas: TypedArray 68, Date 53, Symbol 21, Set 18, Number 17,
     Map 14, Atomics 14. Method-as-value/funcref-wrapper substrate (same family as "Array.prototype.map not
     callable as a value"). dev-std-7 filing a tracking issue.
  **PH-WALL TOTAL (a #2984 + b uncurryThis) = 2268 = 70% of ALL standalone fails, 92% of non-unsupported.**
  Fixing the propertyHelper wall = ~1,200 built-in tests high-confidence (881 #2984 + 320 uncurryThis) →
  by FAR the biggest standalone lever, ahead of #2773 defineProperty-family. Excluded from census as NOT
  PH-attributable: unsupported-feature 799 (Temporal 425 dominates), codegen/invalid-Wasm 69.
  5. #2862 boxed/ToPrimitive (82 in Date/Number, dev-std-5), #2868 RegExp-carrier, #2865 async-carrier,
     namespace-reification (#2933 extension: hang static methods as enumerable own props).
  NOTE: #2984 + the call/bind-dispatch lever together = the propertyHelper.js/verifyProperty wall — likely
  the single largest cross-cutting standalone bucket once censused (every builtin descriptor test uses it).
  **Fable-restore priority: #2773 (biggest) + #2984 (cross-cutting, possibly most tractable as a MOP
  mechanism — assess separately from value-rep).** dev-std-6 to run the #2984 corpus-wide census.
- Measure-discipline reconfirmed all session: cluster labels over-count flips 100-600× (slice-6 "150
  rows"→substrate; #680 flip flake-obscured ~±44/lane); trust localized per-cluster measures, not
  whole-corpus subtraction. See [[feedback_measure_never_extrapolate]].
- **3 audit-found OLD invisible regressions fixed contained** (#680 7d, #3562 >20d, +2 stale guard
  tests #3558) + folded into the required guard suite (#3008 closure, now 8 files) — the guard-audit
  program's payoff. Plus the #3474 done-status gate caught #680's false-done in its first real use.

## Budget / box
2026-07-24. Fable EXHAUSTED (restore via `/usage-credits`). Opus ~34% weekly budget.
**Only the FABLE-tier substrate is suspended.** The Opus fleet KEEPS RUNNING on Opus-appropriate
work — Lane-A CI/infra/tooling, hygiene/reconcile, tests, non-codegen sprint tasks. (Lead briefly
mis-wound the fleet down conflating "codegen clean-increments drained" with "no Opus work"; user
corrected — budget feeds the pipeline, don't hoard it. Fleet re-activated.)
