---
id: 4484
title: "ES5 standalone: operator/coercion smalls — instanceof [[HasInstance]], null/undefined member ToObject throws, strict-assignment throws, `in` on plain maps (~30 rows)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: operators
goal: standalone-gap
related: [4426, 4434, 4464]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. instanceof (7) + property-accessors (6) + assignment strict-throws (4-10) + types/object (12) share operator-level root causes."
---

# #4484 — ES5 operator/coercion smalls

## Problem

Four small operator-level families, ~30 rows total:

- **A — instanceof (7)**: `({}) instanceof Object` false or throwing;
  non-callable RHS must throw TypeError ("Right-hand side ... is not an
  object" leaks host error text); `[[HasInstance]]` for builtin
  constructors.
- **B — member access on null/undefined (6)**: `undefined.toString()` /
  `null.toString()` must throw TypeError (§9.10 CheckObjectCoercible);
  today: wrong class or no throw. Two `Builtin.constructor` codegen-error
  rows (`Object.constructor`, `Boolean.constructor` static-prop CE) ride
  along — decline to the #3006 carrier read instead of CE.
- **C — strict assignment throws (4)**: assignment to non-writable /
  undeclared in strict code must throw TypeError/ReferenceError.
- **D — types/object misc (12)**: `"foo" in map` on object literals,
  prototype-of-non-extensible mutation, this-binding rows. Triage first;
  fix what is bounded, hand descriptor-dependent rows to #4479.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   per-family file lists first.
2. A: find the instanceof lowering (grep `instanceof` in
   `src/codegen/expressions/`); `({}) instanceof Object` needs the builtin
   constructors' [[HasInstance]] against the #3006/#4442 carriers; real
   TypeError instances via `buildThrowJsErrorInstrs`. #2916's
   `native-dynamic-instanceof.ts` is the existing dynamic arm — extend it,
   don't fork it.
3. B: the CheckObjectCoercible throw belongs at member-access lowering on a
   statically-null/undefined or runtime-nullish receiver — the
   `finalizeStructAndDynamicMemberGet` null path is the hook; the CE rows
   are a decline-not-error fix at the static-receiver band (#4460's new
   band is adjacent — read it first).
4. C: strict-mode write sites — find where assignments to consts/globals
   lower; scope to the 4 measured rows, don't build a general strict-mode
   engine here.
5. D: triage, fix bounded rows (`in` operator on literal-backed $Objects
   likely shares the #4062 named-key presence work — read
   `vec-named-key-presence.ts`).
6. Controls: scoped sweeps per directory; operator equivalence per-file
   subset; fn-family pins untouched.

## Acceptance criteria

- ≥15 rows flip across the four families; zero regressions; residuals
  routed (#4479 for descriptor-dependent, #4480 for prototype-dependent).
