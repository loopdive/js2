---
id: 7338
title: "IR: `Object.<static>(…)` calls through the dynamic carrier, one table (defineProperty, defineProperties, getOwnPropertyDescriptor, create)"
status: in-progress
sprint: current
created: 2026-11-11
updated: 2026-11-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7106, 7128, 7280, 7335, 7189]
loc-budget-allow:
  # 2026-11-12 (#7338, PR review B1/B2): select.ts learns that a static's result is the carrier
  # (`isDynamicCarrierValue`, `lowersToCarrier`, the strict-only nullish compare, the reassigned-parameter
  # refusal) so no use of one is claimed and then demoted, and keeps the JS environment's create beside the table.
  - src/ir/select.ts
  # 2026-11-12 (#7338, PR review B1/B2): from-ast's carrier test reads the same plan, and the JS environment's
  # `Object.create` hook is restored beside the table hook.
  - src/ir/from-ast.ts
  # 2026-11-12 (#7338, review nit): the provider type is imported by name instead of `Parameters<…>[0]`.
  - src/ir/integration.ts
---

# #7338 — IR: `Object.<static>(…)` through the dynamic carrier, one table

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only": no function or module-init falls back to the
direct AST compiler).

Census of 2026-11-11 (main `7ce9bc8fbf`, all 9,174 ES5 files, standalone,
`JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`): 8,591 compile,
**1,505 IR-only (17.5 %)**.

The most frequent refusal labels are both about the `Object` statics:

| label | files carrying it | sole label |
|---|---|---|
| `expr-ident-not-in-scope(Object)` | 1,696 | 186 |
| `expr-object-define-property-target` | 1,613 | 35 |

2,600 files carry at least one of the two. `Object.*` members used in the
1,696: defineProperty 712, defineProperties 600, getOwnPropertyDescriptor 506,
create 308, `Object.prototype` 124, preventExtensions 76, bare `Object` 66,
isExtensible 51, freeze 44, getPrototypeOf 40, isFrozen 40, keys 15,
getOwnPropertyNames 13.

### Why each call refuses today (`src/ir/select.ts`, `isPhase1Expr` call arm)

- **`Object.defineProperty(x, k, desc)`** has its own arm
  (`isAmbientObjectDefineProperty`). On standalone it admits only
  `isOpenCarrierDefine` and otherwise answers
  `expr-object-define-property-target`. `isOpenCarrierDefine` needs all of:
  - the target is an identifier naming a `var o = {}` that is either a #7128
    open-carrier local of the same unit, or a #7280 dynamic-home script var
    whose **every** reference passes #7335's allow-list (`isServedUse`);
  - the call is an expression statement (its result would alias the carrier);
  - the key is a string literal and the descriptor an inline data descriptor
    of primitive literals (`openCarrierDefinePlan`,
    `literalDataDescriptorFields`).

  So it refuses: any other target (a call result, a function, an array, a
  primitive in an `assert.throws` body), an accessor descriptor, a descriptor
  held in a variable, a computed key, a used result. It also refuses a
  perfectly literal define as soon as the same `o` is passed to any other
  call, such as `Object.getOwnPropertyDescriptor(o, "p")`, because a call
  argument is not a served use.
- **`Object.defineProperties(x, descs)`** has no arm. It falls to the generic
  member-call receiver walk, where the identifier `Object` is not a value in
  scope: `expr-ident-not-in-scope(Object)`.
- **`Object.getOwnPropertyDescriptor(x, k)`** has no direct arm either, same
  label. The IR lowers this static only in propertyHelper's stored form
  (`var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;`, the
  `STORED_STATICS` table in `src/ir/uncurried-object-alias.ts`). Result uses
  are not the problem: a dynamic result's `desc.value` / `desc.writable` /
  `desc.get` already read through the dynamic member arm.
  `desc.hasOwnProperty("value")` does not (see "Not covered").
- **`Object.create(proto[, descs])`** is admitted for exactly
  `Object.create({}, { <literal data descriptors> })` (#7276,
  `src/ir/object-create-call.ts`), which expands the map at compile time.
  Every other form (one argument, a non-`{}` proto, a map with an accessor or
  a computed value) falls to the same `Object` label.

The native runtime already has what each needs, and legacy standalone calls
it for the non-literal forms: `__obj_define_from_desc(o, k, desc)`,
`__defineProperties(o, descs)`, `__getOwnPropertyDescriptor(o, k)`,
`__object_create(proto)`, all `externref` in, `externref` out.

## Measurements

Method (stub): the label counts above say what a file complains about, not
what else is wrong with it. To measure the real yield, each of the four calls
was rewritten, in memory on the assembled source (harness included, nothing on
disk), into a form the IR already admits:
`(assert._isSameValue(arg, arg), <result>)`. Every argument is consumed as a
boxed dynamic value and the result is a dynamic value, which is what the
mechanism below does. An inline `{}` argument was replaced by a dynamic
object, since a fresh plain object is already lowerable. Then the file was
recompiled and counted as gained only if it had zero legacy units.

Population: **the full set**, all 2,600 files carrying either label (not a
sample). 2,336 of them contain one of the four calls. Tooling:
`.tmp/os/stub.mts`, `agg.py`, `need.py` in the `es5-census` worktree.

| stubbed | files that become IR-only |
|---|---|
| `defineProperty` alone | 8 |
| `defineProperties` alone | 19 |
| `getOwnPropertyDescriptor` alone | 8 |
| `create` alone | 16 |
| all four | **59** (2.5 % of 2,336) |
| all four + `x.hasOwnProperty(k)` / `x.propertyIsEnumerable(k)` | 93 |

"Alone" counts files that use only that static; the other 8 of the 59 need two
(`defineProperty` + `getOwnPropertyDescriptor` 7, `defineProperties` +
`defineProperty` 1).

Split by label: 51 of the 59 are in the 1,696 `Object` carriers, 16 in the
1,613 define-target carriers.

**The label counts overstate by more than four times.** 255 files carry only
these two labels; 59 become IR-only. This lever is a prerequisite for about
2,300 files and sufficient for 59 (IR-only 17.5 % → 18.2 %).

What the 59 need, by operand form (their test bodies):

| needs at most | files (cumulative) |
|---|---|
| `getOwnPropertyDescriptor` + `defineProperty` with a literal data descriptor | 14 |
| + `defineProperties` / `create` with a literal data map | 27 |
| + non-literal descriptors, computed descriptor values, non-identifier targets | 46 |
| + accessor or function-valued descriptor literals | 59 |

Next blockers in the 2,277 files still failing after the all-four stub (top
10 by file count; `sole` = the only reason left):

| files | sole | reason | what it is |
|---|---|---|---|
| 680 | 0 | `expr-ident-not-in-scope(Function)` | comes with the propertyHelper include |
| 673 | 0 | `harness:propertyHelper.js` | `verifyProperty` and siblings stay legacy |
| 672 | 94 | `expr-module-scalar-method(.hasOwnProperty)` | own-property test on a binding outside #7335's proof |
| 535 | 47 | `vardecl-let-closure` | `var f = function () {…}` |
| 412 | 24 | `objectlit-ordinary-to-primitive-method` | an object literal with function-valued fields, mostly accessor descriptors |
| 298 | 28 | `vardecl-module-storage-unrepresentable[empty-array]` | `var a = []` |
| 243 | 40 | `forin-receiver-not-dynamic-externref` | `for (p in obj)` |
| 209 | 0 | `expr-new-module-binding-callee` | `new Con()` on a script var |
| 198 | 57 | `vardecl-module-storage-unrepresentable[object-literal]` | `var o = { a: 1 }` |
| 139 | 0 | `expr-delete-no-ir-lowering` | `delete o.p` |

Read from those reason sets (label-based, so an upper bound): resolving
own-property tests, function-valued literals, closures and the propertyHelper
harness together would free at most 493 more files; adding array and object
literal module storage, at most 854.

Seven stubbed files hit a post-claim error (an IR lowering failure after
selection had claimed the unit) once module-init was claimed. They are
existing lowering gaps this lever would expose, and each slice must leave the
count at zero: `bare 'null' in non-reference context (f64)`, `property
assignment on dynamic is not in slice 4` (2), `empty array literal needs a
vec-typed hint` (3), `proven dynamic binding 'obj' initializer has no
supported carrier`.

## Implementation Plan

### Mechanism

One table of `Object` statics. Each row names the native runtime helper legacy
standalone already calls, and the role of each operand. A call
`Object.<static>(…)` on the ambient `Object` lowers to: every operand boxed
onto the dynamic carrier, one call of the row's helper, the result a dynamic
value. No row is a special arm.

| static | helper (legacy's own registration) | operands | result |
|---|---|---|---|
| `defineProperty` | `__obj_define_from_desc` | target, key, descriptor | the target; a null answer throws the TypeError `emitOpenCarrierDefine` already throws |
| `defineProperties` | `__defineProperties` | target, descriptor map | the target |
| `getOwnPropertyDescriptor` | `__getOwnPropertyDescriptor` | target, key | dynamic |
| `create` | `__object_create`, then `__defineProperties` when a map is given | proto, descriptor map (optional) | dynamic |

Operand roles:

- **value**: any Phase-1 expression, boxed with the existing
  `boxConcreteToDynamic`.
- **descriptor** / **descriptor map**: either an inline object literal, built
  field by field as an open `$Object` (`__new_plain_object` + `__extern_set`,
  the descriptor-building half of `emitOpenCarrierDefine`), or a value already
  on the dynamic carrier. A descriptor that the IR types as a closed struct is
  refused at selection. Legacy reifies such a struct before the helper
  (`emitDescriptorStructReify`, `isDescriptorTranscribableStruct`); the IR
  does not copy that, it refuses until a slice needs it.

### Module placement (IR layering)

- **Selection**: new `src/ir/object-statics.ts`, sibling of
  `object-integrity.ts` and `object-create-call.ts`. It owns the table and one
  plan function, `objectStaticCallPlan(call, facts)`, which answers a row plus
  operand roles, or a refusal code. The selector and from-ast both read this
  one plan (the #7276 pattern), so they cannot disagree. `select.ts` keeps one
  hook in `isPhase1Expr`'s call arm.
- **Lowering**: `src/ir/open-object-carrier.ts` gains
  `emitDescriptorObject(builder, fields)` (factored out of
  `emitOpenCarrierDefine`) and `emitObjectStaticCall(builder, row, operands)`.
  `from-ast.ts` keeps one hook in `lowerCall`.
- **Integration**: `src/ir/stored-static-alias-providers.ts` already holds the
  import signatures of the object-runtime providers and
  `integration.ts` already registers them
  (`storedStaticProviders`). The new helpers are added to that one signature
  table; no new registration loop.

### What it reuses

- The native helpers above, unchanged. No new runtime code, no host import.
- `irRuntimeFuncRef`, `emitNewPlainObject`, `emitThrowTypeErrorIf`,
  `boxConcreteToDynamic`.
- The provider registration path in `integration.ts` for stored statics.
- `unitInKeysAreOwnOnly` (`object-create-call.ts`) wherever a row returns a
  fresh open `$Object`: the native `in` does not reach that object's implicit
  `%Object.prototype%` terminal.
- `src/shared/intrinsic-prototype-writes.ts` and
  `src/shared/binding-writes.ts` for the trust boundary (below).

### Duplicates it removes

1. **`STORED_STATICS` in `uncurried-object-alias.ts`** becomes a consumer of
   the same table. The stored form (`__getOwnPropertyDescriptor(o, k)`) and
   the direct form (`Object.getOwnPropertyDescriptor(o, k)`) are two spellings
   of one row; today only the stored one exists. `getOwnPropertyNames` moves
   with it. `Array.isArray` stays where it is (not an `Object` static).
2. **#7128 / #7335's U1 define** (`isOpenCarrierDefine`,
   `openCarrierDefinePlan`, from-ast's define arm) becomes the
   `defineProperty` row with a literal descriptor. The open-carrier *binding*
   admission of #7128 and #7280 stays: it decides where the object lives, not
   how a define is lowered.
3. **#7276's compile-time expansion** in `object-create-call.ts` (one define
   per key) becomes the `create` row with a literal map through
   `__defineProperties`. Its admission screens (`{}` proto only, no
   `__proto__` key, own-only `in`) stay as that row's S2 conditions.
   `__defineProperties` defines in own-key order where the expansion used
   source order; the two differ only for array-index keys, which #7276 already
   refuses. Keep that refusal until a slice measures it.

`object-integrity.ts` (lever O) is not folded in: its table answers integrity
statics at compile time and never calls the runtime. S5 adds the runtime rows
for the cases it declines; both then dispatch from the same call-arm hook.

### Refusal at selection only

`objectStaticCallPlan` is total: every reason to decline is a selection
refusal with its own detail code (`expr-object-static-lane`,
`-arity`, `-spread`, `-operand`, `-descriptor-struct`, `-untrusted`). from-ast
calls the same plan and treats a null as an invariant violation, never as a
demotion.

### Slices

Gains are the measured counts above, on the full 2,600-file set. Every slice
has the same gates:

- the stated number of files gained on that set, **0 lost**;
- **0 post-claim errors** on the set;
- **0 gc binary changes** (byte-identical output for the JS environment on
  the equivalence corpus and the playground examples);
- pass/fail unchanged on every file whose unit routing changed, IR against
  legacy-only;
- the code-quality criterion stated for the slice;
- the size expectation stated for the slice; any growth grant is the
  exception and is restated in this file's frontmatter with a dated reason.

**S1 — the table, `getOwnPropertyDescriptor`, `defineProperty` with a literal
data descriptor. Expected gain: 14 files.**

- New `object-statics.ts` with the table, the plan and the trust check.
- Rows `getOwnPropertyDescriptor` and `defineProperty`. Target: any dynamic
  carrier value. Key: any Phase-1 value. Descriptor: an inline data-descriptor
  literal whose values are Phase-1 values. The result may be used.
- `STORED_STATICS`' two `Object` rows read the new table (duplicate 1).
- The dynamic-home U1 define is served by the row (duplicate 2). #7335's
  `isServedUse` learns one more served use: an operand of a table call whose
  key operand is a string literal. That keeps its own-property proof valid
  (`sourceWritesMemberNamed` already screens a define of `hasOwnProperty`)
  and is what lets `defineProperty` + `getOwnPropertyDescriptor` on the same
  `o` pass.
- Quality: `select.ts` and `from-ast.ts` each hold exactly one hook for the
  table; `isOpenCarrierDefine`'s dynamic-home half and the from-ast define arm
  are deleted, not kept beside the row; no row has a branch the others lack.
- Size: `select.ts` and `from-ast.ts` net ≤ 0 lines. New module ≈ 150 lines.

**S2 — `defineProperties` and `create` with literal data maps. Expected gain:
+13 (27).**

- Rows `defineProperties` and `create` (one or two arguments; proto `{}` or a
  dynamic value; `null` stays refused, it is the IR's separate
  `Object.create(null)` contract).
- `object-create-call.ts` keeps its screens and loses its expansion
  (duplicate 3).
- Quality: one `emitDescriptorObject` builds every literal descriptor and
  every literal map entry; no second field-by-field loop.
- Size: `object-create-call.ts` shrinks; `select.ts` / `from-ast.ts` net 0.

**S3 — descriptor and map operands that are dynamic values; computed
descriptor values; primitive and inline-literal targets. Expected gain: +19
(46).**

- A descriptor held in a dynamic binding or returned by a call passes as is.
- A primitive target (`Object.defineProperty(true, "foo", {})` inside an
  `assert.throws` body) is boxed and reaches the helper's own type check.
  Verify, per row, that the helper throws the TypeError legacy throws for a
  non-object target before admitting it; a row whose helper does not is
  refused for primitive targets.
- Quality: the struct-descriptor refusal is one predicate in the plan, with a
  test that fails if a struct descriptor is ever boxed raw.
- Size: `object-statics.ts` only.

**S4 — accessor and function-valued descriptor literals. Expected gain: +13
(59).**

- A literal field whose value is a function expression is a closure boxed to
  the dynamic carrier. Depends on the closure-as-dynamic-value support the
  selector has at that point; where the function itself is refused
  (`vardecl-let-closure`, `closure-return-type`) the file stays blocked by
  that lever, not this one.
- Quality: no accessor-specific arm. `get` / `set` are ordinary fields of
  `emitDescriptorObject`.
- Size: net 0 outside tests.

**S5 — the remaining statics as rows.** `getOwnPropertyNames`, `keys`,
`getPrototypeOf`, and the integrity statics lever O declines to fold
(`preventExtensions`, `isExtensible`, `freeze`, `isFrozen`, `seal`,
`isSealed`). Not measured by this issue's stub; measure with the same method
before starting, and drop any row that gains nothing.

## S1 + S2 result (2026-11-11, revised 2026-11-12 after PR review)

Both slices landed together. Measured by real compile (no stubs) over the
2,600-file set plus the 157 files that were already IR-only on main and use a
table static, a stored alias or propertyHelper (2,757 files), standalone,
original harness, `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`,
against a detached `af39ceaf08` (main has had no `src/` change since).

| | files |
|---|---|
| gained (IR-only now, not on main) | **39** (22 use only S1's statics, 17 need S2's) |
| lost | 0 |
| new compile errors | 0 |
| post-claim errors | 0 (0 on main) |

Unit routing changed in exactly those 39 files; each passes under
`scripts/run-test262-paths.mts --standalone` on both trees, and a seeded
300-file sample of the set gives the same verdicts on both. JS-environment
(default target) binaries are byte-identical on both trees for 932 inputs (the
13 playground examples and every third file of the set) and for the 124
probe programs of the PR review.

33 of the 39 are among the 59 the stub predicted; 6 are beyond it. Two of the
27 files the stub assigned to S1 + S2 stay legacy:
`Object/create/15.2.3.5-1-2.js` (`Object.create(null)`, refused as `proto`)
and `Object/prototype/15.2.3.1.js` (`Object` passed as a value, refused as
`untrusted`).

### What the code does

- `src/ir/object-statics.ts`: the table (`defineProperty`,
  `defineProperties`, `getOwnPropertyDescriptor`, `getOwnPropertyNames`,
  `create`) and the one plan, `objectStaticCallPlan`. A row is data: how many
  leading arguments are values, what the rest define (`keyed`: one key and
  its descriptor; `map` / `optional-map`: a descriptor map), the helper, what
  the first value must be where the helper does not test it, and whether the
  first value is a prototype. The selector and from-ast both call the plan; a
  refusal is a selection refusal,
  `expr-object-static-<shape|arity|untrusted|proto|descriptor|in-key>`, and an
  operand that is no carrier is `expr-object-static-operand`.
- `src/ir/empty-object-literal.ts` holds the descriptor parsing: one
  `dataDescriptorFields(descriptor, admitsValue)`, the keyed definition, the
  descriptor map, `definesLiteralsOnly` (#7128's U1 test, now a question over
  the plan's definitions, not a name check) and `unitInKeysAreOwnOnly`.
- `src/ir/open-object-carrier.ts`: `emitObjectStaticCall` lowers every row
  over carrier values, all evaluated first, in source order (every argument
  is evaluated before a static's step 1). `emitObjectRuntimeCall` is the one
  helper call the table and propertyHelper's stored aliases both make.
  `src/ir/from-ast.ts` holds one hook (`tryLowerObjectStaticCall`); a call the
  plan refuses reaching it is an `IrInvariantError`. Every operand crosses
  through one `lowerCarrierOperand`, which the stored aliases, the dynamic
  delete key and #7335's own-property call share.
- **A static's result is the carrier wherever it is used.** The selector's
  operand-family helper (`binaryOperandFamily`, through
  `isDynamicCarrierValue`) and from-ast's (`expressionProducesDynamic`) both
  read the plan, so `+`, the equalities and a script `var`'s initialiser see
  the carrier the call answers. A carrier compared loosely with `null` /
  `undefined` is refused at select (from-ast folds only the strict compare),
  as is a carrier stored into a script `var` whose global is not the carrier.
- `src/ir/object-create-call.ts` stays: it is the JS environment's #7276
  `Object.create({}, { <literal data descriptors> })`, unchanged in output,
  called beside the table hook on both sides and off the table's lane only.
- Folded in: the two `Object` rows of `STORED_STATICS`
  (`uncurried-object-alias.ts`) read the table's arity and helper; #7128 /
  #7335's U1 define is any table call that only defines literal keys with
  literal descriptors (`isOpenCarrierDefine`, `openCarrierDefinePlan` and
  from-ast's define arm are gone).
- The move-only scan's three copies of the "every argument is a carrier or a
  boxable concrete" loop are one `scanCarrierArguments` call each.
- Size: `object-statics.ts` 191 lines, `object-create-call.ts` 180 → 110.
  `select.ts` +79, `from-ast.ts` +23 and `integration.ts` +3 net: granted
  above, for the PR review's B1/B2 fixes.

### Differences from the plan

1. **Literal maps are applied key by key** through `__obj_define_from_desc`,
   not through `__defineProperties`. A map's values may be any carrier
   values: they are evaluated with the other arguments, before the first
   define, which is the spec's order. `__defineProperties` comes with S3's
   dynamic maps.
2. **The first value is tested only where the helper does not test it.**
   `__getOwnPropertyDescriptor` throws for `undefined` / `null` itself, so its
   row has no test. `__getOwnPropertyNames` answers a nullish value, so its
   row tests ToObject; `__obj_define_from_desc` and `__object_create` take any
   first value, and a define on an empty map calls no helper, so
   `defineProperty`, `defineProperties` and `create` test for an Object. A
   fresh `{}` is never tested. Legacy throws only for an operand the checker
   types as primitive, so `Object.defineProperty(o, …)` on a script `var`
   that is still `undefined` is silently applied by legacy and throws in the
   IR, as the spec says. The stored alias `__getOwnPropertyNames(null)` keeps
   legacy's answer (no throw): the alias lowering is the JS environment's too,
   and adding the test there would move its bytes.
3. **The lane is a new capability, `native-object-statics`**: host-free,
   non-fast standalone. A JS environment under the native-first policy
   projects exactly like standalone, so no existing capability could keep the
   table off it; `IrBackendTargetProfile` carries `nativeRegimeInJs` for this
   one question. It is retired when the JS environment adopts the table and
   `object-create-call.ts` folds into it.
4. **`Object.create`'s prototype is `{}`, a primitive literal or `undefined`
   only** (the last two throw). `__object_create` reads a null prototype as
   `%Object.prototype%`, and no carrier is known to be non-null. A prototype
   held in a variable is refused as `proto` until a slice adds the null arm.
5. **Trust is lever O's `objectStaticsPristine` fact** plus "no dynamic code
   may run", not the `sourceWritesMemberNamed` / `sourceNamesReflectiveRoute`
   pair the plan named. It is the same question lever O already answers for
   the integrity statics, so there is one scan. It is stricter than the plan:
   any bare `Object` in the source refuses (137 files in the set). It also
   costs one shape main lowered: a script `function Object() {}` beside
   `Object.defineProperty(o, …)` on an open carrier was IR on main and is now
   refused as `untrusted`.
6. **#7335's `isServedUse` was not widened.** A table call's operand is still
   not a served use, so `o.hasOwnProperty(k)` stays refused beside it. That
   belongs with the own-property follow-on below.
7. **Selector gaps the table exposes are refused, not claimed:**
   - a member store into a dynamic module binding from a nested closure,
     which `dyn.member_set` cannot lower without its writer's strictness
     (`moduleExternPropertyWriteIsProven`);
   - a dynamic module home initialised with a non-empty object literal
     (`vardecl-module-value-flow`);
   - a carrier stored into a script `var` whose global is not the carrier,
     including a member read on a dynamic home (`var r = o.p`, which failed
     after the claim on main too);
   - a reassigned parameter as a static's value (`n = n + 1;
     Object.defineProperty(n, …)`): from-ast cannot prove that `+`, with or
     without the static (the same gap fails `function f(n) { n = n + 1;
     return n; }` on main), so the static refuses the operand
     (`expr-object-static-operand`) rather than claim the function.
8. **`__object_create` is registered through the object-runtime provider
   table** (`stored-static-alias-providers.ts`, `objectRuntimeProviderImport`):
   a module whose only object-runtime call is `Object.create(undefined)`
   otherwise had no provider for it.

### Review probes (PR #7212)

The reviewer's 153 probe programs (8 case files): 0 post-claim errors caused
by this change. Two remain, both failing identically on main and neither
touching a table call: `function f(n) { n = n + 1; return n; }` (the `+`
proof gap above) and a stored `__getOwnPropertyNames` alias inside a
function (a function-type parity mismatch in the alias path).

### What blocks the touched files now

As measured on 2026-11-11, before the review fixes (one more file is IR-only
since). Of the 2,600, 2,562 were not IR-only. By file count (`sole` = the only
reason left):

| files | sole | reason |
|---|---|---|
| 1,290 | 64 | `expr-object-static-descriptor`: 717 an accessor in `defineProperty`, 118 an accessor in a map, the rest a descriptor or map that is not an inline data literal |
| 730 | 0 | `expr-ident-not-in-scope(Function)`, with the propertyHelper include |
| 721 | 0 | `harness:propertyHelper.js` |
| 658 | 43 | `expr-module-scalar-method(.hasOwnProperty)` |
| 561 | 3 | `vardecl-let-closure` |
| 345 | 1 | `expr-object-static-operand`: a target or value that is no carrier (an array, a function, a struct-typed object) |
| 333 | 89 | `expr-ident-not-in-scope(Object)`: `Object.prototype` 127, `preventExtensions` 76, bare `Object` 55, `isExtensible` 51, `freeze` 44, `getPrototypeOf` 40, `isFrozen` 40 |
| 301 | 0 | `vardecl-module-storage-unrepresentable[empty-array]` |
| 219 | 0 | `expr-new-module-binding-callee` |
| 200 | 30 | `forin-receiver-not-dynamic-externref` |

## Trust boundary

A row is admitted only when the call provably reaches the realm's own static.
`objectStaticCallPlan` takes the same facts object lever O's
`objectIntegrityCallFold` takes and refuses (`-untrusted`) otherwise:

- **Shadowed or reassigned `Object`**: the callee's `Object` is the ambient
  binding (`selectorSeesAmbientBinding`) and not in local scope, and the
  source never writes a binding or member named `Object`
  (`sourceWritesMemberNamed(file, "Object")`).
- **Patched static**: no store, delete or define of a member named like the
  row's static (`sourceWritesMemberNamed(file, "defineProperty")` and so on),
  which also covers `Object["defineProperty"] = f`.
- **Reflective routes**: `sourceNamesReflectiveRoute(file)` (its
  `REFLECTIVE_NAMES`, or a `with` statement) refuses, as it does for #7335.
- **Dynamic code**: `sourceRunsDynamicCode(file)` or
  `runtimeEvalMayExecute !== false` refuses, since `eval` or `Function` can
  replace the static under a spelling no scan sees.
- **Cost of the screens, measured on the test bodies**: none of the 59
  gained files names `eval`, `Function`, `Reflect`, `__proto__`,
  `constructor`, `getPrototypeOf`, `setPrototypeOf` or `with`. The screens
  read the assembled source, harness included, so S1 must confirm the same on
  the assembled files before relying on the 14. A harness include that names
  `Function` (propertyHelper does) refuses every file that includes it; those
  files are blocked by the harness units anyway.
- **Proxy targets** need no rule: the helpers carry their own proxy front
  guards and the IR calls the same helpers legacy does.

**JS-environment output stays byte-identical.** Every row is gated on a
standalone backend capability (`native-own-property-introspection` for the
read, the existing `host-object-define-property === false` test for the
defines, `native-dynamic-member-read` for results that are fresh open
objects). On a lane without them the plan refuses and the existing arms run
unchanged. No new host import is added on any lane.

## Not covered

- `x.hasOwnProperty(k)` / `x.propertyIsEnumerable(k)` on a binding outside
  #7335's dynamic-home proof, including on a table result
  (`desc.hasOwnProperty("value")`). Measured follow-on: +34 files on top of
  the 59. It belongs to #7335's `dyn.own_property` arm.
- The propertyHelper harness (`verifyProperty` and siblings): 673 files.
- Closures in script vars, array and object-literal module storage, `for-in`
  receivers, `new` on a script var, `delete`: their own levers, listed under
  Measurements.
- `Object.prototype` as a value (124 files), bare `Object` (66), `new
  Object()`.
- Struct-typed descriptors (a descriptor the IR types as a closed object
  literal). Refused at selection; no file in the 59 needs it.
- `Object.create(null)`: the IR's existing separate contract.
