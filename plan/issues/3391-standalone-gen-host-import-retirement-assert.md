---
id: 3391
title: "standalone: S7 mechanical — assert-zero `__gen_*`/`__get_caught_exception` registration + eager-buffer dead-path accounting (umbrella #3178 closeout)"
status: ready
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: low
horizon: s
feasibility: medium
model: opus
reasoning_effort: medium
task_type: refactor
area: codegen, standalone, ci
language_feature: generators, async-generators
goal: standalone-mode
umbrella: 3178
related: [3386, 3387, 3388, 3389, 2961, 2097]
depends_on: [3386, 3387, 3388, 3389]
origin: "2026-07-17 fable-3178 umbrella decomposition — the S7 'fold into the last slice' step, made explicit now that S1/S2 closed without it."
---

# #3391 — S7: retirement assert + accounting (LAST child, after #3386–#3389)

## Problem

Umbrella #3178's S7 was "fold the `__get_caught_exception`
zero-registration assert + eager-buffer code deletion into the LAST of S1/S2
to land" — but #3164 and #3132 both closed without it. This issue makes S7 an
explicit, dispatchable closeout child. It has ~0 direct row yield; its value
is (a) ratcheting the win so the generator host bundle can never silently
return to the standalone lane, and (b) the umbrella's acceptance measurement.

## Preconditions

#3386–#3389 landed (or explicitly re-scoped). Before starting, re-measure the
family residual from a FRESH promoted standalone baseline
(`node scripts/fetch-baseline-jsonl.mjs --standalone`, aggregate
`error_category === "host_import_leak"` rows by import — the umbrella's
acceptance is each of `__create_generator` / `__create_async_generator` /
`__make_callback` / `__get_caught_exception` under 100 official-scope rows;
`__make_callback` is already at 0 as of 2026-07-17). Mind #3380: the promoted
baseline can lag main by hours-to-a-day — verify the baseline commit
timestamp postdates the last child's merge.

## Implementation Plan

1. **Registration-site ratchet.** The gen host bundle registers in
   `src/codegen/registry/imports.ts` (~1988–2020, the function guarded by
   `ctx.funcMap.has("__gen_create_buffer")`; standalone/wasi early-return at
   ~1990 unless `options?.allowNoJsHost`). Add a standalone-lane assertion
   counter: when `(ctx.standalone || ctx.wasi)` and the bundle registers via
   the `allowNoJsHost` escape, record the reason
   (`ctx.fallbackTelemetry`-style, see `src/codegen/fallback-telemetry.ts`).
   Then add a scripts-level check (pattern: `scripts/check-standalone-highwater.mjs`)
   that compiles a small FIXED probe corpus (the wrapped shapes from
   #3386–#3389's test files) and fails CI if any probe registers the bundle.
   Do NOT gate on the full test262 corpus in PR CI (cost); the merge_group
   standalone floor (#2097) remains the corpus-level ratchet.
2. **Dead-arm audit, not blind deletion.** The eager-buffer emit sites
   (`class-bodies.ts` legacy arm at ~3035–3038, `literals.ts`,
   `nested-declarations.ts` legacy arms, the `__gen_*` emitters in
   `generators-native.ts`/`runtime.ts`) remain LIVE for the JS-host lane and
   for still-bailed standalone shapes (object-rest patterns, try/finally
   returns, dynamic-import chains). Audit which arms are provably unreachable
   under `standalone && !allowNoJsHost` and delete ONLY those; each deletion
   must keep the host lane byte-identical (SHA probe) — this is the #2662/#3032
   W6 boundary: host-lane eager-buffer retirement is NOT this issue.
3. **`__get_caught_exception` per-site check.** Its two sources: the gen
   bundle (dies with it) and the host-lane async wrap
   (`wrapAsyncCallInTryCatch`, `src/codegen/expressions.ts` — the standalone
   arm at ~516 already avoids it). Grep for any remaining standalone-reachable
   emission; add the import name to the standalone-refusal set if fully dead.
4. **Umbrella acceptance write-back.** Update #3178 with the final measured
   table (per-import residual, host_free_pass count) and flip it to done if
   the acceptance bars hold (<100 rows per family import; host_free_pass ≥
   24,500 — already 24,949 on 2026-07-17, so this bar re-verifies trivially).

## Test plan

- The fixed probe corpus compiles standalone with zero family imports and
  instantiates with `{}` imports.
- Full-repo: `prove-emit-identity` host lane; standalone floor in merge_group.
- The new CI check fails when a probe is deliberately broken (self-test).

## Regression risks

- Over-deletion: a standalone shape still legitimately on the legacy path
  (correct-or-legacy residuals listed in #3386–#3390) must keep a VALID module
  — deleting its import registration while its emit arm survives bakes
  undefined funcIdx. The audit order is: telemetry first, delete second.
