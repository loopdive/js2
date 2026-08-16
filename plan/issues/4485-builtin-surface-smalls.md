---
id: 4485
title: "ES5 standalone: builtin-surface smalls — Error.prototype.toString, global value props, annexB Date (getYear/setYear/toGMTString), Array surface tail (~25 rows)"
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
language_feature: builtins
goal: standalone-gap
related: [3006, 4426, 4481]
origin: "2026-08-15 ES5-standalone session — root-cause fan-out. Error (6) + built-ins/global (6) + annexB/Date (6) + Array surface tail (RangeError rows, [object Array] toString) grouped as bounded S-slices."
---

# #4485 — builtin-surface smalls

## Problem

Four bounded surface families, ~25 rows:

- **A — Error.prototype.toString (6)**: §15.11.4.4 — `"Error: msg"` /
  `"Error"` composition from `name`/`message` (own or inherited), empty-name
  edge; `err.constructor.length === 1`; `new`-ability of the Error carrier
  ("is not a constructor").
- **B — global value props (6)**: `encodeURI === null`, `Date === null` —
  reading builtin GLOBALS as VALUES answers null; TypeError rows for
  calling missing ones. Same read-as-value class as #4442 solved for
  `Function` — the carrier dispatch generalizes per-name.
- **C — annexB Date (6)**: `getYear`/`setYear`/`toGMTString` must exist as
  own properties of Date.prototype with function typeof and B.2 semantics
  (`getYear` = getFullYear−1900 incl. the −0.999999 → 0 edge).
- **D — Array surface tail**: `new Array(2^32)` → RangeError ("too large"
  rows must be a catchable RangeError instance);
  `x.toString()` → `"[object Array]"` via Object.prototype.toString.call.

## Implementation Plan

1. Re-verify live (brief: `plan/method/es5-standalone-agent-brief.md`);
   per-family lists.
2. B first — it is the #4442 pattern verbatim: per-name carrier or
   provider-linked intrinsic, decided by module-level demand
   (`function-intrinsic-carrier.ts` is the template; #3006's
   `BUILTIN_CTOR_ARITY` seeds names/arities).
3. A: the Error family already has carriers (#3006 lineage) — the
   composition body is a small reflective method (pattern:
   `string-proto-concat.ts` (#4426) for building strings native-side).
4. C: Date.prototype surface — add the three names to the existing Date
   proto dispatch with B.2 bodies; own-property assertions need them
   visible to hasOwnProperty (check how existing Date methods answer it).
5. D: RangeError instance at the `new Array(len)` length gate (#4426's
   `emitArraySetLengthValidation` is the adjacent validated path);
   `[object Array]` tag from Object.prototype.toString's class table.
6. Controls: scoped sweeps per directory; Date/Error/Array pins; zero
   regressions.

## Acceptance criteria

- ≥14 rows flip across the four families; zero regressions; residuals with
  owners.

## Recovered findings (first agent's worktree lost to session-limit kill, 2026-08-16 01:50 — reimplement from these, they were MEASURED)

Family C (annexB Date) was completed and verified at **14 → 23 pass (+9, 1
residual)** before the loss. Three distinct root causes, reported before death:

1. `setYear`/`toGMTString` were missing from the `DATE_PROTO_METHODS` CSV —
   two of the three gaps are just table entries.
2. `setYear` tested the RAW f64 argument against the 0..99 window instead of
   MakeFullYear's truncated value (§B.2.5 ToIntegerOrInfinity first).
3. `toGMTString` minted its OWN closure singleton instead of aliasing
   `toUTCString`'s — §B.2.6 requires the SAME function object; the fix used
   `ensureStandaloneNativeMethodClosure` to alias, which is the correct
   identity mechanism on any base.

Families A (Error.prototype.toString composition), B (global value props —
use the #4442 function-intrinsic-carrier template), D (Array surface tail)
were NOT started. Lead decision on base (recorded 2026-08-16): successors do
NOT rebase mid-work; base-change staleness costs more than merge-time
reconciliation.
