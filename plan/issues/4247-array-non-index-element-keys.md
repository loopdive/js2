---
id: 4247
title: "Standalone array exotics: a non-array-index element key (`a[4294967295]`, `a[-1]`, `a[1.1]`, `a[true]`) traps or is silently dropped instead of naming a property"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: array-index, property-model, element-access, to-property-key
goal: es5
related: [4222, 3537, 4159, 3251, 4010]
# The classification + emit live in ONE new module, `array-nonindex-key.ts`.
# What grows in place is the single `if` arm at each of the two element sites
# (write / read) that consults it, and `compileElementAssignment` is already
# over budget, so its arm needs the grant below.
func-budget-allow:
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/property-access.ts::compileElementAccessBody
# loc-budget: the 372-line classification+emit subsystem is the NEW module, not
# these two. What lands in each god-file is one guarded `if` arm plus the
# comment that says why the arm is there and why it must fire in both lanes —
# the §10.4.2.2 decision has to be taken at the element sites themselves,
# because that is where the i32 key hint and the vec-grow sequence live.
# assignment.ts is net +9 (the arm, minus the 14-line helper this change
# relocated out of it into the new module).
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
# coercion-sites: BOTH entries are COMMENT-ONLY. This change emits no coercion
# whatsoever — it emits a `call` to an existing named-store helper with a string
# constant key. The gate counts coercion VOCABULARY per file as text, so the
# prose naming `__unbox_number` (the runtime prologue whose string-parsing
# behaviour is the entire root cause of the string-spelling half of this bug)
# registers as growth. Naming that helper is what makes the comment usable by
# the next reader; the alternative is a comment that says "some prologue" and
# sends them hunting. Verified with `grep -n __unbox_number` on both files: every
# occurrence is inside a `//` or `/** */` block.
coercion-sites-allow:
  - src/codegen/array-nonindex-key.ts
  - src/codegen/vec-props.ts
---

# #4247 — non-array-index element keys are NAMED properties, not elements

Per §10.4.2.2 a property key `P` of an Array exotic object is an **array
index** if and only if `ToString(ToUint32(P)) === P` **and**
`ToUint32(P) !== 2^32 − 1`. Everything else — `4294967295`, `4294967296`,
`-1`, `1.1`, `NaN`, `Infinity`, `true` — is an ordinary **named** property:
it round-trips under its canonical name, creates no element, and leaves
`length` alone.

#4222 measured the whole `built-ins/Array` `oob:` cluster as exactly this rule
and deferred it as a *contained follow-up in the element-write growth path*.
This issue is that follow-up. The diagnosis turned out to have **two** halves,
only one of which #4222 had seen.

## Root cause A — the NUMERIC spelling traps the module

`compileElementAssignment`'s vec arm compiles the key with an `{kind:"i32"}`
hint. `4294967295` saturates to `i32.max`, the grow sequence tries to allocate
a 2-billion-element backing array, and the module **traps**
(`array element access out of bounds`) before any assertion runs. The read
twin saturates the same way.

## Root cause B — the STRING spelling is silently dropped

`(a as any)["4294967295"] = v` reaches `__extern_set`, whose spliced
`$__vec_base` prologue runs `__unbox_number(key)` and, when that is not NaN,
handles the key **terminally** as a vec element — in-bounds `array.set`,
otherwise a silent no-op — *without ever reaching the #3537 expando bag*. In
standalone `__unbox_number` parses **native strings** (StringToNumber,
`registry/imports.ts`), so the string spelling is eaten there too.

This half was invisible because the write and the read saturate to the *same*
wrong index, so a write-then-read probe round-trips and looks correct. It is
only wrong against a second observer — `a.length`, `a[0]`, or the other
spelling of the same key. The first cut of this fix was measured as "working"
on exactly such a probe before the WAT showed both sides sitting on
`i32.const 0`.

## Fix

One new module, `src/codegen/array-nonindex-key.ts`, owns the classification
and the emit; the two element sites each gain one `if` arm that consults it.

1. **Classification** (`nonArrayIndexNumericKey`) — a *compile-time constant*
   key that is not an array index, in three families:
   - **number** (`4294967295`, `-1`, `1.1`), including `NaN` / `Infinity` /
     `Number.POSITIVE_INFINITY` / `NEGATIVE_INFINITY`, which are global
     identifiers that `resolveConstantExpression` does not know;
   - **boolean** (`x[true]` names `"true"`, not index 1);
   - **string**, but only when `String(Number(s)) === s` round-trips.
   - Plus `new Number(<const>)` / `new String(<const>)`, whose ToPropertyKey
     runs ToPrimitive first.
2. **Emit** — `__vec_prop_set` / `__vec_prop_get` (the #3537 bag) in
   standalone, `__extern_set` / `__extern_get` in gc. The bag accessors had to
   be **exported** and called directly: routing through `__extern_*` in
   standalone would re-enter the very prologue that is root cause B.
3. **Both spellings route**, so the numeric and string forms of one key can no
   longer disagree.

### Why the string rule is a round-trip and not "any non-index string"

A vec receiver reaches this site for `arr["length"]`, `arr["push"]`,
`arr["constructor"]` too, and none of those are array indices either. Routing
them to the expando bag would answer `undefined` for the real length and for
every borrowed prototype method. `Number("length")` is NaN, whose ToString is
`"NaN"`, which does not equal `"length"` — so the round-trip rejects that whole
family **by construction** rather than by a deny-list a new builtin could
outgrow.

`[Symbol.iterator]` is excluded a second way: the key resolvers refuse
non-literal shapes instead of calling `resolveComputedKeyExpression`, which
maps it to the `@@iterator` reserved name (not an array index either, and its
vec arm lives downstream of this one).

### One relocation

`elementAccessTypedArrayName` moved verbatim from `expressions/assignment.ts`
into the new module. Both element sites must answer the same "is this receiver
an array exotic?" question before the routing may fire, and the READ site had
no equivalent. Relocating instead of duplicating keeps the oracle-ratchet count
net-zero (measured: `getTypeAtLocation +0, ctx.checker +0`).

## Measured

test262, `built-ins/Array/S15.4` + `15.4.5` + `property-cast` + `length/`
(**71** files — the reachable set), this branch vs. its own base, sequentially,
one lane at a time:

| lane | before | after | delta | regressions |
| --- | --- | --- | --- | --- |
| standalone | 31 / 71 | **38 / 71** | **+7** | **0** |
| gc | 29 / 71 | **36 / 71** | **+7** | **0** |

Identical seven files in both lanes:

- `built-ins/Array/15.4.5.1-5-1` · `15.4.5.1-5-2`
- `built-ins/Array/S15.4.5.1_A2.1_T1` · `S15.4.5.2_A1_T2`
- `built-ins/Array/property-cast-number` · `property-cast-boolean-primitive`
  · `property-cast-nan-infinity`

### A regression that the wrapper arms exist to prevent

An intermediate cut lost `S15.4_A1.1_T7` / `_T8` in the gc lane
(`z[new Number(1.1)] = 1; z["1.1"]`). Those were passing **by accident**: the
dynamic `new Number` key was not compile-time constant, so its write stayed on
the element lane at index 1, and the constant-keyed read landed on the same
index-1 element. Routing only the read broke the coincidence. Recognising
`new Number(<const>)` / `new String(<const>)` puts both back on the same
store and the losses went to zero — this is why those two arms are in the
resolver rather than being "extra credit".

## Leftovers (deliberately not shipped)

- **Non-constant keys.** `a[i]`, and `x[object]` with a user `valueOf`/
  `toString` (`S15.4_A1.1_T9`), need the §10.4.2.2 test *inside* the element
  helper at runtime, plus a real ToPropertyKey. Out of scope here; the whole
  measured cluster is constant-keyed.
- **Non-canonical numeric strings** — `""`, `"00"`, `"0x10"`, `" 1"`. Not array
  indices and not canonical, so they keep the old element lowering and stay
  wrong. Unchanged by this issue, not introduced by it. Repairing them needs
  the broad "any non-index string" rule plus a real answer for the
  `length`/method-name family.
- **`(a as any)["length"]` answers `1`** (element 0) in both lanes — the
  pre-existing bracket-read gap for reserved names. The routing correctly
  refuses to touch it; fixing it is a different surface.
- **`y[new Number(1)] = 1; y[1]`** is still wrong in **standalone** (the key
  *is* an index, so it keeps the element lane, where the wrapper object
  coerces to the wrong i32). Fixing it means emitting the resolved constant
  index, which is a different edit in the element path.
- **A genuine index at the top of the range** (`a[4294967294]`) still traps on
  the grow. That needs real sparse arrays (#4222 item 2) and is why
  `S15.4.5.2_A1_T1` — which additionally demands `length === 4294967295` —
  remains failing while its `_T2` sibling flips.

## Permanent repro

`tests/es5-standalone-array-nonindex-keys.test.ts` — 22 tests, both lanes:
both key spellings (numeric and string), the `new Number(<const>)`/
`new String(<const>)` key shapes, and the negative pins (ordinary indices,
`length`, borrowed prototype names keep their lowering). Conformance bucket:
`test262/test/built-ins/Array/{S15.4,15.4.5,property-cast,length}` (+7 both
lanes, measured sequentially).

## Acceptance

- A constant non-array-index element key round-trips under its canonical name,
  creates no element, and leaves `length` unchanged, in **both** lanes.
- Ordinary indices, `length`, and borrowed prototype names keep their existing
  lowering (pinned as non-regression cases).
- No new host imports (the standalone arm asserts an empty `env::` import list).
