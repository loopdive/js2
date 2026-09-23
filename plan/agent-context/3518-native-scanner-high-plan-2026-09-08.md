## Frozen Low dispatch: genuine native scanner

Implement **string pack → flatten/copy/optional UTF-8 decode → StringToNumber/power table → native-value unboxing**.

Start from the published native-value checkpoint once parent supplies its commit SHA. The inspected scanner/flatten donors remain byte-identical to `5118637e0e9b34291465230428447e511958faa1`. Reconcile those exact donors before writing.

Euclid’s closure/ObjVec census is the subsequent connected checkpoint; it is not folded into these write sets.

### 1. Disjoint ownership

**Low A — flatten implementation**

Existing production:

- `src/codegen/native-strings-core.ts`

New production:

- `src/runtime/wasmgc/values/string-flatten-bodies.ts`
- `src/runtime/wasmgc/values/string-utf8-decode-bodies.ts`
- `src/backend/wasmgc/resources/native-string-flatten.ts`

Tests:

- `tests/issue-3518-native-string-flatten-resources.test.ts`
- `tests/fixtures/issue-3518-native-string-flatten-donor.ts`

Extract the exact copy-tree, optional UTF-8 decoder, flatten and cons-memoization bodies/locals. Retain the legacy registration adapter and unchanged `emitStrToUtf8Helper`.

**Low B — scanner implementation**

Existing production:

- `src/codegen/parse-number-native.ts`

New production:

- `src/runtime/wasmgc/values/string-number-grammar.ts`
- `src/runtime/wasmgc/values/decimal-scale-bodies.ts`
- `src/runtime/wasmgc/values/string-number-bodies.ts`
- `src/backend/wasmgc/resources/native-string-number.ts`

Tests:

- `tests/issue-3518-native-string-number-resources.test.ts`
- `tests/fixtures/issue-3518-native-string-number-donor.ts`

Move StringToNumber’s executable body/locals and shared grammar/scaling helpers. Keep parseFloat/parseInt orchestration, caches, registration and module-init delegate authority in the legacy adapter. Shared algorithms must have one canonical implementation.

**Parent integration**

- `src/backend/wasmgc/resources/native-string-literals.ts`
- `src/backend/wasmgc/resources/native-values.ts`
- Existing native-value resource tests.
- Checked physical-plan/consumer joins.
- Boundary activation, historical receipts and root-bound source comparisons.

No changes to Promise settlement, closures, ObjVec, host/linear implementation, ABI obligations or policy allowed edges.

### 2. Frozen pure interfaces

These are proposed exports, not existing APIs.

Flatten builders:

- `buildStringCopyTreeDefinition(layout, worklistTypeIndex)`
- `buildStringUtf8ToFlatDefinition(layout)`
- `buildStringFlattenDefinition(layout, resources)`

Return `{ locals: LocalDef[], body: Instr[] }`. Reuse canonical `NativeStringLayout`.

Flatten resources contain only:

- `copyTree: FuncHandle`
- `emptyLiteralGlobalIndex: number`
- Explicit absent/present UTF-8 decoder handle

Scanner builders:

- `buildStringToNumberPrelude(layout, flattenHandle): Instr[]`
- `buildStringToNumberResult(powerResources): Instr[]`
- `buildStringToNumberLocals(layout): LocalDef[]`
- Power-array descriptor and initializer builders.

`powerResources` contains exactly `arrayTypeIndex` and `globalIndex`.

The prelude ends after exponent scanning and full-match rejection. The result builder performs decimal scaling and returns the result. This separation preserves the legacy adapter’s original lazy power-table creation point without passing an allocating callback into canonical code.

Grammar ownership includes the existing 33 `C_*` constants and whitespace, digit, radix, exact-Infinity and exponent builders. Scaling owns `POW10_TABLE_MAX`, decimal scaling and the beyond-table tail.

Canonical modules import only approved downward runtime/model dependencies—no context types, legacy facades or arbitrary emission callbacks.

### 3. Frozen resource interfaces

Flatten owner:

- `reserveNativeStringFlattenResources(tx, key, stringPack)`
- `fillNativeStringFlattenResources(tx, pack)`
- `requireCompletedNativeStringFlatten(tx, pack, expectedStringPack)`

Reservations contain the exact string pack, worklist type, copy-tree/flatten functions and optional decoder.

Scanner owner:

- `reserveNativeStringNumberResources(tx, nativeValuePlan, flattenPack)`
- `fillNativeStringNumberResources(tx, pack)`
- `requireCompletedNativeStringNumber(tx, pack, expectedStringPack)`

Reservations contain the power-array type/global and actual StringToNumber function. Private ownership retains the issued plan, exact flatten/string packs and transaction.

Use `PhysicalModuleReservations` exclusively. No new allocator or completion ledger.

Completion requires:

1. An actually issued pack.
2. Exact transaction and dependency identity.
3. Successful canonical fill of every required resource.
4. Current ledger validation of all captured tokens and completed contents.

A correctly named constant-return function, matching signature, copied body, nonempty body or structurally fabricated pack must fail authentication. Partial fill cannot issue completion.

Parent replaces native-values’ raw `{ anyString, toNumber }` dependency with the owned scanner pack. Primitive-only absence remains unchanged and cannot substitute for native-string selection.

### 4. String identity and reservation order

Extend the existing string owner narrowly to attest completed resources through its existing ownership record.

Flatten requires the genuine **UTF-16 `""` demand**, matching the donor’s unannotated literal materialization. Do not select merely the first equal text if both UTF-8 and UTF-16 empty literals exist; retain the interning/encoding identity in the lookup. No fabricated global-zero fallback.

One transaction:

1. Reserve string layouts and complete ordered literal demands.
2. Reserve one nullable-AnyString worklist array.
3. Reserve copy-tree, optional decoder, then flatten.
4. Reserve scanner signature/function, then power-array type/global.
5. Reserve dependent native-value functions and remaining selected resources.
6. Freeze once.
7. Fill strings, flatten resources, power/scanner, then native values.
8. Publish final indices and seal.

The worklist type must be reusable by later canonical string providers. Legacy code retains its existing array interner; do not duplicate that identity within either compilation path.

Calls use stable handles. Global/publication coordinates use final physical indices. Stable handles never become `ProgramAbiMap` final indices.

### 5. Required preservation

Retain:

- Legacy broad string-helper initialization order, import-shift reconciliation and suppressed-vector-usage scope.
- Copy-tree → decoder → flatten registration order.
- Flatten’s `nativeStrHelpers` and authoritative `funcMap` registrations.
- Empty-string interning at its original body-construction point.
- Scanner registration before body construction.
- parseFloat → parseInt → StringToNumber selection order.
- Lazy power caches, imported-global offset and push/trace failure ordering.
- All scanner locals, including i64 mantissa and retained unused `fracScale`.
- Flat offsets, worklist capacity16/doubling/copy order and memoization writes.
- Hashed-string cache fields and selected UTF-8 decoding.

The power table remains exactly **309 entries**, `Number(\`1e${k}\`)` for `k=0…308`, with unchanged immutable descriptors and scaling order. Do not substitute `Math.pow`, another parser, generic vector growth or a host conversion.

Receipt reconstruction retains all **13 scanner-module functions, three flatten-module functions, 34 constants**, nested bodies, locals, documentation and registration statements. Preserve existing hashes/denominators through checked live reconstruction; no runtime Git fallback or baseline reseeding.

### 6. Acceptance required before checkpoint completion

**Authentication negatives**

Genuine-positive first, then:

- Foreign transaction/string pack; cloned or substituted producer.
- Missing scanner, decoder, power or literal fill.
- Correctly named/signature-compatible constant-return scanner.
- Changed completed body, locals, power entry/count/mutability or empty literal.
- Reordered/substituted resources.
- Deleted canonical roots and forbidden type/value facade imports.

**Execution**

Execute actual owned flatten → scanner → unbox resources, covering:

- `3e9`, negative zero, NaN-producing text, infinities.
- Whitespace, decimal exponents and unsigned radix strings.
- Signed radix rejection.
- Nonzero flat offsets.
- Deep ropes exceeding16 pending children and repeated memoized flattening.
- Selected UTF-8 decoding.
- Power-table boundary and beyond-308 behavior.

Reuse real source fixtures from `issue-3570`, `issue-2654`, `issue-1184` and native-string suites. Record complete bytes/WAT/resource order and repeated outcomes in explicit-root baseline/candidate children. Add fresh-process canonical execution with legacy/frontend imports forbidden.

Keep separate verdicts for legacy preservation, canonical producer execution and whole-program execution.

The donor’s malformed-exponent handling and precision limitations require explicit semantic controls. Source inspection indicates a possible existing `"1e"`/`"1e+"` acceptance defect; it was not executed here. Preserve any baseline failure rather than treating equal wrong results as correctness.

### 7. Dispatch boundary

Both Low lanes can begin after parent publishes these interfaces and verifies ownership. Parent integrates their authenticated dependency chain after freeze.

This supplies the real scanner required by native values; it does not finish Promise/frame fill, closure application, object classification, formatting/concat/output or full-family physical execution. The original **16-owner/33-call** population, public IR-only cutover, strict closure and unresolved ABI30 witness remain intact.

No further research, edits or tests were performed for this freeze.
