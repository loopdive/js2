---
id: 2038
title: "standalone: `illegal cast` in __iterator_next / async destructuring & yield* paths (~470 tests)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: iterators, for-await-of, async-generators, destructuring
goal: standalone-mode
related: [1665, 1664, 681, 1323, 1048]
test262_bucket: standalone-iterator-illegal-cast
test262_count: 470
es_edition: es2018
origin: "2026-06-10 standalone-vs-host baseline diff: 473 non-Temporal gap rows fail with `illegal cast`, 213 of them inside __iterator_next, concentrated in for-await-of and async-generator destructuring."
---

# #2038 — standalone: iterator-protocol `illegal cast` bucket

## Problem

~470 gap tests (host-pass) trap at runtime with `illegal cast`
(`ref.cast` failure) in standalone mode. Sub-buckets by trap site:

| Count | Trap site | Example |
| ---: | --- | --- |
| 210 | `__iterator_next() ← fn ← test` | `language/statements/for-await-of/async-func-dstr-var-async-obj-ptrn-empty.js` |
| 115 | `[in test()]` directly, async-generator `yield*` | `language/expressions/async-generator/named-yield-star-getiter-async-returns-number-throw.js` |
| ~145 | misc: `__obj_find ← __extern_get ← __closure_*`, compound-assignment closures, `__obj_insert ← __defineProperty_value` (the last belongs to #2042) | |

Confirmed on main @ 936d1ac51:
`for-await-of/async-func-dstr-var-async-obj-ptrn-empty.js` compiled standalone
traps `illegal cast` at runtime (host: pass).

The dominant shape is **async** iteration consuming the pure-Wasm iterator
protocol: `for await (var {} of [asyncIter])`, async-generator method
destructuring (`async-func-dstr-*`, `async-gen-*`), and `yield*` delegating to
an async iterator whose `next()` resolves to a non-object/number
([§27.6.3.8 AsyncGeneratorYield / §7.4.3 IteratorNext](https://tc39.es/ecma262/#sec-iteratornext)).

## Root cause in compiler (to confirm)

The standalone iterator runtime (`$IteratorResult` struct path from #1323 /
native generators from #1665) and the **async** wrapper path disagree about
the carrier type: `__iterator_next` `ref.cast`s the iterator/result to the
sync `$IteratorResult`/`$Object` layout, but async paths hand it a different
representation (boxed promise resolution value, externref, or the async
generator's own state struct). Sync `for-of` over the same patterns largely
passes, so the cast mismatch is specific to the async bridging added around
the microtask/CPS scheduler (#1326/#1326c).

## Suggested fix

1. Trace one repro: dump WAT for the minimal failing form, find which
   `ref.cast` traps and what the actual operand type is.
2. Unify the async-iterator-result carrier with the sync `$IteratorResult`
   struct (or brand-switch before casting), including the
   `yield*`-rejects-non-object path which must throw TypeError, not trap.
3. Keep the #1888 invariant: unknown carrier ⇒ JS `TypeError` via the
   standalone throw helper, never a Wasm trap (`illegal cast` reads as a
   compiler bug, and aborts the whole test instead of being catchable).

## Acceptance criteria

- `async-func-dstr-var-async-obj-ptrn-empty.js` and the
  `named-yield-star-getiter-async-returns-number-throw.js` family pass
  standalone.
- `illegal cast` rows inside `__iterator_next` drop to 0 in the standalone
  baseline; overall bucket ≤ 50 (remaining rows reassigned to owners).
- Wasm traps are not used for spec-reachable error paths in the iterator
  protocol (TypeError surfaces as catchable JS error).
