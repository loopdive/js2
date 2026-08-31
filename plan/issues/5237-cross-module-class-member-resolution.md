---
id: 5237
title: "Compiled-class members resolve against the CALLING module's exports — every prototype member of a linked provider's class answers undefined in the consumer"
status: done
completed: 2026-08-31
sprint: current
priority: high
horizon: l
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5237 — cross-module compiled-class member resolution

## Problem

Through the #4628 linked provider, every member read off a provider class's
prototype answers `undefined` in the consumer:
`typeof Temporal.PlainDate.prototype.toString` is `"undefined"`, `d.year` /
`d.month` / `d.day` on a `.from()` result are `undefined`, and
`Temporal.PlainDate.prototype.toString.call(d)` throws "Cannot read
properties of null" — while `Object.getOwnPropertyNames(PlainDate.prototype)`
correctly lists all 31 names. This is why the harness `staticFrom` row still
prints `[object Object]` after the #5223 fix (PR #5339 re-measured:
byte-identical before/after, so it is a distinct defect).

Root cause (measured by dev-5223): the host boundary resolves compiled class
members against the **calling module's** exports. The provider binary exports
141 `__member_kind_*` / 41 `__call_get_*` / 137 `__class_call_*`; the
consumer exports none, so nothing resolves. A `new`-built instance escapes
because its host proxy carries the provider's export slot; a prototype-read
or `Object.create(proto)` path does not.

Control: the identical single-module shape answers `"function"`.

## Direction

Same family as #5222 (PR #5324's module-aware mirrors) and #5225: the member
resolver needs to consult the exports of the module that OWNS the class (the
minting module recorded on the mirror/prototype), not the reader's. Likely
site: `_resolveClassMember` / `_safeGet` in `src/runtime.ts` and the linked
provider export registry from #5324 — route resolution through the owner's
registered export set when the receiver/prototype is foreign.

## Acceptance criteria

1. Non-Temporal linked reduction: prototype member reads and getter reads on
   a provider class resolve in the consumer; new `tests/issue-5237-*.test.ts`
   failing on base (linked lane), single-module control passing on base.
2. Temporal: `Temporal.PlainDate.from("2020-03-04").toString()` answers
   `"2020-03-04"` and `.year` answers `2020` through the provider; flip the
   harness `staticFrom` knownGap.
3. No regressions: issue-5222/5223/4628 test files + #2527 linker family.
   Gates green.

## Notes

- Found by dev-5223 (PR #5339 "Found and NOT fixed" item 1) with counts and
  controls. With #5225/#5226, this is the remaining provider-seam family
  before the test262 runner can be wired to the provider (#4628 criterion 2).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Implementation notes (2026-08-31)

### What the root cause turned out to be

The direction in "Direction" above was right about the SHAPE — resolution has
to end up against the module that owns the class — but the mechanism is not a
new owner lookup. Two independent defects produced the reported symptoms, and
both were measured with a non-Temporal reduction
(`tests/issue-5237-cross-module-class-members.test.ts`, a throwaway `cls5237`
npm package, `linkPlan.mode === "separate"`).

**1. `__extern_method_call`'s exit un-marshal was still module-blind.** #5222
taught `_unwrapForHost` to leave a mirror minted by a linked provider intact,
but wired the reader through **only** `__extern_get` (via
`normalizeSandboxValue`). A method call is the other door a provider-owned
value walks out of, and its six return exits all called `_unwrapForHost(ret)`
with no reader — so a static factory's fresh instance
(`Point.make(...)`, `PlainDate.from(...)`) was stripped back to a raw WasmGC
struct the consumer has no `__sget_*` / `__member_kind_*` decoder for. Measured
on base: zero own keys, `undefined` for every field, and
`obj.label()` throwing "label is not a function". The mirror is what CARRIES
the provider's export slot, so preserving it *is* routing resolution through
the owner's exports — no second registry needed.

**2. A method bridge ignored `this`.** `classMethodHostBridge` closed over the
carrier it was RESOLVED from and never read its receiver, which is correct for
the `inst.m()` shape it was written for and wrong for `C.prototype.m.call(inst)`
— the call ran against the PROTOTYPE and every field read `null`
("Pnull:null"; through the Temporal provider, a throw). `selectBridgeReceiver`
now honours `this` when the same member-kind discriminator accepts it, and
falls back to the bound carrier otherwise, so nothing that already worked
moves.

A third, smaller gap surfaced in the same reduction: the class-ctor mirror's
`prototype` facade is a Proxy over a bare `Object.create(null)` with only
`get`/`has` trapped, so `Object.getOwnPropertyNames(C.prototype)` answered `""`
in a linked consumer (and `0` for `Temporal.PlainDate.prototype`). It now has
an `ownKeys` trap forwarding to the wrapped prototype struct.

### An owner-exports registry was built, measured, and REMOVED

The literal reading of "Direction" — record raw-carrier owners in
`_wrapForHost` and retry `_resolveClassMember` against the owner's exports when
the reader's set misses — was implemented in full and then **deleted**, because
with (1) and (2) in place it moved **no** measurement: the #5237 reduction, the
`Object.create(providerProto)` probe, and issue-5222 answered identically with
and without it. It would have added a WeakMap write to `_wrapForHost`, which
is on the `__extern_get` hot path (#3903). Recorded here so the next reader
does not re-derive it.

### Acceptance criterion 2 is NOT met, and it is not a provider-seam defect

`Temporal.PlainDate.from("2020-03-04")` still answers `"[object Object]"` for
`.toString()` and `undefined` for `.year`. **The single-module control answers
exactly the same** — measured by compiling the identical polyfill source and
consumer into ONE module with `compileMulti` (no linker, `linkedModules === 0`,
`.tmp/probe-temporal-single.mts`, 37.9 s compile):

| probe | linked provider | SINGLE MODULE (no linking) |
| --- | --- | --- |
| `typeof PlainDate.prototype.toString` | "function" | "function" |
| `new PlainDate(2020,3,4).toString()` | "2020-03-04" | "2020-03-04" |
| `PlainDate.prototype.toString.call(new PlainDate(…))` | "2020-03-04" | "2020-03-04" |
| `PlainDate.from("2020-03-04").toString()` | "[object Object]" | **"[object Object]"** |
| `PlainDate.from("2020-03-04").year` | undefined | **undefined** |

So the `staticFrom` row is blocked by a module-independent gap, not by
cross-module resolution: `@js-temporal/polyfill`'s `CreateTemporalDate` builds
its instance with `Object.create(PlainDate.prototype)` and stores the ISO
fields in slots keyed by that host object, and a host object whose PROTOTYPE is
a WasmGC struct never reaches the prototype's accessors for a member read. The
reduction pins the same shape: `Object.create(C.prototype)` built INSIDE the
provider now dispatches correctly (`P1:2`, `sum === 3`), while the same
expression written in the CONSUMER against a `C.prototype` read through the
ctor-mirror facade still answers `Pnull:null` where the single-module control
answers `P1:2`.

The harness `staticFrom` knownGap is therefore **kept**, with its note replaced
by this measurement — the previous note attributed the row to cross-module
resolution, which the control disproves. Needs its own issue.

### What DID move for Temporal through the provider

Fresh `JS2WASM_TEMPORAL_CACHE` for each side (#5227 — the provider cache is not
invalidated by compiler changes):

| probe | base | after |
| --- | --- | --- |
| `PlainDate.prototype.toString.call(new PlainDate(2020,3,4))` | THREW | "2020-03-04" |
| `Object.getOwnPropertyNames(PlainDate.prototype).length` | 0 | 31 |
| `new PlainDate(2020,3,4).toString()` | "2020-03-04" | "2020-03-04" |
| `Temporal.Now.plainDateISO()` / `timeZoneId()` | throws | throws (#5221 family, unchanged) |

Both moved rows are promoted into the harness SUPPORTED set
(`protoMethodCall`, `protoMemberCount`) and asserted in
`tests/issue-4628-temporal-global.test.ts` (11/11, fresh cache), so a
regression is loud.

### Regression runs

One vitest process per file. Passing: issue-4628 (11), issue-5221 (19),
issue-5222 (2), issue-5223 (9), issue-5237 (2), package-linking (21),
provider-manifest (5), linker (13), issue-3451 (6), issue-3765 (4 + 18),
issue-3782 (2), issue-3521 ×4 (4 + 35 + 19 + 22), issue-2928-e6-provider-cache
(8), issue-2928-refusal-provider (3), 61 of 68 issue-3520 files.
`equivalence-gate` 24 failing / 1718 passing / 24 known — no new regressions.

Failing IDENTICALLY on base (each re-run with only `src/` reverted, same counts
and same errors): issue-2928 (`ERR_IPC_CHANNEL_CLOSED`),
issue-2928-direct-eval-state-pool (2), issue-2928-runtime-acorn (1),
issue-2928-runtime-link (1), issue-3521-prepared-free-function-routing,
issue-4260 (2), and 7 issue-3520 files (compiler-support-abi,
imported-global-abi, lifted-program-abi, monomorph-program-abi,
program-abi-type-remap, support-callable-abi, type-class-abi). The dispatch
brief predicted issue-3451 (3) would fail; it passes 6/6 on this base.

### Other things reported, not fixed

- `Object.getOwnPropertyNames(C.prototype)` omits `"constructor"` in BOTH
  lanes, so the reduction's control pins the shared answer rather than the spec
  one. General compiled-class gap.
- `Temporal.Now.plainDateISO()` / `timeZoneId()` still throw "dereferencing a
  null pointer" — the #5221 family, already knownGaps, untouched here.
- Nothing was blocked by #5225 (consumer-literal args) or #5226 (error
  identity); neither was reached.
