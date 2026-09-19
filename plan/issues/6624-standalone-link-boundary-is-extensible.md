---
id: 6624
title: "standalone: `Object.isExtensible(<provider-owned value>)` answers `false` across the wasm<->wasm link boundary (class object AND instance), blocking every `built-ins/Temporal/*/builtin.js` first assertion"
status: done
sprint: current
priority: high
horizon: s
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/sendev-s37
loc-budget-allow:
  # 2026-09-17 (S37) — `object-runtime-descriptors.ts` grows 5 LOC: one new
  # optional field on `ObjectDescriptorHelperState`, its destructure, and its
  # forward into `buildObjectIntegrityPredicates`'s call. Not a new mechanism
  # in this file — it is the pass-through leg of a boundary-terminal wire
  # whose actual logic lives in `object-integrity-carrier.ts` and
  # `standalone-link-boundary.ts`.
  - src/codegen/object-runtime-descriptors.ts
func-budget-allow:
  # 2026-09-17 (S37) — `buildObjectDescriptorHelpers` grows 2 lines (the new
  # `peerIsExtensibleIdx` destructure line plus its one-line forward into the
  # `buildObjectIntegrityPredicates(...)` call it already makes). Splitting
  # this function is out of scope for a two-line wiring change to an
  # already-over-budget barrel (#3399/#3400 apply repo-wide, not introduced
  # here).
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
---

# #6624 — `Object.isExtensible` across the standalone wasm<->wasm link boundary

## Problem

`Object.isExtensible(Temporal.PlainDate)` — the FIRST assertion in every
`built-ins/Temporal/*/builtin.js` test262 file — answers `false` under
`--target standalone` with a linked provider, where the spec requires `true`
("Unless specified otherwise, the [[Extensible]] internal slot of a built-in
object initially has the value `true`."). Measured directly against the real
`@js-temporal/polyfill` provider (fresh cache,
`test262/test/built-ins/Temporal/PlainDate/builtin.js`):

```
Test262Error: Built-in objects must be extensible.
Expected SameValue(«false», «true») to be true
  at L17: assert.sameValue(Object.isExtensible(Temporal.PlainDate),
```

This blocks all 129 `built-ins/Temporal/**/builtin.js` files from progressing
past their first assertion — 9 of the 129 fail at exactly this line (the
other 120 already pass a different way, e.g. a plain-function export with no
class-object receiver at all).

## Root cause

`Object.isExtensible(v)` on an `any`-typed `v` compiles to the general
(non-`_obj`) `__object_isExtensible` native
(`src/codegen/object-integrity-carrier.ts`). That native decides object-ness
by CARRIER, not by static type: `registerIntegrityBagResolver`'s
`__integrity_bag` recognises exactly four carrier kinds — vec, closure,
error, and the #4194 instance-expando carrier — via `ref.test` chains built
from types the CONSUMER module itself registered (e.g.
`collectClosureBaseWrapperTypeIdxs`, `closure-classifier.ts`). A value the
PROVIDER minted — its class-object struct, or an instance of one of its
classes — is a CLOSED struct in the provider's own type space. Unless it
happens to be structurally identical to something the consumer ALSO
declares (pure accident), none of the consumer's four carrier ladders
recognise it, the bag lookup returns `ref.null.extern`, and the native falls
to its non-object terminal (`i32.const 0` = `false`) — wrong for a value that
genuinely IS extensible.

### Reduction (2026-09-17), in the required order

1. **Single module, no link.** `class C {}; Object.isExtensible(C)` — does
   **NOT** reproduce (`true`). The oracle statically proves `C` callable
   (`ctx.oracle.staticJsTypeOf` → `"function"`), so `provenJsObject` routes
   the call to the `_obj` predicate variant, whose terminal is already
   `true`.
2. **Single module, no link, `any`-typed indirection.**
   `function identity(x: any): any { return x; } const D: any = identity(C);
   Object.isExtensible(D)` — still does **NOT** reproduce (`true`). `C` is
   the CONSUMER's OWN class, so it is already in the CONSUMER's OWN
   `collectClosureBaseWrapperTypeIdxs` list, and the carrier bag recognises
   it regardless of the static type at THIS call site.
3. **Synthetic linked pair.** A tiny provider package (`class PD { static
   compare(){} m(){} }`, exported through a frozen namespace) linked into a
   consumer, `Object.isExtensible(NS.PD)` — reproduces cleanly: `false` on
   base. `Object.isExtensible(new NS.PD())` (a provider-owned INSTANCE, same
   terminal) also answers `false` on base — a second, distinct receiver hit
   by the exact same miss path.
4. **Real `@js-temporal/polyfill`.** Confirmed above — `PlainDate`'s
   `builtin.js` fails at exactly this assertion on base, and (corpus-wide,
   129 files) so do `Duration`, `Instant`, `Now`, `PlainDateTime`,
   `PlainMonthDay`, `PlainTime`, `PlainYearMonth`, `ZonedDateTime` — 9 files
   total, one per top-level Temporal export that is a class/namespace object
   reached directly (the other 120 `builtin.js` files test a different
   member shape that doesn't hit this receiver kind).

### Which of the S37 brief's two hypotheses

Hypothesis (a) — a missing arm in the `__isExtensible` native's ladder,
fixed with a class-object arm plus a link-boundary terminal — is the correct
mechanism. Hypothesis (b) (one of #6620's 7 unaudited bare `ref.test
$__ta_ctor` sites misclassifying the receiver) does not apply here:
`ta-dyn-mop.ts`'s arms gate `__extern_get`'s dynamic MEMBER-READ path, a
completely separate native from `__object_isExtensible`'s carrier-bag
ladder, and this defect reproduces with no TypedArray-shaped construct
anywhere in either module.

## The fix

A new wasm<->wasm link-boundary terminal, `__js2wasm_link_is_extensible`
(`src/codegen/standalone-link-boundary.ts`), the exact same shape as #6617's
`getPrototypeOf` terminal:

- **Export name**: added to `LINK_BOUNDARY_EXPORTS` and the `TERMINALS`
  table (`params: [externref]`, `results: [i32]`).
- **Provider side** (`emitStandaloneLinkBoundaryTerminals`): a direct forward
  to the provider's OWN `__object_isExtensible` — already correct FOR THE
  PROVIDER, since the value in question is native to the provider's own
  carrier ladders (verified: the same synthetic provider answers `true` for
  its own `PD`/`new PD()` when queried from WITHIN the provider). Simpler
  than `callableKind`/`getPrototypeOf`'s reserve-then-fill-at-finalize
  two-step, because `__object_isExtensible` already has a body by the time
  `emitStandaloneLinkBoundaryTerminals` runs (`buildObjectDescriptorHelpers`
  registers it earlier in `ensureObjectRuntime`). A module with no
  `__object_isExtensible` (host mode; never the case for a standalone
  provider) keeps the `0` refusal, matching the pre-fix consumer answer
  exactly.
- **Consumer side**: `standaloneLinkBoundaryPeerIndices` imports the new
  terminal alongside the existing five and returns its funcIdx
  (`isExtensible`). `buildIntegrityPredicate`
  (`object-integrity-carrier.ts`) gains an optional `peerFallbackIdx`
  parameter; when present, it replaces the bare `i32.const terminalResult`
  instruction at BOTH of the predicate's terminal sites (the
  `integrityBagIdx === undefined` arm and the carrier-bag-miss `else` arm)
  with `local.get 0; call peerFallbackIdx`. `buildObjectIntegrityPredicates`
  threads a new `peerIsExtensibleIdx` argument through to exactly ONE `emit`
  call — `__object_isExtensible` — leaving `isFrozen`/`isSealed` (no
  reported defect, no boundary terminal) byte-identical.
- The new `peerIsExtensibleIdx` is plumbed consumer-side from
  `standaloneLinkBoundaryPeerIndices(ctx)` (already called in
  `ensureObjectRuntime`, pre-freeze) through `ObjectDescriptorHelperState`
  (`object-runtime-descriptors.ts`) into `buildObjectDescriptorHelpers`'s
  call into `buildObjectIntegrityPredicates`.

This is answer-preserving in the same sense as every other boundary
terminal in this file: the provider's own ladder, worst case, reproduces the
SAME `0`/`false` the consumer's own terminal would have produced (a
receiver neither module recognises), and best case correctly answers `true`
for a value the provider's own carrier ladder DOES recognise — it can only
ever remove a false negative, never introduce a false positive.

### Bonus scope: instances, not just class objects

The fix lands at the SAME terminal both a class-object miss and an
instance-carrier miss fall through to, so `Object.isExtensible(new
NS.PD())` — a provider-owned INSTANCE — is fixed by the identical change,
not a separate mechanism. This is a strict improvement beyond the assigned
"class object" scope and is covered by its own witness `it` in the test
file below.

## Result

**Corpus-wide, all 129 `built-ins/Temporal/**/builtin.js` files**, fresh
cache per label (`.tmp/s37/builtinrun.mts`, file-copy revert of the four
changed files): **120/129 pass on BOTH labels, 0 flips.** Of the 9 failing
files, **all 9 move past the `isExtensible` assertion** — the failure
signature changes uniformly from `Built-in objects must be extensible.
Expected SameValue(«false», «true»)` to a LATER assertion (mostly `prototype
Expected SameValue(«null», «[object Function]»)` — the already-documented
`Object.getPrototypeOf(<class value>)` residual from S22/#6609, "identical
(residual)" in that slice's own table; `Now`'s file moves to a DIFFERENT
later assertion, `Object.prototype.toString` — `Now` is a namespace object,
not a class, so it has no `getPrototypeOf` residual to hit next). Full
per-file diff:

| file | base (line 17) | branch (line 17) |
| --- | --- | --- |
| `Duration/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `Instant/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `Now/builtin.js` | isExtensible SameValue(«false»,«true») | toString SameValue(«"[object Object]"»,«"[object Temporal.Now]"») |
| `PlainDate/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `PlainDateTime/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `PlainMonthDay/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `PlainTime/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `PlainYearMonth/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |
| `ZonedDateTime/builtin.js` | isExtensible SameValue(«false»,«true») | prototype SameValue(«null»,«[object Function]») |

0 rows became `error`. 0 previously-passing rows regressed.

**Four-family acceptance sample** (`PlainDate`, `Duration`,
`ZonedDateTime/prototype`, `PlainDateTime`, first 120 files each,
`--target standalone`, linked, fresh cache per label,
`.tmp/s36/famrun.mts`): **430/480 both labels** (111/104/112/103), **0
pass→fail, 0 fail→pass, 0 per-file flips** — an honest null for this
sample, exactly as S33/S36 measured for their own slices: none of these
four families' first 120 files is a `builtin.js` file (the 9 moved rows
above live at the FAMILY ROOT, not inside `prototype/`), so the sample and
the corpus-wide `builtin.js` measurement are deliberately disjoint and both
needed.

**Provider bytes**: base 3,311,638 B → branch 3,311,710 B (+72 B — the new
terminal's own body plus the forward call, minted once during the
provider's own `--target standalone` compile). **Corpus byte A/B**: 42
modules × {gc, standalone} = 84 artifacts, unaffected by this change (the
new code path is gated on `ctx.standalone` throughout and on a linked
provider being present; the gc-target equivalence corpus never links a
provider).

**Equivalence gate**: `npm run -s test:equivalence:gate` — 22 failing / 1,720
passing / 22 known-failures, unchanged from baseline. This fix touches only
the standalone `__object_isExtensible` non-`_obj` variant and a new
standalone-only link-boundary terminal; neither is reachable from the
gc-target corpus.

**Must-not-move** (group C per the S37 brief: `built-ins/Object/isExtensible/**`
+ `built-ins/Object/preventExtensions/**` + `built-ins/Object/freeze/**` +
`built-ins/Reflect/isExtensible/**` + `built-ins/TypedArrayConstructors/ctors/**`
first 60 + `language/statements/class/**` first 100 — plus groups A and B):
0 flips. These groups exercise the SAME natives (`__object_isExtensible`,
`__object_isExtensible_obj`) on LOCAL, non-linked receivers, which never
reach the new `peerFallbackIdx` arm (it is `undefined` whenever
`standaloneLinkBoundaryPeerIndices` returns no linked namespace) — verified
byte-identical bodies for every predicate except the one intentionally
changed.

## Witness

`tests/issue-6624-standalone-link-boundary-isextensible.test.ts` — 5 `it`s,
all SYNTHETIC (a tiny hand-written `PD` class package, not the real
`@js-temporal/polyfill`, per the "never compile the real polyfill inside
vitest" rule). Measured by file-copy revert of the four changed files
(2026-09-17):

- **Fix-witness 1** (class object): base `false` → branch `true`.
- **Fix-witness 2** (instance, same terminal): base `false` → branch `true`.
- **Control 1** (linked FUNCTION value): `false` on BOTH trees — a separate,
  pre-existing gap this issue does not touch.
- **Control 2** (local, non-linked plain object): `true` on BOTH trees.
- **Control 3** (local, non-linked class object through an `any`-typed
  indirection): `true` on BOTH trees — confirms the consumer's OWN class
  stays correctly classified via its OWN carrier ladder, unaffected by the
  new peer-fallback arm.

Full suite run alongside the other 21 `tests/issue-66*.test.ts` files (117 +
this file's 5 = 122 tests) passes together.

## Residuals — sized, not fixed

- **`Object.getPrototypeOf(<linked class value>)` still answers `null`**,
  not `Function.prototype` — the NEXT assertion 8 of these 9 `builtin.js`
  files now stop on. Already documented: S22/#6609's own table names this
  exact case "residual" (`gPO(Temporal.PlainDate) === Function.prototype
  (class value) | false | identical (residual)`), and S36's §4 residual
  covers the sibling dynamic-method-call-result case. Not re-filed here;
  same standing gap, now the visible blocker for one more file family.
- **`Object.prototype.toString.call(Temporal.Now)` answers
  `"[object Object]"`**, not `"[object Temporal.Now]"` — `Now` is a
  namespace object (not a class or function), so it takes a different path
  through the §20.1.3.6 classifier than the class-shaped members this
  slice's fix and its siblings (#6609/#6617/#6620) target. A distinct,
  unreduced mechanism; out of this slice's scope.

## Traps, carried forward and added to

Everything in S26–S36 still holds (see #5383's "S36 findings" and #6623's
own "Traps" section). One addition:

- **The SAME "ask the owner" boundary-terminal shape (#6617's
  `getPrototypeOf`) generalises cleanly to a SECOND predicate
  (`isExtensible`) with no new architecture** — only a new export name, a
  `TERMINALS` entry, a reserve-or-forward block, and one new optional
  parameter threaded through an existing predicate builder. When a
  `__object_*` general (non-`_obj`) native's terminal is a bare constant on
  a carrier-bag miss, that terminal is a strong prior candidate for the SAME
  pattern — check whether the miss is a genuinely non-object receiver
  (terminal stays a constant) or a foreign-but-real provider value (terminal
  should ask the peer) before assuming a constant answer is correct across a
  link.
