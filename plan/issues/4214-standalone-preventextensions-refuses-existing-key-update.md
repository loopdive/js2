---
id: 4214
title: "standalone: preventExtensions refuses an UPDATE of an existing writable own property — every receiver kind, §10.1.9 violation"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, standalone
language_feature: objects, property-descriptors, object-integrity
goal: standalone-gap
umbrella: 3977
related: [4210, 4032, 3537, 3468, 1074]
created: 2026-08-07
found-by: ttraenkler/W31
origin: "2026-08-07, fell out of #4210's parity oracle. Not caused by #4210 — it reproduces identically on origin/main@8f119536ae for a plain object."
id-provenance: "Reserved by the tech lead on the upstream issue-assignments ledger. The open-PR scan the tool cannot do was run by hand at reservation time: ZERO open PRs on loopdive/js2, so this id is VERIFIED CLEAN, not merely unscanned."
---

# #4214 — `preventExtensions` refuses an update of an existing writable own property

## The claim

Per **§10.1.9 OrdinarySetWithOwnDescriptor**, `[[Extensible]] = false` blocks
only the **creation** of a *new* own property (§10.1.6.3
ValidateAndApplyPropertyDescriptor step 2, via §10.1.12 CreateDataProperty).
An **existing writable own data property stays writable**:

```js
var o = {};
o.k = 1;
Object.preventExtensions(o);
o.k = 2;          // MUST succeed — `k` already exists and is writable
o.k;              // want 2
```

In `--target standalone` this write is **refused** — silently in sloppy mode,
with a `TypeError` in strict mode. That is a spec violation.

## Measured (2026-08-07, `origin/main@8f119536ae`)

Strict mode (a `compile()` source carrying an `export` is a MODULE, so every
assignment in it is strict), classifying the thrown value inside the module:

| receiver | ADD a new key after `preventExtensions` | UPDATE an existing writable key |
| --- | --- | --- |
| `{}` | `TypeError` — **correct** | `TypeError` — **WRONG** |
| `function f(){}` | `TypeError` — correct | (not separately measured) |
| `new Error("y")` | `TypeError` — correct | `TypeError` — **WRONG** |

Sloppy mode (a test262-shaped script through the real standalone lane), same
three receivers, printing whether the value changed:

```
add=refused  update=REFUSED  plainUpdate=REFUSED
```

**The uniformity is the evidence.** The wrong answer does not depend on which
carrier the receiver uses — plain `$Object`, closure bag and (post-#4210)
`$Error_struct.$props` all give it — so this is not a carrier-arm bug and in
particular **is not #4210's**. #4210 only made Error *reach* the same code path
the others were already on.

## Pre-existing, and how that is known

It reproduces identically on `origin/main@8f119536ae` for a plain object, with
no Error in the picture. Error entered only because #4210's fixture asserts
**parity with a plain-object oracle**, which put the two answers side by side.

## How it was found — the method generalises

A #4210 fixture failed on the head arm. The reflex is to adjust the assertion;
chasing it instead showed the **test** was wrong, for a reason worth knowing:
a `compile()` source with an `export` is a **module**, so every assignment in
it is strict-mode, and a strict write to a non-extensible object **throws**
rather than no-opping. The repair was to stop asserting an absolute and assert
**parity with a plain-object oracle** — and that rewrite is what made this
defect visible at all, because it forced the plain-object answer to be computed
and compared instead of assumed.

## Scope note

`built-ins/Object/preventExtensions/15.2.3.10-3-20.js` (and `-3-10.js`) are
**scripts, not modules**, so their assignments are sloppy and they are
unaffected by the strict-mode half of this. They exercise only the ADD case,
which is already correct. Do not assume the two cases are the same.

## Where to look

The refusal is in the `$Object` store path, not in any carrier arm — which is
why every receiver inherits it:

- `src/codegen/object-runtime.ts` — `__extern_set`'s FROZEN gate reads
  `$Object.flags` field 4 and returns on `OBJ_FLAG_FROZEN`. Its own comment
  says the NON_EXTENSIBLE new-key refusal "lives in `__obj_insert`'s empty-slot
  branch … so it is NOT gated here", which is the correct design.
- `__obj_insert`'s empty-slot branch — the NON_EXTENSIBLE check. If the
  refusal is firing for a key that already has a live (non-tombstoned) entry,
  the slot search is reaching the empty-slot branch for an existing key, or the
  flag is being consulted before the found-entry branch.
- `__reflect_set` / `__extern_set_strict` (#3983) — the strict path converts a
  `false` result into the `TypeError`, so it will faithfully report whatever
  the data path decides. Check the data path first.

Start by distinguishing the two failure modes: does `__obj_find` locate the
existing entry at all after `preventExtensions`, or does it locate it and the
insert refuse anyway?

## Acceptance

- `var o = {}; o.k = 1; Object.preventExtensions(o); o.k = 2; o.k === 2` —
  sloppy AND strict (strict must not throw).
- Adding a NEW key after `preventExtensions` still fails: sloppy no-op, strict
  `TypeError`. That half is correct today and must not regress.
- Same for a function receiver and an Error receiver — asserted as parity with
  the plain-object oracle, not as three absolutes.
- `Object.seal(o); o.k = 2` also succeeds (seal = preventExtensions +
  non-configurable, and does **not** clear `[[Writable]]`), while
  `Object.freeze(o); o.k = 2` still refuses.
- A PRECONDITION case green on both arms so the fixture is not vacuous.
