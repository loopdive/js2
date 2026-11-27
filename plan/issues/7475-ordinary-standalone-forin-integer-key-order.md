---
id: 7475
title: "Ordinary standalone pipeline: for-in visits an object literal's integer keys out of order"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
goal: ir-full-coverage
depends_on: []
related: [7377, 7466, 2964]
origin: "2026-11-26 RV7428 review of #7377 (pre-existing on main, not that PR)"
---

# #7475: for-in key order in the ordinary standalone pipeline

## Problem

On the ordinary pipeline with `--target standalone`, for-in visits an object literal's keys in insertion order, even
when some keys are integer indices. [[OwnPropertyKeys]] (§10.1.11.1), and so EnumerateObjectProperties, lists the
array indices first, in ascending order, then the string keys in insertion order.

```js
export function test() {
  var out = '';
  var o = { b: 1, 2: 1, a: 1, 1: 1, '10': 1 };
  for (var k in o) out += k + ',';
  return out;
}
```

| | Result |
|---|---|
| ordinary standalone, main and PR #7428 | `"b,2,a,1,10,"` |
| node | `"1,2,10,b,a,"` |

Reported by RV7428 on 2026-11-26. The Prepared path's realm row `js.object.for-in-keys` (#7377) gives node's order:
its kernel `ownKeys` sorts through `keyBefore`.

## Where to look

The legacy standalone `__object_keys_forin` (`src/codegen/object-runtime-enumeration.ts`) and the object layout it
walks. [#7466](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7466-retire-legacy-standalone-forin-helpers)
plans to retire those helpers for the realm row. If #7466 lands first, this issue is closed by it. Otherwise the fix
is the index-first ordering in the legacy helper, and `Object.keys` (`__object_keys`, same module) should be checked
for the same defect.

## Done when

- The program above answers node's order on ordinary standalone.
- An equivalence test pins it, together with `Object.keys` of the same object.
- JS-environment output stays byte-identical for programs without integer keys.
