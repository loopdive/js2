# Session B charCodeAt provider handoff

Issue: **Linear IR charCodeAt provider: reusable emission body and exact preservation**,
tracked in `plan/issues/6911-linear-ir-char-code-at-provider-body.md`.
PR: https://github.com/loopdive/js2/pull/6583, non-draft HOLD, no auto-merge.
Branch: `codex/6911-linear-char-code-at-provider-20261007` on canonical upstream.

Source commit: `5761898b7b8e9c3e0983077a35efd33269c9219c`.
Test commit: `462fb0565d1e3f296c12a7e87ab422b398ea057d`.
Source and test hashes, actual paired epochs and limitations are in the issue.
The final publication hash is supplied in the PR body after push; do not infer
remote publication from a local commit or branch name.

## Scope and ownership

Sol 6.1 Medium source owns only runtime.ts's final charCodeAt body callback/import
and `runtime/strings/char-code-at.ts`; its explicit handoff is frozen. Sol 6.1
Medium test owns only the new issue-6911 test file, also frozen. Astra High wrote
the implementation plan. Parent owns READMEs, evidence and serialized validation.
Exact issue:slice claims and unique owners are recorded in the issue file;
all remain active until Session A integrates or releases the slices.

No compiler/index, shared IR/frontend/preparation/provenance, physical emitter,
allocator or source-map files changed. Session A retains all those scopes and
final integration/protected queue submission. Do not take another active claim
without its owner's explicit handoff. Legacy remains until full IR equality.

## Evidence

- New ordinary tests: 10/10 on both arms; all ten full observations and fourteen
  binary witnesses match exactly. Native finite oracle: 41 cases. Source route
  and actual helper binding, Unicode runtime decoding, imported namesake safety,
  fresh mutable instruction trees and bounded header-cache effects are covered.
- Existing fixtures: 28 pass / 3 fail / 31 on both arms; all complete failure
  diagnostics are equal. Neither original fixture changed.
- Strict test-inclusive TS7: exit 0, zero diagnostics. Saved configuration and
  empty raw diagnostic log distinguish it from the root source-only gate.
- Source format/lint and LOC/function budgets passed; first normal push also
  passed all gates, including numeric parity 18/18. No bypass or budget grant.

Recheck the saved control comparison with
`node plan/log/6911-linear-char-code-at-20261007/compare-existing-controls.mjs`.
Recheck provider equality with
`node plan/log/6911-linear-char-code-at-20261007/compare-provider-rows.mjs plan/log/6911-linear-char-code-at-20261007/baseline-v1.jsonl.gz plan/log/6911-linear-char-code-at-20261007/candidate-v1.jsonl.gz`.
Raw logs, observation rows, original test bytes, strict configuration and
comparison result are retained without behavioral normalization or exclusions.

## Dependencies and next integration action

This extraction builds independently on frozen main 6c88. The root runtime
README is byte-identical to B's published #6577 copy, avoiding divergent add/add
content. Do not claim a newer shared contract was consumed or a newer main tested.

Future detached provider reuse requires A's authentic reservation/ABI binding
of the defined ASCII helper and five locals, preserving its cache effect. A's
shared Unicode admission and Prepared-array preparation contracts remain
unreleased to B. This body factory does not itself certify numeric ownership.

[B's GitHub coordination request](https://github.com/loopdive/js2/pull/6582#issuecomment-6041736166)
also identifies published C ABI and vector initializer checkpoints. A's vector
read repair needs combined qualification with B's C ABI checkpoint; independent
green subsets are not combined-delivery evidence. No A acknowledgment is inferred.

After the final push, A should refresh exact PR heads, compose the disjoint
runtime changes, retain all failing controls, qualify the integrated epoch and
submit through the protected queue only when justified. This task is not on main
and the full IR migration goal remains open.

## Current-main845 composition (2026-10-08)

The old epochs above remain historical. Fresh baseline production is canonical
`8452732f0b88c14c5c7634ece58f83240970ea4c` (test-only HEAD
`a2e5f2c5af0ae9a2209a444a5ac4c70ea2e009d1`); candidate execution HEAD is
`62a0cf9294e3743319188790b5866375d7bccde3`. Both use identical frozen test bytes.
All 41 ordered test names/statuses match: 38 pass, three retained original
failures, no pending tests. Complete raw failure text matches exactly, without
normalization. Ten full provider rows and fourteen binary witnesses match;
strict test-inclusive TS7 exits0 with no diagnostics. No production changes
were authored during this refresh; the unchanged provider was composed with main.

Replay saved populations and complete failures:
`node plan/log/6911-linear-char-code-at-20261007/main-845/compare-population.mjs`.
Replay all provider rows and binary witnesses:
`node plan/log/6911-linear-char-code-at-20261007/compare-provider-rows.mjs plan/log/6911-linear-char-code-at-20261007/main-845/baseline-provider.jsonl.gz plan/log/6911-linear-char-code-at-20261007/main-845/candidate-provider.jsonl.gz`.
The `main-845` directory retains raw JSON/logs, input and terminal receipts,
execution runners, strict configuration and its empty diagnostic log.

B's ownership acknowledgment is now on the actual A coordination thread:
https://github.com/loopdive/js2/pull/6583#issuecomment-6054418671.
No overlap with A's published file scopes was found; no ownership was transferred.
This limited preservation result does not clear HOLD or establish full IR equality.
