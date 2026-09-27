# Closed BigInt storage: concrete IR/ABI closure and owner partition

2026-09-27. Source-only follow-up to the fully reread `5883-closed-bigint-storage-architecture-review-20260927.md`. Source anchors below refer to `codex-5883-live-vector-20260927/src/`. No production edits, compiler, tests, typecheck, or git mutations. Main remains parent-reported 2a58. This is an implementation contract, not a new runtime result.

## Decision

Do not apply the proposed closed-field policy inside ObjectStructRegistry, lowerIrTypeToValType, the global checker mapper, or the IR gates. The concrete source routes below distinguish existing rejection from already-selected reference transport. The bounded legacy field repair does not require an IR-wide i64-to-reference migration. It DOES require atomic layout publication and incoming-value preservation for every affected legacy field producer, and unchanged exact ABI checks for shared layouts.

This conclusion is narrower than “all BigInt is legacy.” Erased/reference values can traverse selected IR; explicit IR i64 shapes remain scalar. Neither is authority to reinterpret a field. No added fallback, admission exclusion, null/success substitute, or weakened ownership check is part of this plan.

## 1. Source-position structural projection: existing legacy delegation

`codegen/index.ts:1204` resolves source-position types. Structural references/literals reach `objectIrTypeFromTsType` at 1501 or the lattice projection at 1442. `tsTypeToFieldIr` at 1541 accepts NumberLike, BooleanLike, StringLike, and recursively projectable objects; BigInt returns null. The enclosing object projection rejects the entire unsupported shape. `atomToFieldIr` at 1465 likewise has no BigInt atom; `ir/propagate.ts:114` defines the atom vocabulary without BigInt, and its object-literal inference at 1020 requires atom-valued fields.

The existing resolve catch at `codegen/index.ts:3350–3388` records `type-resolution-unsupported`, does not put that unit into the safe function set, and builds safeSelection from successfully resolved units. Its comment explicitly retains the legacy body under IR-first. Keep this existing behavior and diagnostics; do not add a new exclusion. Changing legacy physical fields to externref does not add BigInt support to this checker-derived projection.

## 2. Body-local shapes: independent producer, not covered by that rejection alone

`ir/from-ast.ts:5754` lowers ordinary object literals separately. Property initializers at 5786 are lowered once; the field's IR type is the actual SSA value type, not the expected f64 argument. Shorthands preserve local/ref-cell value types. The ordinary-to-primitive object path is separate but also publishes actual IR shapes. There is no BigIntLiteral lowering arm in this file; the terminal unsupported-expression path at 4578 invokes the existing body-shape demotion. This is source evidence of absent literal support, not a guarantee that every erased BigInt-bearing reference is rejected.

Already-selected references must remain references without an extra conversion. A legacy producer can supply an opaque reference whose payload is wide BigInt; a selected shape that already stores that reference must not be reclassified from its payload. Conversely a pre-existing i64 SSA value has already lost any unavailable high limbs; boxing later is not repair.

Actual consumers in `ir/from-ast.ts`: destructuring 3854, property/class reads 5591/5624, element reads 6329, method-value reads 8549; object assignment 9330, compound/update 9477, multi-assignment 9678, class assignment 9740. They derive get/set types from the receiver shape. Assignment checks exact IR type agreement after existing numeric coercion. Leave these contracts unchanged for the bounded patch.

`ir/builder.ts:702–756` records the object shape, SSA result types, and raw field values. `ir/verify.ts:2160–2180` validates object.new carriers against shape fields. `ir/lower-generic.ts:1967–2014` resolves the shape and emits aggregate new/get/set using SSA values without a BigInt representation adapter; `:3980` resolves object value types through the same resolver. These are the precise atomic-change sites IF a future patch introduces a new selected BigInt field representation. They are not patch sites now.

## 3. Registry and deduplication: consume physical agreement, never invent it

`ir/integration.ts:5250` constructs ObjectStructRegistry with normal IR-to-Wasm lowering; resolver.resolveObject at 7906 delegates to it. `ObjectStructRegistry.resolve` at 9681 lowers each actual IR field, makes non-null references nullable, and either reuses the legacy physical hash or publishes a new struct. Its cache key at 9755 is the logical recursive IR shape; its legacy key helper at 9780 describes physical fields.

Keep both registry policy and scalar IR meaning unchanged. A logical i64 shape must continue to produce an i64 slot, not hit a reference slot newly published under an old i64 hash. A reference shape may share an equal reference layout. Curie's registration must calculate the physical hash AFTER the field policy, publish all authoritative maps consistently, and not mutate a published scalar slot in place. No BigInt-specific RHS preparation may be inferred merely from a deduplicated externref shape or property name.

The two hash implementations have existing differences in brand metadata; do not repair them incidentally. Add a targeted agreement observation when validating the patch: matching physical fields reuse compatibly, unlike scalar/reference fields do not reuse incompatibly. Do not alter the registry to force convergence.

## 4. Class projection and prepared ownership

`codegen/index.ts:1578` builds class shapes; constructor parameter projection at 1675 and `tsTypeToClassPositionIr` at 2103 do not provide BigInt. The field loop at 1798 first tries AST-derived type with the physical parity guard, then `valTypeToIrField`. Its actual implementation at 2130 accepts ONLY f64/i32. Thus an ordinary BigInt field is rejected both as current i64 and as a proposed generic externref; the latter does not accidentally admit the class. Do not rely on the broader stale comment above that implementation. Nested structural BigInt fields also fail their existing projection. Class members are not the free-function override path: safeSelection forwards member selection, whose integration must still find the exact class shape. Do not claim the free-function catch alone owns class selection.

Already-supported class fields retain the AST/physical parity guard. `codegen/class-layout-registration.ts` is the publication seam: commitClassStructLayout installs the same StructTypeDef/fields and calls programAbiTypes.observeClass. `codegen/program-abi-type-planning.ts:374–430` records exact class identity/type cells, rejects observation after planning, and returns a live observed layout. `ir/integration.ts:10210` ClassRegistry uses that exact prepared layout; when the ProgramAbi type registry exists, a missing layout is NOT permission to guess through a legacy name map.

`ir/program-class-layouts.ts` checks prepared layout keys for the program/ABI/allocations. `codegen/program-abi-prepared-transaction.ts` authenticates prepared descriptors/cells; `codegen/program-abi-signatures.ts:46–100` fingerprints physical fields. All remain unchanged. If an affected class layout joins the storage repair, its policy must run BEFORE commitClassStructLayout/observeClass and ABI sealing. No subsequent field rewrite, observation replacement, or finalizer rebuild.

## 5. Function constructors, opaque references, and other non-object slots

Function-constructor layouts are a separate authority, not anonymous-object fields by another name. `codegen/fnctor-layout-emit.ts` emits base/sibling/residual field families and consumers select actual field types (545/563). Do not run the new policy over every StructTypeDef, residual payload, closure environment, or runtime header.

`codegen/program-abi-fnctor-producer.ts:67,122,152,257` publishes the bounded input-string shape and explicit logical/physical field mappings. `program-abi-fnctor-planning.ts:108–146` checks complete exact ordinals/types/refinements. At 426 it resolves the reserved binding through the session, revalidates the current physical layout, and exposes field mappings. `ir/integration.ts:7930` uses this registry. This is not a generic escape hatch for structural BigInt fields; preserve exact source/unit ownership and the existing supported shape. No new refinement to disguise i64/reference mismatch.

`ir/fnctor-field-lattice.ts` derives field facts from the existing lattice, not a new BigInt atom. Dynamic tagged IR also is not a proof of wide BigInt support: `ir/js-tag-domain.ts:30–39` omits BigInt/Symbol. Existing opaque externref transport and native tagged dynamic arithmetic are distinct. Explicit hand-built IrType.val(i64) shapes, native i64 declarations, static scalar globals, local/parameter/return/ref-cell storage remain their existing ABI. A static object holder's nested affected field still joins the ordinary object repair; its holding global need not change.

## 6. Exact bounded write partition to agree with Curie

No changes below are authorized by this review alone. Parent assigns implementation and integration.

1. Curie owns NEW `codegen/bigint-field-carrier.ts`: pure target-gated storage mapping, separate pre-emission carrier preparation, semantic intent preserved without a second layout authority. Own only inferred layout hunks in `codegen/index.ts` (`ensureStructForType`, physical hash publication), plus `codegen/declarations/struct-type-registration.ts` collection/reconciliation/alias/prefix publication. Do not edit index.ts IR selection/projection.
2. Curie owns `codegen/literals.ts` field growth (both branches), old allocation default patching, initializer/shorthand, spread source/target carrier agreement; and `codegen/char-at-transfer.ts` the existing direct RHS preparation seam. Map before publication and prepare before SINGLE expression evaluation. Preserve explicit native overrides and other field refinements.
3. Parent owns `codegen/expressions/assignment.ts` dynamic/unhinted RHS and related computed/logical write hunks; `codegen/expressions/call-namespace-static.ts` only actual Reflect argument preparation gaps; descriptor acquisition as traced through its real initializer route. Curie and parent agree the helper signature before either edits call sites. No duplicate evaluation or post-i64 reconstruction.
4. Class layout is a named integration dependency, not silently solved by anonymous/interface edits. If affected class-backed alias/shared layouts are in the requested population, parent assigns the exact `codegen/class-bodies.ts` instance field/parameter-property producers and initializers to a separate owner; use the SAME policy before `class-layout-registration.ts` publication. Do not broaden static/accessor/callable ABIs. Until that dependency is shown unaffected or included, do not claim class-backed closure. Existing unsupported class IR remains unsupported without new gates.
5. IR/ABI files enumerated above are review/validation surfaces, with ZERO planned production writes for this bounded repair. Existing physical consumers `object-runtime.ts`, `closed-struct-extern-set.ts`, and `struct-field-exports.ts` should consume their existing externref arms from authoritative field metadata. A newly discovered concrete incompatible consumer is a blocker requiring its own exact hunk, not permission for a blanket mapper.

## 7. Parent acceptance receipts, unrun

Preserve all old sources/failures and existing compiler. Retain the earlier raw/provider/String/comma controls. Add the following route-discriminating checks under the parent's eventual slot:

- Structural BigInt parameter/return shapes and nested interface shapes: same existing selection/delegation reason before/after; repaired legacy field carrier where applicable. No new fallback or diagnostic.
- Body-local literal and shorthand fields: report actual selected owner and SSA/physical shape, not only output. Literal unsupported IR retains existing route; already-reference local transit remains reference.
- Explicit IR i64 object new/get/set remains i64 with unchanged scalar behavior. Existing selected numeric/string/nested-object controls preserve shape keys, ABI and selection.
- Reference field input/output transit with a runtime-chosen wide BigInt constructed directly at the boundary, not passed through an unrelated scalar ABI. Two values sharing low64 but different high limbs remain distinct where reference preservation is claimed.
- Declaration orders, aliases, inherited prefixes, field growth/default patching, cross-source preparation, exact class observation identity, and physically equal/different dedup cases. No stale i64 entry under an externref layout or vice versa.
- Runtime direct/dynamic/Reflect/descriptor writes, assignment results, receiver/key/RHS order and exception counts, host/native gates, explicit native i64, optional/undefined defaults, and no-opt controls from the original review.
- Prepared fnctor/string shape and class ownership checks unchanged; no newly selected fnctor/dynamic BigInt route. No late-import relocation loss or finalizer rebuild.

If genuine selected typed BigInt IR is requested later, the change is atomic across source projection, from-ast value construction, shape/SSA equality, verifier, generic lowering, registry/type keys, and prepared ABI producer/consumer contracts. That is a separate implementation scope, not a fallback or an unfinished hidden part of this field repair. The current bounded spec closes the identified routes by preserving their existing ownership and physical contracts; it does not establish runtime success without parent validation.
