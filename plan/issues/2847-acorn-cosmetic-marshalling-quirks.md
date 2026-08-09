---
id: 2847
title: "compiled-acorn cosmetic marshalling quirk — spurious `sourceFile: null` on every node"
status: ready
sprint: current
priority: low
horizon: m
feasibility: medium
updated: 2026-07-23
created: 2026-06-29
task_type: bugfix
area: runtime
language_feature: host-marshalling
goal: acorn-dogfood
related: [1712, 3557]
umbrella: 1712
---

# #2847 — compiled-acorn cosmetic marshalling quirk (spurious `sourceFile`)

Surfaced by the wider acorn differential corpus
(`tests/dogfood/acorn-corpus.mjs`, #1712 umbrella).

> **SPLIT 2026-07-23 (sendev-acorn):** this issue originally lumped TWO quirks
> as "cosmetic". Quirk B (booleans marshalled as i32 0/1) is **NOT cosmetic** —
> `node.computed === false` fails, `typeof node.computed` is `"number"`, and
> JSON serialization differs; it is a systemic wrong-TYPE-crossing-the-boundary
> gap. It now lives in **#3557** (value-rep track, related #2773). This issue
> keeps only the genuinely-cosmetic Quirk A below.

## Quirk A — spurious `sourceFile` extra field

Compiled-acorn marshals a `sourceFile` field (value `null`) onto **every** node;
node-acorn (parsed with no `sourceFile` option) does not emit the field at all.

```
extra-field   $.body[*]...sourceFile   expected (absent)   actual null
```

Seen on essentially every node of every input (45–85 occurrences per corpus
file; 2298 total across the corpus, measured 2026-07-03). Fix: omit
`sourceFile` from the marshalled node when unset, matching node-acorn (it only
appears when `options.sourceFile` is set).

## Why low priority (holds for Quirk A only)

The quirk does not change the SHAPE of the tree or the identity/value of any
identifier or literal — `sourceFile: null` is ignorable by consumers. It is
tracked because it blocks a _byte-exact_ differential pass and clutters the
diff, not because it breaks parsing. (This rationale previously also claimed
"a consumer that reads `node.computed` still gets a truthy/falsy value" for
the boolean quirk — that under-sold it; see #3557 for why type-fidelity is a
real decision, not an allowance.)

## Acceptance

- `sourceFile` is absent from marshalled nodes when unset.
- `tests/dogfood/acorn-corpus.mjs` reports `quirk-sourceFile` ≈ 0 across the
  corpus.
- No test262 regression.

## Investigation (2026-07-03, dev-team-a) — root cause

Measured against `upstream/main` (e29c8c5b2) with the corpus harness
(`ACORN_CORPUS_NO_ACORN_SELF=1 npx tsx tests/dogfood/acorn-corpus.mjs --json`).

acorn's `Node` constructor assigns `sourceFile` (and `loc`, `range`) **only
conditionally** (`if (parser.options.directSourceFile) this.sourceFile = …`,
acorn.mjs Node ctor). With the option off, node-acorn never creates the
property; compiled WasmGC has a **fixed struct shape**, so the `sourceFile`
slot always exists and defaults to `null`. (`loc`/`range` are the same class
but the differ's `ignorePositions` hides them.)

At marshalling time a never-assigned ref field (`null`) is
**indistinguishable** from a legitimately assigned-`null` field
(`FunctionExpression.id = null`, `SwitchCase.test = null`) — both are `null`
struct slots, and node-acorn *keeps* the latter (verified: 0 real divergences,
so those null fields agree). So there is **no runtime signal** that lets the
generic marshaller (`_structToPlainObject` in `src/runtime.ts`) omit
`sourceFile` while keeping `id`/`test`. A correct general fix needs a
**per-instance field-presence bitmap** for conditionally-assigned fields (a
real feature, not a one-liner) — or the quirk is accepted as cosmetic per the
"why low priority" section. A field-name special-case in the generic
marshaller would regress real user programs (a legit struct field named
`sourceFile`) and violates the no-bespoke-builtins principle.

### Sizing verdict

`horizon: m` — per-instance presence tracking for conditionally-assigned
fields (arguably not worth it for a cosmetic dogfood quirk). Not a bounded,
locally-test262-validatable slice.
