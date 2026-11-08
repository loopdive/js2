---
id: 7276
title: "IR module-init: `Object.create(proto, {descriptor map})` lowered the way legacy does, by compile-time expansion"
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
related: [7275, 7128, 7267, 7189]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  # 2026-11-07 (#7276): the plan and the lowering live in the new
  # src/ir/object-create-call.ts. What remains in the god-files is wiring
  # with no other home:
  #   - select.ts +13: the selector adapter (lane + binding facts) and the
  #     one Phase-1 call arm beside `Object.defineProperty`'s;
  #   - from-ast.ts +24: the resolver capability union, the from-ast adapter,
  #     the arm at `lowerMethodCallWithSourcePlan` (the seam both call entries
  #     share) and `lowerDataDescriptorFields`, which the #7128 open-carrier
  #     define now shares instead of keeping its own copy.
  #   - integration.ts +1 (2026-11-07, review 2): `<module-init>` is told its
  #     code strictness (`functionCodeStrict`), the one option line beside
  #     `moduleInitUnit`; the rule itself lives in `irFunctionCodeStrictness`.
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
func-budget-allow:
  # 2026-11-06 (#7276): one sibling arm in the flat call dispatch, beside
  # `Object.defineProperty`'s; splitting the dispatcher is its own refactor.
  - src/ir/select.ts::isPhase1Expr
  # 2026-11-07 (#7276 review 2): the same one option line, inside the
  # module-init lowering call of `compileIrPathFunctions`.
  - src/ir/integration.ts::compileIrPathFunctions
---

# #7276: `Object.create(proto, {descriptor map})` in the IR

## Problem

#7275 measured 10 stride-40 files whose only legacy unit is `<module-init>`
and whose test body calls `Object.create({}, { <descriptor map> })`. Legacy
expands the descriptor map at compile time, so no runtime provider is needed
(`call-builtin-static.ts`, the `Object.create` arm).

## Measurement (2026-11-06)

**Legacy's expansion** (`call-builtin-static.ts`, the `Object.create` arm, ~L2674–2900) is two compile-time paths. Both start with `__object_create(<proto>)`; on standalone the proto literal is built as a native `$Object` by `compileProtoArg`:

- **Path A.** Taken when every descriptor is statically expandable (`mayStaticallyExpandCreateDescriptor`): one `__defineProperty_value(obj, key, value, flags)` per key, with the flags folded by `staticToBoolean`.
- **Path B.** Taken otherwise: one `__obj_define_from_desc(obj, key, <descriptor $Object>)` per key. This is the native `Object.defineProperty` applier, the same one the #7128 open-carrier define calls.

Neither output can be reused byte for byte from a from-ast arm, because legacy emits Wasm instructions and the IR emits IR. Path B's runtime callables are already IR-callable, though (`irRuntimeFuncRef`): `__new_plain_object`, `__object_create`, `__obj_define_from_desc`. So the IR emits path B, which is legacy's own construction. For a literal data descriptor, A and B compute the same ToPropertyDescriptor.

**The 10 stride-40 files.** I probed each by admitting `Object.create` in the selector (scratch, reverted) and recording the next refusal:

| file (`built-ins/Object/…`) | map shape | next blocker once `Object.create` is admitted |
| --- | --- | --- |
| `create/15.2.3.5-4-154` | `{prop: {value: "…"}}` | none: lowers |
| `create/15.2.3.5-4-229` | `{prop: {writable: "false"}}` | `newObj.hasOwnProperty("prop")` (`expr-module-scalar-method`) |
| `create/15.2.3.5-4-305` | `{prop: {enumerable: true}}` | same |
| `create/15.2.3.5-4-268` | `{prop: {set: function…}}` (accessor: refused) | same |
| `create/15.2.3.5-4-116` | `{prop: descObj}`, `new Number(-9)` | `new Number` before the call |
| `create/15.2.3.5-4-191` | `{prop: fun}` | the function-expression `var` before the call |
| `create/15.2.3.5-4-57` | `{prop: descObj}` | `var proto = {}` storage before the call |
| `create/15.2.3.5-4-94` | `{prop: {enumerable: argObj}}` | the `arguments` IIFE before the call |
| `hasOwn/…_inherited_getter…`, `prototype/hasOwnProperty/8.12.1-1_15` | `Object.create(base)`, no map | `var base = {}` storage before the call |

All 320 `built-ins/Object/create` files under the same scratch admission:

- 46 become fully selector-claimable;
- 10 of those are the all-literal subset: proto `{}`, plus keys whose descriptors carry primitive-literal data fields only;
- the other 36 have accessors, non-literal flags (`enumerable: new Boolean(…)`), non-literal descriptors or non-`{}` protos.

**Expected zero-legacy delta, stated before coding:** +1 at stride 40 (`15.2.3.5-4-154`), and at most +10 in `built-ins/Object/create`.

## Implementation Plan

- **Module.** `src/ir/object-create-call.ts` holds ONE plan, `objectCreateDescriptorMap`, and the lowering:
  - **Admission:**
    - shape: `Object.create({}, <map literal>)`;
    - lane: `native-dynamic-member-read`, standalone only, as for #7267's `JSON.parse`. WASI's IR member read does not answer for an open `$Object`;
    - binding: the lib-only `isUnshadowedLibGlobal`.
  - **Lowering:** `__new_plain_object` → `__object_create` → `emitOpenCarrierDefine` per key → box onto the dynamic carrier.
- **Reuse, and the duplicates it removes.**
  - `literalDataDescriptorFields` is extracted from #7128's `openCarrierDefinePlan`; the open-carrier define now calls it.
  - from-ast's field boxing becomes `lowerDataDescriptorFields`, shared by the #7128 define and this arm.
  - `isUnshadowedLibGlobal` is extracted identically to #7267, so the two PRs merge clean.
- **Wiring.**
  - Selector: one Phase-1 call arm beside `Object.defineProperty`'s. The call's TS type is `any`, so the binding is already dynamic and `dynamicUsesAreMoveOnly` needs no arm (measured: removing the two arms first drafted there changes nothing).
  - from-ast: one arm in `lowerMethodCallWithSourcePlan`, the seam that expression calls and statement calls both enter. The first cut sat in `lowerCall` and was a claim-then-refuse for statement-position calls.
- **Refused, so legacy keeps the call:**
  - a `null` proto: `__object_create` reads null as the `%Object.prototype%` terminal, and the IR has its own `Object.create(null)` contract;
  - a non-empty proto;
  - an accessor, a computed or non-literal flag, a non-literal descriptor;
  - a canonical array-index key: §20.1.2.3.1 defines in [[OwnPropertyKeys]] order, legacy in source order;
  - `__proto__`, which sets the map's prototype;
  - a duplicate key: the literal keeps the last value, while legacy defines twice and throws;
  - a source `Object` binding.
- **Code-quality criterion.**
  - The selector and from-ast read one plan.
  - No second descriptor parser and no second field-boxing loop.
  - No new host imports and no new provider.

## Result (2026-11-06)

- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG; base `origin/main` c0e553e4):
  - compileOk unchanged, invariants 0 = 0, legacy units 4750 → 4749;
  - **zero-legacy files 32 → 33** (`built-ins/Object/create/15.2.3.5-4-154.js`);
  - `15.2.3.5-4-229` and `-305` now refuse later, on `newObj.hasOwnProperty(…)`;
  - no other file changes.
- **`built-ins/Object/create`, all-literal subset.** Zero-legacy: `15.2.3.5-4-{152,154,232}`. The 7 `for-in` files of the subset pass on both sides, but from-ast withdraws them (`module-init unit contains a nested var declaration`). That gap was already on main and is not this arm's. Follow-up: #7288 (PR #7157) refuses a top-level `for (var k in o)` head at selection (`forin-head-module-var`) instead of withdrawing; lowering that head as a module binding is not yet filed.
- **Typed corpus** (playground examples × gc / standalone / WASI, 39 compiles): binaries and host imports byte-identical base vs head, before and after the review fix.
- **test262 A/B**, row by row, base `origin/main` d28280a0. Every status is identical, and no file traps or differs on head where it did not on base:
  - standalone, 1249 paths (`built-ins/Object/create` 320, `built-ins/Object/defineProperties`, 300 seeded-random): 1137 pass / 86 fail / 15 CE / 11 skip on both sides. The only error-text differences are the checkout path inside a missing-QuickJS-provider message;
  - gc, `built-ins/Object/create`: 319 / 1 on both;
  - after the second review (head 43f03fb4, base `origin/main` d28280a0): `language/expressions/in` + `built-ins/Object/create` + the 39 `"<Object.prototype key>" in …` files (359 files), standalone 349 / 9 / 1 and gc 348 / 10 / 1 on both.
- **`in` probe matrix** (second review): 16 receiver kinds × 7 keys, through a dynamic parameter and at module level, on standalone, WASI and gc: head = base on all 112 programs × 3 lanes.
- **Tests:** `tests/issue-7276-object-create-descriptor-map.test.ts` runs 23 cases × 3 lanes plus the review's receivers; the #7128 suite passes too (138 / 138). The cases:
  - the admitted shapes, against JS;
  - non-writable writes in sloppy and strict mode, ToBoolean of the literal flags, `for-in` enumerability, `delete` against configurability, `in`;
  - the refused shapes and the `Object` shadows, against the IR-off compile.

## Adversarial review (fresh context, 2026-11-06)

Verdict before the fixes: one must-fix, the rest should-fix and nits. The reviewer found no claim-then-refuse in any position, and found the refusals and key canonicalisation correct.

1. **Fixed (must-fix); the fix was replaced after the second review, see below.**
   - The finding: `"toString" in o` answered false on the IR route, where legacy and JS answer true. The IR's native `in` arm called `__extern_has`, which stops at an open `$Object`'s implicit `%Object.prototype%` terminal.
   - This was already wrong on main for any dynamic receiver: `function f(o) { return "toString" in o }` took the IR body and threw.
   - First fix (016fd153, withdrawn): a string-literal key on `OBJECT_PROTOTYPE_KEYS` called legacy's fixed-name helper `__extern_has_with_implicit_object_proto` from the native `in`.
2. **Fixed.**
   - The finding: `isUnshadowedLibGlobal`'s comment named a caller that does not use it.
   - The comment now names its real second caller.
   - Main's `ambient-global-function-call.ts` keeps its own `scriptDeclaresName`; #7267 (PR #7118) replaces it with this helper.
3. **Fixed.** The module doc now says legacy folds the flags for literal descriptors (`__defineProperty_value`), and that the IR takes legacy's runtime-applier arm instead.
4. **Fixed.**
   - The finding: the plan said standalone only, while gc also claims.
   - The lane is `native-dynamic-member-read`, which covers standalone and the native-first gc lane (it projects as standalone); this is now stated in the module doc and here.
   - gc output changes only for claimed units. The corpus is byte-identical.
5. **Fixed.** The known divergence (`typeof o.hasOwnProperty`, identical on main) is labelled as such, and `in` cases checked against JS were added.
6. **Fixed.** The admission's capability query is non-optional, symmetric with `isLibOnlyBinding`.
7. **Fixed.** One helper, `staticNamedProperties`, now serves both the descriptor parser and the descriptor-map parser.
8. **Fixed.** The arm sits above the `Object.defineProperty` comment.
9. **Fixed.** The double cast is gone.
10. **Fixed.** The `literalDataDescriptorFields` doc is no longer ambiguous.

## Second review (fresh context, PR comment 6698801419): BLOCKER, fixed in 43f03fb4

- **Finding.** The first fix sent every dynamic receiver to the fixed-name helper. Its last fallback is a constant `1` for any receiver that is not an `$Object` or fnctor. Legacy only calls it for receivers it knows statically to be an `$Object`. So a null-prototype struct (`setPrototypeOf(q, null)`), or a constructor instance whose `prototype` is `Object.create(null)`, answered `true` where main answered `false`. That was 5 standalone and 10 WASI programs.
- **Alternatives measured and rejected:**
  - Refuse such an `in` in the selector. That regresses `"toString" in undefined`: main's IR route throws the TypeError, legacy does not.
  - A new variant of the helper with an exact fallback. That needs a runtime function registered beside legacy's; registered eagerly it changes legacy bytes, and registering it lazily needs the object-runtime internals.
- **Fix.**
  - The native `in` is restored to main's exactly (`native-in.ts`, `integration.ts` and from-ast's `in` arm are unchanged from main).
  - The Object.create plan admits a call only when every `in` of its enclosing unit has a string-literal key `%Object.prototype%` does not own (`unitInKeysAreOwnOnly`). There the native probe and legacy agree on the open `$Object` it creates. Any other unit keeps legacy, as on main.
  - A function elsewhere that receives the object sees the same `$Object` legacy would have created.
- **The pre-existing gap** stays out of this PR: the native `in` misses the implicit `%Object.prototype%` terminal of a non-`$Object` receiver (`"toString" in {x: 1}` through a dynamic parameter answers false). Its own issue was not filed: `claim-issue --allocate` refused (the open-PR scan was degraded), so it is reported to the lead.
- **Measured:**
  - `in` matrix of 112 programs × 3 lanes: head = base;
  - 359 test262 files (standalone, gc): identical;
  - typed corpus byte-identical;
  - vitest 138 / 138;
  - gates green.

## Delta review (6702199382, head 0fa6d6a0): APPROVE with nits

- Nit 1, follow-up (no code change in this PR, it would need another delta):
  `unitInKeysAreOwnOnly` keeps the file's only module-level cache (a
  `WeakMap` keyed by AST node). A per-call scan is simpler unless a profile
  shows the scan.
- Nit 2: recorded in #7304 (the whole-file scan for `<module-init>` is the
  over-refusal to lift once native `in` reaches the terminal).
- Nit 3: the for-in note above now links #7288.

