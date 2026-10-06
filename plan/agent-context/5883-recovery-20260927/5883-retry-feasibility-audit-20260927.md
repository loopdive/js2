# PR5883 retry feasibility audit: not cleared for implementation

2026-09-27. Hume, architecture only. Read the FULL adjacent activation plan before this audit. No compiler, tests, production edits, git mutations, PR operations, or retry/deferred implementation. This planning record is the only new artifact. All existing sources, failures, old-compiler/IR-equivalence obligations and parent ownership remain unchanged.

## Verdict

The proposed immediate retry at the original-vector branch is **not proven safe and should not be selected as implementation-ready**. The branch is an inner lowering decision, not a surviving-emission boundary. Source establishes actual always-discard probes and discovery-body replacement around that decision; the current snapshot API has no admission-commit notification. Fresh CodegenContext alone also does not isolate source/checker identity caches or process-wide telemetry.

This audit qualifies the previous plan's recommendation: a fresh attempt remains a possible design, not an exact solution already supported by the current pipeline. Detecting a missing witness only AFTER retry and returning an error would introduce precisely the prohibited new failure for an otherwise unadmitted input. A third attempt, fallback admission, altered scan, or relaxed parity gate is not an authorized remedy.

Source anchors below are relative to `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-preservation-repair-20260927`, read during this audit. They describe current source, not a pinned immutable diff. No runtime counterexample or success count is claimed.

## 1. Exact branch and enclosing emission

The direct expression path is compileExpression -> compileExpressionBody -> inner call dispatch -> `expressions/calls.ts:9799` compileNamespaceStaticCall -> `expressions/call-namespace-static.ts:2903–2907` observable gate -> `3011–3055` argument-shape probe and original-vector branch. Observable still means the call's own SourceFile resolve/then scan, eligible intrinsic non-subclass all/race and the existing earlier literal/collection decisions. No module-wide OR belongs in that decision.

At 3011 snapshotSpeculative starts the argument probe. compileExpression(arg0) can recursively compile arbitrary expressions and lifted bodies. resolveExternrefVecArg, or observable-only resolveF64VecArg, determines the branch. The branch keeps THIS probe and calls D; it does not notify any outer transaction or certify that fctx.body will be published.

Three enclosing mechanisms are source-proven:

1. **Every general expression has an outer snapshot.** `expressions.ts:835–852` snapshots before compileExpressionInner; on an exception it rolls back, reports a diagnostic and emits a default value. The same wrapper can run recursively. A new admission WeakMap entry is outside that snapshot and would survive discarded expression instructions unless explicitly associated with their ownership.

2. **Type probes always discard successful expression emission.** `array-methods.ts:406` probes a nonliteral HOF callback; `1213` probes an expression's runtime type; `2169` probes an array-method receiver and later recompiles it. These call compileExpression and therefore can traverse comma/subexpressions or lifted code containing the exact Promise branch. `context/speculative.ts:242–249` uses finally to roll back even when the probe successfully returns. The outer Set/Map combinator probe at `call-namespace-static.ts:2965–2967` similarly compiles arg0 then unconditionally rolls back. These prove that reaching the branch need not mean retaining that particular emission. They do not by themselves prove a specific source loses the call permanently: some callers subsequently recompile it. That distinction is why a first-visit signal is not an outer-commit proof.

3. **Module-init discovery is intentionally not publication.** `declarations.ts:6304` compiles pass 1; `6502–6532` can replace compiledInitFctx with pass 2 after restoring property-order state. At `6555–6559`, only full mode injects the selected body; discover/skip never inject. `index.ts:11092–11108` deliberately chooses discover for the first source, skip for intermediates and full for the final source of a graph. The discovery pass sees the complete accumulated statement list under intermediate registries. A call-node identity seen in discovery is not evidence that the same lowering is used in final emission.

The ABI/IR routes introduce a further ownership distinction: `declarations.ts:6388–6407` may skip/preserve a runtime-namespace body according to exact unit routing, and the surrounding top-level function routing similarly selects prepared versus direct bodies. A source position cannot identify which emitted body epoch owns the call.

**Conclusion:** an admission flag/Set of source spans is insufficient. There is no exposed transaction stack in snapshotSpeculative: a successful commit is merely discarding a snapshot, and many callers manually call snapshot/rollback rather than a common wrapper. The current API cannot tell a listener that all enclosing probes and discovery replacements have committed.

## 2. Rollback coverage is not a fresh-attempt transaction

`context/speculative.ts:41–88` snapshots body length, local state, diagnostics, imports/counts, pending shift and an advisory type count. It has no Promise admission, body epoch, helper registry, ABI session or source-cache field.

`rollbackSpeculative:110–196` truncates instructions/restores locals and selected diagnostics; it deliberately retains registered types. Contrary to an overbroad reading of the memory rule, the current implementation does not universally throw on an already-flushed import batch: its probeFlushed check conservatively keeps those imports rather than undo their shifts. Import globals also remain. This is a useful existing safety behavior, not a whole-context inverse or evidence that activation can be undone.

`withSpeculativeCompile:214–229` rolls back before rethrow on exceptions; `probeCompiledType:242–249` rolls back in finally. Changing only compileExpression's catch cannot stop these unwind actions. For an entirely abandoned context that cleanup may be harmless, but it is not evidence permitting that context to be resumed or published. A signal raised inside a rolled-back successful probe is still a provisional observation.

## 3. Catch/unwind trace to generation boundary

For a direct ordinary function statement the control path outward is:

- original-vector branch -> namespace/call dispatcher (no catch around the namespace call at calls.ts:9799);
- inner `compileExpressionBody`, whose catch at expressions.ts:844 currently consumes all throws, rolls back and emits fallback;
- outer compileExpression calls, each with that same catch, plus the recursion-depth finally at expressions.ts:671–675;
- compileStatement catch at `statements.ts:483`, currently converts every unhandled throw into a diagnostic;
- compileFunctionBody (no TypeScript catch around ordinary body compilation found in this file); caller catch in `declarations.ts:6369` for top-level functions, or `6411` for runtime-namespace functions, or `6469` for CJS function expressions;
- generation's outer catch at `index.ts:7090` / `11859`, currently records failure and returns a module-plus-errors result;
- `compiler.ts:1086–1103` receives that result and publishes its telemetry into the pipeline result; later binary/WAT emission must never see an abandoned attempt.

Other source-emission roots checked:

- Module init: compileExpression/compileStatement -> compileModuleInitBody -> `profilePhase(module-init-pass1/pass2)` -> generation catch. The profiler uses finally, not swallow/recovery, so it emits records even when unwinding.
- Class and variable-held class bodies: declarations.ts catches at 5592/5659; accessor/body route catch at 5811; nested classes can instead be reached through compileStatement. These roots cannot rely solely on the top-level function catch fix.
- Lifted closures: compileArrowAsClosure/closure-body lowering is reached inside outer expression emission, with statement/expression wrappers inside the body. The inspected catches at closures.ts:3494 and 4424 guard getText/signature inference respectively, not the source-body compiler, and do not need blind signal edits. Similarly calls.ts:3571/4030 guard checker alias queries, not the namespace branch.
- Speculative owners add the catch/finally rollback paths described above. A language-level JS try/catch lowers Wasm handlers and does not itself constitute a TypeScript control-signal boundary.

IR planning/transaction files contain additional catches, but a grep list is NOT a proven source-call path. Inspected `index.ts:2910` wraps type-map failure and `3344` turns type-resolution failure into IR fallback; `ir-overlay-finalize.ts:658` catches provider registration; `program-abi-prepared-transaction.ts:607` consumes descriptor lifecycle on failure. They must not be mechanically modified on the assumption they execute the legacy Promise branch. Conversely, until every callback that can enter direct source lowering from a prepared route is traced, an exhaustive all-route signal-transparency guarantee cannot be made. The bounded audit establishes the ordinary/module-init/class paths and concrete blockers; it does not falsely certify arbitrary IR/provider callback paths.

Required invariant for any future signal: identity check before diagnostic/fallback/rollback recovery at every actual intercepting catch; ordinary exceptions unchanged. A finally that restores invocation-local stacks can run. No catch may wrap the signal as IrInvariantError, record it as a failure or substitute a default value. The current code does not implement this invariant.

## 4. What a fresh generator really isolates

Positive evidence:

- `index.ts:5216–5232` creates a new module, inventory/planning identity, ProgramAbiSession and CodegenContext for single-source; `10613–10627` does the corresponding multi-source construction.
- `program-abi-session.ts:782–828` holds drafts, prepared scopes, locator references, state and publication in instance-owned maps and checks exact module identity in assertModule. It is tied to the module, not safely reusable across attempts. Constructing a new session at the existing entry boundary is the right behavior.
- `ir/planning-identity.ts:59–78` maps exact AST declarations/source files and captures module-init population; its readonly-map wrapper at 113 copies entries. `ir/identity.ts:573` keeps scanner metadata keyed by inventory. Building a fresh inventory/identity avoids adopting an old session's declaration-to-unit owner views, but it still points at the same AST when the caller reuses TypedAST.
- `context/create-context.ts:95–149` constructs fresh oracle, UsageInference, maps/counters, errors, fallback counts and optional outcome/audit sessions. `context/body-route-audit.ts:24–31` creates a new audit object, not a caller-owned callback. Strict-equality stale-property state is keyed by ctx (`strict-eq-stale-type.ts:12`); preserved descriptor-capture bindings are keyed by FunctionContext (`closures.ts:579`). Those owners separate naturally with a new context.

These establish a good **codegen-owned state boundary**, not a complete fresh invocation proof.

## 5. Reused state outside CodegenContext

### AST/checker identity and caches

The same TypedAST/MultiTypedAST passes the same checker/source nodes into a second generate call. createTypeOracle creates a new wrapper (`checker/oracle-backend.ts:45–54`), but TsCheckerOracle stores and queries that same checker; its per-node fact/key/declaration caches at `checker/oracle.ts:216–224` are only the wrapper's caches. This does not reset TypeScript's lazy internal state.

Process-level caches include:

- Whole-file override caches in calls.ts/member-override-scan.ts: syntax facts keyed by SourceFile. They are candidates for safe reuse only while source structure and relevant parent identity remain unchanged.
- `index.ts:12465,12533`: checker/type-keyed inherited Array/Map analysis. New ctx does not clear them; a genuinely new checker creates new keys.
- `declarations.ts:483,562,777,779,983–986`: AST-keyed declaration analyses. Not all are syntax-only. `functionReturnsHostObjectLiteralCarrier:1093–1138` reads ctx.oracle and objectLiteralTakesHostCarrier(ctx,...) but caches by declaration alone; `parameterHasPropertyWrite:570–597` also queries ctx.oracle. This is concrete ownership requiring review, not a demonstrated incorrect value under the retry's unchanged target options. It cannot be waved away as a universally pure cache.

### Concrete source-node mutation risk

`object-ops.ts:3744–3760` stores an original pass-through descriptor as entry.expr, whereas literal descriptors are synthesized. In the non-reify expansion at `3785–3799`, code unconditionally applies setTextRange(descriptor, descsArg) and sets descriptor.parent to a synthetic call. When the map contains a pass-through descriptor and merged literal entries, the preceding `reify = hasPassThrough && !mergedIntoLiteral` permits that non-reify path with an original descriptor expression. The source explicitly permits original-node mutation in this case. This is not a claim that the existing twelve sources take it; it disproves a general assumption that generation cannot alter reusable AST nodes.

Most other inspected parent writes build synthetic nodes (for example named-this-call and reshaped calls); they are not evidence of original-tree mutation. Do not report all parent assignments as corruption. Nevertheless the descriptor path suffices to block an unrestricted same-TypedAST fresh-context guarantee unless its owner restores/isolate those mutations or a fresh parse/checker is supplied.

### Options and external authority objects

`context/create-context.ts:88,474–478` retains option-provided linkedPackageBindings and WASI/import sets by reference; dtsEntrypointSeeds and several provider descriptors are also forwarded. A targeted source search found no add/set/delete/clear on the named linked/WASI collections under codegen, which is reassuring but not proof against every delegated provider mutator. Treat immutable configuration as reusable; do not reuse a mutable provider/session object merely because its TypeScript type says readonly. No general public source-compilation callback transaction was found in the inspected CodegenOptions path.

### Process globals / observable instrumentation

- `expressions.ts:642–675` has process-global __compileDepth. Normal finally unwinding balances it. `compiler.ts:1526` resets it at compileSourceSync entry, not generateModule. Resetting it in the middle of an outer/reentrant compilation would not be a safe generic repair.
- `compile-profile.ts:49–53,113–178` has process-wide records/stack; streaming START/end writes and finally-recorded aborted phases cannot be unprinted by discarding ctx. profileCount/module-scale writes are likewise immediate. An attempt-aware telemetry policy or buffering is required if the prior plan promises no abandoned-attempt publication.
- `checker/oracle-backend.ts:187,215–227` has globalDivergenceLedger used by DifferentialOracle. Constructing a fresh oracle reuses this ledger by default; no retry-level rollback exists. Clearing it would also erase earlier unrelated observations. Default checker mode does not use this differential ledger, but retaining that mode's contract is part of a general implementation claim.
- `index.ts:11942–11962` has process-global frameStagePrev and optional immediate frame-stage logging; earlier optional index.ts diagnostics and closure frame diagnostics also write directly to stderr. These are distinct from the return-value error list.
- `compiler.ts:1092–1130` publishes returned audit/fallback/postclaim results and can append postclaim JSONL. A generator-level retry before return could avoid publishing the abandoned *returned* result here. It does not undo earlier profiler/oracle/debug emissions. Do not silently suppress established diagnostics and call that parity.

## 6. Safe invocation boundary: what can and cannot be claimed

The narrowest source-demonstrated fresh **module/session/context** boundary is the start of generateModule/generateMultiModule, before createEmptyModule, buildIrUnitInventory and ProgramAbiSession. Retrying only a body emitter, reusing mod, or passing the old ProgramAbiSession into a new context is not safe.

For a fresh **AST/checker** boundary, the same generated TypedAST argument is insufficient. `compiler.ts:989` runPipeline already receives analyzed inputs; its codegen call at 1086 is too late to recreate the frontend. compileSourceSync before analysis can create fresh source/checker when no persistent languageService is supplied. The multi-source path at `compiler.ts:1844–1848` either updates/reuses projectService or calls analyzeMultiSource; the persistent-service route is expressly reuse, not fresh isolation. A retry requiring new AST/checker would need a parent-owned invocation factory over the same in-memory source graph/options/resolution snapshot, without re-reading changed files or reusing incremental service state.

Even that larger invocation boundary does not reset process-wide profiling/differential telemetry or automatically establish source-emission survival. Thus **no existing public boundary is certified as satisfying every retry requirement unchanged**. The two useful boundaries above are conditional design components, not a guarantee or authorization to widen the task into frontend reconstruction/process isolation.

## 7. Surviving-witness criterion

A valid compile-time admission witness must identify an actual emission occurrence, not merely an AST call node:

1. Exact source/unit/call identity and all existing per-source production gates matched, with the actual original vector carrier family selected by the existing probe.
2. Its instruction occurrence belongs to the selected body epoch after every enclosing speculative rollback and after module-init discovery/final selection. The association must follow the actual retained body, not a detached first-pass copy or a second visit to the same span.
3. The selected body is installed by the actual source/body owner. If a later IR/prepared replacement removes it, that occurrence is not a surviving direct-vector witness. Helper-name presence is insufficient because speculative registration can leave helpers/types behind.
4. If parent defines admission as final reachable production behavior, the witness must also survive optimization/DCE or have an explicit ownership transfer through replacement/inlining. If existing admission means committed pre-DCE emission, retain that definition and test reachability separately; do not silently make this audit a new DCE-based production gate. In neither interpretation does first branch encounter suffice.

The current pipeline has no general occurrence ledger satisfying these points. snapshotSpeculative has no commit token; discovery replaces fctx/body; final transforms remap/remove instructions; source-position maps and body-entry audit records record entry, not original-vector occurrence survival. Adding such ownership must be a separately reviewed implementation, not an invented property of the current APIs.

There is a causality obstacle to immediate retry: stopping at first inner admission prevents observing whether its surrounding emission would later be discarded. Rechecking only in active attempt can detect disagreement but cannot preserve unadmitted-input behavior if the proposed response is failure. Suppressing the signal during a known probe also needs complete probe/discovery metadata and a guaranteed later committed encounter; neither is supplied by the current interfaces. Completing an initial legacy attempt and deciding from its final body would require a defined non-captured continuation at the admitted branch and a durable occurrence ledger, not the proposed stop-before-A/B/D algorithm. That alternative is not authorized or implemented here.

## 8. Actionable blockers before choosing retry

1. Establish transaction/body-epoch ownership for admission, covering manual snapshots, always-discard type probes, module-init discovery/full modes and prepared replacement. Without it, reject the immediate-trigger design; do not ship a new error on witness loss.
2. Establish transparent signal propagation through actual expression/statement/declaration/generation boundaries and any direct-lowering callbacks reached by supported IR routes. Do not blanket-change unrelated checker catches. Include speculative finally cleanup in the design.
3. Choose and prove an isolation boundary: fresh codegen alone requires same-AST mutation/cache audit; fresh frontend requires identical frozen source graph/configuration and no accidental incremental-service reuse. Both need process-global telemetry handling that preserves existing external contracts.
4. Preserve exact per-source gate and source-order writes on the active attempt without consuming stale AST/ABI state. No module-wide scan admission, no third attempt, no failed-input downgrade, no dummy references, no old-compiler retirement.

The parent's next choice should therefore be based on these unresolved obligations, not the previous plan's preference alone. This audit is sufficient to withhold approval of immediate retry; it is not a claim that a fully specified deferred design is already safe. Both remain unimplemented and unmeasured.
