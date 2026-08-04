---
id: 4157
title: "umbrella: close the acorn-vs-Node performance gap — representation first (bounded 2.7x), then JIT-class structural work"
status: ready
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: performance
area: codegen
goal: performance
assignee: "ttraenkler/claude-fable"
related: [3780, 4155, 743, 3926, 3927, 4074, 2860]
origin: "2026-08-04 — synthesis of the #3780/#4155 measurement campaign into a scheduled program"
---

# #4157 — umbrella: close the acorn-vs-Node performance gap

## Where the gap lives (measured, 2026-08-04)

Compiled acorn parses the runtime-suffixed 226 KB corpus at **ratio 0.092-0.124
vs native Node** (10.8x slower on CI hardware, 8.0x in a dev container — same
lane, hardware differs). Both numbers are from the `standaloneDynamic` lane;
the `static` lane's huge ratios are compile-time folding and must never be
quoted as runtime performance.

The gap decomposes into two unequal parts (#3780):

1. **~63% is representation overhead.** Boxed `externref` values everywhere:
   42,930 `ref.test`/`ref.cast`/`ref.is_null` + 24,288 conversions against
   22,003 calls; casts+conversions are 19.9% of instructions in the hottest
   functions while real field access is 4.1%; every boxed field read funnels
   through `__extern_get` (14,035 lines, linear scan, 5.6% self-time).
   **Eliminated perfectly this is worth ~2.7x — it cannot reach parity alone.**
2. **~3.5x is the compiled parser losing to the JIT** — inline caches,
   speculation, and tuned string internals that a static compile must earn
   structurally.

## What is already done (do not redo)

- **Typed instance slots are ON by default** (#4155 Phases 0-1, PRs
  #4113-#4116): acorn binary 943,140 → 866,627 B (−8.1%), `discarded` census
  bucket 4 → 1. **Measured A/B: zero runtime effect** (ratio 0.1243 on vs
  0.1221 off, inside noise) — expected, because the READ SIDE was never built.
  Typing the slot is the precondition for the fast read, not the fast read.
- **Prototype-alias recovery has NO headroom** — #2681 already recovers the
  receiver completely; alias and direct forms emit byte-identical twins
  (`struct.get`, no dispatcher). Verified at the instruction level in #4155.
- **Single-hop ctor-param inference is worth 2 slots for +90 bytes** (#4117,
  shipped default-off behind `JS2WASM_FNCTOR_CTOR_PARAM_TYPES`). The next
  attempt starts from the transitive fixpoint, not from call-site agreement.
- Alias-following, multi-site field seeding, and checker-shape synthesis are
  all measured dead ends — see #4155 §3-§4 and index.ts:7654 (#1712).

## The program, in dependency order

### Workstream 1 — finish the representation lever (bounded ~2.7x total)

- [ ] **#4155 Phase 2 — read side**: emit `struct.get`/`struct.set` for data
      fields on a struct-typed receiver; member CALLS stay dynamic (that
      default is where the #1712 attempt regressed). Insertion point pinned:
      `property-access.ts:656` re-boxes a `ref` receiver into the dispatcher.
      Precedent: #3753 S1c ("promoting the slot alone moved nothing because
      the READ never consulted it"). **This converts the −8.1% into speed or
      proves the slot lever dead — either result reshapes the program.**
- [ ] **#743 transitive fixpoint**: 43 of 96 slots are `unknown` because ctor
      args are themselves untyped values forwarded from untyped params.
      Single-hop is measured worthless; the fixpoint must propagate through
      the call graph to convergence. The IR middle-end already has
      `src/ir/propagate.ts` (#1131) — extend it rather than building anew.
- [ ] **#4155 Phase 0's three `it.fails` bugs** (return-position instance,
      array round-trip, method-added field): correctness holes in the same
      machinery; any read-side work must not paper over them.

### Workstream 2 — JIT-class structural work (the ~3.5x residue)

- [ ] **#3926 — `__extern_get` lookup cost**: perfect-hash / `br_table` the
      key dispatch (today: 1,080 ifs, 463 `ref.test`, 303 `__str_equals`,
      zero `br_table`). Pays off on every read Workstream 1 does NOT convert.
- [ ] **#3927 — per-shape fnctor splitting**: `Node` is a 292 B union struct
      for a 3-6 property object; #4074's declared-shape partition (acorn's
      own `.d.ts`, 83 interfaces) is the cheap partition signal. Bounded at
      ~19% of allocation.
- [ ] Scanner/string tuning on the tokenizer hot path — scoped by whatever
      the post-Workstream-1 profile says; do not pre-commit.

### Measurement discipline (how this umbrella stays honest)

- The only quotable lane is **`standaloneDynamic`** (`pnpm run
  benchmark:acorn:standalone-dynamic`).
- Every perf change lands with an **A/B on that lane** (env-flag or
  commit-pair), not a before/after across days — ambient drift between runs
  exceeded the entire effect size of #4116.
- Size deltas are reported as size, never implied as speed.

## Acceptance criteria

- [ ] Phase 2 lands and the `standaloneDynamic` A/B moves outside noise, OR
      the null result is recorded here with the profile that explains it.
- [ ] `unknown` census bucket < 20 (from 43) via the #743 fixpoint, measured
      by `JS2WASM_FNCTOR_FIELD_PROVENANCE=1` on acorn.
- [ ] `__extern_get` self-time < 3% (from 5.6%) on the #3780 profile corpus.
- [ ] Ratio vs Node ≤ 0.25 (≤4x slow) on `standaloneDynamic`, CI hardware —
      the realistic Workstream-1+2 target; parity is NOT promised by this
      umbrella and would require wins beyond both workstreams.
- [ ] The three #4155 Phase 0 `it.fails` tests are promoted to passing.

## Dupe check

#3780 stays open as the measurement/goal issue; this umbrella is its
execution program. #4155/#743/#3926/#3927 are the children and keep their own
acceptance criteria; this file only sequences them and pins the measurement
rules.
