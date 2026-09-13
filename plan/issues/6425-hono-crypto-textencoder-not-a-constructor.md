---
id: 6425
title: "hono crypto: `new TextEncoder()` in compiled code answers `TextEncoder is not a constructor` — the whole of src/utils/crypto.test.ts (4 tests)"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-12
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: correctness
---

## Problem

hono's `src/utils/crypto.test.ts` reads **0/4** in the Wasm lane, 4/4 native.
Three of the four carry the same host-boundary failure:

```
sha256                                              TextEncoder is not a constructor
sha1                                                TextEncoder is not a constructor
Should not be the same values - compare difference  unhandled rejection: TypeError: TextEncoder is not a constructor;
                                                                        TypeError: TextEncoder is not a constructor
Should create hash for Buffer                       update is not a function
```

`TextEncoder` **is** supplied to the worker: `getWebHostConstructors()`
(`src/runtime/web-host-constructors.ts`) forwards it whenever
`typeof globalThis.TextEncoder === "function"`, which holds on every Node the
harness runs on. So the binding reaches the import object and the compiled
`new TextEncoder()` still does not construct — the defect is on the
compiled-code side of the extern-constructor boundary, not in the dependency
map.

It has been visible but unowned: #5338 named it "adjacent, do not chase" and
closed without filing it.

## Why it is filed now

The third test used to read **passed**. It compares two values that are
unawaited Promises (the
[#5371](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5371-await-hands-back-the-promise)
family), so the comparison was trivially satisfied while two `TextEncoder`
rejections were dropped on the floor unobserved.
[#5369](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5369-unhandled-host-rejection-zeroes-test-module)
now attributes those rejections to the test that leaked them, so the file reads
0/4 honestly instead of 1/4. hono's headline moved 258/324 → 257/324 for that
reason alone — an accuracy correction, and the reason this defect now has a
number.

## Acceptance criteria

1. `new TextEncoder()` in compiled JS-host-lane code constructs a real host
   `TextEncoder`, and `.encode()` on it returns something the host accepts.
2. hono `src/utils/crypto.test.ts` reads at least 3/4 (the fourth,
   `update is not a function`, is a separate Buffer-surface gap — diagnose but
   do not bundle).
3. A regression test in `tests/` that constructs a `TextEncoder` from compiled
   code and round-trips a string, independent of hono.
4. A/B over the 17 upstream suites at one HEAD: hono up, nothing else down.

## Notes

Start by checking how the extern constructor is resolved for the web lane's
forwarded constructors versus the `node:` namespace ones — hono's other
`TextEncoder` uses may go through a different path, since only this file
reports the failure.

## Implementation Plan

**Confirmed cause (measured on 23a0ddaa26, `.tmp/6425/probe.mjs`).** The dependency map is fine; the defect is lane-specific. `crypto.test.ts` (and `buffer.test.ts`) run with `DOGFOOD_PLATFORM: "node"` (`tests/dogfood/hono-upstream-suite.mjs:88`), and `--platform node` type-checks against the DOM-free composite lib (`src/checker/index.ts` `DOM_FREE_LIB_NAME`, ~L274-292), which declares no `TextEncoder`. So `ctx.oracle.isUnresolvableIdentifier(TextEncoder)` is true and the #4246 unresolvable arm of `tryNonConstructableNewTarget` (`src/codegen/expressions/new-non-constructable-value.ts` ~L170-185, called from `new-super.ts:6583`) emits a static `TypeError("TextEncoder is not a constructor")` — *before* the synthetic-extern recovery arm at `new-super.ts:6903-6909` (`!className && externClasses.has(name) && resolvesToAmbientGlobal`) that exists for exactly this case (`registerBuiltinExternClasses` registers `TextEncoder`/`TextDecoder` synthetically at `extern-declarations.ts:409-452`). Web lane has lib.dom, resolves the symbol, and emits `env.TextEncoder_new`; node lane emits `string_constants."TextEncoder is not a constructor"` and never imports `TextEncoder_new`. Every other hono `TextEncoder` user is on the web lane, which is why only this file (and `buffer.test.ts`) reports it.

**Fix (one guard, codegen side).** In the unresolvable arm of `tryNonConstructableNewTarget`, decline (`return undefined`) when `ctx.externClasses.has(callee.text)`: an unresolvable identifier that names a registered host extern class is an ambient host global, not an undeclared name. Flow then reaches the L6905 arm and emits `TextEncoder_new`, which the node worker already satisfies (`upstream-suite-compile-worker.mjs:131` assigns `getWebHostConstructors()`). This also covers `TextDecoder` and any other synthetically registered class under the DOM-free lib. Do NOT add a checker-side `declare var TextEncoder` to `buildNodeEnvDts` unless the guard proves insufficient — a real declaration would route through the generic extern collector and could change the method shapes the web lane gets from the synthetic registration.

**Order-preservation constraints.** Keep the arm at `new-super.ts:6583` where it is; only narrow its unresolvable branch. `new undeclaredName()` must still throw (S11.2.2_A2 ReferenceError/TypeError path) — the exemption applies only to names in `ctx.externClasses`, and "unresolvable" already guarantees no user binding shadows them. Standalone/WASI are untouched: the synthetic registration is gated `!ctx.nativeStrings && !ctx.strictNoHostImports`, so `externClasses.has("TextEncoder")` is false there and `tests/issue-1752.test.ts` (no `TextEncoder_*` imports standalone) stays green.

**Probe first.** `.tmp/6425/probe.mjs node nocrypto` (already written) must flip from 0/2 to 2/2; `.tmp/6425/imports.mjs` must show `TextEncoder_new` for node.

**Regression test** `tests/issue-6425-node-lane-textencoder-construct.test.ts`, untyped JS fixtures under `tests/fixtures/issue-6425/` (`lib.js` exporting `enc = () => new TextEncoder().encode("炎")` + a decoder round-trip; `entry.js` importing it), compiled with `compileProject(..., { allowJs: true, target: "gc", platform: "node" })` and instantiated with `buildImports(result.imports, { TextEncoder, TextDecoder })`. Assert: (1) `result.imports` contains `TextEncoder_new`; (2) no string-pool entry `TextEncoder is not a constructor`; (3) round-trip `decode(encode("炎")) === "炎"` and byte length 3. Anti-vacuity controls: the same fixture under `platform: "web"` passes on parent AND child (proves the assertion measures the node lane), and `new NoSuchCtor()` under node still throws a TypeError (proves #4246 is not disabled). Fails on parent with the exact `not a constructor` message.

**Fourth test — diagnosed, not bundled.** `.tmp/6425/probe2.mjs`: `createHash('sha256')` imported from `'crypto'` on the node lane returns **null** ("Cannot read properties of null (reading 'update')") — the `node:crypto` named import is a null provider. In hono the local `./crypto` module also exports an async `createHash`, and the compiled binding resolves to that local export instead of the builtin, which is why the message reads `update is not a function`. File both as one follow-up (node:crypto named-import provider + same-name local-export shadowing an import).

**Expected movement.** hono `src/utils/crypto.test.ts` 0/4 → 3/4; `src/utils/buffer.test.ts` (also node lane, uses `TextEncoder`) may gain. hono headline up ≥3; webpack/three/clsx/cookie/lodash/redux/axios/stylelint/tailwindcss/jsdom/styled-components/uuid/marked/moment/prettier/jest unchanged (all web lane or no `new TextEncoder`). Standalone lane: zero delta expected; run `tests/issue-1752.test.ts`, `tests/issue-1588-str-to-utf8.test.ts` and the new-expression test262 negatives (`language/expressions/new/S11.2.2_A*`) as guards. A/B the 17 suites at one HEAD per AC4.

## Dispatch

**opus** — one-line guard in a well-mapped arm, but the test must prove non-vacuity across two lanes and the A/B over 17 suites needs careful reading; no design ambiguity remains.

## Resolution

The plan's diagnosis held in full; the fix is the single guard it specified.

**Mechanism.** `--platform node` type-checks against the DOM-free composite lib
(`src/checker/index.ts`, `DOM_FREE_LIB_NAME`), which declares no `TextEncoder`
or `TextDecoder`. So `ctx.oracle.isUnresolvableIdentifier(TextEncoder)` was
true, and the #4246 unresolvable arm of `tryNonConstructableNewTarget`
(`src/codegen/expressions/new-non-constructable-value.ts`) turned every
`new TextEncoder()` into a **static** `TypeError("TextEncoder is not a
constructor")` — reached at `new-super.ts:6583`, *before* the recovery arm at
`new-super.ts:6905` (`!className && externClasses.has(name) &&
resolvesToAmbientGlobal`) that the synthetic registration in
`extern-declarations.ts` exists to feed. The web lane has lib.dom, resolved the
same name, and emitted `TextEncoder_new` all along, which is why only hono's two
node-lane files ever reported it. The binding was never missing: the node worker
already supplies it (`upstream-suite-compile-worker.mjs` assigns
`getWebHostConstructors()`).

**Fix.** One guard on that arm — decline (`!ctx.externClasses.has(callee.text)`)
when the unresolvable identifier names a registered host extern class. An
unresolvable name that *is* a registered extern class is an ambient host global
the lib failed to declare, not an undeclared name. Flow then reaches the L6905
arm and emits `TextEncoder_new`. `+17` lines, all but one of them the comment.

**Order preservation.** The arm stays where it is; only its unresolvable branch
narrows. `new undeclaredName()` still throws (asserted as a control in the
regression test). Standalone/WASI are untouched — the synthetic registration is
gated `!nativeStrings && !strictNoHostImports`, so `externClasses` carries no
`TextEncoder` there; `tests/issue-1752.test.ts` (5/5) and
`tests/issue-1588-str-to-utf8.test.ts` (10/10) stay green.

**Probe.** `.tmp/6425/probe.mjs` — a two-test `new TextEncoder()` module:
node lane 0/2 → 2/2, web lane 2/2 → 2/2 (unchanged control).

**Regression test.** `tests/issue-6425-node-lane-textencoder-construct.test.ts`
with untyped JS fixtures at `tests/fixtures/issue-6425/`. 4 tests: 2 fail on the
parent (`expected […] to include 'TextEncoder_new'`, and the round-trip), 4 pass
with the fix. The two anti-vacuity controls — the same fixture on the web lane,
and `new NoSuchCtor()` still pooling `NoSuchCtor is not a constructor` — pass on
**both** parent and child, which is what proves the other two assertions measure
the node lane specifically rather than the guard's mere existence.

**A/B, 17 upstream suites at `3e92241ecc`, one arm at a time:**

| suite | base | fix |
| --- | --- | --- |
| hono | **261/324** | **265/324** |
| webpack | 16/16 | 16/16 |
| three | 17/18 | 17/18 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| lodash | 59/62 | 59/62 |
| redux | 67/82 | 67/82 |
| axios | 208/231 | 208/231 |
| stylelint | 108/108 | 108/108 |
| tailwindcss | 13/13 | 13/13 |
| jsdom | 6/6 | 6/6 |
| styled-components | 9/9 | 9/9 |
| uuid | 75/75 | 75/75 |
| marked | 16/30 | 16/30 |
| moment | 10/10 | 10/10 |
| prettier | 108/151 | 108/151 |
| jest | 335/356 | 335/356 |

The 16 non-hono suites are **byte-identical per file**, not merely equal in
headline. hono's +4 is exactly two files: `src/utils/crypto.test.ts` 0/4 → 3/4
and `src/utils/buffer.test.ts` 4/10 → 5/10.

**Acceptance criteria** 1-4 all met (AC2 asked for ≥3/4; measured 3/4).

**Fourth test — diagnosed, filed, not bundled.** `Should create hash for Buffer`
still reads `update is not a function`. Reduced independently of hono in
`.tmp/6425/probe2.mjs`: on the node lane `import { createHash } from "crypto"`
compiles to a **null** binding (native 2/2, Wasm 0/2, compile clean). Filed as
[#6450](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6450-node-crypto-createhash-null-provider),
together with the possible same-name local-export shadowing that makes hono's
message differ from the bare reduction's.
