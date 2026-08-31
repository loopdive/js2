---
id: 5242
title: "A compiled class reached as a VALUE has no constructor bridge — 'compiled class constructor Duration bridge unavailable'; Temporal add/subtract construct Duration dynamically and throw"
status: done
completed: 2026-08-31
assignee: ttraenkler/senior-dev
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5242 — dynamic class-value construction has no constructor bridge

## Problem

After #5241 (PR #5350) un-hijacked the method calls, Temporal arithmetic now
reaches the polyfill and fails one level deeper:
`Temporal.PlainDate.from("2020-03-04").subtract({days: 1})` (and
`.add("P1D")`) throws `TypeError: compiled class constructor Duration bridge
unavailable` — in the SINGLE-MODULE lane, so it is not a provider-seam
defect. The polyfill constructs `Duration` through a class VALUE (its
intrinsics registry, `new (ce("%Temporal.Duration%"))(…)`), and a compiled
class reached as a value has no CONSTRUCTOR bridge: #5239 fixed the
`Object.create(value.prototype)` instance-minting path, but `new value(…)` /
Reflect-style construction through the host still finds no
`__class_construct_*`-equivalent export.

## Direction

Adjacent to #5239 (same registry-variable spelling, construct path instead
of create path). Reduce with a plain class reached via a registry object:
`const K = reg.K; new K(1,2)` through the host / dynamic lane. Emit or route
a constructor bridge the way #5239's `__object_create_class_instance` matches
prototypes — likely match the class-value mirror to its `struct.new` ctor by
identity, host-side `_construct`/callable-mirror arm in `src/runtime.ts` +
emission next to `emitClassMemberKindExports`. Mind the init-window channel
(#5202) — the polyfill constructs during module init.

## Acceptance criteria

1. Plain-class reduction: `new (reg.K)(…)` constructs a real instance
   (fields, methods, getters) — single-module and linked lanes; new
   `tests/issue-5242-*.test.ts` failing on base with a passing
   direct-identifier control.
2. `Temporal.PlainDate.from("2020-03-04").subtract({days: 1}).toString()` →
   `"2020-03-03"` single-module (provider lane may stay blocked by #5225's
   consumer-literal argument — measure and report per lane). Update harness
   KNOWN_GAPS accordingly.
3. No regressions in issue-5239/5241/5237/5223/5221/4628 + linker family;
   equivalence gate at baseline. Gates green.

## Notes

- Found by dev-5241 (PR #5350 "Reported, NOT fixed"); `subtract` fails
  identically on its base, so pre-existing. Sibling of #5239.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Implementation notes (2026-08-31)

### Root cause — TWO defects behind one message

The filed hypothesis ("no `__class_construct_*`-equivalent export exists") was
right about the fix and incomplete about the cause. `compiled class constructor
<Name> bridge unavailable` was reachable two independent ways, and both had to
be closed before Temporal's `Duration` could be constructed:

1. **The mirror froze a stale export view.**
   `_makeClassCtorMirrorForHost` built `callbackState = { getExports: () =>
   exports }` from the `exports` argument of the crossing that first minted the
   mirror, and the mirror is then cached in `_hostProxyCache` for the life of
   the module. For a class declared at top level that first crossing happens
   inside the wasm `start` section, where the only view available is the
   partial #5202 start-export registry (or nothing at all). Frozen, that view
   contains no `__call_fn_*` for the constructor — so a `new` on the class
   value threw for the module's whole run, long after the real exports existed.
   Measured: the frozen view had 19 entries where the live one has 59.

2. **The only route back into Wasm topped out at arity 4.**
   The mirror dispatched through `_wrapWasmClosureUnknownArity`, whose
   free-function arm uses `__call_fn_<N>` for N ≤ 4 and is emitted at all only
   when the module needs generic closure dispatch for some other reason.
   `Duration`'s constructor takes TEN parameters. Worse, `__call_fn_4` returns
   **null** for an unmatched closure rather than failing, and the mirror's
   `[[Construct]]` arm degrades a non-object result to `{}` — so once (1) was
   fixed in isolation the error simply changed to `Missing internal slot
   slot-years` from inside the polyfill, several frames away from the cause.

### What was built

- `src/codegen/class-value-construct.ts` — `__class_construct_<Class>_<arity>`,
  ABI `(externref × arity) -> externref`, calling `<Class>_new` with the same
  per-parameter coercion and result boxing the #5204 externref-backed METHOD
  bridges use. One export per class; the arity is in the name because there is
  exactly one constructor per class, so no metadata export is needed.
- Gate: `ctx.classCtorHostRegistered`, populated where
  `__register_class_ctor` is actually emitted (`expressions/extern.ts`). A
  module that never lets a class escape as a value emits identical bytes.
- The export joins the #5202 start-export channel
  (`CLASS_CONSTRUCT_EXPORT_PREFIXES`), so construction DURING module init
  works. This is not a nicety: on base the init-window construct throws inside
  `WebAssembly.instantiate` itself, i.e. the program never starts.
- Runtime: `_classCtorCallbackStates` records the LIVE export source per class
  object at registration; the mirror prefers it over its snapshot (the snapshot
  still answers during init, so init-window behaviour is unchanged).
  `_resolveClassConstructBridge` resolves and caches the bridge per export view.

### Second cut — the bridge must publish `__argc` (2026-08-31, found by dev-5243)

The first cut of the bridge was silently wrong for any constructor with
DEFAULT parameters, which is Temporal's `Duration` and most of the polyfill.

`<Class>_new` distinguishes an omitted argument from an explicit `undefined`
through the mutable module global `__argc` (`-1` = "caller unknown"), written
by each compiled call site and consumed once in the callee prologue
(`cacheParamDefaultArgc`). A fixed-arity bridge has to pad, so without that
count the callee cannot tell padding from a real argument — and because
`__argc` is a GLOBAL, "not writing it" does not mean "no defaults", it means
**whatever the previously compiled call site left there**. Two unrelated-looking
symptoms, one omission, both silent:

| stale `__argc` | effect | observed |
| --- | --- | --- |
| `-1` | nothing defaults; padding arrives as `undefined` → NaN | `new Defaulted(11,12)` → `11,12,NaN,NaN,NaN,NaN` |
| small count `n` | `argc !== -1 && argc <= i` fires for every param past `n`; the REAL arguments are discarded for the initializers | `new Duration(11,…,20)` → `11,0,0,0,0,0,0,0,0,0` |

The second row is what dev-5243 reported as "every constructor argument after
the first is lost". Their two disproofs were both correct and both consistent
with this: the emitted bridge IS right when called directly from JS (it never
consulted `__argc`), and only one arity is emitted. What they could not see
from outside is that the callee's behaviour depended on a global neither the
bridge nor the direct JS call had set.

Fix: the ABI gains a leading argument count —
`__class_construct_<Class>_<arity>(argc, a0, …)` — and the bridge does
`global.set __argc` immediately before `call <Class>_new`, after the arguments
are already on the stack so no coercion call can clobber it. The runtime passes
`min(args.length, arity)`, matching `maybeSetArgcForKnownCall`. Changing the
export's shape is free: it is new in this same PR and nothing else consumes it.

Also fixed in the same commit: the trap called the bridge with a SPREAD
(`fn(...dense)`), which routes through `Array.prototype[Symbol.iterator]` — the
exact hazard `_denseOwnWasmArgs` / `_applyWithPrefix` exist to avoid (#4758).
Now `_applyWithPrefix(fn, undefined, [argc], dense)`.

Measured after, in `tests/issue-5242-class-value-construct-bridge.test.ts`
(both lanes) and on the real polyfill:

| probe | first cut | after |
| --- | --- | --- |
| `new D(11,12)` via value | `11,12,NaN,NaN,NaN,NaN` | `11,12,0,0,0,0` (= control) |
| `new Duration(11,…,20)` via value | `11,12,…,20` | unchanged |
| `new Duration(0,0,0,1)` via value | `0,0,0,0,…` / `PT0S` | `0,0,0,1,…` / `P1D` (= control) |

**Process note worth keeping.** This defect existed for the whole first cut and
every gate was green: the equivalence gate, the ratchet gates, and #5242's own
test, which used a class with NO default parameters. A bridge that pads
arguments must be tested against a callee that can TELL — the six-parameter
class proved arity and the export view, and proved nothing about defaults. The
regression rows are now in the test with a direct-`new` control beside each.

### The LOCAL-BOUND construct spelling is a separate, PRE-EXISTING defect

dev-5243 reported that `const t = ce("%Temporal.Duration%"); new t(a…j)` still
reads back `11,0,0,0,…` while the inline `new (ce(…))(a…j)` is correct, and
proposed it as an uncovered arm of this fix. Measured, it is **not** — it is
older than #5242 and #5242 did not make it quieter:

| probe (polyfill `ce`, ten args) | pre-#5242 base `528b8d42cc` | after #5242 |
| --- | --- | --- |
| inline `new (ce(…))(11,…,20)` | THREW `bridge unavailable` | `11,12,…,20` ✅ |
| **bound** `const t = ce(…); new t(11,…,20)` | **`11,0,0,0,…`** | `11,0,0,0,…` (unchanged) |
| control `new Temporal.Duration(11,…,20)` | `11,12,…,20` | unchanged |

So the bound spelling was **already** silently wrong before this change; #5242
fixed the spelling that used to throw and left the other exactly as it was. The
"louder → quieter" concern does not apply to it — it was never loud.

**FIVE ELIMINATED CANDIDATES** for whoever picks it up. Two are mine, three are
dev-5243's, and **theirs kill every mechanism I proposed** — read the
eliminations, not my guesses:

- **It is ORDER-DEPENDENT.** Run alone, the bound spelling is CORRECT
  (`11,12,…,20`); it misreads only after a four-argument bound construct of the
  same class, and that four-argument call is itself correct. So it is the route
  the first call leaves BEHIND, not the first call's own result. A single-probe
  test therefore reports this as PASSING. (mine)
- **It does not enter `__construct_closure` as a struct.** Tracing shows
  `struct=false` there, so a fix that reorders the `_classCtorClosures` /
  `__is_closure` test inside that import does nothing. I wrote that fix,
  measured it, and removed it — it changed no observable value. (mine)
- **NOT ambient `__argc`.** I originally read `11` + nine zeros as the signature
  of `__argc` stale at `1`. **dev-5243 disproved it**: interposing a ten-argument
  STATIC construct — which leaves `__argc` at 10 — between the two bound calls
  does not repair the second, and a repeat call is stable at `11,0,0,…`. A
  stale-global explanation cannot produce a value that survives the global being
  overwritten. Do not spend time here on my account.
- **NOT the `__call_fn_<N>` arity clamp.** The failing module exports
  `__call_fn_0` … `__call_fn_4`, so a generic-closure fallback would deliver
  `11,12,13,14,…` — four good values, not one. That also rules out the cached
  `_wrapCallableForHost` → `_wrapWasmClosureUnknownArity` wrapper I named as the
  likely culprit. (dev-5243)
- **NOT an arity-carrying cache** — the last shape either of us had on the
  table, including the sentence that used to end this section. dev-5243
  measured one compile per width: the FIRST bound construct of a class is
  correct at ANY width (two / four / ten args), and every later one collapses
  to exactly one argument. The decisive row is ten-then-ten — a predecessor
  that itself answers perfectly, at the SAME width as its successor, still
  poisons it. So nothing is carrying the first call's arity. (dev-5243)

What survives all five: a **first-call-wins latch that degrades to arity 1** —
something the first bound construct of a class MEMOISES, reused by every later
one, delivering exactly one correct argument regardless of either call's width,
of the global's state, and of which dispatchers the module emits. Start at
whatever is cached per class on that first construct.

**The authoritative #5244 handoff lives in dev-5243's own issue file**, which
carries the full per-width table. (Not linked by path here: that file is on the
#5243 branch, not this one, and the issue-integrity gate correctly rejects a
path that does not resolve on the branch citing it.) This section is the
#5242-side summary; if the two ever disagree, that one is the record.

Filed as its own lane (#5244 territory). Pinned in this issue rather than in the
test's expectations because the test's own reduction does not reproduce it (its
registry is a plain `Map`, which routes to the class mirror for both spellings);
the `defaultedInline` row was added so the spelling that IS covered is covered
explicitly rather than by accident.

### Deliberately NOT done

- **Rest-parameter constructors** (`constructor(...args)`) and constructors with
  a formal that has no externref boundary coercion (i32/i64/f32 native
  annotations, struct/vec refs) get no bridge and keep today's generic-closure
  behaviour. Widening either would need its own ABI contract, exactly as #5204
  decided for the method bridges.
- **The provider lane's Temporal arithmetic.** The `knownGaps` block of
  `tests/dogfood/report/temporal-global.json` is byte-identical across THREE
  runs — pre-fix, post-fix, and again after the `__argc` ABI change — each from
  a dedicated `.tmp/tcache-*` directory reporting `cacheHit: false`. The residue
  there is the object-literal argument crossing the seam — #5225.

  **`cacheHit: false` is load-bearing here, not decoration.** The provider cache
  is content-addressed on the POLYFILL SOURCE, which a compiler change does not
  touch, so a cache HIT serves a provider built by whatever compiler last ran in
  the container against a consumer built by yours — a compiler-change measurement
  that silently compares two different compilers. dev-5243 hit exactly that on
  2026-08-31: a 17-hour-old `/tmp/js2wasm-temporal-cache` produced five
  simultaneous `supported` failures that read as "the merge regressed #5237",
  and all eleven passed against a fresh directory. No number in this issue used
  the default cache dir.
- **The `dateAdd` destructuring-parameter null.** After this change every
  single-module Temporal arithmetic row fails with `Cannot destructure 'null'
  or 'undefined'` from the ISO calendar's `dateAdd(e, {years=0, months=0,
  weeks=0, days=0}, i)`. Control: `add({days:1})` constructs no Duration at all
  and fails with the SAME message and the SAME stack on base, where no
  constructor bridge was involved. So it is a separate argument-marshalling gap
  on the dynamic method bridge (`__extern_method_call` → `__call_fn_method_3`),
  adjacent to #5221's destructuring work.
- **Un-marshalling the `__construct` / `__construct_closure` RESULT.** Those two
  imports exist only for compiled callers, and the host `[[Construct]]` arm
  hands back a `_wrapForHost` proxy, so returning the raw struct instead looked
  like an obvious companion fix (a constructor stores state keyed by the raw
  `this`, the caller then reads through the proxy). It was built, measured, and
  **removed**: with the bridge in place every probe answers identically with and
  without it, and the only observable difference was the *wording* of an
  unrelated pre-existing throw (`until` moved between two failure messages, both
  wrong). An unvalidated marshalling change on a path this hot is not worth
  carrying, so this PR is exactly the two root causes above.
- **`Temporal.Duration.from({days:1})` answering `"PT0S"`.** Wrong on base and
  wrong after, unchanged by this work; recorded here so it is not rediscovered
  as a regression.

### Cross-lane surprise worth keeping

In the LINKED lane the new path is now better behaved than the old one: an
instance minted through the host ctor mirror answers every member across the
seam, while a plain `new K(…)` inside the provider still loses them
(`label is not a function`). That asymmetry is pinned in the test rather than
asserted away — it belongs to the #5237 cross-module identity family.
