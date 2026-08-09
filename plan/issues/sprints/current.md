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
