---
id: 6913
title: "Native regime / standalone: `arguments[k]` beyond the formals is lost in a HOF callback once any function carries an expando property"
status: ready
created: 2026-10-07
updated: 2026-10-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: es5
goal: architecture
sprint: current
parent: 5385
related: [6898, 6880, 6877]
---

# #6913 — `arguments[2]` is undefined in a 2-formal callback when the module has a function expando

## Problem

ES5 rows `built-ins/Array/prototype/filter/15.4.4.20-9-c-ii-11.js` and
`built-ins/Array/prototype/map/15.4.4.19-8-c-ii-11.js` pass on the host lane
(baseline 2026-10-07, both modes) and fail on standalone. They also fail on
the native regime once #6898 removes the unused `$262` shim (the regime used
to pass them only because the shim's direct `eval` put the module into
runtime-eval mode). ES5 is a `completed` edition, so #6898 cannot land while
they fail, and they are **not** eligible for the ratchet `exceptions` list:
the host lane passes them.

## Reduction (standalone and `native-first`, 2026-10-07)

```js
function assert(m) { return m; }
assert._isSameValue = function (a, b) { return a === b; };   // any function expando
function callbackfn(val, idx) { return val > 10 && arguments[2][idx] === val; }
var newArr = [11].filter(callbackfn);   // TypeError: Cannot access property on null or undefined
```

Delete the expando line and the same program answers `newArr.length === 1`.
Every test262 row has this shape, because `harness/assert.js` assigns
`assert._isSameValue`, `assert.sameValue` and so on. The extra (third)
argument `filter`/`map` pass to the callback never reaches its `arguments`
object: `arguments[2]` reads `undefined`/null. My guess is that the expando
switches function declarations onto the property-bag closure representation
(`closure-props.ts`), and that path's callback dispatch does not carry the
extras-argv (`emitSetExtrasArgv`) for arguments beyond the declared arity.

## Where to look

- `src/codegen/closure-props.ts` (function-object own properties) and the
  closure call path in `src/codegen/closures.ts`. opus-6877 is working in
  `closures.ts` (capture collector), so coordinate before editing.
- The HOF callback invocation in `array-prototype-borrow.ts` (`callClosure`)
  and `hof-native.ts` (`__apply_closure` with a 3-element args vec). Check
  which of the two the reduction reaches.

## Acceptance

- [ ] Both rows pass on `--target standalone` and on `native-first`.
- [ ] A focused test for the reduction (with and without the expando).
- [ ] Default gc byte-identical.
