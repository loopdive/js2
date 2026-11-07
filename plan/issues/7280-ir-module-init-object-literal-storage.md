---
id: 7280
title: "IR module-init: script-var object literals (`var obj = {}`, `{0: …}`, `{length: …}`) as the open `$Object` carrier"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7276, 7288, 7128, 2949, 7252, 7304]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-07 (#7280 S1): the admission is a sibling of #7128's
  # `isOpenCarrierBinding` and must sit beside it, since it reads the same
  # selector state (`currentSelectionOptions.isOpenObjectBinding`,
  # `admittedOpenCarrierLiterals`) and the module-binding resolver:
  #   - select.ts ~+27: `isDynamicHomeOpenCarrier` (with its doc) and the one
  #     call in the `{}` arm of `isPhase1ObjectLiteral`;
  #   - from-ast.ts +2: the literal's box onto the carrier when its slot asks
  #     for a dynamic value.
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# #7280: script-var object literals in `<module-init>`

## Problem

The census behind #6583 counts these as sole blockers of the test262 `<module-init>` unit:

- `var obj = {}` (`objectlit-empty`): 29 files;
- `obj = {}` (`vardecl-module-storage-unrepresentable`): 15 files;
- `{0: …}`: 6 files;
- `{length: …}`: 5 files;
- `proto = {}`: 3 files;
- 66 two-unit files paired with `formatPropertyName`.

Stacked on #7288 (and through it on #7276, whose `Object.create` lowering builds the same open `$Object` carrier).

## Measurement (2026-11-07, head of the #7288 stack 0e558eaf)

**Stride-40 census** (wrapped, standalone, SHAPE_DIAG). Files whose only legacy unit is `<module-init>`, first refused on object-literal storage, by initializer:

| first refusal | files | legacy slot type |
| --- | ---: | --- |
| `vardecl-module-storage-unrepresentable`, `{…}` (non-empty: `{0: 11, 1: 12}`, `{length: …}`, `{a: 1}`) | 47 | a **closed struct**, `(mut (ref null N))`, e.g. `$__mod_obj (ref null 17)` |
| `objectlit-empty` (`{}`, any position) | 29 | `externref` (the open `$Object`) |
| `vardecl-module-storage-unrepresentable`, `= {}` | 23 | `externref` |

So legacy keeps the #7276-style open `$Object` only for the **empty** literal. A non-empty literal is a closed struct (the shape #2949 widens with expando writes), and its `__mod_` slot is typed as that struct. Lowering it like `Object.create` would mean writing an open `$Object` into a struct slot, which changes legacy's storage and its output.

**Next blocker once `{}` is admitted.** Scratch probe, reverted: `{}` accepted as a dynamic value in `<module-init>`, over the 52 `{}` files. Each file's next refusal:

| next refusal | files |
| --- | ---: |
| storage of the `{}` var itself (`vardecl-module-storage-unrepresentable «obj = {}»`) | 33 (25 for `{}`, 8 other vars) |
| `expr-ident-not-in-scope` (`Symbol` 7, `Object` 3, `Array` 1) | 11 |
| closure return types, `let` closures, `++` on a dynamic value, other | 7 |
| from-ast only (selector passed): `f1`-shape `var obj = {}; obj.x = 1;` | 1 |

The storage refusal for `{}` is decided in the resolver / codegen home, not by the literal. Probes:
- `var obj = {}; Object.defineProperty(obj, "length", …)`: storage refused;
- `[].map.call(obj, …)`: storage refused;
- `var o1 = {}; var f = function () { return o1; }`: legacy has no `__mod_o1` slot at all;
- `var obj = {}; obj.x = 1;`: storage fine; from-ast lacks a dynamic producer for `{}` (`proven dynamic binding 'obj' initializer has no supported carrier`).

**Expected zero-legacy delta, stated before coding:**
- the `{}` admission alone: **about 1 file at stride 40**. The other `{}` files stop at the defineProperty / array-borrow storage refusal or at unrelated arms;
- the non-empty literals: **0** without an IR closed-struct producer whose type is legacy's struct, plus a resolver "object-literal struct" home (the #7252 class-instance home is the analogue). That is a different design from #7276's.

## Proposed slices (for the lead's decision)

1. **S1 (small):** a dynamic producer for `{}` in `<module-init>` (`emitNewPlainObject` boxed onto the carrier, the #7128 / #7276 builder). Admitted only where the resolver already gives the slot a dynamic home. Expected +1 at stride 40.
2. **S2 (large):** a closed-struct home for non-empty literals: the IR's `object.new` emitted with legacy's struct type, plus a resolver home kind beside `class-instance`. This is the 47-file bucket, and its next blockers are unmeasured until the storage is representable.
3. **S3:** the storage refusals around `Object.defineProperty(obj, …)` / `[].m.call(obj, …)` (codegen home classification). Most `{}` files sit behind this.

## Lead decision (2026-11-07)

S1 and S3; S2 deferred. A closed-struct home for the non-empty literals is a
resolver contract change and needs its own plan.

- **S2 (deferred follow-up, the 47-file `{…}` bucket):** legacy types a
  non-empty literal's `__mod_` slot as a closed struct (`(ref null N)`). The
  IR would need an `object.new` producer emitted with legacy's own struct type
  index, plus a resolver home kind for "object-literal struct" next to the
  #7252 `class-instance` home, so that every reader of the slot sees the
  struct. The next blockers in that bucket are unmeasured until the storage is
  representable.
- **S3 (next, on this issue):** the `{}` storage-home refusals around
  `Object.defineProperty(obj, …)` / `[].m.call(obj, …)`, and the
  closure-captured `{}` that gets no `__mod_` slot. It depends on session L's
  identity fix (#6583 comment 6701117870): in a JS file
  `Object.defineProperty(obj, "p", …)` makes `obj` a second checker
  declaration, and `directTopLevelDeclaration` declines `var obj = {}` as
  `merged-declaration`. L folds that into one predicate in
  `module-bindings.ts`; in L's scratch run 23 of those 34 files then stop at
  `objectlit-empty`, which S1 now admits. S3 stacks on L's PR and extends
  L's predicate instead of adding a second one. #7128's own scope (S5 = array
  targets) does not cover the module-init object home.

## S1 implementation (2026-11-07)

`var obj = {}` in a script's top-level code, when the resolver already gives
`obj`'s `__mod_` slot the dynamic carrier, no longer refuses `<module-init>`
as `objectlit-empty`.

- **Selector:** `isDynamicHomeOpenCarrier` (`select.ts`, beside #7128's
  `isOpenCarrierBinding`) admits the literal when:
  - it initializes an identifier in a modelled module-init `var` list;
  - the module-binding resolver gives the binding a `dynamic` value kind;
  - legacy keeps it as an open `$Object` in an `externref` slot
    (`isOpenObjectBinding`, the #7128 option, supplied on standalone only);
  - every `in` of the unit is an own-key probe (`unitInKeysAreOwnOnly`,
    shared with #7276; the native-`in` gap is #7304).

  It records the literal in `admittedOpenCarrierLiterals`, the set from-ast
  already reads.
- **Lowering:** the existing #7128 open-carrier producer
  (`emitNewPlainObject`, legacy's `__new_plain_object`), boxed onto the
  carrier because the slot asks for a dynamic value. No new builder or
  runtime helper.
- **Prerequisite fixed in #7142:** `<module-init>` now knows its code
  strictness, so `obj.k = v` / `obj["k"] = v` on the carrier follow PutValue's
  sloppy/strict failure rule instead of withdrawing or running strict.

### Measurement

The 52 test262 files with an `objectlit-empty` `{}` refusal (stride-40
census), with the branch head before S1 as the base:

| | base | S1 |
| --- | ---: | ---: |
| zero-legacy files (wrapped, standalone) | 0 | **1** |
| `<module-init>` first refusal `objectlit-empty` | 29 | 3 |
| post-claim withdrawals | 0 | 0 |
| standalone verdicts (pass / fail) | 50 / 2 | 50 / 2, identical per file |
| gc verdicts | 50 / 2 | 50 / 2, identical per file |

The new zero-legacy file,
`language/expressions/assignment/member-expr-ident-name-default-escaped.js`,
passes on standalone (the census rule: only passing files count). This is the
+1 predicted before coding. The other 25 files that stopped at `{}` move to
their next refusal: `vardecl-module-storage-unrepresentable` (the S3 / L identity
bucket), `expr-ident-not-in-scope` (`Symbol`, `Object`), closure return
types.

- Typed corpus (playground examples × gc / standalone / wasi): 39/39 binaries
  byte-identical, host imports identical.
- `tests/issue-7280-module-init-empty-object-carrier.test.ts`: 11 cases × 3
  lanes. Each asserts the verdict against JS, no `irPostClaimErrors`, and the
  `<module-init>` route (IR on standalone only). One case is compared against
  the IR-off compile on WASI: there legacy's member read misses an inherited
  method on its own, with or without S1.

