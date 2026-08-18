---
id: 3992
title: "Transferred native-proto methods lost their receiver slot — one shape rule was being cloned per member"
status: done
sprint: 78
created: 2026-08-01
completed: 2026-08-01
updated: 2026-08-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: fix
area: codegen, conformance
language_feature: String.prototype, native prototypes
goal: es5
related: [3977, 2742, 2875, 3217, 3254, 2193, 1470]
origin: "2026-08-01, lever-2 (built-ins/String/prototype) root-cause analysis against the standalone baseline of the same day (rows 19:01–19:07)."
---

# #3992 — the transferred native-proto receiver slot

## Symptom

The test262 idiom for a generic receiver is a **transfer**, not `.call`:

```js
var __instance = new Object(true);
__instance.toLowerCase = String.prototype.toLowerCase;
__instance.toLowerCase();          // spec: "true"  ·  standalone: null
```

`String.prototype.<m>.call(recv)` already worked (#3254 covers the syntactic
`.call` form). The transferred form answered a **silently wrong `null`** for
every member except `charAt` and `substring`.

## Root cause

Native-proto **method** closures carry an internal receiver ahead of their user
arguments — the lifted signature is `(self, thisValue, arg0 … arg{n-1})`.
`__call_fn_method_N`'s generic dispatch (`closure-exports.ts`) does the
opposite: it fills **every** closure param from the argument vector and
publishes the receiver only through the `__current_this` global. So the
arguments were shifted one slot left, `thisValue` received `arg0`, and the body
read garbage.

The codebase already knew this. It had **two** corrections for it, each pinned
to one member name:

| correction | member | where |
| --- | --- | --- |
| `buildTransferredCharAtApplyArm` | `charAt` only (`key.endsWith(":method:charAt")`) | `char-at-transfer.ts`, spliced into `__apply_closure` |
| `collectTransferredSubstringReceivers` | `substring` only (`arity === 2 && name === "substring"`) | `closures/transferred-native-proto.ts` |

Those are exactly the two members that worked. Every other member had no clone,
so it stayed silently wrong — and the fix-shape for the next member was "write a
third clone".

There was a **second**, independent per-member divergence stacked on the first.
§22.1.3 specifies `S = ? ToString(this)`, and `ToString` of an **object** is
`ToPrimitive(input, string)` first (§7.1.1 OrdinaryToPrimitive) — that is what
consults `toString`/`valueOf`. The four generic reflective bodies went straight
to `$__any_to_string`, which stringifies an object receiver structurally:
`new Object(true)` came out `"[object Object]"`, and a user `toString` was never
called. `charAt` (`runtimeToPrimitiveInstrs`) and `substring`
(`getToPrimitiveProvider`) each had their own correct-but-separate version — a
third and fourth spelling of one rule.

This second defect was **invisible** before this fix, because every affected
call returned `null` before reaching a body. Fixing only the dispatch converts
`null` into a *silently wrong number*: measured, transferred
`charCodeAt(0)` on `new Object(true)` returned **91** (`"["` — the first
character of `"[object Object]"`) instead of **116** (`"t"`). Both halves are
required; shipping the dispatch alone would have been a downgrade.

## Fix

1. **`collectTransferredNativeProtoReceivers`** replaces the substring-pinned
   collector. It keys on `ctx.nativeProtoReceiverClosureStructTypes` — the set
   the closure factory already populates for *every* `kind === "method"` proto
   closure (`native-proto.ts`) — so the receiver-slot correction is a property
   of the closure **shape**, not of a member name. The exact-identity field-3
   `bfnid` re-check after the structural `ref.test` is retained unchanged
   (WasmGC canonicalizes structurally equal metadata structs, so `ref.test`
   alone is only a family guard).
2. **`buildTransferredNativeProtoCallInstrs`** generalizes the arity-2 call arm
   to any arity, and pads **under-applied** calls with the reflective ABI's
   omitted-arg `ref.null.extern`. Under-application is the norm, not the
   exception: `indexOf`/`lastIndexOf`/`includes`/`startsWith`/`endsWith` get 2
   param slots from `STRING_PROTO_METHOD_PARAM_SLOTS` while their spec `length`
   is 1, so the ordinary one-argument call site supplies one fewer argument than
   the closure declares. Over-application is deliberately left with the generic
   dispatch — out of scope for a receiver-slot fix.
3. **`stringProtoToStringInstrs`** centralizes `? ToString(x)` (ToPrimitive-first)
   for the reflective String bodies, applied to the receiver *and* to the search
   argument (§22.1.3.{6,7,8,9,23} apply `ToString` to both). It returns `null`
   when `__to_primitive` is unavailable (host/gc lowering) and each caller then
   keeps its previous byte-identical sequence, so non-standalone output is
   unchanged.
4. **`NO_ARG_STRING_MEMBER_HELPER`** extends the existing no-arg
   string-returning body (`trim`/`trimStart`/`trimEnd`, #3217) to the
   case-conversion family. Those members reached a body for the first time once
   (1) landed, and refused; wiring them is what converts the new dispatch into
   passes. `toLocale{Lower,Upper}Case` fold onto the non-locale helpers exactly
   as the direct path in `string-ops.ts` already does (#1470) — so the two paths
   agree rather than inventing a second answer.

The shared `ToString` lowering and the no-arg member table live in a new
`src/codegen/string-proto-tostring.ts`, not in the `array-object-proto`
dispatcher — same rationale as `char-at-transfer.ts` and
`string-proto-substring.ts`: the dispatcher stays a dispatcher. This was
prompted by the LOC-regrowth ratchet (#3102) flagging +99 lines on that
god-file; the response was to extract rather than to grant a
`loc-budget-allow:`, and both touched god-files now sit **below** their
budgets (`array-object-proto` 2620 → 2519 / 2521; `closure-exports` 1678 →
1669 / 1675).

## Measurement

Instrument validated first: the standalone baseline reproduces **43,106 official
rows / 25,755 pass / 59.7 %** with **0 corpus files unreadable** (a floored miss
counter, not an assumed-complete scan).

Probe: 13 `String.prototype` members, each transferred onto an object receiver
under the exact test262 shape, every expectation **validated against Node
first** and **no `as any` casts** (test262 has none).

| | members correct |
| --- | --- |
| `upstream/main` | **2 / 13** (`charAt`, `substring` — the two with hand-written clones) |
| + dispatch fix only | 4 / 13, and `charCodeAt` becomes a *wrong number* |
| + ToString fix | 8 / 13 |
| + case family wired | **9 / 13** |

Removal control: the 2/13 baseline was measured on the same probe on
`upstream/main` before any edit, so the movement is attributable to this change
rather than to the probe.

Still failing (4): `slice`, `concat`, `localeCompare` — bodies genuinely
unwired, they now **refuse loudly** instead of answering `null`; and `trim`,
held by the `SUPERSEDED_BY_BORROWED_PATH` carve-out (below).

## Population (post-arbitration, fresh baseline)

`built-ins/String/prototype`, goal scope (ES5 + untagged-legacy editions), rows
timestamped 2026-08-01 19:01–19:07:

- **203** non-pass in the area (the 218 in the original dispatch came from a
  16-hour-stale cache).
- minus **15** `wasm_compile` / `__module_init` files — a different mechanism,
  owned by another lane; they die at Wasm validation before any String
  semantics run.
- **188** is this lever's population.

Decomposed by **mechanism**, not by error signature (a shared error string is a
signature, not a mechanism — the top normalized signature here covers only 22 of
203, and the area has 113 distinct signatures):

| mechanism | files |
| --- | --- |
| M1 RegExp / symbol-protocol search value refusal (`split`/`replace`/`search`/`match`) | 51 |
| M2 generic receiver / `ToString(this)` — **this issue** | 69 |
| M7 `new <builtin method>` must throw (not-a-constructor) | 10 |
| M4 explicit not-implemented | 4 |
| M5 host-import leak (#2961) | 2 |
| M9 long tail | 52 |

**File count is not a flip ceiling** and this issue does not claim one. M2 is
this lever's *reachable* population; the probe measures 9/13 members repaired,
and the per-file conversion is whatever CI reports. Several M2 files assert
additional behaviour beyond the transfer (e.g. `A7` constructor semantics, `T3`
`eval`-dependence) that this change does not address.

## Follow-ups (deliberately NOT in this PR)

- **Re-measure the `SUPERSEDED_BY_BORROWED_PATH` carve-out** (`trim`,
  `codePointAt`, `includes`, `startsWith`, `endsWith`). Its premise — "the
  #2875 reflective body is strictly worse than the legacy borrowed path it
  intercepts" — was established (#2742, +18 files) when the reflective body was
  **unreachable** for transferred receivers. That premise has now changed, so
  the set may be inverted; but it was landed on a measured A/B and must be
  retired on one too, not on inference.
- `slice` / `concat` / `localeCompare` reflective bodies (they refuse loudly
  today, so the failure is honest).
- `buildTransferredCharAtApplyArm` is now plausibly redundant with the generic
  arm. Leaving it costs a few bytes and zero correctness; removing it needs its
  own measurement.
