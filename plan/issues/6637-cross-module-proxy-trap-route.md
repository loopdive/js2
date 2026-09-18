---
id: 6637
title: "Standalone: dynamic (\"any\"-typed) property access on a Proxy throws — NOT a cross-module defect"
status: blocked
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
owner: sendev-s52c
---

# #6637 — dynamic property access on a Proxy misroutes to "null or undefined" (S52c, #5383 stack)

## Origin

Dispatched as the S52c slice of #5383 (standalone Temporal). S52 diagnosed a
PROVIDER-side callable-classification gap; S52b implemented the prescribed
fix (a reverse-peer "is this externref callable" channel) and confirmed it
does not fix the empty-handler-Proxy repro, then found "the empty-handler GET
case is the load-bearing result" — no trap exists to misclassify, so S52's
diagnosis could not be the cause of `NS.readOverflow(new Proxy({overflow:1},
{}))` throwing across a standalone link. S52c was dispatched to find the real
cause under a "cross-module struct field layout" hypothesis.

## The corrected diagnosis: this is NOT a cross-module or struct-layout bug

**The leading hypothesis in scope (a `$Proxy`/`$ProxyTraps` field-order
mismatch between the two modules' canonical types) is falsified.** Every
piece of direct evidence contradicts it:

1. **The struct shapes are byte-identical.** Decompiled both binaries
   (`wasm-dis -all`, never wabt) and diffed the `$Proxy` (7 fields:
   `ptag`/`ptarget`/`phandler`/`ptraps`/`revoked`/`callable`/`constructible`)
   and `$ProxyTraps` (13 externref fields, `get`(0)…`construct`(12)) type
   declarations side by side — field count, field types, field ORDER all
   match. The field index constants (`TRAP_GET=0`, `F_PTARGET=1`, …) are
   literal numeric constants in `object-runtime-proxy.ts`'s source, baked
   identically on every compile — there is no registration-order dependency
   to diverge.
2. **`ref.cast $Proxy` genuinely succeeds in the provider** — confirmed by
   reading `__proxy_get_dispatch`'s own compiled body (`struct.get $19 4`
   [revoked], `struct.get $19 3` [ptraps], `struct.get $18 0` [get trap] —
   all correctly-indexed reads on the RIGHT canonical types). A failed
   canonical-type match would trap the whole cast, not silently misread one
   field.
3. **The bug reproduces through a PLAIN, minimal, single-argument, direct
   `call` to a top-level exported function — no `__apply_closure`/
   `__js2wasm_link_method_call` vec-args bridge involved at all.**
   `export function readOverflowDirect(o) { return o.overflow; }`, called as
   `readOverflowDirect(proxy)`, throws identically to `NS.readOverflow(proxy)`
   — ruling out S52b's own "peer-owned closure hijacks `__apply_closure`"
   mechanism (#5383 S41/#6628) as the cause here; that mechanism is real but
   is not THIS defect.
4. **Plain (non-Proxy) objects cross the exact same boundary correctly.**
   `hasOverflowDirect({overflow:1})`, `isExtDirect({overflow:1})`,
   `keysDirect({overflow:1})` (all `("overflow" in o)` / `isExtensible` /
   `Object.keys(o).length` style reads on a crossed `$Object`) all answer
   correctly (`1`/`1`/`1`). Only Proxy receivers misbehave.
5. **The decisive test: the SAME defect reproduces in a SINGLE STANDALONE
   MODULE with NO link, NO second instance, NO cross-module call at all.**
   ```ts
   function readOverflow(o) { return o.overflow; }   // untyped param — "any"
   export function readViaUntypedFn() {
     const options = new Proxy({ overflow: 1 }, {});
     try { return readOverflow(options) === 1 ? 1 : 2; }
     catch (e) { return -1; }               // → -1 (THROWS)
   }
   export function readViaKnownType() {
     const options = new Proxy({ overflow: 1 }, {});
     try { return options.overflow === 1 ? 1 : 2; }
     catch (e) { return -1; }               // → 1 (correct)
   }
   ```
   Both functions do the identical `.overflow` read on the identical
   `new Proxy({overflow:1}, {})` value, in the same module. The only
   difference is whether the receiver's static type is known (`options`,
   locally declared, TS infers `Proxy<...>`) vs unknown ("any" — `o` is an
   UNTYPED function parameter, exactly the shape every provider function's
   parameter has, since the link stub declares it as `any`). `readViaProxy`/
   `readViaEmptyProxyCross` etc. in the original repro only "looked"
   cross-module-specific because **every provider function parameter is
   necessarily untyped** — the real trigger is the untyped/"any" receiver,
   not the module boundary.

**Conclusion: `NS.readOverflow(proxy)`'s repro is an instance of a general,
single-module, standalone defect — dynamic ("any"-typed) property access on a
value that turns out to be a `Proxy` at runtime throws `TypeError: Cannot
access property on null or undefined`, instead of correctly dispatching
through the Proxy's trap machinery. The cross-module framing in #5383 S52/S52b
was a coincidence of where the untyped receiver came from, not the cause.**

## Root cause (traced to source)

`e.message.charCodeAt(i)`-decoded the actual thrown message (native strings
can't be `console.log`'d directly in standalone — decode via `.charCodeAt`,
not `wasm-dis`/host tricks) for the single-module repro's throw:

```
"Cannot access property on null or undefined at 2:50"
```

This is `typeErrorThrowInstrs`'s compile-time-baked message
(`src/codegen/property-access.ts` ~1398), and `diagNullCheck(o)` — a provider
probe doing `if (o === null) return 1; …` on the raw Proxy argument BEFORE any
property read — answers `1`: **the compiled code treats the live, non-null,
correctly-typed `$Proxy` receiver as if `===null`.** A companion probe
(`localNullCheckOfProxy`, same `===null` test on the SAME just-constructed
`options` value, no crossing) answers `3` ("genuinely not null") — so the
value is fine right up until the untyped-receiver dot-access runs its guard.

`emitNullGuardedStructGet` (`src/codegen/property-access.ts` ~1656) explains
the mechanism: for a member read where the compiler has a `propName` but no
certain static struct type for the receiver, it does a **guarded cast to some
assumed static struct type** (`emitGuardedRefCast`, `src/codegen/
type-coercion.ts` ~53) and then "multi-struct dispatch": try the primary
struct, then try every OTHER statically-known struct type that happens to
have a field literally named `overflow`. A `Proxy`'s properties are never
static struct fields — they resolve dynamically via `[[Get]]`/traps — so this
by-field-name struct search can never find `$Proxy`, the guarded cast fails
(produces `ref.null`), and `emitNullCheckThrow` (~1461) treats that failed
cast as "the receiver is null" and throws, instead of falling through to the
GENERIC dynamic path (`__extern_get`, which correctly recognizes `$Proxy` via
its own `ref.test` front-guard — confirmed working for `known-type` receivers
and for plain-`$Object` receivers in every control above).

The remaining trap/target-forward split observed in the original run (get/
set/delete THROW; has/isExtensible/`Object.keys` return silently-wrong
`0`/`0`/`0` instead of the correct `1`/`1`/`1`) is a SEPARATE downstream
consequence, not a separate defect: dot/bracket `[[Get]]`/`[[Set]]`/`delete`
compile through this same STATIC guarded-struct-cast+`emitNullCheckThrow`
path (property-access.ts), which throws on a struct-shape miss; `in`/
`Object.isExtensible`/`Object.keys` compile through the GENERIC dynamic
helpers (`__extern_has`/`__object_isExtensible`/`__object_keys`), which DO
correctly `ref.test $Proxy` and correctly recognize the trap-absent case —
their own miswiring (answering `0` instead of forwarding to the real target)
is a second, smaller, separate bug in that generic path, not investigated
further this session (lower priority: it does not throw, and it is reachable
only once the primary defect above is fixed for those receivers too, since
they were never gated by the guarded-cast throw in the first place — WAIT,
they already bypass it and already answer wrong on today's `main` equivalent,
independent of #6637's throw path; see "What's still open" below).

## What was implemented (this branch)

Nothing shipped. **S52b's WIP terminals were reverted** (`localCallableKind`/
`reverseCallableKind`/`localApply`/`reverseApply` in
`standalone-link-reverse-peer.ts`, plus the `__typeof_function` reverse
fallback arm in `typeof-natives-finalize.ts`) — they target a callable-
classification gap that this session's evidence shows is not implicated in
the empty-handler repro at all (no trap closure exists to misclassify, and
the defect reproduces identically with zero linking). Keeping unused,
untested cross-module plumbing in the tree pending a defect it does not fix
is not warranted; `git revert --no-edit HEAD` cleanly removed exactly S52b's
diff (`git diff 0bb08d20a0..HEAD -- src/codegen/standalone-link-reverse-peer.ts
src/codegen/typeof-natives-finalize.ts` is empty after the revert).

A fix for the REAL defect (untyped-receiver dot-access on a Proxy) was
**not** attempted this session. It is a different, larger-blast-radius change
than what was scoped for S52c: `emitNullGuardedStructGet`/
`emitGuardedRefCast`/`emitNullCheckThrow` are the generic machinery behind
EVERY "any"-typed property read in the compiler (not Proxy-specific), so a
fix has to reason about every other struct-shaped runtime value (open
`$Object` bags, class instances, Map/Set/RegExp carriers, wrapper primitives,
…) that ALSO reaches this path via an untyped receiver, to make sure a
"guarded cast failed — fall through to the dynamic path instead of throwing"
change does not regress an existing, deliberate "receiver really is the wrong
shape, throw" case elsewhere. That needs its own architect-level design pass,
not a same-session patch.

## What's still open

1. **The fix itself.** Likely shape: when `emitGuardedRefCast`'s cast fails
   AND the receiver's declared/inferred type is "any" (not proven to be one
   of the specific static struct candidates), `emitNullGuardedStructGet`
   should fall through to the GENERIC dynamic property-read helper
   (`__extern_get`/`__extern_set`/`__delete_property`, which already handle
   `$Proxy` correctly via `ref.test` front-guards) instead of treating the
   failed cast as null. Needs an architect pass on blast radius: which of the
   "multi-struct dispatch by field name" call sites are meant to be
   EXHAUSTIVE static resolution (legitimately throw on a genuine shape miss)
   vs. which are a FAST PATH over a truly dynamic ("any") receiver that
   should fall through to `__extern_get` on any miss, not just a
   `$Proxy`-shaped one.
2. **The has/isExtensible/`Object.keys` silent-wrong-value bug**, confirmed
   present and REACHABLE INDEPENDENTLY of #1 (their code path never goes
   through the guarded-cast throw at all — they already answer wrong on
   today's tree). Root cause not traced this session; worth its own
   diagnosis pass once #1 is understood, since it may turn out to share a
   root cause with #1 (something about `ptarget` forwarding through the
   Proxy dispatch's trap-absent arm) or be fully independent.
3. **Re-run the original 10 sample-row list** once #1 lands — not attempted
   this session, since the fix wasn't attempted.
4. **`localApply`/`reverseApply`/`localCallableKind`/`reverseCallableKind`
   terminals**: S52b's WIP, now reverted. May still be independently useful
   for #5383's callable-classification gap (S52's original diagnosis, which
   remains true for the REAL-trap case — `readViaProxy` in the original repro,
   which has an actual `get(t,k,r){...}` closure and threw "Proxy get trap is
   not callable", a message this session did NOT re-derive or re-examine).
   Re-implement from scratch if/when that specific gap is revisited; do not
   resurrect this branch's reverted commit as-is without re-verifying it
   against whatever #1's fix changes in `__typeof_function`'s arm ladder.

## Verification (this session)

Three gitignored probe files (project convention — ad-hoc repro/debug files
go in `.tmp/`, not `tests/`), preserved for the next agent at
`.tmp/s52c/probe-6637-{repro,direct,single-module}.test.ts` in this worktree
(`/home/user/js2/.claude/worktrees/agent-ad93bfa729a45909f`):

- `probe-6637-repro.test.ts` — the original S52b two-module `NS.readOverflow`
  harness, extended with empty-handler LOCAL vs CROSS variants and `in`/
  `isExtensible` controls.
- `probe-6637-direct.test.ts` — the direct-top-level-function-import
  bisection (rules out the `__apply_closure`/methodCall vec-args bridge);
  10 read/has/set/delete/isExt/keys probes, plain-object controls, and the
  `charCodeAt` message-decode diagnostic that found "Cannot access property
  on null or undefined at 2:50" and `diagNullCheck`'s `=== null` confirmation.
- `probe-6637-single-module.test.ts` — the DECISIVE single-module (no link at
  all) repro: `readViaUntypedFn` (`-1`, throws) vs `readViaKnownType` (`1`,
  correct), both reading `.overflow` off the identical `new Proxy({overflow:1},
  {})` value.

No `tests/issue-6637-*.test.ts` witness suite was written — writing a
permanent witness for a defect whose fix location is not yet chosen (see
"What's still open" #1) would need to be rewritten once the architect design
lands; the three probes above are the reproducible evidence trail instead.
Base-vs-fix comparison, the four-family battery, the must-not-move A-F
battery, byte-flip tables, and equivalence-gate numbers were **not run** —
there is no fix on this branch to compare against a base.

## Recommendation

1. **Do not dispatch another "cross-module Proxy" slice against #6637 as
   scoped.** The cross-module framing is retired by the evidence above; the
   next slice should be scoped as "standalone: dynamic property access on a
   Proxy through an untyped receiver" and should NOT require any link/
   provider/consumer harness to reproduce or verify.
2. **Route through an architect pass first** for the blast-radius question
   in "What's still open" #1 before implementation — this touches the
   general "any"-typed member-access fast path, not a Proxy-specific
   function.
3. Keep the has/isExtensible/`Object.keys` silent-wrong-value finding (#2
   above) as a candidate follow-up issue once the primary fix's shape is
   known — it may or may not share a fix.

## Implementation notes / commits (this branch)

- `git revert --no-edit HEAD` (reverts S52b's `9f7e38ac1e` WIP commit
  cleanly) — `src/codegen/standalone-link-reverse-peer.ts`,
  `src/codegen/typeof-natives-finalize.ts` restored to their pre-S52b state.
- This issue file rewritten with the corrected diagnosis (this commit).
- No `src/` changes beyond the revert.
