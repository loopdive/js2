---
id: 7299
title: "IR: harness makeArrayLike — object literal with a dynamic member value (measured: 0 units; blocked by makeArray via call-graph closure)"
status: blocked
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7298, 7265, 7260, 7258, 7280, 2949]
assignee: "ttraenkler/c-lane-opus"
---

# #7299 — harness `makeArrayLike`: `{ length: arr.length }` into a dynamic local

## Problem

`makeArrayLike(TA, primitiveOrIterable)` (`test262/harness/testTypedArray.js:80`)
is legacy-compiled in 51 units on the wrapped stride-40 standalone ledger,
covering every typed-array test. Its first refusal is
`move-only[concrete]` on `{ length: arr.length }`:

```js
function makeArrayLike(TA, primitiveOrIterable) {
  var arr = makeArray(TA, primitiveOrIterable);
  if (isPrimitive(arr)) return arr;
  var obj = { length: arr.length };
  for (var i = 0; i < obj.length; i++) obj[i] = arr[i];
  return obj;
}
```

## Measurement (2026-11-07, main c03f7d0e)

**1. Its callee `makeArray` is legacy in all 51 files**, refused as
`expr-ident-not-in-scope` `Array` (`Array.from({ length: n }, function () {…})`,
`Array.from(iterable)`). The Step-2 call-graph closure (`selectIrFunctions`,
`src/ir/select.ts` ~L1325) drops any claimed function with an unclaimed local
callee (#7298 verified this on a minimal program). So `makeArrayLike` cannot
go IR until `makeArray` does, whatever its own body admits. The other units
in these files stay legacy too, 13–25 per file: `makeArrayBuffer`,
`testWith*TypedArrayConstructors`, `<module-init>`, …

**2. `makeArrayLike`'s own body.** With `makeArray` replaced by an
IR-claimable stand-in, `isPrimitive` and the stand-in claim. `makeArrayLike`
then stops first at this literal. Beyond it the body needs:

- `obj.length` as a dynamic read (#7265);
- `obj[i] = arr[i]` as a dynamic-local element store (#7260, sloppy only);
- `return obj` / `return arr` as a dynamic return.

**3. Legacy's emission.** On standalone, `{ length: arr.length }` with `arr: any` is a
**closed struct** (two `struct.new`). The indexed writes go through the expando
path (`__is_instance_expando_carrier`, `__extern_set`, `__reflect_set`), and the
reads through `__extern_get` / `__extern_length`. That is not an open
`$Object` built by a create-and-define helper. So an IR lowering that keeps
`obj` dynamic would have to produce a carrier legacy also reads the same way,
or reuse that struct-plus-expando lowering. That is a lowering design question
to settle with R13, whose #7280 covers script-var literal-data-only literals,
before any code.

**4. Reach of the general admission today.** The only object-literal
`move-only` first refusals on the stride are this literal: 51 units of
`makeArrayLike` plus 1 `makeArrayLike$dup0`. All of them are closure-blocked
by `makeArray`. **Units that would move on the stride: 0.** That is below the
threshold of 5 used for #7298, so this slice is docs-only.

## Conclusion

- Parked: `status: blocked` until `makeArray` is IR-claimable, which needs
  ambient `Array.from` with an array-like and a callback, and with an
  iterable, on standalone.
- When that lands, the admission is worth up to 51 stride units (every
  typed-array test). Its lowering must match legacy's struct-plus-expando
  representation of `obj` or reuse it; coordinate with R13 (#7280).
- No code change on this id.
