# PR5883 recovery checkpoint — not a landing candidate

This directory preserves incomplete implementation work as reviewable data.
It does not activate that work, change runtime sources or expectations, or
authorize landing PR5883. Keep the existing `hold` label and auto-merge off.
The old compiler remains until the IR path is fully implemented and equivalent.

## Exact recovery

- Published source base: `608be80f6beef338665fdcdb834e7d9b9f20b925`.
- Working integration HEAD: `18f1bd831312b3f5805f1e176388aac449c2d389`, plus
  the recorded uncommitted source/test changes. That HEAD contains upstream
  main `2a58b9fe9f95dc17bd5d2ba44ecd564b9695356b`.
- `integration.patch` includes all 39 changed/new source and test files,
  relative to the published source base. SHA256:
  `11ba93965347ce6c270b020ffb9d8637510cb228d3e6d50c92f4085b7ddf360b`.
- `source-sha256.txt` records the resulting file bytes. Apply only in a new
  isolated checkout of the exact base, never over another session's edits.
  `git apply --check --whitespace=nowarn integration.patch` passed against
  that base. Verify resulting hashes before continuing.
- Vector prototype storage v1 is separately preserved and NOT integrated;
  its patch is based on `bed38fc00a4dc3b3e7298a39c56c18d37cee9f03` (PR6181).
  Its two supplemental test snapshots are `.test.ts.txt` data, unexecuted.
  Do not apply either patch as an acceptance claim.

## Latest measured state

- Combined TypeScript checks passed (handles87878,97704,69853, all terminal0).
- Exact ToObject20 comparison: baseline2/20, initial integration11/20;
  nine gains, zero pass losses. Every source/hash is retained in the pair.
- Semantic index Get repair: function receiver checks now pass. The combined
  50-case run72096 is31/50; original reflective5/6 and live substrate10/12
  retain their previous results. Full log is `5883-live-semantic-get-first.txt`.
- BigInt prototype classification run44569: ToObject12/20 and diagnostics6/12,
  total18/32. Two BigInt getter cases improve; valueOf/slot/equality failures
  remain. Full log is `5883-bigint-proto-first.txt`.
- Pure scanner extraction run14199:36/36 equivalence controls pass.
- No tests, expected values, fixtures or conformance floors were waived.
  Node's exhaustion reference discrepancy remains a failing assertion.

## Required next work

Early activation remains unimplemented. Immediate fresh-context retry is not
approved: the complete feasibility audit identifies discarded speculative/
discovery emission, reused AST state and telemetry hazards. Do not replace
exact admission with a broad source scan or add a success fallback.

Vector prototype integration requires a lossless single Object prototype
authority: its current Object-only field loses Object-to-vector identity
before SameValue/cycle validation. The provider blocker documents this.
Default/cycle providers and frontend/indexed-reader integration remain needed.
The class/generator/Error blockers for PR5753 remain separate work.

PR6181 is the tested array-length prerequisite. Last observed OPEN/QUEUED at
position4; verify live state and main content before claiming delivery. Do not
refresh its queued head. Compiler execution is serialized; no parent process
is live at this snapshot. Plans and receipts here preserve historical states,
not permission for concurrent runs or assertions that every source is tested.
