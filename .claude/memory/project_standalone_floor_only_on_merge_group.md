---
name: project_standalone_floor_only_on_merge_group
description: "Standalone test262 floor gate (#2097) runs only on merge_group, never on pull_request — standalone regressions pass all PR checks then fail the moment they hit the merge queue"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The standalone pass-count high-water floor gate (`scripts/check-standalone-highwater.mjs`, #2097) lives inside the `merge shard reports` job of `test262-sharded.yml`. On **pull_request** events the heavy 114-job test262 shard matrix is INTENTIONALLY skipped (`SHARDS_RAN: false`, `SHARD_SKIP_OK: true`) and `merge shard reports` reports GREEN without measuring anything. The floor gate only has real data on **merge_group** events.

Consequence: a standalone-regressing PR shows ALL-GREEN PR checks (incl. `check for test262 regressions` and `merge shard reports`) and only fails once it reaches the merge queue, where its merge_group fails and blocks the WHOLE queue. This is "why it slipped" for the 2026-06-20 −84 breach — NOT stale baselines, NOT a measurement artifact.

**Why:** shards are merge_group-only to save CI cost; the trade-off is no per-PR standalone visibility.
**How to apply:** When a merge_group fails the floor but every PR check was green, that's expected, not a paradox. To bisect a floor breach, compare the merged standalone report (artifact `test262-merged-report`, file `test262-standalone-results-merged.jsonl`) from the high-water run vs the failing merge_group run, OR locally build affected tests at each suspect head and run `WebAssembly.validate(binary)` (compile with `{ target:"standalone", skipSemanticDiagnostics:true }`, wrap source via `wrapTest` from tests/test262-runner.ts). The floor reads `full_summary.pass`. See [[project_standalone_hostimport_gate_index_shift]].
