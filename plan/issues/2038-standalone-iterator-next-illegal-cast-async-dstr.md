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

## Reproduction findings (2026-06-13, dev-a)

Confirmed the bucket reproduces on current main (c28b423e6). Key observations
from minimal repros (standalone target, `WebAssembly.validate` + zero-import
instantiate):

- **Sync iteration is healthy.** `for (const {a} of [{a:1}])`,
  `for (const [a,b] of [[1,2]])`, and `for (const v of [1,2,3].values())` all
  compile to valid standalone Wasm and run correctly (no illegal cast). So the
  shared `__iterator`/`__iterator_next` consumer path (loops.ts ~L3940+,
  `ensureNativeIteratorRuntime`) is NOT the problem on its own.
- **The `illegal cast` bucket is async-specific.** `for await (const x of
  [Promise.resolve(1)])` compiles + validates but:
  1. **leaks `env.Promise_resolve`** as a host import even under
     `--target standalone` — i.e. the async path is not standalone-complete
     (Promise.resolve has no pure-Wasm lowering). This is a precondition: the
     module can't even instantiate with `{}` imports, so the runtime trap only
     surfaces once the microtask scheduler + Promise host shims are supplied.
  2. The `illegal cast` itself (per the issue's trap-trace) is downstream:
     `__iterator_next` `ref.cast`s the result to the sync `$IteratorResult`/
     `$Object` carrier, but the async wrapper hands it the awaited promise
     resolution value (boxed / externref / async-generator state struct),
     whose runtime type does not match the cast target.
- **`yield*` over an array** hits a *different* wall first:
  `Codegen error: native generator lowering currently supports only sequential
  ...` (generators-native.ts) — so the `yield*`-delegation sub-bucket is gated
  by a native-generator limitation upstream of the cast, not the same fix as
  the for-await-of sub-bucket.

### Where to look

- `src/codegen/statements/loops.ts` — the `__iterator_next` consumer (~L3891+,
  the multi-value `(done, value) = __iterator_next(iter)` path) and the
  `iterResultType` struct cast (~L3602/3682).
- `src/codegen/generators-native.ts` — async-generator / `yield*` lowering.
- The async bridge over the microtask/CPS scheduler (#1326) — where the awaited
  value's carrier type diverges from the sync `$IteratorResult` the consumer
  casts to.

### Recommendation

Two distinct sub-fixes hide under this one bucket:
1. **for-await-of carrier mismatch** (210 + misc): unify the async iterator
   result carrier with the sync `$IteratorResult`, OR brand-switch before the
   `ref.cast`; AND give Promise.resolve a standalone lowering so the module is
   host-free. Per #1888, an unknown carrier must throw a JS `TypeError` via the
   standalone throw helper, never a Wasm trap.
2. **`yield*` async delegation** (115): first lift the native-generator
   "sequential only" restriction, then the §27.6.3.8 / §7.4.3 "next() returns
   non-object ⇒ TypeError" path.

This is `reasoning_effort: high` and spans the async scheduler + native
generators + iterator runtime — recommend an `## Implementation Plan`
(architect spec) before implementation, and likely splitting the for-await-of
and yield* sub-buckets into separate PRs.
