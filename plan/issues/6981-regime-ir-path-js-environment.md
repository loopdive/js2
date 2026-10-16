---
id: 6981
title: "Native regime in a JS environment: IR-path Error.message / Map-Set / typeof tags + five direct-path compile failures"
status: done
sprint: current
created: 2026-10-14
updated: 2026-10-15
completed: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
goal: architecture
parent: 5385
related: [6708, 6979]
assignee: ttraenkler/opus-6981-ir
loc-budget-allow:
  # 2026-10-14 (#6981) — each is a small in-place correctness arm on the
  # standalone-shared native path; moving any of them out would split one
  # mechanism (the extern-get Error arm, the selector `new` gate, the typeof
  # tag read, the destructuring boxer, the __extern_get_idx body, the local
  # carrier prover) across two files.
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/object-runtime.ts
  - src/ir/select.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/registry/error-types.ts
func-budget-allow:
  # 2026-10-14 (#6981) — `mayBeBoolean` closes over makeProver's `unwrap` /
  # `isBooleanish` / oracle exactly like its siblings; the Error-message arm
  # must sit after the subclass proto-chain consult inside the same splice.
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/numeric-property-analysis.ts::makeProver
  - src/codegen/registry/error-types.ts::fillExternGetErrorProps
---

# #6981 — Native regime in a JS environment: IR path + direct-path compile failures

## Problem

Flipping the default `semanticProviders` to `native-first` in a JavaScript
environment (slice A of #6708) turns 15 equivalence rows red that are owned
here:

- `ir-slice10-error` (a)–(e): IR-path `Error.message` reads return `""`.
- `ir-slice10-map-set` (d)/(e): "Map/Set IR capability violation".
- `issue-6798`: resolve-stage-catch; string-bool-union; yield-star-return.
- `gradual-typing`: typeof any boolean runtime tag check; typeof any number
  comparison (compile failures).
- `destructuring-require-object-coercible`: `let {} = 5` (compile failure).
- `binding-null-guard`: class method with destructured param.
- `element-assignment-externref`: numeric key assignment on any-typed param.

All reproduce on main with an explicit `{ semanticProviders: "native-first" }`
compiled module read through `wrapCompiledExports`.

## Acceptance criteria

- All 15 rows pass under the regime (verified on slice A's branch).
- `tests/issue-6981-regime-ir-path.test.ts` covers each construct under both
  `semanticProviders: "native-first"` and `target: "standalone"`.
- `node scripts/equivalence-gate.mjs` reports no new regressions; standalone
  output unchanged or improved.

## Implementation notes (2026-10-14)

Root causes, each fixed on the standalone-shared native path (every one also
reproduced under `target: "standalone"`, so standalone results improve):

1. **`new Error().message` → `null`** (`ir-slice10-error` (d)). The native
   `$Error_struct` arm in `__extern_get` (`fillExternGetErrorProps`) correctly
   lets a null `$message` field fall through, but for a builtin instance the
   walk then missed instead of reaching %Error.prototype%.message (`""`,
   §20.5.3.3). The arm now answers `""` after the subclass prototype consult,
   but ONLY while every error-family `$NativeProto` global is still null
   (`intrinsicErrorMessageDefaultArm`, `error-subclass-proto-chain.ts`). Review
   fix 2026-10-15: the first cut answered `""` unconditionally and so shadowed
   `Error.prototype.message = "x"`, `delete Error.prototype.message` and an
   accessor redefinition (reproduced native-first and standalone). An
   unmaterialized prototype cannot have been touched; a materialized one is
   read by the ordinary `__extern_get` companion walk, which already carries
   the seeded `""` data property (#5156). Controls for write / delete / getter
   / materialized-but-untouched sit next to the default case in the test.
2. **Map/Set "IR capability violation"** (`ir-slice10-map-set` (d)/(e)). The
   selector claimed `new Set()` in a host-free lane and from-ast lowered it to
   a `Set_new` host import; the first member use then hit the deferred
   extern-member capability assert. `isPhase1NewExpression` now declines a
   known extern constructor without a host-free IR arm (everything but native
   `$Map`, gated RegExp/Date) when `hostExternCapability` defers, with the
   honest `host-surface-unavailable` reason. The JS-host selector is unchanged
   (the IR-fallback gate runs `jsHostExterns: true`).
3. **typeof on an `any` local, fast mode → invalid Wasm** (`gradual-typing`).
   The definition-site numeric-local oracle narrows `let a: any = x` (x number)
   to an `f64` slot; `compileTypeofComparison`'s `$AnyValue` tag arm read
   `struct.get $AnyValue 0` off the raw f64. The operand is now boxed through
   `coerceType` when it is not already an `$AnyValue`.
4. **`let {} = 5` → "Cannot destructure: unknown type"**
   (`destructuring-require-object-coercible`). The scalar-initializer arm only
   knew the host `__box_number` import; without it (native regime) it fell to
   the error. It now boxes through the coercion engine's native arm.
5. **`obj[0] = 42; return obj[0]` on a JS object → `undefined`**
   (`element-assignment-externref`). Writes reach the admitted boundary object
   through `__extern_set`, but `__extern_get_idx` only knew native carriers
   and missed for a host object. With the boundary hooks registered
   (`__boundary_object_get` present — JS environment only), a non-null
   non-carrier value now takes the same `Get(O, ToString(i))` as the `$Object`
   arm. Standalone bytes are unchanged for this arm (no boundary hooks).
6. **`false && f()` stored as `any` → `typeof` "number", `String` "0"**
   (`issue-6798` string-bool-union). The grounded numeric-local admission
   excluded only ALWAYS-boolean definitions (`isBooleanish`), but `isNumeric`
   counts booleans as numeric, so a MAYBE-boolean `&&`/`||`/`?:` definition
   narrowed the slot to f64. A new `mayBeBoolean` predicate (either operand /
   branch, or a boolean type fact) gates the local carrier.
7. **`issue-6798` resolve-stage-catch.** Not a codegen defect: a host-free
   selector keeps the documented conservative caller-direction call-graph
   closure (#2858/#3214), so with an unannotated arrow argument `test` is
   unclaimable and `apply` is demoted before its parameter type is resolved,
   leaving the probed error channel unexercised. The probe source now
   annotates the arrow's return type so both units are claimed in every lane.

Not fixed here, by decision:

- `ir-slice10-error` (a)(b)(c)(e) and `binding-null-guard` are harness gaps in
  slice A's helpers (`compileAndRunIRVariant` never calls `setInstance`, so
  `__str_from_mem` cannot reach `__str_mem` and every string result reads
  `""`; `helpers.buildImports`'s stub list lacks the `__boundary_object_*` /
  `__str_*_mem` imports the regime registers by design, #4399). Slice A owns
  both helper files and carries the fixes.
- `issue-6798` yield-star-return: the #680 native generator lowering gate
  (string yields, `yield*` delegate return values) fails it under standalone
  too. Shared generator lowering, outside #6980's scope as well; needs its own
  issue.
