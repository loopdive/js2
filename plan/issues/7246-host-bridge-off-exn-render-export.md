---
id: 7246
title: "Export policy: `hostBridge: \"off\"` still leaves the `__exn_render_prepare` exception-render export on a gc module"
status: ready
created: 2026-11-05
updated: 2026-11-05
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [4035, 6979, 7098]
---

# #7246 — the exception-render export ignores the host-bridge policy

Found by the S7-c fix-on-touch pass (2026-11-05) in
`tests/issue-4035-host-bridge-policy.test.ts`, row "honours an explicit off
for js-host too" (marked `it.fails` on PR 6896; fails on main before and
after S7). With `hostBridge: "off"` on the default gc target the module
still exports `__exn_render_prepare`, so the bridge-marker surface is not
empty. #4035 established that an explicit `off` strips every bridge export;
the exception-render export was added (or re-routed) later without
consulting the policy — most likely with the exception-transfer adapter
work around #7098 (exported probes) or the throw-boundary changes.

## Plan

1. Measure: compile the #4035 REALISTIC program with `hostBridge: "off" |
   "auto" | "always"` on gc, standalone and WASI; list the exports that
   carry a bridge marker per setting; find where `__exn_render_prepare` is
   exported and which policy switch it reads.
2. Fix: route that export through the same host-bridge policy as the other
   bridge exports (`off` → not exported; standalone/WASI unchanged).
3. Tests: turn the `it.fails` row back into a normal row.
4. Acceptance: equivalence gate "No new equivalence regressions"; default and
   `always` outputs byte-identical.
