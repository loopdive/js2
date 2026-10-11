---
id: 6758
title: "standalone: lodash-es `Hash` / `ListCache` instances are broken, so `memoize(f)(x)` traps `illegal cast`"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6738, 6720, 3981]
---

# #6758 — lodash-es `Hash` / `ListCache` instances are broken in standalone

## Problem

After [#6738](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6738-standalone-new-of-logical-or-callee-null)
`new (memoize.Cache || MapCache)` and `new (Map || ListCache)` construct, so
`memoize(f).cache` is a real `MapCache` whose `__data__.map` is a real `Map`.
The next wall is the other two cache classes, constructed through the STATIC
`new F()` path:

Measured on the #6738 branch (base `0aeb5733bb`), a `compileProject` graph of
`lodash-es/{memoize,uniqBy,isEqual,_MapCache,_ListCache,_Stack,_Hash}.js`,
`--target standalone`, `runtimeEvalProvider: false`, Node for the expected
column:

| probe | Node | standalone |
| --- | --- | --- |
| `new Hash().size` | `0` | `undefined` |
| `new MapCache(); c.set("k", 5); c.get("k")` | `5` | `undefined` |
| `new MapCache(); c.set(4, 5); c.get(4)` | `5` | `RuntimeError: illegal cast` |
| `memoize(f)(4)` | `4` | `RuntimeError: illegal cast` |
| `new ListCache(); c.set("k", 5)` | ok | `TypeError: Cannot access property on null or undefined at 15:15` (`entries.length`, so `entries == null` answered false for an omitted argument) |
| `new Stack(); c.set("k", 5)` | ok | `TypeError: called value is not a function` |
| `uniqBy([2.1, 1.2, 2.3], Math.floor).length` | `2` | `TypeError: Cannot access property on null or undefined at 13:31` |

The same shapes written in ONE file (`function Hash(entries) { … this.clear(); }`
with `Hash.prototype.clear = hashClear`) construct correctly, so the fault is in
the multi-module lowering — `_hashClear.js` reads `nativeCreate` (a
`getNative(Object, 'create')` default-expression import), and `_ListCache.js`'s
typed fnctor path under-applies `entries`.

## Why it matters

Every lodash-es operation that builds a `MapCache` / `Stack` at run time:
`memoize`, `isEqual`, `cloneDeep`, `uniqBy`, `toPath`, `get` with a string
path. The npm-compat `words`/`kebabCase` sample does not reach it.

## Suggested start

Bisect the single-file vs `compileProject` difference for `new Hash().size`
(two modules: `_Hash.js` + `_hashClear.js` with `_nativeCreate.js` inlined as a
default-expression export), then the `new ListCache()` omitted-argument
`entries == null` answer on the static fnctor path.
