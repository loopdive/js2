---
id: 4164
title: "fix(standalone): borrowed String.prototype.<m> on a non-string receiver — case-conversion family + slice, and the transferred-closure dispatch arm"
status: in-progress
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
area: codegen
language_feature: String.prototype
goal: es5
related: [4163, 2875, 3217, 3254, 1470]
loc-budget-allow:
  - src/codegen/array-object-proto.ts
coercion-sites-allow:
  - src/codegen/array-object-proto.ts
assignee: ttraenkler/es5-string
---

# #4164 — borrowed `String.prototype.<m>` on a non-string receiver (standalone)

Child of the #4163 ES5-standalone umbrella, lever
`built-ins/String/prototype` (194–202 reachable failures).

## Census of the cluster (fresh baseline `20260801-090441`)

630 ES5-classified `built-ins/String/prototype` tests run in the standalone
lane; **428 pass, 202 fail**. Sub-buckets, with the host-lane verdict for each:

| # | host-pass | bucket |
| --- | --- | --- |
| 82 | 52 | **borrowed receiver / ToString(this)** — `obj.m = String.prototype.m; obj.m()` or `String.prototype.m.call(x)` with a non-string `x` |
| 51 | 38 | **RegExp-gated codegen refusals** — `search`/`match`/`split`/`replace` with a RegExp or symbol-protocol argument (#1474/#1539/#1913). **NOT this cluster** — they belong to the standalone RegExp engine |
| 26 | 23 | other |
| 22 | 9 | `TypeError: Cannot access property on null or undefined` (mostly transferred `split`, which returns an Array) |
| 15 | 15 | `__module_init` invalid Wasm — `call[N] expected type externref, found ref.null` |
| 4 | 3 | `is not yet implemented in --target standalone` (`concat`, `split`, `Object.prototype.toString`) |
| 2 | 2 | host-import leak (`env::Cache_match`) |

**So a quarter of the "194" is RegExp-gated and out of scope.** The genuine
String.prototype-semantics majority is the borrowed-receiver bucket, and by
method it is dominated by the case-conversion family:

| method | failures | host-pass |
| --- | --- | --- |
| split | 25 | 11 |
| **toLocaleUpperCase / toLowerCase / toLocaleLowerCase / toUpperCase** | **13 + 13 + 13 + 13 = 52** | 39 |
| substring | 10 | 8 |
| slice | 10 | 6 |
| indexOf / charCodeAt / lastIndexOf | 6 each | |
| match / replace / charAt / concat | 5 each | |

## Root causes (two, both real)

### 1. `emitStringProtoMemberBody` wired only part of the member set

`src/codegen/array-object-proto.ts`. The reflective `String.prototype.<m>`
closure body dispatched to a real native body for
`{substring, indexOf, lastIndexOf, includes, startsWith, endsWith, trim,
trimStart, trimEnd, charAt, at, charCodeAt, codePointAt}` and to
`emitProtoMemberBodyRefusal` for everything else. That refusal **returns
`null`**, which is the "not wired — fall through" signal, so a borrowed
`toUpperCase` evaluated to `null`.

### 2. The transferred-closure dispatch arm was hard-coded to `charAt`

`src/codegen/char-at-transfer.ts`. The generic `__apply_closure` bridge
installs the receiver only in `__current_this` and fills every declared closure
parameter from the argument **vector**, so a borrowed method's param 1 (`this`)
receives the first user argument — or, for a 0-arg method, nothing. `charAt`
had a bespoke exact-dispatch pair of arms (one in `__extern_method_call`, one
in `__apply_closure`) to work around this; no other member did. That is why
`x.charAt = String.prototype.charAt; x.charAt(0)` worked while
`x.toUpperCase = String.prototype.toUpperCase; x.toUpperCase()` returned `null`.

### 3 (latent). `$__any_to_string` is not `ToString`

On an OBJECT receiver it takes the `"[object Object]"` terminal instead of
running §7.1.1.1 OrdinaryToPrimitive, so a boxed-primitive receiver
(`new Object(true)`, `new Boolean`, `new Number(123)`) stringified to
`"[object Object]"`. `emitStringSubstringMemberBody` already pre-reduced via
`__to_primitive`; the trim-family body did not.

## Change

- `array-object-proto.ts` — generalise `emitStringTrimMemberBody` into
  `emitStringUnaryStringMemberBody(ctx, fctx, member, helperName)` (arity 0,
  string in / string out) and route the case-conversion family to it.
  `toLocale{Upper,Lower}Case` map to the non-locale helpers, matching the
  #1470 fallback the direct path already takes. Add the `__to_primitive`
  pre-reduction so ToString is spec-correct for object receivers. Route
  `slice` to the substring body.
- `string-proto-substring.ts` — parameterise on `"substring" | "slice"`;
  `__str_slice` has the identical `(flatStr, i32 start, i32 end)` shape and the
  same `0x7fffffff` absent-end sentinel, differing only in the
  negative-index-vs-swap rule.
- `char-at-transfer.ts` — replace the hard-coded `"charAt"` in both arms with a
  `TRANSFERRED_STRING_PROTO_MEMBERS` list, and generalise the apply arm to any
  closure arity (it re-verifies the meta type, the
  `__proto_method_<brand>_<member>` body and the all-externref ABI at emit
  time, so an unwired entry is inert rather than wrong).
- The `__to_primitive` pre-reduction is applied to the index-accessor and both
  search bodies too — that is what makes `indexOf`/`lastIndexOf`/`charCodeAt`/
  `at`/`codePointAt` correct on a boxed-primitive receiver, in BOTH the
  transferred and the `.call` shapes.

Also carries a §7.1.17 Symbol guard: `$__any_to_string` has a deliberately
PRINTABLE Symbol fallback, so routing the case family through it without a
guard silently stringified a Symbol receiver instead of throwing. The first A/B
run caught exactly that as a single regression; the guard fixes it and two
`trim{Start,End}` symbol tests with it.

## Test Results

**Unit** — `tests/issue-4164.test.ts`, 16 cases through the literal-JavaScript
(`allowJs`) lane the test262 standalone runner actually uses: **8 fail on
`HEAD`, 16/16 pass with the change.** (A `.ts`-lane probe does NOT reproduce the
bug — an annotated receiver takes a different, statically-typed member-call
route.)

**Scoped standalone test262, `built-ins/String/prototype`** — full A/B, both
runs in this worktree, `TEST262_TARGET=standalone`:

| | ES5-classified | all editions |
| --- | --- | --- |
| before (`HEAD`) | 412 / 632 | 647 / 1184 |
| after | **441** | **699** |
| delta | **+29** | **+52** |
| regressions | **0** | **0** |

(The `after` column is the +29/+49 measured on the first full A/B plus the +3
from the Symbol guard, re-measured over the affected directories:
`toLowerCase/this-value-tostring-throws-symbol`,
`trimStart/this-value-symbol-typeerror`, `trimEnd/this-value-symbol-typeerror`
— 0 broken in that pass.)

Fixed families: `toUpperCase`/`toLowerCase`/`toLocale*` (8 ES5 + 4 ROC),
`trim*` (11 ES5 + 12 own-toString/valueOf error-propagation),
`slice` (5), `charCodeAt` (4), `indexOf`/`lastIndexOf` (4),
`includes`/`startsWith`/`endsWith`/`codePointAt` `return-abrupt-from-this` (4).

**No host-lane regression**: `tests/equivalence/` string/prototype/coercion
suites (`string-methods`, `tostring-valueof`, `wrapper-string-concat`,
`issue-799-prototype-chain`, `array-prototype-methods`,
`issue-3085-symbol-tostring`, `string-arithmetic-coercion`) — 86/86 pass.
`tests/issue-3217.test.ts` (the trim slice this generalises) — 7/7 pass.

**Pre-existing, NOT caused by this change**: `tests/issue-2875.test.ts`
`at.call('abc', 9)` and `tests/issue-2875-slice2-num.test.ts`
`codePointAt.call('ABC', 9)` (out-of-range → `undefined`) fail identically on
`HEAD`.

## Remaining / out of scope

- **`split` (25)** — the transferred closure would have to build an Array, a
  different result shape from the string/index/boolean families already wired.
- **RegExp-gated (51)** — #1474/#1539/#1913, the standalone RegExp engine.
- **`__module_init` externref/ref.null invalid-Wasm (15)** — a module-init
  lowering bug, all 15 host-pass; unrelated to receiver coercion.
- **plain object literal with an own `toString`** — a closed-struct receiver
  does not reach `__extern_method_call`, so the transferred arm never fires.
- `concat` (variadic), `repeat`/`padStart`/`padEnd`, `localeCompare`,
  `substr` — same wiring shape, not yet added.

## Coercion-ratchet note (added while draining CI on PR #12)

`check:coercion-sites` failed: this change adds `__any_to_string` x2 and
`__to_primitive` x1 in `src/codegen/array-object-proto.ts` (root cause 3 — the
missing §7.1.1.1 pre-reduction, without which `$__any_to_string` takes the
`"[object Object]"` terminal on an object receiver).

Granted via `coercion-sites-allow` rather than rewritten, because the same
pre-reduction already exists in the substring body — this follows in-tree
precedent rather than hand-rolling a fresh ToString/ToPrimitive matrix, which
is what the gate is actually guarding against.

**That is a stopgap, not an endorsement.** The gate's preferred fix is routing
through the single coercion engine (#1917 / #2108,
`plan/log/analysis-2026-06/03-coercion-engine-spec.md` §5). Before this issue
merges, decide explicitly: route through the engine, or keep the allowance and
record why. Do not let the allowance become the silent default.


## MEASURED (2026-08-05): +39 / 0 regressions, full directory, all editions

Hardened A/B (incremental per-file output, hang-skip wrapper — zero skips
needed) over the FULL `built-ins/String/prototype` directory, 1,073 files,
standalone lane, host-free pass rule:

| | pass |
| --- | --- |
| BEFORE (three files at c40c9286) | 656 / 1,073 |
| AFTER | **695 / 1,073** |
| fixed / regressed | **+39 / 0** |

Scope note: measured over ALL editions deliberately (char-at-transfer and the
proto-member wiring affect ES2015+ members too), so this is the blast-radius
number, not just the ES5 cluster. No conformance claim is outstanding on this
issue any more; the remaining open item is the coercion-sites-allow vs
coercion-engine decision recorded above.


## Merge resolution (2026-08-05): mostly superseded upstream; two pieces survive

Upstream's #3992 landed the same root causes in refactored form
(`string-proto-tostring.ts`: `NO_ARG_STRING_MEMBER_HELPER` +
`emitStringProtoToStringFlat` — the ToPrimitive-first ToString shared helper).
Upstream's modules win in the merge. Surviving from this branch:

1. `char-at-transfer.ts` generalisation (upstream never touched it — dispatch
   was still hard-coded to `charAt`).
2. The §7.1.17 SYMBOL rejection, re-grafted INTO upstream's shared
   `emitStringProtoToStringFlat` — their #3992 body lacked it, caught by this
   issue's test (`toLowerCase.call(Symbol())` must throw; it printed). Placing
   it in the shared helper also covers the search family's
   `ToString(searchString)` operands.

All 16 behavior tests pass on the merged tree. The +39/0 measurement above was
taken on this branch's pre-merge implementation; the merged tree shares the
mechanism, and the upstream merge_group re-validation is the final arbiter.
