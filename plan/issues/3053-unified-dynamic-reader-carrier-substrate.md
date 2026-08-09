---
id: 3053
title: "Unified dynamic-reader carrier substrate — one __dyn_member_get primitive under #3037 CS3 (identity) AND #2949 S5.4 (IR claim-rate)"
status: ready
model: fable
fable_role: spec
sprint: current
created: 2026-07-05
updated: 2026-07-17
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: analysis
area: standalone
language_feature: compiler-internals
goal: standalone-mode
related: [3037, 2949, 3027, 2719, 2734, 2175, 2580, 2896, 2186, 2947, 2855]
depends_on: [3037, 2949]
origin: "2026-07-05 — two independent investigations (opus-3037-cs1c CS3 readiness; opus-s5-4 S5.4 verdict) converged on the SAME root cause: the $Object dynamic reader returns a bare externref, tag-5-boxed downstream, losing BOTH object identity (#3037) AND typed-carrier information (#2949). This spec designs the ONE substrate that unblocks both, and gives the honest floor-safety verdict for the -299/-788 minefield."
---

# #3053 — unified dynamic-reader carrier substrate

**This is a substrate / strategy spec, not a single PR.** It designs a single
runtime primitive — a locals-free, carrier-uniform `__dyn_member_get(recv,key)`
that returns a proper tag-6 carrier for object payloads (strings stay tag-5) —
and shows how ONE helper serves BOTH remaining sprint levers:

1. **#3037 CS3** — the ~1,552-test object-identity keystone (#3027 driver). The
   CS1a→CS1b operand-scoped carrier hit its coverage ceiling (it fixes only
   DIRECT `any===any` operands). Every remaining gap is a reader/producer result
   carried as externref INTO an `any` slot (local / arg / return), dominantly the
   `assert.sameValue` harness comparator (any params, tag-5). The CS1b(iii)
   re-probe pinned the residual as the **UNIVERSAL-reader carrier = CS3 / V2-S3b**
   — the −299 minefield.
2. **#2949 S5.4/S5.P** — the IR claim-rate lever. opus-s5-4 traced S5.4 to a
   MISSING primitive: a locals-free, carrier-uniform `__dyn_member_get(recv,key)
   → carrier` that handles named + indexed reads without touching the caller's
   `fctx`/locals. With property-access blocked, S5.P's reachable flip set is
   near-empty (the reduce-style `obj[idx]===cur && obj[idx-1]===prev`
   conjunction needs property-access).

Verified against `upstream/main @ fa2e137e6` (V2-S3a landed; #3037 CS1a/CS1b/
CS1b(ii)/CS1b(iii) landed; #2580 M-series dyn-read + #2896 landed). Line/symbol
anchors are from that HEAD; re-grep if drifted.

---

## The convergence (why one spec serves two frontiers)

Both investigations independently bottomed out at the SAME instruction. Traced,
not narrative:

- `__extern_get` (`object-runtime.ts:1015-1168`) returns
  `extern.convert_any(e.value)` (`:1138`) — a **bare externref** of the stored
  property value's GC ref.
- `emitDynGet` (`dyn-read.ts:224`) / `__dyn_get` (`dyn-read.ts:144`) wrap it but
  **preserve the bare-externref carrier** (`dyn-read.ts:143`: "The result is a
  UNIFORM externref").
- Downstream, that externref is boxed by the **generic `boxToAny` externref arm**
  (`value-tags.ts:187-213`) → `__any_box_string` → **tag-5**. For a genuine GC
  object this is the identity-losing lie: two reads of the same object are both
  tag-5, and `__any_strict_eq`'s same-tag tag-5 arm (`any-helpers.ts:2431+`) is a
  string-content compare that returns **0** for objects.

So:
- **#3037 loses IDENTITY** because the object arrives at `===` boxed tag-5.
- **#2949 loses the TYPED CARRIER** because the reader hands the IR a bare
  externref, not a tagged `$AnyValue` the IR lattice can thread; and the one
  leaf helper (`emitDynGet`) breaks the pure-`Instr[]` handle contract
  (`dyn-read.ts:305-306` allocs caller locals; `:297` late-import-shifts the
  caller body — the #2043/#2078 mid-emit funcidx hazard).

**The unified fix is a single self-contained primitive** whose call site is a
bare `call` and whose result is the identity-preserving, tag-honest carrier both
frontiers need. Its floor-safety hinges on ONE architectural decision that all
three prior deaths violated: **the externref↔carrier round-trip lives INSIDE the
helper, never in a shared seam** (`emitAnyEqOperands` −299, the generic
`boxToAny` externref arm −788/−794, or `__any_to_extern`'s tag-6 arm — the
consumer-breadth mine).

---

## Ground truth: the four seams this spec must NOT touch (and why)

| Seam | Site | Regression on touch | Why load-bearing |
| --- | --- | --- | --- |
| generic `boxToAny` externref arm | `value-tags.ts:187-213` → `__any_box_string` | **−788 / −794** (`honestAnyBoxing` global flip) | the `assert.sameValue`/`isSameValue` harness comparator marshals ALL `any` operands through this arm and depends on main's tag-5 box-the-externref behaviour |
| `emitAnyEqOperands` (the `===` operand seam) | `coercion-engine.ts:454-467` (`coerceType(externref→$AnyValue)`) | **−299** (V2-S3b operand-site tag-6) | the harness comparison *is* an `===` over any operands; forcing tag-6 here re-breaks the harness tag-5 identity |
| `__any_to_extern` tag-6 arm | `any-helpers.ts:814-827` (`extern.convert_any` of the WHOLE box) | breaks EVERY dynamic member read (CS1a finding) | a `$AnyValue`-typed any-object local, coerced to externref for a re-read, hands `__extern_get` the wrapped box → `ref.test $Object` fails → null/0 |
| tag-5 same-tag arm | `any-helpers.ts:2431+` (`tag5*EqThen`) | **−162** (adding an object-identity `ref.eq` arm) | tag-5 is triple-overloaded (strings + `$BoxedNumber` + non-string GC); destructuring / generator-iterator lowering rely on its boxed-VALUE equality |

**The design rule that follows:** the new primitive must produce and consume its
carrier so that a migrated value NEVER traverses any of these four seams in a way
that changes their emitted bytes. Achieved by (a) doing the unwrap/rebox inside
the helper, and (b) leaning on the **landed S3a cross-tag arm**
(`any-helpers.ts:2302-2368`, standalone-gated) so any transitional tag-6×tag-5
pair of the same object still `ref.eq`s to 1 — partial migration **never
regresses, only under-fixes**.

---

## The unified primitive

```
;; standalone / gc carrier = (ref null $AnyValue); host carrier = externref
__dyn_member_get(recv: <carrier>, key: <carrier>) -> <carrier>
```

### Standalone / gc body (self-contained round-trip — the whole point)

```
__dyn_member_get(recv: (ref null $AnyValue), key: (ref null $AnyValue))
    -> (ref null $AnyValue):
  recvExt = __carrier_recv_to_extern(recv)   ;; INTERNAL unwrap — NOT global __any_to_extern
  keyExt  = __any_to_extern(key)             ;; existing; key is string/number → decimal
  resExt  = __extern_get(recvExt, keyExt)    ;; existing reader (proto-walk, accessors, .length)
  return  __any_from_extern_honest(resExt)   ;; honest box → tag-6 object / tag-5 string / tag-3,4 num,bool
```

The critical, DIFFERENT-from-`__any_to_extern` piece is the **internal receiver
unwrap** `__carrier_recv_to_extern` — a NEW leaf helper (or inlined body) that,
unlike the global `__any_to_extern`, PEELS the tag-6 payload:

```
__carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref:
  tag 6 → extern.convert_any(v.refval)     ;; the RAW $Object ref (field 3) — so __extern_get's ref.test $Object HITS
  tag 5 → v.externval                       ;; string externref (field 4)
  tag 3 → __box_number(v.f64)               ;; primitive receiver (rare: String/Number method)
  tag 4 → __box_boolean(v.i32)
  tag 2 → __box_number(f64.convert_i32_s(v.i32))
  tag 0/1 → ref.null.extern / undefined     ;; null/undefined receiver → __extern_get miss
```

This is exactly the tag-6 unwrap the global `__any_to_extern` **deliberately
does NOT do** (`any-helpers.ts:814-824` keeps tag-6 wrapped so an `any` boundary
round-trips through the generic classifier). Because the peel lives INSIDE the
substrate helper and its output feeds ONLY `__extern_get` (then is immediately
re-boxed honest), the global `__any_to_extern` seam — and every other consumer of
it — stays byte-identical. The round-trip is closed HONESTLY inside the helper
(`__any_from_extern_honest` re-tags the object tag-6), so re-reads compose:
`__dyn_member_get(__dyn_member_get(o,"a"),"z")` works without ever hitting the
`__any_to_extern` tag-6 breaker.

### `__any_from_extern_honest` is the settled classifier — reuse verbatim

The result boxing MUST use the FULL classifier `__any_from_extern_honest`
(`any-helpers.ts:378`, `{forceHonest:true}` → distinct-name sibling), NOT the
bare `fallbackStringAny` eq fragment. The ordering is the settled #3037 CS0/CS1b
probe (`any-helpers.ts:509-543`): `ref.test $AnyValue` passthrough →
`$BoxedNumber`→**tag-3** (`:510`) → `$BoxedBoolean`→**tag-4** (`:527`) → THEN
`fallbackStringAny` (`$AnyString`→**tag-5** `:444`, other-eq→**tag-6** `:460`).
The tag-3/tag-4 peel BEFORE the eq test is load-bearing: `__box_number_struct`
(`index.ts`) is a plain WasmGC struct → an `eq` subtype → a bare `ref.test (ref
eq)` would mis-route a boxed number to tag-6 and re-break numeric `===`. This
classifier is already on main (landed CS1b); `__dyn_member_get` reuses it — it
does NOT mint a second classifier.

### Host body (carrier = externref)

```
__dyn_member_get(recv: externref, key: externref) -> externref:
  return __extern_get(recv, key)   ;; host carrier IS externref; no box/unwrap
```

with the `.length` vec-dispatch / closure-arity / null-receiver arms currently in
`emitDynGet` (`dyn-read.ts:303-417`) moved INTO the helper's own frame (a defined
function allocates its OWN locals — the S5.4 blocker was that `emitDynGet`
allocated in the CALLER's `fctx`; here the call site is a bare `call`).

### Registration discipline (funcidx-shift-safe, locals-free at call site)

Registered up-front by a `preregisterDynamicSupport(ctx)` pass (idempotent, runs
BEFORE body compilation / funcidx settle — the same slot `ensureAnyHelpers` /
`ensureObjectRuntime` occupy), so the IR handle method stays a pure
`readonly Instr[]` `[call __dyn_member_get]` and the legacy call site is a bare
`call` with **zero** caller-frame locals and **zero** mid-emit late-import
shifting. This is what makes it BOTH a clean IR handle (S5.0–S5.3 body-only-shim
contract preserved) AND a clean legacy carrier.

---

## Micro-step ladder (each byte-inert-or-correct; each merge_group-floor-gated)

> **Every slice validates on the full `merge_group` +
> `check-standalone-highwater.mjs` + `scripts/prove-emit-identity.mjs` (the
> 39-hash corpus)** — never a scoped sweep. This is THE floor minefield
> (documented −162 / −299 / −788 / −794 / −7228). Each `ctx.standalone`-gated;
> host/gc off-path must stay byte-identical.

### U0 (M) — build the substrate helper (byte-inert, no call site)

Build `__dyn_member_get` + the internal `__carrier_recv_to_extern` unwrap +
absorb the `.length`/vec-index/closure/null-receiver dispatch + `ToPropertyKey`
into the helper body. Gate emission on a `ctx.usesDynMemberGet` latch that
**nothing sets in U0** (mirror `ensureDynReadHelpers`'s `ctx.usesDynRead` M0
gate, `dyn-read.ts:77`) + a `JS2WASM_FORCE_DYN_MEMBER_GET=1` self-test escape
(mirror `dyn-read.ts:76`). Registered via `preregisterDynamicSupport`.

- **Files:** `src/codegen/dyn-read.ts` (new `ensureDynMemberGet` + the two
  helper bodies, beside the existing `ensureDynReadHelpers`); wire
  `preregisterDynamicSupport` in the finalize/preregister pass in
  `object-runtime.ts` / `index.ts` next to `ensureObjectRuntime`.
- **Floor-risk: LOW.** An uncalled defined function is not import-pruned; the
  latch (not dead-elim) guarantees zero bytes for every module that never calls
  it. `prove-emit-identity` 39/39 IDENTICAL by construction.
- **Flip targets:** none yet (mechanism).
- **Anti-vacuity:** hand-built unit tests over `JS2WASM_FORCE_DYN_MEMBER_GET=1`
  asserting, on host AND standalone: (a) object read → tag-6, self-`===` via the
  carrier → 1, distinct → 0; (b) string read → tag-5, `typeof "string"`,
  content-eq; (c) number read → tag-3, `23===23.0`; (d) boolean → tag-4; (e) a
  **re-read** `__dyn_member_get(__dyn_member_get(o,"a"),"z")` returns the right
  value + tag (proves the internal unwrap round-trips — the CS1a `__any_to_extern`
  breaker is NOT re-triggered); (f) indexed `arr[0]` and dynamic-index
  `arr[i]`; (g) `.length` on array/string/closure matches `emitDynGet`. Contrast
  a deliberately-wrong tag to prove the assertions bite (no coincidental pass).

### U1 (M) — #2949 S5.4 consumer: route the IR member-read through the primitive

The thin-wiring S5.4 said was blocked, now unblocked. `IrDynamicLowering.
emitMemberGet()`/`emitElementGet()` → `[call __dyn_member_get]`;
`builder.emitDynMemberGet(recv,key) → dynamic`; the `from-ast`
`lowerPropertyAccess`/`lowerElementAccess` dynamic-receiver arm
(`from-ast.ts` ~L2200/L2579). Carrier in/out is the IR `dynamic` = `(ref null
$AnyValue)` gc/standalone, externref host — **no externref↔$AnyValue impedance at
the IR boundary** (the S5.4 carrier-impedance blocker, `2949` note 3, is
dissolved because the helper takes and returns the carrier directly).

- **Files:** `src/ir/lowering/handles.ts`, `integration.ts` (the
  `makeDynamicLowering` resolver — the pure `{body:[]}` shim now works because
  the op is a bare `call`), `builder.ts`, `from-ast.ts`.
- **Floor-risk: LOW–MED.** Byte-inert until S5.P opens the scan (the IR path is
  claim-gated); `prove-emit-identity` IDENTICAL. The only live change is that
  IR-claimed functions (a fixed, small set today) route member reads through the
  helper — validated by the `ir_first` lane (#2947).
- **Flip targets:** none yet (mechanism; the scan is still closed).
- **Anti-vacuity:** deferred to U2 per #2949 §4; unit tests execute
  `dyn.length`, `dyn[0]`, `dyn["k"]`, `dyn.p` over host + gc asserting value +
  tag preservation (the §S5.4 acceptance "value + tag preservation MUST be
  covered").

### U2 (L) — #2949 S5.P: open the IR scan for dynamic property-access (the claim-flip)

Relax `src/ir/select.ts` `dynamicUsesAreMoveOnly` (~L1178): accept a dyn receiver
in `isPropertyAccessExpression`/`isElementAccess` (result is dynamic → feeds
return / another dyn position), co-landed with the truthiness/eq/relational arms
per S5.P. **With property-access now available, the reduced-form-set caveat that
would have DEFERRED S5.P is lifted** — the reduce-style conjunction population
(`idx>0 && obj[idx]===cur && obj[idx-1]===prev`) becomes claimable.

- **Floor-risk: MED.** This is the real claim flip; measured per #2949 §4 (the
  ceiling + real-selector reachability probes, now on the FULL form set).
- **Flip targets (#2949):** `claimed` strictly increases; `param-/return-type-
  not-resolvable` drops by the claim increase and does NOT reappear as
  `body-shape-rejected`; `post-claim demotions == 0`. `check:ir-fallbacks`
  buckets `param-type-not-resolvable` / `return-type-not-resolvable` drop
  (`--update-on-decrease`).
- **Anti-vacuity:** #2949 §4 is MANDATORY — build S5.P only for a non-empty
  real-selector flip set. If the FULL-form-set probe is still empty, defer
  (documented), but the ceiling probe should now be non-empty precisely because
  property-access is the form the population needs.

### U3 (L) — #3037 CS3: the identity payoff (RIDES on U1/U2, not a separate legacy substrate)

**The honest architecture:** CS3's universal-identity flip is realized THROUGH
the IR carrier-uniformity of U1/U2, not through a bounded legacy patch. A function
the IR claims carries `any` locals/params/returns as `$AnyValue` uniformly, so
`x === y` inside it gets the **tag-6 same-tag `ref.eq` arm**
(`any-helpers.ts:2417-2430`) for free — with `emitAnyEqOperands` (−299) and the
generic arm (−788) UNTOUCHED (the operands arrive already `$AnyValue`, so
`emitAnyEqOperands`'s `isAnyValue` guard at `coercion-engine.ts:458/463` skips
the coercion seam entirely).

- **The CS3 KNOWN-GAP flip targets** (pinned at `0`, marked CS3-owned in
  `tests/issue-3037-cs1biii-descriptor-value-carrier.test.ts:179/191`):
  - `const v1: any = o.a; const v2: any = o.a; v1 === v2` → **flip to 1** when
    the enclosing function is IR-claimed (`any` locals carried `$AnyValue`,
    reads via `__dyn_member_get` tag-6, `===` via the tag-6 arm).
  - the descriptor `.value`-into-locals analogue → same.
- **The dominant CS3 gap — the `assert.sameValue` harness comparator** — flips
  IFF the IR claims the harness comparator (any params, `===` + `String()` +
  `typeof` + throw). If S5.P's forms cover the comparator body, CS3's ~1,552-test
  keystone moves as a SIDE EFFECT of the claim-rate work. **This is the
  convergence payoff: the same IR claim that raises #2949's number gives #3037
  its identity.**
- **Fallback if the IR does NOT claim the harness comparator** (U3b, scoped, MED):
  a harness-comparator-specific param-carrier migration — box object arguments as
  tag-6 `$AnyValue` at the CALL SITE and type `assert.sameValue`/`isSameValue`
  `any` params as `$AnyValue`, so the internal `===` sees tag-6 operands. This is
  a NARROW, single-callee carrier migration (NOT the global seam), safe via S3a
  for any un-migrated caller. Consumer-breadth inside the comparator (`String()`,
  `typeof`) is bounded and routes through existing `$AnyValue`-accepting helpers.
- **Floor-risk: LOW for the ride-on (U1/U2 already floor-gated); MED for U3b**
  (a real param-carrier ValType change on one callee family).
- **Flip targets:** the CS1b(iii) KNOWN-GAP rows; the #3037/#3027 identity
  cluster (~1,552 tests, the assert.sameValue-dominated tail).
- **Anti-vacuity:** the KNOWN-GAP test flips `0→1` under the claimed path AND a
  contrast test proves an UNCLAIMED function still under-fixes (0) rather than
  falsely passing; distinct-object anti-vacuity stays 0; string/number/boolean
  by-value invariants hold.

### U4 (L) — CS3 = V2-S3b reader-arm MOP, RE-ENABLED on the carrier (owned by the #2175 wave)

The `$NativeProto`/`$Object`/closed-shape step-3/4 reader arms across the 7
reader natives land as a CONSUMER of the substrate: because U1–U3 route reader
results through the tag-6-honest carrier, the reader arm needs **zero** `===`
change (the exact thing that killed the −299 attempt). Listed to make the
dependency explicit; owned by #2175 V2-S3b. Do not attempt before U1 lands.

**Order:** U0 → U1 → U2 (the #2949 claim-flip) → U3 (the #3037 identity ride-on,
+ U3b harness fallback if needed) → U4 (#2175 V2-S3b). U0 is the shared keystone;
BOTH frontiers stack on it.

---

## Which consumers break, and how each migrates (the consumer-breadth mine)

Making the reader return a `$AnyValue` carrier UNIVERSALLY (rather than a bare
externref) changes the read-result ValType → every consumer of a dyn read must
accept the new carrier. This is the mine that killed the naive "reader returns
tag-6 everywhere" approach (CS1a's finding: an `$AnyValue`-typed any-object local
breaks reads). The ladder defuses it by **NOT migrating all `any` locals** —
instead the carrier is uniform only WITHIN the boundary that already accepts it:

| Consumer of a dyn-read result | Legacy externref path (today) | Migrated `$AnyValue` path |
| --- | --- | --- |
| another dyn read (`o.a.z`) | externref → `__extern_get` | `__dyn_member_get` (unwraps tag-6 internally) — **self-composing** |
| `===` / `!==` | tag-5 (identity lost) | tag-6 same-tag arm (identity) — U3 |
| arithmetic (`+ - * /`) | `__any_to_f64` | `__any_to_f64` (unchanged; unboxes from box) |
| string concat (`+`) | `__any_add` | `__any_add` (tag-dispatched; unchanged) |
| `typeof` | tag-dispatched | tag-dispatched (unchanged) |
| method call (`o.m()`) | externref receiver | `__carrier_recv_to_extern` → externref (helper-internal) |
| host handoff | `__any_to_extern` (wraps) | `__any_to_extern` (unchanged — global seam untouched) |
| `Object.keys`/spread/`delete`/destructuring | externref | `__any_to_extern` → externref (unchanged) |

**The key safety property:** the ONLY consumer whose semantics CHANGE is `===`
(the intended fix, U3), and it changes only when BOTH operands are already
`$AnyValue` inside a carrier-uniform (IR-claimed) boundary. Every other consumer
either already accepts `$AnyValue` (arith/concat/typeof) or goes through the
helper-internal unwrap (reads/method-calls). The global `__any_to_extern` and the
generic `boxToAny` arm are **never** touched — that is why this path does not
re-detonate −788/−299.

**Why the migration is IR-scoped, not a legacy dataflow pass:** deciding WHICH
`any` locals to carry as `$AnyValue` (vs externref) is a whole-function dataflow
problem. Doing it in legacy would reimplement the IR's carrier lattice. The IR
(`#2949`) already tracks a value's `dynamic` carrier and threads it uniformly —
so the correct home for the carrier migration IS the IR claim (U1/U2). A bounded
legacy patch is offered ONLY for the single harness-comparator callee (U3b),
where the migration surface is one function, not the whole program.

---

## Edge cases

- **Native strings stay tag-5.** `__any_from_extern_honest` tests `ref.test
  $AnyString` FIRST (`any-helpers.ts:444`) — a string read stays tag-5, concat &
  content-`===` intact. NEVER a bare `ref.test $eq`.
- **`$BoxedNumber`/`$BoxedBoolean` carriers stay tag-3/tag-4.** The classifier
  peels them (`:510`/`:527`) BEFORE the eq test — settled by the CS0 probe
  (`__box_number_struct` is an `eq` subtype). Any carrier boxing MUST reuse the
  full classifier, never the eq fragment.
- **Accessor `.get` reads** (`__extern_get:1127-1131`) return a fresh computed
  value — NOT an identity-stable ref. `__dyn_member_get` boxes whatever the getter
  returns honest; identity of getter results is out of scope (spec-correct: a
  getter may return anything).
- **`null`/`undefined` receiver** → `__carrier_recv_to_extern` yields
  null/undefined extern → `__extern_get` miss → the singleton (S1 regime,
  `object-runtime.ts:1040`). No null-deref.
- **Typed-nominal-element vec** (`const a: any = [{z:1},{z:2}]`) — the
  `__extern_get_idx` #2186-class reader gap (CS1b(ii) known-limitation,
  `3037` §CS1b(ii)). `__dyn_member_get`'s indexed arm inherits it; out of scope
  here (does not occur in test262 pure-JS). File as a #2186 follow-up if the
  indexed-vec population needs it.
- **Host mode / gc lane byte-identity.** Every arm `ctx.standalone`/`ctx.wasi`
  gated; host `__extern_get` import path and `isSameValue` (#1888) untouched.
- **Transitional mixed pairs** (one operand migrated tag-6, one still tag-5) →
  S3a's cross-tag reconciliation arm (`any-helpers.ts:2302-2368`) → `ref.eq` → 1.
  Partial coverage never regresses.

## What this spec explicitly does NOT do

- Does NOT touch `emitAnyEqOperands` (−299), the generic `boxToAny` externref arm
  / `honestAnyBoxing` (−788/−794), the `__any_to_extern` tag-6 arm (the CS1a
  read-breaker), or the tag-5 same-tag arm (−162).
- Does NOT make the reader return tag-6 "universally" as a bare ValType flip —
  that IS the consumer-breadth mine; the carrier is uniform only within the
  IR-claimed (or single-callee U3b) boundary.
- Does NOT change host mode; no new host imports (`__dyn_member_get` host body is
  a thin `__extern_get` wrapper).
- Does NOT build a general user-object intern map (user objects ARE their GC ref;
  only synthesized objects need Option-A memoization, done in #3037 CS2).

---

## HONEST tractability verdict

**There IS a floor-safe, micro-stepped path — but the two frontiers do NOT get
equal, symmetric payoff from the same slice, and the CS3 identity flip is
DOWNSTREAM of the #2949 IR work, not parallel to it.** Precisely:

1. **U0 (the substrate helper) is unambiguously floor-safe and buildable.** It is
   byte-inert until called (latch-gated, like the #2580 M0 scaffold), does the
   externref↔carrier round-trip INSIDE itself, and touches none of the four
   forbidden seams. This is the clean shared keystone. **LOW risk.**

2. **#2949 S5.4/S5.P (U1/U2) gets a CLEAN, direct win.** U0 is exactly the
   locals-free, carrier-uniform, named+indexed primitive opus-s5-4 said S5.4 was
   blocked on. U1 is the thin wiring; U2 is the measured claim-flip (gated by
   #2949 §4 anti-vacuity). This unblocks the claim-rate lever with property-access
   in the form set. **LOW→MED risk, well-bounded.**

3. **#3037 CS3 (U3) is REAL but INDIRECT.** The universal-identity flip requires
   `any`-slot carriers to be `$AnyValue`-uniform — which is the consumer-breadth
   mine, tractable ONLY as the IR carrier work (U1/U2), NOT as a bounded legacy
   patch. So CS3's ~1,552-test keystone moves as a SIDE EFFECT of the IR claiming
   the identity-sensitive functions (dominantly the harness comparator). If the
   IR claims `assert.sameValue`, CS3 lands for free; if not, U3b is a scoped
   single-callee param-carrier fallback. **The honest caveat: the CS3 magnitude is
   CONTINGENT on the IR claim reaching the harness comparator** — a dependency on
   #2949's claim-rate growth, not a standalone guarantee.

4. **What would make CS3 tractable WITHOUT the IR:** a legacy whole-function
   `any`-carrier-selection pass (mark single-assignment `any` locals whose uses
   are all read-or-`===`, carry them `$AnyValue`, route reads through
   `__dyn_member_get`). This is a MED-L legacy analysis that DUPLICATES the IR
   lattice — **not recommended**; the IR is the right home. Documented as the
   alternative so the decision is explicit.

**Bottom line:** the substrate is NOT intractable — U0 is a clean, floor-safe,
byte-inert helper that both frontiers stack on, and it is the correct unblock for
BOTH the S5.4 blocker and the reader-arm MOP. The −299/−788 deaths are avoided by
keeping the round-trip inside the helper and leaning on S3a for partial coverage.
The one honest qualification is asymmetry: **#2949 gets a direct claim-flip; #3037
CS3 gets its identity flip as a downstream consequence of the IR carrier work
(U1/U2), realized fully only when the IR claims the harness comparator.** Build U0
first (it is pure upside, floor-safe, and unblocks the IR immediately); the CS3
magnitude then tracks the IR claim-rate. This is a "prerequisite-first" verdict:
U0 is the prerequisite; the CS3 keystone lands through the IR, not around it.

---

## Coordination / non-collision

- U0/U1 touch `src/codegen/dyn-read.ts` + `src/ir/**` — clear of #3037's
  `property-access.ts` operand-carrier work (CS1a/CS1b landed there) and clear of
  the #2949 S5.0–S5.3 mechanism slices. Confirmed by opus-s5-4's own collision
  note (`2949` §"Coordination with #3037 CS1b(ii)").
- U3/U3b touch the equality-consumer side and the harness call site — coordinate
  with the #2175 V2-S3b wave (U4) since both consume the carrier.
- The `__dyn_member_get` author should pair with the #2949 S5.4 owner
  (opus-s5-4's filed substrate dependency IS U0) and the #3037 CS3 owner.

---

## U0 — LANDED (byte-inert substrate helper)

**Author:** opus-u0-carrier. **Branch:** `issue-3053-u0-carrier-helper`.
**Risk realised: LOW** — byte-inert, zero emitted-byte change in every normal
compile (proven, see below).

### What shipped

- `src/codegen/dyn-read.ts` — new `ensureDynMemberGet(ctx)` registering, in
  gc/standalone (`ctx.standalone || ctx.wasi`):
  - `__carrier_recv_to_extern(v: (ref null $AnyValue)) -> externref` — the
    novel piece. It **PEELS** the carrier to the externref `__extern_get`
    needs: tag 6 → `extern.convert_any(v.refval)` (the RAW `$Object`, field 3,
    so `__extern_get`'s `ref.test $Object` HITS); tag 5 → `v.externval`
    (field 4); tag 3 → `__box_number(v.f64val)`; tag 4 →
    `__box_boolean(v.i32val)`; tag 2 → `__box_number(f64.convert_i32_s(...))`;
    tag 0/1/null → `ref.null.extern` (null/undefined receiver → miss). This is
    exactly the tag-6 unwrap the global `__any_to_extern` **deliberately does
    NOT do** (`any-helpers.ts:814-824` keeps tag-6 WRAPPED — the CS1a
    read-breaker). Because the peel lives INSIDE the helper and its output
    feeds ONLY `__extern_get`, the global `__any_to_extern` seam stays
    byte-identical.
  - `__dyn_member_get(recv, key) -> (ref null $AnyValue)` — the self-contained
    round-trip: `__carrier_recv_to_extern(recv)` → `__any_to_extern(key)` →
    `__extern_get` → `__any_from_extern_honest` (the settled #3037 CS1b
    classifier — tag-3/tag-4 peel BEFORE the eq test, then tag-5 string /
    tag-6 object; reused verbatim, NOT re-minted).
  - Host mode: `__dyn_member_get(recv,key) -> externref` = a thin
    `__extern_get(recv,key)` wrapper (carrier IS externref; no box/peel).
- Context latch `ctx.usesDynMemberGet` + idempotence latch
  `dynMemberGetHelpersEmitted` (`context/types.ts`, `create-context.ts`).
- `src/codegen/index.ts` — `ensureDynMemberGet(ctx)` wired at BOTH finalize
  points beside `ensureDynReadHelpers` (before dead-elim/freeze).

### Why floor-safe (the −162/−299/−788/−794 minefield, 3 prior deaths)

The helper touches NONE of the four forbidden seams: `emitAnyEqOperands`
(−299), the generic `boxToAny` externref arm / `honestAnyBoxing` (−788/−794),
`__any_to_extern`'s tag-6 wrap (CS1a read-breaker), the tag-5 same-tag arm
(−162). The externref↔carrier round-trip lives INSIDE the helper. **Verified
byte-inert:** `scripts/prove-emit-identity.mjs check` → **39/39 (file,target)
emits IDENTICAL** vs the pre-change base (`88f529d83`). Byte-inertness is
guaranteed by the `usesDynMemberGet` LATCH (nothing sets it in U0), not by
dead-elim — an uncalled DEFINED function is not import-pruned.

### funcidx-shift safety

Helpers are minted stable-handle (`mintDefinedFunc`); `eliminateDeadImports`
remaps live-import call immediates in all defined bodies (incl. finalize-minted)
and SKIPS stable handles — so the host body's baked `call __extern_get`
(a live import) is remapped, and standalone's stable-handle calls are immune.
No struct types registered at finalize (only `addFuncType`); the honest
classifier / `__any_to_extern` reuse struct types reserved during body comp.

### Self-test (anti-vacuity) — `JS2WASM_FORCE_DYN_MEMBER_GET=1`

`ensureDynMemberGet` under the FORCE escape also emits exported `__dmg_*`
drivers that build a receiver, call the helper, and return an i32 verdict
entirely in Wasm (a `(ref $AnyValue)` can't cross to JS). The drivers compare
via **direct carrier-field `ref.eq` / `f64.eq`** (not `__any_strict_eq`) so no
sealed coercion helper is invoked from `dyn-read.ts` — the #2108 coercion-drift
gate stays at 0. Covered by `tests/issue-3053-u0-dyn-member-get.test.ts` (12
assertions, all green):
- **standalone ($AnyValue carrier):** object read → **tag-6**; aliased reads ARE
  `===` (refval `ref.eq` → 1), distinct objects NOT (→ 0, assertions bite);
  string → **tag-5**, same stored ref via externval `ref.eq` → 1; number →
  **tag-3**, f64val `f64.eq` → 1; boolean → **tag-4**; RE-READ
  `dmg(dmg(o,"a"),"z")` → tag-3 value 7 (proves the internal peel round-trips —
  the `__any_to_extern` tag-6 breaker is NOT re-triggered).
- **gc/host (externref carrier):** the host object model is JS-side and box/
  marshal semantics are opaque, so the driver reports a marshalling-independent
  i32 — a present-key read through the host wrapper is a non-null externref (1),
  proving the host `__dyn_member_get` (thin `__extern_get` wrapper) is emitted,
  valid, and executes without trapping (deep host read semantics are
  `__extern_get`'s, tested elsewhere).

### U1 readiness — YES

U0 is exactly the locals-free, carrier-uniform, named-key primitive #2949 S5.4
was blocked on: the call site is a bare `call __dyn_member_get`, carrier in/out
is `(ref null $AnyValue)` (gc/standalone) / externref (host) with NO
externref↔$AnyValue impedance at the IR boundary. U1 wires
`IrDynamicLowering.emitMemberGet()`/`emitElementGet()` → `[call
__dyn_member_get]` and sets `ctx.usesDynMemberGet` at that call site (the latch
that makes this finalize pass emit the helper). The pure-`{body:[]}` IR shim
works because the op is a bare `call`. Deferred from U0 (scope): the host-mode
`.length`/vec-index/closure/null-receiver dispatch arms of `emitDynGet` — U0's
standalone body relies on native `__extern_get`, and the host body is the thin
`__extern_get` wrapper; the runtime-key-dispatched host `.length` arms are best
added in U1 against a real call site (they were not needed for the byte-inert
substrate and carry no floor risk deferred).

---

## U1 — LANDED (byte-inert-off-path IR member-read wiring)

**Author:** opus-u1-wire. **Branch:** `issue-3053-u1-ir-wire` (predecessor-
stacked on `issue-3053-u0-carrier-helper`). **Floor verdict realised:
BYTE-INERT-OFF-PATH** — the wiring exists but is UNREACHED in every claimed
function until S5.P (U2) opens the selector scan. Proven, see below.

### The floor-sensitivity determination (measure-first — the whole point)

The task's central question — does U1 change EMITTED code for any
currently-claimed function? — was settled **empirically against the U0 base**,
not by narrative:

- **The IR selector rejects every dynamic-receiver member read TODAY.** In
  `select.ts` `dynamicUsesAreMoveOnly` (~L1289–1296) a member/element access
  scans its receiver with `expectDyn = false` — a dynamic-name receiver returns
  `false` ⇒ the function is NOT claimed. And a chained/call-return intermediate
  dynamic (`o.a.b` where `o.a: any`) that would reach `lowerPropertyAccess` with
  a dynamic receiver hit the pre-U1 `throw` — a claim-then-demote the selector's
  phase-1 shape gate is precisely tuned to NEVER produce (a claim-then-demote is
  a HARD ERROR under `JS2WASM_IR_FIRST`). So the set of claimed functions with a
  dynamic member read is **empty**.
- **Probes** (host + standalone, `JS2WASM_IR_FIRST=1`): every dynamic-receiver
  shape (`p.x` on an any param; `x.p` on an any local; `o.a.b`/`o.a[0]`
  intermediate-dynamic; call-return `foo().b`) reported `irCompiledFuncs: []` on
  BOTH the U0 base and the U1 tree — never claimed, never emitted a
  `__dyn_member_get`. A concrete-numeric control claimed as expected.
- **`prove-emit-identity` = 39/39 (file,target) IDENTICAL** vs the U0 base
  (`91e556f`). The from-ast arm REPLACES the prior dynamic-receiver `throw`, but
  since that throw was unreachable-in-claimed-functions, so is the replacement —
  zero emitted-byte change. **`check:ir-fallbacks` all deltas 0** (no
  claim/fallback behaviour change; the selector is untouched).

**Verdict: byte-inert-off-path.** Self-merge safe; NO monitored floor enqueue
needed (there is no floor delta to measure). The floor-sensitive step is U2, when
the scan opens and these reads start emitting.

### What shipped (the thin wiring)

- **IR node `dyn.member_get{recv, key}`** (`src/ir/nodes.ts`) — both operands
  `dynamic` carriers, result `dynamic`; added to the `IrInstr` union + every
  exhaustive `instr.kind` switch (operands extractor, buffer/leaf `never`
  checks).
- **`builder.emitDynMemberGet(recv, key)`** (`src/ir/builder.ts`) — constructs
  the node; rejects a non-dynamic recv/key at construction (carrier-only). Uses
  `irDynamic()` result.
- **Verifier** (`src/ir/verify.ts`) — R-rule: recv, key, AND result must all be
  `dynamic`; the hard backstop behind the builder guard.
- **`lower.ts` arm** — `emitValue(recv)`, `emitValue(key)`, then the handle's
  member-get ops (the `__dyn_member_get(recv, key)` operand order); throws on a
  non-dynamic operand.
- **`IrDynamicLowering.emitMemberGet()` / `emitElementGet()`**
  (`backend/handles.ts` interface + `integration.ts` gc + host arms) — both
  return `[call __dyn_member_get]` (resolved BY NAME) and flip
  `ctx.usesDynMemberGet` (the latch U0's finalize `ensureDynMemberGet` reads).
- **`preregisterDynamicSupport`** (`integration.ts`) — detects `dyn.member_get`
  in the built IR (`isDynamicOp` + a new `usesDynMemberGet` scan), then
  `ctx.usesDynMemberGet = true; ensureDynMemberGet(ctx)` UP-FRONT (before Phase 3)
  so the emit-by-name resolves — the finalize `ensureDynMemberGet` runs AFTER
  Phase 3, too late. Registers only DEFINED funcs (no import shift), self-guards
  on missing object runtime, and is idempotent with the finalize pass.
- **from-ast dynamic-receiver arms** — `lowerPropertyAccess` boxes the property
  NAME as a tag-5 string carrier; `lowerElementAccess` boxes a string-literal key
  as tag-5 or lowers+boxes the index (`boxConcreteToDynamic`), then
  `builder.emitDynMemberGet`. These REPLACE the prior dynamic-receiver `throw`.
- **Effects** (`effects.ts`) — `dyn.member_get` is call-like (reads+writes heap):
  `__dyn_member_get` walks the proto chain and may fire a getter.
- **Tests** (`tests/issue-3053-u1-ir-member-read.test.ts`, 10 green) — node
  shape + construction guards + verifier backstops (non-dynamic recv/key/result
  all bite); handle routing in BOTH aligned strategies (standalone-gc emits the
  bare call to the registered `__dyn_member_get` + the gc peel helper is present;
  host emits the wrapper call, no peel; missing-registration throws a clear
  error); the latch re-flips on each emit; lower drives `[recv][key][call]` in
  order and rejects a concrete operand. Runtime value+tag preservation of the
  helper itself stays proven by U0's `issue-3053-u0-dyn-member-get.test.ts`.

### KNOWN GAP — carrier mode-split alignment is a U2 PREREQUISITE (must fix before opening the scan)

`makeDynamicLowering` / `resolveDynamic` select the carrier on **`ctx.fast`**
(`fast` ⇒ gc `$AnyValue`, else externref). U0's `ensureDynMemberGet` selects its
helper BODY on **`ctx.standalone || ctx.wasi`** (gc `$AnyValue` body vs the host
externref wrapper). `createCodegenContext` sets `ctx.fast = options.fast ?? false`
and does **NOT** derive `fast` from `standalone` — `compiler.ts` maps
`target:"standalone"` → `standalone:true` but passes `fast` through independently.
So the two splits agree only in a subset of configs:

| config (`fast` / `standalone|wasi`) | handle carrier | helper body | aligned? |
| --- | --- | --- | --- |
| fast + standalone/wasi | gc `$AnyValue` | gc `$AnyValue` | ✅ |
| default (neither) | externref | externref wrapper | ✅ |
| fast-only (host js-string playground) | gc `$AnyValue` | externref wrapper | ❌ |
| non-fast standalone/wasi | externref | gc `$AnyValue` | ❌ |

In the ❌ rows the emit would call `__dyn_member_get` with the wrong carrier ABI →
invalid Wasm. This is **harmless in U1** (byte-inert: no producer emits
`dyn.member_get`, so the mismatch is never realised — `prove-emit-identity`
39/39), but **U2 MUST first align the two mode splits** (make
`ensureDynMemberGet` key its carrier on `ctx.fast`, having first confirmed the gc
body's `__extern_get`/honest-classifier deps are valid — or gate the scan to the
aligned configs) BEFORE any function starts emitting the node. The U1 tests use
the two aligned configs (`{fast:true, standalone:true}` gc, `{}` host) only.

### U2 readiness — YES (with the alignment prerequisite above)

The mechanism is complete and byte-inert: builder → node → verifier → lower →
handle → `[call __dyn_member_get]` → finalize `ensureDynMemberGet`, plus the
from-ast producer arms. U2 is `src/ir/select.ts` `dynamicUsesAreMoveOnly`
(~L1289–1296): relax the member/element-access receiver from `expectDyn=false`
to accept a dynamic receiver (result → `dynamic`), co-landed with the S5.P
truthiness/eq/relational arms and gated by the #2949 §4 anti-vacuity probe — AND
the carrier mode-split alignment above. That is the measured, FLOOR-SENSITIVE
claim-flip; U1 deliberately leaves the scan closed.

## U2 — LANDED (the claim-flip: scan opened for dynamic member/element reads)

**Author:** opus-u2-flip. **Branch:** `issue-3053-u2-claim-flip` (from
`upstream/main` with U0+U1 merged). **Floor verdict realised: BYTE-INERT on the
prove-emit corpus; claim-delta ~0 on the measured population (honest per §4).**

### 1. Carrier mode-split alignment (the mandatory U2 prerequisite) — FIXED

`ensureDynMemberGet` now keys its body on **`ctx.fast`**, the SAME predicate
`resolveDynamic` / `makeDynamicLowering` (`integration.ts`) use for the carrier
ValType. Previously the body keyed on `ctx.standalone || ctx.wasi`, which
DISAGREED with the carrier in two configs (the KNOWN-GAP table). Empirically
verified across the full `{fast} × {standalone|wasi|host}` matrix — every config
that CLAIMS now emits a **VALID, carrier-aligned** module:

| config (`fast` / `standalone|wasi`) | carrier (`ctx.fast`) | body (now `ctx.fast`) | claims + valid |
| --- | --- | --- | --- |
| fast + standalone/wasi | gc `$AnyValue` | gc `$AnyValue` | ✅ |
| default host (neither) | externref | externref wrapper | ✅ |
| **non-fast standalone/wasi** (prove-emit `standalone`/`wasi` targets, `fast:undefined`) | externref | **externref wrapper** (was gc — the bug) | ✅ FIXED |
| **fast host-js-string** (`fast && !standalone`) | gc `$AnyValue` | gc `$AnyValue` | ⛔ **gated OFF** (see §2) |

The critical realisation: **prove-emit-identity's `standalone`/`wasi` targets run
with `fast:undefined` (=false)**, so they are the `!fast && standalone` config —
which the old keying mishandled (gc body vs externref carrier ⇒ invalid Wasm the
moment a read emits). Aligning on `ctx.fast` makes the non-fast standalone/wasi
targets use the externref host-wrapper body (calling native `__extern_get`),
matching their externref carrier. Confirmed valid + behaviourally correct.

### 2. Fast host-js-string is UNSOUND for the gc body — clean pre-claim gate

In `fast && !standalone && !wasi` the carrier is gc `$AnyValue` yet strings are
host js-string externrefs, so the native honest classifier (`$AnyString`-shaped)
mis-tags reads → **forcing the gc body to build there produced an INVALID
module**. Rather than rely on the benign IR-demote (a wasteful claim-then-demote,
gate-6-absorbed but fragile), U2 adds a config-aware selector capability
`IrSelectionOptions.dynMemberReadBuildable` (set from `ctx` at
`codegen/index.ts`: `!(ctx.fast && !ctx.standalone && !ctx.wasi)`). When false the
`dynamicUsesAreMoveOnly` member/element arms give a **clean pre-claim rejection**
(function keeps its `param-/return-type-not-resolvable` bucket) — never a
claim-then-demote. `check:ir-fallbacks` (default-host compile = sound) is
unaffected (default `true`).

### 3. The scan opening (`select.ts` `dynamicUsesAreMoveOnly`)

- `isDynShaped` extended to recognise member/element reads off a dyn-producing
  receiver (`dyn.a`, `dyn[i]`, chains `dyn.a.b`) — so the receiver classifier and
  the alias tracker (`const y = o.x`) both see the dynamic result.
- **Property access** `dyn.name`: accepted in a dyn-wanted position (`expectDyn`);
  from-ast always boxes the named key, so no key-shape gate (1:1 with the
  producer).
- **Element access** `dyn[key]`: accepted ONLY for the key shapes from-ast
  produces a non-null carrier for — **string-literal / numeric-literal / dynamic
  index**. Any other index (bare i32, dynamic arithmetic `idx-1`) stays rejected,
  because from-ast would demote (the JS2WASM_IR_FIRST skipped-slot contract).
- Result is `dynamic`, so it flows only to a dyn-accepting position; a member
  read into a concrete position (`o.x + 1`) still rejects.

### 4. Anti-vacuity measurement (§4) — HONEST: claim-delta ~0 on the corpus

Real-`compile()` claim sweeps (production `irCompiledFuncs`, default-host = sound
config):

| corpus | baseline (U1, scan closed) | U2 (scan open) | Δ claims | post-claim demotions |
| --- | --- | --- | --- | --- |
| playground examples + test262/language stride-150 (159 files) | 6 | 6 | **0** | 0 |
| `check:ir-fallbacks` playground gate | (baseline) | unchanged, all buckets Δ0 | **0** | 0 |
| `prove-emit-identity` (39 (file,target), gc/standalone/wasi) | — | **IDENTICAL 39/39** | — | — |

**Verdict — property-access-alone is corpus-vacuous, exactly as §4/§5 and the s4
/ S5.4 investigations predicted.** The reachable test262 population (reduce-style
`callbackfn`: `idx>0 && obj[idx]===cur && obj[idx-1]===prev`) needs a CONJUNCTION
of forms — relational + eq + element-access **and dynamic arithmetic** (`idx-1`)
— not property-access alone. Even the full S5.P form set (eq + relational +
truthiness + access) would not claim `callbackfn` (the `idx-1` dynamic-arith
index has no producer). So the corpus claim-delta is ~0 today; it grows only as
the co-requisite forms (S5.P eq/relational/truthiness) AND dynamic arithmetic AND
the #1370/#2855 body-shape surface land.

**But the mechanism is proven NON-VACUOUS in unit tests** (`issue-3053-u2-claim-
flip.test.ts`, 19 green): `return o.x`, `return o[i]`, `return o[0]`,
`return o["k"]`, `const y=o.x;return y`, chained `o.a.b`, and member-read →
dyn-param-call ALL claim, build valid Wasm in every sound config, and RUN
correctly (value + string/number by content). **Object IDENTITY is preserved
through the carrier** — `fwd(outer) === outer.x` holds (the #3037 CS3 ride-on
works for any function that DOES claim a member read).

### 5. Floor expectation

**Byte-inert on the prove-emit corpus (39/39 IDENTICAL) ⇒ cannot regress the
standalone floor.** No corpus/test262-sample function claims a new member read,
so `usesDynMemberGet` is never set and the carrier-alignment change is never
realised there. The only behavioural change is for the (currently ~0 on the
sample) test262 functions that DO claim a dynamic member read — and those emit
valid, identity-preserving code (unit-proven). Expected merge_group floor delta:
**~0 (byte-inert), NET ≥ 0** (any claimed member-read gains #3037 identity via the
tag-6 carrier; none loses correctness). Not the −162/−299/−788/−794 seams — none
touched.

### 6. U3 (#3037 CS3 identity) reachability THROUGH this IR claim — YES, mechanically

The carrier is now uniform: a function the IR claims carries `any` reads as the
tag-honest `$AnyValue` (tag-6 objects), and `fwd(o)===o.x`-style identity holds
through `__dyn_member_get` (proven in the U2 runtime test). So U3's identity
payoff is reachable through U1/U2 for any claimed function — **contingent on the
IR CLAIMING the identity-sensitive function** (dominantly the `assert.sameValue`
harness comparator). Per the §4 measurement, that claim does NOT happen yet on the
corpus: the comparator body uses forms beyond property-access (eq + `String()` +
`typeof` + throw + arithmetic). So CS3's magnitude remains **contingent on the
co-requisite S5.P forms landing** (the honest asymmetry §"HONEST tractability
verdict" already flagged). U2 delivers the substrate + the carrier alignment + the
identity mechanism; the CS3 keystone lands when the IR claim reaches the
comparator.

### Follow-ups (to make the corpus claim-delta non-vacuous)

1. **S5.P eq/relational/truthiness scan arms** (co-land, mirroring the from-ast
   `tryLowerDynamicEq`/`tryLowerDynamicRelational`/`emitDynTruthy` producers that
   already exist) — the conjunction the reachable population needs.
2. **Dynamic arithmetic** (`dyn - 1`, `dyn + 1`) — the missing producer for
   `obj[idx-1]`-style reduce bodies (new #2949 slice).
3. **#1370/#2855 body-shape widening** — the other half of the claim ceiling.
