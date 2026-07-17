---
id: 3341
title: "Promote zeroed IR fallback reasons into STRICT_IR_REASONS (#2855's own AC — cheapest unstarted hardening step)"
status: ready
sprint: current
created: 2026-07-17
priority: high
feasibility: medium
horizon: s
task_type: feature
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
related: [2855, 2856, 2857, 2858, 2859, 2950]
origin: "carved out of #2855's umbrella scope per the 2026-07-17 IR audit (plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md §2) — the promotion half of #2855's AC has not started even though the underlying buckets are already zero"
---

# #3341 — promote zeroed IR fallback reasons into `STRICT_IR_REASONS`

## Problem

`STRICT_IR_REASONS` (`src/codegen/index.ts:1511`) is still the empty set.
Per `docs/architecture/codegen-axes.md` and CLAUDE.md's IR Fallback Budget
section, once an "unintended" fallback bucket hits zero on the corpus, its
reason is supposed to be promoted into `STRICT_IR_REASONS` — turning any
_future_ regression of that reason from a silently-demoted legacy fallback
into a hard compile error. Nobody has done this promotion, even though the
following reasons are already at zero on the `scripts/ir-fallback-baseline.json`
corpus as of 2026-07-17 (verified via `pnpm run check:ir-fallbacks -- --verbose`):

- `call-graph-closure` (#2858, done)
- `class-method` (#2857 + #3000 B/C/E, done)
- `param-type-not-resolvable` (#2859, done)
- `external-call`, `param-shape-rejected`, `destructuring-param-complex`,
  `return-type-not-resolvable`, `type-resolution-failure` — already absent
  from the baseline's `unintended` section.

This is the single cheapest, already-unblocked hardening step available in
the #2855 umbrella — no new codegen work needed, just closing the loop on
work already done.

**Note**: `body-shape-rejected` (still 14, #2856 in-progress) and
`async-function`/`type-parameters`/`non-export-modifier`/`unnamed` (deferred
category) are NOT in scope here — only the reasons already at zero.

## Task

1. Move the reasons listed above from the demote-to-warning channel into
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1511`).
2. **Caveat that must be handled, not skipped** (per the audit): baseline
   zero is measured against the 13-file playground corpus only. A reason
   can be zero-on-corpus but still legitimately fire on real user code —
   promoting it to a hard error is only safe if firing it SHOULD actually be
   an error (i.e. the fallback reason represents a case the IR is now
   expected to always handle), not just "we happen not to have a test for
   it." Check `plan/log/ir-adoption.md`'s per-reason notes (the class-method
   row already flags this exact distinction: "corpus bucket 0 … NOT yet
   strict") before promoting each reason — promote only the ones where
   zero-on-corpus genuinely means "should never happen," and leave the rest
   demoted with a note explaining why.
3. Run the full existing test suite + `pnpm run check:ir-fallbacks` to
   confirm no live corpus code trips a newly-strict reason (if it does,
   that's real signal the promotion was premature for that reason — back it
   out, don't suppress).
4. Fix the two stale demote-channel line-number citations found by the
   audit while you're in this code (`plan/log/ir-adoption.md` still says
   `index.ts:889-896`; actual location is ~1891/2390 as of 2026-07-17) and
   in `docs/architecture/codegen-axes.md` (same stale citation, plus a
   stale "not yet moved" claim about the aggregate/closure/ref-coercion
   groups in `lower.ts` — see #2855's audit-note for detail).

## Acceptance criteria

- Every reason promoted is justified in the commit/PR body with the
  corpus-vs-strict reasoning, not just "it was zero so I promoted it."
- Full test suite green; `check:ir-fallbacks` gate green.
- Stale line-number citations in `ir-adoption.md` and `codegen-axes.md`
  corrected.
- `plan/issues/2855-ir-frontend-migration-ratchet-buckets-to-zero.md` updated
  to reflect this slice as done against its own AC (don't close #2855 itself
  — `body-shape-rejected` remains open via #2856).
