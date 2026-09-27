---
id: 6615
title: "standalone: a DYNAMIC call/construct hard-casts every externref argument into the callee's declared ref formal, so a parameter typed only by its own default initializer (`calendar = \"iso8601\"` ⇒ `string`) TRAPS on `undefined` and on every wrong-typed value instead of running its default or throwing the callee's own TypeError"
status: done
completed: 2026-09-15
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s28-lane
created: 2026-09-15
loc-budget-allow:
  # 2026-09-15 (#6615): INHERITED red, restated here — not growth this change
  # made. This PR touches only `src/codegen/**` (+ this issue file and one
  # test); `src/runtime.ts` measures 19,822 against a 19,601 ceiling under
  # `LOC_GATE_BASE=origin/main` because main's post-merge baseline refresh has
  # not caught up with an earlier slice's landed growth. The grant lives in an
  # issue file this PR does not modify, so CI's merge-preview base would report
  # it as a STRANDED grant and fail `quality` (the #6612/#6613/#6614
  # precedent). Restated verbatim rather than fixed: re-splitting `runtime.ts`
  # is not this slice's work, and lowering the number by editing the baseline is
  # forbidden (main is its sole writer, #3131).
  - src/runtime.ts
func-budget-allow:
  # 2026-09-15 (#6615): same inherited red, same rationale — `buildImports` is
  # 308 against a 300 ceiling under `LOC_GATE_BASE=origin/main`. Untouched by
  # this PR.
  - src/runtime.ts::buildImports
---

## Problem

Under `--target standalone` (and WASI), a value reaching a compiled function
through a **dynamic** entry point — `__class_construct_dispatch`'s per-class
trampoline, or a closed-method dispatcher — is marshalled into the callee's
declared parameter type by `externArgCoercionInstrs`. Its ref arm is two
instructions:

```ts
out.push({ op: "any.convert_extern" });
out.push({ op: "ref.cast", typeIdx: (want as { typeIdx: number }).typeIdx });
```

`ref.cast` is the NON-null variant, and a failed `ref.cast` is a wasm **trap** —
it kills the instance, so no `catch` in the program can observe it.

The formal's type, meanwhile, is whatever the CHECKER inferred. For a parameter
typed only by its own **default initializer** those are not the same question:

```js
class PD { constructor(y, m, d, cal = "iso8601") { this.t = typeof cal; } }
function mk(C, a, b, c, d) { return new C(a, b, c, d); }

mk(PD, 2020, 12, 24, undefined);  // TRAP illegal cast — spec: run the default
mk(PD, 2020, 12, 24, null);       // TRAP illegal cast — spec: the body sees null
mk(PD, 2020, 12, 24, 1);          // TRAP illegal cast
mk(PD, 2020, 12, 24, {});         // TRAP illegal cast
mk(PD, 2020, 12, 24, "gregory");  // "gregory" — only a MATCHING type survives
mk3(PD, 2020, 12, 24);            // "iso8601" — a MISSING argument is fine
```

`cal = "iso8601"` makes TypeScript infer `cal: string`, which lowers to a
`(ref null $string)` formal. The declared type describes the DEFAULT, not the
argument, and a dynamic caller is under no obligation to honour it.

test262 spells this `built-ins/Temporal/**/calendar-undefined.js` (the default
must apply for an explicit `undefined`) and `calendar-wrong-type.js` (ten
wrong-typed values, each of which must throw a **TypeError** — the polyfill's own
`Ve` is `if ("string" != typeof e) throw new TypeError(…)`).

## Fix

`src/codegen/extern-arg-marshal.ts` — the one module that owns this marshal —
mints, per formal type, a lenient replacement for the inline cast:

```
__extern_arg_ref_<typeIdx>[_opt] (externref) -> (ref [null] $T)
```

Three arms, and the ONLY values that reach arms 1 and 3 are exactly the ones
`ref.cast` would already have **trapped** on, so no program that previously
worked can change its answer:

1. **`undefined` into a DEFAULTED nullable formal → `ref.null`.** The callee's
   parameter prologue fires a ref-typed default on `ref.is_null`
   (`function-body.ts`), so a typed null IS the "run your default" signal — the
   ref-lane twin of #5380's f64 sNaN sentinel.
2. **A value that inhabits `$T` → the same cast as before**, byte for byte.
3. **Anything else → a catchable `TypeError`** (a real instance: `e instanceof
   TypeError` and `e.constructor === TypeError` both hold — measured). A number,
   a boolean, a symbol, `null` or a foreign object cannot be REPRESENTED in a
   `(ref null $string)` formal, so the callee cannot run its own check on the raw
   value; throwing is what the callee would have done for every one of the ten
   values `calendar-wrong-type.js` passes, and unlike a trap it leaves the
   instance alive.

A helper FUNCTION rather than inline instructions, for the reason
`ensureUnboxNumberOrOmitted` already is one: the argument may come from
`__extern_get_idx`, so the sequence must not evaluate it twice — and a function
needs no scratch local in callers whose local layout was fixed at reserve time.

**Gate / byte-neutrality.** The TypeError instance and its message cannot be
created at fill time, so the terminal throw is armed mid-compile — the same
reserve-then-fill discipline, and the same call site, as #6612's IsConstructor
guard. No-JS-host lanes only. An unarmed module gets `lenientRefArg` →
`undefined` and emits exactly the bytes it did before.

Arming has **two** sites, and both are gated on
`moduleHasRefTypedConstructFormal`:

- `armExternRefArgTypeGuard`, at the dynamic `new <runtime value>` expression;
- `armExternRefArgTypeGuardForLinkedProvider`, post-bodies in both codegen
  paths, for `ctx.exportsConsumedByWasm`. A **linked provider's** construct
  trampolines are driven from another module entirely
  (`__js2wasm_link_construct`), and the `@js-temporal/polyfill` provider
  compiles no dynamic `new <value>` site of its own — measured: with only the
  first site its artifact stayed byte-identical and every
  `new Temporal.PlainDate(2000, 5, 2, null)` still trapped across the link.

The predicate reads `structMap` (filled by `collect-declarations`) rather than
`classObjectGlobals`, which is materialised lazily and is still empty at the
expression site. Without it, a module whose classes take only `f64`/`i32`
formals paid **+232 B** for a message it could never reach (measured).

## Acceptance criteria — all met

- `new Temporal.PlainDate(2000, 5, 2, <wrong type>)` throws a catchable
  TypeError instead of trapping, across the link. **Met**: all 13 corpus-wide
  `calendar-undefined.js` / `calendar-wrong-type.js` files go 3 → 13 pass.
- `new Temporal.PlainDate(...args, undefined)` applies the `"iso8601"` default.
  **Met** (same rows, plus the witness's typed assertion that the default's own
  type is observed).
- 0 legitimate pass→fail on the four-family sample and the must-not-move groups.
  **Met**: four families 419 → 423, 0 pass→fail, the 4 fail→pass rows are exactly
  the 4 `illegal cast` rows; 356 must-not-move rows across three groups, 0 flips;
  corpus byte A/B 84 artifacts, 0 move; equivalence gate at baseline
  (22 failing / 1,720 passing / 22 known).

## Implementation notes

See the "S28 findings" section of
`plan/issues/5383-standalone-temporal-provider.md`.
