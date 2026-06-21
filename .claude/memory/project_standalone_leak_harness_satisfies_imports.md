---
name: project_standalone_leak_harness_satisfies_imports
description: "Standalone host-import \"leaks\" found via empty-importObject probes may be benign — the test262 standalone harness provides those imports"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

A standalone host-import "leak" detected by compiling with `target:'standalone'`
and instantiating against an **empty** `{}` importObject is NOT proof the feature
is broken in the real test262 standalone run. The **test262 standalone harness
provides many `env::__*` host imports** (e.g. `__for_in_keys/_len/_get/_has`), so
code that "leaks" them against an empty probe still **passes** in the harness.

**Why:** my probe chose an empty importObject; the harness does not. Confirmed
2026-06-19: gating off + refusing standalone `for-in` (#2371, PR #1734) turned
**89 passing** standalone tests (built-ins/{decodeURI,encodeURI,JSON,global,
Boolean,Function,...} — all use `for(k in o)`) into compile_errors → net **-89,
0 improvements** → merge-queue regression-gate FAIL. PR closed.

**How to apply:** before proposing a gate/refusal for a standalone host-import
leak, VALIDATE against the real harness, not an empty importObject — either run
the test262 standalone shard scope locally, or check whether the import is in the
standalone harness's provided set. A gate/refusal is only safe once a **working
Wasm-native replacement** exists. Pure-additive native lowerings (like the #2161
`String(re)`/template coercion, which never refuses) are safe; refusals that
demote a previously-working path are not. Applies to any future leak finding
(e.g. `__extern_rest_object` object-rest destructuring — re-validate before gating).
Related: [[feedback_regression_analysis]] (regressions may be false-positive
exposure, not real regressions).
