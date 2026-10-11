# Bounded Promise getter capture

Approved specification recorded before production edits. Base: a7fbc6eb6fa8ebcde29529d67e55408592672fee (PR 5765). Worktree: /private/tmp/js2-3518-promise-getter-capture-20260908; branch: codex/3518-promise-getter-capture-20260908. Preserve the old resolution candidate and its receipts unchanged.

Reserve/fill __promise_lookup_then(externref) -> (i32 callable, externref capturedThen). Accessor, field and open-object arms read then once and return that exact callable using function-local multi-results. Compiled methods return callable=1 with null capturedThen as the existing compiled-method dispatch sentinel. Noncallable values return 0/null.

Resolve consumes the second result into a function local and stores it in the existing continuation caps.callback. The queued job uses the actual applyClosure binding with the captured function and original peeled receiver. No global scratch, second Get, or extra capture allocation. Getter exceptions continue to reject with their original reason. Get remains synchronous and invocation remains queued. Native Promise adoption and compiled-method dispatch stay intact.

Owned production files: src/runtime/wasmgc/promise/thenable-bodies.ts, resolution-bodies.ts; src/codegen/async-scheduler.ts, closed-method-dispatch.ts. Focused tests and this handoff are also owned. Resource files and Hilbert signature integration belong to the parent.

Preserve authenticated donor fixture hashes and all 49 preservation controls. Check intentional deltas explicitly rather than rebaselining donor text. Add capture/replacement, poisoned and noncallable getters, receiver identity, two pending resolutions, and reentrant getter controls. Immutable public baseline controller: 76198. Required new trace: getter=1, original=1, replacement=0, value=42, trace=1324.

Heavy tests require the parent's explicit slot grant (parent running 19123 at dispatch). Freeze source manifest for High review before publication. Use normal hooks and user author with Codex coauthor. Final publication is a non-draft PR to loopdive/js2; no merge, cutover or retirement claim.

## Validated candidate

After parent checkpoint push 30254 completed, the parent granted an exclusive validation slot. TS7 session 28466 exited 0. Serial single-fork preservation/runtime session 9166 exited 0: 56/56 tests across 2/2 files in 15.28s (49 original preservation controls with checked intentional deltas, 7 standalone runtime cases). Both used a 2048 MiB heap. Heavy slot released after terminal.

The repaired runtime asserts getter=1, original=1, replacement=0, value=42, trace=1324 and original receiver identity. Additional runtime cases cover thrown reason identity, noncallable getter fulfillment, field replacement, two pending captures, reentrancy, native adoption and compiled-method dispatch.

Donor receipt SHA256 remains da7c7a907726732488dec5e80a8a06c8bb0ed88c644fea32e0da15abef70a646. The immutable controller76198 baseline and old candidate tree were not modified. Exact commands/output are recorded in .tmp/promise-getter-capture-validation-9166.json; source identities are in .tmp/promise-getter-capture-manifest.json. Parent High review and resource signature integration remain pending.

### Explicit migration lanes

The initial 9166 receipt exercised only the default lane and is retained independently. All seven cases now run with experimentalIR=false and true, skipSemanticDiagnostics=false, and the six compiler controls from public controller76198 fixed to zero before compiler import.

TS7 40200 exited 0. First explicit-lane run 85556 failed the 10-second import hook (49 preservation passed, 14 runtime skipped due to failed setup); its failure receipt is retained. After bounding that import hook to 60 seconds, full rerun 6839 exited 0: 63/63 passed in 18.53s, comprising all 49 preservation controls and all 14 runtime tests, no skips. No source algorithm changed during this validation extension. Exact commands/output are in .tmp/promise-getter-capture-validation-6839.json. Heavy slot released; High review precedes PR publication.
