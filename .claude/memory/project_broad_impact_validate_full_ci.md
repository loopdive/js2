---
name: project-broad-impact-validate-full-ci
description: "Broad-impact changes (value-rep / dynamic-dispatch / call-path / shared codegen helpers) MUST be validated via full local-ci or the merge_group, NEVER a scoped/sampled sweep — scoped sweeps repeatedly passed while the full gate caught real regressions."
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

A change with broad blast radius — value-representation (AnyValue/$Object/$Hole boxing), dynamic dispatch, the call-path (arity/closure/method dispatch), or any SHARED codegen helper — **cannot** be validated by a scoped or sampled test262 sweep. The scoped "+N / 0 regressions" is meaningless: the regressions land in files OUTSIDE the scoped set.

**Evidence (2026-06-21):** three PRs ejected from the merge_group Test262 gate AFTER their devs' scoped sweeps reported "0 regressions":
- #1837 (#820): arity-pad in `tryEmitInlineDynamicCall` touched ALL dynamic closure-value calls → +26 new `wasm_compile` (invalid-wasm) on void-result/multi-externref-param candidates (Promise/TypedArray) → tripped the 10% ratio gate despite net +71.
- #1838 (#2001 S1): the universal `$Hole→undefined` read-mapping over-reached → -39 net.
- #1844 (#983d): an over-broad `__extern_method_call` fallback intercepted every unresolved `obj.method()` → **-200 net / 323 regressions** (local 180-sample showed +11).
- sd-3's #2040 scoped sweep showed +3 but HID an `indexOf` -1 regression.

**RULE:** before enqueuing a broad-impact change, validate via the FULL gate:
`JS2WASM_LOCAL_CI=1 ./scripts/local-ci.sh` (full local test262, ~68 min, see CLAUDE.md) — confirm **net ≥ 0, 0 new wasm_compile, no bucket > 50** across ALL ~30k files — OR accept the merge_group itself as the validator for a *targeted* fix (one-shot enqueue; if it ejects that's the signal, not churn). Never a scoped sweep. A refuse→compile-but-fail flip is a wash; refuse→compile-but-invalid-instantiate is a regression — verify newly-compiling files PASS at runtime, not just compile.

The 68-min full-ci run is cheaper than an eject→auto-park-hold→diagnose→re-validate churn cycle (which cost ~3 held PRs + a multi-agent drift investigation on 2026-06-21). Relates to [[project_standalone_floor_only_on_merge_group]] (standalone floor is merge_group-only) and [[feedback_baseline_drift_cross_check]] (distinguish real regressions from baseline drift: identical clusters across unrelated PRs = drift; distinct clusters = real).
