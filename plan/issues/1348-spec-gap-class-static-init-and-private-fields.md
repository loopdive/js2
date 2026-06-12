---
id: 1348
title: "spec gap: class static initialization order + private field semantics (significant share of 1500+ class fails)"
status: done
created: 2026-05-08
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class
goal: spec-completeness
sprint: 61
parent: 1328
pr: 1250
completed: 2026-06-06
---
# #1348 — Class: static block order, private field exotics, super-class field shadow

## Problem

`language/expressions/class`: **2755 / 4059 pass (67.9%) — 1301 fails (666 assertion_fail,
256 runtime_error, 205 type_error, 103 wasm_compile, 39 other)**.
`language/statements/class`: **2874 / 4367 pass (65.8%) — 1489 fails (850 assertion_fail,
221 runtime_error, 207 type_error, 107 wasm_compile, 48 other)**.

Combined ~2,790 class-related failures. Major sub-categories:

1. **Static initialization order** (§15.7.10): class static fields, methods, and `static {}` blocks
   must run in source order during class evaluation, with private statics installed before public
   methods. We currently process them all "after" the constructor, observable via field access from
   a static block.
2. **Private fields** (§15.7.7): each instance carries a fresh PrivateName slot per class
   declaration. Re-reading after deletion throws TypeError. Private brand check on `obj.#x` must
   throw TypeError if the object isn't an instance of the declaring class.
3. **Super-class field shadow**: when a subclass has a same-named instance field, the spec requires
   the superclass to install its field first, then the subclass overwrites. We currently skip the
   superclass install when the subclass redeclares.
4. **Computed property names with side-effects** (#1239): the [[Get]] of a computed name may have
   side-effects that must be observed once.

## Acceptance criteria

1. `language/statements/class/static-init-order-of-eval.js` passes.
2. `language/expressions/class/elements/private-field-as-instance.js` passes.
3. `language/statements/class/subclass/built-ins/Array/super-must-be-called-1.js` passes.
4. wasm_compile errors in `language/statements/class` drop from 107 to <30.
5. Pass-rate for `language/statements/class` rises from 66% to ≥80%.

## Files to modify

- `src/codegen/class-bodies.ts` — class member compilation order
- `src/codegen/expressions.ts` — private field access (`obj.#x`)
- `src/codegen/declarations.ts` — class declaration emission

## Implementation Plan

### Root cause

Multiple intertwined issues. Recommend splitting into three sub-tasks:

1. **Static initialization order**: scan class-body in source order; emit a single
   `__class_init_$N` function that runs each member's initializer in the right slot.
2. **Private fields**: model each `#x` as an additional struct field on the instance,
   with a hidden brand-check (`ref.test $ClassBrandX`) at every access site. TypeError
   on missing brand.
3. **Super shadow**: when extending a parent class, walk parent's field declarations during
   constructor compilation; emit each (whether or not the child redeclares).

Each sub-task is medium-sized; consider creating sub-issues if devs prefer.

### Edge cases

- `static {}` block can reference earlier static fields but not later ones — emit a hoisting
  guard that raises ReferenceError on TDZ access.
- Private field on a class expression vs class declaration — same brand semantics.
- `class C extends null` — super constructor is null; valid per spec, super() throws TypeError.

### Test262 sample

- `test262/test/language/statements/class/static-init-order-of-eval.js`
- `test262/test/language/expressions/class/elements/private-field-as-instance.js`
- `test262/test/language/statements/class/subclass/builtin-objects/Array/super-must-be-called-1.js`
- `test262/test/language/statements/class/static-block-private-name.js`

  > NOTE: verify exact paths against the submodule (`find test262/test/language
  > -path '*class*' -name '*static*order*'` / `*elements/static-*`); the
  > filenames above are indicative, not verbatim (the `class/elements/` and
  > `static-init-order-*` clusters carry the real fixtures).

## Architect Spec (2026-06-04) — done-vs-residual + dev-ready slices

The coarse plan above is correct in spirit but several pieces have since
**landed**; this section pins exactly what exists on main, what the residual
gap is per sub-task, and cuts independently-shippable slices. Verified against
current source 2026-06-04.

### Already on main (do NOT re-implement)

- **Static field + `static {}` source-order queue** — `class-bodies.ts:691-757`
  pushes static field initializers AND static blocks to the shared
  `ctx.staticInitExprs` queue **in member-declaration order**, drained in
  `__module_init` (`declarations.ts:3832-3854`) with per-entry
  `enclosingClassName`/`isStaticContext` so `this` resolves to the class
  singleton. So intra-class field-vs-block ordering is already correct.
- **Private-field brand check (#1365)** — `property-access.ts:1127-1181`:
  reading `obj.#x` resolves the declaring class
  (`resolveDeclaringClassForPrivateName`), `ref.test`s the receiver against that
  class's struct, throws a real `TypeError` on brand-miss, `ref.cast`+
  `struct.get` on success. Skips the check for `super.#x` and in-body `this.#x`.
  Private setters (#1680) + static private accessors (#1681) landed.
- **Static initializer blocks execute (#1643)**; static `this.X=v` routes to the
  static global (#1697).

### Residual gaps (this issue's actual scope) — three independent slices

#### Slice A — static **method/accessor** install order + forward-field TDZ (§15.7.10)

**Gap:** static *methods/accessors* are installed at class-body compile time
(`class-bodies.ts:420-560`, into `staticMethodSet`/`staticAccessorSet` + emitted
as functions), **separately** from the `staticInitExprs` field/block queue. The
spec evaluates the class body in a single source-order pass; a static field
initializer or static block that runs earlier must NOT observe a *later* static
method, and a static field initializer reading a *later* same-class static field
must throw ReferenceError (TDZ), not read the global's zero-init.

**Fix:**
- Thread static method/accessor *installation* into the SAME `staticInitExprs`
  ordering via a new entry kind `{ staticMethodInstall: fullName, className }`,
  pushed at the member's source position in the `class-bodies.ts:695` loop
  (interleaved with field/block pushes). The drain (`declarations.ts:3832`)
  assigns the funcref/closure to the static class-object slot when it reaches
  that entry, so a preceding static block does not see a later method as a
  property. (Direct internal calls by name are unaffected — this is about the
  observable `C.method` property + static-block visibility window.)
- **Forward-field TDZ**: track a per-static-field i32 "initialized" flag (one
  global per field, or a per-class bitset global). Set it as each
  `staticInitExprs` field entry runs. In static-context reads
  (`isStaticContext`) of a same-class static field, guard the `global.get` with
  `if !flag → __throw_reference_error`. Scope to static-context only — instance
  reads unaffected.
- Files: `class-bodies.ts` (ordered method-install + field-flag pushes),
  `declarations.ts` (drain new entry kinds + set flags), `expressions.ts`
  (static-context forward-read TDZ guard at the static-global read site).

#### Slice B — super-class instance-field shadow + `extends null` (§15.7.10 InitializeInstanceElements)

**Gap:** when a subclass declares an instance field with the same name as a
superclass field, the spec installs the **superclass** field first (during
super()'s InitializeInstanceElements), then the subclass overwrites after super()
returns. Current constructor compilation skips the superclass install when the
child redeclares, dropping the parent initializer's side-effect and corrupting
field order/identity.

**Fix:**
- In the constructor instance-field init emission (`class-bodies.ts`, the
  per-field `struct.set` init loop), when `extends` is present, replay the
  **parent's** instance-field initializers at the super()-return point
  (InitializeInstanceElements timing) for **all** parent fields — even ones the
  child redeclares — then emit the child's own inits (which overwrite). Store the
  parent's field-init expressions on class metadata at collection time
  (`declarations.ts`) so the child constructor can replay them. Walk
  `ctx.classParentMap`.
- **`class C extends null`**: parent is null; `super()` must throw TypeError
  (§15.7.14 step 6). Guard the super-call path — if the resolved parent is the
  null-extends sentinel, emit `__throw_type_error`.
- Files: `class-bodies.ts` (parent-field replay at super-return + extends-null
  guard), `declarations.ts` (carry parent field-init exprs on class metadata).

#### Slice C — private-field exotics residuals (build on the #1365 brand check)

**Gap (narrow, after #1365/#1680/#1681):**
- **`#x in obj` (PrivateIn, §13.10.1)**: the `in` operator with a private name is
  a brand check returning a boolean (NO throw). Today `obj.#x` throws on
  brand-miss; `#x in obj` must instead yield `false`. Add a PrivateIn arm to the
  `in`-operator lowering: `ref.test` against the declaring class → i32 boolean,
  no throw. Locate the `InKeyword` binary-op site (`binary-ops.ts`).
- **Static-block plain private field** (`static #x; static { this.#x }`): confirm
  static private *fields* (not accessors — #1681 covered those) read from the
  static class-object brand, not the instance struct.
- **Per-declaration fresh slot**: verify the struct-field +
  `resolveDeclaringClassForPrivateName` model gives each class *declaration* a
  distinct brand (it does, keyed by className). A class *expression* re-evaluated
  twice needing distinct brands is likely out of scope → carve #1348c if a
  fixture requires it.
- Files: `binary-ops.ts` / `expressions.ts` (PrivateIn arm), `property-access.ts`
  (static private field read), tests.

### Edge cases (consolidated)

- `static {}` reading an earlier static field → OK; a later one →
  ReferenceError (Slice A TDZ).
- `class C extends null; new C()` → super() TypeError (Slice B).
- `#x in obj` → boolean, never throws (Slice C); `obj.#x` on wrong brand →
  TypeError (already #1365).
- Computed static property names with side-effects (issue item 4 / #1239): the
  `[expr]` key's `[[Get]]` runs once at class evaluation in source order — fold
  into Slice A's ordered pass (push a `computedNameEval` entry at the member's
  position). Keep narrow; carve to #1348d if it balloons.

### Slice independence + sizing

- **Slice A** (static method/accessor order + forward-field TDZ): ~150 LOC,
  highest assertion_fail share (static-init-order cluster). Independent.
- **Slice B** (super-field shadow + extends-null): ~120 LOC, independent; carries
  most of the `wasm_compile` 107→<30 AC (invalid-Wasm super/extends-null paths).
- **Slice C** (`#x in`, static private field): ~90 LOC, builds on merged #1365.
- The ≥80% bar is the union A+B+C plus the already-merged brand work. Each slice
  is a separate PR; A is the biggest single lever.

### Risk / conflicts

- File overlap: `class-bodies.ts` + `declarations.ts` are touched by all three
  slices AND by in-flight class work (#1680/#1681/#1682 family, #1697). Land
  A→B→C serially to avoid `class-bodies.ts` conflict churn; if parallelized, give
  to the same dev to serialize file edits.
- Regression watch: the static-init reordering must not regress the
  already-passing `static {}`-executes (#1643) or static-`this.X` (#1697) — run
  `language/statements/class/elements/static-*` as the guard.
- No new host imports — codegen ordering + `ref.test` brand checks + native
  throws (#1473, standalone-safe). Dual-mode clean. ✓

## Codex implementation notes (2026-06-06)

Implemented the residual class/private semantics that still reproduced locally:

- Private brand checks now combine the existing `ref.test` with the hidden class
  tag and descendant-tag ancestry. This rejects unrelated classes that declare
  the same private name and compile to an equivalent WasmGC struct shape, while
  preserving subclass instances as valid receivers for ancestor private names.
  The shared predicate is used by both `#x in obj` and `obj.#x` reads.
- Explicit derived constructors now defer their own instance field initializers
  until the handled `super()` call returns. `compileSuperCall` also replays
  superclass field declaration initializers before child initializers, so
  same-named child fields overwrite after parent side effects run.
- Static field/static-block source order was already mostly implemented on this
  branch; added focused regression coverage for public static fields/blocks and
  static blocks reading earlier private static fields.

Spec references checked before implementation:

- ECMA-262 §15.7.14 ClassDefinitionEvaluation: class elements are evaluated and
  static field/block records execute during class evaluation.
- ECMA-262 §13.3.7.1 SuperCall: after constructing the super constructor,
  `InitializeInstanceElements(result, funcObj)` runs for the derived constructor.
- ECMA-262 §7.3.26 PrivateElementFind / §7.3.30 PrivateGet: private membership
  is keyed by the declaring private name, not by structural field shape.

Validation:

- `node node_modules/vitest/dist/cli.js run tests/issue-1348.test.ts` — pass
  (10 tests).
- `node node_modules/vitest/dist/cli.js run tests/issue-1348.test.ts
  tests/issue-1643.test.ts tests/issue-846h.test.ts tests/issue-1682.test.ts
  tests/class-static-private-this.test.ts` — pass (29 tests).
- `pnpm exec tsc --noEmit --pretty false` — pass.
- Rechecked after merging `origin/main` on 2026-06-06 with the same scoped
  vitest set and `pnpm exec tsc --noEmit --pretty false` — pass.

Notes:

- The local `test262/` checkout is absent in this worktree, so no local
  test262 path-filter run was possible.
- An accidental broad `pnpm test -- tests/issue-1348.test.ts` invocation expanded
  into a partial full-suite run, surfaced unrelated existing failures, and ended
  with a vitest worker OOM. Scoped direct vitest runs above are the validation
  used for this issue.
