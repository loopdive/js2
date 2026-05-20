---
id: 1492
sprint: 52
title: "nodejs: crypto.randomBytes / randomUUID host imports"
status: ready
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: nodejs-support
related: [1322, 1044]
---

# #1492 — `crypto.randomBytes` / `crypto.randomUUID` host imports

## Problem

The only source of entropy reachable from compiled TS today is `Math.random`:

- JS host target: `Math.random` delegates to V8's `Math.random` (good
  quality but not crypto-grade).
- WASI/standalone: `Math.random` reads 8 bytes from `wasi_snapshot_preview1.
  random_get` (#1322) — actually crypto-quality but only as a 53-bit double.

There is **no way** for compiled code to produce a
`Uint8Array`-of-random-bytes or a UUID without writing a custom byte-level
helper around `Math.random` (which is misuse for crypto purposes). `import {
randomBytes, randomUUID } from "node:crypto"` reaches `preprocessImports`
(`src/import-resolver.ts:33` — `crypto` is in `NODE_BUILTIN_MODULES`) and
falls through to `declare const randomBytes: any`, with no host binding.

## Use case

Generating session tokens, UUIDs for object IDs, random salt for hashing:

```ts
import { randomBytes, randomUUID } from "node:crypto";

const sessionId = randomUUID();                       // "1a2b3c4d-..."
const tokenBytes: Uint8Array = randomBytes(32);
const tokenHex = Array.from(tokenBytes)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
console.log(sessionId, tokenHex);
```

Every non-trivial Node server / CLI needs this. Without host bindings users
have to either ship their own JS wrapper or accept Math.random.

## Implementation plan

1. **`src/index.ts`** — reuse the `node_builtin_fn { moduleName; name }`
   `ImportIntent` variant introduced by #1491 (or add it here if #1491 lands
   later).

2. **`src/runtime.ts`** — extend the `node_builtin` resolution path:

   ```ts
   case "node_builtin": {
     if (intent.moduleName === "crypto") {
       const crypto = _getNodeRequire()?.("crypto");
       return {
         randomBytes: (n: number) => new Uint8Array(crypto.randomBytes(n)),
         randomUUID: () => crypto.randomUUID(),
         randomInt: crypto.randomInt,
       };
     }
   }
   ```

   In a browser/Worker context (no `require`), fall back to `globalThis.
   crypto.getRandomValues` for `randomBytes` and `globalThis.crypto.
   randomUUID` for `randomUUID`. This keeps the standalone-mode promise
   (architecture principle: "JS host imports are acceptable as a fast path
   when a JS runtime is available").

3. **`src/codegen/expressions/calls.ts`** — call-site routing for
   `randomBytes(n)` and `randomUUID()` when the binding was declared via
   `import * from "crypto"`. Marshal:
   - `randomUUID()` → host import returns externref string, no conversion.
   - `randomBytes(n: number)` → host returns a `Uint8Array` (already
     supported via #965 TypedArray). Compiler emits the call as
     `(f64) -> externref` and the runtime resolves the Uint8Array.

4. **WASI fallback**: for `--target wasi`, `randomBytes(n)` should lower
   into `n` repeated calls to `random_get` (already imported via #1322).
   Generate a `__crypto_random_bytes(len, outPtr)` helper next to
   `Math_random` in `src/codegen/math-helpers.ts`. `randomUUID()` in WASI
   mode builds a v4 UUID string from 16 random bytes.

5. **Type declarations**: emit
   `declare function randomBytes(size: number): Uint8Array;`
   `declare function randomUUID(): string;` from `preprocessImports`
   instead of `any`.

## Acceptance criteria

```ts
import { randomBytes, randomUUID } from "node:crypto";

function main(): void {
  const id = randomUUID();
  const bytes = randomBytes(16);
  console.log(id.length, bytes.length);   // 36 16
  // Two consecutive calls produce different results.
  console.log(randomUUID() !== randomUUID()); // true
}
main();
```

- Works in Node JS-host target (uses `node:crypto`).
- Works in WASI target (uses `random_get`).
- Compiled output is reproducible across targets given identical seed
  injection (test-only hook acceptable).

Equivalence test: assert byte length matches request and successive UUIDs
differ.

## Files to modify

- `src/index.ts` — extend or reuse `node_builtin_fn` `ImportIntent`.
- `src/runtime.ts` (≈line 1850 `node_builtin` case) — bind crypto fns; browser
  fallback to `globalThis.crypto`.
- `src/import-resolver.ts` — typed declare-emission for crypto.
- `src/codegen/expressions/calls.ts` — call-site routing.
- `src/codegen/math-helpers.ts` — WASI `__crypto_random_bytes` + UUID v4
  helper that consumes `random_get`.
- `tests/equivalence.test.ts` — "crypto randomBytes / randomUUID" block.
