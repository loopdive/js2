---
id: 2089
title: "silent-fallback telemetry + check-codegen-fallbacks ratchet (Phase 0: instrument the 16 verified sites)"
status: done
completed: 2026-06-16
sprint: 62
created: 2026-06-11
updated: 2026-06-16
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1376, 1530, 2090]
origin: "2026-06-11 analysis program (report 04 §5); stub 08-B4"
---

# #2089 — count the silent fallbacks so the classes stop breeding

## Problem

~33 of the ~135 June wrong-answer bugs trace to seven silent-fallback
classes (ref.null value fallback, lookup-miss skip, NaN/0/false constants,
arity truncation, allowlist miss, silent caps, compiler catch-and-
continue). None are counted, so the classes keep breeding — the corpus's
#1 family (24 issues).

## Root cause

No codegen-internal equivalent of the proven #1376/#1530 IR-fallback
ratchet.

## Plan (Phase 0, ~1 day)

`src/codegen/fallback-telemetry.ts` with `reportSilentFallback(class,
site)`; `scripts/check-codegen-fallbacks.ts` + baseline JSON + CI
`quality` wiring (growth fails, `--update-on-decrease` banks);
`STRICT_FALLBACK_CLASSES` promotion to hard error at zero. Phase 0
instruments only the ~16 verified bug sites (8 unary-updates NaN sites, 7
`fieldIdx===-1` skips, identifiers.ts:812). Phases 1–4 (full inventory
coverage) ride this issue or split. Full inventory + design:
plan/log/analysis-2026-06/04-fail-loud-audit.md.

## Acceptance criteria

- Baseline file committed; CI fails on growth; decrease auto-banks
- The 16 Phase-0 sites report through the choke point

## Dupe check

#1376/#1530 are the IR-path ratchet only; no codegen-fallback equivalent
exists. New (analysis program).

---

## Resolution — Phase 0 (2026-06-16, dev3)

**Done (Phase 0).** Pure-telemetry choke point + gate landed, mirroring the
#1376/#1530 IR-fallback machinery. No emitted-code change — behavior-preserving.

### What landed

- **`src/codegen/fallback-telemetry.ts`** — `reportSilentFallback(ctx, cls,
  site, node?, detail?)` with the seven `SilentFallbackClass` values, the
  per-class→per-site `FallbackCounts` accumulator (`ctx.fallbackCounts`), the
  three-level escalation (count → warning when `trackSilentFallbacks` →
  hard-error when the class is in the empty-for-now `STRICT_FALLBACK_CLASSES`,
  `strictFallbacksEnabled` auto-on under CI/vitest), and JSON serialization.
- **Wiring**: `fallbackCounts` + `trackSilentFallbacks` on `CodegenContext`
  /`CodegenOptions` (context/types.ts), initialized in `create-context.ts`,
  surfaced on `CodegenResult` (both `generateModule`/`generateMultiModule`
  returns) and threaded onto the public `CompileResult.fallbackCounts`
  (compiler.ts, gated on the option so normal compiles pay nothing).
- **16 verified sites instrumented** (counts only):
  - 8 `unary-updates.ts` NaN sites → `const-fallback`
    (`incdec-unresolvable-receiver-type`, `incdec-struct-not-found`,
    `member-incdec-unknown-field`, `incdec-dynamic-property-externref`,
    `incdec-nonref-element-access`, `incdec-unsupported-operand`,
    `prefix-incr-property-unknown-field`, `postfix-incr-property-unknown-field`);
  - 7 `fieldIdx === -1) continue` skips → `lookup-miss-skip`
    (2× closures.ts, destructuring-params.ts, loops.ts, 3× assignment.ts);
  - `identifiers.ts` unimplemented-global default → `const-fallback`
    (`unimplemented-global-default`).
- **`scripts/check-codegen-fallbacks.ts`** + `scripts/codegen-fallback-baseline.json`
  + `pnpm run check:codegen-fallbacks` + CI `quality`-job step. Flag-compatible
  with `check-ir-fallbacks` (`--update`, `--update-on-decrease`, `--json`,
  `--verbose`). Gate fails on per-class growth; decreases auto-bank.
- **`tests/issue-2089-fallback-telemetry.test.ts`** — proves the choke point
  counts, accumulates additively, and surfaces on the result.

### Baseline note

The committed baseline is `{}` (empty `counts`): the gate corpus
(`website/playground/examples/**`) is idiomatic code that does **not** hit any
of the 16 instrumented unresolvable-receiver / unknown-field / unimplemented-
global sites. That is the honest current reality — and it means the gate is now
a **zero-floor ratchet**: any future corpus addition that introduces one of
these silent fallbacks fails CI. The unit test exercises the sites directly
(the playground corpus deliberately stays clean), so detection is proven
independent of the baseline.

### Phases 1–4 (follow-on, this issue or split)

Phase 0 lands the *mechanism*. Phases 1–4 (§"Adoption phases" in the audit
doc) route the remaining ~30 null/const sites, the 18 `Math.min` arity loops,
the allowlist Sets, the loop/regex caps, and the 83+28 `catch {}` sites through
the choke point, then promote zeroed classes into `STRICT_FALLBACK_CLASSES`.
Per-class ownership + target dates belong in `plan/log/ir-adoption.md`
alongside the IR ratchet.
