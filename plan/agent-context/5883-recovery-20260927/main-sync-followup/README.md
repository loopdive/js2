# Main synchronization and staging checkpoint — 2026-09-27

## Authoritative locations

- Upstream main: 456771a7cd0a0a866a8a818ebf60117738caa18f.
- Owned successor: /private/tmp/js2-5883-main-sync-20260927,
  branch codex/5883-main-sync-20260927.
- Merge commit: a3c3d9fb1c (full ancestry verified against upstream main).
- Original unfinished tree remains intact:
  /Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927.
- Shared root and queued PR heads were not modified.

## Why a successor was needed

Normal checkpoint hooks rejected an existing constant-condition type test,
then four file-size overruns: vec-overlay +30, proto-index-store +13,
assignment +12, and index +8. No hook bypass, limit increase or manual stash
was used. The negative type assertions now live in an uncalled function;
all assertions are retained. Existing unfinished changes remain staged in
the original tree. A clean successor from its HEAD merged main, then applied
the full 82-file owned diff with git apply --3way. Every file applied cleanly.
The unfinished source is still uncommitted and not landing-ready.

## Validation on the successor

- Session 62814: seven pure-test files, 99/99 passed. A subsequent attempted
  tsgo command was unavailable; that command did not typecheck anything.
- Session 56189: the repository TypeScript 7 compiler found a duplicate
  ensureSymbolNativeProtoGlue import in expressions/calls.ts after integration.
- Removed only the duplicate between ensureBooleanNativeProtoGlue and
  ensureObjectNativeProtoGlue; retained main's existing import after
  ensureStringNativeProtoGlue.
- Session 62776: TypeScript 7 exited 0 with all source plus explicit
  staging-foundation, staging-edit and reference-storage-operand test files.
  Negative type assertions were included.
- Source command: node node_modules/typescript7/lib/tsc.js --noEmit
  -p .tmp/sync-typecheck.json (extends tsconfig.ts7.json, noEmit, no incremental).

The attached source/test copies are data, not production wiring. Editor
operations remain isolated: leaf removal, same-region permutation, nested
paired rollback and independent census. No pending-operation activation.
These pure tests do not prove runtime equivalence or authorize old compiler
retirement.

## Resumed work and queue

Huygens's isolated TypedArray candidate typecheck passed (21686), with
original diagnostics preserved; runtime validation remains unperformed.
Hume reviews real Array identity and pre-source provider closure.
Curie and Mendel continue isolated closed-BigInt-field/default source work.
Russell reviews the editor's exclusive construction-token ownership gap.
Singer's tool-blocked diagnostic is not retried through another route.

PR 6177 is on main. PRs 6181 and 6182 remained open at this sync.
Conformance run 36295793335 was still running with no terminal failing jobs
at the one-shot status read; this is not a pass claim. Queued heads remain
bed38fc00a4dc3b3e7298a39c56c18d37cee9f03 and
6670264762a294f502753c67e318edde38dc10ef respectively.

Next: reconcile concrete source-budget blockers without waivers, integrate
coherent source patches, rerun unchanged paired runtime fixtures on this
new base, and shepherd the protected queue. Prior-base paired measurements
remain historical evidence, not current-base runtime certification.
