---
id: 4554
title: "A declared address domain for the linear lane: ptr/size/handle instead of literal i32, so handles stop riding as f64 and memory64 stays reachable"
status: in-progress
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
related: [3686, 4539, 4541, 4550]
# id 4554 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the only open PRs were
# 4639 (ci artifact refresh) and 4643 (this lane's own), neither adding an
# issue file.
loc-budget-allow:
  - src/codegen-linear/index.ts
---

# #4554 — A declared address domain, not literal `i32`

Two problems with one shape. Both are about naming the *role* of a scalar
instead of hard-coding its width.

## Problem 1 — handles ride as f64, and the cost is representation

The linear backend compiles a TS `number` to **f64**, so a value that is
semantically an i32 handle is stored in an f64 local and an 8-byte arena slot.
Under [ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md)
*every* `JSValue` is a handle, so that is **2× memory on every stored handle**
plus a conversion at every use.

The conversion instructions themselves are not the cost — a `trunc`/`convert`
pair next to a call is noise. The representation is.

**This is not a flag that was left off.** `resolveType` in
`src/codegen-linear/index.ts` deliberately resolves numeric aliases —
`type i32 = number` and `type Meters = number` alike — to **f64**, and says why:

> Anything else used to fall straight into the `i32` (pointer) default — which
> silently mis-typed **every type alias of a numeric type** (#3686 bug 2). The
> signature slot came out `i32` while the body compiled the arithmetic as
> `f64`, so the module failed validation.

So what is missing is a **value domain**: the direct backend has no
expression-level type tracking, so a signature saying `i32` and a body emitting
`f64` cannot be kept in agreement. That is the same gap recorded as the
boundary-conversion limitation in `c-abi.ts`, seen from the other side.

## Problem 2 — `i32` is hard-coded as *the* pointer type

Pointers, sizes and handles are `i32` **because the target is wasm32**, not
because they are inherently 32-bit. Under memory64 addresses and sizes become
`i64`. Every literal `{ kind: "i32" }` standing for an address is therefore an
unexamined assumption, and today there are hundreds of them (`__heap_ptr`, the
`this` param, string/array pointers, the aggregate offsets).

**We already read the answer and then ignore it.** `scripts/quickjs-artifact/
extract-abi.mjs` pulls `handleSize` and `jsValueSize` out of the pinned
artifact — the design already treats handle width as a property of the build.
Then the extern ABI hard-codes `{ kind: "i32" }`.

## Non-goal: adopting memory64

Preparation is about not foreclosing it, **not** betting on it. memory64 is
frequently *slower* on today's engines — 64-bit bounds checks cannot use the
4 GiB guard-page trick — and doubling pointer width costs cache. Nothing here
should be read as a plan to switch.

## Tier 1 — the new surface, while it is still private (this PR)

`ExternCImportSpec` is hours old and has no callers outside its own tests, so
changing its shape costs nothing now and is breaking after #4643 merges.

- [x] An `AddressKind` (`"ptr" | "size" | "handle"`) usable anywhere an extern
      param/result type is written, resolved through a single
      `LinearAddressModel`.
- [x] `WASM32_ADDRESS_MODEL` maps all three to `i32` — today's behaviour,
      now stated once instead of assumed everywhere.
- [x] `declareImportedMemory` accepts an `indexType`, and **refuses `"i64"`
      with an explicit error** rather than accepting it and emitting wasm32
      limits. The API is shaped for memory64; the emitter cannot encode it yet,
      and silently emitting the wrong bytes is the failure this avoids.

## Tier 2 — the value domain (not this PR)

- [ ] A pointer/size/handle domain across the linear **IR** value model, so a
      handle stays i32 from producer to consumer with no f64 round-trip.
- [ ] Consume the extracted `handleSize` so width comes from the artifact
      rather than a constant — pairs with #4541's ABI stamp.
- [ ] Retire the boundary-conversion limitation documented in `c-abi.ts`.

**Tier 2 belongs in the IR / `LinearEmitter`, not the direct backend.** The IR
already has a typed value model; the direct path is precisely what lacks one.
Building an address domain into the direct backend would grow the legacy
front-end the migration is retiring — the same constraint recorded on #4541 —
and it shares the coverage gate measured in #4550.

## Soundness constraint (applies to both tiers)

The domain must be **declared, never inferred.** JS `number` is f64; narrowing
anything that "looks like a size" silently changes overflow and division
semantics. `nativeTypeFromTypeNode` already enforces the right guard — the name
must bind to a user-declared `= number` alias, so a stray `interface i32 {}`
cannot miscompile — and that guard should be reused rather than reinvented.

## Acceptance criteria

- [x] Tier 1: an extern import declared with an address kind resolves to the
      target's width and links end-to-end against the real C peer.
- [x] Tier 1: a memory64 index type is refused with a message naming the
      limitation, and a test asserts the refusal.
- [ ] Tier 2: a handle-typed value makes a full round trip — C → compiled code →
      C — with **no** f64 conversion emitted, asserted on the instruction
      stream, not just on the result.
- [ ] Tier 2: switching the address model to i64 changes the emitted types with
      no other source edit — the property that makes this "prepared" rather
      than "hard-coded differently".
