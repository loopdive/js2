---
id: 7574
title: "Prepared path: `Object` as a realm value (the constructor, `Object.prototype`, `Object(v)` / `new Object(v)`)"
status: done
completed: 2026-11-27
sprint: current
created: 2026-11-27
updated: 2026-11-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: [7561]
related: [7561, 7352, 7557, 7560, 7354, 7350, 7575]
---

# #7574 — `Object` as a realm value on the Prepared path

## Problem

On the Prepared path (`TEST262_COMPILER_PATH=ir`, standalone) `Object` is only a call-form receiver: four statics
(`create`, `defineProperties`, `defineProperty`, `getOwnPropertyDescriptor`) lower as static calls, and
`Object.prototype.toString.call(v)` is intercepted. Every other use of the name refuses. `harness/propertyHelper.js`
(about 900 ES5 tests) reads `Object.defineProperty`, `Object.getOwnPropertyDescriptor`, `Object.getOwnPropertyNames`,
`Object.prototype.hasOwnProperty` and `Object.prototype.propertyIsEnumerable` as values in its first eight lines.
The other lane's two test262 witnesses, `S15.5.4.15_A3_T6` and `S15.5.4.13_A3_T2`, stop at `o.toString()` on
`new Object()`.

This issue is item 2 of #7561's plan ("`Object` as a realm value"), re-planned on the #7561 head with measurements.

## Measured (2026-11-27, `origin/claude/7561-wrappers` `10273019db`)

Strict Prepared entry, the runner's options, each program beside a function expression, node's answer from a fresh
realm. One program per construct at module level; the same constructs inside a function declaration give the same
refusal as that function's abort body.

| # | construct | today | text of the refusal |
| --- | --- | --- | --- |
| 1 | `typeof Object` | refused | `identifier "Object" is not in scope` |
| 2 | `var O = Object; typeof O` | refused | same |
| 3 | `new Object()` | refused | `unknown class "Object"` |
| 4 | `new Object(1)` | refused | same |
| 5 | `Object(1)`, `Object("a")`, `Object(null)`, `Object(o) === o` | refused | `direct call to "Object" has no exact AST-site plan` |
| 6 | `({}).constructor === Object` | refused | `identifier "Object" is not in scope` |
| 7 | `var c = ({}).constructor; typeof c` | aborts | (run-time abort: the realm's Object.prototype holds no `constructor`) |
| 8 | `var p = Object.prototype` | refused | `identifier "Object" is not in scope` |
| 9 | `Object.prototype.toString.call(x)` for `{}`, `1`, `"a"`, `true`, `undefined`, `null`, a function, `new Number(1)`, `new String("a")` | agrees | |
| 10 | `new Object().toString()` | refused | `unknown class "Object"` |
| 11 | `({}).toString()` | refused | `method call .toString(...) on externref not in slice 4` |
| 12 | `var o = {}; o.toString()` | aborts | |
| 13 | `var o = {}; o.valueOf() === o` | aborts | |
| 14 | `"" + {}` | agrees | |
| 15 | `String({})` | refused | `String() of externref operand is deferred` |
| 16 | `o instanceof Object` | refused | `instanceof RHS class "Object" has no projected shape` |
| 17 | `var d = Object.defineProperty`, `Object.keys`, `Object.getOwnPropertyNames` as values | refused | `identifier "Object" is not in scope` |
| 18 | `Object.getOwnPropertyNames({a: 1})`, `Object.keys({a: 1})`, `Object.getPrototypeOf({})` called | refused | same |
| 19 | `Object.prototype.hasOwnProperty.call({a: 1}, "a")`, `…propertyIsEnumerable.call(…)` | refused | same |
| 20 | `Object.foo = 1; Object.foo` | refused | same |
| 21 | `Object.prototype.x = 5; ({}).x` | refused | same |
| 22 | `Object.defineProperty(o, "a", {value: 1})` then `getOwnPropertyDescriptor` | agrees | |
| 23 | `o.hasOwnProperty("a")`, `p.isPrototypeOf(o)`, `typeof ({}).hasOwnProperty` | agrees | |
| 24 | `var h = o.hasOwnProperty; h.call(o, "a")` | aborts | |

No row is a wrong value. 36 programs were compiled; nothing was invalid Wasm and nothing threw out of `compile()`.

### Where `propertyHelper.js` stops

12 of 12 sampled ES5 tests that include `propertyHelper.js` (every 83rd of 829 under `built-ins/Object/define*`,
`Object/create`, `Function/prototype`, `Error`, `Number`, `JSON`, `Array/prototype/indexOf`, `String/prototype/trim`,
`language/statements/function`) stop at the same place: `identifier "Array" is not in scope in <module-init>`,
which is line 27. Each capture line, compiled alone:

| line | source | first stop today | lifted by |
| --- | --- | --- | --- |
| 27 | `var __isArray = Array.isArray;` | `"Array" is not in scope` | #7352 |
| 28–30 | `Object.defineProperty` / `getOwnPropertyDescriptor` / `getOwnPropertyNames` as values | `"Object" is not in scope` | this issue, then slice 2 |
| 31–32 | `Function.prototype.call.bind(Array.prototype.join / push)` | `"Function" is not in scope` | #7557, #7560, #7352 |
| 33–34 | `Function.prototype.call.bind(Object.prototype.hasOwnProperty / propertyIsEnumerable)` | `"Function" is not in scope` | #7557, #7560, this issue |
| 35 | `Math.pow(2, 32) - 1` | `math.pow needs callable provider materialization` | the Math lane |

With lines 27–35 replaced by stubs and `assert.js` + `sta.js` in front, the program compiles. Its abort bodies (a
function that fails to lower aborts when called) name the work after module-init:

| function | refusal |
| --- | --- |
| `verifyProperty` | `empty array 'failures' escapes before its element type is closed` (line 93, `[]`) |
| `isWritable`, `isConfigurable` | `delete has no IR lowering` |
| `isEnumerable` | `dynamic for-in runtime is unavailable` |
| `verifyNotWritable` | `dyn.publish_argc has no Prepared intrinsic` (`arguments.length`) |
| `verifyCallableProperty`, `verifyEqualTo`, `compareArray` | `dyn.member_get with a computed key` |
| `verifyAccessorProperty`, `verifyPrimordialAccessorProperty` | `ternary branches have different types` |
| `formatIdentityFreeValue` (`assert.js`) | `identifier "JSON" is not in scope` |
| `compareArray.format` (`assert.js`) | `identifier "Array" is not in scope` |

## Where `Object` goes in main's model

### The row

`Object` is a third family of `REALM_CONSTRUCTORS` in `src/ir/program/builtin-prototype-keys.ts`:
`constructors("object", ["Object"])`, with `RealmFamilyNames` gaining `object: "Object"`. The front end's routes are
keyed on `realmConstructorId` already (`realmIntrinsicRead`, the callee and `new` paths of
`function-object-lowering.ts`, the `instanceof` right side), so rows 1–6, 8, 10 and 16 stop refusing in the front end
without a line in `src/ir/from-ast.ts`. The implementer's first step is to confirm this by adding the row alone and
re-running the table.

In the catalog `%Object%` already exists as a complete row (23 statics) that no realm exposes. It becomes an
**identity row** in the sense of #7350 B3a: `identityOnly: ["length", "name", "prototype"]` and `heldWith: "%Object%"`.
"Identity row" means: the realm holds the function object, its identity and the listed own properties; `modelledRow`
drops the rest; the kernel marks the object (`BUILTIN_IDENTITY_ONLY_FLAG`) so a query that misses the listed
properties is unknown and aborts instead of answering "absent". `%Object%` and `%Object.prototype%` are appended to
`NATIVE_VALUE_INTRINSICS` (positional, so appended).

### `Object.prototype` is the root the realm already has

The realm allocates one root prototype today (`globals.objectPrototype` in
`native-builtin-functions.ts`); every ordinary object, family prototype and function prototype chain ends there.
`js.object.intrinsic` gains one arm for `%Object.prototype%` that reads that global after the realm's initializer.
No object is allocated for the catalog row, and `familyObjects` must keep skipping it. Two links are seeded where the
realm holds `%Object%`: the root's `constructor` (the catalog's `reference("constructor", "%Object%")`) and
`%Object%`'s `prototype` (`{!w, !e, !c}`, the root).

The root's members follow #7561's holding rule, not a new one: `pinnedWrapperMembers` in
`native-realm-requirements.ts` generalises to the prototypes of every family that pins per member (a list of
`{constructor, prototype}` pairs: the three wrappers and `Object`). So where a program can obtain `Object.prototype`,
the realm holds each member a constant key names and every member where a key may be computed. A member not held is
then one no key of the program reaches, and no own-property query can answer "absent" for a catalog key. This makes
the root complete for the program instead of marking it partial.

### The premise that goes, and the fact that replaces it

Three places assume no program can change `Object.prototype` (#7354 M1, C1):

1. `BUILTIN_REACHABLE_KEYS.object` and `UNPOPULATED_OBJECT_PROTOTYPE_KEYS`: a read of `toString`, `valueOf`,
   `constructor`, `toLocaleString`, `__proto__` or a legacy accessor helper that misses the own chain aborts.
2. The primitive arm of a member read: a key outside the wrapper prototype's list answers `undefined` statically.
3. The front end's interception of `Object.prototype.toString.call(v)` as `dyn.object_tag`, and
   OrdinaryToPrimitive's static "[object Object]" for an object without a `toString` on its own chain.

The fact that replaces the premise is the source's, as in #7561 decision 2: `ProgramObjects.realmFamilies` has
`"object"` when the program reads the pristine `Object` in any form but the two the front end folds, which reach no
object: the receiver of a native static's call (`Object.defineProperty(…)`, `nativeObjectStaticCall`) and the
intercepted `Object.prototype.toString.call(v)`. `constructorRead` in `src/ir/source-plain-objects.ts` gains those two
exclusions beside `realmConstantRead`. Where the fact is false nothing changes, bytes included. Where it is true:

1. An object's or function's read of an Object.prototype key is the realm's [[Get]] (the `has ? get : abort` guard
   stays only for keys the realm does not hold for this program, which the pin rule makes empty).
2. A primitive's read goes through its wrapper prototype where `ProgramObjects.wrappers` has the kind, else through
   `%Object.prototype%` with the primitive as receiver (W2's `obtainsPrototypes` rule, expressed with `holdsFamily`).
   A primitive's write stays #7561's rule (abort where the key is on the chain).
3. `dyn.object_tag` and OrdinaryToPrimitive read `toString` / `valueOf` through the realm and answer by identity
   (below).

### `toString`, `valueOf`, `toLocaleString`

`NATIVE_MEMBERS["Object.prototype"]` gains the three. Their ids are appended to `NATIVE_VALUE_INTRINSICS`, so
`METHOD_IDS` in `native-realm-requirements.ts` stops being a prefix slice and becomes the list of P1's three ids.
They are rows of the one method-by-identity table (`src/ir/program/dynamic-builtin-methods.ts`), tested after the
Error and wrapper rows:

- `%Object.prototype.toString%`: the tag chain of `dynamic-object-tag.ts` (§20.1.3.6), called with the receiver.
  `dyn.object_tag` itself becomes "read `toString` off the root; if it is the built-in, the tag chain; else the
  run-time abort" where the family is held. The abort arm becomes a call when #7557's caller exists.
- `%Object.prototype.valueOf%`: ToObject(this) (§20.1.3.7): an object or function itself, a primitive its wrapper,
  `undefined` / `null` a TypeError.
- `%Object.prototype.toLocaleString%`: Invoke(this, "toString") (§20.1.3.5), through P1's method call.

`objectAbsentToString` in `ordinary-to-primitive.ts` stays for programs that do not hold the family.

### `Object(v)` and `new Object(v)`

One new module, `src/ir/program/dynamic-object-constructors.ts`, beside `dynamic-error-constructors.ts` and
`dynamic-wrapper-constructors.ts`, dispatched from the same place by `ctor.family`. §20.1.1.1 with NewTarget
undefined or %Object%: a kind chain over the first argument.

- absent, `undefined`, `null`: OrdinaryObjectCreate(%Object.prototype%), the allocation an empty object literal uses;
- an object or a function: the value itself;
- a string, number or boolean: `js.object.create-wrapper(value, selector)` with the selector from
  `WRAPPER_OF_PRIMITIVE` and `realmConstructorId`. No conversion runs (`WRAPPER_CONVERSIONS` is for `X(v)`); no
  second wrapper path exists.
- a symbol or bigint: the run-time abort.

The arms follow `kindsOf` of the operand, so `Object(1)` emits one arm. Each `create-wrapper` use makes
`pinnedWrapperMembers` hold that wrapper prototype. For the source fact, `programObjects` adds to `wrappers` every
kind a call or `new` of pristine `Object` with an argument may wrap (all three when the argument is not a literal),
so a primitive of that kind reads through the prototype the program can now obtain (`Object(1).constructor.prototype`
is out of reach until statics are complete, but `Object.getPrototypeOf` will reach it; the fact is set now so it
cannot be forgotten).

### #7575 (the other lane) is taken as given

#7575 is a small change on main from the other lane, not readable from here (local only when this plan was
written). By its description: the existing source walk records zero-argument `new Object()` sites where `Object` is
the pristine realm binding, and lowers them through the ordinary literal allocator, so `new Object()` is `{}`. It
leaves Object.prototype's methods, global-object properties and constructors with arguments to this issue, and keeps
its site rule in one named predicate.

This issue does not add a second path beside it:

- The zero-argument site stays #7575's lowering (the literal allocator). It is the "absent" arm of §20.1.1.1 and
  needs no realm value, so such a program keeps its bytes.
- #7575's predicate is the third fold exclusion of `constructorRead` (beside the native static's call and the
  intercepted tag): a `new Object()` site alone does not make the program hold the `object` family.
- `new Object(v)`, `Object(v)`, `Object()` and `Object` as a value are the realm value's
  (`dynamic-object-constructors.ts`). If #7575's predicate also has to answer "is this `new Object` handled", it is
  widened by one clause there (arguments present → the realm's construct), not copied.

What #7575 keeps refusing or aborting and this issue must make answer (each a row of criterion 1):

| program | #7575 | this issue |
| --- | --- | --- |
| `new Object().constructor === Object` | refuses (`Object` is no value) | true |
| `new Object() instanceof Object` | refuses | true |
| `var o = new Object(); o.toString()` (`S15.5.4.15_A3_T6`, `S15.5.4.13_A3_T2`) | aborts | "[object Object]" |
| `new Object().valueOf()`, `new Object().hasOwnProperty("a")` on the literal operand | refuses or aborts | agrees |
| `new Object(1)`, `Object()` | refuses | agrees |

`o.toString()` on a `new Object()` site in a program that does not otherwise name `Object` is the one case where the
fact above is false and the read still has to answer. Rule: a constant-key read of `toString`, `valueOf` or
`toLocaleString` off an object is answered by the identity row where the family is held, and where it is not held
the miss on the own chain answers the built-in's algorithm statically (the tag chain, the object itself), exactly as
OrdinaryToPrimitive's `objectAbsentToString` does today for `"" + {}`. That is sound under the same premise (no
program without the fact can change the root) and it is one function shared with OrdinaryToPrimitive, not a copy.
It lifts measured rows 11–13 for every program, so those programs' bytes change from an abort to an answer; this is
the one stated exception to criterion 5.

To verify once #7575's PR exists:

1. The name and module of its predicate, and that `constructorRead` can call it (no import cycle, no IR to runtime
   edge).
2. That it tests the pristine binding with `isPristineGlobal`, the same predicate `constructorRead` uses, so the
   two cannot disagree on a shadowed or written `Object`.
3. Whether its lowering yields a dynamic value or a raw externref for a function-local `var o = new Object()` (A1a
   review r1 found a raw externref breaks for-of and `+`); the rows above are run for a script var, a function local
   and the literal operand.
4. That `new Object` with a spread argument, and `new Object` without parentheses, fall on the documented side.
5. That its tests' refusal rows for `Object` as a value are moved, not deleted, when this issue makes them answer.

### `instanceof Object`, `isPrototypeOf`

OrdinaryHasInstance reads `Object.prototype`, which is read only and non-configurable, so it is the root. The answer
is the existing chain walk with the root as the prototype: `true` for every object whose chain reaches it (functions
through `functionChainAnswer`, errors, wrappers), `false` for a primitive and for a `null`-prototype object.

### Statics, and what must keep refusing

`%Object%` is an identity row in this issue. The call form of the four native statics keeps folding. That is sound
only while no program can replace a static and still reach the fold, so these must hold, each with a test row:

| program | answer required | why it holds |
| --- | --- | --- |
| `Object.keys = f; Object.keys(o)` and `Object.defineProperty = f; …` (statement form) | refuses by name | TypeScript's expando merge makes `Object` not pristine (#7350 slice 1 notes); every read of it refuses |
| `Object["defineProperty"] = f`, `Object[k] = f` | refuses or aborts | a write to a key the identity row lacks aborts in the kernel (the identity mark) |
| `var O = Object; O.defineProperty = f; Object.defineProperty(o, "a", d)` | aborts at the write | the identity mark |
| `function w(x) { x.defineProperty = f; } w(Object); Object.defineProperty(…)` | aborts at the write | the identity mark |
| `Object.defineProperty(Object, "keys", {value: f})` | refuses by name | `identityOnlyTargetRefusal`; a computed key aborts in the kernel |
| `delete Object.defineProperty` and `delete O[k]` | refuses or aborts | must be checked against the other lane's OrdinaryDelete for built-in function objects: a delete on an identity-only object with a key outside its list aborts |
| `Object.keys`, `Object.getOwnPropertyNames`, `var d = Object.defineProperty` read as values | refuses by name | `identityOnlyKeyRefusal` (`Object.keys is not reachable on this path yet`) |
| `var O = Object; O[k]` | aborts | the identity mark |
| `Object.keys(o)`, `Object.getPrototypeOf(o)` and every other non-native static's call | refuses by name | the same refusal: the callee read misses the identity row |

So after this issue lines 28–30 of `propertyHelper.js` refuse by name with `Object.defineProperty is not reachable
on this path yet` instead of `identifier "Object" is not in scope`. Slice 2 lifts them.

## Slices

| # | issue | content | changed source lines (estimate) |
| --- | --- | --- | --- |
| 1 | **#7574** | the identity row, `Object.prototype` as the root, `Object(v)` / `new Object(v)`, `toString` / `valueOf` / `toLocaleString` by identity, `instanceof Object`, the source fact | about 650 |
| 2 | new id | `Object` statics as values: #7350's escape rule, per-member static rows, the call form by identity where `Object` escapes | about 450 |
| 3 | new id (listed in #7352's order) | `Object.getOwnPropertyNames` and `keys` as natives returning a realm array | about 300 |

Two more ids for this plan (slices 2 and 3). Slice 3 needs arrays (#7352) and is ordered there.

### Slice 1 (#7574): modules

| layer | module | change | reuses | lines |
| --- | --- | --- | --- | --- |
| contract | `src/runtime/contracts/native-realm-catalog.ts` | `%Object%` identity row; three native members; five ids appended | `callable`, `members`, `modelledRow` | 40 |
| IR keys | `src/ir/program/builtin-prototype-keys.ts` | the `object` family row; `UNPOPULATED_OBJECT_PROTOTYPE_KEYS` reads the three new natives as populated | `constructors` | 25 |
| source walk | `src/ir/source-plain-objects.ts` | the two fold exclusions; `wrappers` from `Object(v)` | `nativeObjectStaticCall`, `realmConstantRead` | 45 |
| IR construction | `src/ir/program/dynamic-object-constructors.ts` (new) | the kind chain | `create-wrapper`, `WRAPPER_OF_PRIMITIVE`, the literal's allocation | 80 |
| IR methods | `dynamic-builtin-methods.ts`, `dynamic-prototype-methods.ts`, `ordinary-to-primitive.ts` | three rows of the identity table | `identityTest`, `builtinMethodChain`, `conversionMethodTests` | 110 |
| IR tag | `dynamic-object-tag.ts` | the identity guard where the family is held | `identityTest` | 30 |
| IR member access | `dynamic-member-access.ts` | the three premise changes; `prototype` of `%Object%` | `heldPrototype`, `holdsFamily` | 80 |
| IR chains | `dynamic-function-operations.ts`, `dynamic-value-chains.ts` | `instanceof Object` with the root | `functionChainAnswer` | 40 |
| IR holds | `native-realm-requirements.ts` | the `object` row of `HELD_FAMILIES`; `pinnedWrapperMembers` over a pair list; `METHOD_IDS` as a list | the pin rule | 60 |
| backend | `native-source-objects.ts`, `native-realm.ts`, `realm-family-bodies.ts` | the intrinsic arm for the root; the two seeded links | `nativeBuiltinFunctionOperands`, `familyProperties` | 90 |
| tests | `tests/issue-7574-object-value.test.ts` | below | `tests/helpers/prepared-node-agreement.ts` | 260 |

Duplicates removed in this slice: `METHOD_IDS` as a positional slice (one id list instead); the wrapper-only pin
function (one pin function over pairs); the static "[object Object]" answer where the family is held (the identity
row answers). `tests/issue-7354-m-prototype-premise.test.ts` loses the rows that become obtainable and keeps the
rest.

### Slice 2 (new id): `Object` statics as values

- `module-bindings.ts`: #7350's escape rule beside `boundOrWrittenNames` (`foldableMembers(identifier)`): a fold of a
  writable member of `X` applies only where every occurrence of `X` is a callee, the object of a static member read
  or method call, a `typeof` operand or the right side of `instanceof`. The expando fix (#7350 slice 1, part 1) ships
  with it.
- Catalog: each native static becomes a row the realm can hold one by one (`heldWith` itself) and is added to
  `%Object%`'s `identityOnly` list as it becomes native. The row stays an identity row until all 23 are held or
  refused by name.
- IR: where `Object` escapes, `Object.defineProperty(o, k, d)` is a [[Get]] of the static, an identity test, and the
  existing algorithm of `dynamic-object-statics.ts` behind it (the call-site adapter #7557 plans as `BuiltinCall`);
  any other value is the dispatcher's call. Where `Object` does not escape the fold stays, so those programs keep
  their bytes.
- A held static called through a value (`__defineProperty(obj, name, desc)`) is the run-time abort until #7557's
  caller has the rung. Slice 2 can therefore land before or after #7557; the rung is added by whichever lands second.
- Acceptance: `var d = Object.defineProperty; typeof d`; `Object.defineProperty === Object.defineProperty`;
  `var O = Object; O.defineProperty = f; Object.defineProperty(o, "a", {})` calls `f`; the same through a parameter,
  `Object["defineProperty"] = f`, and `Object.defineProperty(Object, "defineProperty", {value: f})`; a program where
  `Object` does not escape has unchanged Prepared bytes.

## Acceptance criteria (slice 1)

Correctness:

1. These programs agree with node on the Prepared path at module level and inside a function, each also asserted
   with a wrong answer that must fail (`agreesWithNode`, fresh realm): rows 1–8, 10–13, 15 (where `String(object)`
   lowers), 16 and 21 of the measured table; `Object(o) === o` for an object and a function; `typeof Object(null)`
   and `typeof Object(undefined)`; `Object(1) + 1`, `Object("ab").length`, `Object(true).valueOf()`;
   `new Object(1) instanceof Number`; `Object.prototype === Object.prototype`;
   `Object.prototype.constructor === Object`; `Object.length` and `Object.name`;
   `Object.getOwnPropertyDescriptor(Object, "prototype")`; `Object.prototype.foo = 1; (5).foo` and `"a".foo`;
   `Object.prototype.toString = function () { return "z"; }; String({})` and `"" + {}` answer "z";
   `Object.prototype.valueOf = function () { return 7; }; ({}) * 1` answers 7;
   `var k = "to" + "String"; Object.prototype.hasOwnProperty(k)` true;
   `Object.create(null) instanceof Object` false; `(function () {}) instanceof Object` true;
   `new Object().toString()` and `var o = new Object(); o.toString()` (the other lane's witnesses).
2. Five of them also pass behind the real prelude (`assert.js`, `sta.js`).
3. Every row of "what must keep refusing" refuses by name or aborts, and none answers.
4. Never a wrong value, a trap where JavaScript throws a catchable error, invalid Wasm, or an exception out of
   `compile()`.
5. Ordinary-pipeline output is byte-identical (`prove-emit-identity`). On the Prepared path a program that does not
   name `Object`, or names it only as the receiver of a native static's call, in
   `Object.prototype.toString.call(v)` or as #7575's zero-argument `new Object()`, has byte-identical output
   (`check:prepared-bytes`), except where it reads `toString` / `valueOf` / `toLocaleString` off an object, which
   aborted before (the #7575 section).
6. `src/ir/from-ast.ts` does not grow. No new IR to runtime import edge (the budget is 10): catalog reads go through
   `builtin-prototype-keys.ts`. No `loc-budget-allow` or `func-budget-allow`.
7. The prelude's size and compile time (`assert.js` + `sta.js` + one assertion) are reported before and after; the
   prelude names `Object` only in the intercepted form, so both must be unchanged.

Code quality (CLAUDE.md, "IR path: code quality comes first"):

8. `Object` is a row of `REALM_CONSTRUCTORS` and of `HELD_FAMILIES`. No `=== "Object"` test outside the catalog,
   `builtin-prototype-keys.ts` and the fold predicate that exists today.
9. One root: no second allocation or global for `%Object.prototype%`.
10. One pin rule for the wrapper prototypes and the root; one method-by-identity table for P1's call,
    OrdinaryToPrimitive and the tag.
11. `Object(primitive)` calls `js.object.create-wrapper`; no second wrapper allocation.
12. The new module is classified in `scripts/compiler-boundaries.json` in the same commit.
13. A fresh-context adversarial review, given the diff and this plan, with its verdict in the PR body.

## Open questions for the owner

1. **The escape rule.** #7350 plans it as its own PR in the #7350 lane. Slice 2 needs it. Does this lane build it
   under slice 2's id, or wait for #7350's?
2. **Partial objects: pin rule or `js.object.is-partial`?** #7561's model holds every member a key can reach, so a
   held prototype is never partial. The other lane adopted `js.object.is-partial` (from the old A1b branch) for `in`.
   This plan uses the pin rule for the root. Two mechanisms for one question should not both stay. Cost of the pin
   rule: a program with one computed own-property key holds all 12 members of the root, and all members of every
   other prototype it can obtain; the first array PR measures that on the prelude.
3. **`delete` on an identity-only built-in.** The other lane builds OrdinaryDelete for built-in function objects.
   The identity mark must abort a delete of a key outside the row's list. Who adds that test row?
4. `Object.prototype`'s `__proto__` accessor and the four legacy helpers become held function objects whose call
   aborts. Accepted, or refuse those keys by name where they are constant?

## Not verified

- The front end needing no change for rows 1–6, 8, 10, 16 is read from the code (`realmConstructorId` call sites),
  not run.
- The size estimates.
- That TypeScript's expando merge covers `Object["k"] = v` (the table lists "refuses or aborts" for that reason).

## Result (2026-11-27, branch `claude/7574-object-value`, base `claude/7352-arrays-a` `a851be4a78`)

**Built** (`src/`: about +450 / −130):

- Catalog: `%Object%` an identity row (`length`, `name`, `prototype`), held with itself; `toString`, `valueOf`,
  `toLocaleString` native and held one by one (`NATIVE_OBJECT_PROTOTYPE_CONVERSIONS`); `%Object%`,
  `%Object.prototype%` and the three appended to `NATIVE_VALUE_INTRINSICS`. `METHOD_IDS` is P1's id list.
- Holding: an `object` row of `REALM_CONSTRUCTORS` and of `HELD_FAMILIES`; the root is one more `PinnedPrototype` of
  the one pin function (obtained wherever `%Object%` is read). The backend's `familyObjects` also yields the root's
  properties whose value is a held family member (`constructor`, the held methods), seeded on the kernel's
  `object-prototype`; `js.object.intrinsic` reads the root through the kernel's `objectPrototype`. No second root.
- IR: `dynamic-object-constructors.ts` (`Object(v)` / `new Object(v)`: `create-default`, the value itself,
  `create-wrapper`); `Object.prototype` reads the realm's root; a primitive reads and writes through the root where the
  program holds the family (`primitiveBase`); Object.prototype's `toString` / `valueOf` are rows of the one
  method-by-identity table, so P1's call, OrdinaryToPrimitive and the object tag share them; `dyn.object_tag` is a call
  of the root's `toString` where the family is held (another method aborts); `functionChainAnswer` answers `true` for
  the root (one identity chain with the `%Error%` abort); an own-property query of the root with a key it lacks
  (`__proto__`, the Annex B helpers, or a computed key) aborts (`unlessUnheldOwnKey`, beside the String-object guard).
- Source fact: `constructorRead` excludes the receivers the front end folds (a native static's call, the object tag,
  whose shape test `objectTagCallReceiver` moved out of `from-ast.ts`); `Object(v)` adds the wrapper kinds it may make.
- Folded: `ObjectStaticBuilders.errors` (dead after `functionChainAnswer` takes the program).

**Refuses or aborts** (`tests/issue-7574-object-value.test.ts`): `Object.keys(o)`, any non-native static and a static
read as a value (#7580); `Object.keys = f` (Object not pristine); a computed key off `Object`; `var O = Object;
O.defineProperty = f` and the same through a parameter abort at the write; the root queried as own with a key it
lacks; the object tag through a written `toString`; `delete Object.defineProperty` (no `delete`). Inside a function,
`Object(o) === o` for a function-local literal aborts (the function-local object operand, as on the base).

Not built: zero-argument `new Object()` stays the realm's `create-default` through `%Object%` (#7575 is not on this
base); `toLocaleString` is held but its call aborts; a computed-key `Object.prototype.hasOwnProperty(k)` aborts
instead of answering.

**Proof** (local node 22, load 2–6 from other agents):

- Probes in a fresh realm, each agreement with a wrong twin: 27 programs, right 16, refused 4, aborted 7, wrong 0,
  invalid 0, exceptions 0 (two wrong answers and one invalid module found on the way were fixed: an own query of the
  root's `__proto__` / Annex B keys answered `false`; the tag answer was not carried into the carrier).
- Harness: the 12 `propertyHelper.js` programs of `built-ins/Object/defineProperty` stopped at line 28 (`"Object" is
  not in scope`); all 12 now first stop at line 31 (`"Function" is not in scope`, #7557). Lines 28–30 refuse by name
  after it (`Object.defineProperty is not reachable on this path yet`, #7580).
- Prelude (`assert.js` + `sta.js` + one assertion): 90,242 → 90,125 B; median of 3 compiles 6.5 → 6.2 s and
  6.7 → 6.5 s (two interleaved sessions).
- Cost: `var O = Object; typeof O` 24,840 B; `Object.prototype.hasOwnProperty.call(o, "x")` 49,329 B against
  46,774 B for `o.hasOwnProperty("x")` (+2.5 KB: `%Object%`, the root's `constructor`; the call itself aborts until
  #7557).
- Bytes: ordinary pipeline 30 programs × 2 targets identical. Prepared: every realm program is 117 B smaller (only the
  global section differs): `%Object%` and the three methods are no longer rows of every realm, so their names and the
  statics' keys are no longer realm literals. 12 programs that name `Object` only as a native static's receiver or in
  the object tag: same outcome, each exactly −117 B.
- test262, own runner, `mw-00` (87 rows): pass 18 → 19 (`S15.2.1.1_A2_T13`), fail 11 → 11, compile error 58 → 57, no
  pass lost.
- `src/ir/from-ast.ts` 17,395 → 17,393. Gates at the merge base: all pass. With `LOC_GATE_BASE=origin/main` the LOC and
  function budgets fail only on files this branch does not touch (`src/codegen/…`): main moving.

Pins moved: `issue-7354-m-prototype-premise` (Object.prototype is obtainable; `Object.getPrototypeOf` refuses by its
static's name), `issue-7354-m-refusals` (G45 refuses by the static's name), `issue-7354-t2` (`typeof Object` agrees).
