---
id: 5362
title: "REGRESSION on main: a typed array built in compiled code no longer reaches a host WebCrypto method as a typed array — hono 244 → 220/324, all 24 in `cookie.test.ts` (`SubtleCrypto.importKey: 2nd argument is not instance of ArrayBuffer …`)"
status: done
sprint: current
created: 2026-09-06
updated: 2026-09-06
completed: 2026-09-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-06 (#5362): the fix is 14 lines in the compiled→host marshaller
# `_wrapForHost` — 4 of code, the rest the comment naming why the check must
# sit BEFORE `_hostProxyCache`. `_wrapForHost` is the single function every
# host-call argument crosses, and "which host representation does this
# compiled value get" is exactly its question, so the growth can be relocated
# neither to a smaller file nor to a smaller function without putting the
# decision somewhere it does not belong (`_wrapVecForHost`, whose contract is
# to return an ARRAY-backed view). The comment was already cut once to keep
# this to the minimum; the long-form rationale lives in the test header.
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::_wrapForHost
---

## Problem

hono dropped **244/324 → 220/324** on `main` between `01ce47aba7` and
`efa9e76f07` (27 commits, 2026-09-06 ~03:00–06:00Z). All 24 losses are in
**one file**, `src/utils/cookie.test.ts`, which now fails as a **whole
module** — per-test `wasmError` is `null`; the message is in
`report.compile.details[N]`:

```
SubtleCrypto.importKey: 2nd argument is not instance of ArrayBuffer, Buffer, TypedArray, or DataView
```

Reported by the #5342 agent on clean `main` at `efa9e76f07`, and independently
by the #5346 agent, whose *parent-code* control run also gave 220. **Not yet
measured by the lead — step 1 is to reproduce.**

The shape: hono's signed-cookie helper (`src/utils/cookie.ts`) does

```js
const secretBuf = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret
const key = await crypto.subtle.importKey('raw', secretBuf, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign'])
```

Both the string-secret tests and the binary-secret test
(`new Uint8Array([172, 142, …])` at `cookie.test.ts:911`) hand a typed array
produced in **compiled** code to a **host** WebCrypto method. Until this
window that crossed the boundary as a real `Uint8Array`; now the host sees
something that is not a buffer view. Whole-module failure means it dies
before the first `it` body completes — establish whether it is module-init
(a hoisted `importKey`) or the first call.

## Candidates — three `src/`-touching merges in the window

| merge | PR | what it changed | why it could do this |
|---|---|---|---|
| `fc4d4e6050` | #5646 (#5343) | `call-tail-dispatch.ts`: a registry miss now routes to the **dynamic call ladder** instead of falling through silently | `crypto.subtle.importKey(...)` is a host method on a host global; if the ladder boxes a WasmGC typed-array carrier generically (`extern.convert_any` / `__box_*`) instead of the typed-array→host conversion the direct arm used, the host receives a wrapper, not a view |
| `4001bbe811` | #5642 (#5334) | `callable-rest-bridge.ts` + runtime: host callables with rest params get a wrapper | `importKey` takes five arguments; a generic re-marshal in the bridge would turn a typed array into a plain array/object |
| `d58086f75d` | #5641 (#5250) | `src/runtime.ts` Temporal error semantics | least likely — but it touches the host runtime |

**Two measurements settle it**: the reduction at `4001bbe811` (after #5642,
before #5646) and at `b26dd237bc` (before #5642). Use the reduction, not the
full suite, for the bisect — seconds instead of minutes.

## Acceptance criteria

1. Culprit PR named, with the two bisect results quoted. **Fix forward in the
   culprit's mechanism** — do not revert any of the three PRs; each fixed
   real failures (#5343 hono/axios, #5334 jest +6, #5250 Temporal).
2. `cookie.test.ts` back to its pre-regression count (measure it at
   `01ce47aba7` yourself — expected 24/35) and hono **≥ 244/324** on the fixed
   HEAD.
3. Regression test under `tests/`, **untyped `.js` two-file fixtures**: (a) a
   `new Uint8Array([...])` literal and (b) a `TextEncoder().encode()` result,
   each passed from compiled code to a host method that requires a buffer view
   (`crypto.subtle.importKey('raw', buf, {name:'HMAC', hash:'SHA-256'}, false,
   ['sign'])` on Node's webcrypto is the real thing and needs no shim), with
   (c) an anti-vacuity control that a plain array literal still arrives as a
   plain array. Fails on the regressed parent, passes with the fix — exact
   counts both ways.
4. **A/B at one HEAD**, 17 suites, per test file. **Anchors on current main
   (2026-09-06 08:40Z)**: hono **220**/324 (regressed) · lodash **58**/62
   (#5342 landed) · jest 335/356 · prettier 101/151 · axios 200/231 · redux
   63–64/82 · marked 9/30 · three 17/18 · webpack 16 · clsx 32 · cookie 63740
   · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · moment 10 ·
   stylelint 108. hono moves up; nothing else moves. If lodash or redux read
   differently on your base, re-run that suite alone before believing it.
5. All ratchet gates green including `pnpm run check:dogfood-validation`.

## Implementation Plan

0. Base recipe (mandatory, the agent worktree starts ~3,800 commits stale):
   fetch `upstream main` with the LFS overrides or STOP; detach onto
   `upstream/main`; `rev-parse HEAD` must equal `rev-parse upstream/main`;
   dirty count must be 0; only then branch.
1. Reproduce on current `main`: run the hono suite alone
   (`node --import tsx tests/dogfood/hono-upstream-suite.mjs`), read
   `compile.details` for `cookie.test.ts`, quote the exact error and which
   phase (`errors[]` / `validationError` / `runtimeError`).
2. Reduce in a standalone `.mjs` via `compileAndRunUpstreamModule` (never
   vitest + `instantiateWithRuntime`): a two-file untyped project whose entry
   does `const k = await crypto.subtle.importKey('raw', new Uint8Array([1,2,3]),
   {name:'HMAC', hash:'SHA-256'}, false, ['sign']); return k.type;`. Confirm
   the same message. Also try the `TextEncoder` form and a direct host
   function `(b) => ArrayBuffer.isView(b)` — the last one tells you whether
   it is *this* call shape or every typed-array crossing.
3. Dump WAT for the call. Which arm marshals argument 2 — the typed-array→host
   conversion (grep `src/runtime.ts` for the typed-array export/import pair,
   and `src/codegen` for how a `ref $Uint8Array` carrier is coerced to
   `externref` at a host-call boundary), or a generic box?
4. Bisect with the reduction at `4001bbe811` and `b26dd237bc`.
5. Fix in the culprit's mechanism:
   - If #5646: the dynamic ladder must coerce typed-array carriers through the
     same conversion the direct host-call arm uses (or the registry-miss
     fallthrough must not claim calls whose receiver is a host global —
     whichever is the narrower, sound change).
   - If #5642: the rest bridge must pass each argument through the direct
     call's coercion; do not re-marshal.
   - If #5641: find the runtime helper whose signature/behaviour changed and
     restore the typed-array branch.
6. Regression test; A/B; one PR; set `status: done` here with the culprit,
   the mechanism, and the two bisect measurements recorded.

## Dispatch

Model: **opus**. A two-step bisect with a seconds-long reduction, three
named candidates, and a fix inside an existing coercion arm. No design
decision — but the previous three regressions in this effort (#5333, #5332,
#5335, #5348) were each misattributed once before being measured, so the
bisect is not optional.

## Resolution

**Culprit: `d58086f75d` — PR #5646's sibling `#5641` (issue #5250), the
`_resolveHostField` numeric-shape-miss change in `src/runtime.ts`.** The
candidate table above ranked it *least* likely; it is the one. Neither #5646
(`call-tail-dispatch`) nor #5642 (`callable-rest-bridge`) is involved — both
were already in the tree at bisect point A and the failure predates them.

**#5641 is not itself wrong, and it is not reverted.** What it changed is one
field read; what that read unmasked is a marshalling defect that was already
there. The fix is in the marshaller.

### Bisect (fast probe: hono `src/utils/cookie.test.ts` alone, ~2 min each)

The probe re-runs the already-generated
`.hono-upstream-suite-generated/src/utils/cookie.test.ts` through
`compileAndRunUpstreamModule`. `tests/dogfood/` has **no diff** across the
window, so the generated source is identical at every point and only `src/`
moves.

| commit | contents | cookie.test.ts |
|---|---|---|
| `01ce47aba7` | parent, before the window | **24/35** |
| `d58086f75d` | **+ #5641** (`_resolveHostField`) | **0/35** — whole-module crash |
| `b26dd237bc` | + #5644 (`temporal-provider`) | 0/35 (spec's point B) |
| `4001bbe811` | + #5642 (rest bridge) | 0/35 (spec's point A) |
| `59063c653a` | current main | 0/35 |

Both measurements the spec asked for are in that table; the extra two rows are
what pinned the commit, because A and B were *both* red.

### Mechanism

Three facts, each measured rather than inferred:

1. **The failing argument is a branded compiled typed array.** Instrumenting
   the `extern_class` method shim at `src/runtime.ts` `invokeMethod` shows
   argument 2 of the binary-secret `importKey` arriving as
   `struct=true, taKind=2` (kind 2 = `Uint8Array`, set by
   `__register_typed_array`) and leaving `_wrapForHost` as
   `arr=true, ctor=Array, len=15`.
2. **A vec facade can never satisfy a WebIDL `BufferSource`.**
   `_wrapForHost`'s `__is_vec` arm routes every vec to `_wrapVecForHost`,
   which returns a **Proxy**. `ArrayBuffer.isView` reads internal slots, which
   a Proxy does not forward — so the host check fails by construction, not by
   accident. `__make_iterable`'s `convertToJS` already avoided this by
   preferring `_compiledTypedArrayMirror`; `_wrapForHost` did not, so the same
   carrier had two different host shapes depending on which bridge it crossed.
3. **#5641 turned that latent rejection into a fatal one.** The only
   behavioural delta of #5641 in this module is ONE field: `length` on the
   `{ name, hash }` algorithm struct — 34 reads, `0` → absent, logged at the
   #5250 gate itself, no other key. #5641 changes no compiled bytes, and the
   probe shows the two runs make the SAME 24 host-method calls in the same
   order. What differs is their outcomes: with `algorithm.length === 0` Node
   rejected *every* `importKey` with `HmacImportParams.length cannot be 0`
   (that is verbatim the parent's error for two of its 11 failures); with the
   field absent the string-secret calls now succeed, leaving the binary-secret
   `BufferSource` failure as the only rejection — and that one is observed by
   nobody, so it becomes an **unhandled promise rejection** and kills the
   worker process. That is the whole 24 → 0.

   Control, and the load-bearing measurement: with
   `process.on("unhandledRejection")` installed and *nothing else changed*,
   current main scores exactly **24/35** — identical to the parent, same
   failures. So the regression is one un-observed rejection, not eleven broken
   tests.

   Not chased, because it changes neither the diagnosis nor the fix: WHY the
   parent's rejections were all observed while this one is not. The proximate
   suspect is visible in the same probe — `crypto.subtle.verify` receives a
   **`Promise`** where hono passes `secretKey`, i.e. `await getCryptoKey(…)`
   handed back the promise itself rather than the key, on BOTH sides. An
   `await` that does not attach a reaction leaves the rejection unowned. Worth
   its own issue; see the follow-ups below.

### Fix

`src/runtime.ts`, `_wrapForHost`: prefer `_compiledTypedArrayMirror` for a
carrier that codegen branded, before the generic vec facade. 21 lines, no
codegen change, no compiled bytes change.

Two placement decisions are load-bearing:

- **Before the `_hostProxyCache` lookup**, because `_wrapVecForHost` populates
  that cache — a carrier that crossed once as an array facade must not stay
  pinned to it. Identity is still stable: `_compiledTypedArrayMirror` has its
  own per-carrier cache.
- **Gated on the brand** (`_compiledTypedArrayKinds.has`), so an ordinary
  array literal — which shares the identical vec carrier — keeps arriving as a
  plain `Array`. That is the anti-vacuity control in the test.

Write-through is preserved: `_compiledTypedArrayMirror` registers the mirror
with `registerVecMirror`, and a host API that fills the buffer in place
(`crypto.getRandomValues(buf)`) is still observed by compiled code. This is
asserted, because the facade it replaces wrote through immediately and a silent
loss there would have been the obvious way to trade one bug for another.

### Regression test

`tests/issue-5362-compiled-typed-array-host-boundary.test.ts` — untyped `.js`
package half + `.ts` entry, compiled through the dogfood lane's own
configuration (`allowJs`, web platform, `deferTopLevelInit`,
`buildCompiledImports` + `wrapExports`).

| | base (`59063c653a`) | with fix |
|---|---|---|
| all six cases | **4 failed / 2 passed** | **6 passed** |

The two that pass on both sides are the controls: a plain array literal must
still arrive as a plain `Array`, and `crypto.getRandomValues(buf)` must still
be observed by compiled code.

Three lane/shape facts are recorded in the test header because each one, if
guessed wrong, produces a green test that proves nothing — all three were
learned by measuring, after a first version reported a false pass:

- an INLINE `new Uint8Array([…])` call argument does not reproduce (that arm
  builds a host TypedArray); the value must be `const`-bound, as at
  `cookie.test.ts:911`;
- the host call must come from an untyped `.js` module;
- the plain `instantiateWithRuntime` lane does not reproduce at all.

### A/B — all 17 upstream suites, one HEAD, base vs fix, compared per test file

| suite | base | fix | | suite | base | fix |
|---|---|---|---|---|---|---|
| **hono** | **220/324** | **244/324** | | jsdom | 6/6 | 6/6 |
| jest | 335/356 | 335/356 | | styled-components | 9/9 | 9/9 |
| prettier | 101/151 | 101/151 | | uuid | 75/75 | 75/75 |
| axios | 200/231 | 200/231 | | moment | 10/10 | 10/10 |
| stylelint | 108/108 | 108/108 | | marked | 9/30 | 9/30 |
| redux | 66/82 | 66/82 | | three | 17/18 | 17/18 |
| cookie | 63740/63740 | 63740/63740 | | webpack | 16/16 | 16/16 |
| lodash | 58/62 | 58/62 | | clsx | 32/32 | 32/32 |
| tailwindcss | 13/13 | 13/13 | | | | |

Every suite exited 0 and printed its `admitted` headline on both sides.
Compared **per test file**, exactly ONE file moved in the whole corpus:

```
0/35 -> 24/35   hono src/utils/cookie.test.ts
FILES MOVED: 1
```

redux reads 66/82 on this HEAD rather than the issue's 63–64 anchor; it reads
66 on BOTH sides, so it is anchor drift, not movement.

### Not fixed here (deliberate, all pre-existing and all wider than #5362)

- **`ArrayBuffer.isView()` called from COMPILED code** still answers `false`
  for a compiled carrier: `__arraybuffer_isView` receives the raw struct, not a
  host value. That is the compiled-side twin of this defect and changes an
  observable predicate program-wide.
- **A HOST-built typed array loses its brand on the way IN.** A bare
  `new TextEncoder().encode(s)` crossing a module boundary is narrowed by
  `__vec_from_extern_<N>` into a vec that nobody brands, so it comes back out
  as a plain array. Branding it needs the *runtime* type of the incoming host
  value, i.e. a new import — a different mechanism from the one fixed here.
- **`new Uint8Array(<host typed array>)` builds an EMPTY compiled carrier.**
  Found while writing the regression test (`DataError: Zero-length key is not
  supported` — the mirror is length 0, so the vec is too). Unrelated to this
  regression and unaffected by the fix; the test therefore uses hono's other
  producer, `new Uint8Array(n)` + an index-fill loop, which is correct.
- **An unobserved host-promise rejection kills the whole module.** This issue
  is one instance; the general hazard (a rejected host promise that compiled
  `await` never attaches a handler to) is a design question, not a marshalling
  one. Worth its own issue — it converts any single host-API rejection into a
  whole-file zero, which is how a 24-test loss looked like a 244 → 220 cliff.
- hono's signed-cookie tests still fail on signature CONTENT (`AA%3D%3D` — the
  `crypto.subtle.sign` result reads back as one zero byte). Unchanged by this
  fix and unchanged by #5641; it is why cookie.test.ts is 24/35 and not 35/35
  on both sides.
