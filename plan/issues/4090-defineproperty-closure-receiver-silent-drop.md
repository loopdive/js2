---
id: 4090
title: "Object.defineProperty(fn, k, desc) is a SILENT no-op — give the define appliers the closure-bag arm #4047 named as its own prerequisite"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: property-descriptors
goal: standalone-mode
related: [4047, 4055, 4017, 4010, 4080, 3468, 3251, 3537]
umbrella: 4055
origin: "Harvested 2026-08-02 from the stranded draft fork PR ttraenkler/js2#12 (its `#3979` item 3). Everything else in that PR was superseded; this is the one slice that is still live, still unowned, and independently corroborated."
---

# `Object.defineProperty(fn, k, desc)` silently defines nothing

## The gap, measured on `upstream/main` @ `2ad68955e` (2026-08-02)

`--target standalone`, compiled host-free (zero `env` imports asserted — the
#2961 refusal that `runTest262File` does **not** apply):

```js
const fn = function () {};
Object.defineProperty(fn, "p", { value: 42, enumerable: true, configurable: true, writable: true });
fn.p;                       // undefined   (spec: 42)
fn.hasOwnProperty("p");     // false       (spec: true)
```

It does **not** throw. `__defineProperty_value` / `__defineProperty_accessor`
reach a terminal arm that is a lenient no-op for a closure receiver, so the call
returns normally having stored nothing — a silent wrong answer, not a refusal.

Positive control in the same run: the identical sequence on a plain `{}`
receiver answers `42` / `true`, and an 8-way own-property probe on `{}` answers
the spec value on all 8 reads. So the instrument sees the correct path when
there is one.

## This is not a new diagnosis — #4047 named it as its own prerequisite

`f887d4bb8` ("fix(#4047): revert the carrier-bag arm — it was unsound") reverted
resolving a `Properties` **map** through the carrier bag, and closed with:

> Concrete evidence for #4010. The narrower prerequisite for the Function half:
> give `__defineProperty_value`/`_accessor` a closure arm recursing on
> `__closure_bag_ensure`, mirroring `vecOverlayArm` — which would also fix the
> pre-existing silent drop of `Object.defineProperty(fn, "p", desc)`.

That prerequisite was never filed. This is it.

## Why THIS arm is sound where #4047's reverted one was not

The distinction is the one #4017 already drew, and it is load-bearing — do not
pattern-match this to the revert:

| | #4047's reverted arm | this issue |
| --- | --- | --- |
| operation | enumerate a `Properties` **map** | define **one fixed key** |
| needs a COMPLETE own-key source? | **yes** | **no** |
| bag is complete? | **no** — `props.p = v` lands in the bag, `Object.defineProperty(props,"p",…)` lands in the #3251 overlay (Array) or nowhere (Function) | n/a |
| failure mode it produced | enumerated empty, defined nothing, **returned normally** | — |

Writing one key into `__closure_bag_ensure`'s bag is writing into exactly the
table `__extern_get` / `__extern_set` / (post-#4017) `__hasOwnProperty` read
from, so define/read/presence agree **by construction**. It also *removes* an
inconsistency rather than adding one: it is what makes #4017's
`hasOwnProperty` answer `true` for the `defineProperty` spelling, which today it
correctly answers `false` for.

## Instance #8 of #4080

Same shape as the seven already collected: **the correct treatment already
exists and one consumer was never wired to it.** `__closure_bag_ensure` (#3468)
is the treatment; `vecOverlayArm` is the working sibling consumer for the vec
carrier; the define appliers are the consumer that was never wired.

## Scope — and what is deliberately NOT here

**In scope:** a closure arm on `__defineProperty_value` and
`__defineProperty_accessor` recursing on `__closure_bag_ensure`, mirroring
`vecOverlayArm`.

**Explicitly NOT in scope, each with its reason:**

- **The ARRAY (vec) half.** #4017 measured a vec `hasOwnProperty` arm
  *unreachable* and removed it rather than shipping decoration; the vec bag
  (#3537) and the vec descriptor overlay (#3251) are two disjoint tables that
  clobber each other. That is **#4010**, and it is a substrate change, not this
  arm.
- **Enumeration over the bag** — `Object.keys` / `for-in` / `__object_keys_forin`
  on a carrier. These need a *complete* key source and therefore hit #4047's
  unsoundness head-on **until this issue lands**. Measured on main today, with
  `Object.keys` over a vec's index keys as a live control (answers `3`, i.e.
  #4071 did land, so the probe path is live):

  ```js
  const a = [10, 20, 30]; a.q = 7;
  Object.keys(a).length;   // 3   (spec: 4 — the named expando is invisible)
  ```

  Sequencing note for whoever takes #4055: this issue is the prerequisite that
  makes a bag a complete own-key source for the **closure** carrier, and only
  then does enumerating it become sound.
- **Date / Error / RegExp receivers.** Measured: the expando write is lost
  outright — `d.q = 7; d.q` does not even round-trip, so all 8 reflective reads
  fail. There is no bag to define into. Already recorded in **#4010**; not
  re-filed here.

## Owner routing

`src/codegen/object-runtime-descriptors.ts` is the `L-descriptor` lane's active
file (PR #4017, #4055). **This issue is filed FOR that lane, not implemented
here** — the harvest that produced it deliberately touched no file that lane
owns.

## Measurement provenance

- Baseline JSONL force-refreshed before any sizing
  (`node scripts/fetch-baseline-jsonl.mjs --force` → 48,346 entries, 2026-08-02).
- All probes compiled `target: "standalone"` and **asserted zero `env` imports**,
  so a lane-routing change cannot hide behind `runTest262File`'s missing #2961
  refusal.
- Verdicts computed **inside** the module and returned as numbers: a `string`
  returned from an exported standalone function does not marshal and comes back
  `undefined` for every case *including a positive control*. The first cut of the
  probe fell into exactly that and had to be discarded — see #3992's test header,
  which documents the same trap.
- No flip count is claimed here. The population this gates sits inside #4055's
  835 ≤ES5 standalone failures; **gated is not flipped**, and this issue does not
  quote a flip estimate it has not measured.
