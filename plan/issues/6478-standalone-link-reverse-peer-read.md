---
id: 6478
title: "standalone: the link boundary is ONE-DIRECTIONAL — a consumer-owned object literal or class instance is undecodable inside a linked PROVIDER, so `Get(bag, \"year\")` answers `undefined`, `k in bag` answers false and `Object.keys(bag)` answers `[]`; the Temporal polyfill reads every property bag that way"
status: done
completed: 2026-09-14
assignee: ttraenkler/dev-5383-s17
sprint: current
priority: high
horizon: m
parent: 5383
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-14
loc-budget-allow:
  # 2026-09-14 (S17) — the reverse link channel. The mechanism itself is the NEW
  # module `src/codegen/standalone-link-reverse-peer.ts`; what lands in the two
  # god-files is wiring only, and none of it can move:
  #   object-runtime.ts  +18  (a) the reserve, in the SAME pre-#1984-freeze
  #     window as `standaloneLinkBoundaryPeerIndices`, because the two miss arms
  #     below bake the funcIdx and because the installer's import must precede
  #     the freeze; (b) `?? reversePeerGetIdx` / `?? reversePeerKeysIdx` on the
  #     three existing `boundaryObject… ?? peer…` arms; (c) the consumer's local
  #     terminals, beside `emitStandaloneLinkBoundaryTerminals`, which is the
  #     one point where every terminal they wrap is registered. Most of the
  #     growth is the note that the three alternatives are MUTUALLY EXCLUSIVE
  #     (JS-host module / standalone consumer / standalone provider) — a reader
  #     who does not know that will "simplify" the chain and give one lane an
  #     arm it must not have, which no byte A/B on the other lane would show.
  #   index.ts  +7  the finalize call, in the post-host-bridge-strip window next
  #     to `publishStandaloneLinkBoundaryExports`, with the reason it cannot run
  #     earlier (both sides resolve through `funcMap`, which every late import
  #     since registration has shifted).
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
---

# standalone: the link boundary only works in one direction

## Problem

#5383 S2d gave the standalone lane a wasm→wasm boundary so a CONSUMER can read a
value a linked PROVIDER minted. The other direction was never built, and it is
the direction the Temporal polyfill actually uses: the consumer builds a
property bag and hands it to the provider, which reads it with a computed key.

```js
// consumer
const bag = { year: 1976, monthCode: "M11", day: 18 };
NS.get(bag, "year");           // provider: function (o, k) { return o[k]; }
```

Measured host-free, `--target standalone`, linked pair
(`.tmp/s17/{c1,c2}.mjs` through `.tmp/s17/pair2.mjs`; "single" = the same two
modules with no link):

| consumer-built carrier, read by the PROVIDER | linked, base | single | S17 |
| --- | --- | --- | --- |
| object literal `{ year: 1976 }` → `o[k]` | **`undefined`** | `1976` | **`1976`** |
| object literal → `o.year` | **`undefined`** | `1976` | **`1976`** |
| `{}` then `b.year = …` | **`undefined`** | `1976` | **`1976`** |
| class instance → `o[k]` | **`undefined`** | `1976` | **`1976`** |
| `Object.keys(bag)` | **`""`** | `year,monthCode,day` | **`year,monthCode,day`** |
| `{}` then `b[k] = …` (computed write) | `1976` | `1976` | `1976` |
| `Object.create(null)` bag | `1976` | `1976` | `1976` |
| array `length` / index, string `length` | ok | ok | ok |
| `k in bag` | **`false`** | `true` | **`true`** |
| `for (k in bag)` | **`""`** | `year,day` | **`year,day`** |
| `{ calendar: null }` → `typeof` | `undefined` (bag unreadable) | `object` | **`object`** |

**The discriminator is the CARRIER, not the key and not the direction of the
call.** A generic `$Object` is a canonical runtime type, so the provider's own
ladder decodes it — which is why the `Object.create(null)` bag and the
computed-write object were already fine and made this look like a key-identity
or string-interning problem. An object literal and a class instance are CLOSED
static-shape structs the consumer declared; they appear in the consumer's
finalize-time `__extern_get` field ladder and in no other module's, so the
provider misses on every arm and falls through to its terminal. That is exactly
the S2d defect with the two modules swapped.

Against the real linked Temporal provider (`.tmp/s17/t1.mjs`, fresh cache,
`cacheHit=false` on both labels) the same split shows up as an INLINE-vs-BOUND
difference, which is what makes the test262 rows fail:

| probe | base | S17 |
| --- | --- | --- |
| `Temporal.PlainDate.from({ year, month, day }).day` (inline) | `18` | `18` |
| `const a = { year, month, day }; Temporal.PlainDate.from(a).day` | **`""`** | **`18`** |
| `const a = { …, timeZone: "UTC" }; Temporal.ZonedDateTime.from(a).year` | **`""`** | **`1976`** |

Every `*-propertybag-*` test262 row writes the bound form.

## Root cause

`src/codegen/standalone-link-boundary.ts` is consumer→provider only: the
provider EXPORTS `__js2wasm_link_member_get` / `__js2wasm_link_object_keys` /
… and the consumer IMPORTS them on a miss (`peerMemberGetIdx` /
`peerObjectKeysIdx` in `object-runtime.ts`). A provider has no peer at all, so
its own miss arms have nothing to call.

That shape cannot simply be mirrored. Wasm module imports may not be cyclic, and
the provider is compiled — and CACHED — before any consumer exists, so it cannot
import from one.

## Implementation

New module `src/codegen/standalone-link-reverse-peer.ts` (classified in
`scripts/compiler-boundaries.json`). The channel is INSTALLED at runtime instead
of linked:

1. The provider defines one nullable typed-funcref global per terminal
   (`get`, `keys`, `has`, `isNull`), an `i32` re-entrancy flag, an `i32`
   null-vs-absent channel, and exports one setter
   `__js2wasm_link_install_peer(get, keys, has, isNull)`.
2. The consumer defines its OWN normalising terminals
   (`__js2wasm_link_local_member_get` / `_object_keys` — same undefined→null and
   empty-keys→null normalisation the forward wrappers do, for the same reason:
   `null` has to mean "not mine" — plus `_has` and `_is_null`) and calls the
   setter from the top of `__module_init` with `ref.func` of each.
   `applyModuleInitGuard` prepends `call __module_init` to every exported
   function on this lane, so the channel is live before any consumer entry point
   runs.
3. The provider's `__object_keys` / for-in and `__extern_has` miss arms take the
   same slot the forward peer / host import takes
   (`boundaryObjectKeysIdx ?? peerObjectKeysIdx ?? reversePeerKeysIdx`,
   `boundaryObjectHasIdx ?? reversePeerHasIdx`) and `call_ref` through the global
   when it is non-null. `__extern_get` takes its OWN arm shape — see below.

### `__extern_get` cannot share the forward arm, and that is a correctness fact

The forward arm reads a `null` answer as "the peer does not own this receiver".
On this side that is ambiguous: a bag field whose VALUE is `null` comes back as
the same `ref.null.extern`. Collapsing the two is a WRONG ANSWER, not a missing
one — measured (`.tmp/s17/c4.out`, first cut of this slice):
`typeof bag.calendar` answered `"undefined"` for `{ calendar: null }`, the
polyfill's `!== undefined` guard admitted it, and **three test262
`*-propertybag-calendar-wrong-type` rows stopped throwing**. The defect was
introduced by the fix and caught by the three-family run, not by any gate.

So the hop asks a second question on exactly that path —
`__js2wasm_link_local_is_null`, which is
`__extern_get(o,k) is null && __extern_has(o,k)` computed in the CONSUMER,
the only module that can see the raw answer before normalisation — and records
it in `__js2wasm_link_reverse_owned`. The provider's arm returns the null only
when that says so, and otherwise falls through to its own miss path exactly as
before. The `__extern_has` conjunct is what keeps a receiver NEITHER module owns
out of the null answer.

After it, `null` · absent · `undefined` are three distinguishable answers inside
the provider, and every probe in `.tmp/s17/c1.mjs` answers **identically in the
linked and the single-module lane**.

A funcref handed across a wasm→wasm link IS the callee, so this is pure wiring:
no copy, no second ABI, and a provider whose consumer never installs keeps its
globals null and answers exactly what it answered before.

### The re-entrancy flag, and why the obvious guard is the wrong one

Both directions are miss paths, so a carrier NEITHER module can decode bounces
forever. The flag is on the PROVIDER side and guards only the reverse hop.

The tempting guard — "refuse while serving a consumer request" — is **wrong
here, not merely weaker**: the provider is normally already inside a
consumer-initiated call when it reads the bag (`PlainDate.from(bag)` runs
provider code for its whole duration), so that guard refuses exactly the reads
this module exists to serve. Only a hop that itself started from the reverse
channel is refused.

The flag is restored through `try`/`catch_all` + `rethrow`, not a straight-line
reset: a provider throw propagating out of a reverse call is ordinary (S2m gave
the graph a shared exception tag precisely so it can), and a leaked `1` would
silently disable the channel for the rest of the instance's life — a wrong
ANSWER, not a crash, which no byte A/B shows.

### Order preservation

- `gc` / JS-host lane: every entry point returns before emitting unless
  `ctx.standalone`, and the three arms prefer the host index — byte-identical by
  construction, and measured.
- A standalone module that is neither a wasm-consumed provider nor a consumer of
  one: nothing is reserved, nothing is imported, no arm changes.
- A provider gains five globals, four functions and one export; a consumer
  gains four functions, one import and a five-instruction init prologue. That is
  the intended change and is what the byte A/B shows moving.
- **The standalone footprint is per-LINKED-MODULE, not per-shape.** A consumer
  that links a provider grows whether or not any consumer-owned carrier ever
  crosses: the targeted byte A/B moves the `noCarrier` and `nullProtoBag`
  controls too. That is stated rather than hidden — any object literal in a
  consumer CAN cross, so an escape analysis would be the only way to narrow it,
  and it would buy bytes, not answers. Modules that link nothing are
  byte-identical, which the 42-file × 2-lane corpus A/B measures.

## Residuals, measured, with reductions

| residual | probe | answers | should be |
| --- | --- | --- | --- |
| provider WRITES a consumer bag (`o[k] = v`) | `.tmp/s17/c2.mjs` "provider writes consumer bag" | old value | new value |
| provider calls a consumer method | `.tmp/s17/c3.mjs` | `called value is not a function` | `7` |
| `typeof <provider-owned instance>` | `.tmp/s17/t2.mjs` | `"function"` | `"object"` |

`__extern_set` has no boundary terminal in EITHER direction, so the write side
needs the forward one first. `in` and `for-in` were residuals in the first cut of
this slice and are **fixed**: the `has` terminal the null-vs-absent oracle needed
serves the `__extern_has` arm too.

**The method-call residual is the `called value is not a function` bucket — 15
rows pooled over the three families, the largest one left — and is now reduced
to one step.** After this fix
`typeof o.m` inside the provider answers `"function"` — the reverse GET hands
back the consumer's closure correctly — and the call still throws, from the
`wantIsCallableGuard` in `emitDynamicCall`
(`src/codegen/expressions/calls.ts` ~L4851): `__is_callable` is a module-local
ladder (`typeof-natives-finalize.ts`) that cannot recognise a foreign closure,
so it refuses before `__apply_closure` is ever reached. A consumer closure
passed as a plain ARGUMENT and called (`cb(a[i])`) already works, which is what
makes the guard — not the apply — the attributed terminal. The forward direction
solved the same question with the `callableKind` terminal; the reverse needs its
twin spliced ahead of `__is_callable`'s terminal `0`. **A reverse `methodCall`
hop was built and then REMOVED from this slice**: with the guard throwing first
it never fired in any probed shape, and an unexercised arm in a provider's hot
terminal is not worth its global.

## Acceptance

1. A consumer-built object literal and class instance read with a computed key
   inside a linked provider answer the consumer's own values. ✅ measured
2. `Object.keys` of a consumer bag, read in the provider, answers its keys.
   ✅ measured
3. The real linked provider's bound-bag `from()` shapes answer. ✅ measured
4. The three linked Temporal families do not regress.
   ✅ **202 → 232** (solo-corrected 233), 33 `fail→pass`. **3 `pass→fail`**, all
   one shape (`calendar: <a provider-owned Temporal.Duration>` in a bag), and
   the base-tree control says they are not this slice's: on base the same value
   through an INLINE bag and through an `Object.create(null)` bag — neither of
   which uses this channel — already throws a **RangeError** where the spec
   wants a TypeError, because `typeof <provider instance>` answers `"function"`
   (the S11 residual). Those rows passed on base only because the whole bag was
   unreadable and an unrelated TypeError came out first. Full tables in
   `### S17 findings` in #5383.
5. Every `gc` artifact in the byte A/B corpus is sha256-identical. ✅ measured

## The id collision this slice found, and how it was resolved

**RESOLVED 2026-09-14.** S14–S16 renumbered on their own branches and the fix
was merged forward: **#6474 → #6479, #6475 → #6480, #6476 → #6481,
#6477 → #6482**. #6478 was never in the collision and did not move. The account
below is kept because the failure mode is reusable, not because it is open.

`npm run -s check:issue-ids:against-main` went RED on this branch the moment the
catch-up merge pulled `main` in, and **none of the four collisions was this
slice's**:

| id | this branch (S14–S16) | already on `origin/main` |
| --- | --- | --- |
| 6474 | `standalone-dynamic-new-poisons-provider-values` | `linked-harness-prelude-module-goal` |
| 6475 | `standalone-nullable-vec-element-callback-param` | `linked-provider-realm-error-constructors` |
| 6476 | `standalone-nullable-native-string-element-binding` | `linked-harness-async-done-marker` |
| 6477 | `standalone-void-0-undefined-comparison` | `linked-harness-descriptor-reads` |

This is exactly the #2531 merge-queue wedge: those four ids were hand-picked
rather than reserved (`claim-issue.mjs --allocate` was, and still is, exiting 6
because the open-PR scan cannot reach `gh`), and `main` has since landed the
`linked-harness` family on them. **#6478 is clean** — the gate names only the
four above.

The fix belonged in the S16 PR, not here: renaming those files from this stacked
branch would have rewritten the predecessor's own change-set and conflicted with
it. The order actually run was (1) S16 renumbered, (2) this branch re-merged,
(3) the gate went green — which is what happened.

**Three things in that sequence are worth carrying forward.**

1. A red `check:issue-ids:against-main` blocks BOTH PRs of a stack and is
   invisible until a catch-up merge pulls `main` in. It is not a reason to
   defer the merge; it is a reason to do it early.
2. **The gate compares FILENAMES, not prose.** S16's renumber passed the gate
   with seven cross-slice `#<old-id>` references still in issue text, source
   comments and a test — each pointing a reader at an unrelated issue that
   `main` now owns under that number. The sweep (`grep -rn '#<old>'` repo-wide)
   has to run AFTER the gate goes green, not before.
3. This branch had to merge S16 **twice**: a concurrent lane merged an earlier
   S16 tip into it (pre-sweep), so `git merge-base --is-ancestor <s16-head> HEAD`
   answered 1 while every file looked renumbered. Checking the ancestor rather
   than the filenames is what caught it.

## Note on the issue id — #6478 is UNRESERVED

`node scripts/claim-issue.mjs --allocate` exited **6** (`open-PR id scan FAILED
… gh offline/unauthenticated`) every time it was run this session, so nothing
could be reserved. `--dry-run` previewed **#6474**, which was already in use by
an unreserved file on this branch — 6474–6477 were all taken that way, and all
four then collided with `main`. This slice therefore took the next id after
6477, **#6478**, per the S17 brief.

**That means #6478 carries exactly the same exposure the other four did**: it is
free on `main` and on the open-PR scan as of 2026-09-14, and nothing holds it.
The required `check:issue-ids:against-main` gate is the only backstop until
`--allocate` can reach the assignment book again; if it goes red on this id,
renumber here rather than anywhere else.
