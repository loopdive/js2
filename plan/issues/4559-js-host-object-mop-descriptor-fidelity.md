---
id: 4559
title: "JS-HOST lane: Object MOP descriptor fidelity — 7 landed commits, host lane 0/101 → 68/101 (parked out of the standalone push)"
status: blocked
sprint: current
created: 2026-08-19
updated: 2026-08-19
assignee: ttraenkler/es5-standalone-push
priority: medium
horizon: m
feasibility: medium
task_type: conformance
area: codegen, runtime
es_edition: 5
language_feature: property-descriptors
goal: test262-conformance
related: [4491, 4163, 4556, 2668]
origin: "2026-08-19 ES5 standalone push. This work was produced by the `es5-obj-rest` lane before the target was narrowed to standalone-only; measured host-only, so it was parked rather than merged."
---

# #4559 — JS-host Object MOP descriptor fidelity (parked branch)

## Why this issue exists

The 2026-08-19 ES5 push targets **standalone** (#4163). This branch predates that
narrowing and was measured to move **zero** standalone rows, so it is deliberately
NOT in the standalone integration. It is real, validated work and is parked here
so it is not lost.

**Branch: `es5-obj-rest`, head `92688f1`, clean tree, 7 commits.**

## Attribution — measured, not inferred

Method: revert `src scripts tests` to base `f7df34f1` in-place, run standalone,
restore, run standalone again — same tree, same corpus, only the branch's code
differing. 740 standalone runs total.

| corpus | base | HEAD | failure set |
| --- | --- | --- | --- |
| 101-row Object lane, `target=standalone` | 73/101 | 73/101 | byte-identical |
| 639-row sample, `target=standalone` | 572/639 | 572/639 | byte-identical |

Not one row moved in either direction. Per commit, the code confirms the reason:

| commit | why host-only |
| --- | --- |
| `a1266b5` `__get_builtin` sandbox-first | `__get_builtin` **is a host import**; it does not exist in standalone |
| `9599eb5` gOPD struct fast path, aliased global `this` | predicate opens `if (ctx.standalone \|\| ctx.wasi) return false` |
| `10ba34b` accessor read + frozen-struct descriptor | both sites in `resolveImport`, i.e. host imports only |
| `c444f04` new-key accessor define + gOPD nullish throw | accessor half is codegen but measured zero standalone movement; throw is a host import |
| `37f6392` `x.valueOf()` identity fold | literally `if (!ctx.standalone) return undefined` — host-only by construction |
| `c5f6c53` defineProperties enumerable-only + accessor-aware | host imports |
| `92688f1` vec `hasOwnProperty` | host import |

**Host-lane result, for the record: 0/101 → 68/101, guard 632/639 → 633/639**
(one deliberate trade, documented in `92688f1`).

## Harness changes on this branch (also host-only in effect)

- `tests/test262-runner.ts` + `scripts/test262-worker.mjs`: sandbox globals are
  now installed with `Object.defineProperty` as
  `{writable: true, enumerable: false, configurable: true}` per §19, instead of a
  plain assignment which made them **enumerable** — so
  `getOwnPropertyDescriptor(this, "parseInt").enumerable` read `true` and a
  `for (p in this)` walk enumerated the whole builtin surface. This is realm
  fidelity, not skip-logic: nothing is excluded from running.
- `scripts/test262-sandbox-globals.mjs`: added the §19.2 global **function**
  properties (`eval`, `isFinite`, `isNaN`, `parseFloat`, `parseInt`,
  `decodeURI*`, `encodeURI*`, `escape`, `unescape`). The list previously held
  constructors and namespaces only, so reflective views of the global object
  disagreed with the callable ones.

### These sandbox names do NOT manufacture standalone passes — verified

The concern was that supplying `escape`/`unescape`/`eval` from the **JS sandbox**
would mask genuine standalone gaps that #4556 is meant to fix in the compiler.
Tested directly: a 19-row list (the `prop-desc.js` files for those globals plus
the `15.2.3.3-4-4..11` gOPD family), run `target=standalone`, with and without
the harness change:

- base (no added names): **11 pass / 8 fail**
- HEAD (names added): **11 pass / 8 fail — the same 8**

The three flagged rows fail identically in both arms, with the census wording:
`escape should be an own property`, `unescape should be an own property`,
`eval should be an own property`.

Mechanism: in standalone there is no JS host, so the compiled module's global
object is its own and the JS sandbox is never consulted. Those names are only
readable by the **js-host** lane — which is where the 7 gOPD rows they fix live.

**Consequence: `escape`/`unescape`/`eval` own-property rows remain genuine
standalone gaps and stay owned by #4556.**

## Spun-out finding — a compiled-code crash, not a missing property

`parseInt` / `parseFloat` / `isNaN` / `isFinite` `prop-desc.js` all trap under
standalone with:

```
RuntimeError: dereferencing a null pointer in verifyCallableProperty()
```

That is a crash in compiled code, not an absent global. 4 rows, unrelated to the
descriptor work above. Route separately.

## Unblocking condition

Pick this up when the JS-host ES5 lane is a target again (it is at 84.8 %, well
behind standalone's 94.2 % — see #4163). Re-merge `origin/main` first; the branch
is based on `f7df34f1`.
