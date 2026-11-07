---
id: 7269
title: "IR: propertyHelper.js alias-call vardecls (#7250 steps 1–2)"
status: done
completed: 2026-11-06
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
related: [7190, 7106, 7258, 7265, 7266, 7272]
assignee: "ttraenkler/c-r11"
loc-budget-allow:
  # 2026-11-07: +4 in select.ts after main's post-merge baseline refresh lowered
  # the ceiling: the vardecl alias-call exemption sits next to the sibling
  # vardecl arms in the move-only scan and the alias expression arm next to
  # the other callee arms.
  - src/ir/select.ts
---

# IR: propertyHelper.js alias-call vardecls (#7250 steps 1–2)

## Problem

`ir_only_pass` counts standalone test262 passes with zero legacy units,
harness included. propertyHelper.js keeps about 130 of the 1340 stride-40
files out of it. With the move-only slices (a)(b)(c) in (#7104 → #7107 →
#7265), lane R7 measured `isWritable` stopping first at
`vardecl-module-binding-alias` (`src/ir/select.ts`, `isPhase1VarDecl`), and
`verifyProperty` at its own alias chain.

This issue was to admit the two harness alias-call vardecls:
`var x = __alias(args)` where `__alias` is a certified module binding, and
the boolean `__isArray(obj)` call in the conditional of isWritable's first
statement.

## Result

The measurement stopped this issue at first (0 units, 0 files). The lead
then split it on 2026-11-06:

- **This PR ships admission (1)**, the alias-call vardecl exemption (see
  "Shipped" below). It frees 0 units on its own, by design.
- **isWritable's first statement moves to #7272**, with admissions (d)–(f).

Base: `issue-7265-ir-move-only-bool-into-dynamic` @ `30856ab9`.

### Refusal chains (wrapped standalone compile, `JS2WASM_IR_SHAPE_DIAG=1`)

Same on `Boolean/prop-desc.js`, `Date/now/name.js`, `Math/abs/prop-desc.js`
and `Object/defineProperties/15.2.3.7-6-a-282.js` (10 of 25 units legacy):

| unit | first refusal |
| --- | --- |
| verifyProperty | `vardecl-module-binding-alias` on `__getOwnPropertyDescriptor(obj, name)` |
| isWritable | `vardecl-module-binding-alias` on `__isArray(obj) && name === "length" ? nonIndexNumericPropertyName : "unlikelyValue"` |
| verifyCallableProperty | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` |
| verifyEqualTo | `abi-signature-parity`: IR=161 (`$__closure_prop_set_type`), legacy=86 |
| verifyWritable / verifyNotWritable | `call-graph-closure` (they call isWritable) |

Two other files differ:

- `Object/defineProperty/15.2.3.6-4-547-2.js`: verifyEqualTo and
  verifyWritable stop at `param-dynamic-carrier-diverges-from-legacy(name)`.
  The cause is call-site dependent.
- `AbstractModuleSource/length.js`: all 25 units are legacy
  (`expr-ident-not-in-scope` on `assert`, `nonIndexNumericPropertyName`;
  `expr-new-ctor-unknown` on `Test262Error`). The whole harness is turned
  away there, before any of this issue's arms are reached.

### What the module-binding resolver returns

I logged `currentModuleBindingResolver` at the refusal site:

| binding | resolved `valueKind` |
| --- | --- |
| `__getOwnPropertyDescriptor` | `dynamic` (module slot, has declaration) |
| `__isArray` | `dynamic` (module slot, has declaration) |
| `nonIndexNumericPropertyName` | `f64` |

So the brief's premise does not hold. None of the aliases is a "compiled
function binding with a known signature". They are dynamic module slots that
hold host builtins. Their call identity is certified syntactically by
`src/ir/uncurried-object-alias.ts`, not by the resolver:

- `__hasOwnProperty`: uncurried form;
- `__getOwnPropertyDescriptor`: stored-static form;
- `__isArray`: not certified.

Typing `x` "by the callee's resolved return kind" would mean the resolver
reports function-valued slots, which is a change to its contract.

### Admission (1), the alias-call exemption: works, frees nothing alone

I stubbed it locally (not shipped): in `isPhase1VarDecl`, skip the alias
refusal when the initializer is `isStoredObjectDescriptorAliasCall` or a
2-argument `uncurriedObjectAliasMethod` call. On `Boolean/prop-desc.js`:

- verifyProperty moves to `vardecl-module-binding-alias` on
  `__getOwnPropertyNames(desc)`. That is the next alias in its chain, and
  after it come `names.length`/`names[i]`, `__push`, `__join` and
  `__defineProperty`. It also calls isWritable.
- isWritable does not move, because its first statement is the conditional
  below.
- With the conditional also stubbed to `var unlikelyValue = "unlikelyValue"`,
  isWritable then stops at `__hasOwnProperty(obj, name)`, which the
  exemption clears. **isWritable, verifyWritable and verifyNotWritable then
  become whole IR units** (legacy 10 → 7). This confirms R7.

So (1) is ready, but it is the second blocker of isWritable, not the first.

### Admission (2), the conditional: three admissions, not one

I replaced the initializer of `var unlikelyValue = …` one piece at a time,
with (1) stubbed:

| initializer | refusal |
| --- | --- |
| original | `vardecl-module-binding-alias` (`__isArray` dynamic slot, `nonIndexNumericPropertyName` f64 module value) |
| `__isArray(obj) && name === "length" ? 4294967295 : "unlikelyValue"` | `vardecl-module-binding-alias` |
| `Array.isArray(obj) && …` | `expr-static-predicate-operand` on `obj`: the #7106 static-predicate arm lowers only primitive operands |
| `name === "length" ? 4294967295 : "unlikelyValue"` | `expr-mixed-conditional-proof`: #5092 needs a checker-primitive condition; `name` is dynamic |
| `value ? 4294967295 : "unlikelyValue"` | `expr-mixed-conditional-proof` |
| `obj ? value : name` (all dynamic) | moves on to `expr-logical-value-family` on `value \|\| unlikelyValue` |

So once the alias is certified, the first statement still needs:

1. **`Array.isArray` of a dynamic operand.** Legacy does not certify
   `__isArray` (`resolveStoredObjectStaticMethod` lists only `Object`
   statics). It calls the slot as a generic dynamic callable. The IR has no
   dynamic-operand isArray. It would be a new IR operation with a native
   standalone helper, or the IR would have to make the same dynamic call.
2. **A mixed `number : string` conditional with a dynamic condition, into a
   dynamic local.** #5092's proof refuses a non-primitive condition, and its
   result is not a dynamic carrier. One arm is also the f64 module value
   `nonIndexNumericPropertyName`, which has to be boxed.
3. **A dynamic local as a logical-value operand.** `newValue = value ||
   unlikelyValue` admits only dynamic **parameters** and concrete buildable
   operands (`dynamicLogicalValueCarrier` /
   `concreteDynamicAssignmentOperandIsBuildable`). A dynamic `var` is neither.
   Then `newValue === oldValue` and `newValue + "2"` see a dynamic `newValue`
   whose type is no longer string-or-dynamic-param, which is the move-only
   scan's input domain.

Item 3 is the line the brief draws: it changes what `dynamicUsesAreMoveOnly`
and the logical-value carrier rules accept. It also overlaps the #7266 lane
(non-bool module values in conditions and values).

### Why the file count stays 0 even with isWritable done

Every includer compiles every propertyHelper unit, so a file reaches zero
legacy only when all of them ship. The 2026-11-05 census agrees: with every
harness unit shipped, zero-legacy rises 25 → 41 at stride 40. Freeing
isWritable, verifyWritable and verifyNotWritable leaves verifyProperty,
verifyCallableProperty, verifyAccessorProperty, verifyEqualTo, the two
verifyPrimordial* units and `<module-init>` (`Function`) legacy in every
includer. So **zero-legacy files freed: 0** for anything in this issue's
scope.

## Shipped: the alias-call vardecl exemption

- **`src/ir/uncurried-object-alias.ts`** gains two predicates:
  - `isUncurriedObjectAliasCall`: the 2-argument, non-optional, non-spread
    uncurried call. It folds the selector's inline copy of the same test.
  - `isCertifiedObjectAliasCall`: the uncurried call, or the stored
    `getOwnPropertyDescriptor` call.
- **`isPhase1VarDecl` (`src/ir/select.ts`)** no longer raises
  `vardecl-module-binding-alias` when a local's initializer is a certified
  alias call and none of its arguments touches a module value.
- **Nothing else changes.** The call itself is still checked by the existing
  expression arms, and from-ast already lowers it to the native provider. The
  result is an exact boolean (`__hasOwnProperty`) or the dynamic descriptor
  (`__getOwnPropertyDescriptor`). The resolver contract and
  `dynamicUsesAreMoveOnly` are untouched.
- **verifyProperty now stops at `vardecl-module-binding-alias` on
  `__getOwnPropertyNames(desc)`.** isWritable still stops on its first
  statement (#7272).

Adversarial cases (`tests/issue-7269-ir-property-helper-alias-call-vardecls.test.ts`):

- **Still refused:** an alias that is reassigned later, a wrong-arity call
  (`__hasOwnProperty(obj)`), and a module value as an argument.
- **Not certified:** a call through a shadowing parameter.
- **Alias called before its `var` runs:** both IR and legacy lower the call
  natively, so neither throws the TypeError that JS would. That was already
  legacy's behaviour; head and base give the same result.
- **Alias that throws (`probe(null, "x")`):** TypeError on both.

## Next slice

isWritable's first statement is [#7272](7272-ir-property-helper-iswritable-first-statement.md):
- (d) a dynamic-operand `__isArray`;
- (e) a mixed conditional over a boolean-result condition;
- (f) a mixed-conditional local as a dynamic logical operand.

After that, verifyProperty still needs its own chain (`__getOwnPropertyNames`
…). The file count only moves once all 7 remaining units ship, so this is a
multi-PR cover, not one lever.

## Implementation Plan

- **Module:** `src/ir/select.ts` (`isPhase1VarDecl`) only. The certification
  stays in `src/ir/uncurried-object-alias.ts`.
- **Reuses:** the existing alias certification (`uncurriedObjectAliasMethod`,
  `isStoredObjectDescriptorAliasCall`), the existing expression arms and
  from-ast's existing lowering.
- **Duplicate removed:** the selector's inline 2-argument uncurried test
  folds into `isUncurriedObjectAliasCall`.
- **Effect table** (fresh review, 2026-11-06): `isSideEffecting` (the DCE
  facet in `src/ir/analysis/effects.ts`) now agrees with `effectsOf` for
  every value-producing call-like dyn op. Added: `dyn.own_property` (the
  blocker), `dyn.member_get`, `dyn.instanceof`, `dyn.instanceof_fn`,
  `dyn.arguments_length`.
  - The `dyn.member_get` row also fixes a bug already on main: an unused
    `o.a` / `o[k]` in an IR-claimed function dropped its getter call (and the
    null-receiver TypeError). This is now tested.
  - `iter.done` / `iter.value` are left out: nothing builds them, and
    lower-generic rejects them as unreachable scaffolding.
  - Left droppable on purpose: `dyn.current_this` and `dyn.global_object`
    only read. `dyn.publish_argc` has no result, so the null-result rule
    keeps it.
  - `vec.set` / `vec.set_length` came in from #7134 through the main merge.
- **Code-quality criterion:** no new copy of an alias predicate, the
  exemption sits next to its siblings in `isPhase1VarDecl`, and the effect
  facets agree op for op on the dyn ops.

## Acceptance (for the slice that ships)

- In the wrapped-ledger A/B, harness legacy units fall, invariants stay at 0,
  and compileOk is not lower.
- The typed corpus is byte-identical on 3 lanes.
- Standalone test262 A/B over the propertyHelper includers: no pass→fail.
