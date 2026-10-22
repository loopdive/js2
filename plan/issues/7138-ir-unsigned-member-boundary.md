---
id: 7138
title: "IR: preserve unsigned native fields across dynamic member boundaries"
status: in-progress
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: ir
goal: ir-full-coverage
parent: 3518
depends_on: [7135, 7137]
assignee: "ttraenkler/codex-session-b"
---

## Problem and measured base

Base `721d93176ef22111a5beda3c763e0e925ac66de8` includes the native class
integer-domain fix (PR #6873), which depends on native console PR #6872.
Issue allocation and this branch claim were verified on upstream/issue-assignments.

`type u32 = number; class C { value: u32 = 4294967295; }` now stores the
correct bits in IR, but `read(v: any): number { return v.value; }` returns
`-1`. WAT confirms an externref-to-f64 reader ABI. The reader and its caller
remain legacy-owned (`param-type-not-resolvable`, `return-type-not-resolvable`).
The old constructor stored 2147483647, so successful compilation is insufficient.

## Implementation Plan

- Preserve the exact source-qualified uint32 domain on the existing shared i32
  carrier, without changing Wasm layout. Audit signature interning, equality,
  prepared-data round trips and brand checks before making it load-bearing.
- Reuse the canonical integer conversion recipe for writes and one scalar
  widening decision for reads/boxing. Audit generic and typed member getters,
  inline caches, computed properties, shared object/proxy field readers and
  setters. Do not introduce a second IR-only property dispatcher or conversion
  engine. Boolean/Symbol and unbranded numeric carriers retain their behavior.
- Integrate the durable physical dynamic-parameter ABI proof from PR #6871.
  Admit only physically matching native slots, and qualify the IR reader and
  caller by actual outcomes. Use the existing dynamic-to-number operation for
  numeric return boundaries where required; preserve fail-closed checks.
- Measure values, source evaluation order, inherited fields, high-bit/wrapping
  stores, both native targets and meaningful negative controls against the
  exact predecessor. Preserve standard gc binaries and state unsupported forms.
- Run current-main quality gates and publish a ready PR with explicit dependency
  order and a fresh-context review request. Do not change predecessor heads,
  HOLDs, queue entries or existing test processes.

## Target structure and quality acceptance

The upstream quality rule landed in PR #6869 while this implementation was in
progress (fetched main `c0a04d0e48edb412a9b694f7c5a0d72e46270c90`).

- `src/wasm/physical/numeric-carriers.ts` owns the shared uint32-aware i32
  widening decision. The native annotation map supplies the carrier fact;
  function signature interning/equality, Program ABI canonicalization and the IR
  projection retain it. A targeted before-fix control proved the ABI canonical
  signature previously collapsed unsigned and plain i32.
- `coercion-plan.ts` and `type-coercion.ts` retain the scalar conversion
  authority. `helpers/uint32-coercion.ts` extracts the existing exact low-32-bit
  recipe provider from the index; no second conversion algorithm is introduced.
- Dynamic writes call the existing `__extern_set_strict` outcome owner. The
  provisional closed-field result provider was removed after the inherited-Set
  control exposed that Reflect.set's Boolean conflates refusal with UNADMITTED.
- `declarations/prepared-signatures.ts` owns prepared signature vocabulary and allocated
  slot proof, reusing physical type equality. `array/vec-element-boxing.ts`
  owns loaded-element boxing; `ast-source-facts.ts` forwards the identical
  source-oracle facts at all four IR lowering sites.
- `select-dynamic-members.ts` owns named/computed member admission and one key
  boxing proof for reads/writes. The corresponding branches are removed from
  `select.ts`; the giant selector functions shrink.
- `prepared-dynamic-support.ts` extends exact carrier/provider evidence for
  existing native dynamic operations. The selector's allocated-slot guard and
  the dependency-sealing validator remain load-bearing.
- Code-quality acceptance: keep the conversion/property engines shared, preserve
  sibling structure, pass source gates, and obtain the required fresh-context
  adversarial verdict before release. Remaining minimal seam growth must be
  split or justified explicitly in review; no new budget grant has been added.

## Acceptance

- [ ] Shared uint32 metadata survives the supported preparation/ABI boundaries.
- [ ] Dynamic read/write paths preserve actual uint32 values and evaluation order.
- [ ] Supported reader/caller bodies are genuinely emitted through IR.
- [ ] Native controls, exact-base comparison and standard byte identity recorded.
- [ ] Ready PR and independent review status recorded; remaining migration gaps explicit.

## Work in progress evidence, 2026-10-22

The known dependency merge is `7dd1650791ef8a3381d7d0a88aac84fdb05a29a6`.
The exact-base audit checkout is separate from published worktrees. The initial
55-test matrix measured **54 failures / one passing data-copy control** on
that base; all 55 passed on candidate. The expanded matrix now has **65 tests**,
including primitive keys, Boolean values, inherited stores and an observable
store-body counter. The expanded exact-base run measures **64 failures / one passing data-copy control**.

Latest focused run: **191/191 in four files** (65 boundary, 70 predecessor
numeric-field, 48 dynamic-in, eight compatibility-carrier controls). A separate
run with `JS2WASM_IR_I32_DOMAIN=1` passes **135/135** boundary + numeric-field
registrations. Supported constructor/reader/writer/caller rows all assert
`irBodyEmitted: true`, `legacyBodyEmitted: false`, correct values, zero imports,
no warnings and no post-claim errors.

The native identity-box support now names an empty callable list where the
actual lowering is identity. The existing compatibility-control test is updated
only for the qualified native environment; its JavaScript-environment refusal
and prior number-box support both remain covered.

The larger five-file regression run has **241 passes / two failures**. Both
failures recur on exact base: the module-record declaration receipt mismatch
and `computedWriteCtorField` returning 1 instead of 11. The isolated base run
of those two files has **150 passes / the same two failures**. Neither is
called green or repaired by changing its expectation.

The initial inherited-Set pool attempts failed before worker readiness due to
missing compiler/runtime bundles. After building both, the candidate had
**20 passes / 16 failures**, against exact base **21 passes / 15 failures**.
The added failure was trap-absent Proxy forwarding a typed-array out-of-bounds
UNADMITTED result: the dynamic setter incorrectly treated Reflect.set=false as
an actual refusal. Reusing `__extern_set_strict` fixes that control and removes
the provisional closed-field result provider. The full current-bundle suite
now has **21 passes / the same 15 failure names as base**. None were hidden by
changing expectations. The experimental writer's post-claim error is a bare
null in dynamic module-init, also present on base.

The shared dynamic-kernel comparison has **235 passes / seven failures across
eight files** (including the 191 focused registrations). The seven failure
names match exact base's **44 passes / seven failures** for the four older
kernel suites. After the signature/scalar refactor, a separate four-file run
passes **197/197** (65 boundary + 70 numeric-field + 48 dynamic-in + 14 scalar
coercion controls). The final seven-file run after source-fact/vector extraction, ABI canonicalization
and warning assertions passes **225/225**. The final i32 run passes **135/135**.

Byte comparison against the exact dependency predecessor: **58/60 records
identical**, including all 15 gc and 15 standalone successful binaries. Only
`js/algorithms.ts::wasi` and `js/async.ts::wasi` change. The algorithms command
binary (SHA `2195f6478823ed4770081abe81fbe8dcab149166ed641d5ca0514c769a81a779`)
exits zero and matches the complete JavaScript stdout oracle. The async literal
has no `_start`. Reactor execution with the exported microtask drain emits only
the heading, also on exact base; the full async JavaScript oracle is not qualified.
Do not call these two binaries qualified merely from their hashes.

Types pass. Coercion/checker vocabulary, import cycles, IR layering and flat
source-directory checks pass. LOC/function checks pass both on the change base
and with `LOC_GATE_BASE=upstream/main`, without a new allowance. The inherited
console dependency's documented cycle allowance remains unchanged. Compiler
inventory is valid but architecture remains incomplete; the preservation-only
reachability contract passes while strict modeled closure remains OPEN because
of two existing nonliteral dynamic imports. Current main has been fetched, not
yet merged into this working diff. Fresh-context adversarial review remains
required before release; no predecessor head, HOLD or queue entry changed.

### Open semantic controls — publication is pending

The broader effect probe is kept in `.tmp/7138-effects.log`, with exact-base
results in the audit checkout's `.tmp/7138-effects-base.log`:

- Redefining a closed field with a read-only descriptor still does not reject
  the write (both base and candidate return -5 instead of the JS result 3).
- Frozen-field handling improves to 3 on standalone; WASI still returns -5.
- A dynamic accessor setter leaves its counter at zero on both base and current
  candidate in both targets. The provisional WASI throw was removed by canonical
  strict-set reuse. This needs a real shared MOP fix,
  not a narrower claim gate or an assertion accepting the wrong value.
- A computed store whose RHS dynamically invokes an instance method also
  exposes a provider gap. Base returns the wrong 0 / 1; candidate throws.
- Assignment-as-value remains a legacy-owned control, returning the correct -1.

These controls are not part of a claimed full semantic or retirement result.
The issue remains in progress and unpublished while they are investigated.
Existing predecessor heads, HOLDs and queue entries were not changed.
