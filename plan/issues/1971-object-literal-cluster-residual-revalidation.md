---
id: 1971
title: "re-validate object-literal/property cluster: 6 reproducible-on-main behaviors whose covering issues are marked done (#140/#1239/#492/#1112/#1837/#1136)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: investigation
area: codegen
language_feature: object-literals
goal: property-model
related: [140, 1239, 492, 1112, 1837, 1136, 1821]
origin: "2026-06-10 deep-audit sweep (objects + eval-order agents): verified on main; flagged as residuals/regressions of done issues rather than unknown bugs"
---

# #1971 — done-status issues whose behaviors still reproduce

## Problem

The 2026-06-10 audit verified the following on current main. Each falls inside
the scope of an issue marked `done`, so they are residuals or regressions —
this issue is the triage container to re-validate, then either reopen-as-new
(per renumbering policy) or split into scoped bugfix issues:

1. **Dynamic computed keys silently dropped** (incl. losing the key
   expression's side effects) — scope of #140/#1837.
2. **Spread of accessor-bearing object literals drops the property** (getter
   never fires, value NaN) — scope of #492/#1112.
3. **Object-literal setters not invoked on assignment**; object-literal
   accessors on module-level consts trap (`o.x += 3` → null deref) — scope of
   #1239.
4. **Duplicate keys: first-wins instead of last-wins** — basic object-literal
   semantics.
5. **`delete o.a` leaves `"a" in o === true`** with literal objects;
   dynamic-key delete is a silent no-op — #1821 fixed only the literal-key
   sidecar.
6. **JS-host enumeration order ignores the integer-keys-ascending rule**.

Compile-error cluster verified alongside (second-tier, loud):
`arr.flat()/flatMap()` on `number[][]` → "No default value" (regression vs
#1136-done); `reduceRight` on string arrays → "Illegal argument";
`Object.entries(o)[0]` element access → "No default value";
`Map.forEach((v,k)=>...)` → invalid module (struct vs externref arg mismatch).

Also from the eval-order audit: **non-optional method call on null class
receiver is an uncatchable wasm trap** instead of catchable TypeError —
residual of #785 (done).

## Acceptance criteria

- Each of the 6+5 behaviors re-verified with a minimal probe
- For each: either a scoped new issue (with `renumbered_from`-style provenance
  note pointing at the original) or a documented wont-fix rationale
- The done-status originals annotated with the residual finding

## Why one issue

These need per-item git-archaeology (did the fix regress, or never cover this
shape?) before they're dev-dispatchable; that triage is one sitting of work.

## Dupe check

Each item grepped during the audit; all covering issues are `done`, none have
open follow-ups.
