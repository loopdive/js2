---
id: 6646
title: "standalone: a spread into a DYNAMIC (identifier-held) callee does not expand — `f(...a)` passes the source array as formal zero"
status: done
completed: 2026-09-20
assignee: ttraenkler/sendev-s68
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
# (2026-09-20) The host-free twin of the existing `emitDynamicSpreadCall` arm
# is a 12-line splice at the ONE point the host lane already diverts, inside
# `compileIdentifierCall`'s `funcIdx === undefined` branch. Putting it anywhere
# else would either miss a shape or claim one that already works (measured —
# see "One splice" below); the mechanism itself lives in the new leaf
# `src/codegen/standalone-dynamic-spread-call.ts`, not here.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
---

## Problem

On the host-free (`--target standalone`) lane, a call whose **callee reaches
the compiler as a runtime value through an identifier** and whose argument
list contains a **spread** passes the spread's SOURCE ARRAY as one argument
instead of expanding it.

Measured on the S67 head (`907ac32037`), host-free, with the one changed
source file file-copy reverted (`.tmp/s68/ab.sh base`), probes
`.tmp/s68/probes/q1.js`, `q2.js`, `q5.js`:

| expression | S67 head | correct |
| --- | --- | --- |
| `callSpread(echoF,[1,"s",[2]])` where `callSpread(f,a){ return f(...a) }` | `arr3/UNDEF/UNDEF/1` | `number/string/arr1/3` |
| `var g = O.echo; g(...[1,"s",[2],4])` | `object/UNDEF/UNDEF/UNDEF/1` | `number/string/arr1/number/4` |
| `var f = this.echo; f(...args)` | `E1,2,3undefinedundefined` | `E123` |
| `callMixed(f,a){ return f(1, ...a) }` | first formal only | `number/string/arr1/3` |
| `echoF(...[1,"s",[2]])` — STATIC callee, **control** | correct | correct |
| `fwdPlain(...args){ return echoF(...args) }` — STATIC callee, **control** | correct | correct |
| `O.fwd(…)` where `fwd(...a){ return this.echo(...a) }` — **control** | correct | correct |

The controls are what localises the defect. A spread into a callee the
compiler can RESOLVE is already exact (the rest vector is folded into the
callee's real formals), and — measured, not assumed — so is the
`this.<m>(...args)` spelling. The base answers give the defect away:
`arguments.length` is 1 and formal ZERO holds the source ARRAY.

### S67 residual 1 was a misattribution

S67 recorded residual 1 as "`fwd(...args) { return this.echo(...args) }` — a
rest-forwarded call does not happen at all (`undefined`)", measured in
`.tmp/s68/probes/p34.js`. That probe's `echo` ends with `arguments.length`,
and the real cause is a **different, pre-existing** defect with nothing to do
with spread: `this.<m>(…)` where `m` reads `arguments` answers `null` even
with **no spread at all** (see the residual section below). With an
`arguments`-free callee — which is what `temporalHelpers.js` actually has —
the `this.<m>(...args)` forward was already correct on the S67 head. The
`checkSubclassingIgnored*` entry shape

```js
checkSubclassingIgnoredStatic(...args) {
  this.checkStaticInvalidReceiver(...args);
  this.checkStaticReceiverNotCalled(...args);
  this.checkThisValueNotCalled(...args);
},
```

is therefore **not** blocked by this issue. It is pinned in the witness as a
control so the fix cannot silently take it over.

## Root cause

`src/codegen/expressions/calls.ts::emitDynamicSpreadCall` already repairs this
shape — but only for the JS-host lane. Its first line is

```ts
if (ctx.standalone || ctx.wasi || !expr.arguments.some((arg) => ts.isSpreadElement(arg))) return null;
```

and its header states the reason:

> This path is deliberately limited to the JS-host lane. Standalone/WASI calls
> retain their native ObjVec/call_ref lowering, where the vector is a
> first-class Wasm value and can be expanded without a host boundary.

**The second sentence is not true of the lowering that actually runs.** Every
dynamic-callee arm sizes its argument list from `expr.arguments.length` — one
local per AST node — so a spread contributes exactly ONE value. Traced on the
base tree (a temporary `console.error` at the `ts.isSpreadElement` fall-through
in `expressions.ts`, which is where a spread gets compiled as a single value),
the broken shapes land in two arms, both reached from
`compileIdentifierCall`'s `funcIdx === undefined` branch:

| shape | arm that compiled the spread as one value |
| --- | --- |
| `f(...a)` (param callee) | `calls.ts::tryEmitInlineDynamicCall`'s per-arg loop |
| `var g = …; g(...a)` | `call-identifier.ts`'s matched-closure dispatch |

Both are reachable only when the callee is a runtime value, and both sit
downstream of the point where the host lane already diverts.

## Fix

New leaf `src/codegen/standalone-dynamic-spread-call.ts` —
`tryEmitStandaloneDynamicSpreadCall` — the host-free twin of
`emitDynamicSpreadCall`, using the same runtime-argv terminal the linked-static
arms adopted in #6644/S67:

```
argv = __objvec_new()
<tryEmitSpreadHostArgs>            // #6616's shared expander: one push per RUNTIME element
__apply_closure(callee, receiver, argv)
```

`__apply_closure` widens/clamps to the selected callable's declared arity
(`buildApplyClosureArityWidening`) and installs `receiver` as `this`. It is
already the innermost DEFAULT arm of `tryEmitInlineDynamicCall`, so no carrier
becomes reachable that was not reachable before — only the argument COUNT
changes.

**One splice**, one-way, gated on a spread being PRESENT: in
`call-identifier.ts`, immediately after the existing
`isKnownVariable && hasSpreadArg && !noJsHost(ctx)` host arm — the same
condition with `noJsHost(ctx)` instead of `!noJsHost(ctx)`. It sits inside the
`funcIdx === undefined` branch, i.e. the identifier is NOT a compiled
function, which is why the `echoF(...[…])` control cannot reach it.

A second splice, before `call-tail-dispatch.ts`'s `#1298 fix #3` generic
fallback, was written and then **removed**: the base measurement above showed
that path already answers correctly for `this.<m>(...spread)`, so the splice
would have taken over a working lowering and added instructions for no
measured gain.

### Gates, and why each is load-bearing

- **A spread must be present.** Without one the existing fixed-arity lowering
  is exact, so every call site in the byte corpus stays instruction-identical.
  Same gate, same reason, as S67's linked computed call.
- **Host-free lane only** (`noJsHost`). The host lane has its own repair and
  does not reserve `__apply_closure`.
- **A side-effect-free RECEIVER spelling** for a member callee — `this`, an
  identifier, or a property-access chain over those (kept even though only the
  identifier-callee splice is live, because a parenthesised or aliased member
  callee can still reach it). §13.3.6.1 evaluates the
  MemberExpression once; the terminal reads the receiver for `this` and then
  compiles the whole callee expression, which reads it a second time. A
  spelling that cannot run user code makes the duplicate read unobservable;
  anything else declines rather than duplicating an observable evaluation.
  `super.m(...)` declines outright.

Everything the terminal emits is wrapped in `withSpeculativeCompile` (#1919),
so a declined receiver/callee/spread compile rolls back to nothing.

## Residual measured, NOT fixed (pre-existing, orthogonal)

`this.<m>(…)` where `m` READS `arguments` answers `null` — **with or without a
spread**. `.tmp/s68/probes/q5.js`:

| expression | answer |
| --- | --- |
| `this.a3(1,2,3)` — no spread at all | `null` |
| `this.a3(...x)` | `null` |
| `this.p3(...x)` (`p3` does not read `arguments`) | `p3:123` |
| `var f = this.a3; f(...x)` | `a3:123:3` |
| `O.a3(...x)` (identifier receiver, same callee) | `a3:123:3` |

The no-spread row proves this is not the spread terminal: it is a pre-existing
`this.<method>` receiver-call defect for an `arguments`-reading object-literal
method. It is why `.tmp/s68/probes/p34.js`'s `fwd` row still reads `undefined`
after this fix — p34's `echo` ends with `arguments.length`. The
`temporalHelpers.js` helpers do not read `arguments`, so the rows are not
blocked on it. Filed as a residual here for the next lane rather than widened
into this slice.

## Verification

Full battery against the S67 base, with #6645 on top (the two land as one
stack): four families **463/480**, **0 pass→fail**, +4 fail→pass; the nine
must-not-move groups (3,204 rows) flat in both directions; corpus
42×{gc,standalone} statusFlips=0 shaFlips=0; equivalence 22 / 1720 / 22;
witness sweep `tests/issue-66* + 6484 + 6493` 51 files / 287 tests green under
Node 22 and Node 25.9. Artifacts: `.tmp/s68/battery/diff-all.log`,
`.tmp/s68/corpus-fix.jsonl`, `.tmp/s68/equiv.log`, `.tmp/s68/sweep-node2*.log`.
