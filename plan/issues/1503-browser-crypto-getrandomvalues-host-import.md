---
id: 1503
title: "browser: crypto.getRandomValues / crypto.randomUUID host imports"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: browser-support
sprint: 52
related: [1500, 1501, 1502]
---
# #1503 — Web Crypto host imports: `getRandomValues` and `randomUUID`

## Problem

Compiled TypeScript has no access to **cryptographically-secure
randomness**. `Math.random()` is wired (`src/runtime.ts:1773` —
`(Math as any)[intent.method]`) but it is explicitly NOT suitable for
security-sensitive code (session tokens, nonces, UUIDs).

The Web Crypto API surfaces two essentials:

- `crypto.getRandomValues(typedArray)` — fills a `Uint8Array` / `Uint32Array`
  with secure bytes.
- `crypto.randomUUID()` — returns a v4 UUID string.

Both are available on Node 19+ and every modern browser. Compiled code
currently cannot call either:

1. `crypto` resolves via `declared_global` to the real
   `globalThis.crypto` object. So far so good — the externref read
   succeeds.
2. `crypto.getRandomValues(buf)` then goes through the generic
   `extern_class` method dispatch. The first arg `buf` is a compiled
   `Uint8Array` — a WasmGC vec struct that the host sees as an opaque
   externref. `getRandomValues` validates `instanceof ArrayBufferView`
   and **throws TypeError** because the compiled Uint8Array is *not* a
   real one.
3. `crypto.randomUUID()` returns a string and would work — but only if
   the call dispatch reaches it. Today nothing registers the call.

## Use case

```ts
function makeSessionToken(): string {
  return crypto.randomUUID();
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function nonce(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
```

All three are extremely common in real-world code (auth, JWT signing,
file deduplication, request IDs).

## Current behavior

- `crypto.randomUUID()` — generic `extern_class` method dispatch hits
  `self[m]` where `self` is the real `Crypto`. The call works and returns
  a string. Pass-through round-trip *should* succeed but is not tested.
- `crypto.getRandomValues(buf)` — `self.getRandomValues(opaqueWasmStruct)`
  throws `"TypeError: argument is not an ArrayBufferView"`. Compiled code
  surfaces this as an uncaught exception.
- WASI target — no `crypto` global; `declared_global` fallback yields
  `undefined`; the call traps.

## Implementation plan

1. **`src/index.ts`** (≈line 33): add intent variants
   ```ts
   | { type: "crypto_getrandomvalues" }
   | { type: "crypto_randomuuid" }
   ```
2. **`src/codegen/expressions/calls.ts`**: detect calls of the form
   `crypto.getRandomValues(...)` and `crypto.randomUUID()`. Register host
   imports with signatures:
   - `crypto_getrandomvalues`: `(externref) -> externref` — input vec,
     return same vec for chainability.
   - `crypto_randomuuid`: `() -> externref` — returns a string ref.
3. **`src/runtime.ts`** `resolveImport` (≈line 1700): add the two new
   cases.

   For `crypto_getrandomvalues`, marshal the compiled Uint8Array into a
   real one, fill it, and write the bytes back:
   ```ts
   case "crypto_getrandomvalues": {
     return (vec: any) => {
       const exports = callbackState?.getExports();
       const vecLen = exports?.__vec_len;
       const vecGet = exports?.__vec_get;
       const vecSet = exports?.__vec_set;   // may need to add this export
       if (typeof vecLen !== "function") {
         throw new TypeError("crypto.getRandomValues: argument is not a typed array");
       }
       const n = vecLen(vec);
       const tmp = new Uint8Array(n);
       (globalThis as any).crypto.getRandomValues(tmp);
       for (let i = 0; i < n; i++) vecSet(vec, i, tmp[i]);
       return vec;
     };
   }
   case "crypto_randomuuid": {
     return () => (globalThis as any).crypto.randomUUID();
   }
   ```
4. **`__vec_set` export**: verify it already exists alongside `__vec_get`
   / `__vec_len` (`runtime.ts:341`). If not — add it in
   `src/codegen/index.ts` near the existing vec helpers (search for
   `__vec_get`).
5. **Uint32Array / Uint16Array support**: the same marshaling works if
   the per-element write goes through the per-typed-array element setter
   (`__vec_set_u32`, etc.). For the first cut, support only `Uint8Array`
   and document the rest as a follow-up.
6. **Standalone fallback**: when `globalThis.crypto?.getRandomValues` is
   undefined, fall back to Node's `require('node:crypto').randomFillSync`
   (use the existing `_getNodeRequire` helper at `runtime.ts:12`). For
   pure WASI, document that secure RNG requires a WASI `random_get`
   syscall — out of scope, but throw a descriptive error rather than
   silently using `Math.random()`.

## Acceptance criteria

`tests/equivalence.test.ts` "crypto random" block:

```ts
function uuidsAreUnique(): boolean {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  return a !== b && a.length === 36 && b.length === 36;
}
// Expected: true

function fillsBuffer(): number {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += buf[i];
  // 16 bytes from a uniform distribution — sum is ~2040 ±. Just
  // check that not every byte is zero (probability 256^-16 ≈ 0).
  return sum;
}
// Expected: > 0 (essentially always)
```

Pass means:

- `uuidsAreUnique()` returns `true` (round-trip preserves the JS string).
- `fillsBuffer()` returns a positive integer (vec_set wrote the bytes back).
- Re-running 100 times produces 100 distinct UUIDs.

## Files to modify

- `src/index.ts` (≈line 33) — `ImportIntent` extension.
- `src/codegen/expressions/calls.ts` — recognise the two crypto calls.
- `src/codegen/index.ts` — verify or add `__vec_set` (and `__vec_set_u32`
  if needed) exports.
- `src/runtime.ts` (≈line 1700 switch, also see `_getNodeRequire` at
  line 12) — new cases.
- `tests/equivalence.test.ts` — new "Web Crypto" block.

## Notes

- Critically important for any compiled code that does **auth tokens,
  session IDs, request IDs, or password hashing**. Without this, users
  cannot port real apps to Wasm.
- `crypto.subtle.*` (SubtleCrypto for hashes / signatures) is a much
  larger surface — out of scope. Track as a follow-up if there's
  demand.
- The fallback to `Math.random()` for `getRandomValues` is **forbidden**
  per RFC and would create a false-security trap. Throw instead.

## Suspended Work

- **PR**: #407 — https://github.com/loopdive/js2/pull/407
- **Branch**: `issue-1503-browser-crypto`
- **Worktree**: `/workspace/.claude/worktrees/issue-1503-browser-crypto/`
- **HEAD SHA**: `8274ab1a2a53a7d79eeca2b84e73b077a4fe559d`
- **State**: PR open, in CI-wait. 5/5 local tests pass.

### Implemented (commit 8274ab1a)
- `src/codegen/expressions/calls.ts` — detect `crypto.randomUUID()` and `crypto.getRandomValues(buf)`. For the buffer arg, emit `extern.convert_any` directly (bypassing `coerceType`'s `__make_iterable` wrapping that strips vec identity).
- `src/codegen/index.ts` — new `__vec_set_byte(externref vec, i32 idx, i32 byte) -> ()` export with vec-type dispatch (f64 vec → f64.convert_i32_u, i32/i32_byte vec → direct array.set). Gated on `__crypto_get_random_values` being imported. Widened `emitVecAccessExports` gate to co-emit `__vec_len`.
- `src/runtime.ts` — `__crypto_random_uuid` and `__crypto_get_random_values` resolvers. Prefer `globalThis.crypto.*`; fall back to `require('node:crypto').{randomUUID,randomFillSync}` for older Node. Throw (no Math.random) on standalone hosts.
- `tests/issue-1503.test.ts` — 5 tests: randomUUID shape/uniqueness, getRandomValues entropy + byte readback, return-value chaining.

### Resume steps
1. Monitor `.claude/ci-status/pr-407.json` for HEAD-SHA match (`8274ab1a...`).
2. Run `/dev-self-merge 407`.
3. If MERGE: `gh pr merge 407 --admin --merge`; mark task #59 completed; remove worktree.
4. If ESCALATE: message tech lead with criterion + values.
