---
id: 6641
title: "standalone: a COMPUTED-KEY method call on a linked-provider-owned externref receiver returns null (`api[k](3,4)` → `null` where `api.add(3,4)` → `7`)"
status: done
assignee: ttraenkler/senior-dev-s58
sprint: current
priority: high
horizon: s
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-18
completed: 2026-09-18
loc-budget-allow:
  # 2026-09-18 (S58, #6641) — two new arms wired into the computed-key call
  #   site's element-access dispatch (call-receiver-method.ts already has the
  #   literal-key twin, `#799 WI3`, in a different file so it does not need a
  #   grant): a 3-line "try the standalone/wasi generic arm" block after each
  #   of the two existing `tryEmitDynamicElementHostMethodCall` call sites,
  #   plus the new import. The actual dispatch logic lives in the NEW module
  #   `dynamic-element-generic-call.ts`, deliberately not in the god-file.
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  # 2026-09-18 (S58, #6641) — same two 3-line call sites land inside
  # `compileTailDispatch`, the single function `call-tail-dispatch.ts`
  # dispatches through; the new logic itself is a function in the new,
  # separate `dynamic-element-generic-call.ts` module.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
---

## Problem

Under `--target standalone` (and `wasi`), a COMPUTED-key method call on a
linked-provider-owned externref receiver answered `null`:

```ts
const api = getProviderNamespace(); // any-typed, crosses a `field(): any` getter
api.add(3, 4); // 7 — correct
const k = "add";
api[k](3, 4); // null — WRONG, should be 7
```

Found by S57 (#5383 S57) while reducing
`ZonedDateTime/prototype/add/math-order-of-operations-add-{constrain,none}.js`
to a Temporal-independent two-module fixture; this issue blocks those 2 rows
and every `recv[op](…)` shape crossing a standalone provider/consumer link.

## Root cause (S58)

Instrumented with temporary runtime debug globals/exported getters (removed
before commit; see git history of this commit's parent for the exact probes)
to trace exactly where the call was lost. Findings, in order:

1. `ref.test $Object` in the CONSUMER's `__extern_method_call` does NOT match
   a provider-owned plain-object receiver (the module-local-ladder "miss-path"
   design documented at the top of `standalone-link-boundary.ts` holds).
2. The consumer's else-arm correctly reaches
   `boundaryOrPeerCallIdx` → `call $__js2wasm_link_method_call` (confirmed via
   `wasm-dis` — the funcIdx-authority-shift concern from `#1899`/`#5383 S2f R12`
   was a false lead this session: `eliminateDeadImports` correctly renumbers
   every reference when unused peer terminals like `construct`/`toStringTag`
   are pruned).
3. But: a call-counter global placed INSIDE the provider's
   `__js2wasm_link_method_call` wrapper incremented once per LITERAL-key call
   (`api.add(3,4)`) and never incremented for a COMPUTED-key call
   (`api[k](3,4)`) — the wrapper was never invoked at all for the computed
   shape.
4. Traced to the CALL SITE: `call-tail-dispatch.ts`'s computed
   (`ElementAccessExpression`) call-site handling has arms for a user-class
   receiver, a TS-KNOWN plain-object-literal receiver, and (JS-host only)
   `tryEmitDynamicElementHostMethodCall` (gated on `!noJsHost(ctx)`) — but
   nothing covers the generic `any`/externref receiver under
   `--target standalone`/`wasi`. A linked-provider value's static TS type is
   always `any` (it crossed a `field(): any` getter stub), so EVERY arm
   declined and the call fell through to the silent
   drop-everything-return-`ref.null.extern` fallback — the exact same
   fallback the `(#4482)` comment right above it names as "the point where
   'no arm recognised this call' becomes the silent VALUE undefined."

   The LITERAL-key twin (`api.add(3,4)`) never hits this gap:
   `call-receiver-method.ts`'s `(#799 WI3)` arm is a GENERIC
   `__extern_method_call(recv, name, args)` dispatch for exactly this
   `any`/externref shape, with no `!ctx.standalone` gate — its `native-first`
   branch (`ensureObjVecBuilders`) already covers standalone/wasi. The
   computed-key call site simply never got the same arm.

## Fix

`tryEmitGenericComputedMethodCall`
(`src/codegen/expressions/dynamic-element-generic-call.ts`, new file) — the
`noJsHost` twin of `tryEmitDynamicElementHostMethodCall`
(`dynamic-element-host-call.ts`): computes the method NAME at RUNTIME
(`elemAccess.argumentExpression` compiled to externref — the same key
marshaling the working element-access READ path already uses successfully,
see `compileElementAccessBody`'s generic `__extern_get(recv, key)` arm)
instead of a string constant, builds the args vec via `ensureObjVecBuilders`
(mirroring WI3's `native-first` branch), and calls `__extern_method_call`
generically.

Wired into BOTH branches of the computed-call dispatch in
`call-tail-dispatch.ts` (the resolved-method-name branch and the
unresolved-key branch), immediately after each
`tryEmitDynamicElementHostMethodCall` call site — same position, opposite
`noJsHost` gate, so the two arms are mutually exclusive and byte-identical to
before on the JS-host lane (`tryEmitGenericComputedMethodCall` returns
`undefined` immediately when `!noJsHost(ctx)`).

## Witness

`tests/issue-6641-link-forward-computed-method-call.test.ts` — a
Temporal-independent synthetic two-module fixture (S57/S58 pattern,
`hostBridge: "off"`, empty import object):

- computed-key call with 0/1/2/3 args on a provider object-literal method
- computed-key call on a provider class instance method
- chained computed `x[k]()[k]()`
- a computed key naming a non-function → the same `TypeError` the literal
  path already throws
- controls: literal-key call unchanged, in-module (non-linked) computed call
  unchanged

File-copy revert-and-measure (`git show HEAD:… > .tmp/s58/fix/*.base`,
restored after measuring): FAILS on base tree (`expected null to be 7`),
PASSES with the fix.

`tests/issue-6605-link-reverse-method-call.test.ts` (the REVERSE
direction — provider calling a consumer-owned receiver's method) has one
control that DOES move: `callsThroughComputedKey` flips from its documented
residual `null` to `7`, matching its literal-key twin
(`callsConsumerMethod`, already `7`). This fix's new arm is `noJsHost`-gated,
not consumer-vs-provider-gated, so it also applies inside the PROVIDER's own
compile for `var k = "m"; o[k]()` — reaching `__extern_method_call`
generically for the first time, which #6605 had already wired for the
reverse-peer hop. Updated that test's assertion + added a dated comment
citing this issue; every other #6605 teeth/control is unchanged (measured in
the same battery run as #6641).
