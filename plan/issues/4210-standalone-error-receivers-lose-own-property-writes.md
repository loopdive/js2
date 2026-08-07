---
id: 4210
title: "standalone: Error receivers lose ALL own-property writes — the last receiver kind with no carrier bag"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, standalone
language_feature: objects, property-descriptors, errors
goal: standalone-gap
umbrella: 3977
related: [4165, 3468, 3537, 4010, 4161, 4055, 2992]
created: 2026-08-07
found-by: ttraenkler/W29
origin: "2026-08-07 re-derivation of #4165 on current main — the only surviving receiver kind of #4165's 'state 3'."
---

# #4210 — Error receivers lose all own-property writes (standalone)

## The defect

In `--target standalone`, an own-property write to an **Error instance** is
**silently discarded**. Both spellings:

```js
err.x = 7;                                              // lost
Object.defineProperty(err, "y", { value: 9, … });       // lost
```

There is **no throw, no refusal, and no diagnostic**. The value simply does not
read back, and `hasOwnProperty` answers `false`. A silent wrong answer is worth
its own issue independent of the file count — every other receiver kind either
works or fails loudly.

## Measured (2026-08-07, `origin/main@78683628d2`)

Real standalone lane — `runTest262File(…, target: "standalone")`, provider at the
**INTERPRETER** tier (`TEST262_FULL_RUNTIME_EVAL=1`, key `854c120ce015d507`), so
the results are CI-comparable and not the refusal/link-error substitute.

Write an expando, then read it back; uppercase = correct
(`R`ead · `H`asOwnProperty · gOP`D` · for-in `E` · `I`n · `K`eys · deleted-then-absent `X`):

```
plainObj=RHDEIKX  fnObj=RHDEIKX   arrObj=RHDEIKX  dateObj=RHDEIKX
regexpObj=RHDEIKX boolObj=RHDEIKX strObj=RHDEIKX  numObj=RHDEIKX  objObj=RHDEIKX
errObj=rhdeik  ← every read channel wrong
```

Second probe, separating plain assignment from `defineProperty`
(`R`/`H`/`D` as above, then `V` = defineProperty value reads back, `H` = it is own):

| receiver | result |
| --- | --- |
| `new Error("e")` | `rhd\|vh` |
| `new TypeError("e")` | `rhd\|vh` |
| `new Error()` (no message) | `rhd\|vh` |
| `Error("e")` (called, not constructed) | `rhd\|vh` |
| `{}` (control) | `RHD\|VH` |

All four Error spellings behave identically, so this is the Error **carrier**,
not a message/subclass/construct-vs-call artifact.

### This is the last survivor of #4165's "state 3"

#4165 (2026-08-01) recorded Date, Error and RegExp as losing writes outright,
and functions/arrays as storing-but-invisible-to-reflection. Re-measured today:
functions, arrays, **Date and RegExp are all fully correct** — closed by #4010
S2/S3, #4017, #4055 and #4161. Error is the only one left.

## Root cause

`__carrier_bag_of` (`src/codegen/carrier-bag-visibility.ts`, ~L314) is built from
exactly **two** arms:

```
closureArm = arm(IS_CLOSURE_PROP_CARRIER, CLOSURE_BAG_LOOKUP)   // #3468
vecArm     = arm(IS_VEC_PROP_CARRIER,     VEC_BAG_LOOKUP)       // #3537
… then ref.null.extern
```

An Error instance is neither a closure carrier nor a vec carrier, so
`__carrier_bag_of` answers null and every consumer
(`__carrier_bag_has` / `__carrier_bag_gopd` / `__carrier_bag_delete` /
`__carrier_bag_push_keys`) reports "absent". Unlike the function/array case,
the write side has nowhere to land either — hence loss rather than invisibility.

## Sizing (measured, and what it does NOT claim)

AST reachability scan over the **whole corpus** — 53,575 files, each file's body
plus its `includes:` harness files — for the trigger shape *an identifier bound
to a freshly-constructed Error that later receives an own property* (member
assignment or `Object.defineProperty`/`defineProperties` with that identifier as
`O`):

**58 files.** Distribution:

| directory | files |
| --- | ---: |
| `staging/sm/Math` | 15 |
| `built-ins/Object/defineProperties` | 9 |
| `built-ins/Object/create` | 8 |
| `built-ins/Object/defineProperty` | 7 |
| `built-ins/Error/prototype/toString` | 4 |
| 14 other directories | 1 each |

Scan script: `.tmp/probe/scan-err.mts` in the #4187 worktree (reproducible).

**What this number is:** an upper bound on the files this mechanism can reach
directly. **What it is NOT:** a predicted fix yield. It is not filtered by
current pass/fail status, and some of those files fail for unrelated reasons
upstream of the Error write. Do not quote 58 as "+58".

**Explicitly unmeasured:** the indirect population — an Error used as the
*descriptor* argument (`Object.defineProperty(o, k, errObj)`, where
ToPropertyDescriptor probes fields the carrier cannot see) is only partially
captured by the scan above, and #4165's 2026-08-01 census put "Error" at 20 in
its 270-file exotic-descriptor family. Those two counts overlap by an unknown
amount. Re-derive before sizing a fix.

**Do NOT reuse #4165's 857.** That figure is from the 2026-08-01 census and is
comprehensively stale: the mechanism it described no longer reproduces for any
receiver kind except this one.

## Fix direction

Add a **third carrier arm** for Error instances, mirroring the shape #3537
established for `$Vec` — an identity-keyed side-table plus an
`IS_ERROR_PROP_CARRIER` predicate and an `ERROR_BAG_LOOKUP`, registered into
`__carrier_bag_of` so all four reflective consumers inherit it for free. That is
the composition boundary both #3468 and #3537 used and the reason Date/RegExp
came along cheaply.

Two things to check before assuming symmetry:

- **Find out how Date and RegExp were fixed first.** They were in the same
  "state 3" bucket as Error in #4165 and are now correct, but they do **not**
  appear as arms in `__carrier_bag_of`. Whatever path closed them may close
  Error more cheaply than a third bag — and if so, the asymmetry is itself the
  question to answer.
- The **write** side is the part that is actually missing (functions/arrays
  stored the value and only reflection was blind). A read-side-only carrier arm
  would not fix this.

## Acceptance

- `err.x = 7` then `err.x` reads `7`; `err.hasOwnProperty("x")` is `true`;
  gOPD reports the property; for-in and `Object.keys` include it; `delete`
  removes it — i.e. the RHDE probe reports `errObj=RHDEIKX`.
- `Object.defineProperty(err, k, {value})` likewise.
- All four Error spellings above (`new Error`, `new TypeError`, `new Error()`,
  `Error()`) behave identically.
- No regression on the other nine receiver kinds, byte-hashed.
