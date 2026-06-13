---
id: 1464
title: "spec gap: Iterator.prototype helpers + Iterator.zip / Iterator.concat (ES2025)"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: iterator-helpers
goal: spec-completeness
sprint: 52
related: [1367]
---
# #1464 - spec gap: Iterator.prototype helpers + Iterator.zip / Iterator.concat (ES2025)

## Problem

`built-ins/Iterator/` totals **452 test262 failures**:

```
44 prototype/flatMap   37 prototype/filter   36 prototype/map
34 prototype/drop      33 prototype/every    33 prototype/some
33 prototype/take      32 prototype/find     30 prototype/reduce
27 prototype/forEach   18 prototype/toArray
42 Iterator/zipKeyed   36 Iterator/zip       32 Iterator/concat
 6 prototype/Symbol.dispose
 5 prototype/Symbol.iterator   2 prototype/Symbol.toStringTag
 + smaller / spec-shape tests
```

These are the **ES2025 Iterator Helpers** proposal. The compiler relies
on the JS host's `Iterator.prototype` (see `src/runtime.ts:4122` —
synthesised iterators inherit from `globalThis.Iterator.prototype` when
available, so methods *resolve* but the tests fail because:

1. The Wasm-side `IteratorRecord` / `next()` shape doesn't match what
   the host helpers expect when the source is a TS-compiled iterator
   (e.g. a generator function lowered through #1373).
2. Several tests target trap-order invariants — `Iterator.prototype.map.call(badNext, …)` — and our wrappers don't surface the `get next` / typecheck failures at the exact point the spec demands.
3. `Iterator.zip` / `Iterator.zipKeyed` / `Iterator.concat` are **not
   recognised as builtins at all** — calls compile but the host's
   global `Iterator.zip` is reached via host-import only when JS is the
   host. In standalone mode they are completely absent.
4. Several iterator-helper tests pin descriptor attributes on the
   helper functions (downstream of #1462).

Sample errors:

| Test | Pattern |
| --- | --- |
| `prototype/filter/argument-order.js` | `Iterator.prototype.filter.call({get next(){…}}, null)` — TypeError must be thrown before reading `next` |
| `prototype/filter/return-on-abrupt-completion.js` | Underlying iterator's `return()` must be invoked when arg validation fails |
| `Iterator/zip/option-strict-mode.js` | `Iterator.zip` unknown |
| `Iterator/concat/iterable.js` | `Iterator.concat` unknown |
| `prototype/initial-value.js` | Iterator helpers must inherit from `%Iterator.prototype%` per spec; check fails |

## Failure count

452 in `built-ins/Iterator/`. Realistic target: ~330 (some tests pin
exact property-descriptor shapes — those resolve via #1462).

## Root cause

In `src/codegen/` — there is **no dedicated Iterator helper layer**.
Synthesised iterator objects in `src/runtime.ts:4122` set their
`__proto__` to `globalThis.Iterator.prototype` so `.map`/`.filter`/etc.
*work* on JS hosts, but:

1. **Generator-produced iterators** (via #1373 CPS lowering) do not
   currently inherit from `Iterator.prototype` consistently — verify
   by checking the prototype chain of `(function*(){})()`.
2. **No Wasm-side implementation.** Standalone-mode (WASI / no JS host)
   has no helpers at all — all 452 tests would still fail there.
3. **`Iterator.zip` / `Iterator.zipKeyed` / `Iterator.concat`** are
   missing even on JS-host mode: they are recent ES2025+ additions
   that the host may have, but the compiler doesn't import them.
4. **Argument-validation trap order** — the spec mandates a specific
   sequence (check callable → close on abrupt → start consuming). The
   host's behaviour matches, but our generator-iterator's `return()`
   wiring drops the close on early arg failure.

## Acceptance criteria

1. All synthesised iterators (from `__iterator` runtime helper and from
   `__call_@@iterator` on Wasm structs) inherit from
   `globalThis.Iterator.prototype` when available, or from a
   compiler-installed polyfill object in standalone mode.
2. Iterator helper method dispatch works on **generator-produced**
   iterators (`(function*(){})().map(f).toArray()` returns expected
   value).
3. Iterator helper argument validation closes the underlying iterator
   on abrupt completion (via `return()`) when the host helper does so.
4. `Iterator.zip(iters, opts)`, `Iterator.zipKeyed(iterMap, opts)`,
   `Iterator.concat(...iters)` are wired as host imports (with a
   standalone fallback that throws "Iterator.X requires JS host").
5. ≥300 of the 452 failures resolved.
6. Tests: `tests/issue-1464.test.ts` covers each helper + zip/concat
   with at least one positive and one abrupt-completion case.

## Files to inspect

- `src/runtime.ts` lines 3958–4170 — iterator synthesis path
- `src/codegen/async-scheduler.ts` — generator lowering, iterator
  protocol
- `src/codegen/expressions/calls.ts` — call-site dispatch on
  `Iterator.zip` / `Iterator.concat` / iterator helper methods
- `src/codegen/declarations.ts` — register `Iterator` as a known
  builtin alongside `Object`, `Promise`, etc.
- `tests/issue-1464.test.ts`

## Notes

- #1367 set up the Iterator-prototype inheritance for synthesised
  iterators; this issue extends that to all iterator producers and
  adds zip / concat.
- Tests that pin function `name` / `length` / descriptor flags on the
  helper methods themselves will only flip once #1462's descriptor
  work lands — count those as "indirect" wins.
