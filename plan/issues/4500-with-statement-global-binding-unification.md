---
id: 4500
title: "Standalone: `this.p` and bare `p` are different storage — global-binding unification"
status: ready
sprint: Backlog
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [4206, 4495, 4205]
architect_spec: required
---

# Global-binding unification: `this.p` and bare `p` never reconcile

## Problem

At script global scope, `this.p1` and the bare name `p1` denote the **same
binding** in JavaScript. In `--target standalone` they are backed by **two
different storages** that never reconcile, in either direction.

The 2026-08-07 handoff on #4206 already named this as "the real head of this
cluster … unowned and unfiled", sized at ≥19 files. This issue is that item,
now with a controlled experiment separating it from #4495.

## Measured evidence — the type is held CONSTANT

**Provenance: measured 2026-08-15 on `9e17d34f3` + `5cde3f054`, `--target
standalone`, via `.tmp/same-type-probe.mts` and `.tmp/global-binding-probe.mts`.
Each case throws only when the observed value is WRONG, so "ok" means
spec-correct. No `with` statement appears in any row.**

Every value is the **same type throughout**, which is what rules out #4495's
slot-typing mechanism as an explanation:

| case | result |
|---|---|
| `this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` | **WRONG** |
| `var p1 = 1; p1 = 2; this.p1 === 2` | **WRONG** |
| `var p1 = 1; this.p1 = 2; p1 === 2` | **WRONG** |
| `this.p1 = 'a'; var f = function(){ p1 = 'b'; }; f(); p1 === 'b'` (string throughout) | **WRONG** |
| `var p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` (`var` global — control) | ok |

And the cases that do **not** fail, which localise it:

| case | result |
|---|---|
| `this.p1 = 1; p1 === 1` (bare read of a `this.`-assigned global) | ok |
| `this.p1 = 1; p1 = 'x1'; p1 === 'x1'` (straight-line write then read) | ok |

## What the evidence says

- The split is **not** observable on a straight-line write-then-read, and **not**
  on a plain bare read of a `this.`-assigned global. Both work.
- It becomes observable across a **closure boundary** (`f(){ p1 = 2 }` called
  from the same scope) or across a **`this.`/bare direction change**.
- It is **independent of value type** — numeric-throughout and
  string-throughout both fail identically.
- A `var`-declared global with the identical closure shape is **correct**, so the
  closure-capture machinery itself is fine; what differs is the storage chosen
  for a `this.`-assigned global.

That combination points at the *binding resolution* for globals introduced via
`this.<name>` rather than at closure capture or at slot typing.

## Relationship to #4495 — TWO heads, not one

#4495 (string/typed slot cannot represent a dynamic value ⇒ stores `null`) is a
**separate defect**. The clean separators, both measured:

- `function id(x){ return x }; var result = 'r'; result = id(1); '' + result`
  reproduces **#4495** with **no globals anywhere**.
- The type-held-constant table above reproduces **this issue** with **no type
  change anywhere**, so no slot can be blamed.

They **co-occur** throughout the `S12.10` `with` corpus because `this.p1 = 1`
does two things at once: it splits the storage (this issue) *and* makes the value
dynamic to the checker, which then hits #4495's slot path. That co-occurrence is
what caused an earlier revision of #4495 to wrongly merge the two — see the
correction recorded in that file. **Neither subsumes the other; both must land.**

## Residue arithmetic (#4206)

**Provenance: `language/statements/with`, `--target standalone`, 181 files,
measured 2026-08-15 with a working quickjs eval provider (`.tmp/with-base2.jsonl`).**

Baseline **113 pass / 55 fail / 13 CE** — i.e. a **68-row residue**. (An earlier
scan reporting 66/102/13 was instrument noise: 56 rows were "quickjs provider is
not built". See #4206 §0.)

How the 68 splits, and who owns each part:

| rows | cluster | owner |
|---:|---|---|
| 13 | `__str_concat` null deref | **#4495** — and worth **zero passes** on its own: in all 13 files every concat is inside `throw new Test262Error(...)`, so the crash is strictly on the already-failing path |
| 10 (+1) | `#1387` closed-shape CE gate | constructible-closure ABI — an ABI project, not a slice (per #4206's 2026-08-11 record) |
| 6 | `p1 === "x1"` actual `1` | **this issue** |
| 4 | `result === undefined` actual `null` | **#4495** (a native-string slot cannot represent `undefined` at function entry) |
| 2 | `theirObj.p1` actual `true` | not diagnosed |
| rest | singletons | not diagnosed |

**Consequence for scheduling:** no further `with`-lane slice is takeable until
this issue and #4495 land. #4206 should be treated as blocked on the two heads
rather than as a source of ready work.

## Blast radius — read before starting

Global binding resolution is load-bearing for every script-goal program, and the
`var`-global path is currently **correct** — so a fix must not disturb it. The
risk is a change that unifies the two storages but regresses the common
`var`-global fast path, which is exercised far more widely than the `this.`-global
one. `feasibility: hard` and `architect_spec: required` for that reason.

**A Fable-lane implementation plan is required BEFORE dispatch.** Do not start
implementation off this file alone.

## Acceptance criteria

1. Every row in the type-held-constant table above is `ok`.
2. The two currently-passing localisation rows stay `ok` (no regression on the
   straight-line and bare-read paths).
3. The `var`-global control stays `ok`, with a measured check that the
   `var`-global path did not regress.
4. Measured, two-sided A/B on `language/statements/with` standalone against the
   68-row baseline above, plus a gc-lane control (this is not carrier-gated).
5. Zero `pass → non-pass` transitions on either lane.

## Instrument warning

Measuring this needs a **working eval provider**, or ~56 of the 181 `with` rows
report a false failure and the delta is meaningless. `TEST262_FULL_RUNTIME_EVAL=1`
selects the *interpreter* tier, but since #4242 the default engine is **quickjs**
and the selector never builds it. Build both bundles first, then the provider —
and rebuild both bundles **per A/B arm**, since the test262 pool worker imports
`scripts/compiler-bundle.mjs`, not `src/`:

```sh
node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
NODE_OPTIONS=--max-old-space-size=3072 node scripts/build-quickjs-eval-provider.mjs
```

## Falsified hypotheses (kept visible)

- ~~"This is the same defect as #4495; global-binding is just one of its
  sources."~~ **False**, and it was written into #4495 before being disproved.
  The type-held-constant table fails with no type change anywhere, so no slot
  can explain it.
- ~~"It is a `with`-scope-chain resolution bug."~~ **False.** Every failing row
  above has no `with` statement. The `with` corpus merely *contains* the shape;
  removing `with` entirely preserves the failure.
- ~~"Closure capture is broken."~~ **False.** The identical closure shape over a
  `var`-declared global is correct; only the `this.`-assigned global fails.

## Implementation Plan (fable, 2026-08-15)

Source picture (verified against source 2026-08-15): script-goal globals have
TWO storages today —

- **`var`-declared** → wasm module globals (`ctx.moduleGlobals`,
  `global.get/set`, e.g. assignment.ts ~L208-217).
- **Implicit / `this.`-assigned** → the realm global-environment object:
  pre-scan `recordSloppyImplicitGlobalNames` populates
  `ctx.sloppyImplicitGlobals` (see module-init-collection.ts ~L160-176,
  index.ts ~L3714); reads go through `emitImplicitGlobalRead`
  (identifiers.ts ~L929 → global-environment.ts ~L335); writes through
  `ensureGlobalEnvironmentOperation("__extern_set")`
  (assignment.ts ~L885, unresolvable-assign.ts ~L181/L246/L258). The env
  object exists natively in standalone (probes' bare-read row works).

The unification rule: **one canonical storage per name, decided statically.**
`var`-declared in the compiled script ⇒ module global. Otherwise ⇒ env
object. Each defect row is a path that picks the WRONG storage for its name.

### Slice A — `this.p` ⇄ module global (probe rows 2 and 3)

Where a member access's receiver is the realm global object
(`receiverIsRealmGlobalObject` / `isGlobalObjectExpr`,
sloppy-this-global.ts ~L164/~L191, global-environment.ts ~L613) AND the
property name is in `ctx.moduleGlobals`: compile the access as
`global.get`/`global.set` on the module global instead of the env-object
op. Sites: the member-read dispatch and member-write path that currently
route such receivers to `__extern_get`/`__extern_set` (find them by tracing
the row-2 probe: `var p1 = 1; p1 = 2; this.p1` — the `this.p1` read's arm).
Coerce through the module global's declared type with the existing
`coerceType` (the #3534 box-on-store invariant applies if the global is
externref). `delete this.p1` on a var global: emit `false` (var globals are
non-configurable) — add a probe row for it.

### Slice B — closure bare-write of an implicit global (probe row 1)

`this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` fails, yet the
write path at assignment.ts ~L885 already consults `sloppyImplicitGlobals`.
So EITHER the closure's write compiles through a different arm (the
auto-local at ~L899, or an unresolvable-assign arm that allocated a local
before the set was consulted), OR the pre-scan runs after the closure body
compiles, OR the checker resolves `p1` inside the closure to something
else entirely. Diagnose FIRST: instrument all four candidate arms
(assignment.ts L885/L899, unresolvable-assign.ts L181/L246) and compile the
row-1 probe; record which arm fires. Then fix that arm to route through the
env-object write. The auto-local arm's own comment (#4231 RC-F) documents
why minting a local is destructive — whatever the diagnosis, the fix must
not introduce a new local for a name in `sloppyImplicitGlobals`.

### Order

Slice B first (it is the closure row, likely the bigger test262 share and
carries no representation change), then Slice A. Separate boundaries, each
with its own measurement. If Slice B's diagnosis reveals the pre-scan
ordering is the defect, fixing the ordering may also change Slice A's
baseline — re-measure between slices.

### Measurement (both slices)

1. The probe tables in this file: all WRONG rows flip to ok, all ok rows
   (incl. the var-global control and the two localisation rows) stay ok —
   both targets.
2. Scoped test262 A/B, standalone: `language/statements/with` against the
   68-row baseline (quickjs provider per Instrument warning; rebuild bundles
   per arm) — expect the 6 `p1 === "x1"` rows to flip; plus
   `language/eval-code` and `language/global-code` as global-semantics
   control buckets. Zero pass→non-pass.
3. gc-lane control on the same buckets. Zero pass→non-pass.
4. The `var`-global fast path must not change bytes for programs with no
   `this.`-global interplay: compile 2-3 var-global-only samples before/after
   and diff the binaries — byte-identical expected (Slice A only adds arms
   behind a `receiverIsRealmGlobalObject && moduleGlobals.has` test that such
   programs never take; Slice B is behind `sloppyImplicitGlobals`).
