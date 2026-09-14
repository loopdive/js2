---
id: 6421
title: "A spread argument to a STATIC BUILTIN method contributes exactly ONE element — `String.fromCharCode(...bytes)` yields one char, which is why hono signs every cookie as `AA==`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
String.fromCharCode(...[65, 66, 67]).length; // node 3, compiled 1
Array.of(...[1, 2, 3]).length; //               node 3, compiled 1
String.fromCharCode(48, ...[65, 66, 67]).length; // node 4, compiled 2
```

A spread argument to a **static builtin method** call expands to exactly one
element. Fixed arguments before it survive (the third line proves the spread
itself is the part that collapses, not the whole call).

This is NOT about what is being spread. Measured on the same run, all five
sources collapse identically: a plain array literal, `new Uint8Array([…])`,
`new Uint8Array(n)`, `new Uint8Array(<host typed array>)`, and a host typed
array handed in directly.

Nor is it spread in general. These are all CORRECT on the same build:

| form                                          | result  |
| --------------------------------------------- | ------- |
| `String.fromCharCode(65, 66, 67)` (no spread) | correct |
| `f(...[1,2,3])` into a user rest function      | correct |
| `String.fromCharCode.apply(null, [65,66,67])`  | correct |
| `Math.max(...new Uint8Array(hostAb))`          | correct |

So the defect sits in the argument lowering for the STATIC-BUILTIN call arm
specifically — `Math.max` takes a different (already-correct) route, which is
the useful contrast for whoever picks this up.

**This is the THIRD site of one known idiom, not a new class.** #5361 built the
shared spread-expanding argument-list builder (`src/codegen/spread-arg-list.ts`)
and converted `splice` / `push` / `Math.min`-`max` / the generic
`__extern_method_call` bridge; #6411 (merged 2026-09-12, `e1ce335402`)
converted the two host-Array argument builders in
`src/codegen/array-method-host.ts`. Both replaced the same wrong pattern: build
the argument list with ONE push per AST node, which is exact only while every
argument is a single value. The static-builtin call arm still does that.
Reading those two diffs first is likely the whole job.

## Why it matters — it is hono's cookie blocker

hono `src/utils/cookie.ts:48`:

```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```

`crypto.subtle.sign` answers a 32-byte host ArrayBuffer. Every step on that
line is already correct on current main — measured:
`byteLength` reads 32, `new Uint8Array(hostAb).length` is 32, and the bytes
match. Only the spread collapses, so the signature serializes as `AA==`
(base64 of a single zero byte) instead of the real 44-character digest.

That one line accounts for **9 of the 11** remaining
`src/utils/cookie.test.ts` failures (24/35 on the branch that closed
[#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity)):
four "Should parse signed cookies…" cases, four more verify-side cases that
answer `false` where a value was expected, and "Should serialize signed cookie
with all options". The verify side fails for the same reason —
`verifySignature` (cookie.ts:58-62) cannot match a signature produced from a
truncated buffer.

A tenth, "Should serialize a signed cookie", fails on this AND on a second,
unrelated defect; the eleventh, "Should serialize cookie", fails on that second
defect ALONE — a spurious `Max-Age=0` emitted for an ABSENT `maxAge` option
([#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan)).
So the expected mover for this issue by itself is **24/35 → 33/35**, not 34 and
not 35; the last two need #6423 as well.

## Acceptance criteria

1. `String.fromCharCode(...xs)`, `Array.of(...xs)` and a fixed-arg-plus-spread
   call all expand every element, for a plain array, a compiled TypedArray
   carrier, a buffer-backed view and a host typed array.
2. Anti-vacuity: the no-spread, `.apply`, user-rest-function and `Math.max`
   forms above stay correct (they are correct today — a fix that reroutes
   everything through one path must not regress them).
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD. hono `src/utils/cookie.test.ts`
   24/35 → 33/35 is the expected mover if the attribution above holds.
5. Standalone lane status recorded.

## Dispatch

Model: **opus**. The failing and working forms are both located and contrast
cleanly, so the diagnosis is cheap; the care is in not regressing the four
forms that already work.

## Implementation Plan

**Diagnosis (measured on 23a0ddaa26, untyped two-file .js fixture, `target: gc` and `standalone`).** There is no single "static-builtin call arm" — two per-builtin lowerings still use the one-push-per-AST-node idiom that #5361/#6411 removed elsewhere:

1. `compileFromCharCodeFamily` — `src/codegen/expressions/calls.ts:6127` (serves `String.fromCharCode` AND `String.fromCodePoint`, native and host lanes). It loops `expr.arguments` and calls `compileExpression(arg, f64)` on the `SpreadElement` itself: the source array coerces to `NaN` → ToUint16 → one `"\0"` part. That is exactly why hono signs as `AA==` (base64 of one zero byte). `fromCodePoint(...xs)` is worse: `NaN` trips the #2601 range guard → `RangeError: Invalid code point NaN` (gc) / unhandled Wasm exception (standalone). Measured: `fromCharCode(...[65,66,67])` → 1, `(48, ...[65,66,67])` → 2, `...new Uint8Array([...])` → 1, host `ArrayBuffer` view → 1, `...s.split(",").map(Number)` → 1.
2. `Array.of` arm — `src/codegen/expressions/call-builtin-static.ts:1569-1660`. Host path (`__js_array_new` + one `__js_array_push` per node, L1649) → `Array.of(...[1,2,3]).length` = 1. Standalone path explicitly skips spread (`noJsHost && !hasSpreadArg`) and falls through to the host path whose imports do not exist → length **0**.

Controls are correct on the same build (`fromCharCode(65,66,67)`, `.apply`, `Math.max(...xs)`=5 via `compileMathMinMaxSpread` in `expressions/builtins.ts:3816`, `Array.of(1,2,3)`), so the fix is local to those two sites.

**Changes, in order.**

1. `calls.ts` `compileFromCharCodeFamily`: at the top, `if (hasSpreadArgument(expr.arguments))` take a new spread lane; otherwise keep the existing loop **verbatim** (no-spread output byte-identical — that is the anti-vacuity guarantee). Spread lane: (a) host lane must call `addStringImports(ctx)` unconditionally first (today gated on `arguments.length > 1`, wrong once one spread yields N parts) and re-resolve `repr` after; (b) `buildSpreadArgList(ctx, fctx, expr.arguments, 0, {kind:"f64"}, "fcc")` — returns `undefined` → fall back to the old loop (no worse than today); (c) allocate `acc` local of `repr.resultType`, init `repr.literal("")`; (d) `emitStores({pre: [], post: [<per-code-unit coercion>, call helper, then acc = repr.concat(acc, part)]})`. Factor the existing per-argument tail (ToUint16 f64 math for native `fromCharCode`, `i32.trunc_sat` after the #2601 range guard for `fromCodePoint`, `f64.convert`-free host path) into a small `emitCodeUnitPart(buf, argType: f64)` helper reused by both lanes so the sink and the loop cannot drift. Sink values are always f64, so the `i32` arms are dead in the sink. Re-read `helperIdx`/`__str_concat`/`concat` indices from `ctx.nativeStrHelpers` / `ctx.jsStringImports` **after** `buildSpreadArgList` returns (it flushes late imports; the maps are kept in lockstep by `flushLateImportShifts`, captured numbers are not). The #5152 Symbol/BigInt static throw stays on positional args only (spread elements are runtime values).
2. `call-builtin-static.ts` Array.of host path (L1649 loop): replace with `tryEmitSpreadHostArgs(ctx, fctx, expr.arguments, itemsLocal, "__js_array_push", arrPushIdx)` and keep the unrolled loop as the `false` branch — the exact #6411 edit (`src/codegen/host-method-args.ts`).
3. Array.of standalone with spread (currently length 0): drop the `!hasSpreadArg` gate; when a spread is present, `canBuildSpreadArgList` → `buildSpreadArgList(..., elemWasm, "arrof_sp")`, `array.new_default` sized from `built.countLocal`, then `emitStores` with the `array.set` + running-index sink copied from `src/codegen/array-push-spread.ts:85-100`, `struct.new` the vec with `countLocal`. Element type: with a spread present the `allNumeric` static scan cannot see spread elements → use the contextual type arg if resolvable, else `externref` (mirror #5361's splice choice; do not guess f64).
4. Order preservation: `buildSpreadArgList` already evaluates left-to-right once; do not compile any argument before calling it. Keep the receiver-less shape (these are static calls, nothing precedes the args).

**Regression test** `tests/issue-6421-static-builtin-spread-args.test.ts`, same harness as `tests/issue-6411-host-bridge-concat-spread.test.ts` (untyped `lib.js` + `entry.js`, `compileProject({allowJs, skipSemanticDiagnostics, target:"gc"})`). Assert exact lengths and joined strings: `fromCharCode(...[65,66,67])`="ABC"/3; `(48, ...xs)`="0ABC"/4; `...new Uint8Array([…])`; host `ArrayBuffer` passed in; `...s.split(",").map(Number)`; `fromCodePoint(...[0x1F600, 65])`; `Array.of(...[1,2,3]).join("|")`; `btoa(String.fromCharCode(...new Uint8Array(4)))`==="AAAAAA==" (the hono shape). Controls that must already pass on parent: no-spread, `.apply`, `Math.max(...xs)`, `Array.of(1,2,3)`. Expected parent: ~9 failed / 4 passed; fix: all pass. Add a `target:"standalone"` describe for the same fixture (gate Array.of/fromCodePoint on `canBuildSpreadArgList` behaviour; record any residual as skipped with reason).

**Dogfood A/B at one HEAD (17 suites).** Expected mover: hono `src/utils/cookie.test.ts` 24/35 → 33/35 (hono overall 259/324 → ~268/324); the two left need #6423. All others delta 0 (grep: no other fixture uses `fromCharCode(...`/`Array.of(...`). Standalone lane: record the probe results (parent: fromCharCode 1, Array.of 0, fromCodePoint trap) and the post-fix numbers; the standalone `__array_from_iter_n` substrate already serves `Math.max` spreads, so parity is expected.

**Not in scope, note in the issue:** other static builtins that unroll `expr.arguments` (e.g. `Object.assign`, `Math.hypot`) were not measured; list them for a follow-up rather than rerouting them here.

## Dispatch

Model: **opus**. Both defects are located to exact lines with a working sibling (`compileMathMinMaxSpread`, #6411's `tryEmitSpreadHostArgs`) to copy from; the care is re-resolving function indices after the late-import flush and keeping the no-spread path byte-identical.
