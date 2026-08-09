---
id: 3638
title: "Reflective `.call`/`.apply` on an INSTANCE-read builtin method casts unconditionally — uncatchable illegal_cast trap (standalone)"
status: done
assignee: ttraenkler/opus-loop-c
sprint: 77
priority: high
horizon: m
feasibility: hard
goal: standalone-gap
related: [3610, 3620, 2876, 2193, 3619]
created: 2026-07-25
completed: 2026-07-25
---

# Reflective `.call` on an instance-read builtin method traps instead of throwing

## Problem

`emitReflectiveNativeProtoClosureCall` (`src/codegen/expressions/calls.ts`,
#2876/#2193 PR-B) recovers the native-method wrapper from the receiver with an
**unconditional non-null `ref.cast`**:

```ts
const recvType = compileExpression(ctx, fctx, receiver);
if (recvType && recvType.kind === "externref") fctx.body.push({ op: "any.convert_extern" });
fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx }); // ← unconditional
```

The gate that selects this lowering proves the receiver's **STATIC TYPE** is a
builtin-prototype `MethodSignature`:

```ts
const sym = ctx.checker.getTypeAtLocation(receiver).getSymbol();
// decl is a MethodSignature on interface Array / Object / String / …
```

Two **different receiver syntaxes** share that static type and lower to
different runtime values:

| receiver syntax                       | value read lowers to                          | cast   |
| ------------------------------------- | --------------------------------------------- | ------ |
| `Array.prototype.fill` (+ a var bound to it) | the identity-stable `__builtinfn_singleton_*` wrapper | ✔      |
| `a.fill`, `[].fill` (**instance** read) | the dynamic `__extern_get(vec, "fill")` path  | **✘**  |

The instance read yields **null** today, and a non-null `ref.cast` on null traps
`illegal cast`. **A trap is uncatchable**: it aborts the module, so the
enclosing `try`/`catch` — and test262's `assert.throws` — can never observe it.

```js
var o = {};
[].fill.call(o, 1); // → RuntimeError: illegal cast, escapes try/catch
```

The JS-host lane raises a *catchable* `TypeError` ("Cannot read properties of
null (reading 'call')") for the same program, so the trap is also a lane
divergence.

This is the same shape as **#3610's "reusable generalisation"** — an
unconditional `ref.cast` justified by a static type that no longer describes the
runtime value — applied to the residual bucket #3620's census recorded as
`illegal_cast [in __closure_# ← __closure_# ← __call_fn_method_# ←
__apply_closure]` and explicitly left unowned.

## Root cause

The gate proves a property of the receiver's **type**; the cast needs a property
of the receiver's **value**. Nothing bridges the two.

## Fix

`src/codegen/reflective-call-receiver.ts` (new subsystem module; `calls.ts`
keeps only the dispatch wiring, +8/−6 lines, so the LOC ratchet stays flat).

§23.1.3: `a.fill` **is** `Array.prototype.fill` — the same function object,
reached through the prototype chain. So an instance-read receiver resolves to
the **same per-(brand, member) singleton** the `.prototype` spelling reads, with
the base evaluated only for its side effects. The two spellings then behave
observationally identically instead of one of them trapping; every already-
working shape keeps its byte-identical lowering (the `else` arm is the old code
verbatim).

Two deliberate details:

- **`pushBuiltinFnSingletonValueInstrs`, not a fresh `ref.func` + `struct.new`.**
  Minting the closure per call site was tried before and tripped a
  wrapper-struct type-idx consistency check at finalize (the probe and the final
  wrapper in `ensureStandaloneNativeMethodClosure` register distinct struct
  types) — that prior failure is recorded in the pre-existing comment in
  `calls.ts`. The singleton global is the mechanism that already solved it, so
  identity is preserved rather than merely "a callable is produced".
- **A conservative purity test on the base.** A side-effect-free base is not
  compiled at all — its value is discarded anyway, and compiling a bare `[]` in
  expression position *fails* ("empty array literal needs a vec-typed hint"),
  which would convert a runtime trap into a compile error. Anything not provably
  pure IS compiled and dropped, so side effects still happen in source order
  (pinned by the `f().fill.call(t, 9)` counter test).

No raw-checker query is added, so the #1930/#3273 oracle ratchet is untouched.

## Measured reach

Whole target bucket (all 43 rows of the `__closure_# ← __closure_# ←
__call_fn_method_# ← __apply_closure` frame signature), run standalone
before and after on this branch. Baseline: `test262-standalone-current.jsonl`
force-fetched 2026-07-25, 48,088 rows.

|                             | before | after  |
| --------------------------- | -----: | -----: |
| rows trapping (uncatchable) | **43** | **27** |
| rows passing                |      0 |  **6** |
| new traps introduced        |      — |  **0** |
| pass → fail regressions     |      — |  **0** |

**16 of 43 de-trapped; 6 of those flip to pass.** Reported gross, not as a net.

The 6 pass flips are the `TypeError`-expecting members of the bucket, which now
raise a catchable `TypeError` instead of aborting the module:

```
Array/prototype/flatMap/this-value-null-undefined-throws.js
Array/prototype/sort/comparefn-nonfunction-call-throws.js
Array/prototype/{find,findLast,findLastIndex,copyWithin,fill}/…-as-symbol.js  (4)
```

> **Honesty note on the flips.** These tests assert only *that* a `TypeError` is
> thrown, not where it originates. The `TypeError` now raised comes from the
> native member body rejecting the receiver — plausibly, but not provably, the
> same one §7.1.20 / ToLength would raise. They are counted as **de-trapped**
> first and as passes second; the de-trapping is what this change proves.

### The bucket was a FRAME, not a single cause — 27 rows remain

Exactly the failure mode #3620 warned about. The residual splits into causes
this change does not touch, and none of them is a reflective-call cast:

| residual family                                             | rows | note                                   |
| ----------------------------------------------------------- | ---: | -------------------------------------- |
| `null_deref` — Proxy gOPD / deleteProperty invariants        |    5 | #3610 remaining-work item 3            |
| `null_deref` — `Function.prototype[Symbol.hasInstance]`      |    3 | #3610 remaining-work item 2            |
| `null_deref` — `Date.prototype[Symbol.toPrimitive]`          |    2 |                                        |
| `null_deref` — ThrowTypeError, `Symbol.for`, `split`, private-fields-proxy | 4 |                        |
| `illegal_cast` — `TypedArray.prototype.join` separator       |    4 |                                        |
| `illegal_cast` — `String.prototype.replaceAll` replaceValue  |    2 |                                        |
| `illegal_cast` — `escape` / `unescape` ToPrimitive           |    2 |                                        |
| `illegal_cast` — `Object.define{Property,Properties}`        |    2 |                                        |
| `illegal_cast` — direct-eval `arguments` lexical binding     |    2 |                                        |
| `oob` — `Array.prototype.with`                               |    1 |                                        |

## Residual (known, pinned, NOT fixed here)

1. **`var f = [].fill; f.call(o, 1)` still traps.** The receiver is an
   identifier, so the syntactic classifier cannot see that its value came from
   an instance member read. Tracing the declaration initializer would need a
   raw-checker query (oracle-ratchet); the runtime-guard alternative
   (`ref.test` + else-arm) is the principled general fix and is left for a
   follow-up. No test262 row in the bucket depends on this shape. Pinned as a
   KNOWN GAP test so closing it flips loudly.

2. **The upstream defect: `a.fill` reads as `null` on BOTH lanes.** Measured:

   | expression                       | standalone | host |
   | -------------------------------- | ---------- | ---- |
   | `var a=[1]; a.fill` truthy       | 0          | 0    |
   | `a.fill === null \|\| undefined` | 1          | 1    |
   | `Array.prototype.fill` truthy    | 1          | 1    |

   An instance member value-read of a builtin prototype method does not resolve
   to the method — `tryCompileStandaloneBuiltinProtoMemberRead` requires the base
   to be literally `<Ident>.prototype`. This change compensates at the CALL site;
   it does not fix the value read. That is the real fix for residual 1 and for
   `a.map`-style code generally.

3. **`a.fill.call(t, 9)` throws where `Array.prototype.fill.call(t, 9)` returns.**
   Not a divergence this change introduced (main *trapped* there): an earlier
   array-aware arm claims the `.prototype` spelling when the `thisArg` is a known
   vec, so the two spellings reach different lowerings. The reflective lowering's
   own native `fill` body rejects a vec `thisArg` with a `TypeError`.

## Test — premise-asserted, merge-base-red

`tests/issue-3638-reflective-instance-method-call.test.ts`, 18 cases,
**15 verified RED against unmodified `upstream/main`** (`git checkout
upstream/main -- src/codegen/expressions/calls.ts`). The 3 that stay green are
the two negative controls and the KNOWN-GAP pin — green both ways by design.

**The suite asserts its own premise** (#3619's sibling discipline: a regression
test proves the fix *detects* the bug; a premise assertion proves it *exercises
the path it claims to*). Each covered program is checked to compile to a module
containing `__builtinfn_singleton_`, i.e. it really reaches the fixed lowering,
with two negative controls that must NOT contain it.

**This was not theoretical.** The first draft of this suite was built on
`[].fill.call(t, 9)` and `Array.prototype.fill.call(t, 9)` with a real array —
the obvious spellings. Both are claimed by an **earlier array-aware arm** and
never reach the reflective lowering at all, so those assertions passed on
unmodified main and covered nothing. Only the premise check exposed it.

Every behavioural assertion reads an observable value out of the module (a
caught-error discriminant, a side-effect counter); "it compiles" is never
asserted, and an uncatchable trap surfaces as a rejected instantiation, so
"no trap" is enforced by the tests completing at all.

## Regression evidence

- `npx tsc --noEmit` clean.
- The 43-row bucket A/B above: 0 new traps, 0 pass→fail.
- Adjacent reflective-call / native-proto suites (`issue-3610-*`, `issue-2984-*`,
  `issue-2876-*`, `issue-2193-*`, `host-import-allowlist-*`) — see the PR body.
- The full test262 regression measurement is the `merge_group` re-validation on
  the merged state; PR-level `check for test262 regressions` is a designed
  green no-op.
