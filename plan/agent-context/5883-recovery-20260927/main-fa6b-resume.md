# Main sync and resumed implementation

2026-09-27. Continuation of the held recovery checkpoint, not production
acceptance or old-compiler retirement.

## Authoritative working state

Integration worktree: `/private/tmp/js2-5883-main-6eac-20260927`.
Branch: `codex/5883-main-6eac-20260927`.
HEAD: `fda4b498696f395889e199756c6b8c27a629387c`.
Merged upstream main: `fa6b3a6126d463b278e0e70fff68789070998344`, also
verified against the remote main ref after validation. Uncommitted repairs
were preserved from the previous main-688 tree with a clean three-way replay.
The shared root and older worktrees remain untouched.

The only replay follow-up removes the duplicate String helper inventory entry
whose nextBoundary begins "Separate source BigInt classification"; upstream's
entry beginning "Separate AST argument compilation" is retained. No inventory
allowance or activated layer changed. Both new lease/conversion test files were
included in the replay, not left behind as untracked work.

Recovery patches remain in `main-688-followup` and `coercion-lease-followup`.
The new worktree is the authority for this sync; this document is not a new
full source archive. Never apply incremental patches twice.

## Measured sync correspondence

Ran the unchanged four suites: iterator-protocol-get, runtime-to-object,
promise-vector-iterator and promise-vector-acquisition. Single fork, 2048 MB.
Result: **113/136 pass, 23/136 fail**, exit 1, no removed fixtures.
Compared all 136 unique full test names, statuses and failure-message arrays
against the previous `prepared-coercion-candidate.json`. Replaced only each
arm's exact worktree path with the same placeholder in BOTH reports. Zero
changed rows. Four rows in each arm still have null failure details; this
does not prove equality of their unknown exception values.

New report: `.tmp/main-fa6b-runtime-baseline.json`, SHA-256
`f864e833d19d5460a9143d38357f581d1486e0e3a2a0a29dfc6950e2387a62a1`.
The raw reports remain in their respective integration worktrees.
Diff whitespace checks pass. Inventory is valid with zero errors, but
architecture remains incomplete. Conversion vocabulary and checker-query
ratchets pass without new allowances. The original runtime failures and
unwired staging/reachability blockers remain blockers.

Full source TypeScript 7 plus the eight ownership/editor/conversion test files
also passes on the synced tree, using `.tmp/tsconfig-coercion-lease.json` and
the repository's `node_modules/typescript7/lib/tsc.js` entry point. An initial
`pnpm exec tsgo` attempt only reported a missing command and ran no compiler;
the subsequent repository-native check completed with exit 0.

## What reached main

PR 6183 (constructor identity / evolving-any instanceof prerequisite) is
MERGED at `6eac568d412537091ca6201878fbc492deab3631`; its conformance watcher
finished successfully. PR 6180 (compatibility artifact refresh) is MERGED at
`fa6b3a6126d463b278e0e70fff68789070998344`. Both are in this integration HEAD,
as is the earlier PR 6182 BigInt String prerequisite. Their watcher handles
are terminal; do not restart them.

## Resumed parallel assignments and parent decision

Curie implements the reviewed immediate-resource / attached-effectful-prologue
/ captured-tail boundary, only in its owned drive and observable-protocol
modules and focused tests. This is an intermediate extraction, NOT the fully
detached whole-drive renderer and NOT production pending-operation activation.
Preserve constructor publication/seeding, local/string allocation checkpoints,
shift-root coverage, legacy omitted-option behavior and original failures.
No discarded warming emission, fabricated ready proof or silent index repair.

Hume specifies the remaining constructor identity / own-property seed
prepare-versus-emit seam. Preserve reentrant publish-before-seed identity,
lazy runtime order, speculative registration rollback and cold/warm behavior.
Reviewable source-backed spec first; no production edit or compiler run.
Its planning directory is not a Git worktree and must not be used for Git edits.

Parent remains the integration owner. Agents must request the serialized
compiler slot before runtime/typecheck work. Full detached emission, actual
pending-node ownership and provider closure remain required next steps.
No end-to-end IR program has yet demonstrated complete equivalence. The old
compiler stays until the new IR path is fully implemented and equivalent.
