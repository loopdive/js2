# Native physical module completion contract

Source-grounded implementation specification by Astra High. This is a prerequisite for whole-program native async emission, not evidence that async materialization or direct-codegen retirement is complete.

## Decision

Refine the shared prerequisite to a **completion ledger around the existing module allocator**, not a second allocator or an extension of `ProgramAbiSession`.

Source pin inspected: `09b7ae5857472a0e8d4c9a197d9b7ac7a6d8b390`. Read-only inspection; no tests.

Three existing mechanisms have different responsibilities:

- [function-handles.ts](../../src/wasm/physical/function-handles.ts) defines the two handle regimes. Actual minting and registration remain in [func-space.ts:201](../../src/codegen/func-space.ts).
- `indexSpaceFrozen` rejects late imports; it does **not** prevent raw function/global/type/table additions or certify filled bodies.
- [ProgramAbiSession](../../src/codegen/program-abi-session.ts) authenticates ABI plans and exact allocator objects. It neither allocates the complete module nor proves runtime helper completion.

Therefore `src/wasm/physical/module-reservations.ts` is justified, but only as the lifecycle owner described below. It must use the existing `funcOrdinalToPosition` authority and canonical ABI identities.

## 1. Shared API and identity contract

The transaction operates on the **same actual module objects** later consumed by ABI binding and emission. Reservation records must not clone `WasmFunction`, `Import`, `GlobalDef`, or type objects into a second authoritative registry.

Backend planning supplies resource identities:

- Existing program resources retain `IrBindingId`.
- Async frame support uses the actual owning `IrUnitId` and fixed roles: resume/0, fulfill-step/1, reject-step/2.
- Shared runtime resources use the existing entry-source anchor plus closed resource roles.
- Platform resources use their certified capability/provider identity and publication role.

Names, insertion positions, “first requesting function,” and surviving-function census are not identities. Physical code receives these keys without importing IR identity constructors. A reservation token authenticates transaction membership; it does not invent another semantic ID.

Proposed public operations:

```ts
reserveType(key, definition)
internFunctionType(params, results, name?)
reserveFunctionImport(key, moduleName, field, signature)
reserveGlobalImport(key, moduleName, field, type, mutable)
reserveFunction(key, name, signature)
reserveGlobal(key, name, type, mutable)
reserveTag(key, signature, linkage)
reserveTable(key, definition)

freezeReservations()

fillFunction(reservation, { locals, body })
fillGlobal(reservation, initializer)
defineElement(key, tableReservation, offset, functionReservations)
defineExport(key, externalName, targetReservation)
defineStart(functionReservation)

seal()
```

Each operation uses existing exact Wasm data types, not `unknown`, a legacy context, or arbitrary callbacks.

Additional storage operations are necessary **when demanded by the native dependency plan**: string-pool entries, memory definitions and data segments. Thenable self-resolution currently reaches native TypeError/string machinery; those resources cannot disappear from the census. These operations carry existing descriptors—including passive-segment distinctions—not a new memory implementation.

Rules:

- Duplicate keys reject; shared-resource discovery deduplicates demands before reservation.
- Defined functions use the existing stable `FuncHandle` regime.
- Imported functions retain existing import-space indices.
- Globals/types/tables/tags retain their current positional representation. Do not manufacture new “stable” numerical regimes.
- All references are checked against the correct resource kind and transaction.
- Signature checks retain reference type indices and semantic carrier brands; `.kind` equality is insufficient.

**Correction to my intermediate observation:** the consumer exposes allocating `internFuncType` after its freeze, but its generic body-lowering call does not invoke the concrete convenience wrapper that requires this allocation. The new resolver should perform cache-only lookup after freezing. Any genuinely missing signature must be reserved beforehand or fail explicitly—not justify an unrestricted late allocator.

## 2. Lifecycle and completion

Use four states: `reserving → filling → sealed`, with terminal `failed`.

**Reserving**

Authenticate the selected prepared runtime and derive the complete ordered demand set first. Allocate imports before defined index-bearing resources. Preserve canonical function-type interning, descriptor order, optional fields and exact objects.

Minting and physical function placement are separate facts: preserve the existing ordinal-to-position mapping rather than assuming mint order equals push order.

**Freeze**

Require every mandatory resource to exist, validate references/signatures, and snapshot exact layout/object ownership. No imports, slots, globals, structural types, tags or tables may subsequently appear. No discovery callbacks during lowering.

**Fill**

Mutate reserved function objects **in place**. Each body and global initializer has an explicit completion state.

`body.length > 0` is not completion proof: existing thenable placeholders contain valid instructions. Missing fill must fail even if the placeholder validates as Wasm. Conversely, a valid empty void body must not be rejected merely because its instruction array is empty.

Thenable finalization must supply completed bodies based on the real complete dispatch inventory. It cannot substitute empty method/closure inventories. Generate final bodies once after dependencies are fixed; do not rebuild already shifted legacy bodies.

**Seal**

Require:

- Every planned function/global initialization completed exactly once.
- Exact module population and object ownership; no unregistered additions or substituted slots.
- Complete element/export/start targets and collision policy.
- No unresolved stable ordinal or required dependency.
- Exact ABI correspondence for ABI-owned resources.

Only then may `program-consumer` publish its `emitted` observation. Keep its existing single-use acceptance authority and failure behavior. A failed emission does not yield a partial module or make the acceptance reusable.

Sealing is not universal immutability of the publicly returned mutable `WasmModule`; receipts must state the checked lifecycle boundary. Any subsequent layout transformation needs its existing explicit remap/final-index protocol.

## 3. Smallest shared implementation ownership

### Low A: physical kernel and completion ledger

Proposed source writes:

- `src/wasm/model/module-records.ts` — new canonical physical records.
- `src/ir/types.ts` — explicit compatibility imports/reexports.
- `src/wasm/physical/function-handles.ts`
- `src/codegen/func-space.ts`
- `src/wasm/physical/function-types.ts` — canonical cache-key/interning implementation.
- `src/codegen/registry/types.ts` — downward delegation only.
- `src/wasm/physical/module-reservations.ts`
- `src/codegen/registry/physical-imports.ts` — share the narrow append primitive while retaining legacy policy/diagnostics.

The necessary model move is exactly these fifteen existing declarations:

`TypeDef`, `FuncTypeDef`, `StructTypeDef`, `ArrayTypeDef`, `RecGroupDef`, `SubTypeDef`, `FieldDef`, `WasmFunction`, `TagDef`, `Import`, `ImportDesc`, `WasmExport`, `Table`, `Element`, `GlobalDef`.

Preserve every field and JSDoc. Leave mixed `WasmModule` metadata and `createEmptyModule` where they are for this slice; the transaction accepts a precise physical-storage view of that same module. This removes its type-only dependency on the old IR facade without another whole-module relocation.

For function registration, retain one mint/ordinal-commit implementation. Keep `traceSlotWrite` in the legacy wrapper at its existing point—ordinal recorded, trace emitted, function appended. Do not introduce an arbitrary tracing callback into the clean allocator or change tracing failure ordering.

Do not move whole `registry/types.ts`: its other registrations have additional consumers and bookkeeping.

### Parent integration: real consumer, not a standalone schema checkpoint

Proposed writes:

- `src/ir/program-consumer.ts`
- `src/ir/program-physical-plan.ts`

Replace existing manual slot/global setup and nonempty-body census with this transaction. Existing synchronous whole-program execution is its first immediate production consumer and must retain bytes, ordering and observation behavior.

Keep `ProgramAbiMap` as the consumer’s ABI authority. The physical ledger returns actual locators/indices; it must not instantiate a competing ABI session. Legacy `ProgramAbiSession` remains unchanged, including exact object locators, remap handling and publication.

This prerequisite may be published separately as allocator/completion progress, **not as native async acceptance**.

### Low B: dependent native resource consumer

Use the already planned `src/backend/wasmgc/resources/native-async.ts`. Its executable contract is:

- derive native demands from authenticated selected runtime attachments;
- reserve them through the shared transaction;
- return bound resources for runtime body builders and the prepared frame adapter;
- complete every demanded helper before transaction sealing.

B can implement demand validation and body-builder integration against A’s frozen API in parallel. Composed async emission requires the native runtime/frame implementations from the published cutover plan. Do not pretend the reservation API makes existing context-taking helpers directly reusable.

## 4. First whole-program native async wiring

The connected path must be:

`prepareWholeIrProgram` / typed replay  
→ canonical runtime-callable declarations  
→ `acceptPreparedIrProgram`  
→ complete native physical demand plan  
→ reserve resources and bind ABI  
→ prepared async frame lowering  
→ complete runtime/publication resources  
→ seal and emit.

Specific prerequisites remain:

- [runtime/callable-declarations.ts](../../src/ir/runtime/callable-declarations.ts) currently recognizes only `__new_ReferenceError`. Add the exact native-delay callable contract before backend resolution; do not infer its signature from operands.
- Consumer dependency/exception scans must include selected `asyncRuntime.states[*].body`, not just blocks and semantic async states.
- Async entries must use the Promise-returning physical signature and prepared-frame dispatch, not synchronous body-result lowering.
- Support functions need their own completion/ownership receipts; they must not inflate `emittedUnitIds`.

For the earliest delay/suspending-number/void path, bound resources include:

- Queue types, **six globals**, grow/enqueue/drain; reuse existing queue body builders and capacity **8192**.
- Promise/reaction/capture types; fulfill/reject/resolve-value and required adoption machinery.
- Number boxing/unboxing and boundary exports; canonical undefined type/singleton.
- Exact timer import, exception tag, closure wrapper/capture, timer callback and native-delay provider.
- Owner-specific frame type, resume and two step functions.
- Timer dispatcher publication: **two tables, one element segment, one manifest global**, and existing collision-safe export families.

The shared API must accommodate these actual resources. It does not authorize dropping the thenable/object/closure prerequisites currently reached by settlement.

## 5. State-preservation obligations

Before freezing implementations, record these mappings explicitly:

- `funcOrdinalToPosition`: mint writes sentinel; registration writes position; layout/DCE/emission read or remap it.
- Import arrays, counts and `funcMap`: preserve append order and legacy strict-import diagnostics.
- Function-type cache: retain reference indices, boolean/symbol/bigint/undefined brands and cache-hit naming behavior.
- Struct registries: preserve Promise bookkeeping; prepared frame types deliberately **do not** enter source-visible `structFields`.
- Scheduler/provider caches: one transaction-owned result on the new path, not independently allocating “ensure” caches.
- `currentFunc`, locals and detached body buffers: preserve restoration on failure and instruction ownership.
- Timer publication: preserve exact dispatcher-object authority, export collision behavior and publication-once state.
- ABI session: no locator cloning, inferred ownership by name, or premature final-index binding.

## 6. Required tests and acceptance boundary

Add focused tests:

- `tests/issue-3518-module-reservations.test.ts`
- `tests/issue-3518-native-async-physical-resources.test.ts`
- `tests/issue-3518-whole-program-native-async.test.ts`

Reuse existing consumer controls in `issue-3518-program-codec-replay.test.ts`, stable-handle controls in `issue-1916-symbolic-func-refs.test.ts`, and the source/replay helpers after A’s validation.

Mandatory negatives: missing/duplicate fill; valid-looking unfinished placeholder; foreign transaction token; substituted allocator object; reordered resource population; wrong reference index/brand; missing runtime-state-only dependency; post-freeze allocation; publication collision; failure followed by attempted reuse.

Actual source execution must cover:

- The existing certified delay source from `issue-4573-standalone-native-promise-delay.test.ts`.
- Playground `fetchUser(7)`: pending before timer fire, then **70**.
- `fetchUser(300_000_000)`: **3_000_000_000** through the real wrapped Promise boundary.
- A source-produced suspending `Promise<void>` owner: canonical undefined, not null.

Record prepared serialization/replay, complete resource receipts, instantiated bytes/WAT and timer/value traces. A synthetic allocator test or the existing public native route cannot satisfy this whole-program execution requirement.

The complete `issue-4574` family—sequential/parallel execution, Promise.all, vectors, strings/stdout, rejection and `main` undefined—remains mandatory follow-on acceptance. Existing public preservation, strict unknown failures, ABI30’s unresolved getter witness, host/linear deferral and eventual IR-only public default remain unchanged.
