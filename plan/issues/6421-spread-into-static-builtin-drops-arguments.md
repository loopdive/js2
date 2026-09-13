---
id: 6421
title: "A spread argument to a STATIC BUILTIN method contributes exactly ONE element — `String.fromCharCode(...bytes)` yields one char, which is why hono signs every cookie as `AA==`"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-13
completed: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6421): the `Array.of` arm gains a spread branch and the host
  # arg loop a shared-builder branch; the runtime-length vec build itself was
  # extracted to `src/codegen/array-of-spread.ts` rather than added here, and
  # `calls.ts` shrank by ~60 lines in the same change-set.
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  # 2026-09-13 (#6421): same +31 lines, seen through the enclosing function —
  # the Array.of and fromCharCode arms both live inside this one dispatcher.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
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

## Resolution

Fixed on `issue-6421` (branched from `699df289e1`). Three sites, one idiom.

**1. `String.fromCharCode` / `String.fromCodePoint`** — new
`src/codegen/from-char-code-spread.ts`. `compileFromCharCodeFamily`
(`src/codegen/expressions/calls.ts`) built one string PART per argument AST
node and folded the parts at compile time, so a spread compiled its SOURCE as
one code unit (`NaN` → ToUint16 → `"\0"`). A spread-containing list now goes
through `buildSpreadArgList` and folds at RUNTIME into an accumulator local
seeded with `""`. The per-code-unit tail (§7.1.8 ToUint16 in the f64 domain,
the #2601 range guard, the 1-char-string helper) moved into a shared
`emitCodeUnitPart` both lanes call, so the loop and the accumulator cannot
drift. A list with no spread keeps the old loop untouched.

**2. `Array.of`** — the host path's `__js_array_new` + one `__js_array_push`
per node is now `tryEmitSpreadHostArgs` (the exact #6411 edit) with the
unrolled loop kept as the no-spread branch; the standalone path's
`noJsHost && !hasSpreadArg` gate is gone, and a runtime-length list is sized
and filled by the new `src/codegen/array-of-spread.ts`. The `allNumeric`
element-type scan can never see a spread's elements, so a spread-containing
list boxes to `externref` rather than guessing `f64` (#5361's `splice` choice).

**3. `emitStores` handed out SHARED instruction objects** — the defect that
made the first two fixes wrong in standalone, and a latent hazard for every
existing caller. `SpreadArgSink.pre`/`post` were spliced into the body once per
slot, so the same `Instr` objects sat at several points of one array; the
late-import shifter (`shiftFuncIndices`, `src/codegen/registry/imports.ts`)
dedups by ARRAY identity and never by instruction identity, so it added the
shift delta to a repeated `call` index once per occurrence. Measured on
`String.fromCharCode(48, ...[65,66,67])` standalone, where all four slots are
static values: the accumulating `__str_concat` was shifted four times and the
call answered `"0"`. `emitStores` now clones the sink per use.

### Measured

Probe (untyped two-file `.js`), parent → fix:

| form | gc parent | gc fix | standalone parent | standalone fix |
| --- | --- | --- | --- | --- |
| `fromCharCode(...[65,66,67])` | `"\0"` | `"ABC"` | len 1 | len 3 |
| `fromCharCode(48, ...[65,66,67])` | `"0\0"` | `"0ABC"` | len 1 | len 4 |
| `...new Uint8Array([72,73,74])` | `"\0"` | `"HIJ"` | len 3 | len 3 |
| `...new Uint8Array(new ArrayBuffer(n))` | `"\0"` | `"XY"` | — | — |
| host `ArrayBuffer` handed in | `"\0"` | `"PQR"` | — | — |
| `...s.split(",").map(Number)` | `"\0"` | `"ABC"` | len 3 | len 3 |
| `fromCodePoint(...[0x1F600, 65])` | threw `RangeError: Invalid code point NaN` | len 3 | len 2 | len 3 |
| `Array.of(...[1,2,3])` | len 1, joins `"NaN"` | len 3, `"1\|2\|3"` | module would not instantiate | len 3 |
| hono shape, 4 zero bytes | `"AA=="` | `"AAAAAA=="` | — | — |

Controls correct on both: `fromCharCode(65,66,67)`, `.apply`,
`Math.max(...xs)`, `Array.of(1,2,3)`, `fromCodePoint(0x1F600,65)`.

The standalone `Array.of` residual is WORSE than this issue predicted: not a
length-0 vec but an unbindable module — the spread fell onto the host path and
imported `__js_array_new` / `__array_of`, which the native-first adapter
refuses ("legacy-semantic import owned by #4397"), so nothing in the module
runs.

### Regression test

`tests/issue-6421-static-builtin-spread-args.test.ts` — 20 failed / 8 passed
of 28 on the parent, 28 passed with the fix. The 8 `control…` rows pass on
both. Across the 31 spread / charCode / `Array.of` test files, base 47 failed /
238 passed → fix 27 failed / 258 passed, with the failing SET unchanged apart
from this file's 20 rows.

### Dogfood A/B (17 suites, one HEAD, base = `699df289e1`)

16 suites flat. One mover:

| suite | base | fix |
| --- | --- | --- |
| hono | 261/324 | **262/324** |
| webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740/63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6 · styled-components 9/9 · uuid 75/75 · marked 16/30 · moment 10/10 · prettier 108/151 · jest 335/356 | | unchanged |

hono `src/utils/cookie.test.ts` 24/35 → 25/35. Exactly one row flipped, and no
row regressed: **"Should serialize signed cookie with all options"**, which on
base emitted `great_cookie=banana.AA%3D%3D` — the literal symptom this issue is
named for.

**The predicted 24/35 → 33/35 did NOT happen, and the issue's attribution of
the other eight rows was wrong.** Signing is now provably correct: "Should
serialize a signed cookie" emits the real 44-character digest
`macha.diubJPY8O7hI1pLa42QSfkPiyDWQ0I4DnlACH%2FN2HaA%3D` and fails only on the
spurious `Max-Age=0` that #6423 owns. The eight "Should parse signed
cookies…" rows still answer `false` even though the signature they are handed
is now correct, so verification has a defect of its own rather than being
downstream of this one — filed as
[#6449](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6449-hono-signed-cookie-verify-returns-false).
Expected total once #6423 and #6449 land: 33/35 as predicted, but from three
issues, not one.

### Not in scope

- **A spread into a USER rest function throws `illegal cast`** in an untyped
  `.js` project — on the parent AND with this fix, for every source shape
  (inline literal, variable, `.split()`, TypedArray; same- and cross-module).
  This issue listed that form as already correct; it is not. Filed as
  [#6443](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6443-spread-into-user-rest-function-illegal-cast).
- Other static builtins that unroll `expr.arguments` — `Object.assign`,
  `Math.hypot` — were not measured. Filed as
  [#6444](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6444-static-builtin-spread-audit-remaining-arms).
- The hono signed-cookie VERIFY side, per the A/B above:
  [#6449](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6449-hono-signed-cookie-verify-returns-false).
