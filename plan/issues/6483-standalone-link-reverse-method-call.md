---
id: 6483
title: "standalone link: a PROVIDER calling a method on a CONSUMER-owned receiver throws TypeError"
status: done
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s18-lane
completed: 2026-09-14
loc-budget-allow:
  # 2026-09-14 (#6483): the reverse channel (#6478) grows a fifth terminal —
  # `__js2wasm_link_reverse_method_call` — plus its consumer-side local wrapper,
  # its peer global, its `callOwned` null-vs-miss global and the provider-side
  # miss arm. Measured: without it, provider code doing `o.m()` on a
  # consumer-owned bag throws `TypeError: called value is not a function`
  # (`.tmp/s18/c7`, linked pair, `--target standalone`). The growth is one
  # terminal built from the same `reverseHopBody`/`define` helpers the other
  # four use; the alternative (deriving it from `get` + `apply`) is measured
  # WRONG, see "Why it is not `get` + `apply`" below.
  - src/codegen/standalone-link-reverse-peer.ts
  - src/codegen/object-runtime.ts
func-budget-allow:
  # 2026-09-14 (#6483): one new exported arm builder,
  # `reverseMethodCallArmInstrs`, the exact twin of `reverseGetArmInstrs`.
  - src/codegen/standalone-link-reverse-peer.ts
---

# #6483 — standalone link: provider → consumer method calls

Child of [#5383](5383-standalone-temporal-provider.md) (S18), following
[#6478](6478-standalone-link-reverse-peer-read.md) (S17).

## Problem

S17 gave the standalone link its reverse channel: a PROVIDER can now READ a
carrier its CONSUMER owns (`o[k]`, `k in o`, `Object.keys(o)`). It could still
not CALL one. Measured on a host-free linked pair, `--target standalone`
(`.tmp/s18/c7.mjs`, this worktree):

```js
// consumer
const b = { m: function () { return 7; } };
NS.callm(b);                      // provider: callm: function (o) { return o.m(); }
```

| probe | base | expected |
| --- | --- | --- |
| provider reads `typeof o.m` | `"function"` | `"function"` |
| provider calls `o.m()` | **`TypeError: called value is not a function`** | `7` |

The read crosses (S17); the call does not.

## Root cause

`__extern_method_call`'s non-`$Object` receiver arm consults a peer before it
gives up — `boundaryObjectCallIdx ?? peerMethodCallIdx`, the host-lane boundary
call and the forward (consumer→provider) `__js2wasm_link_method_call` terminal
(S2h). **A provider has neither.** `boundaryObjectCallIdx` is the JS-host lane's
and `peerMethodCallIdx` is the consumer's, so in a provider the arm is empty and
control falls straight through to `buildVecOrClosurePropMethodCallElseArm`'s
terminal miss, whose resolved-callee guard (`resolved-callee-guard.ts`, #4221 /
#4656) throws `TypeError: called value is not a function`.

That guard is correct — an unresolved method IS a TypeError. The defect is that
the provider had no way to resolve it, because the only module that can is the
consumer.

### Why it is not `get` + `apply`

The same reason the FORWARD terminal is its own export rather than a
composition (S2h): the method closure's trampoline reads `this` from its OWNING
module's `__current_this` global. A closure shipped across and applied on the
other side binds nothing. Resolution and application both have to run in the
module that owns the receiver, which is what this terminal does.

### Why the arm does NOT adopt a `null` answer — the opposite of the `get` hop

S17's `__extern_get` hop adopts a null as the VALUE when the peer says it owns
the receiver and the key is present, because for a READ those two facts settle
it. For a CALL they do not. The hop answers `ref.null.extern` for **three**
different reasons:

| the hop answered null because… | correct continuation |
| --- | --- |
| the consumer does not own the receiver | this module's own miss path |
| it resolved the method and `__apply_closure` declined | this module's own miss path (a real TypeError) |
| the method ran and returned `null` | return the null |

Nothing available to the arm separates the last two. A first cut used the
already-installed `has` terminal as an owned-oracle, exactly mirroring
`reverseGetArmInstrs`; measured, it turned `o.add(3, 4)` into `null` and
`this.v` into `undefined` where both had thrown (`.tmp/s18/witness-new.out`) —
a silent wrong value replacing a correct TypeError.

The shipped arm therefore returns **only** a non-null answer. That makes it
strictly throw-reducing and never answer-changing, at the cost of leaving "a
consumer method that legitimately returns `null`" unfixed (see the residuals).

### Why `localMethodCall` installs `__current_this`

Composing `__extern_get` + `__apply_closure` by hand dispatches the call but does
not bind the receiver for an object-LITERAL method: `{ v: 42, readSelf() { return
this.v; } }` answered `NaN` through the hop and `42` in a single module
(`.tmp/s18/c10-new.out`). A class instance bound correctly either way, so the gap
was invisible in half the shapes and would have shipped as a regression.

Delegating to this module's own `__extern_method_call` instead does not work —
a consumer's own object literal is a CLOSED struct, so that native takes its
non-`$Object` arm, asks the provider, and recurses into the same miss
(`.tmp/s18/c10-new2.out`: all three literal probes throw). So the terminal
installs and restores `__current_this` around the apply itself, through
`try`/`catch_all` + `rethrow` — a leaked receiver would be a wrong answer for the
rest of the instance's life, and a throw out of a provider-initiated call is
ordinary (S2m).

## Fix

`src/codegen/standalone-link-reverse-peer.ts`:

- `__js2wasm_link_reverse_method_call` — provider-internal hop, through the new
  `__js2wasm_link_peer_method_call` funcref global, under the existing
  re-entrancy flag and its `try`/`catch_all` + `rethrow` restore.
- `__js2wasm_link_local_method_call` — the consumer-side terminal it calls:
  `__extern_get`, then `__apply_closure` inside a `__current_this`
  install/restore, normalising unresolved/`undefined` to `ref.null.extern` =
  "not mine".
- `reverseMethodCallArmInstrs` — the provider-side miss arm; returns only a
  non-null answer, and otherwise falls through to the pre-#6483 path unchanged.
- `__js2wasm_link_install_peer` grows from four funcref parameters to five.

`src/codegen/object-runtime.ts`: the reverse arm takes the same slot as the
forward/host call arm when neither of those exists.

A provider whose consumer never installs keeps null globals and answers exactly
what it answered before; the JS-host and single-module lanes never reach any of
it.

## Test

`tests/issue-6483-link-reverse-method-call.test.ts` — linked-pair witness. Two
teeth (both `-1` on base, `.tmp/s18/witness-base.out`): a provider method calling
`o.m()` on a consumer-built object literal answers `7`, and one that reads `this`
answers `42`. Five controls are asserted rather than omitted, because each is a
residual this slice deliberately did not fix and a change in any of them is a
real event.

## Deliberately NOT fixed here — measured, with probes

1. **The forward terminal's `null` is still three states** (`.tmp/s18/c7`):
   `NS.retnull()` — a provider method legitimately returning `null` — throws
   `called value is not a function`, while `NS.retundef()` is correct. A first
   cut of this slice fixed it consumer-side by re-asking `memberGet` +
   `callableKind` on the null path. **It was reverted after measurement**: the
   terminal also answers `null` when it resolved the method and
   `__apply_closure` declined, and adopting that null converts a loud TypeError
   into a silent wrong value. `.tmp/s18/c3-new.out` shows the damage —
   six probes went from a TypeError to `"null"`. Doing this properly needs a
   provider-side "I really did run it" channel, i.e. a forward ABI addition.
   The REVERSE direction has the identical hole for the identical reason and is
   left open deliberately — the witness asserts `methodReturningNull` still
   throws, so closing it later is a visible, deliberate change rather than a
   silent one.
2. **`f.call(recv, …)` / `f.apply(…)` on a provider-owned closure**
   (`.tmp/s18/r4-inst.out`): the instrumented terminal reports
   `MC-EXIT-UNDEFGET` — the provider resolves `call` on its own closure as
   `undefined`. `Function.prototype.call` is not reachable on a boundary
   closure.
3. **The real Temporal bucket is a LITERAL-vs-COMPUTED member-name split, and it
   is in a third place again** — see the S18 findings in
   [#5383](5383-standalone-temporal-provider.md) §"the literal-name dispatch
   path". `Temporal.Duration.from("P0Y")` throws while
   `Temporal.Duration[k]("P0Y")` with `k = "from"` answers correctly, and the
   instrumented forward terminal proves it is **never consulted** on the literal
   path. That is the next slice.
