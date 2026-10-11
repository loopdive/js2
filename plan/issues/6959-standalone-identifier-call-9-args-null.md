---
id: 6959
title: "standalone: calling an `any`-typed local that holds a function value with 9+ arguments (`var f; f = parse[9]; f(a,…,i)`) answers `undefined` without invoking the callee — stale per-call-site `APPLY_CLOSURE_MAX_ARITY = 8` gates predate the #6655 above-cap `__apply_closure` arm (Octane earley-boyer: Earley returns 0 trees instead of 132)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: dynamic-call, arity
goal: standalone-gap
related: [874, 6655, 4640, 5148, 4096, 3310, 6949, 6958]
---

# standalone: 9+-argument call through an untyped local never invokes the callee

Found by the Octane standalone triage (Session D, 2026-10-11, branch `d-triage3` =
`c-octane-integ` = origin/main + #6950/#6955/#6956/#6957/#6958). `earley-boyer` fails
`Error: Earley or Boyer did incorrect number of rewrites` because the Earley half
returns `0` instead of `132`.

## First divergence (bisected with throw-probes in a patched driver, `.tmp/patch-d1..d7.mjs`)

| probe | node | standalone |
|---|---|---|
| `parse->parsed?`, `nb-trees*` (parse[8], parse[10]) | true / 132 | true / 132 (correct) |
| `parse->trees` (parse[9]) via `BgL_parsezd2ze3treesz31(x,"s",0,k)` | 132 trees | `null` (0 trees) |
| `x[9]("s",0,k,x[0],x[2],x[4],x[5],x[6],x[7])` — the SAME closure, called directly | runs | runs (entry `throw` fires) |
| `BgL_parsezd2ze3treesz31`: `f = parse[9]; f(9 args)` | runs | **callee body never entered**, result `null` |

The whole parse (states, enders, names, toks — all 11 slots) is identical in both lanes. The
only thing that differs is one call shape: `BgL_parsezd2ze3treesz31` copies `parse[9]` into a
local and calls it with **nine** arguments; its working twin `BgL_parsezd2ze3nbzd2treesze3`
does the same with **eight** (`parse[10]`, no `names`). `is_parsed` (6 args) also works.

## Minimized repro (`.tmp/m2.js`, 14 lines — node `8,9,9`, standalone `8,null,9`)

```js
function mk() {
  var f8; var f9;
  { f8 = function (a, b, c, d, e, f, g, h) { return a + b + c + d + e + f + g + h; };
    f9 = function (a, b, c, d, e, f, g, h, i) { return a + b + c + d + e + f + g + h + i; }; }
  return [0, f8, f9];
}
function call8(p) { var fn; return ((fn = p[1]), fn(1, 1, 1, 1, 1, 1, 1, 1)); }        // 8 → ok
function call9(p) { var fn; return ((fn = p[2]), fn(1, 1, 1, 1, 1, 1, 1, 1, 1)); }     // null on standalone
function call9direct(p) { return p[2](1, 1, 1, 1, 1, 1, 1, 1, 1); }                    // 9 → ok (different arm)
/** @returns {string} */
export function main() { var p = mk(); return call8(p) + "," + call9(p) + "," + call9direct(p); }
```

Compile options as the Octane harness uses them: `target: "standalone"`, `allowJs`,
`inferModuleStrictArguments: false`, `runtimeEvalProvider: false` (`.tmp/sa.mjs m2.js --script --no-eval`).
The `--gc` lane is unaffected (the `__apply_closure` bridge is reserved on standalone/wasi only).

## Root cause

`compileCallDispatchTail` → **`tryEmitNullishIdentifierCalleeTypeError`**
(`src/codegen/expressions/stored-member-closure-call.ts` ~L200-279, #4640 D1 + #5148 checkpoint)
is the arm that claims `fn(...)` for an identifier whose checker type is `any`/non-callable
(the `var fn; fn = p[2]` binding — `bindingIsPopulatedFromElementRead` in `call-identifier.ts:481`
deliberately keeps it OFF the typed `closureMap` path, and `tryEmitInlineDynamicCall` declines
because `callSigs` is empty). It computes

```ts
const canApply = !spread && expr.arguments.length <= APPLY_CLOSURE_MAX_ARITY;   // = 8, L91
```

and when `canApply` is false it compiles callee + args for side effects, emits the nullish
TypeError guard, and pushes **`ref.null.extern`** (L273-275) — the callee is never invoked.
Emitted WAT for `call8` confirms the `__objvec_new`/`__objvec_push`/`__apply_closure` route;
`call9` gets the bare sentinel.

The constant's doc comment ("`fillApplyClosure` dispatches arities 0..8 and answers the
undefined sentinel above that") is **stale since #6655**: `fillApplyClosure`
(`src/codegen/object-runtime.ts:6404-6425, 6557-6569`) now adds ONE above-cap arm guarded by
`n > 8` that calls `__call_fn_method_<top>`, where `top` is the module's highest closure
formal count above 8 (`topHighClosureMethodCallArity`, `closure-exports.ts:1299`; minted in
`index.ts:6483`). `n = max(argc, declaredArity)` (`buildApplyClosureArityWidening`,
`closure-exports.ts:2044`). earley-boyer and `m2.js` both contain 9-formal closures, so
`__call_fn_method_9` IS minted (the `m2` WAT exports `__js2_call_fn_method_argc_9`) — the bridge
would dispatch the call correctly; only the call-site gate stops it from being reached.

The same stale `APPLY_CLOSURE_MAX_ARITY = 8` call-site gate is copy-pasted in four sibling arms,
each of which declines to the same graceful `ref.null.extern` fallback:

| file | line |
|---|---|
| `src/codegen/expressions/stored-member-closure-call.ts` | 94 (const), 221-222 (`canApply` — **the earley-boyer blocker**), 344 (`tryEmitStoredMemberClosureCall`), 557 (`tryEmitProtoInheritedMethodCall`) |
| `src/codegen/expressions/realm-global-member-call.ts` | 51, 83 |
| `src/codegen/expressions/function-typed-property-call.ts` | 35, 54 |
| `src/codegen/expressions/callable-property-apply-fallback.ts` | 41, 113 |
| `src/codegen/expressions/class-instance-member-call.ts` | 55, 92 |

**Not #6949.** The repro has no constructor function, no prototype, no escape gate; the
callee is an ordinary closure value in an array. (The planned #6949 fix touches
`__fnctor_proto_start` materialization, a disjoint mechanism.)

## Implementation Plan

### 1. One shared admission predicate (replace five private constants)

**File: `src/codegen/object-runtime.ts`** — next to `fillApplyClosure` (~L6350), export

```ts
/**
 * Call-site admission for `__apply_closure`. The bridge dispatches 0..8 per arm and, since
 * #6655, every n > 8 through the module's top minted `__call_fn_method_<top>`; an n with no
 * dispatcher answers the undefined sentinel — i.e. exactly what the graceful fallback a
 * declining arm lands on would produce. Admitting any non-spread argc is therefore monotone:
 * it can only turn a silent `undefined` into a real invocation.
 */
export function applyClosureAdmitsCall(expr: ts.CallExpression): boolean {
  return !expr.arguments.some((a) => ts.isSpreadElement(a));
}
```

(Keep spread excluded — the spread lowering is a separate path, `standalone-dynamic-spread-call.ts`.)

**File: `src/codegen/expressions/stored-member-closure-call.ts`**
- Delete `APPLY_CLOSURE_MAX_ARITY` (L87-94) and its stale comment.
- L221-222: `const canApply = applyClosureAdmitsCall(expr);`
- L344 (`tryEmitStoredMemberClosureCall`, the `o.f(...)` arm) and L557 (`tryEmitProtoInheritedMethodCall`):
  replace `if (expr.arguments.length > APPLY_CLOSURE_MAX_ARITY) return undefined;` with
  `if (!applyClosureAdmitsCall(expr)) return undefined;` (and drop the now-redundant spread check beside it).

**Files: `realm-global-member-call.ts:83`, `function-typed-property-call.ts:54`,
`callable-property-apply-fallback.ts:113`, `class-instance-member-call.ts:92`** — same substitution;
delete each local constant. (`callable-property-apply-fallback.ts` caps `min(args, paramTypes.length)`;
replace that with the predicate as well — the bridge handles over/under-application via `__argc`.)

### 2. (Optional, same PR if cheap) no-high-closure module: route n > 8 to the arity-8 arm

`fillApplyClosure` L6557: when `applyClosureTopArity === APPLY_CLOSURE_MAX_ARITY` (nothing minted
above 8) and `n > 8`, today's chain falls to `armUnsupported`. A 9+-arg call into an ≤8-formal
closure is legal JS (§7.3.14 extras ignored) and `__call_fn_method_8` "admits every closure of
host arity <= 8", so add `else if n > 8 → buildArm(8)` there. Not needed for earley-boyer (its
module mints `__call_fn_method_9`); include only if the test row below is wanted now.

### Order / blast radius
- Step 1 is strictly monotone (every admitted shape today yields `ref.null.extern` with the callee
  never run); the bridge is reserved only on standalone/wasi so the gc/host lane is byte-identical.
- Watch `check-loc-budget` / `check-func-budget` / `check:dead-exports` (five constants removed, one
  export added — the export must be referenced by all five sites or `dead-exports` fails).
- No overlap with #6949 (`fnctor-proto`), #6958 (`struct param inference`), #6950-#6957.

### Acceptance
- `tests/issue-<id>.test.ts` (public `compile()`, `allowJs`, `skipSemanticDiagnostics`,
  `inferModuleStrictArguments: false`), run under `target: "standalone"` AND gc:
  - `.tmp/m2.js` → `"8,9,9"` (both lanes);
  - 10 args into the 9-formal closure through the local → extras ignored (`9`);
  - 9 args into the 8-formal closure through the local, module WITH a 9-formal closure → `8`;
  - (step 2 only) same, module WITHOUT any 9-formal closure → `8`;
  - control: `fn = null; fn(1..9)` still throws `TypeError: fn is not a function` (the #4640 guard
    must stay in front of the dispatch).
- `pnpm run -s benchmark:octane -- --only earley-boyer --lanes standalone --timeout 600` → pass, but
  only TOGETHER with the closure-in-loop fix (see "Simulated fix" below); on its own this fix turns the
  wrong-result into a hang, so land/validate the two as a pair.
- `tests/issue-6655-standalone-apply-closure-high-arity.test.ts` and `tests/issue-4640.test.ts` stay green.

### Simulated fix (patch-and-rerun, `.tmp/patch-d8-simfix.mjs`)
Rewriting the single 9-arg local call in `BgL_parsezd2ze3treesz31` to the direct
`(parse[(9)])(…)` form — the arm that already works — gets past this defect, and then
EXPOSES a second, independent one: the now-executing `deriv_trees` spins forever (100 % CPU, killed
after 14 CPU-min; `BOYER-START` probe never reached in 300 s). That is the closure-in-loop re-boxing
defect in `.tmp/#6960`. With BOTH simulated at source
level (`.tmp/patch-d10-simfix2.mjs`) earley-boyer passes on standalone: `octane_run -> 2`, teardown ok.
So this issue alone does not turn the benchmark green; the pair does, and the Boyer half has no blocker.

Size: **S** (one 5-line export + five one-line substitutions; step 2 adds ~10 lines).
