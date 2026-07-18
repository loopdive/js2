---
id: 2733
title: "Standalone JSON.parse booleans/null have wrong typeof (boxed as number struct) — value-rep substrate"
status: ready
created: 2026-06-26
updated: 2026-06-26
priority: low
feasibility: hard
model: fable
task_type: bug
area: codegen/runtime
language_feature: standalone
goal: standalone-everything
depends_on: []
related: [2721, 1917, 2580]
sprint: Backlog
---
# #2733 — Standalone JSON.parse boolean/null `typeof` (value-rep substrate)

Split out of **#2721** (which delivered the number/`\uXXXX` grammar tightening).
This is the boolean/null half — substrate-blocked, parked under the #1917 /
#2580 value-representation umbrella.

## Problem

In `--target standalone`, `JSON.parse("true")` / `"false"` / `"null"` produce
the correct *value* (equality works: `JSON.parse("true") === true`,
`JSON.parse("null") === null`, `false` is falsy), but their **`typeof` is
wrong**. Verified on current main:

```ts
typeof JSON.parse("true")   // matches NONE of boolean/number/object/undefined/string
typeof JSON.parse("null")   // not "object"
```

## Root cause — substrate, not the codec

The native codec (`src/codegen/json-codec-native.ts`, `boxBoolAny`) deliberately
boxes a JSON boolean as a `$__box_number_struct` (1.0/0.0), with an in-line note:

> JSON booleans box as a `$__box_number_struct` … a distinct boolean identity
> (`o.t === true`) is the broader standalone boolean-boxing gap (overlaps
> #1917), out of PR-C scope.

So two substrate gaps compound:
1. **Boolean boxing**: the standalone `i32 → externref` store path boxes a
   boolean as a NUMBER (the broad #1917 boolean-boxing gap). The codec matches
   that representation so object member reads round-trip consistently.
2. **`typeof` of a boxed struct in standalone**: even given the boxed value,
   `typeof` does not return a recognized type string (all of
   boolean/number/object/undefined/string compare false) — a standalone
   typeof-of-boxed-value gap.

Fixing JSON.parse's boolean/null `typeof` in isolation (e.g. a dedicated
`$__box_bool` struct just for the codec) would desync it from the
representation every other standalone boolean uses, breaking member-read /
round-trip consistency. The correct fix is the shared value-rep substrate
(#1917 boolean boxing + standalone typeof), coordinated with #2580.

## Acceptance criteria

- [ ] In standalone, `typeof JSON.parse("true")` / `"false"` is `"boolean"` and
      `typeof JSON.parse("null")` is `"object"`, consistent with the broader
      standalone boolean/null representation (not a codec-local hack).

## Notes — feasibility: hard

Blocked on the #1917 / #2580 value-representation substrate. Do NOT attempt as a
codec-local patch. Low movement (standalone-only parity; zero test262 — test262
JSON runs host mode).
