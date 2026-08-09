---
id: 4193
title: "SUPERSEDED by #4176 / PR #4155 — named properties on builtin prototypes (kept for the independent measurement)"
status: wont-fix
created: 2026-08-06
updated: 2026-08-06
priority: high
task_type: bug
area: codegen
goal: es5
sprint: current
horizon: xl
superseded_by: 4176
related: [4176, 4160, 4159, 2875, 4163]
---

# #4193 — superseded by #4176 / PR #4155

**Do not implement this.** #4176 (PR #4155) already implements the per-brand
proto-property store — named keys on builtin prototypes living through the
prototype chain, generalising #4160's integer-key store to all brands — and
measured **+76** on a 219-file lever. It found the same root cause independently
(module-init collection dropping top-level `<Builtin>.prototype.<name> = …`
writes because builtins have no module-global root identifier). It is held only
to sequence a conflict with #4153.

Retained because the reservation is spent and because the census below is
independent corroboration reached from a completely different direction — the
`built-ins/String/prototype` borrowed-method residue.

## The defect (repro, `--target standalone`, pre-#4155)

```js
Number.prototype.foo = function () { return "FOO"; };
typeof Number.prototype.foo;             // "undefined"   (want "function")
(1).foo();                               // null          (want "FOO")
Number.prototype.bar = 7;
Number.prototype.hasOwnProperty("bar");  // false         (want true)

Boolean.prototype.baz = function () {…}; true.baz();  // null
Object.prototype.qux = function () {…};  ({}).qux();  // null
Array.prototype.quux = function () {…};  [].quux();   // null
```

An **own** property on an ordinary object works
(`new Object(42).charAt = String.prototype.charAt` → `"4"`). The gap is specific
to the builtin **prototype object**: `$NativeProto` (`native-proto.ts`) has six
fields — `brand`, `isClass`, `ctor`, `parent`, `memberCsv`, `name` — and no
own-property store, so the write has nowhere to land.

## Independent size measurement (2026-08-06, ES5 label, standalone)

List every ES5 test262 file whose body matches
`\b(Object|Function|Array|String|Number|Boolean|Date|RegExp|Error|…)\.prototype\.\w+\s*=`
(139 files) and sweep with the runtime-eval provider attached and
`TEST262_FULL_RUNTIME_EVAL=1`:

| directory | fail / total |
| --- | ---: |
| `built-ins/Object/defineProperty` (+ `defineProperties`) | 63 / 87 |
| `built-ins/String/prototype/split` | 13 / 13 |
| `built-ins/String/prototype/{toLowerCase,toUpperCase,toLocale*Case}` | 12 / 12 |
| `built-ins/String/prototype/{slice,substring,match,replace,concat,indexOf,lastIndexOf}` | 12 / 12 |
| `built-ins/RegExp/prototype/{exec,test}` | 6 / 6 |
| `built-ins/Function/prototype/bind` | 3 / 5 |
| `built-ins/Array/**`, `built-ins/Number/prototype`, misc | 3 / 4 |
| **total** | **112 / 139** |

Spot-verified causal, not incidental:

- `Object/defineProperty/15.2.3.6-3-34-1.js` — `Array.prototype.enumerable = true;`
  then an `[]` is used as the attributes bag and must inherit `enumerable`.
- `Object/defineProperty/15.2.3.6-3-248-1.js` — `Function.prototype.set = fn;`
  then a function object is the attributes bag and must inherit `set`.
- `String/prototype/split/call-split-1-0-instance-is-number.js` —
  `Number.prototype.split = String.prototype.split; new Number(…).split(1,0)`.

The load-bearing part for planning: **63 of those sit in
`built-ins/Object/defineProperty`**, i.e. inside #4163's #1 lever (857 reachable
failures) but **not** behind the descriptor MOP (#1906/#2992/#3251). They are
attributes bags inheriting from a monkey-patched builtin prototype, and #4155
closes them without any MOP work.
