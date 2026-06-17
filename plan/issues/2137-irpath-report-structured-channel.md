---
id: 2137
title: "IrPathReport channel: stop laundering IR fallbacks through ctx.errors warnings"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1921, 1923, 1530]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N1); the codegen/index.ts:1318 comment calls this 'tracked as a follow-up' but no issue existed"
---

# #2137 — IR-path failures ride the diagnostics array as fake warnings

## Problem

IR-path failures are pushed as warning-severity entries into the
compile-diagnostics array (`src/codegen/index.ts:1330-1344`). Consumers
(bridge tests, #1858's `[IR-FALLBACK]` grep, the `"Codegen error:"` prefix
gate) all string-match on diagnostics — brittle and unqueryable.

## Approach

Add `irPath?: { claimed: string[]; fallbacks: {name, reason, phase}[] }` to
the codegen result and `CompileResult`; keep one warning line for
back-compat one sprint; migrate bridge-test filters.

## Acceptance criteria

- No test filters on `message.startsWith("IR path failed")`.
- `check:ir-fallbacks` reads the structured channel.

## Notes

Coordinate with #1921 (structured failure gate) and #1923 (demotion
metering) — same family, don't merge into one PR. Routine dev.

## Resolution (2026-06-16)

The structured channel itself already existed: #1923 added
`CompileResult.irPostClaimErrors: { kind, func, message }[]` and the
`check:ir-fallbacks` gate already reads it (acceptance criterion 2 was already
met). This PR closes criterion 1 — moving consumers off the message-string
filters — and completes the channel so it's a faithful replacement.

- **`src/codegen/index.ts`** — the pre-claim type-resolution fallback (the
  `"IR path: could not resolve types for …"` warning added in #1921) now also
  records a structured `irPostClaimErrors` entry (`kind: "resolve"`), so the
  channel captures both pre-claim resolution failures and post-claim
  build/verify/lower failures — i.e. everything the old
  `message.startsWith("IR path failed") || startsWith("IR path: could not
  resolve") || startsWith("ir/from-ast") || startsWith("ir/lower")` filters
  matched. The back-compat warning line in `ctx.errors` is retained one sprint
  per the approach (so #1850's diagnostic-shape unit test and any external
  log-grepping keep working).
- **`tests/helpers/ir-fallbacks.ts`** (new) — `irFallbacks(r)` returns
  `r.irPostClaimErrors ?? []`, the single query point for the bridge tests.
- **11 bridge tests migrated** off `r.errors.filter(message.startsWith("IR
  path failed") …)` onto the structured channel: #1169a/b/c/d/e-bridge/g,
  #1182, #1183, #1185 now `expect(irFallbacks(r)).toEqual([])`; #1374's local
  `irFallbacks(src)` reads `irPostClaimErrors` (mapped to `${func}: ${message}`
  so its per-reason `.includes(...)` checks keep working). #1850 is a
  deliberate unit test of `formatIrPathFallbackDiagnostic`'s message shape /
  severity promotion (`.toMatch(/^Codegen error: IR path failed/)`) — left as
  is; it does not string-filter `r.errors`.

### Test Results

- `git grep 'startsWith("IR path failed")' / '.includes("IR path failed")'`
  over `tests/` is empty (criterion 1).
- The 11 migrated bridge-test files: 260/260 pass on the structured channel.
- `pnpm run check:ir-fallbacks` — gate OK, "Post-claim demotions: (none)" — the
  new `resolve` entries don't perturb the playground corpus (criterion 2 still
  holds).
- `npm run typecheck` + `npm run lint` (Biome) clean.
