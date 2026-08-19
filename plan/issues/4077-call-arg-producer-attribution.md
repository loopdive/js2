---
id: 4077
title: "call-argument repair pairs args with the wrong params — a `null` arg gets a neighbour's GC type and the module stops validating"
status: done
sprint: 78
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/H-crashes
created: 2026-08-02
completed: 2026-08-02
---

## Problem

In standalone mode a call with a `null` argument followed by a closure
argument emits a module that **fails Wasm validation**:

```
__module_init failed: call[2] expected type externref,
                      found ref.null of type (ref null 6)   ; type 6 = $AnyString
```

The module never instantiates, so **every** assertion in the file is lost —
this is a whole-file flip, not a single-assertion gap.

Measured on the standalone lane (baseline row timestamp `2.8.2026, 03:32`,
official scope 43,505 / 25,995 pass; ES5+untagged goal scope 8,545 run /
6,298 pass / 0 unopenable):

- **53** goal-scope files carry the `invalid Wasm binary` signature.
- **28** of those are this mechanism. They are all the
  `verifyNotWritable(obj, name, null, function () { … })` shape from
  `propertyHelper.js`, i.e. the `S15.*_A10` "length is ReadOnly" family across
  `String.prototype.*`, `RegExp.prototype.*`, `Object.prototype.*`,
  `Function.prototype.*` and `Error.prototype`.

### What this issue REFUTES

The 28 files were previously attributed to **`Function.prototype.bind`**
(`compileFunctionBind`'s standalone arm, `src/codegen/expressions/calls.ts`),
on the evidence that the failing function's WAT prefix is full of
`$__bindfn_tgt_*` / `$__bindfn_arg_*` locals.

That attribution is wrong, and the WAT prefix is the trap: it is only the
first ~200 characters of `__module_init`'s **locals list**. Those locals come
from `propertyHelper.js`'s own prologue —

```js
var __join = Function.prototype.call.bind(Array.prototype.join);
```

— which runs long before the failing instruction (at byte offset +149,658 in
one measured module). `bind` is *incidental*: it is merely the first thing in
the harness that allocates a local.

The reduced repro contains **no `bind` at all**:

```js
function g(obj, name, verifyProp) { return !!verifyProp; }
function f(obj, name, verifyProp, value) {
  if (g(obj, name, verifyProp)) { return 2; }
  return 3;
}
f({}, "length", null, function () { return "shifted"; });
```

This also explains the previously-recorded, unexplained observation that *"a
synthetic `call.bind` does NOT reproduce it"* — correct, because `bind` was
never the mechanism.

## Root cause

`fixupExternConvertAny` (`src/codegen/fixups.ts`) contains a repair pass:
for each `call`/`return_call`, if an argument is `ref.null.extern` but the
parameter is a GC ref, rewrite it to `ref.null $T`.

To decide *which* argument an instruction produces, it walked **backwards**
from the call assuming **one instruction == one argument**, with a
hand-maintained list of exceptions:

| op                | handling                        |
| ----------------- | ------------------------------- |
| `local.tee`       | stack-neutral, retry same param |
| `struct.new`      | skip N field producers          |
| `array.new_fixed` | skip N element producers        |
| `call`            | skip M argument producers       |

Every stack-neutral op **missing** from that list silently burns one parameter
index and shifts the entire pairing by one.

`extern.convert_any` was missing — and codegen emits it on essentially every
boxed argument. For the repro, `__module_init` holds:

```wat
call     $objlit          ;; arg0  {}
global.get $str_length    ;; arg1  "length"
ref.null.extern           ;; arg2  null
ref.func $closure_body    ;; \
i32.const 0               ;;  |  struct.new field producers
i32.const 1               ;; /
struct.new $closure       ;; arg3  function expression
extern.convert_any        ;; arg3 → externref
call     $f
```

The backward walk consumed **param 3** on `extern.convert_any`, **param 2** on
`struct.new`, and then handed `ref.null.extern` — which is argument **2**, an
`externref` parameter — to **param 1**, a `(ref null $AnyString)`. It rewrote
the null to a string-typed null, and V8 rejected the module.

The `local.tee` entry in that table was itself added to stop this exact class
of mis-pairing (`#1605-cpn`), so this is the second time the list has been
short. It is also **unfixable by extending the list**: a producing consumer
such as `f64.add` (pop 2 / push 1) makes the walk step into its *own* operands,
so `f(null, a + b)` never reaches the null at all — a silent *missed* rewrite
that has always been there.

This is the same shape as **#3989**: two halves that must agree about a slot's
type living apart and drifting. There, the load was made slot-type-aware and
the store was not. Here, the emitter knows the parameter types exactly
(`getFuncParamTypes` reads the emitted signature) and the repair pass
re-derives them from a pattern match.

## Fix

Model the operand stack instead of pattern-matching it.

- `instrPopsPushes(instr, mod)` — **exact** `(pops, pushes)` per instruction.
  Deliberately not `instrStackDelta`, which returns only the NET delta and is
  documented as "a conservative approximation": net delta cannot tell `drop`
  (pop 1 / push 0) from `i32.add` (pop 2 / push 1), and that is precisely the
  distinction argument attribution needs. Returns `null` for anything it
  refuses to model.
- `locateCallArgProducers(instrs, mod)` — one **forward** pass carrying a
  producer-instruction index per live stack slot. At each `call` it snapshots
  the top-N producers; those are the argument producers, exactly.

Slot attribution rule: a stack-neutral transformer (`local.tee`,
`extern.convert_any`, `ref.cast`, …) **owns** the slot it rewrites; we do not
see through it, because the value's type at the call is the transformer's
output type, not the underlying producer's.

The map is **partial by design**: the walk stops at the first instruction it
refuses to model (a terminator, an unknown op, a stack underflow), and calls
recorded before that point are still exact. Calls absent from the map fall
through to the legacy backwards walk — so the pass can never rewrite *fewer*
call sites than it did before.

## Measurements

Row timestamp `2.8.2026, 03:32` · corpus `test262-standalone-current.jsonl`
(loopdive/js2wasm-baselines) · official 43,505 / 25,995 pass (59.75%) ·
goal scope 8,545 run / 6,298 pass (73.70%) / **0 unopenable**.

Funnel, reported per stage:

| stage         | count | note                                                        |
| ------------- | ----: | ----------------------------------------------------------- |
| population    |    53 | goal-scope `invalid Wasm binary`                            |
| mechanism     |    28 | `call[N] expected externref, found ref.null` (this issue)   |
| reachable     |    28 | all 28 compile; the crash is at instantiate, not compile    |
| **flips**     |    24 | measured with `runTest262File`, standalone target, serially |

Kill-switch control (the fix reverted, same 28 files, same runner): **28 fail
/ 0 pass**. With the fix: **24 pass / 4 fail**. The 4 residuals fail on
unrelated semantics once the module runs at all.

## Residual

The other 25 goal-scope `invalid Wasm binary` files are separate mechanisms and
are NOT addressed here:

- 12 `local.set[0] expected externref, found call_ref of type i32` in
  `__call_fn_method_N`
- 8 `f64.add/sub expected f64, found global.get of type i32` — `++`/`--` on an
  i32-typed global; explicitly **not** the externref family
- 2 `local.set expected (ref null 6), found struct.get of type i32`
- 2 `type error in fallthru`
- 1 `any.convert_extern expected externref, found if`
