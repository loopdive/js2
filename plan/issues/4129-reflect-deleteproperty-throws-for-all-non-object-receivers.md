---
id: 4129
title: "standalone: Reflect.deleteProperty throws for EVERY non-$Object receiver — including plain success cases; the `delete` operator is fine, only the Reflect spelling"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: reflect
goal: standalone-mode
related: [4010, 1781]
---

# Reflect.deleteProperty is broken where `delete` now works

Found by the #4010 S2 owner while measuring tombstones (2026-08-03), deliberately
not folded into that slice. **Verified identical on the S2 base commit and after
S2 landed** — pre-existing, independent of the store work.

## Behaviour

```js
var arr = [1, 2, 3];
arr.q = 12;
Reflect.deleteProperty(arr, "q");   // standalone: THROWS
delete arr.q;                        // standalone: works (post-S2/PR #4063)
```

`Reflect.deleteProperty` throws for **every non-`$Object` receiver**, including
plain success cases on ordinary expandos. Only the `Reflect` spelling is
affected; the `delete` operator's lowering is separate and correct as of S2.

## Likely shape (verify, don't inherit)

The `delete` operator's non-`$Object` arm was just rewired to the carrier-bag
delete (`src/codegen/carrier-bag-delete.ts`, PR #4063) with a tri-state result.
`Reflect.deleteProperty` presumably routes through an older/different path that
never learned about non-`$Object` receivers — the #4080 family shape (a correct
treatment exists; one consumer never wired to it). The fix is most likely
routing the Reflect spelling through the same delete native the operator now
uses — at the Reflect dispatch site, not by widening anything general.

## Acceptance

- [ ] `Reflect.deleteProperty(arr, "q")` on an expando returns `true` and the
      property is genuinely gone (value read AND store record — two
      derivations, per the S2 standard; the S2 evidence table shows why one
      derivation lies).
- [ ] Returns `false` (not throw) where OrdinaryDelete would refuse.
- [ ] `delete` operator behaviour byte-identical before/after (it is correct;
      this fix must not touch its path).
- [ ] Population sized from the fresh baseline before any flip claims.
