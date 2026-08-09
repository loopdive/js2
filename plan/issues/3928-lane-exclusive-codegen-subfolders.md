---
id: 3928
title: "Move lane-exclusive codegen (standalone vs js-host) into separate subfolders"
status: backlog
sprint: Backlog
created: 2026-07-31
updated: 2026-07-31
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
---

# Move lane-exclusive codegen (standalone vs js-host) into separate subfolders

## Problem

The two compile lanes — **js-host** (`target: "gc"`, JS host imports available)
and **standalone** (`target: "standalone"`, pure WasmGC, no host) — are selected
by a **context flag threaded through one shared source tree**, not by a module
boundary. Measured on `main` at 2026-07-31:

| Signal | Count |
| --- | --- |
| `src/**/*.ts` files mentioning `standalone` | **222 of 481** |
| Occurrences of `standalone` in `src/**` | **2,922** |
| `ctx.standalone` read sites | **691** |
| `nativeStrings` read sites | **522** |
| LOC already in files whose *name* declares a lane | **~16,200** |

The flag itself is set in exactly one place —
`src/compiler.ts:725` (`standalone: options.target === "standalone"`) — and then
fans out through `CodegenContext` (`src/codegen/context/types.ts:2839`) into
almost every codegen module. The densest sites are the shared ones:
`src/codegen/index.ts` (148), `src/codegen/expressions/calls.ts` (135),
`src/codegen/expressions/call-builtin-static.ts` (98),
`src/codegen/object-runtime.ts` (97).

So "which lane does this code belong to?" is answerable only by reading each
`if (ctx.standalone)` in context. There is no directory, no module, and no type
that carries the answer.

### Why this costs us something concrete

This is not only an aesthetic complaint. **Per-lane test262 gating (#3906)
cannot narrow on `src/**` at all** — precisely because the lane is a flag and
not a tree, every `src` change must conservatively schedule *both* lanes'
shards. From that PR's classifier:

> **All of `src/**` stays both-lane.** `target: "standalone"` is a flag threaded
> through the *same* compiler, not a separate source tree, so there is no sound
> src-level split.

That leaves the per-lane gate firing only on the two shard-weight maps. With a
real boundary, a standalone-only change would skip **66 js-host shard jobs** and
a host-only change would skip **36 standalone shard jobs** on every merge_group
— against a serial queue (`max_entries_to_build=1`) where shard wall-clock is
the throughput limit.

Secondary costs:

- **Standalone regressions hide in shared code.** #1897 exists because a #1196
  merge silently dropped ~1,800 standalone passes (+5,582 `compile_error`) — the
  only hard guard at the time read the host JSONL. A change author editing a
  file with no lane in its name gets no signal that they are on a standalone
  path.
- **The "dual-mode: JS host optional" architecture principle is unenforceable.**
  CLAUDE.md says new features should have Wasm-native implementations and that
  host imports need a standalone fallback. Nothing structural checks that; it is
  a review-time convention over a flag.
- **`standaloneHostImportError` is a runtime backstop for a static property.**
  `tests/test262-runner.ts:3622` fails a standalone test at *execution* time if
  the module emitted host imports (#2961). A module boundary could make most of
  that class of bug a compile-time or lint-time error instead.

## Proposal

Give the lane a **directory**, so the answer to "can this change move the
standalone lane?" is a path prefix rather than a code read.

The split is already latent — ~16,200 LOC sit in files whose names declare a
lane but whose *location* does not:

```
src/codegen/regexp-standalone.ts        src/codegen/native-strings*.ts   (8 files)
src/codegen/json-standalone.ts          src/codegen/stdlib-selfhost.ts
src/codegen/wasi.ts                     src/codegen/number-format-selfhost.ts
src/codegen/raw-wasi-api.ts             src/runtime/wasi-polyfill.ts
src/codegen/host-import-allowlist.ts    src/codegen/data-struct-host-bridge.ts
src/codegen/host-fnctor-method-driver.ts
src/ir/host-date.ts                     src/ir/host-extern.ts
```

Target shape (names to be settled in the arch spec):

```
src/codegen/lane/standalone/**   — only reachable when target is standalone/wasi
src/codegen/lane/host/**         — only reachable when a JS host is present
src/codegen/**                   — lane-agnostic; must not read ctx.standalone
```

This mirrors the existing precedent rather than inventing one: #679 (dual string
backend) and #682 (dual RegExp backend) already produced `native-strings-*.ts`
and `regexp-standalone.ts` as separate *modules* — this issue finishes the job
by making them separate *trees* and extending the treatment to the rest.

## Sequencing risk — read before scheduling

**This collides head-on with the `ir-full-coverage` north star.** The #3518
epic is actively rewriting and deleting the direct AST→Wasm front-end
(#3090 is literally the deletion), and the densest lane-conditional files
(`src/codegen/index.ts`, `expressions/calls.ts`, `object-runtime.ts`) are
exactly the ones in that blast radius. A large file-move refactor there would
produce sustained `[CONFLICT]` churn against in-flight IR work, and `main` is
append-only so a bad interleaving cannot be rebased away.

Recommended handling, in order:

1. **Do not start this while #3518 is mid-flight in the same files.** Sequence it
   after the AST front-end retirement, or scope phase 1 to files IR retirement
   does not touch.
2. **Land it in small, independently-mergeable slices** (see below), never as one
   XL move commit.
3. Every slice is a **pure move + import rewrite** with no behaviour change, so
   the test262 numbers must be bit-identical across it. A slice that moves the
   pass count is a bug in the slice.

## Suggested phasing

- **Phase 1 — free wins (S/M).** Move only the files that are *already* 100%
  lane-specific by name and have no `ctx.standalone` branch inside them. Pure
  relocation + import rewrite. Establishes the directory and the convention.
- **Phase 2 — the lint (M).** Add a gate asserting no file outside
  `lane/**` reads `ctx.standalone` / `nativeStrings`, ratcheted against a
  baseline like `check:ir-fallbacks` / `check:oracle-ratchet` do (growth fails,
  shrink auto-banks). This is what stops the boundary re-eroding, and it can
  land and start ratcheting long before the tree is clean.
- **Phase 3 — extraction (XL, incremental).** Walk the ratchet down: for each
  dense shared file, hoist the lane arms into `lane/<lane>/` behind a
  lane-dispatch seam. Bounded by the phase-2 baseline, so progress is
  measurable and regressions are blocked.
- **Phase 4 — turn on the gating.** Only once a lane subtree is provably
  self-contained, add its path prefix to the lane-exclusive table in
  `scripts/test262-paths-match.sh` (`classify_test262_path`) and the JS mirror
  in `scripts/check-baseline-floor-staleness.mjs` (`classifyTest262Path`). The
  wiring, fail-safes and tests for this already exist from #3906 — this is a
  two-line table addition per subtree, nothing more.

## Acceptance criteria

- [ ] A lane subtree exists and at least the phase-1 files live in it.
- [ ] A ratcheted CI gate rejects new `ctx.standalone` / `nativeStrings` reads
      outside the lane subtree, with a committed baseline and an
      `--update-on-decrease` mode.
- [ ] Moves are behaviour-neutral: test262 host and standalone pass counts are
      unchanged across each slice (not "within tolerance" — identical).
- [ ] At least one lane subtree is registered as lane-exclusive in
      `scripts/test262-paths-match.sh`, and
      `tests/test262-per-lane-gating.test.ts` is extended to pin it.
- [ ] A merge_group whose diff touches only that subtree demonstrably schedules
      one lane's shards, not both.
- [ ] `docs/architecture/codegen-axes.md` documents the lane boundary alongside
      the existing backend-lowering / front-end axes.

## Non-goals

- **Not** a third backend or a change to the backend-lowering axis
  (`src/codegen/` WasmGC vs `src/codegen-linear/` linear). That axis is
  orthogonal and both stay — see `docs/architecture/codegen-axes.md`.
- **Not** a behaviour change. No lane's output should differ by one byte.
- **Not** a merge of the `wasi` and `standalone` targets, though they will
  likely share the host-free subtree.

## References

- #3906 — per-lane test262 shard gating; the classifier comment there documents
  why `src/**` cannot currently be narrowed, and its table + tests are the
  hook-up point for phase 4.
- #679 / #682 — dual string and dual RegExp backends; the existing precedent for
  lane-split modules.
- #1897 / #2097 — standalone regression guard and high-water floor; the runtime
  backstops that exist because the boundary is not structural.
- #2961 — standalone host-import leak scan (`standaloneHostImportError`).
- #3518 / #3090 — IR front-end retirement; the sequencing conflict above.
- `docs/architecture/codegen-axes.md` — the two existing orthogonal axes.
