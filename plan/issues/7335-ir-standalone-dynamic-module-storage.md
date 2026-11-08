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
# 2026-11-08: the binding rule and every use rule live in
# src/ir/dynamic-home-open-object.ts. What remains in the god-files is the hook
# each needs, because it reads or writes the selector's per-subject state:
# select.ts adds the initializer, define and own-property admissions (which
# record into #7128's admitted-literal set and the lowering's call map), the
# scope adapter, the raw-standalone gate, a use-refusal hook in isPhase1Expr's
# identifier arm and the own-property hook in its call arm. from-ast.ts adds
# the own-property dispatch in lowerCall; its arm is its own function.
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

- `src/ir/dynamic-home-open-object.ts` (new) holds the binding rule and every
  use rule:
  - `isDeclaration`: the syntactic rule plus legacy's `isOpenObjectBinding`
    and the resolver's `dynamic` home;
  - `useIsRefused`: refuses the uses the dynamic operations do not serve:
    - an inherited `Object.prototype` key read (#7128's U2 key screen);
    - a loose `==` / `!=`, whose `null` arm has no lowering;
    - a member write inside a nested function, whose code strictness
      `dyn.member_set` is not told;
  - `ownPropertyMethod`: `o.hasOwnProperty(k)` / `o.propertyIsEnumerable(k)`.
    It refuses a file that could have replaced the inherited method: a
    `.<method>` write or delete, or a `"<method>"` string anywhere in the
    source.
- `src/ir/select.ts` adds hooks that reuse #7128's state:
  - the empty-literal arm admits the initializer (`admittedOpenCarrierLiterals`);
  - `isOpenCarrierDefine` admits a U1 define statement on the binding from any
    unit;
  - the call arm admits the own-property test when the lane builds the
    `native-own-property-test` provider;
  - the boolean-influence classifier knows that test is an `i32` boolean;
  - the identifier arm refuses `useIsRefused`.
- `src/ir/from-ast.ts`:
  - `boxConcreteToDynamic` boxes an admitted open-carrier `{}` with the Object
    tag;
  - `lowerOpenCarrierDefineProperty` takes the target from the dynamic slot;
  - `lowerOwnPropertyMethodCall` reuses `lowerAliasCarrierOperands` and
    `emitDynOwnProperty`, the certified uncurried aliases' path (#7106 S1g).
- **Claim-then-demote fix** (found by the census). `for (var k in x)` in
  `<module-init>` was claimed by the selector and then demoted by lowering
  ("module-init unit contains a nested var declaration").
  - The predicate moves from `from-ast.ts` to `src/ir/module-init-vars.ts` as
    `moduleInitContainsUnmodelledVar`.
  - `assessModuleInit` refuses by it at select, and lowering keeps the same
    check, so there is one copy.

### gc

Every new arm requires the `isOpenObjectBinding` selection option, which only
the raw `standalone` target sets (`irOpenObjectSelectionOption`). The
unmodelled-var refusal is gated the same way (`selectingForRawStandalone`).

The ungated first cut changed one gc binary in the sample
(`Object/create/15.2.3.5-4-46.js`). The claim-then-demote it replaces leaves
the partial lowering's type registrations behind, and removing them reorders
the gc type section. gc keeps the demote until its own A/B.

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
