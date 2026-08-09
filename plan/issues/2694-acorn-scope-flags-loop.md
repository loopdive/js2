---
id: 2694
title: "acorn parse() 11th wall — Scope.flags read loop (local-receiver slot/sidecar asymmetry, needs #2660)"
status: blocked
assignee: ttraenkler/unassigned
sprint: Backlog
created: 2026-06-26
updated: 2026-07-23
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2681, 2687, 2686, 2660, 2664, 2659]
depends_on: [2660]
origin: "Surfaced by sd-2674c's validated #2681 this-read-dispatch: with the parseExprAtom switch now matching (the #2681 unexpected() throw resolved), parse(\"x\") advances PAST the identifier path and hits a tight loop reading Scope.flags ~800k×/cap. Same any-typed-local-receiver slot/sidecar family as #2681/#2687; the receiver is a method-call return the checker types `any`, so resolving it needs the #2660 inter-procedural flow keystone."
---

# #2694 — acorn `parse()` 11th wall: `Scope.flags` read loop

## Context

After sd-2674c's #2681 `this`-receiver read-dispatch fix (validated: compiled-acorn
`parse("x")` `__host_eq` 30k→163, the parseExprAtom `switch(this.type)` matches and
the #2681 `unexpected()` throw is gone), `parse("x")` STILL hangs — now at a
DEEPER wall reached only because #2681 peeled past the throw.

## Localized (key histogram, sd-2674c)

`.tmp/keyhist2.mjs` (`__extern_get` key histogram, cap-throw, on the #2681-fixed
base) names the hot field:

```
__extern_get top keys (parse "x"):
  flags: 799238      ← the loop
  keyword/beforeExpr/startsExpr/isLoop/isAssign/postfix/binop: ~77-80  (TokenType)
  ...
```

`.flags` = **`Scope.flags`** (`var Scope = function Scope(flags){ this.flags =
flags; ... }`, a function-constructor like Parser; 16 `scope.flags & SCOPE_*`
bitops). The loop reads `Scope.flags` ~800k× with `__box_number`/`__unbox_number`
in lockstep (numeric bitmask).

## Root (same family as #2681/#2687 — needs #2660)

The receiver is `this.currentVarScope()` / `this.scopeStack[i]` — a LOCAL bound
from a method-call return that the compiler's checker types **`any`** (verified by
`.tmp/checker-probe.mjs`: `currentVarScope()` return type = `any`). So
`scope.flags` reads route through the dynamic `__extern_get` (host proxy/sidecar)
path, which diverges from the struct-slot write → a non-advancing loop.

Unlike #2681's `this` receiver (recoverable SYNTACTICALLY from the prototype-alias
assignment), resolving `scope`'s `Scope` struct type requires inter-procedural
return-type flow (follow `currentVarScope` → `scopeStack[last]` → the field's
element type). That is the **#2660** whole-program escape/flow keystone — hence
`depends_on: [2660]`, `status: blocked`.

## Fix (via #2660)

Once #2660 resolves local-receiver struct types, route `scope.<field>` (and the
general `recv.<field>`) reads/writes/compound through the SAME symmetric dispatch
as #2681's READ half (`tryEmitThisStructMemberRead` → generalized
`emitExternrefToStructGet`) + #2664's WRITE half. Must cover read + write +
**compound** (`scope.flags & X`, `scope.flags |= X`) consistently — a read-only
slot fix without the write/compound match caused a 35.9M-iter loop in the #2681
investigation.

## Acceptance
- `parse("x")` / `parse("var x = 1;")` advance past the Scope.flags loop (return
  or hit the next wall, not spin).
- Full merge_group / test262 floor (broad value-rep change via #2660).

## Correctness datapoint (2026-07-23, sendev-acorn — from the #1712 regression bisect)

This issue frames the Scope.flags surface as a PERF loop (read-count ~800k×).
The 2026-07-23 acorn parse regression (bisected to PR #3267 commit
`479f747c4292ff`, fixed under #1712) adds a **correctness** datapoint on the
same read/write-lane-asymmetry family — and empirically validates this issue's
own warning ("a read-only slot fix without the write/compound match caused a
35.9M-iter loop"):

- The regression was EXACTLY a read-only struct-slot shortcut: an
  exact-struct-field `struct.get` lane added for reads whose `typeName` is
  unrecoverable, while the receiver's writes/runtime representation stayed on
  the dynamic host-`$Object` lane. Result was not a loop but a WRONG VALUE
  (ref.null substituted by the `__extern_get` fallback's default arm for
  ref_null-typed fields) → acorn's scope-accessor table
  (`prototypeAccessors.inFunction.get = fn`) lost its getters → `inFunction`
  / `inGenerator` / `allowNewDotTarget` answered undefined→false → genuine
  SyntaxErrors ("'return' outside of function", new.target, yield).
- NOTE the mechanism was NOT a `Scope.flags` read (instrumented: the hijacked
  reads were `types$1.<token>` and `prototypeAccessors.<accessor>`); the
  scope-state symptom arose one level up, via the accessor-install path. The
  `Scope.flags` __extern_get loop this issue tracks is still the separate,
  #2660-blocked receiver-typing gap.
- Design constraint reaffirmed for the eventual #2660 fix: any struct-slot
  routing for these receivers must cover read + write + compound TOGETHER, and
  must be gated on the receiver's RUNTIME representation actually being the
  struct (see the #1712 fix's `widenedVarStructMap`/`widenedDefinePropertyKeys`
  gate for the pattern) — a statically-resolvable struct typeIdx alone is NOT
  evidence the runtime value is that struct (growable/`$Object`-poisoned vars
  resolve statically but hold host objects).
