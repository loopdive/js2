# PR5748 quality failure: additional HOLD blocker and test-localization proposal

2026-09-27. Source inspection only. No compiler, tests, hooks, source/test edits,
gate/baseline changes, commit or push. Parent retains the execution slot. Earlier
BigInt receipts, failures and fixture bytes remain historical and unchanged.

## Demonstrated failure

- Published and locally inspected HEAD: `d6f4da7029f06ea81ac20f6271a285fa6179d9a9`.
- Owned branch: `codex/5748-main7443-integration-20260927`.
- Fresh GitHub read: MERGEABLE, BEHIND; no unresolved review threads returned.
- CI run `36309414605`, quality job `108592349253`:
  https://github.com/loopdive/js2/actions/runs/36309414605/job/108592349253
- Failed step: `Dead-export gate (#3090 Phase 2)`, exit 1.
- Step command: `pnpm run check:dead-exports`, expanding to
  `node scripts/audit-legacy-reachability.mjs --check --moved-reference-contract=preservation-v1 --require-core-types --require-core-nodes`.
- Actual log at 09:31:19 UTC:

```text
core-node execution gate: PASS (12/12 observed callers; dispatch-cut UNKNOWN)
core-type gate: PASS (10/10 full, 10/10 dispatch-cut class-free references)
moved-runtime gate: FAIL (production-rooted evidence incomplete)
  src/optimize.ts#getBinaryenModule: unknown nonliteral dynamic import module target at line 394
  src/runtime/platform-capability-adapter.ts#resolvePlatformCapabilityImport: unknown nonliteral dynamic import module target at line 146
dead-export gate: 1 NEW unreferenced top-level function(s) in src/codegen/:
  src/codegen/vec-own-index-export.ts#vecOwnIndexExport
```

The script exits at the added-dead-symbol branch before evaluating its final
preservation-only result. Its selected preservation contract can tolerate an
incomplete strict graph if source integrity and the old ratchet are unchanged.
Consequently the two nonliteral imports are recorded limitations, not separately
proven terminal blockers. No gate success is inferred without later execution.

Evidence was read with `gh pr view 5748 --repo loopdive/js2`, the GraphQL
reviewThreads query (filter unresolved), and
`gh run view 36309414605 --repo loopdive/js2 --job 108592349253 --log-failed`.
Initial sandbox network reads failed; approved read-only network access succeeded.
No live-run polling, rerun or remote mutation.

## Consumer inventory and ownership distinction

`rg -n 'vecOwnIndexExport|vec-own-index-export' src tests scripts` finds the
getter declaration at `src/codegen/vec-own-index-export.ts:169` and exactly three
test calls in `tests/issue-5399-vec-own-index-export.test.ts`:

- Line 41: retrieve the allocator descriptor after compilation to select the
  published instance export.
- Line 128: repeated emission retains descriptor identity despite colliding
  user export names.
- Line 151: compiling another module does not change the first module's identity.

The tests import the module namespace at line 16. Production
`src/codegen/vec-access-exports.ts` imports only `emitVecOwnIndexExport` and
`finalizeVecOwnIndexExport`; their calls are at lines 529 and 342 respectively.
The boundary inventory lists the file, not a getter consumer. The accessor was
introduced in `4335a57cc7718bbb0d75ef7c1ad4506efefab8f7` as a future publication
interface. Its comment is intent, not an implemented A1 runtime consumer.

The private allocation WeakMap is NOT test-only: emission deduplication and
finalization use it. Only this read accessor is presently test-only. Preserve
that storage and both production operations unchanged.

## Proposed diff scope, not implemented

Two files only, plus this handoff:

1. `src/codegen/vec-own-index-export.ts`: remove only the five-line exported
   getter/comment. Keep the WeakMap, allocation, demand, return type, descriptor
   publication and finalizer byte-for-byte unchanged.
2. `tests/issue-5399-vec-own-index-export.test.ts`: replace the three getter
   calls with a test-local observer of the existing real emission spy. No source
   fixture strings, row names, expected values, optimization variants, corruption
   cases, or runtime operations removed or relaxed.

The observer should snapshot export object identities immediately before calling
the real emitter; call it exactly once; and on a first defined returned handle
require exactly one newly inserted function descriptor whose index equals that
handle. Retain that exact object and the function resolved by `definedFuncAt`
before finalization. Do not select by display name, guessed ordinal, last export,
or a second emit call added merely for discovery. An undefined handle must add no
descriptor. Later observations for that context must add none and resolve to the
same function; finalization may legitimately change the descriptor index.

Keep observer state local to each `built` invocation (or an explicitly scoped
test-only observer), keyed by the actual context where needed; never a global
latest-context slot. Restore spies in finally. For the repeated-emission assertion,
observe that existing explicit emit operation and verify no additional descriptor,
the same function identity, and the original descriptor still present exactly
once. For the cross-module assertion, retain the first observer's descriptor and
verify its identity/membership and original supplying instance independently of
the second compile. Preserve the existing finalizer corruption checks, including
replaced and duplicated descriptor rejection: these are the production checks
that authenticate allocator ownership after observation.

This preserves the intended externally observable assertions, but not the literal
assertion that the removed getter returns a private WeakMap entry. That accessor
assertion is replaced by actual emission/publication identity observation plus
the existing private-ownership finalizer negatives. Review this equivalence before
implementation; do not silently claim an unchanged test implementation.

Likewise, removing an exported internal TypeScript symbol IS a module API removal
in the literal sense. Repository inspection supports no current production
consumer or runtime ABI change, not a guarantee about external unpublished users.
If “no production API change” means retaining this exact export, localization alone
cannot satisfy the request: a unused production getter would still trip the gate.
Future A1 publication design must not be claimed implemented by this proposal.

## Validation boundary after approval and explicit slot grant

Run the unchanged dead-export command first and preserve its first result, then
full original own-index test file (all cases/optimization variants), scoped typecheck
and formatting as granted. Confirm collision, repeated emission, independent
modules, wrong-instance routing and all five corruption controls remain present.
No baseline update, gate exception, artificial production caller, fixture/floor
change or widened runtime activation. Quality failure remains an additional HOLD
blocker until the approved change and actual gate result are reviewed. Four array
blockers and all earlier BigInt/IR-equivalence limits remain separate.

## Approved implementation, source-only review receipt

Parent approved the two-file localization after reading this proposal. Implemented
against `d6f4da7029f06ea81ac20f6271a285fa6179d9a9`; not executed or staged.
The earlier proposal and CI evidence above are historical, not a pass receipt.

- Production diff is exactly the five-line removal of the unused internal
  `vecOwnIndexExport` accessor/comment. This is an internal exported API removal,
  not legacy compiler retirement. Allocation storage, emitter and finalizer are
  unchanged; no replacement production caller or future A1 activation.
- Test diff adds a per-`built` WeakMap observer keyed by real context. It records
  the unique newly inserted descriptor and resolved function at actual emission,
  checks existing descriptor identity/order retention, and checks no insertion
  on absent demand or repeated allocation. Saved descriptor membership/name and
  function identity are checked after finalization, allowing physical index changes.
- The existing repeat-emission call now goes through this observer, which calls
  the captured real emitter once. The three former getter calls use observed
  descriptor identity. Spy restoration remains in finally. The original five
  corruption cases still call the real finalizer and retain their original errors.
- All fixture strings, test names, original expected values, parameter lists and
  optimize variants remain unchanged by diff inspection. Static case enumeration
  remains 26 (12 optimization-expanded plus 14 demand/ownership cases); this is
  not an executed count. Test implementation has changed as disclosed, including
  additive observer assertions; the removed getter's private-map read is no longer
  itself under test.

Review diff:

```sh
git diff d6f4da7029f06ea81ac20f6271a285fa6179d9a9 -- src/codegen/vec-own-index-export.ts tests/issue-5399-vec-own-index-export.test.ts
```

SHA256 before validation/formatting:

- `src/codegen/vec-own-index-export.ts`: `8812aafce8326c6fd4d2f26d40136fb9e221b3bdc8818a97d6efe757ce657f69`
- `tests/issue-5399-vec-own-index-export.test.ts`: `2453d4b30f0b2433fdab4016c78bac7c441b903a659b402b5ec798ebfac3f3c4`

No compiler, tests, formatter, hooks, gate or baseline execution. Huygens retains
the slot. No gate/baseline edits, fixture deletion, commit or push. HOLD remains
until review and explicitly granted validation; all prior evidence is preserved.
