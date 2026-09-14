---
sprint: current
status: active
planned: 2026-06-30
updated: 2026-07-21
---

# Current budget window — FOCUS: complete the IR-only migration

## Stakeholder directive (2026-07-31) — ES5 · Acorn perf · ESLint · React

Supersedes the 2026-07-21 IR-only ordering **for new pulls**. The IR migration
continues as the substrate it always was; these four are what the window is
judged on:

1. **ES5 compatibility** — close the descriptor/coercion/enumeration residual.
   `#3776 #3661 #3662 #3420 #3475 #3663 #3768 #3631` plus the reclaimed
   `#2200 #2668 #2670 #2742 #2747 #2552`.
2. **Acorn performance** — compiled Acorn is still ~400–500× native at real-file
   scale (#3756). `#3756 #3675 #3782 #3780 #3686 #3685 #3684 #3683 #3730`.
3. **ESLint** — ~~continue PR #3687~~. **PR #3687 is CLOSED (2026-07-31,
   stakeholder decision)**: DIRTY, bot park-held (so skipped by the
   `auto-enqueue` backstop and unable to recover on its own), and ~12.9k lines
   of divergence behind `main`. It was mined for slices instead — see the
   carry-over table in `#1400`. `#3655` and `#3672` landed by other routes and
   are **done**; `#3653` measures as substantially already met and needs a
   status reconcile. Remaining: `#3654 #3656 #3657` plus the carry-overs
   `#3798` (the architectural blocker that stopped #3687) and `#3930`.
4. **React** — `#3801`, new: run React's OWN upstream unit tests against
   compiled React. Self-authored vectors share our blind spots.

### Reclaimed stalled work

`#2200 #2552 #2668 #2670 #2742 #2747` sat `in-progress` on closed sprints (64/67
/Backlog) with no open PR and their agents long gone — stalled claims, not live
work. Reset to `ready` and pulled into this window so they can actually be
claimed. See the sprint 77 retro for why stalled claims accumulate.

### Standing rule for this window

Report `passed / attempted / total` with all three denominators. A suite we
control drifts toward vacuity; prove a harness can go red before quoting any
number from it (#3592, #2093).


> **Stakeholder directive (2026-07-21).** Drive the IR migration through an
> IR-only default and retire direct codegen. This supersedes the June 30
> ordering for new pulls. Standalone correctness remains a protected parallel
> lane and a required final acceptance gate; it no longer outranks the
> migration spine.

## Top of the sprint — IR retirement

1. **#3529 (R0a, delivered)** — full equivalence is back to zero new failures
   without expanding the committed baseline. Known capability gaps now leave
   through explicit typed outcomes and genuine producer/pass invariants were
   fixed. One baseline-known case now passes and remains deliberately
   unratcheted in this slice.
2. **#3519 (R0b, delivered)** — the typed terminal-outcome channel and honest
   `check:ir-only` policy gate are in place. The bounded hybrid lane is green
   with 31 / 37 IR-emitted units, six typed Unsupported units, zero Invariants,
   and complete accounting. Strict remains intentionally non-green on those
   six typed blockers and the separately reported 37 legacy-emitted bodies.
3. **#3520 (R1, ready, next)** — add source-qualified `IrUnitId` and a
   whole-program `ProgramAbiMap` on the delivered R0 boundary.
4. **#3521 (R2, blocked on #3520)** — `PreparedIrProgram` and compile-once
   ownership for single-source top-level free functions.
5. **#3522 (R3, blocked on #3521)** — exhaustive class/member/closure census
   and compile-once ownership, including constructor support units.
6. **#3523 (R4, blocked on #3521 and #3522)** — typed ordered module-init
   planning, one body emission, and planned host/deferred/WASI invocation.
7. **#3525 (R5, blocked on #3520–#3523)** — one whole-program
   `PreparedIrProgram`/`ProgramAbiMap` for single- and multi-source/M0,
   including imports/re-exports, collisions, fast mode, classes, and init.
8. **#3526 (R6, blocked on #3521)** — typed
   `IntrinsicId -> RuntimeFeature -> HostCapability` contract, fixed-point
   manifest freeze, and measured runtime-family rewiring beginning with pure Math.
9. **#3527 (R7, blocked on #3522, #3525, and #3526)** — AST-free
   `IrAsyncPlan`, canonical Promise ABI, and one existing frame engine across
   declarations, closures, methods, `for await`, and async generators.
10. **#3528 (R8, blocked on #3525–#3527)** — linear consumes the exact shared
    Prepared program/runtime/async plans; zero unhandled and zero direct AST
    bodies replace the current permissive overlay ratchet.
11. **#3518 (program owner, in-progress)** — the IR-only default and direct
    front-end retirement program remains open. R0 is complete; R2–R8 remain
    blocked behind #3520 and their declared dependency chain.
12. **#3517 (active stacked slice)** — retire the last measured Algorithms
    module-init `Map` residual. This closes a corpus count, not R4 compile-once
    module ownership.

Only #3520 is ready in the retirement spine. The R2–R8 files are dispatch
specifications, not authorization to bypass their dependencies or implement
directly from #3518.

Program owner: **#3518**. Deletion ledger: **#3090**, blocked until R9. The
function fallback-corpus epic **#2855 is done** and is not a claimable tail
task.

The next acceptance boundary is #3520, not a default flip. The R0 hybrid-green
result proves honest observation and equivalence preservation; the strict
six-blocker result proves that IR-only readiness has not yet been reached.
“Function bucket zero” is not an IR-only status.

## Parallel protected lane — standalone-vs-js-host Test262 gap

### Protected-lane goal

The standalone metric was made **honest** in #2879 (via #2360): a standalone
pass is credited only when it is **host-free** (no leaked host imports), not when
a leaky binary is host-satisfied. On the honest metric:

- js-host passes **~34,052** official tests.
- host-free standalone passes **~12,883**.
- The honest **standalone gap is ~20,500 tests** (roughly double the earlier
  ~9,177 figure that counted host-satisfied leaky passes as wins).

Umbrella: **#2860**. The gap decomposes into the carriers (architecture-scale
half) plus the dynamic-object substrate, the proto-glue / CE clusters, and the
de-masked real-failure clusters.

### Ordered standalone-gap queue

All `priority: high` + `sprint: current` except #2877 (medium). Within the high
tier the **carriers are the biggest lever**, then the substrate/cluster track in
parallel.

### Carrier track (biggest lever — ~2,476 combined)

The carriers share one Wasm-native suspendable **frame substrate** (arch-frame
design; spec lives in #2860 / #2864, `architect_spec: candidate`). Build it once,
then layer the carriers:

1. **Frame substrate** (arch design — #2860/#2864).
2. **#2864** sync generator carrier — 697, horizon xl. First carrier on the
   frame; proves the substrate end-to-end.
3. **#2867** Promise / microtask carrier — 375, horizon l. The microtask
   scheduler the async machinery needs.
4. **#2865** async-generator / for-await carrier — 986, horizon xl.
   `depends_on: [2864, 2867]` (composes the generator frame + microtask
   scheduler).
5. **#2866** Symbol carrier — 418, horizon l. Independent of the frame; parallel
   track.

### Substrate + de-masked cluster track (parallel with carriers)

6. **#2861** built-in static/proto value-read glue — ~882, horizon l. Mechanical,
   start now.
7. **#2863** dynamic-shape `__get_builtin` reflective-read codegen — 365,
   horizon m.
8. **#2878** invalid-Wasm residual (`__str_flatten` + user-body shapes) —
   horizon m. Correctness; follows the #2868 URI-carrier fix.
9. **#2872** TypedArray.prototype.\* cluster — 294, horizon m (de-masked from
   #2862).
10. **#2873** language/expressions cluster — 276, horizon m (de-masked).
11. **#2875** String.prototype.\* cluster — 159, horizon m (de-masked).
12. **#2876** RegExp cluster — 125, horizon m (de-masked).
13. **#2877** standalone exception message readability — horizon s, medium.
    Triage enabler (lower lever).

### Already done / blocked (not queued)

- **#2868** invalid-Wasm emission (URI/str_flatten carrier) — **done** (via #2350).
- **#2874** getOwnPropertyDescriptor numeric-key coercion — **done** (via #2354).
- **#2879** honest host-free metric — **done** (via #2360); re-based the gap to
  ~20,500.
- **#2856** IR `body-shape-rejected` playground corpus — **done** (31 → 0;
  Sprint 73). The generic reason remains non-strict for wider source coverage.
- **#2862** ToPrimitive over built-in exotics — **blocked** (superseded; the
  de-masked clusters #2872/#2873/#2875/#2876 carry the tractable residual).

### Demoted tail work (priority: low, kept sprint: current)

These stay claimable as tail-filler but sort under all the standalone-gap work.
Do NOT close them — just lowered priority per the directive:

| Issue | Was  | Now | Why demoted                                                           |
| ----- | ---- | --- | --------------------------------------------------------------------- |
| #2850 | high | low | acorn dogfood regex-validator remnant — non-standalone                |
| #2853 | high | low | acorn dogfood self-parse remnant — non-standalone                     |
| #2669 | high | low | ES2015 destructuring umbrella — non-standalone conformance            |
| #2803 | high | low | callsite param-type inference — non-standalone (platform)             |
| #1042 | high | low | async state-machine epic — non-standalone (deferred acceptance owner) |

**Other in-progress non-standalone work left untouched.** Active claimed tasks
(e.g. #1917, #2106, #2710, #2773, #2838, #2580, #2623, #2660) are not competing
for the next pull, so their priority is unchanged; they finish, and available
protected-lane capacity follows the standalone queue. (Note: #2029, #2161, #2173, #2175, #2651
are `goal: standalone-mode` — these ARE standalone work and stay as-is.)

### Definition of done (protected standalone lane)

Host-free standalone official_pass climbs from ~12,883 toward the ~34,052 host
figure. Each child issue's test plan = its cluster's standalone-CE/fail tests
flip to host-free pass under full `merge_group` + the standalone high-water floor
(`check-standalone-highwater.mjs`), with zero host-mode regression (all changes
`ctx.standalone`-gated).

## Results (interim — 2026-09-07, protected standalone lane, ES2015 wave 5)

**ES2015 standalone:** 10,188 → **10,228** pass / 11,704 = **87.4 %** (+40 over
waves 4→5's close; whole corpus standalone 35,213 / 48,735). Goal (100 %) not
yet met; 1,476 rows remain (1,146 fail, 329 compile_error, 1 compile_timeout).

### Merged
- **#5688 wave-5 PR-1** (#5316 r5, #5350 r1, #5318 r4/round 2, #3371 r2, #5351;
  +46 / −2 whole corpus)
- **#5694 #5349 species r5** (rounds 1–5; +19 owned, +21 / 0)
- **#5696 #5316 r6** (the 2-row Annex B regression #5688 introduced; both rows
  back)
- **#5698 docs** (umbrella #4444 wave-5 close)

### Closed without merging
- none

### Interim retro
- **Went well**: plan → Opus implement → Opus adversarial review → fix rounds
  converged on every lane; the post-merge baseline set-diff caught a loss no
  gate saw; a finisher workflow recovered a lane killed by a container restart
  without re-running its ~5 h of controls.
- **Went badly**: five fix rounds on #5350 and five on #5349 — static
  predicates over dynamic facts, and a gated emitter returning a local, each
  needed a reviewer to loop what the pins ran once; the Temporal host bucket
  parked a green PR after a benchmark-artifact push rebuilt its queue group.
- **Process improvements**: every pin that exercises a codegen site must run
  it at least twice on different arms; set-diff the promoted baseline after
  every merge as a standing step; quarantine the Temporal host cluster if it
  parks a second PR.
- **Remaining for the lane**: see
  `plan/agent-context/es2015-standalone-handover-2026-09-07.md` (priority
  list: #5350 captured-`var` defect, the TypedArray cluster, ArrayBuffer
  subclass species, wasi own-key ladder, `Reflect.defineProperty`, #3371 r3,
  then the unowned regexp / generators / promise / for-of clusters).


## Results (interim — 2026-09-07 18:00, Temporal lane, re-targeted to standalone)

**Baseline progress (host lane, whole corpus):** 35,498 → **38,343** pass / 48,735
(+2,845 over the window). Standalone `built-ins/Temporal/**`: **170 / 4,603** —
unchanged yet; the standalone goal opened today with #5383.

### Merged
- **#5364 registry leaks across linked projects** (#5678) — batch == solo.
- **#5373 Array-subclass toString dispatch** (#5685).
- **#5374 valueOf across the linked seam** (#5682).
- **#5376 accessor-bearing literal stored as null** (#5691).
- **#5377 constructor identity through any-typed receivers** (#5699, +7 on 481).
- **#5378 absent number-typed property reads as undefined + DateTimeFormat options** (#5706, +54 on 334).
- **#5381 extern-class constructors marshal struct arguments by default** (#5709, +82 on 325).
- **#5383 S1 — the standalone polyfill validates, import-free** (#5721).
- docs: #5679 #5686 #5700 #5701 #5707 #5719.

### In flight
- **#5723** — #5384 (standalone exception renderer exports) + #5383 S2 R3/R4/R5.
- **#5712** — #5380 (defaulted numeric formal through the host class-method bridge; 9 hangs → 0).
- **#5704** — #5379 (draft; 0 delta, pins that #5364 closed the channel).

### Closed without merging
- none.

### Interim retro (Temporal lane)
- **Went well**: plan/implement split held — every lane shipped with per-row A/B
  measurements and 0 pass→fail; parks were diagnosed by measurement, not by
  re-running until green (three collateral parks, all proven with byte-identical
  wasm or solo re-runs).
- **Went badly**: the goal was read as host-lane for the whole window until the
  owner said "standalone only"; a worktree cleanup deleted the shared test262
  tree box-wide; the runtime.ts ceiling had to be re-measured on every re-merge;
  the queue dropped PRs to BEHIND on every CI bot push.
- **Process improvements**: make `test262/` in the main checkout a real
  submodule (done) and never symlink a worktree's copy into another worktree;
  read the goal's target mode before planning; release runtime.ts-growing PRs
  one at a time (kept).
- **Sprint-close criteria remaining (standalone Temporal, #5383)**: S1, S2, S3,
  S4 and S5 are all **done** — the polyfill compiles and links host-free, the
  three-assertion smoke test passes, every test262 lane is wired per target,
  the `__temporal_*` leak is 0 by construction (the #4628 binding gate), and
  the three-family measurement is in the issue. #5383 stays `in-progress` on
  **one unmet criterion**: 4 legitimate pass→fail remain and the linked lane
  scores 0 pass, all traced to a single link-boundary defect. The artifact is
  opt-in. Successors: **#5406** (a boundary-crossing value is not an ordinary
  object — `Object.prototype.toString` refuses it and a provider error's
  `constructor` is not the consumer's; 136 rows cannot pass without it),
  **#5408** (`PlainDate.from` throws / returns a non-number), **#5407** (the
  1.83× link cost — the only blocker to default-on). See
  `plan/agent-context/temporal-standalone-handover-2026-09-12.md`.
