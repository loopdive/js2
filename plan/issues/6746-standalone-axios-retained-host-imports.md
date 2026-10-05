---
id: 6746
title: "standalone axios: the optimized standalone-dynamic module still imports 23 host functions (node builtins, async generators, AbortController, FormData, runtime-eval)"
status: ready
sprint: current
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 6732, 6742]
---

# #6746 — axios standalone-dynamic keeps host imports

## What you will see

After [#6742](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6742-npm-compat-standalone-budget-aware-wasm-opt-level),
axios's `standalone-dynamic` lane no longer ends in `optimization-error`. It
now stops at the next gate. Measured 2026-09-29 on `c8b4f0ef36` + #6742, on a
loaded box where the planned `-O2` timed out and `-O1` was used:

```
npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic
→ host-import-error: standalone binary retained 57 host import(s)
```

The standalone lane instantiates with zero imports. How many imports remain
depends on how much dead code wasm-opt removes:

| artifact | imports |
|---|---:|
| raw (`optimize: 0`, 9,260,766 B) | 61 (`env` 59, `js2wasm:runtime-eval` 2) |
| `-O1` (5,565,338 B) | 57 |
| `-O2` (4,196,091 B) — the level an unloaded run plans | 23 |
| `-O4` without Flatten (3,820,273 B, #6732) | 24 |

The `-O2` survivors, verbatim:

`env.hasSymbolShams, env.__node_stream, env.__node_util, env.__node_path,
env.__node_url, env.__node_assert, env.__node_http2, env.Blob_new,
env.__gen_create_buffer, env.__gen_push_ref, env.__create_async_generator,
env.__gen_next, env.__gen_return, env.__gen_throw, env.__gen_result_value,
env.__gen_result_done, env.AbortController_new, env.AbortController_abort,
env.AbortController_get_signal, env.FormData_new,
js2wasm:runtime-eval.__runtime_apply_interpreted, env.__js_array_new,
env.__js_array_push`

## Direction

Each family needs a standalone implementation, or needs to become
unreachable before emission, so the lane does not depend on wasm-opt's DCE:

- Node builtin shims (`__node_*`): axios's Node adapter must not be linked
  into a standalone graph.
- Async-generator host bridge (`__gen_*`, `__create_async_generator`).
- `AbortController` / `Blob` / `FormData` constructors.
- `hasSymbolShams`.
- The runtime-eval apply bridge. The lane sets `runtimeEvalProvider: false`.
