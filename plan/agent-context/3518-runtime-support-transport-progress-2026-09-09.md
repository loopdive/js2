# Formatter runtime-support transport integration

Status: uncommitted integration in `codex/3518-runtime-support-transport-20260909`, based on `721cd33a828c89cfc04c851b011f910b76a4d2c5`. Not full formatter execution, async materialization, ABI30 completion, public cutover, or retirement.

Composed the frozen R/F implementation from `/private/tmp/js2-3518-symbolic-support-ref-20260909/.tmp/symbolic-support-ref-r2-validation.json`. All 26 recorded R/F/T dependency hashes matched after composition. The R/F worker's final run was 30/30 and TS7 exited zero; those results cover the real radix SSA build and source producer, not this whole transport integration.

T now builds support once before joint capture, retains it through the existing semantic freeze and codec reconstruction, independently reconciles primary demand, validates the separate body and allocation population, and adds seven required ABI entries before the runtime tail. The support body never enters ordinary inventory, derived units, startup, or primary functions. Missing support is a failure even when its own demand receipt is removed.

Parent validation receipts, all terminal:

- `37713`, exit 0: 16/16 across transport (7), codec (4), guarded fresh-process replay (2), and identity (3), 22.80 seconds.
- `68757`, exit 0: TS7 with `--noEmit -p tsconfig.ts7.json`.
- `90298`, exit 0: 109/109 across native-family source contract (45), Promise resources (33), and vector resources (31), 40.52 seconds. Original policy-refusal diagnostics and primary 5/22 -> 16/33 populations remain tested.

Heavy commands used one Vitest fork and 2 GiB limits; TS7 used GOMEMLIMIT=2GiB and GOMAXPROCS=1. No heavy process remains from these parent invocations.

The subsequent High amendment added no ABI schema or legacy caller changes. `assertPreparedIrRuntimeSupportDependencies` now traverses actual support body/signature fields from the existing complete program validator, rejects unsupported and physical reference forms, and reconciles canonical dependencies against required ABI declarations. Session `7107` exited 0: 17/17 across transport (11), codec (4), and source-free replay (2), 24.13 seconds. Four new controls independently remove type/callable declarations or introduce a nested foreign reference/physical index while retaining original occurrence receipts. The preceding dependency-join smoke session `40669` passed 9/9 on the earlier test population; it does not cover those four added controls.

TS7 sessions `99588` and `59936` exited 1 on binding-union narrowing. The final fix uses an explicit local binding and terminating guard, then captures its ID before the callback. Session `4660` exited 0. The canonical core/program modules are now mandatory in the boundary policy with additive history and unchanged allowed edges; classification of the newly extracted frontend wrappers still needs its reviewed disposition and executed boundary verification.

The dependency review found that canonical callable membership alone did not authorize a literal materializer field. D1 now rejects any own storage/materializer attachment on support literals. A genuine literal mutated with the canonical `new` kernel is rejected through both complete program validation and codec reauthentication. Additional real-packet controls cover foreign anchors, kernel order/duplicates, nullability, storage width, missing literal receipts and retired allocations.

After formatting all 47 source/test paths (`18508`, exit 0), session `69266` exited 0: **167/167 across nine suites**, 64.72 seconds. This combines R20, F10, transport18, codec5, source-free2, identity3, native-family45, Promise33 and vector31 on the formatted implementation. The earlier expanded transport run `15405` passed 25/25 before that formatting.

Boundary activation required a measured correction: the checker enforces every file assigned to an active layer, irrespective of its unmigrated state. Contracts-only frontend activation therefore exposed pre-existing dependencies in 17 of the 20 existing frontend debt files. High approved changing exactly those 17 layer labels to mixed-needs-split with destination frontend-ts, retaining all unmigrated states and existing owner/next-boundary text. Divergence-classifier, node-capability-map and ts-api remain unchanged. All previous active history and allowed edges remain intact. Inventory audit `43404` exited 0 with zero errors and **architectureComplete:false**. Earlier failing audit `75317` is retained as the activation diagnosis, not ignored. Targeted boundary run `18519` passed 17 with 42 explicitly filter-skipped; the subsequent complete boundary suite is not yet recorded here.

Complete boundary retry `5497` passed 64/64 in 31.19 seconds. The first complete run `6867` had 60/64 because four newly added fixtures omitted their contracts-only root and mixed-debt owner metadata; diagnostic run `21108` confirmed those setup errors, and focused retry `79871` passed 4/4 before the complete rerun. No detector implementation or allowed edge was changed to resolve these fixture failures.

Preservation gate `12667` exited 0 under the explicitly approved preservation-only contract: 12/12 core-node executed callers, 10/10 core-type full/cut references, and 6/6 moved source witnesses in both views. The strict graph remains OPEN on the original nonliteral imports in optimize.ts and platform-capability-adapter.ts; retirement/deletion is NOT certified. Final post-format TS7 `80148` exited 0.

Older builtin run `67058` exited 0: 19/19 across five suites in 20.84 seconds, including generalized self-hosting, host/standalone timsort, cache identity, and the original standalone/WASI radix cases. These are preservation controls, not execution of the new prepared D2 formatter.

Final Astra High static review approved the non-draft D1 semantic-support checkpoint, including the exact 17 debt classifications, unchanged prior history/allowed edges, and complete-validator materializer rejection. Reviewed source/test manifest SHA-256: `d989f81cb02d9dd1ea1d47879a076d8daf7bf17419fb93825c9fa1ace4fbe628`; policy SHA-256: `f3b8b58050c85d9018cd135e3d4a4b6dbb09c2b1fed0f286c91fb1fa4602e42d`. The earlier pending-classification and pending-boundary notes above describe intermediate states; the subsequent review and 64/64 receipt supersede them.

Still required before publication: normal commit/push hooks and a non-draft PR on loopdive/js2. D2 physical formatter emission remains required afterward.

Normal commit attempt `96236` exited 1 on Biome `noVoidTypeReturn` in the dependency visitor. Replaced `return invalid(...)` with a block that calls the same throwing helper then returns without a value. No validation policy changed. Post-amendment TS7 `13215` exited 0; normal hooks must still pass on retry.

Normal commit retry `65612` passed formatting, lint and the file-size budget but exited 1 at the function-size budget: `verifyInstrTypeRules` measured 317 lines and `lowerVarDecl` 305, both above 300. Applied the implementation subagent's helper extraction (`0172f51be673f10eff4add10f365897b000cc9e22f8618c4a7972a457f9e2f92` patch SHA-256): `checkSupportRefFlow` preserves the instruction guard order and diagnostics; `resolveMutableLocalRepresentation` preserves widening, rejection and resolver behavior. No budget allowance or gate changed. Post-refactor review, tests and hook retry remain required.

Post-refactor function-budget run `93371` exited 0. Scoped verification `96167` exited 0: **55/55 in five suites**, 32.62 seconds, covering symbolic support references (20), genuine source support (10), transport (18), codec (5), and fresh-process source-free replay (2), with no skips. These runs supersede the corresponding pending checks above; final TS7, amendment review and normal hooks remain pending at this writing.

Final post-refactor TS7 `51116` exited 0. Astra High approved the applied helper extraction and lint guard as semantically equivalent, retaining D1 publication approval. Verified SHA-256: verify.ts `fd73abfc7adb62789a1a794ace44f007baa53a141e946a98ebaeb20f23adfd0a`; from-ast.ts `d887bbd1dc61d68fdefedd665ce2eb409af28d0336f03960cdd30d058f1392d3`; dependency validator `0ea7a1b7d7ce5bf0a035d8b3a4c9c5a65aabd841ddd3c7a7c10bf82b11c9b8a7`. Normal commit/push hooks and publication are the remaining D1 handoff steps.
