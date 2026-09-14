Here is the complete B dispatch contract, independent of the source-certification work.

## B: canonical resolved async-frame bodies

**Base:** published physical checkpoint `0194b64c246d2b5beab2db00af33a73498e2eb6e`.

**Outcome:** existing public compilation calls a context-free native frame engine for await classification, step callbacks, state dispatch and rejection routing. This does **not** relocate the entire prepared IR adapter or remove whole-program async refusal.

### Exact write set

Six production files:

- New `src/runtime/wasmgc/async/frame-engine.ts`.
- New `src/runtime/wasmgc/async/native-await.ts`.
- New `src/wasm/physical/exception-control.ts`.
- Existing `src/codegen/async-frame.ts`.
- Existing `src/codegen/prepared-native-async-await.ts`.
- Existing `src/ir/try-table.ts`.

Two focused tests:

- New `tests/issue-3518-async-frame-body-ownership.test.ts`.
- New `tests/issue-3518-async-frame-body-source-preservation.test.ts`.

Parent owns policy/history integration and serialized validation. No Promise-settlement, queue, program-source, delay-declaration, or physical-consumer changes in B’s map.

### Canonical executable APIs

Move `NativeAwaitClassificationOptions`, `buildNativeAwaitClassification` and `buildNativeAwaitSuspendArm` completely into `native-await.ts`; retain explicit old forwards to the same function objects.

In `frame-engine.ts`, extract:

- `buildStepAdapterLocals(stateTypeIdx): LocalDef[]`.
- `buildStepAdapterBody(resources, reject): Instr[]`.
- `buildAsyncFrameStateChain(input): Instr[]`.
- `buildAsyncFrameDispatch(input): Instr`.

The step resources explicitly contain state type, sent/error/mode field indices, throw-mode value and the reserved resume function handle. Preserve parameters `(caps, value)` and `$frame` local index 2.

State-chain input contains frame local/type/state-field indices, the ordered `{ id, body: Instr[] }` states, and an optional `{ id, body }` completed arm. Bodies are already emitted Wasm instructions. No source/IR emitter callbacks.

Dispatch input contains:

- Explicit `{ wasi, standalone }` EH target selection.
- Frame type, state/mode fields and next-mode value.
- Frame, result-Promise, reason and optional handler local indices.
- Bound exception tag and reject-settlement function.
- The already-assembled state chain.
- Ordered handler records.
- Optional async-generator completed-state ID.
- Optional existing host caught-exception function binding.

Each handler retains `id`, `parent`, its separately compiled finalizer body, optional catch-state target, and optional catch-binding name/local/spill-field mapping. Preserve absence versus index zero. Do not discard finally-only regions, empty finalizers, or parent information. Derive routed versus non-routed dispatch from the same existing condition.

`buildAsyncFrameDispatch` returns the single existing outer instruction: routed block/loop/try, or non-routed tagged try around block/loop. Preserve singleton-finalizer truthiness guards, multi-region equality guards, mode reset, catch binding, branch depths, reject ordering and completed-state transition.

Canonical modules accept no `CodegenContext`, `FunctionContext`, `AsyncCfgPlan`, AST/checker, allocator, provider catalog or arbitrary callback. Function handles are already bound; these builders never resolve names or reserve resources.

### Required EH dependency move

Move all of `ir/try-table.ts`’s implementation into `wasm/physical/exception-control.ts`, importing Wasm model directly:

`StandardEhHandler`, `walkChildren`, `isLabelOp`, `bumpBranches`, `buildStandardTryTable`, `buildTargetTaggedTry`.

Keep explicit public forwards at the old path. Preserve the current algorithm and in-place branch mutation exactly; no opportunistic EH correction.

### Production integration and lifecycle

Within `ensureAsyncResumeFunction`:

1. Keep signature creation and reservation order unchanged: resume signature, step signature, resume placeholder, fulfill step, reject step. Preserve exact objects, cached handles, function-map entries, owner recording and host export timing.
2. Replace the two step-body builders with canonical calls at their existing invocation points.
3. Emit state bodies in ascending order using the existing producer. Track every completed detached state array immediately in `liveBodies`.
4. Produce the optional completed body at its existing point. Call the canonical state-chain builder, then track its returned array **before compiling finalizers**.
5. Compile finalizers in the existing order, with existing body swaps/restoration. Resolve catch locals/spill fields after this compilation.
6. Call canonical dispatch assembly at the existing assembly point.
7. Assign the original resume context’s exact `locals` and `body` arrays to the original placeholder. Release detached tracking only after publication.

Do not clone state bodies: late-import fixups must reach their actual arrays. Preserve the independent `structuredClone` for host catch-all routes to prevent double remapping.

Both `currentFunc` restoration scopes, inner body restoration, temporary aliases and awaited-value bindings must retain their failure behavior. Do not introduce reservation rollback that does not exist today.

### Deliberately retained dependencies

Keep `ir-async-frame.ts` unchanged. Its `preparedCfg` must continue emitting **selected `asyncRuntime.states[index].body`**, then semantic updates/transitions. Keep its current handler refusal and exact attachment authentication.

Also retain AST planning, coercion, local allocation, frame-entry construction, closure/TDZ initialization, provider reservation and the single prepared-runtime WeakMap authority. Moving coercion behind a callback capturing context is not an acceptable substitute.

Real production chain:

`lowerIrEntryFunction → lowerPreparedIrAsyncFunction → emitPreparedAsyncFrameStateMachine → ensureAsyncResumeFunction → canonical builders`.

### Preservation and acceptance

Measured donor denominators—supplemental, not replacements for existing receipts:

- `async-frame.ts`: 51 non-import/export statements, 47 top-level functions, 92 function-like bodies.
- Unchanged `ir-async-frame.ts`: 9/7/38.
- `prepared-native-async-await.ts`: 3/2/3.
- `try-table.ts`: 6/5/9.
- No classes in these donors.

Reconstruct historical bodies from live canonical code and exact mapped edits; no reseeded hashes or discarded nested bodies.

Required focused controls:

- Same-object compatibility forwards; mandatory missing canonical files fail.
- Forbidden type/value/barrel/import-type edges fail.
- Mutations to state order/body, spills, finalizer order, callback handles, branch depths, mode and completed arm are detected.
- Tagged/catch-all bodies do not alias.
- State/finalizer failures restore exact prior context/body/alias objects.
- A later state’s helper registration correctly updates earlier detached bodies.
- Existing prepared attachment corruption still fails at the original allocation boundary.

Required source proof uses the complete existing native-family fixture, including pending timers, **70**, **3e9**, sequential and reverse Promise.all, rejection and `main` undefined, with paired full bytes/WAT/resources/outcomes/values. Add grounded existing multi-await, try/catch/finally and late-import fixtures. Existing host/EH suites are preservation controls only.

Keep all six/ten/twelve proofs unchanged. This checkpoint supplies real frame execution builders for later whole-program integration; it does not prove source-family admission, async physical acceptance, public cutover, retirement, or the missing ABI `planningSealed` witness.

I’ll now review A’s frozen settlement files and harness against the published settlement plan.
