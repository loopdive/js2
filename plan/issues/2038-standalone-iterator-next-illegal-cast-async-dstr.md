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

## Implementation Plan (architect spec, 2026-06-13)

### Root cause (confirmed precise — carrier mismatch + host-import leak)

The for-await-of consumer in `src/codegen/statements/loops.ts` mixes two
incompatible iterator implementations under `--target standalone`:

1. **Producer side (async):** `loops.ts:4002-4007` calls `ensureAsyncIterator`
   (`src/codegen/statements/destructuring.ts:377`). That function registers
   `__async_iterator` as a **JS-host `env` import**
   (`addImport(ctx, "env", "__async_iterator", …)`) — it has NO standalone
   native lowering. It is allowlisted as host-only under #1472
   (`src/codegen/host-import-allowlist.ts:248`). So the async receiver carrier
   is whatever the host import returns (a host iterator / boxed value).
2. **Consumer side (native):** the very next lines reuse the native
   `__iterator_next` (`src/codegen/iterator-native.ts:134`, body at `:183`),
   which does `ref.cast $IterRec` on its arg (`iterator-native.ts:188`). The
   native `__iterator` (`:106`) is the only producer that builds an `$IterRec`;
   the host `__async_iterator` does not. Feeding the host-produced carrier to
   the native `__iterator_next` ⇒ `ref.cast $IterRec` traps **`illegal cast`**.

**Sync is healthy** because the sync path uses the native `__iterator`
(`:106`) → builds `$IterRec` → native `__iterator_next` casts the SAME
`$IterRec`. The brand matches. The async path breaks the brand invariant.

Secondary defect (precondition): the async path also leaks
`env.Promise_resolve` (`src/codegen/expressions.ts:324`,
`async-cps.ts:186`) as a host import in standalone — the await/microtask bridge
(#1326 CPS driver, `closures.ts:2904` `__cb_N`) has no pure-Wasm Promise
lowering. So a for-await module can't even instantiate with `{}` imports; the
`illegal cast` only surfaces once host shims are supplied.

### Spec basis
- GetIterator(async) [§7.4.3](https://tc39.es/ecma262/#sec-getiterator) — for an
  async-iterable use `@@asyncIterator`; if absent, wrap the sync iterator via
  **CreateAsyncFromSyncIterator** [§27.1.4.1](https://tc39.es/ecma262/#sec-createasyncfromsynciterator),
  whose `next` does `Await(result.value)` and re-wraps as `{value, done}`.
- IteratorNext [§7.4.4](https://tc39.es/ecma262/#sec-iteratornext) — `next()`
  result that is not an Object ⇒ **TypeError** (the `yield*`-returns-number-throw
  family).
- AsyncGeneratorYield [§27.6.3.8](https://tc39.es/ecma262/#sec-asyncgeneratoryield).

### Two distinct sub-buckets — SPLIT INTO SEPARATE PRs

The 470 rows are two unrelated defects sharing a symptom. Do NOT try to fix both
in one PR.

#### Sub-bucket A — for-await-of carrier mismatch (210 + misc, the bulk)

**File: `src/codegen/statements/destructuring.ts` — `ensureAsyncIterator` (`:377`)**

Give `__async_iterator` a standalone-native lowering that returns the SAME
`$IterRec` carrier the native `__iterator_next` consumes, so the brand matches.

- When `ctx.standalone || ctx.wasi`: do NOT `addImport`. Instead
  `ensureNativeIteratorRuntime(ctx)` and register a native
  `__async_iterator(externref) -> externref` that implements
  **CreateAsyncFromSyncIterator** over the native runtime:
  - If the subject is already an async iterator carrier (future: an async
    generator state struct), pass it through.
  - Otherwise wrap the sync native `__iterator` result: build the SAME
    `$IterRec` (or a thin `$AsyncIterRec` brand the native `__iterator_next`
    also accepts — see "carrier unification" below). The async `next` semantics
    (Await on each value) are layered by the CPS driver around the loop body,
    NOT inside the carrier — so for a sync-backed async iterable the carrier can
    be the plain `$IterRec` and per-element `Await` is emitted by the existing
    for-await CPS lowering.
- **Carrier unification (the core design decision):** make `__iterator_next`
  accept BOTH the sync `$IterRec` and the async carrier. Two options —
  recommend (a):
  - **(a) Single carrier (preferred):** the async path reuses the plain
    `$IterRec`. The "async" part is the `Await(value)` the CPS driver wraps
    around each consumed element; the iterator record itself is brand-identical
    to sync. This needs NO change to `__iterator_next`'s cast — the async
    producer just builds an `$IterRec`. Lowest risk.
  - **(b) Brand-switch in `__iterator_next`:** add an async-carrier struct type;
    `__iterator_next` does `ref.test $IterRec` else `ref.test $AsyncIterRec`
    before casting; unknown ⇒ throw TypeError via `__new_TypeError` (see #2042
    spec for the throw helper), never `ref.cast`-trap. More flexible but more
    surface area. Only take (b) if (a) cannot express async-generator-produced
    iterators in a later slice.
- **Promise.resolve / Await standalone lowering** (precondition): the for-await
  body's per-element `Await` must not leak `env.Promise_resolve`. For a
  sync-backed async iterable the awaited value is already settled, so
  `Await(v)` reduces to `v` — emit the identity/already-settled fast path in
  standalone instead of the `Promise_resolve` host call. Coordinate with the
  async-CPS owner: the general standalone Promise runtime is a larger effort,
  but the **sync-backed for-await** case (the dominant test262 shape:
  `for await (x of [1,2,3])` / `for await (x of syncIterable)`) only needs
  Await-of-already-settled = identity. Scope PR-A to that; defer
  genuinely-pending-Promise for-await to a Promise-runtime follow-up.

**File: `src/codegen/statements/loops.ts` (`:4002-4007`)** — no logic change;
once `ensureAsyncIterator` returns a native `$IterRec`-producing func in
standalone, the existing consumer drives it correctly. Verify the
`addIteratorImports` call at `:3956` stays a no-op in standalone.

#### Sub-bucket B — `yield*` async delegation (115)

Blocked UPSTREAM by a native-generator limitation, NOT the carrier mismatch.

**File: `src/codegen/generators-native.ts`** — `yield*` over an iterator hits
`Codegen error: native generator lowering currently supports only sequential …`
BEFORE any cast. So:
1. First lift the native-generator "sequential only" restriction enough to
   support `yield*` delegation (this is the hard part — a separate, larger PR;
   may stay refused-loud short-term).
2. Then implement the §7.4.4 / §27.6.3.8 contract: delegate `next`/`throw`/
   `return` to the inner iterator; an inner `next()` returning a non-Object ⇒
   **throw TypeError** (catchable), never a Wasm trap. Use the `__new_TypeError`
   standalone constructor + exn tag (`object-runtime.ts:1570` pattern), the same
   helper #2042 uses.

### Wasm IR pattern (carrier unification, option (a))

```wasm
;; standalone __async_iterator(subject) -> externref  (CreateAsyncFromSyncIterator)
local.get $subject
call $__iterator          ;; native: builds $IterRec{kind, vec, idx}, returns externref
return                    ;; SAME carrier the native __iterator_next casts to → no illegal cast
;; per-element Await is emitted by the for-await CPS lowering around the loop body,
;; reduced to identity for already-settled (sync-backed) values in standalone.
```

### Edge cases
- **`for await` over a sync iterable** (the common test262 shape): values are
  already settled ⇒ Await = identity ⇒ no Promise host import. MUST work in PR-A.
- **`for await` over genuinely-pending Promises** (`[Promise.resolve(1)]`):
  needs the standalone Promise/microtask runtime — DEFER to a Promise-runtime
  follow-up; until then refuse-loud (no host leak, no trap) rather than emit
  `Promise_resolve`.
- **`next()` returns a non-object** (the `yield*`-returns-number-throw family):
  TypeError via `__new_TypeError`, catchable — covered in sub-bucket B.
- **Empty async destructuring** `for await (var {} of [x])`
  (`async-func-dstr-var-async-obj-ptrn-empty.js`): the `{}` pattern binds
  nothing; once the carrier matches, this is the simplest passing case — use it
  as the PR-A smoke test.
- **Iterator close on early exit / throw**: the existing finallyStack iterator-
  close machinery (`loops.ts:4095-4126`) calls `__iterator_return`; the native
  `__iterator_return` (`iterator-native.ts:150`) is a no-op for vec iterators —
  correct for sync-backed. Async `return` of pending values is part of the
  deferred Promise-runtime work.
- **`#1888 invariant`**: any unknown carrier reaching `__iterator_next` ⇒
  TypeError (option b) or simply never produced (option a). Never `ref.cast`-trap.

### PR split (REQUIRED — do not combine)
1. **PR-A (carrier fix, sync-backed for-await):** native `__async_iterator` in
   `destructuring.ts` returning `$IterRec` (option a) + Await-of-settled identity
   fast path in standalone. Target: `async-func-dstr-*` / `for await (x of
   [literals])` rows; the 210 `__iterator_next` `illegal cast` rows → ~0.
   Scope: `destructuring.ts` + a small standalone-Await branch. Touches the
   async-CPS boundary — **coordinate with the async-CPS owner; likely
   senior-dev.**
2. **PR-B (yield* async delegation):** native-generator sequential-restriction
   lift + §7.4.4 non-object-TypeError. Larger; may land refused-loud first.
   Scope: `generators-native.ts`. **Senior-dev / architect-reviewed.**
3. **PR-C (standalone Promise runtime for genuinely-pending for-await):**
   separate epic; out of scope here beyond the refuse-loud guard.

### Regression risk
- `__async_iterator` is currently host-only; making it native in standalone is
  additive (host mode keeps the import). **Verify host for-await tests
  unchanged** — gate the native branch strictly on `ctx.standalone || ctx.wasi`.
- Carrier option (a) reuses `$IterRec` — zero change to `__iterator_next`, so
  sync for-of cannot regress. Option (b) edits `__iterator_next`'s cast and is
  higher risk (every for-of consumer); prefer (a).
- funcIdx stability: registering native `__async_iterator` shifts late-import
  indices — `ensureAsyncIterator` already does `shiftLateImportIndices`
  (`destructuring.ts:383`); mirror that for the native registration and flush
  pending batches first (the `ensureObjectRuntime` ordering discipline).

### Test files to verify
- `language/statements/for-await-of/async-func-dstr-var-async-obj-ptrn-empty.js`
  (PR-A smoke test) — standalone pass.
- A new `tests/issue-2038.test.ts`: standalone `for await (const x of [1,2,3])`
  sums to 6; `for await (const {a} of [{a:1},{a:2}])` works; matches host.
- `language/expressions/async-generator/named-yield-star-getiter-async-returns-number-throw.js`
  family (PR-B) — TypeError thrown, catchable.
- Confirm sync for-of / generators (`tests/` generator + for-of suites) byte-
  identical pre/post PR-A.
