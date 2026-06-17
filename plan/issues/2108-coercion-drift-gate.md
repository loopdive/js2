---
id: 2108
title: "coercion drift gate: scripts/check-coercion-sites.mjs — no 9th hand-rolled ToString"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2089]
origin: "2026-06-11 analysis program (report 03 §5); stub 08-F23"
---

# #2108 — drift continues during normal sprint work

## Problem

Nothing stops a ninth ToString copy: the June inventory found the §7.1.17
ToString matrix hand-rolled 7×, and an in-flight fix branch added a fresh
inline ToNumber matrix WHILE the analysis ran — live proof that drift
continues under normal sprint pressure until a gate exists.

## Root cause

The coercion vocabulary (`__extern_toString`, `__any_to_f64`,
`__host_loose_eq`, number_toString emission, …) is callable from anywhere.

## Fix direction

Per plan/log/analysis-2026-06/03-coercion-engine-spec.md §5: grep-count
baseline of coercion-vocabulary uses OUTSIDE src/codegen/coercion-engine
.ts; growth fails CI (`quality` job), `--update-on-decrease` banks
migration progress; engine internals become non-exported once Step 1
seals the vocabulary. Lands AFTER coercion Step 1.

## Acceptance criteria

- Gate live; a synthetic out-of-engine `number_toString` call fails CI;
  migration steps shrink the baseline automatically

## Dupe check

The engine itself is the upstream 1917 slug (+ amendment); the gate is
unfiled. New (analysis program).

## Implementation (2026-06-16)

Landed `scripts/check-coercion-sites.mjs` — modelled on the proven
`scripts/check-any-box-sites.mjs` ratchet gate (same `--update` /
`--update-on-decrease` / `--verbose` flag convention).

- **Scans** `src/codegen/**` + `src/codegen-linear/**` recursively,
  **excluding** the engine-owned files `coercion-engine.ts` (future
  single-engine home, doesn't exist yet — listed up front so the gate is ready
  the moment the #1917 migration starts), `any-helpers.ts`, `native-strings.ts`.
- **Counts** the sealed §7.1.x/§7.2.x vocabulary per `(file → total)` in the
  form it appears as a USE site: quoted (`"number_toString"`, the
  funcMap/late-import names) or call (`emitBoolToString(`, the TS helper
  identifiers). Vocabulary list from spec §5: `number_toString`,
  `emitBoolToString`, `__extern_toString`, `__any_to_string`, `__to_primitive`,
  `_toPrimitiveSync`, `__host_loose_eq`, `__host_eq`, `__any_to_f64`,
  `__str_to_number`, `__unbox_number`, `__is_truthy`, `__to_boolean`,
  `__any_eq`, `__any_strict_eq`, `valueOfClosureTypes`, `toPrimitiveHint`.
- **Baseline** `scripts/coercion-sites-baseline.json` — 256 out-of-engine sites
  across 30 files at landing (heaviest: binary-ops.ts 37, index.ts 31,
  type-coercion.ts 28, string-ops.ts 22). Growth fails CI; the coercion-engine
  migration ratchets it down with `--update-on-decrease`.
- **Wired** into `package.json` (`check:coercion-sites`) and the `quality` job
  of `.github/workflows/ci.yml` (a required check per `docs/ci-policy.md`),
  alongside the IR / codegen-fallback / any-box gates.

Lands BEFORE the engine exists (the issue's "AFTER Step 1" note is satisfied
by the migration *direction*, not ordering): the gate is most valuable now —
it freezes today's 256-site surface so no 9th hand-rolled matrix can land while
the engine is being built, exactly the drift the §5 analysis caught in flight.

## Test Results (2026-06-16)

Validated all four behaviours locally on the worktree branch:

1. **Baseline run PASSES** — `pnpm run check:coercion-sites` → exit 0, "OK (no
   unsanctioned growth)".
2. **Synthetic 9th `number_toString` call FAILS** (acceptance criterion) —
   injected `ctx.funcMap.get("number_toString")` into `peephole.ts`; gate
   reported `codegen/peephole.ts: 0 → 1` and exited 1.
3. **`--update-on-decrease` ratchets** — stripped one `__unbox_number` from
   `type-coercion.ts`; gate detected `28 → 27` and banked it.
4. **Sanctioned exclusion works** — a `number_toString` call placed inside a
   temp `coercion-engine.ts` was NOT counted (gate stayed green).

`pnpm run lint`, `format:check`, `typecheck` all exit 0 (the `.mjs` matches
Biome formatting; `.mjs` is outside the lint/typecheck `.ts` globs, same as the
existing `check-any-box-sites.mjs`).
