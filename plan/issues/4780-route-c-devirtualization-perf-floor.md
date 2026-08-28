---
id: 4780
title: "perf-gate: route-c devirtualization has no floor — a 27.8x regression lived on main for 3 days"
status: done
completed: 2026-08-27
assignee: ttraenkler/opus-4780
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: m
feasibility: medium
task_type: infrastructure
area: testing
goal: performance
related: [4775, 3754, 3685, 3683, 4157]
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: the 6 open PRs on
# loopdive/js2 (#5056, #5063, #5067, #5069, #5070, #5072) add or modify issue
# files {1691, 3481, 3525, 4770, 4777, 4778}. 4780 is above all of them.
---

# #4780 — nothing gates the devirtualization perf floor

**The gate is built** — see the implementation record at the bottom. The
sections immediately below are the original proposal, kept as written.

## The gap

[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main)
found a **27.8x** regression on the `method` axis — `recv.m()` on a non-`this`
fnctor receiver stopped devirtualizing entirely — that lived on `main` from
2026-08-24 to 2026-08-27 with **every required check green**. Three separate
safety nets were present and none of them fired:

| net | why it missed |
| --- | --- |
| the six required checks | none runs a perf measurement, by design |
| `tests/issue-3754-numeric-return-twin.test.ts` | correctly went red — but is in no gating lane, so nobody saw it |
| the acorn dogfood corpus | **structurally blind**: its devirtualized sites are all `this.m()` (routes a/b), which never traverse the changed code. Its census is byte-identical with and without the regression |

The third row is the one worth internalising. The census
`sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0` was
quoted in #4775's own problem statement as evidence the mechanism was healthy,
and it was *true and irrelevant* — a green reading over a path the change does
not traverse (#4157 entry 22). A corpus is only evidence for the routes it
actually exercises, and no artifact says which those are.

## What a floor would need

The three admission routes into the direct-call trampoline machinery
(`tryEmitDirectTwinCall`, `src/codegen/typed-this.ts`) fail independently:

- **(a)** `this.m()` inside a typed twin — heavily exercised by acorn.
- **(b)** `this.m()` inside a pinned generic body — likewise.
- **(c)** `recv.m()` on a proven non-`this` receiver — exercised by acorn
  **not at all**, and the one that regressed.

So a per-route floor, not an aggregate one. The cheapest form is probably not a
timing gate at all but a **shape** gate: assert that a fixture of each route
still emits its `__dc_*` trampoline. That is deterministic, runs in seconds, has
no noise budget, and would have caught this exact regression — `#4775`'s suite
is already such a gate for route (c) and did catch it. Promoting the existing
`tests/issue-37*.test.ts` shape suites into a required lane may be most of the
work.

A timing floor is the stronger but costlier option, and only worth it where a
shape gate cannot express the property.

## The measurement method, if a timing floor is built

Validated during #4775; reuse it rather than re-deriving:

- **Interleave the arms in one container**, alternating A/B/A/B, min-of-5 per
  reading, three rounds. Wall-clock across containers is not comparable.
- **Carry a noise probe** — an axis the change provably cannot touch. #4775 used
  `numeric`, which stayed at 2.42–2.49 ms across all six arms while `method`
  moved 25.7 → 0.92. Without the probe, a 27x delta and a noisy container are
  not distinguishable from the numbers alone.
- **Require matching checksums** on every axis in every round. A faster arm that
  computes something else is not a faster arm.
- `benchmarks/cross-engine/run-js2.mjs` already implements all of this.

## Acceptance criteria

- A decision recorded: shape gate, timing floor, or both — with the reason.
- Whichever is chosen covers route (c) specifically, not just an aggregate.
- If a timing floor: its noise probe is named, and its threshold is justified
  against a measured spread, not guessed.

---

## Implementation (2026-08-27)

**Decision: shape gate, no timing floor.** The reason is not "timing is noisy" —
it is that at the only threshold a timing canary could safely carry, the canary
is **blind to half the failure class the shape gate covers**. Arithmetic below.

### What was built

| file | what it does |
| --- | --- |
| `tests/issue-4780-devirtualization-routes.test.ts` (new, 8 cases, ~5 s of test time) | pins all three admission routes into `tryEmitDirectTwinCall` separately, by reading the emitted WAT |
| `tests/guard-suite.json` (+2 entries) | puts that file **and** `tests/issue-3754-numeric-return-twin.test.ts` into the required `quality` job, on every PR, merge group and push |

No `.github/` change, and none needed: `run-guard-suite.mjs` is already wired
into `quality` and reads the manifest, so promoting a suite into the required
lane is a JSON edit. That is also the answer to #4775's open question ("do these
suites belong in a gating lane?") — yes, and the manifest is how.

`test:changed-root` picks the new file up automatically (`^tests/[^/]+\.test\.ts$`,
not on the exclusion list), but that lane is **not** the point: it selects only
files the PR itself touches, and the regression this issue exists for was caused
by an edit ~1400 lines away in `src/codegen/expressions/call-receiver-method.ts`
that touched no test at all. The guard suite is the lane that catches that, and
its `$comment` names exactly this shape — "guards that pin a FILE OTHER than
themselves… the edit that breaks them never selects them".

### Route coverage — all three, identified structurally

| route | fixture | WAT signature asserted |
| --- | --- | --- |
| **(a)** `this.m()` in a typed twin | `ALL_ROUTES` (`twice` calls `this.inc()`) | a `*__typed_this` body calls the **UNGUARDED** `__dc_P_inc_0`. Unguarded is exclusive to (a): (b) and (c) both set `guardedReceiver`, so the missing `_g` suffix *is* the route |
| **(b)** `this.m()` in a generic lifted body | same | a **generic lifted body** — a function `N` for which `N__typed_this` also exists — calls the guarded `__dc_P_inc_0_g` |
| **(c)** `recv.m()` on a proven non-`this` receiver | `METHOD_AXIS` (the benchmark's own `method` axis shape) + `ALL_ROUTES` | `inner`, whose source contains no `this` at all, calls `__dc_..._g`, and its body carries **none** of `compileCallablePropertyCall`'s dynamic ladder (`__extern_method_call`, `$__fsd_recv`, `$__fsd_args`) |

Two further pins that are about the same subject and would otherwise be a hole:

- **"green but pointless" degradation** (#3754 point 2) — a trampoline is
  reserved, the call edge exists, and the *fill* silently drops to the legacy
  dispatcher for every site. Trampoline existence alone does not catch it, so
  each trampoline body is asserted to reach a typed twin. (A *guarded*
  trampoline legitimately carries `__call_m_*` in its else arm; what a degraded
  one lacks is the twin call.)
- **Negative control** — a `TWO_CLASS` fixture whose receiver two different
  classes flow into must **decline**: no trampoline at all, ladder retained.
  Without it, "no ladder / a trampoline exists" would also be satisfied by a
  compiler that devirtualized indiscriminately, which is unsound rather than
  fast.

### Two flag lanes, deliberately

The IR inliner inlines `__dc_*` trampolines unconditionally (rule 3, #4157), so
at the **shipped default** the `call $__dc_*` *edge* is gone from the call site —
while the trampoline function itself is still emitted. So:

- **default lane** — asserts (i) the trampoline exists and (ii) the call site
  carries no dynamic ladder. Both flip under the regression, and this lane runs
  the configuration that actually ships.
- **`JS2WASM_IR_INLINE=0` lane** — the call edge survives, which is what makes
  per-route attribution readable at all. Pinned **per compile**, not file-wide,
  so the default lane stays genuinely default.

### Non-vacuity — the A/B, run

`ad543a660e`'s try-order was reintroduced on top of the shipping tree by
disabling the #4775 reorder guard in
`src/codegen/expressions/call-receiver-method.ts:2126` (`if (false && …)`), a
one-token mutation of the mechanism rather than of the test.

| arm | result |
| --- | --- |
| `main` @ `76c47838e1`, unmodified | **8 / 8 green**, 5.3 s of test time (31.5 s wall incl. transform) |
| regression reintroduced | **3 failed / 5 passed** |

The three that go red are exactly the route-(c) pins, in both lanes:

```
route (c): the method axis reserves a trampoline and its call site carries no dynamic ladder
  → route (c) reserved no trampoline at all: expected [] to include '__dc_P_inc_0_g'
route (c): `inner` calls the guarded trampoline directly
  → expected '(local $p (ref null 17))…' to match /call \$__dc_P_inc_0_g/
all three routes are live in ONE module
  → expected [ 'a', 'b' ] to deeply equal [ 'a', 'b', 'c' ]
```

Routes (a) and (b), the value assertions and the negative control stay **green**
under the regression — correctly, since `ad543a660e` is route-(c)-only. The
suite being *selectively* red is itself the evidence that the per-route
attribution works: an aggregate gate would only have said "something is worse".

The mutation was reverted and `git status src/` verified clean before commit;
the compiler is untouched by this PR.

### Timing canary — considered, measured, declined

Measured on this container at load average 8–10 (three readings, `pnpm exec tsx
benchmarks/cross-engine/run-js2.mjs`, checksums identical across all three —
`method` reads `45000150000` every time):

| reading | `method` ms | `numeric` ms (noise probe) | ratio |
| --- | ---: | ---: | ---: |
| 1 | 0.9067 | 2.4167 | 0.375 |
| 2 | 0.9098 | 2.4341 | 0.374 |
| 3 | 0.9173 | 2.3971 | 0.383 |

So the ratio-to-probe is stable to **±1.2 %** even on a busy box, and under the
regression it was `25.7 / 2.45 ≈ 10.5` — a canary of the form *"`method` must
stay under **5×** the `numeric` probe on the same run"* would have fired with 2×
margin and ~13× headroom over the observed spread. It is not a fragile gate.
**It is a gate with a blind spot**, and that is why it was declined:

1. **At 5× it misses the degradation the shape gate catches.** #3754 recorded
   the boxed-ABI arm — the "trampoline reserved, fill degraded to the legacy
   dispatcher" state — at **4.22 ms**, i.e. ratio **1.7**, comfortably under a
   5× ceiling. So the canary is blind to exactly the "green but pointless"
   failure the shape gate pins directly. Tightening to ~2× to cover it drops the
   headroom from 13× to ~5× over a spread measured on **this** box, and the
   ratio's behaviour on a shared GitHub runner is **not** something these three
   readings establish: `numeric` is a pure-f64 loop with no allocation, `method`
   is 300 k guarded calls with GC-struct field writes, and there is no reason
   those two degrade proportionally under a *different machine's* contention.
   #4775's noise probe was validated for a **paired interleaved A/B inside one
   container**; a CI gate has no A arm, so reusing that validation for an
   absolute per-run ceiling would be inheriting a figure from an artifact and
   restating it as a measurement.
2. **There is no informational lane available without a `.github/` change.**
   The guard suite runs inside the required `quality` job, so anything added to
   it gates hard; a non-required timing lane needs a workflow file, whose blast
   radius is queue-wide and out of scope here.

Add it later, as a **non-required** job, if someone wants coverage of the
"structure unchanged, code got slower" class — which is a different subject from
this issue. It should carry the #4775 method verbatim: interleaved arms in one
container, min-of-5, `numeric` as the named probe, checksums required per axis
per round. Recorded here rather than built, per the scope note above.

### What this does not cover

- The gate reads WAT, so a regression that keeps the shape and loses speed
  **inside** the twin is invisible to it. That is the class the deferred canary
  would own.
- Route coverage is proven for these fixtures, not for the whole compiler. The
  standing lesson from #4775 stands: a corpus is evidence only for the routes it
  traverses, and nothing yet reports which routes a corpus exercises.

### Tests

- `tests/issue-4780-devirtualization-routes.test.ts` — 8 cases, green on
  `main` @ `76c47838e1`, 3 red under the reintroduced `ad543a660e`.
- `tests/issue-3754-numeric-return-twin.test.ts` — 10/10 green, unmodified,
  promoted into the guard suite.
- `node scripts/run-guard-suite.mjs` — the two new entries contribute **+18
  passing, 0 failing**. See the caveat below before reading that as "the suite
  is green".

### Caveat worth recording: the guard suite is NOT green in this container

Running the full manifest locally gives **26 failed / 4 files** —
`issue-680`, `issue-3164`, `issue-3386`, `issue-3565`, all `RuntimeError:
unreachable` in standalone generator lowering. That is **not** caused by this
change and is **not** a red main:

- the identical 26 failures reproduce with `main`'s own 18-entry manifest, with
  this branch's files absent (control run) — so this PR adds 18 passing tests
  and no failures;
- `issue-680.test.ts` fails the same way run alone, so it is not cross-file
  interference in the single fork;
- **CI on this branch's exact base `76c47838e1` is green**, `quality` included,
  and the guard suite runs there on every push — so the manifest is green on the
  hardware that gates.

So it is environmental to this container, and unresolved. Recorded because the
next person to run `pnpm run test:guard` locally will see 26 red and reasonably
suspect their own branch; the control-vs-treatment run above is the cheap way to
tell those apart, and is worth doing before chasing it.
