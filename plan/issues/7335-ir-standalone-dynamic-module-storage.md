---
id: 7335
title: "IR: standalone dynamic module storage for script vars (lever D), slice 1: `var o = {}`"
status: in-progress
sprint: current
created: 2026-11-08
updated: 2026-11-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7106, 7311]
assignee: "ttraenkler/opus-lever-d"
# 2026-11-08 (review round 1): the binding rule and the allow-list of
# consumers live in src/ir/dynamic-home-open-object.ts; the never-written proof
# moved verbatim from codegen/class-heritage-check.ts to src/shared/binding-writes.ts.
# What remains in the god-files is the hook each needs, because it reads or
# writes the selector's per-subject state:
#   - select.ts +70: initializer, define and own-property admissions (they
#     record into #7128's admitted-literal set and the lowering's call map),
#     the live query object, and one hook each in
#     trackedModuleInfluenceIsBoolean and isPhase1Expr's call arm (+1 there);
#   - from-ast.ts +21 (lowerCall +2): the own-property dispatch in lowerCall,
#     its arm as its own 11-line function, the define target read from the
#     dynamic slot, and the Object-tag box of an open-carrier `{}`.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/from-ast.ts::lowerCall
---

# #7335: dynamic module storage for script vars (lever D)

## Problem

A test's `<module-init>` is refused whenever a top-level script `var` holds a
value the IR cannot type: `{}`, `{…}`, `new Date(0)`, a function, a wrapper,
or a var reassigned across value families. The IR has to share legacy's
`__mod_<name>` slot. With no IR home for the value, every use of the var
refuses: `Object.defineProperty(v, …)`, `v.p`, `v[k]`, calls and compares.

**Body-level ceiling** (stub census, 2026-11-08, origin/main `14a95052da`,
standalone, seeded ES5 sample of 2,000 files, 1,864 compiling, 239 already
IR-only):

- 99 files become IR-only with lever D alone.
- 224 files become IR-only with lever D plus `Object.*` statics.
- Most of the D-alone gain is `Object/defineProperty` (38) and
  `Object/defineProperties` (25).
- Data: `scratchpad/lever-d/` of the measuring session.

The census stubbed whole uses: accessor descriptors, `assert.throws`
closures and `hasOwnProperty` calls. Real code needs each of those as its own
arm, so lever D is a series of slices. This issue is slice 1.

## Implementation Plan

### Seam

**Legacy slot.**
- Legacy types a script `var` slot in `moduleGlobalWasmType`
  (`src/codegen/declarations.ts`).
- For an empty literal, the slot follows the empty-object widening pass
  (`collectEmptyObjectWidening`, `object-shape-widening.ts`). That pass keeps
  the var an open `$Object` in an externref slot unless an expando write
  widens it into a struct.
- Every `$Object` consumer (define, delete, accessor define, reflective write)
  already poisons that widening through `ctx.objectHashConsumerVars`.

**IR resolver.**
- The resolver already reads an externref script-var slot as the `dynamic`
  home (`scriptVarHome`, #7132), and `writeValueMatches` accepts any value
  for that home.
- The IR side therefore needs no new storage mechanism. It needs to:
  - admit the initializer;
  - box it onto the dynamic carrier;
  - serve the uses the dynamic operations handle, and refuse the rest at
    select.

**Slice 1 scope.** The binding:
- is a script's top-level `var o = {}` (unannotated, declared once);
- is never written or redeclared anywhere in the file;
- is one that legacy itself keeps open (`isOpenObjectBinding`, #7128 S1).

A non-empty literal needs an IR open-`$Object` builder that matches legacy's
`compileObjectLiteralAsExternref`. That, and `new`, functions and wrappers,
are later slices.

### Unconditional vs predicted widening: decided by measurement

Slice 1 widens nothing. It admits only bindings whose slot legacy already
chose as an open `$Object`, so legacy output for unclaimed files is unchanged
by construction. Whether a pin is worth adding (keeping `{}` vars that legacy
widens on an expando write open as well) is measured by A/B below, and gets
its own slice only if its gain is non-zero with zero ES5 regressions.

### Modules

- `src/ir/dynamic-home-open-object.ts` (new) holds the binding rule. It
  answers `isDeclaration`, `isReference` and `ownPropertyMethod`.
  - **The binding.** A script's top-level unannotated `var o = {}`.
  - **The proof that nothing else writes it:**
    - `bindingIsUniqueAndNeverWritten`: declared once and never written in any
      spelling, destructuring and parenthesized targets included, with no
      `eval` or `with` in the file;
    - `sourceWritesMemberNamed`: no member named `o` is stored or defined
      (`this.o = v` writes a script `var`);
    - `sourceMayPatchPrototype(file, "Object")` and
      `sourceNamesReflectiveRoute`: `Object.prototype` is the realm's own.
  - **The consumers.** Every reference, taken in its outermost parenthesized
    form, must be on an **allow-list** of the consumers the dynamic operations
    serve:
    - a read of an own key (not an `Object.prototype` key);
    - a plain `=` write in `<module-init>` or a top-level function;
    - a U1 define (`isOpenCarrierUse`);
    - an own-property test;
    - a strict `===` / `!==` operand, a `typeof` operand, a call argument.
  - Any other reference keeps the whole binding on legacy: an alias, an
    element access, a loose `==`, a condition, a destructuring target, a
    nested-closure write.
  - The verdict is cached per declaration, and the cheap checks run first.
  - `ownPropertyMethod` admits `o.hasOwnProperty(k)` /
    `o.propertyIsEnumerable(k)` only where every other mention of the method
    name is a plain member read and none is written.
- `src/shared/binding-writes.ts` now holds `bindingIsUniqueAndNeverWritten`,
  `occurrenceIsWriteTarget` and `isBindingSiteName`. They were moved verbatim
  from `codegen/class-heritage-check.ts`, which re-exports them, so codegen and
  the IR share one never-written proof.
- `src/shared/intrinsic-prototype-writes.ts` takes the #7106 lever SR branch's
  version verbatim (`sourceNamesReflectiveRoute`, `sourceWritesMemberNamed`,
  more intrinsics). Main's copy had not changed since SR forked, so the two
  merge cleanly.
- `src/ir/select.ts` adds hooks that reuse #7128's state through one live
  query object (`DYNAMIC_HOME_QUERY`):
  - the empty-literal arm admits the initializer;
  - `isOpenCarrierDefine` admits a U1 define on the binding from any unit,
    through `isOpenCarrierUse`;
  - the call arm admits and records the own-property test;
  - the boolean-influence classifier asks the same question as a pure query.
- `src/ir/from-ast.ts`:
  - `boxConcreteToDynamic` boxes an admitted open-carrier `{}` with the Object
    tag;
  - `lowerOpenCarrierDefineProperty` takes the target from the dynamic slot;
  - `lowerOwnPropertyMethodCall` reuses `lowerAliasCarrierOperands` and
    `emitDynOwnProperty`, the certified uncurried aliases' path (#7106 S1g).
- **The census's claim-then-demote** (`for (var k in x)` in `<module-init>`,
  claimed and then demoted for its nested `var` head) is no longer reachable.
  Main's #7288 refuses the head at select (`forin-head-module-var`) on every
  lane. The first cut's own refusal and its lane option were dropped when
  `origin/main` was merged in, because nothing else reached them: a `var` in a
  `with` body, a catch-redeclared `var` and a `for-of` head are all refused
  earlier.

### gc

The dynamic-home arms need the `isOpenObjectBinding` selection option, which
only the raw standalone target sets (`irOpenObjectSelectionOption`). gc
declines them, and the A/B finds no changed gc binary.

### Acceptance criteria

- **Correctness:** the claimed cases run equal to node and to the legacy-only
  compile on standalone. The refused cases keep `<module-init>` legacy with
  zero post-claim errors.
- **Sample measurement:** a 2,000-file ES5 sample A/B against main, every
  candidate file run on standalone. IR-only gain reported, and **zero** pass
  regressions (ES5 is a completed edition).
- **gc:** byte-identical spot check for a claimed shape and for a module-init
  for-in.
- **Code quality:** no new mechanism. The binding rule is one predicate
  shared by every arm. The selector hooks reuse #7128's open-carrier state. The
  moved predicate leaves one copy. No growth beyond those hooks in `select.ts`
  or `from-ast.ts`.

## Result (2026-11-08, base `cf5eac1cf6`, standalone)

**Unconditional vs predicted widening: no widening at all.**
- Slice 1 admits only `{}` bindings that legacy already keeps open, so legacy
  output for unclaimed files does not change.
- A pin that would also keep open the `{}` vars legacy widens on an expando
  write is worth nothing yet. All 69 sample files still refused with
  `objectlit-empty` carry 7 or more other legacy units (the propertyHelper
  harness lane), so the pin moves 0 files. No speculative pre-pass was built.

**Gain on the seeded 2,000-file ES5 sample.** This is a real compile with no
stubs, over every file with a qualifying binding (310):
- 9 files become IR-only: `Object/defineProperty/15.2.3.6-2-{15,18,30,32,33,36,38}`,
  `15.2.3.6-3-180` and `types/reference/8.7.2-6-s`.
- 0 files are lost, and post-claim errors are 0 on both base and head.

**A/B.** 367 candidate files: every qualifying binding, plus every file with a
module-init `var` head.
- Binaries were hashed with `originalHarnessCompileOptions` on both lanes.
- gc: 0 binaries changed.
- Standalone: 10 changed: the 9 above plus `Object/create/15.2.3.5-4-46.js`,
  the refused for-in.
- `runTest262File` on standalone: all 10 pass on both base and head.
  **0 regressions.**

**What the census says comes next.** The 310 files that still refuse:
- `Object.*` statics: 28 files where they are the sole blocker (lever O).
- `Object.defineProperty` with an accessor or computed descriptor:
  `expr-object-define-property-target`, 17 files where it is the sole blocker
  (#7128 S4).
- Function-valued vars: `vardecl-let-closure`.
- The propertyHelper harness lane.
- Non-empty `{…}` homes need an IR open-`$Object` literal builder that matches
  `compileObjectLiteralAsExternref` (the next slice).

**Data.** The measuring session's `scratchpad/lever-d/` holds the stub census.
The A/B rows are in the worktree's `.tmp/`.

## Review round 1 (2026-11-08, PR #7193)

The fresh-context review returned NOT met, with 10 findings. Each was
reproduced before it was fixed. The tests are rows in
`tests/issue-7335-dynamic-home-open-object.test.ts`.

1. **Parenthesized receivers and aliases bypassed the use screens.** Fixed:
   the per-use deny-list is gone. The binding qualifies only when every
   reference, in its outermost parenthesized form, is on the allow-list. An
   alias is not on it.
2. **Writes that the never-written proof missed:** `[o] = [5]`,
   `({a: o} = …)`, `(o) = 5`, `for ([o] of xs)`, `this.o = v`, eval and with.
   Fixed: the proof is the shared `bindingIsUniqueAndNeverWritten` plus
   `sourceWritesMemberNamed`.
3. **A fourth copy of the binding scan.** Fixed: the proof moved to
   `src/shared/binding-writes.ts` (with `isBindingSiteName`), and the
   reference walk is `emptyObjectLiteralBinding`'s.
4. **`methodMayBeReplaced` was weak.** Fixed:
   - the binding now needs `!sourceMayPatchPrototype(file, "Object")` and
     `!sourceNamesReflectiveRoute(file)`;
   - the own-property test needs every mention of the method name to be a
     plain member read.
5. **The lane was inferred from an option's presence.** Fixed: the refusal
   that needed it is gone (see the claim-then-demote note under Modules).
   Every remaining arm reads `isOpenObjectBinding` for what it means, legacy's
   answer, not as a lane flag.
6. **The U1 test was re-inlined.** Fixed: `isOpenCarrierUse` is called.
7. **Cost.** Fixed:
   - the verdict is cached per declaration, and the cheap checks run first;
   - the strictness owner is computed only for member writes;
   - there is one live query object instead of one allocation per call.
8. **A type query recorded admissions.** Fixed: the boolean classifier calls
   the pure `dynamicHomeOwnPropertyMethod`. Only `isPhase1Expr` records.
9. **Nits:** `Scope` became `DynamicHomeQuery`; the deny-list names are gone;
   no duck-typed `.name`; the grants state their sizes.
10. **Tests.**
    - The refusal rows assert `kind: "unsupported"`, `stage: "select"` and the
      selector detail.
    - `f` is asserted IR-claimed.
    - A trap is told apart from a thrown value.
    - Rows were added for: parenthesized and alias uses; destructuring,
      parenthesized and `this.o` writes; eval; `setPrototypeOf`; a replaced
      method; a ToPropertyKey-running key; an accessor descriptor; a
      shadowing parameter; `[o.b] = [11]`; a use before the declaration.
    - **Partly rebutted: the use-before-declaration row.** The input was
      `function f() { Object.defineProperty(o, 'q', { value: 2 }); }`, then
      `try { f(); … } catch (e) { if (!(e instanceof TypeError)) throw … }`,
      then `var o = {};`.
      - Node throws a TypeError there.
      - Legacy does not throw; neither does the IR, and it does not trap.
      - The row therefore asserts that the IR matches legacy and does not
        trap. This is a legacy gap, not a regression from this slice.

**Re-measured after the review and the merge of origin/main.** Base is main
at `aae9eda0b2`, which includes #7288. Same 2,000-file sample.
- **Gain:** 9 files become IR-only, the same 9 as before. 0 lost, and 0
  post-claim errors on both sides.
- **gc:** 0 of the 367 hashed binaries change.
- **Standalone:** exactly the 9 gained binaries change. The for-in file no
  longer differs, since #7288 handles it on both sides.
- **Pass/fail:** `runTest262File` passes all 9 on base and on head.
  **0 regressions.**
