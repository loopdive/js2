---
id: 6450
title: "node lane: `createHash` imported from `'crypto'` compiles to null — hono `src/utils/crypto.test.ts` 'Should create hash for Buffer' reads `update is not a function`"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

On the `--platform node` lane a named import from the `crypto` builtin compiles
to a **null** binding. Measured on `3e92241ecc` with the
[#6425](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6425-hono-crypto-textencoder-not-a-constructor)
fix applied (`.tmp/6425/probe2.mjs`, a two-test module with
`DOGFOOD_PLATFORM: "node"`):

```js
import { createHash } from "crypto";
createHash("sha256")            // → null   (native: a Hash object)
createHash("sha256").update(…)  // → "Cannot access property on null or undefined"
```

Native lane 2/2, Wasm lane 0/2. The compile succeeds with zero errors — the
provider simply hands back null, so every failure surfaces one call later as a
property access on null.

## Why it is filed now

It is the **last remaining failure** in hono's `src/utils/crypto.test.ts` after
#6425. That file went 0/4 → 3/4; the fourth test, `Should create hash for
Buffer`, still reads `update is not a function`.

Two distinct things are probably in play there and this issue covers both:

1. **The builtin provider returns null** (the reduction above, independent of
   hono).
2. **A same-name local export may shadow the import.** hono's own
   `src/utils/crypto.ts` exports an `async function createHash`, and the file
   under test imports from both. The message the suite reports is `update is
   not a function` rather than the null-property message the bare reduction
   gives, which is what you would see if the binding resolved to the local
   async export (whose return is a Promise) instead of the builtin. Confirm
   which binding the compiled code picked before fixing either half.

## Acceptance criteria

1. `import { createHash } from "crypto"` (and `"node:crypto"`) on the node lane
   yields a working hash object: `.update(…)`/`.digest(…)` round-trip against
   the native oracle.
2. If the shadowing half is real, a named import and a same-name local export
   in one module resolve to the correct binding at each use site, with a
   regression test that fails on the parent.
3. hono `src/utils/crypto.test.ts` reads 4/4.
4. A/B over the 17 upstream suites at one HEAD: hono up, nothing else down.

## Notes

- Reduction to start from: `.tmp/6425/probe2.mjs` in the #6425 worktree — a
  standalone two-test module, no hono checkout needed.
- Check the `node:` builtin provider table first: the compile reports no
  diagnostic, so the name is being resolved to *something* that evaluates to
  null rather than being rejected, which points at a registered-but-empty
  provider entry rather than a missing one.
- `src/utils/buffer.test.ts` (same node lane) sits at 5/10 after #6425; its
  remaining failures are `Response is not defined` and friends, a separate
  host-global gap — do not bundle those here.

## Implementation Plan

**Diagnosis (measured on upstream/main 54c36a9fe3, `.tmp/6450/variants.mjs` via `compileProject`, `platform: "node"`).** The provider is NOT the bug — the runtime `node_builtin` arm (`src/runtime/platform-capability-adapter.ts:162`) hands back the real `require("crypto")` module, and `import * as c from 'crypto'; c.createHash(...)` works (`__extern_method_call_1` on the `__node_crypto` thunk). The defect is in codegen, in the multi-file lane the dogfood runner uses:

- `collectGraphNodeBuiltinImports` + `registerNodeBuiltinImports` (`src/codegen/extern-declarations.ts:1785`) register `createHash` as a `declaredGlobals` **member** binding. A bare VALUE read works (`js-ch-read` → `__extern_get(__node_crypto(), "createHash")`, the #4616 path in `identifiers.ts:1787`).
- A direct CALL `createHash('sha256')` goes through `compileCallExpression`'s identifier path in `src/codegen/expressions/call-identifier.ts`, which has **no arm for a node-builtin member binding** (grep: `declaredGlobals` is never consulted there). It falls through to the bare-name `closureMap`/`funcMap` ladder (~L1843–1892): with a same-named function anywhere in the graph it calls THAT (probe p2: hono-shaped `lib.js` `export const createHash = async …` → unhandled `Failed to normalize algorithm` — this is the issue's "shadowing" half, confirmed real, and it is a cross-module name leak, not TS shadowing); with none it reaches the graceful `ref.null.extern` (w1 WAT: `func $hex … ref.null extern`, the issue's null reduction). `randomUUID()` from the same import is null for the same reason (the `__nodefn__` typed stubs exist only in the single-file `preprocessImports` lane).
- Secondary: `typeof createHash` folds to the constant `"undefined"` (`compileTypeofExpression`) — fix if cheap, else note.
- Single-file `compile()` lowers `createHash` to a raw `env.createHash` import (no manifest classifier entry → null). Out of scope for hono; leave a note in the issue.

**Fix — one new arm in `call-identifier.ts`**, placed AFTER `isLocallyShadowed`/`hasVisibleClosureStorage` are computed (~L1739) and BEFORE the `tryCompileImmutablePropertyCallableAlias`/`closureMap`/`funcMap` resolution (~L1786+). Order matters: lexical/module/captured shadows must still win (that is what `!isLocallyShadowed && !hasVisibleClosureStorage` guards), but the graph-wide bare-name registries must NOT win over an import specifier declared in this file. Gate: `!ctx.wasi`, `ctx.nodeBuiltinGlobals.has(funcName)`, `ctx.declaredGlobals.get(funcName)?.member !== undefined`, and `calleeBindingDecl` (already computed via `ctx.oracle.valueDeclarationOf`) is an `ImportSpecifier` whose `ImportDeclaration.moduleSpecifier` satisfies `isNodeBuiltin` (import from `src/import-resolver.ts`). Emit: `call <member.funcIdx>` (module thunk) · `addHostStringConstantGlobal(member)` · args array via `__js_array_new` + `emitHostMethodCallArgs` (`src/codegen/host-method-args.ts`) · `ensureLateImport("__extern_method_call", [externref×3], [externref])` exactly as `calls-optional.ts:455` / `own-property-method-shadow.ts:251` do, then `flushLateImportShifts`; return `{kind:"externref"}`. Put the body in a new helper `src/codegen/expressions/node-builtin-member-call.ts` (call-identifier.ts is under the #3400 per-function LOC ceiling — run `check-func-budget` before committing). `this` binds to the module object, which is what `crypto.createHash` needs.

**Probe first** (5 min): copy `.tmp/6450/variants.mjs` shape — six one-file `compileProject` variants, grep WAT for `__node_crypto`/`ref.null extern`; today `js-ch-call`/`ts-ch-call` show no import at all. After the fix they must show `__node_crypto` + `__extern_method_call`.

**Regression test** `tests/issue-6450-node-builtin-named-call.test.ts`, fixtures `tests/fixtures/issue-6450/{entry.js,lib.js}` (untyped `.js`, mirror `tests/issue-6425-node-lane-textencoder-construct.test.ts`): `lib.js` exports a same-named async `createHash(data, algorithm)` (hono's shape) plus `sha256`; `entry.js` imports `{ createHash, randomUUID } from 'node:crypto'` and `{ sha256 } from './lib.js'`, exports `hex()` (`createHash('sha256').update('a').digest('hex')`), `uuid()`, `viaLib()`. Assert `hex()` equals Node's own digest, `uuid().length === 36`, `viaLib()` still returns lib's Promise (anti-vacuity: the graph function is NOT stolen), and the WAT contains `__node_crypto` and no `env.createHash`. Parent: `hex()` throws (lib's rejection / null property). Add the one-file variant (no lib.js) too — that is the null reduction. Also cover `'crypto'` (bare) and `'node:crypto'`.

**Dogfood expectation:** hono `src/utils/crypto.test.ts` 3/4 → 4/4 (hono ~261 → ~262/324). Every other suite's node-builtin named imports are value reads (#4616 jest `EOL`, `isNativeError`) or namespace calls, so webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 stay flat — run the 17-suite A/B at one HEAD (AC4). **Standalone lane:** node builtins are a JS-host-only surface (WASI errors at registration; standalone has no `__node_*` thunk), the arm is `!ctx.wasi`-gated — expect zero test262/standalone movement.

## Dispatch

**opus** — mechanical once the arm is placed, but the placement inside the call-identifier resolution ladder (before closureMap/funcMap, after lexical shadows) and the per-function LOC budget need judgment; the diagnosis is already confirmed so no exploration is left.
