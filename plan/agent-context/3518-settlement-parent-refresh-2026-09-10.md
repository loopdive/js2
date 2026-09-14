# Settlement parent refresh: validation blocked

PR5754 head `535ee6b6ba19239394ee50f8235e6c528212688b` is being refreshed
against its parent PR5752 at `3b1fbc608b3b95d5136b43fe81d2c7db739b9e67`.
The isolated branch is `codex/5754-parent-refresh-20260910`.

The merge preview tree is `ef7ba2af6f889da8f198b3944170180b0a4e925d`.
Its only conflict is appended issue3518 history. Removing only the three
conflict marker lines preserves both full histories exactly. All six PR-owned
production/test files still match the original PR head byte-for-byte.

On Node25.9.0 Darwin ARM64, the three-file Vitest run finished EXIT1:
241/249 passed, eight assertions failed. Ownership passed129/129 and semantic
provider boundary passed101/101. Source preservation passed11/19.
Two of its eight source fixtures (delay and native-family) throw during
WebAssembly.Module construction: the native delay function mixes legacy and
new exception-handling instructions. Six hook/adoption/rejection fixtures
execute. The remaining six failed assertions depend on the two failed rows.
This is not yet attributed to the parent refresh versus the original head.

Raw fixture reports and terminal receipt remain in the isolated checkout at
`.tmp/promise-settlement-P2eTgv/`. No fixture, expected value, gate, or failure
was removed. The test process is terminal. The merge is uncommitted and has
not been pushed; the PR hold remains intact.

Next: compare the same source fixtures on the original PR head using the same
runtime/dependencies, then identify the exact exception-handling change or
previously documented repair. Do not infer conformance clearance from the
230 passing ownership/boundary controls. No expanded registry-intervention
diagnostic requests were executed.

## Original-head control

The untouched original head was measured in
`/private/tmp/js2-5754-original-control-20260910` with the same Node25.9.0
executable and canonical dependencies. Both eight-row reports and child
terminal receipts are preserved in
`/private/tmp/js2-5754-refresh-pair-20260910`.
Both sides execute the same six hook/adoption/rejection fixtures; both delay
and native-family fixtures throw mixed-exception-handling CompileErrors.
The delay error is identical (#309, offset106875). Native-family differs:
original fails at #346 `__async_resume_fmain__ir`, offset114063; refreshed
fails at #314 `__ir_promise_delay_native`, offset110573. Thus the original
already fails, but exact error/artifact preservation is NOT established.

The existing pair command finished EXIT1 after producing both reports: its
comparison intentionally requires historical baseline `e3de0f3ff7d7828c66b3fea7946f08e593bf77d8`,
and rejected the original PR head as that baseline. This admission failure
is retained, not bypassed; this run is raw original-head attribution evidence,
not an accepted historical comparison. Neither failure justifies relaxing a
test or the landing hold.

## Local targeted repair (not yet published)

The standalone-only native delay provider emitted a legacy `try`. It now uses
the existing `buildStandardTryTable` helper with both original handlers:
tagged externref rejection first, foreign-exception sentinel rejection second.
No handler body, fixture, expected result, or shared EH helper was changed.
The source-preservation suite now passes19/19 on Node25.9.0; JSON receipt:
`/private/tmp/js2-5754-delay-eh-vitest-20260910.json`.
Ownership, boundary and native-delay behavior checks are being run separately.
This fixes local execution, not the historical-baseline admission rejection or
the independent conformance hold. The original failure receipts remain intact.

The broader three-file check subsequently finished EXIT0 (receipt
`/private/tmp/js2-5754-delay-eh-blast-20260910.json`). Independent read-only
review found no blocking defect: handlers and publication order are unchanged,
the provider is standalone-only, and the helper module was already reachable.
When refreshing PR5759, carry this repair into its extracted `delay-bodies.ts`;
that downstream body still emits legacy `try` and must not restore the defect.
