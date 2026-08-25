---
id: 4220
title: "Standalone: a transferred `String.prototype.split` throws `not yet implemented` — the ES5 split battery never runs"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string-split, native-prototypes, property-model
goal: es5
related: [2875, 3992, 4207, 1441, 1057, 3133, 3183, 4034, 1474]
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/object-runtime.ts
---

# #4220 — reflective `String.prototype.split` (standalone)

## Symptom

```js
Number.prototype.split = String.prototype.split;
(100111122133144155).split(1, 2);
// TypeError: String.prototype.split is not yet implemented in --target standalone
```

23 ES5 files under `test/built-ins/String/prototype/split/` failed on that
message. The DIRECT form (`"a,b".split(",")`) has been native since #1441; the
battery almost never writes it — it transfers the method onto a Number/Boolean/
Object/Function/Math receiver first, which routes through the `native-proto.ts`
closure factory instead.

## Root causes (two, both required)

1. **No `split` arm in the reflective String glue.** `emitStringProtoMemberBody`
   (`array-object-proto.ts`) wires `charAt` / `substring` / `slice` / the
   search family / the trim+case family; `split` fell through to
   `emitProtoMemberBodyRefusal`, whose whole job is to throw that message.

2. **`<array>.constructor` is `undefined` when the receiver is only known at
   runtime.** Independent of split, and demonstrable on its own:

   ```js
   var a = [1, 2];
   function f(x) { return x.constructor; }
   f(a) === Array;   // false — reads undefined
   ```

   #3133 routes the ARRAY-**typed** spelling to the `__builtin_Array`
   namespace singleton, but that arm is static-type driven. An `any`-typed
   receiver falls to `__extern_get(obj, "constructor")`, whose `$__vec_base`
   arm (#3183) answers only `"length"` and numeric index keys. Since every
   file in the battery asserts `__split.constructor === Array` on a
   necessarily-`any` result, fixing (1) alone flips **zero** of them.

## Fix

- `src/codegen/string-proto-split.ts` (new) — the §22.1.3.23 body over the
  existing pure-WasmGC `__str_split` kernel: RequireObjectCoercible,
  ToString(this), ToUint32(limit), ToString(separator), the `lim = 0` → `[]`
  and undefined-separator → `[S]` early-outs. Limit ToNumber goes through
  `__to_primitive` with the `"number"` hint, which is what makes the spec's
  step-4-before-step-5 ordering observable (`.split(objThrowingToString,
  objThrowingValueOf)` must surface the *valueOf* throw).
- `src/codegen/vec-constructor-carrier.ts` (new) — a demand-minted
  `__vec_ctor_Array()` accessor plus the `__extern_get` `$__vec_base`
  `"constructor"` arm that calls it. The accessor, rather than a bare
  `global.get`, carries the singleton's guarded lazy init, so the read works
  when it is the module's FIRST demand for `Array` — exactly the argument
  order of `assert.sameValue(a.constructor, Array)`. Demand-minted because an
  unconditional pull-in of the `Array` namespace object on the array path is
  the #4034 hazard.

## Result

`test/built-ins/String/prototype/split/` on the standalone lane, same box,
same runner, both arms one tree:

| | pass | fail |
| --- | --- | --- |
| before | 87 | 33 |
| after | **106** | 14 |

**+19 fail→pass, 0 pass→fail** (verified by diffing the two failing-file
lists, not the counts).

## Deliberately out of scope

- **A RegExp separator** (2 files: `argument-is-regexp-and-instance-is-number`,
  `separator-regexp-limit-string-via-eval`). §22.1.3.23 step 2's `@@split`
  dispatch needs a *runtime* regexp; the standalone engine compiles a
  *statically known* pattern at compile time and has no interpreter. The
  reflective body therefore keeps flowing a RegExp separator into
  ToString(separator) — the same documented gap
  `emitStringSearchBooleanMemberBody` carries for its search value.
- **Over-arity transferred calls** (1 file:
  `arguments-are-boolean-expression-function-call-and-null-and-instance-is-boolean`,
  which passes 3 args to the arity-2 `split`). `collectTransferredNativeProtoReceivers`
  skips a closure whose declared param count is `< arity + 1`, so an
  over-arity call misses the receiver-threading arm and falls to the generic
  dispatch. Pre-existing and cross-cutting (it is the #3992 family), not
  split-specific.
- **`instance-is-math` / `instance-is-number-1e21`** — ToString of the `Math`
  namespace object, and `Number.prototype.toString` on a wrapper. Both fail
  outside split's own steps.

## Permanent repro

Pinned by `tests/es5-standalone-split.test.ts` (15 cases: reflective transfer,
limit/separator coercion order, `<array>.constructor` carrier) and the
`test262/test/built-ins/String/prototype/split/` battery (+22 measured flips,
runner-validated on the branch).
