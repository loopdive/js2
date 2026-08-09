# opus-sa-assertfail — standalone `assertion_fail` triage (paused 2026-07-25)

Lane: standalone `assertion_fail` bucket (12,038) after the #3592
de-vacuification. **Paused mid-flight by the lead (box oversubscribed).**
Everything below is measured, not inferred.

## 1. Data used

| Artifact                                                                                                   | What it is                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/standalone-baseline.jsonl`                      | PRE-#3592 standalone (27,709 pass)  |
| `/workspace/.claude/worktrees/agent-aeb44e25b6597e676/.tmp/mg3601/test262-standalone-results-merged.jsonl` | POST-#3592 standalone (22,621 pass) |
| `/workspace/.claude/worktrees/agent-a9035bbe084665a85/.tmp/flipped.jsonl`                                  | the 5,114 `pass`→`fail` flips       |

Status deltas across the two: `pass` 27,709 → 22,621 · `fail` 13,236 → 18,325 ·
`compile_error` 7,003 → 7,002. **5,114 tests flipped `pass`→`fail`** — that is
the de-vacuification yield and the whole prioritised subset.

## 2. Taxonomy of the 5,114 newly-revealed failures

By `error_category`: `assertion_fail` 4,496 · `other` 371 · `type_error` 179 ·
`illegal_cast` 43 · `null_deref` 21 · `range_error` 3 · `oob` 1.

By normalised message (top clusters):

|   Count | Normalised message                                                                  |
| ------: | ----------------------------------------------------------------------------------- |
|     938 | `Expected a TypeError to be thrown but no exception was thrown at all`              |
| **924** | **`Expected a undefined but got a different error constructor with the same name`** |
|     386 | `Expected a undefined to be thrown but no exception was thrown at all`              |
|     222 | `Expected SameValue(«"S"», «"S"») to be true`                                       |
|     213 | `Expected a RangeError to be thrown but no exception was thrown at all`             |
|     181 | `Expected SameValue(«N», «N») to be true`                                           |
|     166 | `Expected a SyntaxError to be thrown but no exception was thrown at all`            |
|     162 | `Expected SameValue(«undefined», «N») to be true`                                   |
|     134 | `Expected SameValue(«null», «[object Object]») to be true`                          |
|     131 | `Expected SameValue(«undefined», «"S"») to be true`                                 |
|     107 | `Expected SameValue(«NaN», «undefined») to be true`                                 |
|     104 | `TypeError: Cannot access property on null or undefined`                            |
|     101 | `Expected a ReferenceError to be thrown but no exception was thrown at all`         |
|      75 | `Array.prototype.map is not yet callable as a value in --target standalone`         |

The `…to be thrown but no exception was thrown at all` family (938 + 386 + 213 +
166 + 101 ≈ 1,804) is **heterogeneous** — each is a separate missing-throw
semantic gap. Not a single-fix cluster.

## 3. ROOT CAUSE FOUND + FIXED (the 924 cluster) — see #3614

Split of the 924 by the constructor passed to `assert.throws`:
**854 `Test262Error`**, 33 `DummyError+TypeError`, 14 `DummyError`, 9
`ExpectedError`, 5 `MyError`, 5 `Test262Error+TypeError`, 3 `CustomError`,
1 `StopReverse`.

Upstream `harness/assert.js` runs `thrown.constructor !== expectedErrorConstructor`
for **every** caught value. Measured in standalone (probe below):

- `thrown.constructor` on a `new Test262Error(...)` value → **`undefined`**
- `expectedErrorConstructor.name` (read off a **parameter**) → **`undefined`**
  → both names compare equal → the "same name" branch → that exact message.
- `Test262Error === Test262Error` and identity **through a parameter** → already
  TRUE (the cached closure singleton), so only the back-pointer was missing.

Why: `emitStandaloneTest262Error` (#2902) lowers `new Test262Error(msg)` to an
`$Error_struct` with `$name = "Test262Error"`. `fillExternGetErrorProps`
(`src/codegen/registry/error-types.ts`) answers `.constructor` only for genuine
builtin errors — its `Error`-tag arm is explicitly `$name === "Error"`-guarded,
so Test262Error fell through to the miss.

**Fix (implemented, branch `issue-3614-standalone-test262error-ctor-identity`):**
in `fillExternGetErrorProps`, add a `userCtorArms` block ahead of the builtin
`ctorArms` that, when `$name` matches a `USER_ERROR_CTOR_IDENTITY_NAMES` entry
(today just `Test262Error`), returns `ctx.funcClosureGlobals.get(name)` — the
SAME `__fn_closure_<Name>` global the bare identifier resolves to, so `===`
holds by `ref.eq`. It only **reads** the global (never materialises it), which
avoids minting a `ref.func` trampoline at finalize — the late-funcidx-shift
hazard this file already documents.

**Measured, via the CI-equivalent pool path:** probe `.tmp/probes/ctor2.js`
BITS `231 → 245` — bit 2 (`thrown.constructor === undefined`) cleared, bit 16
(`thrown.constructor === expected`) set. `tsc --noEmit` clean.

## 4. How to reproduce locally (this cost ~1h to discover — do not redo it)

`runTest262File` (`tests/test262-runner.ts`) is **NOT** the CI path and gives
misleading results: it renders thrown payloads via `originalHarnessThrownText`,
which does not use `tryNativeExnRender`, so every standalone Test262Error shows
as `uncaught Wasm-GC exception (non-stringifiable payload)` instead of its real
message. The CI shard path is
`assembleOriginalHarness` → `CompilerPool(n, "unified")` → `scripts/test262-worker.mjs`.

Working reproduction harness: `.tmp/run-pool.mts` in worktree
`/workspace/.claude/worktrees/agent-a9035bbe084665a85`. Prerequisites (the
worker imports two generated bundles that are not in the tree):

```
npx esbuild scripts/compiler-bundle-entry.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen \
  --external:@typescript/native-preview '--external:@typescript/native-preview/*'
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript --external:binaryen
```

Probe idiom: a `.js` file with a test262 frontmatter block that accumulates
`bits` and ends with `throw new Test262Error("BITS=" + bits)` — the thrown
message is what the runner records, so it is the only reliable output channel.
Probes live in `.tmp/probes/`.

Note: the standalone lane is ALWAYS `oracle_lane: "honest"`; the #3461 fast
native-harness oracle is host-lane-only, so it is not a factor here.

## 5. Remaining work in this lane (not started)

1. Land #3614 and measure the real delta on a full standalone shard run.
2. `expectedErrorConstructor.name` on a compiled closure read **through a
   parameter** is still `undefined` (a static `Test262Error.name` read works).
   This is the standalone twin of #3429 (host), whose
   `maybeStampCompiledFunctionArgName` is gated `if (ctx.standalone) return false`.
   Fixing it does not flip tests by itself but repairs many failure MESSAGES,
   which currently mislabel clusters.
3. The 70 non-Test262Error members of the 924 (`DummyError`, `MyError`,
   `ExpectedError`, `CustomError`, `StopReverse`) are plain fnctor instances,
   not `$Error_struct`s — they need the general fnctor `.constructor`
   back-pointer. This is the standalone counterpart of open issue **#3486**.
4. `SameValue` clusters (222 + 181 + 162 + 134 + 131 + 107 + …) are untriaged;
   they need per-cluster repros — the bucket label is a symptom, not a cause.
5. The ~1,804 "no exception was thrown at all" family is heterogeneous —
   triage by which operation failed to throw, not by directory.

## 6. State

- Branch `issue-3614-standalone-test262error-ctor-identity` in worktree
  `/workspace/.claude/worktrees/agent-a9035bbe084665a85`, based on
  `upstream/main` @ `c429f7800`. Fix committed; issue file NOT yet written;
  no PR opened; no regression test written yet.
- Claim held: `node scripts/claim-issue.mjs --release 3614 ttraenkler/opus-sa-assertfail`
  to hand it off.
