---
id: 2501
title: "Object.prototype.toString [object X] builtin tag — Array/Function/Date missing (host) + standalone CE (~151 test262)"
status: done
created: 2026-06-19
updated: 2026-06-20
completed: 2026-06-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: object-builtins
goal: spec-completeness
sprint: 64
assignee: ttraenkler/dev3
test262_bucket: object-tostring-tag
test262_count: 151
---

# #2501 — `Object.prototype.toString` `[object X]` builtin tag

## Problem (§20.1.3.6)

`Object.prototype.toString.call(v)` must return `[object X]` where X is the
spec builtin tag. Current state (verified, sd3 2026-06-19):

| receiver       | spec                 | current host         | current standalone |
| -------------- | -------------------- | -------------------- | ------------------ |
| `{}`           | `[object Object]`    | ✅ `[object Object]` | ❌ compile error   |
| `[]`           | `[object Array]`     | ❌ `[object Object]` | ❌ CE              |
| `function(){}` | `[object Function]`  | ❌ `[object Object]` | ❌ CE              |
| `new Date()`   | `[object Date]`      | ❌ `[object Object]` | ❌ CE              |
| `42`           | `[object Number]`    | ✅                   | ❌ CE              |
| `"s"`          | `[object String]`    | ✅                   | ❌ CE              |
| `true`         | `[object Boolean]`   | ✅                   | ❌ CE              |
| `/x/`          | `[object RegExp]`    | ✅                   | ❌ CE              |
| `null`         | `[object Null]`      | ✅                   | ❌ CE              |
| `undefined`    | `[object Undefined]` | ✅                   | ❌ CE              |

So host mode is **partial** (Array/Function/Date wrong → `[object Object]`), and
**standalone hard-errors** on the whole `Object.prototype.toString.call(...)`
form (~151 test262 fails, the jsonl `Object_toString` cluster).

## Two parts

### Part A — host-mode missing tags (smaller)

The `Object.prototype.toString.call` tag dispatch is at
`src/codegen/expressions/calls.ts` ~8430-8458: it has an `isArray`/`isFunc`
branch but `isArray` (`resolveArrayInfo`) doesn't fire for the `.call(arr)`
receiver path, and Date isn't checked. The Number/Boolean/String/RegExp/Null/
Undefined tags come from a different (working) path — confirm which, then add
the **Array / Function / Date** arms to the SAME classifier so they return
`[object Array]` / `[object Function]` / `[object Date]`. (Function arm exists
above but returns the source-text toString, not the tag — the `.call`-as-Object-
toString case must take the tag branch, not the function-source branch.)

### Part B — standalone native classifier (larger)

The whole `Object.prototype.toString.call(...)` is a `reportError` compile-error
under `--target standalone` (no host `Object_toString`). Emit a native §20.1.3.6
classifier: a static type-check switch on the receiver's TS/Wasm type producing
the right `[object X]` string constant (the per-builtin tag is statically known
in nearly all test262 cases — `compile away`). Order per §20.1.3.6:
undefined → `Undefined`; null → `Null`; isArray → `Array`; callable →
`Function`; Error → `Error`; Boolean/Number/String wrapper → that tag; Date →
`Date`; RegExp → `RegExp`; arguments exotic → `Arguments`; else `Object`.

**Defer Symbol.toStringTag (phase 2):** §20.1.3.6 step 15 reads
`@@toStringTag` off the receiver, which needs dynamic property lookup — route to
the dynamic-property epic, not this issue. Banks most of the 151 without it.

## Acceptance criteria

- Host + standalone: `Object.prototype.toString.call(v)` returns the right
  `[object X]` for Object/Array/Function/Number/String/Boolean/Date/RegExp/Null/
  Undefined.
- Standalone: no `env.Object_toString` leak / no compile error for the
  `.call(...)` form.
- No regression in the already-correct host tags.

## Landed (sd3, 2026-06-19) — unified compile-time classifier (both modes)

Parts A + B collapsed into ONE fix: a compile-time `[object X]` classifier that
intercepts `Object.prototype.toString.call(v)` **before** the host/standalone
split (`src/codegen/expressions/calls.ts`, the `Type.prototype.method.call`
borrowed-method handler, right after `typeName`/`methodName` are established).
The §20.1.3.6 builtin tag is statically known from the receiver's TS type, so it
emits the tag string directly via the dual-mode `stringConstantExternrefInstrs`
helper — no host import, no `__proto_method_call`. This fixes BOTH:

- **host** (Array/Function/Date were mis-tagged `[object Object]` because the
  Wasm vec/closure receiver is opaque to the host's `Object.prototype.toString`);
- **standalone** (the whole `.call(...)` form was a hard compile error).

New helper `resolveObjectToStringTag(ctx, argExpr)` classifies per §20.1.3.6
steps 2-14: undefined→Undefined, null→Null, isArray→Array, primitive
boolean/number/string→Boolean/Number/String, callable→Function,
Date/RegExp/Error(+ subclasses)/Arguments by symbol name, else Object; returns
`undefined` (caller falls through) when the receiver shape is unresolvable.

**Verified:** `tests/issue-2501.test.ts` — host returns all 9 tags correctly
(Array/Function/Date now right, was `[object Object]`); standalone array→
`[object Array]` (len 14) and `{}`→`[object Object]` (len 15) with **env=[]**
(no leak). `tsc` clean; the pre-existing `tostring-valueof`/`helpers.js` test
failures fail identically on main (verified by stash-compare) — not a regression.

**Deferred (phase-2):** `Symbol.toStringTag` override (§20.1.3.6 step 15) — needs
dynamic `@@toStringTag` property lookup → the dynamic-property epic. Banks the
bulk of the ~151 without it.

## Regression re-verification (dev3, 2026-06-20)

A test262 regression was flagged on PR #1742 earlier. Re-checked against current
`origin/main` (PR reconciled to head 616efb80f, then `git merge origin/main`):
the flagged regression **does not reproduce — it was drift / already resolved.**
The PR is strictly an improvement over main in every probed case, never a
pass→fail:

| receiver                                | main (prior)              | PR #1742                        | verdict                                                         |
| --------------------------------------- | ------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `[]` host                               | `[object Object]` (wrong) | `[object Array]`                | **fixed**                                                       |
| `function` / `Date` host                | `[object Object]` (wrong) | correct tag                     | **fixed**                                                       |
| `any`-typed receiver, host              | `[object Object]`         | `[object Object]`               | unchanged (still unfixed, not a regression)                     |
| `@@toStringTag` override, host          | `[object Object]`         | `[object Object]`               | unchanged (deferred phase-2; main never honored it here either) |
| standalone `.call(...)`, `any` receiver | **hard compile error**    | valid Wasm (clean fall-through) | **improved** (CE → no CE)                                       |

The `@@toStringTag` deferral does **not** regress host mode: on main the opaque
Wasm receiver already routed to `[object Object]` (the host `Object.prototype.
toString` never saw the JS `@@toStringTag`), so old and new fail that case
identically. Scoped suites green: `issue-2501` (3) + Object/toString/call
regression set (`2104`/`2163`/`2161`/`1337`/`hasownproperty-call`/`2042-r2`/
`2042-s3`/`2029-subclass`) = 70/70; `tsc` + prettier clean. Merged main clean
(no conflicts, no dropped files); reconciled to the PR head, not the stale
`9c5e876e4` worktree, so sd3's pushed progress is preserved.

## Source

#2376/#2379 jsonl sweep, sd3 2026-06-19. Routed by tech-lead from the
[object X]-tag cluster (~151, the 2nd-largest bounded standalone-feature group).

## Regression fix (PR #1742, 2026-06-20) — the −27 WAS real

The earlier "does not reproduce — drift" note above was **wrong**: the
`merge_group` full-shards confirmed a real **−27** (8 improvements − 35
regressions, `assertion_fail`, bucket `ef8cfd3a676ebd52`). Root cause:
`resolveObjectToStringTag` (src/codegen/expressions/calls.ts) was **too eager**
and emitted a static tag for receivers the host `Object.prototype.toString`
already resolved correctly, so the static path _overrode_ a correct host answer
with a wrong one. Five mis-tag classes:

| receiver form                                               | emitted           | correct                   | why                                                    |
| ----------------------------------------------------------- | ----------------- | ------------------------- | ------------------------------------------------------ |
| `Object("")` / `Object(5)` / `Object([])` (ToObject-boxing) | `[object Object]` | wrapped tag               | `Object(x)` types as `Object`                          |
| `new Number(5)` / `new Boolean(true)`                       | `[object Object]` | `[object Number/Boolean]` | wrapper-object type, not primitive                     |
| `TypeError.prototype` / `Error.prototype`                   | `[object Error]`  | `[object Object]`         | a `.prototype` is not an instance (no `[[ErrorData]]`) |
| `Function.prototype`                                        | `[object Object]` | `[object Function]`       | `.prototype` has no call sig in TS                     |
| `JSON` / `Math` (`@@toStringTag`)                           | `[object Object]` | `[object JSON/Math]`      | step-15 deferred — host got it right                   |

**Fix**: make the classifier _defer to the host_ for everything it can't prove,
returning a static tag only for the receivers the host gets WRONG (opaque Wasm
vec/closure/struct): genuine arrays, callable functions, `arguments`, and
Date/RegExp/Error _instances_. `Object(x)` recurses on `x` (§7.1.18 + §20.1.3.6,
the tag of `Object(x)` is the tag of `x`). The 8 host-mis-tag _improvements_
(Array/Date/Function) are retained. **Standalone** has no host fall-through, so a
`deferOrStandalone(fallback)` helper keeps the best static answer there (plain
object → `[object Object]`, primitives/wrappers → their tag) — no worse than the
pre-#2501 hard CE.

**Validation** (host mode, isolated per-process to avoid prototype-poison cross
-talk): all 35 toString-related regressions recovered (34/34; the 36th is a
`Proxy`-skip feature, not run in CI). On an 84-file regressed-category sweep
(Object/toString + Array.prototype iteration + NativeErrors + Function +
Number/RegExp/class-subclass): **PR-broken 24 pass → fixed 50 pass, net +26,
ZERO new regressions** (every remaining failure also fails on the broken head).
`tests/issue-2501.test.ts` 4/4 (added a PR #1742 regression-guard case). tsc +
prettier clean.

**Follow-up — Proxy receiver regression (the gate's last −1 blocker):** the
classifier still static-tagged a **Proxy** receiver, because a proxy carries no
TS-type brand — `new Proxy(t, h)` types identically to `t`, and
`Proxy.revocable([], {}).proxy` types as `never[]` (an array). So
`Object.prototype.toString.call(revokedProxy)` emitted a constant
`[object Array]` instead of deferring to the host, which (§20.1.3.6 step 4 →
§7.2.2 IsArray step 3a) must **throw TypeError** on a revoked proxy. The static
constant can't throw → `test262 proxy-revoked.js` regressed (pass on main → fail
on the PR; it was the single file failing the regression-gate's 10 % ratio for
PR #1742 / #1711). Fix: a `receiverMayBeProxy()` syntactic detector (`new
Proxy(...)`, `Proxy.revocable(...).proxy`, and identifiers bound transitively to
either) → defer to host (standalone refuses, no proxy runtime there).
**Validation:** `proxy-revoked.js` fail → pass, deterministic 5/5; a 276-file
`Object.prototype.toString.call` sweep is **net +9 / −0 vs origin/main** (the 8
host-mis-tag wins + proxy-revoked); two proxy regression-guard cases added to
`tests/issue-2501.test.ts` (6/6). tsc + prettier clean.
