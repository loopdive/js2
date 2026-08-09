---
id: 4172
title: "Standalone: make the [[Prototype]] chain LIVE for `new F()` with reassigned `F.prototype` (ES5 inherited-property family)"
status: in-progress
assignee: ttraenkler/W2-prototype-chain
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: prototype chain, constructor functions
goal: standalone-gap
related: [2660, 4008, 4055, 4160, 802]
loc-budget-allow:
  # clause-A widening belongs inside classifyUse's ladder — extracting one
  # rung would split the single classification ladder #4123 unified
  - src/codegen/fnctor-escape-gate.ts
  # G4 module-global arm is the same slot-type check as the local arm and
  # must read the ALLOCATED slot inside fnctorNewResultConsumedAsExternref
  - src/codegen/expressions/new-super.ts
  # one predicate line in moduleInitForcesExternref — the module-global twin
  # of the two index.ts dynamicProtoLiteralNodes consults (lockstep set)
  - src/codegen/declarations.ts
  # registerDescriptorHasOwn moved after __extern_has (funcIdx ordering) +
  # rationale comment; the logic lives in carrier-bag-hasown.ts (not a god-file)
  - src/codegen/object-runtime.ts
func-budget-allow:
  # one predicate line + lockstep-rationale comment; the consult must live in
  # moduleInitForcesExternref (nested closure of collectDeclarations)
  - src/codegen/declarations.ts::collectDeclarations
  # registerDescriptorHasOwn call relocation + rationale comment inside the
  # ensure flow — the funcIdx-ordering constraint pins it to this position
  - src/codegen/object-runtime.ts::ensureObjectRuntime
# (#1930/#3273 oracle ratchet) dynamic-proto.ts: ctxChecker 0 -> 1.
# NOT a hand-rolled checker query. The new proto-SOURCE detection calls the
# EXISTING `resolveFnctorSymbol` (src/codegen/fnctor-escape-gate.ts:233), whose
# signature is `(checker: ts.TypeChecker, calleeExpr)` and which is shared with
# the #2660 escape gate — so the call site cannot avoid passing `ctx.checker`
# without changing that shared helper's signature and every existing caller.
# That refactor belongs with the gate it serves, not smuggled into a
# behavioural slice; doing it here would widen this PR's blast radius across
# the one subsystem whose S2 header records a measured -40 standalone-floor
# cost for unscoped change. The gate is counting the reference, not new
# vocabulary: total raw-checker QUERIES in the tree are unchanged.
oracle-ratchet-allow:
  - src/codegen/dynamic-proto.ts
---

# Standalone: make the [[Prototype]] chain LIVE for `new F()` with reassigned `F.prototype`

## Problem

**The largest single mechanism in the ES5 standalone tail — 219 files**
(list: `.tmp/levers/W2-prototype-chain.txt`, derived from test262
`description:` frontmatter, not error-string clustering; see the #4008
pickup notes). Two shapes, one substrate gap:

1. `new F()` with a REASSIGNED `F.prototype` does not link `[[Prototype]]`:

   ```js
   var proto = { foo: 1 };
   var F = function () {};
   F.prototype = proto;
   var child = new F();
   // standalone: "foo" in child === false, Object.getPrototypeOf(child) === proto === false
   ```

2. `Object.prototype.x = …` is invisible to every instance (12 files —
   separate slice, #4160's proto-index store minus its integer-key gate).

⚠ **Identity-without-liveness trap** (#4008 notes): `Object.getPrototypeOf({})
=== Object.prototype` evaluates TRUE in standalone while the chain is dead.
Probe with `in` or a property read, never the identity.

## Root causes found (measured, 2026-08-06)

The #2660 substrate (S1 escape gate, S2 per-fnctor prototype `$Object`, S3a
`__object_create` reconstruction) already exists and the S1 gate classified the
canonical repro `reconstruct` — but THREE independent gaps kept the chain dead:

1. **S3a's G4 gate only accepted function-LOCAL externref bindings.**
   `fnctorNewResultConsumedAsExternref` (new-super.ts) returned false for a
   module-global binding — and top-level `var child = new F()` is the dominant
   test262 shape. Widened to accept a module-global whose ALLOCATED slot is
   externref.

2. **The prototype OBJECT itself compiled as a closed struct.** `var proto =
   {foo: 1}` (non-empty literal, no contextual type) takes the closed-struct
   path, so `__object_create(proto)` seeds `$proto = (proto is $Object ? proto
   : null)` → null. Fixed by marking proto-SOURCE literals (one-hop
   identifier bindings flowing into `F.prototype = X` for approved fnctors,
   `Object.create(X)`, `setPrototypeOf(_, X)`, `__proto__ = X`) into the
   existing #802 `ctx.dynamicProtoLiteralNodes` promotion (scanForDynamicProto)
   — literals.ts builds them as `$Object`, slot typing follows in lockstep.
   Also added the MISSING third slot-typing consult: declarations.ts
   `moduleInitForcesExternref` (the module-global twin of the two index.ts
   consults).

3. **Clause A missed the descriptor idiom.** `Object.defineProperty(obj, "p",
   attr)` passes `attr` to a CONCRETELY-typed lib.d.ts param, so the
   any/unknown-param dynamic-use check never fired → `keep-static` → struct
   path. Added: any argument of a builtin `Object.*`/`Reflect.*` call is a
   dynamic consumer (their standalone lowerings all consume via the externref
   `$Object` runtime). Clause B (typed own-field ⇒ keep-typed) unchanged.

Plus the **#4008 prerequisite re-land**: `__desc_has_own` widened from
HasOwnProperty to full §7.3.12 HasProperty (final arm delegates to
`__extern_has`, registered after it for funcIdx ordering). Measured +0 while
the chain was dead; load-bearing now that it is live.

## Measured (2026-08-06, CI-aligned shimmed instrument — see L2 handoff §2/§3)

| | pass on the 219-file lever list |
| --- | ---: |
| origin/main (`83e7c4db3`), base files swapped in | **0 / 219** |
| this branch | **95 / 219** |

Delta **+95**, 0 regressions on the list. Instrument responsiveness verified in
both directions (95 → 0 on revert-swap, 0 → 95 on restore). Remaining 124:
15 × override-of-inherited define semantics (§8.12.9 step-1 refinements),
14 × `accessed !== true` (accessor `this`-binding / invocation shapes),
12-file `Object.prototype.x` named-key slice (probe2 — proto-index store minus
its integer gate, follow-up), 8 × missing TypeError arms, plus a long tail of
builtin-prototype (`String.prototype` S15.5.3.1_A*, `Number.prototype`) tests
that are a DIFFERENT mechanism (builtin proto objects, not user fnctors).

## Acceptance

- The four-line repros above resolve `in`/read/gpo correctly (probes 1, 1a-1c,
  3, 3b in `.tmp/` — all verified 2026-08-06).
- Measured pass-count gain on the 219-file lever list, 0 regressions on it.
- Standalone floor / equivalence tests green (the #2660 S2 header records a
  −40 floor cost for unscoped interception — every widening here stays behind
  the S1 (A)∧(B) gate).
