## Explicit recursive-type emission checkpoint

Source pin: `e3a01efa44f68da1b93c16b1a728d0ba099183f9`. Proposed implementation only; no tests or mutations performed.

The smallest coherent fix is **one shared, read-only physical type-layout calculation**, used by reservations, binary emission, WAT and runtime-group extraction. No new allocator, type IDs or index remapping.

### 1. Current defect and ownership

- [module-reservations.ts:409](/private/tmp/js2-3518-delay-admission-integration-20260908/src/wasm/physical/module-reservations.ts:409) already reserves types in **flattened Wasm index space**. A recursion wrapper consumes no type index; its members each consume one.
- [module-reservations.ts:763](/private/tmp/js2-3518-delay-admission-integration-20260908/src/wasm/physical/module-reservations.ts:763) rejects type-definition references into or beyond the first explicit group. This is the temporary guard.
- [binary.ts:72](/private/tmp/js2-3518-delay-admission-integration-20260908/src/emit/binary.ts:72) computes groups using outer `mod.types` positions. Consequently `[rec(A → type1, B), function]` can become an invalid outer recursion group containing another recursion wrapper.
- Binary validation disables resolved signature/field checks when explicit groups exist.
- WAT also indexes outer records; [canonical-recgroup.ts:241](/private/tmp/js2-3518-delay-admission-integration-20260908/src/emit/canonical-recgroup.ts:241) skips explicit groups entirely.

The existing reservation tokens, exact objects, function ordinals and `resolveLayout` remain authoritative.

### 2. Exact write map

Production, disjoint from current source/vector and delay/combinator work:

1. New `src/wasm/physical/type-layout.ts`
2. `src/wasm/physical/module-reservations.ts`
3. `src/emit/binary.ts`
4. `src/emit/wat.ts`
5. `src/emit/canonical-recgroup.ts`

Tests:

1. Existing `tests/issue-3518-module-reservations.test.ts`
2. New `tests/issue-3518-physical-type-layout.test.ts`
3. New `tests/issue-3518-explicit-rec-emission.test.ts`

Parent integration: mandatory new physical-module entry and additive controls in `scripts/compiler-boundaries.json` and `tests/issue-3518-semantic-provider-boundary.test.ts`. No allowed-edge changes or historical reseeding.

No edits to function-handle allocation, ProgramAbiMap, physical consumer, model unions, object emitter, workflows or budgets are required.

### 3. Shared canonical interface

Proposed exports:

```ts
indexPhysicalTypes(types: readonly TypeDef[]): PhysicalTypeTable

planPhysicalTypeSection(
  table: PhysicalTypeTable,
  forcedGroups?: ReadonlyArray<readonly [number, number]>,
): PhysicalTypeSectionPlan
```

Required readonly data:

- `PhysicalTypeEntry`: `typeIndex`, `recordIndex`, optional `memberIndex`, and the **original** non-rec `definition` object.
- `PhysicalTypeTable`: ordered entries, each outer record’s inclusive flattened range, and explicit-group ranges with their originating record.
- `PhysicalTypeSectionPlan`: ordered groups with flattened `start/end`, `recursive` encoding flag and explicit-record provenance when applicable.

The group’s position in `groups` is a **type-section vector-entry ordinal**, never a type reference. All instruction/signature/metadata references remain existing flattened `TypeHandle` values.

Separate indexing from final planning: reservation may legitimately contain references to future types. Shape/indexing checks run while reserving; complete reference/group checks run at freeze and seal. Emission computes from its current, final module—never from a stale cached pre-transformation layout.

### 4. Grouping and subtype rules

1. Flatten outer records in order, retaining original member/subtype objects. A `sub` occupies one index; unwrap its payload only for kind/signature lookup.
2. Preserve each explicit group’s exact member sequence and boundary, including explicit singleton encoding.
3. Resolve nested value references through function parameters/results, struct fields, arrays and subtype payloads.
4. Permit self/forward value references **within the same explicit group**, plus references to earlier groups.
5. Run the existing forward-reference interval closure over intervening ordinary flat records. Preserve historical grouping and bytes when no explicit groups exist.
6. Refuse a reference or forced interval that would require splitting or merging an explicit group. Do not silently change its canonical identity.
7. `canonicalRuntimeRecGroup.start/end` are flattened coordinates:
   - an exact explicit-group match is valid;
   - a disjoint forced group before or after explicit groups is valid;
   - partial overlap, enclosing adjacent groups, or forced-range enlargement fails.
8. Supertypes must precede the subtype’s own flattened index. Do not sort members or treat forward inheritance like forward field references. Literal nested `rec` wrappers remain rejected; they are not subtype members. These distinctions follow the [Wasm recursive/subtype validation rules](https://webassembly.github.io/spec/core/valid/types.html) and [binary type grammar](https://webassembly.github.io/spec/core/binary/types.html).

Retain the ledger’s existing nonempty/dense-member requirement. Reject contradictory double subtype wrappers instead of emitting nested subtype headers. This does not require implementing a general Wasm subtype checker.

### 5. Consumer changes

**Reservation ledger**

Replace its private flattening/group-closure duplication with the shared calculation. Remove the temporary first-explicit-rec guard only with the composed emitter fix.

Preserve exact-object snapshots, descriptor presence checks, future canonical-descriptor reservation, cache-only post-freeze interning and terminal failure behavior. `reserveType(...).typeIndex` remains the first member’s flattened index.

**Binary**

Emit one type-section entry per planned group. Emit exactly one recursion header where required, followed by its flattened subtype definitions—not the original recursion wrapper inside another header.

Keep exported `computeRecGroups` compatible for historical flat inputs, delegating to the shared planner. Keep low-level `encodeTypeDef` available to existing callers.

Always supply the flattened lookup to validation. Restore resolved checks for:

- function/import/tag signatures and parameter counts;
- locals and struct field bounds;
- reference types in globals, parameters, results and fields;
- block signatures and instruction type immediates.

Both ordinary and source-map emission use the same plan. Function/global handle resolution and every existing index-validation site remain unchanged.

**WAT**

For explicit-group modules, render the planned groups and flattened coordinates. Preserve every type declaration: disable signature inlining in this mode so omitted declarations cannot shift numeric references. Resolve signatures through flattened entries, preserve subtype finality, and use correct numeric supertype references.

Retain historical nongroup formatting unchanged. This is not a general WAT cleanup.

**Runtime metadata**

Make `extractRuntimeGroup` enumerate flattened entries, including explicit members. Preserve names, original definition objects, ordering, hashing algorithm and ABI version. No silent empty/subset fingerprint caused by skipping wrappers.

### 6. Required controls

Retain the existing **31 temporary-guard controls**, changing expectations individually:

- Of the 24 position × reference-form cases, value references at self/internal-forward and ordinary trailing-forward positions become positive.
- Prefix references requiring merger into a later explicit group remain negative.
- Self/forward supertype cases remain negative.
- Preserve six backward-prefix controls.
- Convert the original no-prefix `rec(A → B, B)` counterexample into successful emission.
- Separately convert the existing canonical-group-after-explicit coordinate refusal into a positive.

Add actual instantiated binary tests—not only planner snapshots:

- Mutual struct/array references with construction and a nested field read returning **42**.
- Function signatures inside and after groups, including multiple groups and a prefix.
- Parent-before-child subtype construction/cast and field access.
- Imported function/tag signatures, global/local reference types, typed blocks and indirect/reference calls using flattened indices.
- Canonical runtime group after an unrelated explicit prefix: nonempty exact membership, unchanged fingerprint, binary verification and cross-module value exchange.
- Both binary entry points produce identical bytes; source-map offsets remain valid.
- WAT preserves group/member order, flattened references and subtype finality.

Required negatives include missing/out-of-range members, sparse/nested wrappers, cross-boundary forward references, forced-group overlap/enlargement, forward/self inheritance, invalid field/local indices after a group, wrong signature kinds, and post-freeze descriptor/member substitution.

Reuse unchanged canonical-recgroup, index-validation, symbolic-function-reference and physical-consumer suites. Retain paired synchronous source bytes/WAT/resources/value evidence; do not reseed expected outputs.

### 7. Integration and remaining limits

Implement shared layout and all emission/metadata consumers first, then replace the guard in the same composed checkpoint. Do not publish guard removal alone.

This enables real recursive physical resource graphs without renumbering or changing group identity. It does not certify legacy transformations or relocatable-object pipelines for newly introduced explicit groups; their eventual callers must establish compatibility before applying those transformations.

Native runtime materialization, complete async-family execution, public IR-only cutover and the unresolved ABI30 witness remain required. No architectural user choice is needed for this scoped fix.
