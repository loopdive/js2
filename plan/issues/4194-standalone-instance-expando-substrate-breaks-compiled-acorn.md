---
id: 4194
title: "standalone: a constructed instance has no expando substrate — for-in/Object.keys/`in` see 0 keys and a dynamic write is DROPPED; this is what makes compiled acorn reject `{ f }` destructuring in every eval"
status: done
completed: 2026-08-08
pr: 4232
assignee: "ttraenkler/fable-3927-emission"
sprint: 78
created: 2026-08-06
updated: 2026-08-18
loc-budget-allow:
  # New module (PR #4233's bag half): carrier predicate, bag get/set, tombstone
  # marker filtering, enumeration merge. The declared-field write-through ladder
  # was DROPPED from this module in the #4232 reconciliation — #4232's
  # closed-struct-extern-set.ts owns that half.
  - src/codegen/instance-props.ts
  # `object-runtime.ts` edits deliberately kept to call-site wiring — every new
  # body lives in `instance-props.ts`.
  - src/codegen/object-runtime.ts
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: runtime
es_edition: 5
language_feature: objects
goal: standalone-mode
related: [2928, 3927, 4010, 4055, 4071, 4098, 4137, 4182]
loc-budget-allow:
  # (2026-08-08 computed-write slice) One import + the fill call in each of
  # the two finalize sequences; the fill itself (~350 LOC) is the NEW
  # src/codegen/closed-struct-extern-set.ts.
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
origin: "W14 (annexB eval-code lever, 2026-08-06). Reserved with pr_scan=degraded (gh unauthenticated) — re-verify the id before merge."
---

## Status 2026-08-08 — re-measured on current main; the WRITE half is this issue's remaining substance and its computed-key core is FIXED here

The 2026-08-06 table predates the #3920 chain (GitHub PRs #4219 + #4229). On
current main the four claims split cleanly:

| surface (same fixture as the TL;DR) | 2026-08-06 | 2026-08-08 main | after this slice | native |
| --- | ---: | ---: | ---: | ---: |
| `for (p in n)` bitmask | 0 | 11 | 11 | 111 |
| `Object.keys(n).length` | 0 | 2 | 2 | 3 |
| `("type" in n) + ("name" in n)`·(1/10) | 0 | 1 | 1 | 11 |
| named write `n.name="f"` readback | 101 | 101 | 101 | 111 |
| computed write to a STRUCT-FIELD name (`n[k]="T2"`, k="type") | — | **0 (dropped)** | **11 = native** | 11 |
| computed write to an expando name (`n[k]`, k="name") | — | 0 | 0 | 11 |

So the ENUMERATION half is fixed for struct-backed fields (own keys with
storage enumerate, `in` answers, presence-word reads are live) — by
#4219/#4229, not here. What remained, and what this slice fixes, is the
**computed-WRITE half for names WITH physical storage**: `n[key] = v` through
a dynamic key silently dropped on every closed-struct receiver — even
`n["type"] = "T2"` — because `__extern_set`'s non-`$Object` arm knew only
vecs and closures. That drop is exactly what kept acorn's `copyNode`
(`for (p in node) newNode[p] = node[p]`) blank AFTER enumeration went live,
i.e. the measured zero-effect blocking the #3927 per-type-layout default-ON
flip.

**What this slice ships** (`src/codegen/closed-struct-extern-set.ts`,
`fillClosedStructExternSetArms`, wired beside the GET fill in both finalize
sequences): closed-struct write arms in `__extern_set` — key flattened once,
per-name probes, per-receiver `ref.test` + `$shape` collision guards
mirroring the GET fill, presence-bit set on write, cold-tail arms through
`__cold_ensure_*`, tombstone REVIVAL on write (bag-lookup-only, never
ensure), funcMap-read-only value coercion (a field whose unbox helper is
absent is skipped and stays exactly as unwritable as before). Strict and
sloppy both route here (`__extern_set_strict` delegates every non-`$Object`
receiver). Measured after: the copyNode composition goes **0 → full copy**
(unit fixture 1111 = native, incl. a flow-grown conditional field, with a
positive-control write asserted first); delete-then-computed-rewrite revives
the key (1111 = native); frozen computed writes still throw with the value
unchanged (= native); acorn dogfood canaries 2/3/4/5, `functionImports []`.

**What this slice does NOT ship — the rows still ≠ native above:**

1. **The true expando substrate** (a name with NO storage anywhere:
   `n.name = "f"` on the minimal fixture, `keysLen` 2 vs 3, `"name" in n`).
   That is the #4010 rows-4-7 / #4098 carrier-bag greenfield this file's
   TL;DR cites; unchanged here, pinned by
   `tests/issue-4194-closed-struct-computed-write.test.ts` ("expando
   residual") so the day it lands is noticed. In ACORN's case the ESTree
   names are flow-grown struct fields, so copyNode does not need it.
2. Layers 2–3 of the annexB stack below (interpreter ObjectPattern catch
   destructuring, B.3.3/B.3.5 cancellation) — unchanged scope.
3. The `SyntaxError: NaN` diagnostic defect — independent, unchanged.
4. The js-host lane has DRIFTED since 2026-08-06 (measured 2026-08-08:
   for-in 100, keys 0, `in` 10 on the same fixture — it now sees ONLY the
   sidecar expando, not the ctor fields). **Filed as #4227**
   (`plan/issues/4227-jshost-instance-reflection-sees-only-sidecar.md`) so it
   stays dispatchable after this file goes `done`.

**Acorn-scale validation — the copyNode composition, measured on the real
artifact.** `tests/dogfood/cold-tail-differential.mjs` gained a fourth mode,
`PROBE_READ=copy`: every walked node is copied via
`for (k in n) copy[k] = n[k]` into a fresh laundered `new Node(...)` and the
64 per-field hashes are taken over the COPY. Against the same build's
computed-mode (direct read) hashes, over 32,506 objects: **58 of 64 fields
bit-exact** — before this slice the copy was structurally blank (first
measurement: every write dropped). The 6 divergences decompose completely and
none is a write defect:

- `type`/`start`/`end` presence 32,487 → 32,506: the copy shell is a Node,
  whose ctor writes those three unconditionally — the 19 walked non-Node
  objects gain them. Instrument shape.
- `pattern`/`flags` 15 → 0, `source` 5 → 1: acorn's `node.regex` descriptor
  is a plain `{pattern, flags}` object natively (enumerable — the native
  ORACLE's copy keeps all 15), but the wasm lane's `for…in` over that carrier
  class yields nothing, so the copy loses what the direct computed read still
  sees. Pre-existing, newly measurable precisely because the write half now
  works. **Filed as #4228**
  (`plan/issues/4228-acorn-regex-descriptor-forin-yields-nothing.md`) — with
  the load-bearing negative result that the obvious minimal fixture does NOT
  reproduce (a hand-built `{pattern, flags}` behind a dynamic receiver
  enumerates fine; the mechanism is context-dependent inside compiled acorn).
  Whoever runs the flag-ON conformance pass should expect this class, now
  with an issue number to cite.

Two instrument traps burned into the harness docs: the copy receiver must be
LAUNDERED (a struct-typed `var copy = new Node(...)` binding takes a
different lowering for both `copy[k]` reads and writes — the first cut
answered non-undefined for all 64 fields on all 32,506 nodes, a fully
vacuous-looking PASS shape), and the expected divergences above are labeled
so they are not re-diagnosed.

# #4194 — a constructed instance has no expando substrate in standalone, and compiled acorn is the victim

## TL;DR

In `--target standalone`, an object produced by `new C(...)` (ES `class` **or**
function constructor) supports **no reflective own-property surface at all**,
and a dynamically-added property is **silently discarded**. Measured on current
`main`, same source compiled twice:

| surface, on an instance with ctor fields `type`/`start` + a later `n.name = "f"` | standalone | js-host | correct |
| --- | ---: | ---: | ---: |
| `for (const p in n)` — keys seen (bitmask 1/10/100) | **0** | 111 | 111 |
| `Object.keys(n).length` | **0** | 2 | 3 |
| `("type" in n) + ("name" in n)` (1/10) | **0** | 11 | 11 |
| direct reads `n.type` / `n.name` / `n.start` (1/10/100) | **101** | 111 | 111 |

The last row is the sharpest one: `readsBack = 101` means the *write itself*
was dropped — `n.name = "f"` on an `any` holding a class instance is a no-op in
standalone, and the read-back is `undefined`. The host lane is essentially
correct (its `keysLen = 2` vs 3 is a separate, much smaller gap).

`carrier-bag-visibility.ts` already names this as known-greenfield —
*"Date / RegExp / Error / class instances have no bag, so `__carrier_bag_of`
answers null … their expando substrate is still greenfield (#4010's matrix rows
4-7); #4098 is the issue that needs it."* This issue is not the discovery of
that gap. It is the **consumer** that makes it urgent, plus a decisive A/B that
localises the payoff.

## Why this is not a niche reflection bug

The standalone `eval` / `new Function` provider is **compiled acorn**. Acorn's
`copyNode` is:

```js
pp$2.copyNode = function(node) {
  var newNode = new Node(this, node.start, this.startLoc);
  for (var prop in node) { newNode[prop] = node[prop]; }   // <- enumerates NOTHING
  return newNode
};
```

`node` is an untyped parameter, so the receiver is `any` → the for-in takes the
dynamic path (`__object_keys_forin`) → the runtime value is not a `$Object` and
has no carrier bag → **zero keys** → `copyNode` returns a blank `Node`.

`copyNode` is called on exactly one hot path: **object-property shorthand**.

```js
// acorn parsePropertyValue, shorthand arm
prop.value = isPattern
  ? this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key))   // pattern
  : this.copyNode(prop.key);                                              // expression
```

For an object *expression* nobody inspects the copy, so `var o = { f }` looks
fine. For an object **pattern**, `checkLValPattern(prop.value)` reads
`expr.type` — `undefined` on the blank copy — falls through every case to
`checkLValSimple`'s `default:` arm and **raises**. Hence:

| eval'd source | node-acorn | compiled acorn (standalone) |
| --- | --- | --- |
| `var { a: b } = {};` | ok | ok |
| `var [a] = [];` | ok | ok |
| `var o = { f };` | ok | ok |
| **`var { a } = {};`** | ok | **SyntaxError** |
| **`let { f } = {};` / `function g({ f }){}` / `({ f } = {})` / `for (var { f } of [])` / `catch ({ f })`** | ok | **SyntaxError** |

So: **no standalone `eval`/`Function` can parse object destructuring shorthand.**

### The A/B that proves it — on the real artifact, not a model

Compile the pinned acorn tarball twice, changing **only** `copyNode`'s for-in
into explicit field copies (`.tmp/probe/acorn-copynode-ab.mjs`):

| build | `var { a } = {}` | `var { a: b } = {}` | `catch ({ f }) {{ function f(){} }}` | `var o = { f }` |
| --- | --- | --- | --- | --- |
| A stock | **raise** | ok | **raise** | ok |
| B copyNode patched | **ok** | ok | **ok** | ok |

One two-line change to a single acorn function, and every shorthand shape
parses. Nothing else in the parser is implicated.

## Second, INDEPENDENT defect found alongside — every acorn diagnostic renders `NaN`

Recorded here because the two are always seen together and were previously
conflated (see "Corrections to #4137" below). On genuine syntax errors, where
compiled acorn is *supposed* to raise:

| eval'd source | node-acorn | compiled acorn |
| --- | --- | --- |
| `var 1 = 2;` | `Unexpected token (1:4)`, `err.pos = 4` | message `"NaN"`, `err.pos = NaN` |
| `(` | `Unexpected token (1:1)`, `err.pos = 1` | message `"NaN"`, `err.pos = NaN` |
| `a b c` | `Unexpected token (1:2)`, `err.pos = 2` | message `"NaN"`, `err.pos = NaN` |

`err.pos` is `NaN` too, not just the message — so this is **not** only the
`message += " (" + line + ":" + col + ")"` string-concat lowering. Something in
`pp.raise(pos, message)`'s argument path numerifies **both** operands. This
defect changes **no verdicts** on its own (the raise still happens, the test
still fails) — it destroys the *diagnostic*, which is why the shorthand bug
above stayed invisible for so long. Fix the substrate first; fix this so the
next one is findable.

## Payoff, measured honestly

`SyntaxError: NaN` is **36 standalone records** — 24 in
`annexB/language/eval-code/**-skip-early-err-try`, 12 in
`language/{expressions,statements}/class`. Every one of them is this shorthand
raise.

**But fixing this alone flips ZERO of the 24 annexB files.** They need a
three-layer stack, and layers 2 and 3 are separate work:

1. **this issue** — instance expando substrate, so `copyNode` works and acorn
   parses `catch ({ f })`.
2. **interpreter emitter** — measured with a shorthand-free but semantically
   identical oracle (`catch ({ f: f })`, which stock compiled acorn *can*
   parse): the interpreter then refuses with
   `Error: interp/emitter: unsupported in Phase 1: catch destructuring
   (ObjectPattern)`. That is #4137's arm 3 / #2928 Phase 2 scope.
3. **B.3.3 condition ii / B.3.5** — a *destructuring* CatchParameter must
   **cancel** the Annex B synthetic var (only a `BindingIdentifier` is exempt).
   #4137 built `SIMPLE_CATCH_SCOPE_LABEL` for the exempt half; the cancelling
   half is untested because nothing has ever reached it.

The 12 class-family files may need only layer 1 — not verified, because layer 1
does not exist yet to test against.

The wider payoff is not countable from the current baseline at all: every
standalone `eval` of shorthand-using source fails *today* with an unrelated-
looking message, and a working instance expando substrate is a prerequisite for
#4098 and for `Date`/`RegExp`/`Error` expandos (#4010 rows 4-7).

## Implementation notes / hazards

- **`Object.keys` is NOT the same surface as `for-in` here, and the difference
  is load-bearing.** #4071 measured **-5** for letting closed-struct fields into
  `Object.keys` and was reverted. Do not widen `Object.keys` and for-in with one
  switch. The acorn consumer needs **for-in** (and the dynamic *write* to be
  retained); `Object.keys` on builtin-backed structs is where the -5 lives.
- The **write** half is the harder half and probably has to come first: there is
  no point enumerating a key the assignment threw away. `readsBack = 101` says
  `n.name = "f"` on an instance-typed `any` currently lands nowhere.
- Follow the composition rule the bag work established: the existing answer runs
  **first** and is returned when affirmative; the new substrate is consulted only
  where today's answer is "absent". That is what kept #4055 v2 from re-running
  into the -684.
- A **query must never allocate** a bag/substrate (`carrier-bag-hasown.ts`
  rule) — `for (p in x)` on a fresh instance must not hand a later
  `__integrity_bag` consumer a carrier it did not have.

## Reproduction

All probes are in the (gitignored) worktree `.tmp/probe/`; each is restated
inline above so nothing load-bearing dies with the worktree.

- `forin-lanes.mts` — the standalone-vs-host table at the top. Compiles ONE
  source twice; ~10 s.
- `acorn-copynode-ab.mjs` — the decisive A/B. Compiles the pinned acorn tarball
  twice (~50 s each) with only `copyNode` changed.
- `acorn-raise3.mjs` — the shape matrix (which shorthand forms raise) plus the
  genuine-syntax-error control that isolates the `NaN` message/pos channel.
- `.tmp/probe/oracle-shorthand.js` — the layer-2 oracle: the real
  `skip-early-err-try` body with `catch ({ f })` rewritten to `catch ({ f: f })`.
  Run through the standalone test262 lane; returns the Phase-1 refusal.

**Instrument** (non-negotiable — a run without it measures a different
compiler): rebuild `scripts/compiler-bundle.mjs` and `scripts/runtime-bundle.mjs`
with esbuild, then `node scripts/build-runtime-eval-provider.mjs` (~106 s, its
cache key folds in the compiler-bundle hash, so redo it after every source
change being A/B'd), then run with `TEST262_FULL_RUNTIME_EVAL=1`. Without that
flag the REFUSAL tier answers and every eval test reports
`dynamic code evaluation is not supported` — a different, equally fake result.

## Corrections to #4137 (its arm 3, `SyntaxError: NaN`)

#4137's work log attributes this family to "Acorn's `pp.raise` message … an
`any`-typed compound `+` … it is a **codegen** bug in
`src/codegen/expressions/operator-assignment.ts`", and hands off a
`pa9.ts`/`pa10.ts` probe pair as *the* diagnostic. That diagnosis is **half
right and points at the wrong file for the verdict**:

- The message corruption is real, but it is **cosmetic** — #4137 already said
  fixing it would not flip the 24 tests, and that is right for a reason it did
  not have: the raise is **spurious**, and it comes from `copyNode`, not from
  the message path. Also, `err.pos` is `NaN` as well, which a
  `message += string` bug cannot explain.
- #4137 says "a second compiled-acorn **scope-tracking** defect sits
  underneath". It is not scope tracking. It is `copyNode` returning a blank
  node, so `checkLValPattern` never sees an `Identifier`. Anyone starting from
  the scope tracker will not find it.

Neither correction reflects badly on that lane's measurement — it explicitly
flagged the arm as diagnosed-not-fixed and told the next lane to expect a second
layer. There were three.

## Permanent repro (#2093)

`tests/issue-4194-instance-expando.test.ts` — the §e1 micro-probe table as
vitest: reads-back / for-in / `in` / Object.keys / computed writes / the
copyNode-shaped copy loop, on class and function-constructor receivers,
standalone. The end-to-end population is the 24
`test262/test/annexB/language/eval-code/**/*-skip-early-err-try.js` files
(24/24 pass with the full provider).

## Acceptance criteria (status annotated 2026-08-08 — see the Status section)

- [x] ~~`for (const p in instanceOfC)` enumerates the instance's own
      enumerable keys~~ **for STRUCT-BACKED keys: done by #4219/#4229** (not
      this slice), including keys added by a later dynamic assignment to a
      storage-backed name (presence bit set on write — this slice). Keys
      added to names with NO storage: still invisible (expando substrate,
      #4010/#4098).
- [ ] A dynamic write to an instance-typed `any` (`n.name = "f"`) is retained
      and reads back — **done for names WITH physical storage (this slice,
      computed + named routes agree); still open for true expandos**
      (#4010/#4098 substrate; pinned red in the unit test).
- [ ] The A/B above collapses: **stock** compiled acorn parses `var { a } = {}`,
      `catch ({ f })`, `function g({ f }){}` with no source patch. The
      compiled-acorn copyNode composition now copies (58/64 fields bit-exact
      at scale); the eval-provider A/B itself needs the provider rebuild
      instrument (~106 s + TEST262_FULL_RUNTIME_EVAL=1) and is the flag-ON
      conformance run's first checkpoint.
- [x] `Object.keys` behaviour on builtin-backed receivers is **unchanged** —
      this slice touches only the WRITE helper; the #4071 screen
      (`isUserDeclaredStruct`) governs enumeration and is untouched. The
      write arms enumerate `ctx.structFields` for STORAGE, never for name
      lists, and skip synthetic carriers.
- [ ] Measured on the standalone lane with a lever list AND a control list of
      currently-passing files in the same clauses; report both.
## Implementation Plan (arch, 2026-08-08)

Measured on branch `worktree-agent-ae3cfbc43c814cdc8` @ `ca26c15d` = origin/main
`20e56796` + session head `8d2f12a6` (#4137 NaN-render fix + #2200 layers 2/3).
All probes in `.tmp/probe-4194/` (gitignored); every load-bearing number is
restated here.

### (a) Fresh baseline — the landscape has moved, the core defect has not

**A1. Micro-probes** (`forin-lanes*.mjs`, one source compiled twice; encoding:
bitmask 1=type, 10=name(expando), 100=start):

| receiver / surface (after `n.name = "f"`) | standalone | host | issue's 2026-08-06 standalone |
| --- | --- | --- | --- |
| class instance: for-in mask | **101** | 111 | 0 |
| class instance: `Object.keys().length` | 2 | 2 | 0 |
| class instance: `("type" in n)`+`("name" in n)` | **1** | 11 | 0 |
| class instance: readsBack | **101** | 111 | 101 |
| class, computed writes `n[k]=v` (declared str / declared num / expando) | **0** | 111 | (not measured) |
| class, copyNode emulation `for(p in a) b[p]=a[p]` | **101** (ctor-default masked) | 111 | — |
| fn-EXPR ctor (acorn `var Node = function Node(...)` shape): literal expando write | **111/111** | 111 | — |
| fn-expr ctor, copyNode emulation | **101** | 111 | — |

Declared-field *enumeration*, `in`, and dynamic *reads* were fixed by #3920 /
#4170 / #3927 (landed 2026-08-07, after the issue's measurement). What is STILL
broken, and is the whole remaining substrate gap:

1. **`__extern_set` drops every write to a closed-struct receiver** — computed
   OR literal key, declared field OR expando. (The fn-expr-ctor lane's literal
   `n.name="f"` works only because #3927's receiver-flow pass *grew a field*
   for the textually-visible write and `__set_member_name` stores it; the
   computed spelling `n[k]=v` bypasses the dispatcher and hits `__extern_set`,
   which has no closed-struct arm — exactly the `member-set-dispatch.ts:173`
   comment's warning.)
2. **Expando visibility**: an instance's bag (if anything could write one) is
   invisible to for-in / `in` / hasOwnProperty — `__carrier_bag_of`
   (`carrier-bag-visibility.ts:314`) has closure and vec arms only.

**A2. The eval-lane routing fact that invalidated my first measurements (and
will invalidate a dev's, if not known).** `eval("<literal>")` is compiled at
COMPILE TIME by the static-inline lane (`src/codegen/expressions/eval-inline.ts`,
#1163) and never reaches compiled acorn. Only bodies the inline lane refuses —
notably Annex-B function-in-block shapes
(`hasScriptScopeAnnexBFunction` / `evalAnnexBDeclarationsInlineSupported`,
`src/codegen/expressions/eval-annexb.ts:4/30`) — take the runtime
compiled-acorn + interpreter lane. So "eval of `var {a} = {}` works" proves
NOTHING about acorn. **Never verify this issue with plain literal evals.**

**A3. Parse layer isolated inside the provider unit**
(`provider-parse-split.mjs`: recompiled `buildRuntimeEvalProviderSource()` +
parse-only canaries with `RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS`, 175 s):

| parse(...) input | compiled acorn | stock acorn oracle |
| --- | --- | --- |
| `var { a } = {};` | **raise** | ok |
| `try{throw{}}catch({ f }){ }` plain | **raise** | ok |
| `catch ({ f }) { function f(){} }` (1-lvl collide) | raise | raise (`already declared` — correct) |
| `catch ({ f }) {{ function f(){} }}` (2-lvl) | **raise** | ok |
| `catch ({ f: f }) {{ function f(){} }}` longhand | ok | ok |
| copy-fidelity canary (read `prop.value.type/.name` after parse) | **both parses raise** (16000000) | — |

The issue's copyNode model stands exactly: `newNode[prop] = node[prop]` drops
every write (`__extern_set`, closed-struct receiver — acorn's `Node` is a
fnctor struct: `var Node = function Node(parser,pos,loc)`, and
`fnctor-ctor-param-types.ts:158+` covers FunctionExpression-in-var), the copy
keeps its ctor defaults (`this.type = ""`), and `checkLValSimple`'s `default:`
arm raises **"Binding rvalue"** (`acorn.mjs:2371`) on the `type:""` copy.

**A4. The 24 annexB files, fresh** (faithful lane: `runTest262File(...,
"standalone")`, `TEST262_FULL_RUNTIME_EVAL=1`, provider rebuilt on this base):
**24/24 fail, all `SyntaxError: Binding rvalue (1:266)` or `(1:288)`**
(`annexb24-merged.jsonl`). Before the #4137 render fix the same failures read
`SyntaxError: NaN` (measured both ways on this branch). Layers 2+3 are
demonstrably working end-to-end: the longhand oracle
`eval("try{throw{}}catch({ f: f }){{ function f(){} }}")` **passes** through
the runtime lane (parse ok → #2200 catch-ObjectPattern emit → B.3.3
cancellation) — parse is the ONLY remaining gate for the 24.

**A5. The "12 class files" population NO LONGER EXISTS.** Fresh scoped run of
all 131 eval-containing `language/{expressions,statements}/class` files:
**61 pass / 70 fail**, and not one failure is in the shorthand/NaN family
(buckets: `'super' keyword outside a method`, `new.target`, private-name
Phase-1 refusals, two null-deref RuntimeErrors, missing-SyntaxError asserts).
Those belong to #2928 Phase 2 / other trackers; expected flips from this issue
there: **0**. (`class-chunk0{0,1,2}.jsonl`.)

### (b) Substrate design

All new code in a NEW module `src/codegen/instance-props.ts` (loc-budget: do
not regrow `object-runtime.ts`; the pattern is `vec-props.ts`/`carrier-bag-*`).
Everything gated `ctx.standalone || ctx.wasi`; host output byte-identical.
Reserve-then-fill throughout (funcIdx discipline of `closure-props.ts` header);
fills are funcMap-read-only.

**Carrier set — ONE authority.** `__is_instance_expando_carrier(v) -> i32`:
`ref.test` chain over the typeIdxs of every `ctx.structFields` entry admitted
by `isUserDeclaredStruct` (`user-declared-structs.ts:90` — class ∪ `__fnctor_`
∪ `__anon_`; tuples and builtin carriers excluded by that predicate). This is
deliberately the SAME screen `collectClosedStructEnumerationEntries`
(`object-runtime.ts:6777`) uses, so write/enumerate/`in` cannot drift apart
(#3920's one-authority principle). Reserve next to `reserveInstanceTombstones`
(`object-runtime.ts:866`); fill mirrors `instance-tombstones.ts:262`'s
`userClassStructTypeIdxs` but widened — do NOT edit that module's own
class-only predicate (its tombstone semantics stay #4098-owned). If the
merge_group net guard implicates `__anon_` shapes, first mitigation is
trimming the carrier to class+fnctor (acorn needs only fnctor) and filing the
anon slice as follow-up.

**S1 — declared-field WRITE-THROUGH: `fillClosedStructExternSetArms(ctx)`.**
The write half comes first (issue: "no point enumerating a key the assignment
threw away").

- Entry collection mirrors `fillClosedStructExternGetArms`
  (`object-runtime.ts:7009`): walk `ctx.structFields`; screen
  `isSyntheticStructName` AND — stricter than the get side —
  `isUserDeclaredStruct` (a dynamic write must NEVER reach a builtin internal
  slot: `(new Date(0) as any).timestamp = 5` is an expando in JS, not a
  timestamp mutation). Per field: `typeIdx`, `fieldIdx`, `fieldType`,
  mutable-only (immutable → skip arm, `struct.set` would not validate),
  `presenceSlot` (`presenceSlotOf`/`presenceTestInstrs`), `$shape` guard
  (`shapeIdByStructName`, the #2009 collision gate), and #3927 cold-tail
  fields (`coldOwnFieldsFor` + `coldFieldNameAt`; store via
  `__cold_ensure_<Struct>` + tail store — copy the arm shape from
  `fillMemberSetDispatch`'s cold arms, `member-set-dispatch.ts:173+`).
- Splice: `fn.body.unshift(...)` on `__extern_set` (registered at
  `object-runtime.ts:2609`; current body starts with the `$Object` test at
  2440-2453). Prologue shape, mirroring the #3673-round-19 guard
  (`object-runtime.ts:6627-6636`): `if (!ref.test $Object(recv) &&
  ref.test $AnyString(key)) { flatten key once; per-name ladder; per-name:
  per-struct ref.test arms }`. Plain-`$Object` writes pay ONE ref.test —
  same cost shape the read side already pays. Linear name ladder first;
  upgrade to the #3926 hash `br_table` (get-side pattern at
  `object-runtime.ts:7160-7230`) only if provider timings regress (build was
  166-180 s on this container; per-test standalone budget 30 s).
- Matched-arm body, in order:
  1. **Tombstone resurrection** (#4098 III2/II7): if
     `__instance_field_deleted(obj, key)` (`instance-tombstones.ts:109`) →
     delete the self-referential marker from the bag via `__delete_property`
     on the bag object (bag exists whenever a tombstone does), then proceed
     to store. Restores `delete o.f; o.f = v` round-trip.
  2. **Presence bit**: if the field has a `presenceSlot`, SET it (writes make
     conditional fields live — symmetric with the get side's presence test).
  3. **Store with per-kind coercion** — copy `buildSetterStore`
     (`struct-field-exports.ts:619`), which already solved exactly this:
     `externref`/`ref_extern` → store as-is; other ref kinds →
     `any.convert_extern` + `ref.test <fieldType>` guard + `ref.cast` +
     store (guard-miss → `return` no-op — see edge cases); `f64` →
     `__unbox_number`; boolean `i32` → the boolean unbox `buildSetterStore`
     uses. Then `return`.
- The arm returns only on a NAME match for a MATCHING receiver type; all
  misses fall through to the untouched original body — the #4055 composition
  rule (existing answer first; new code only where today's answer is
  "silently dropped").

**S2 — expando bag (write + read).** No new side table: the #3468 bag is
keyed by **eqref identity** and `__closure_bag_lookup` / `__closure_bag_ensure`
work on any struct instance unchanged — that is a receipt from
`instance-tombstones.ts` (its tombstones already live in instance bags).

- `__instance_prop_set(obj, key, value)`: `bag = __closure_bag_ensure(obj)`
  (ensure is legal here — this IS a write); `__extern_set(bag, key, value)`.
  Reached only when the S1 declared-field ladder missed, so the bag can never
  shadow a struct field (the −684 shape is structurally excluded: the read
  path's declared-field arms answer first AND the write path never deposits a
  declared name into the bag).
- Wire into `__extern_set`'s non-`$Object` arm via a NEW composition builder
  `buildInstanceOrVecOrClosurePropSetMissArm(ctx)` in `instance-props.ts`
  that emits the instance branch (`__is_instance_expando_carrier` →
  `__instance_prop_set`; return) and falls through to the UNCHANGED
  `buildVecOrClosurePropSetMissArm` (`vec-props.ts:120`). Ownership boundary:
  edit call sites, not #3468/#3537 modules. Order inside the arm:
  builtin-fn refusal (already at head, the −684 fix) → vec → **instance** →
  closure. Callsite: `object-runtime.ts:2452`.
- `__instance_prop_get(obj, key)` wired the same way around
  `buildVecOrClosurePropGetMissArm` (callsites `object-runtime.ts:1732/1741`):
  if carrier: (i) `__instance_field_deleted(obj,key)` → fall through (miss);
  (ii) `bag = __closure_bag_lookup(obj)` (**LOOKUP, never ensure** — the
  `carrier-bag-hasown.ts` query-must-never-allocate rule); (iii) bag non-null
  AND `__obj_find(bag, key)` live AND entry.value NOT `ref.eq` bag → return
  `__extern_get(bag, key)`; otherwise FALL THROUGH so the existing #4176
  proto-companion consult and undefined-miss still run (inherited names must
  keep answering).
- **Instance arm in `__carrier_bag_of`** (`carrier-bag-visibility.ts:314-362`):
  third `arm(__is_instance_expando_carrier, __closure_bag_lookup)` after
  closure and vec. #4098's "inert alone" warning is honoured by shipping this
  IN THE SAME PR as S1/S2's write path — never alone.
- **Marker filtering — the leak `instance-tombstones.ts:69-77` predicted.**
  The tombstone marker is `bag[k] === bag` (self-referential entry). All three
  bag query natives must skip it (`$PropEntry` value = fieldIdx **1**;
  compare `ref.eq` against the bag):
  - `CARRIER_BAG_HAS` (fill at `carrier-bag-visibility.ts:382`): found entry
    whose value `ref.eq` bag → answer 0.
  - `CARRIER_BAG_GOPD` (:399): same → "not handled" null.
  - `CARRIER_BAG_PUSH_KEYS` (:431 loop): skip the entry.
  Safe for closure/vec carriers too: the marker is unforgeable (a bag is
  unreachable from user source), so the filter can never hide a real entry.

**S3 — enumeration merge (for-in, Object.keys, gOPN).** Extend
`buildClosedStructEnumerationArms` (`object-runtime.ts:6830-6891`): in
`returnNames` (:6870), between the declared-field pushes and
`local.get vec; return`, append
`buildBagPushKeys(ctx, { vecLocal, includeNonEnum, objLocal: 0 })`
(`carrier-bag-visibility.ts:233`) — with `includeNonEnum` threaded from the
caller (gOPN passes true). One edit serves all three surfaces
(`fillClosedStructEnumerationArms` :6975 for keys/for-in,
`fillClosedStructOwnPropertyNamesArms` :6893 for gOPN) — they share this
builder by design. Declared names first, bag keys after: matches
OrdinaryOwnPropertyKeys for the dominant ctor-fields-then-expandos lifecycle
(interleaved-insertion ordering infidelity is a documented bounded divergence).
The for-in **per-visit liveness** half (#3920's receipt at
`object-runtime.ts:6686-6693`: fixing the key source alone is measurably not
enough) is covered by S2's instance arm in `__carrier_bag_of` →
`__extern_has`'s existing bag consult answers the re-check.

**S4 — `in` / hasOwnProperty: zero new code.** `__extern_has`
(`object-runtime.ts:3145+`), `__hasOwnProperty` / `__object_hasOwn`
(`bagHasIfAbsent` at :3056) already consult `CARRIER_BAG_HAS`; S2's instance
arm + marker filter light them up. Tombstone screens already in place (own
mode :6678, hasProperty mode :6661-6674).

**Wiring.** Reserves: alongside `reserveCarrierBagVisibility` /
`reserveInstanceTombstones` (`object-runtime.ts:865-866`). Fills: add
`fillInstanceProps(ctx)` (predicate + get/set helpers) and
`fillClosedStructExternSetArms(ctx)` in **BOTH** finalize sequences —
single-source `index.ts:4452-4455` block AND multi-source `index.ts:6712-6715`
block, next to `fillClosedStructExternGetArms`. Missing the second site is a
silent provider-lane gap (the #2200 hazard class; the provider is a
multi-hundred-KB single unit but A/B instruments and future multi-source
providers exercise both paths). Order: after `fillInstanceTombstones` (arms
bake its call), before `unshiftExternGetProtoCacheArm` for the get-side wrap.

### (c) Deliberately OUT of scope

- **Builtin-receiver expandos** (`new Date().foo = 1`, RegExp/Error) — #4010
  matrix rows 4-7; needs a builtin-carrier predicate + bag arms; separate PR.
- **Full descriptor MOP on instances** — `Object.defineProperty` /
  gOPD-synthesis for declared fields is #4098 stage 3; this issue adds no gOPD
  arm beyond the (already-present) bag gOPD + marker filter.
- **#4098's broader matrix** (subclassing cells, resurrect-then-define, …) —
  this ships its stage 2 + the for-in/`in` slice of stage 4 only.
- **Static-read tombstone coherence** (`o.foo` compiled as `struct.get` after
  `delete`) — pre-existing documented divergence, unchanged.
- **`err.pos` marshalling** (`e.pos` reads as non-number through the eval
  boundary — observed in probes) — cosmetic, separate.
- **The class-family eval failures** (super / new.target / private names /
  null-derefs, A5) — #2928 Phase 2 territory, zero coupling to this substrate.

### (d) Edge cases

- **Bag can never shadow a declared field**: writes to declared names
  write-through (S1 returns before the bag arm); reads answer declared arms
  first. The −684 mechanism (write refused by read-lane, deposited invisibly)
  is structurally excluded; the builtin-fn refusal arm stays at the head.
- **Type-mismatched write-through** (`n[k] = "str"` into an f64 field): the
  `ref.test` guard misses → **silent no-op return** (today's behaviour),
  NOT a bag deposit — a bag deposit would read back shadowed by the struct
  field and resurrect the −684 shape. Bounded divergence; note in module
  header. Acorn's copyNode writes are same-typed, so it never hits this.
- **Inherited vs own in for-in**: the instance enumeration arm returns own
  keys only (declared + bag) and does not walk to prototype objects. For
  acorn nodes this is faithful (Node.prototype carries no enumerable props on
  the hot path); documented bounded divergence otherwise.
- **Deleted keys**: declared-field arm skips tombstoned names
  (`buildTombstoneSkip` already in `buildClosedStructEnumerationArms:6848`);
  bag queries skip the marker (S2). Resurrection: S1 step 1.
- **Identity / ref.eq**: bag keyed by instance identity; no wrapper or bag
  allocation on ANY query path (lookup-only). `for (p in x)` on a fresh
  instance allocates nothing (`__carrier_bag_of` → lookup → null).
- **Provider self-compile (the #2200-discovered hazard class)**: the
  interpreter's `this.loops[i] = ctx` element stores were silent no-ops under
  provider self-compile — the SAME defect family this issue fixes. (a) Do not
  revert `installLoopCtx`; (b) any new emitter code keeps avoiding
  element-store idioms on class-field vectors until S1 is proven under
  self-compile; (c) after S1, re-run the #2200 probe matrix — S1 plausibly
  fixes the underlying compiler defect recorded as #2200 follow-up 1.
- **Instrument discipline**: never validate with literal `eval("...")` (A2 —
  static-inline lane); use the provider-unit parse canaries
  (`.tmp/probe-4194/provider-parse-split.mjs` pattern) or the annexB files.
- **Optimize lane**: dogfood harness ships `-O3`; run the acorn compile probe
  once with `optimize: 3` to confirm wasm-opt keeps the arms (ordinary code —
  expected fine).

### (e) Verification

1. **Micro-probe table** (`.tmp/probe-4194/forin-lanes{,2,3}.mjs` — restated
   in (a)): class lane 101/2/1/101 → **111/3/11/111**; computed-writes 0 →
   **111**; both copyNode emulations 101 → **111**; fnctor control lane stays
   111 (and host lane byte-identical everywhere).
2. **Provider-unit parse canaries** (`provider-parse-split.mjs`, recompile
   ~3 min): `var {a}` / plain `catch({f})` / 2-lvl → **1 (ok)**; 1-lvl
   collide stays a raise but with stock-acorn's *"Identifier 'f' has already
   been declared"*, not "Binding rvalue"; `copy_fidelity` → **1111**. This is
   the issue's "A/B collapses on stock acorn with no source patch" criterion,
   measured at the parse layer.
3. **The 24 annexB files** (`baseline-scoped.mjs annexb24.txt`,
   `TEST262_FULL_RUNTIME_EVAL=1`, provider REBUILT): expected **24/24 flip to
   pass** — layers 2+3 are already proven end-to-end by the longhand oracle
   (`catch ({f:f}) {{...}}` eval passes on this branch), so parse is the only
   gate. If any file survives with a NEW error text, that is a distinct
   downstream divergence — file it separately, do not widen this PR.
4. **Controls (all must hold)**:
   - `language/eval-code/` (direct + indirect trees, scoped run): **zero
     pass→fail**.
   - #4071 bucket: `Object.keys(new Date(0)) === []`,
     `Object.keys(/ab/g) === []`, `getOwnPropertyNames(/ab/g).length === 1`
     (the #4098 V1/V2 controls) — builtin structs fail `isUserDeclaredStruct`
     and get no bags, so unchanged BY CONSTRUCTION, but measure anyway.
   - The 131-file class-eval list: pass count ≥ 61 (`class-eval.txt`).
   - Closure/vec carrier probes (#3468/#3537 families) unchanged — the new
     arms sit between vec and closure; both existing substrates answer first.
   - Full equivalence suite (host lane byte-neutrality).
5. **Provider rebuild discipline** (non-negotiable, measured on this
   container): esbuild both bundles → `node
   scripts/build-runtime-eval-provider.mjs` (**166-180 s**) after EVERY
   compiler-source change being measured; run with
   `TEST262_FULL_RUNTIME_EVAL=1` or the refusal tier answers with
   `dynamic code evaluation is not supported` — fake results both ways.
   `.test262-cache` in the worktree; `test262/` may be a symlink to the main
   checkout (runner resolves `TEST262_ROOT` relative to `tests/`).

### (f) Risks / gates

- **Oracle ratchet (#1930/#3273)**: all new code is finalize-time Wasm
  emission over `ctx.structFields`/`funcMap` — no checker queries; ratchet-safe.
- **`check:coercion-sites` / `check:loc-budget`**: new module
  `instance-props.ts` needs its own budget entries; the store-coercion arms
  copy `buildSetterStore`'s existing recipe (no new coercion-plan surface).
  Keep `object-runtime.ts` edits to the enum-arm append + two callsite wraps.
- **Hot-path cost**: `$Object` writes pay one `ref.test` + branch (read side
  already pays this shape); statically-typed member access never enters these
  helpers; queries allocate nothing when no bag exists.
- **Bag list contention**: instance expandos share the closure list
  (`$__closure_prop_head`, O(n) `ref.eq` walk). Acorn's hot node fields are
  flow-grown STRUCT fields (write-through, no bag), so bag traffic is
  plugin/edge only — but if provider timings regress (#3756 superlinear
  precedent), split instances onto their own head global first, hidden
  per-struct `$bag` slot second (layout change, #3927 interplay — follow-up).
- **merge_group-only gates**: PR-level test262 checks are designed no-ops;
  the standalone floor/net guards (#1897/#2097) and the per-SHA regression
  diff run only in the queue — expect the truth there, and treat an
  auto-park as signal (the #4055 v1 history of this exact surface).
- **Carrier-set blast radius**: `__anon_` shapes are included for
  one-authority coherence with #3920's enumeration arms; if the net guard
  implicates them, trim to class+fnctor (acorn needs only fnctor) and file
  the anon slice separately.

### Corrections to this issue's own text (fresh evidence, 2026-08-08)

- The "36 standalone records" split is stale: the **12 class-family files no
  longer exist as a shorthand population** (A5) — expected flips there: 0.
  The 24 annexB files remain, now failing readably (`Binding rvalue`).
- "no standalone eval can parse object destructuring shorthand" needs
  narrowing: the **static-inline lane** (#1163) compiles most literal evals
  without acorn; the defect bites only bodies routed to the runtime lane
  (annexB function-in-block, non-literal sources, future inline-refusals).
  The substrate defect itself is unchanged and measured (A1/A3).
- The three-layer stack: layers 2 (#2200 catch-ObjectPattern) and 3 (B.3.3
  cancellation) are landed and **verified working** via the longhand oracle;
  this issue's layer 1 is the sole remaining gate for the 24.

## Implementation notes (senior-dev, 2026-08-08) — what was built and WHY

Landed on `worktree-agent-aeb33418e4a262077` (= `origin/main` `cafb5bb7` +
session base `328cf887`, i.e. #4137's NaN-render fix + #2200 layers 2/3 +
#2929). New module `src/codegen/instance-props.ts`; call-site wiring only in
`object-runtime.ts` / `index.ts`; marker filtering + the third
`__carrier_bag_of` arm in `carrier-bag-visibility.ts`.

### The headline

**24/24 of the annexB `…-skip-early-err-try` files flip fail → pass**, measured
on the faithful lane (`runTest262File(…, "standalone")`, provider REBUILT on
this branch, `TEST262_FULL_RUNTIME_EVAL=1`). Tier line, quoted:

```
[test262-in-process] runtime-eval tier: INTERPRETER (key 76b68a30f881745b,
TEST262_FULL_RUNTIME_EVAL=1) — authoritative CI-comparable standalone tier (#2928 E7)
## pass=24 fail=0 other=0 total=24
```

The spec's prediction was exact: layers 2+3 were already working, parse was the
only gate, and the parse gate was `copyNode`'s dropped writes.

### Three places where the implementation departs from the spec, and why

**1. The get-side consult sits at the HEAD of `__extern_get`'s non-`$Object`
branch, not inside `buildVecOrClosurePropGetMissArm`'s two call sites.**

The spec named `object-runtime.ts:1732/1741`. Wiring only there covers class
instances and MISSES every fnctor instance that has a prototype:
`__fnctor_proto_start` answers non-null for those, so control takes the
proto-walk and a chain-exhausted miss lands on the body's tail (`:1902`), never
on the miss arm. **Acorn's `Node` is exactly that shape.** Since S3 makes the
enumeration surfaces list such an instance's bag keys, wiring only the miss arm
would produce a key that enumerates but reads `undefined` — a new silent
divergence, in the same change that exists to remove one.

Measured: the fn-expr-ctor `copyNode` emulation (`forin-lanes3.mjs`
`copyLoop`) is **101 with the spec's placement and 111 with this one**. The
placement is also strictly more correct — an own property shadows the prototype
chain (§7.3.2), and the bag holds own properties. Cost: one predicate call on
the non-`$Object` read path, which already pays several.

**2. Scalar stores are NOT type-guarded; they go through `coercionInstrs`.**

The spec said a type-mismatched write should be a silent no-op, reasoning that a
bag deposit would resurrect the −684. The second half is right and is preserved
(see the invariant below) — but "no-op" is not the only non-depositing option,
and it is the worse one. `n.count = "abc"` with a LITERAL key already goes
through `__set_member_count` → `coercionInstrs` → stores `NaN`. Making the
computed spelling no-op instead would have introduced a literal-vs-computed
divergence, which is the exact failure class this area keeps regrowing. Using
the single coercion engine also satisfies `check:coercion-sites` without an
allowance (the first cut hand-rolled `__unbox_number` and the gate correctly
refused it).

Measured on the `noShadow` probe: with the guard, standalone answered `111`
(struct value preserved) against host `110`; without it, standalone answers
`110` — **identical to host**.

**3. `__instance_prop_get` folds the tombstone screen into the marker filter
instead of calling `__instance_field_deleted` first.**

The spec listed a separate `__instance_field_deleted` screen as step (i). It is
the same test — both ask "is `bag[k]` `ref.eq` the bag" — so folding saves a
second walk of the bag list on the read path. It also WIDENS the screen
correctly: `__instance_field_deleted`'s carrier predicate is class-only by
design (#4098 owns it, and this change does not touch it), while an
`__fnctor_` instance can now carry a marker.

### The invariant that keeps this off #4055 v1's −684

Once S1's ladder matches a name **on a receiver whose struct type it matched**,
the arm **always `return`s** — storing, or REFUSING:

- immutable field (`struct.set` would not validate) — §10.1.9 OrdinarySet over
  a non-writable own data property is a no-op anyway;
- unrepresentable field kind (i64 / f32 / v128 / packed);
- brand-mismatched value into a typed-ref slot (the same `ref.test` guard
  `fillMemberSetDispatch` emits). Its guard-miss falls back to `__extern_set`;
  from inside `__extern_set`'s own prologue that would recurse, so refusing is
  forced here as well as correct.

So a declared name can never reach the bag ⇒ the bag can never shadow a struct
field ⇒ `Object.keys` can never list a name twice. Every refusal is byte-equal
to today's behaviour, since the write is dropped today too; they only remove the
option of the bag catching them. The name set is derived with
`exposedClosedStructFieldName` — deliberately the read ladder's own filter — so
the refusal set is a superset of the read lane's answer set for any receiver
that can own a bag.

Two consequences worth stating because they are NOT obvious:

- The write ladder does **not** skip `isOpenDescriptorShape` structs even though
  the read ladder does. Skipping them would let a declared name (`enumerable`,
  `value`) reach the bag on a receiver whose S3 enumeration arm ALSO lists it
  from the struct — a duplicate key. Covering them costs nothing and removes the
  case entirely.
- The write ladder's carrier screen is `isUserDeclaredStruct`, which is
  **stricter** than the read ladder's (the read ladder answers for `__Date`'s
  `timestamp`). That is safe precisely because a non-carrier can never obtain a
  bag: `(new Date(0) as any).timestamp = 5` falls through to the closure arm,
  which no-ops for a non-closure. Nothing is deposited, so nothing can be
  shadowed.

### Measurements

Micro-probes (`.tmp/probe-4194/forin-lanes{,2,3}.mjs`; 1 = `type`, 10 = `name`
expando, 100 = `start`; standalone lane, host lane byte-identical throughout):

| probe | before | after | target |
| --- | --- | --- | --- |
| class: for-in / keys / `in` / reads | 101 / 2 / 1 / 101 | **111 / 3 / 11 / 111** | 111/3/11/111 |
| class: computed writes `n[k] = v` | 0 | **111** | 111 |
| class: `copyNode` emulation | 101 | **111** | 111 |
| fn-expr-ctor: `copyNode` emulation | 101 | **111** | 111 |
| fnctor control lane | 111 | 111 | unchanged |

Provider-unit parse canaries (`provider-parse-split.mjs`, recompiled 202 s):

| parse(…) input | before | after |
| --- | --- | --- |
| `var { a } = {};` | raise | **ok** |
| `try{throw{}}catch({ f }){ }` plain | raise | **ok** |
| `catch ({ f }) {{ function f(){} }}` 2-level | raise | **ok** |
| `catch ({ f }) { function f(){} }` 1-level collide | raise | raise (correct — see below) |
| `catch ({ f: f }) {{ … }}` longhand | ok | ok |
| copy-fidelity (`prop.value.type` / `.name` after parse) | 16000000 (both parses raised) | **1111** |

Controls, A/B'd against this branch's HEAD by file copy (never `git stash` in a
worktree — `refs/stash` is one shared stack):

| control | before | after |
| --- | --- | --- |
| #4071 bucket: `Object.keys(new Date(0))` / `Object.keys(/ab/g)` / `gOPN(/ab/g)` / `gOPN(new Date(0))` | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 (unchanged) |
| #3537 vec carrier family (write/read/`in`/keys/length/delete) | 11111 | 11111 |
| #3468 closure carrier family (same round trip) | 11111 | 11111 |
| #4098 `delete o.f; o.f = v` round trip, computed spelling | 111 | **11111** |

Gates: `pnpm run typecheck` clean; `check:coercion-sites` OK (no net vocabulary
growth); `check:loc-budget` and `check:func-budget` OK with the allowances
recorded in this file's frontmatter; `check:oracle-ratchet` OK (+0 — the whole
change is finalize-time Wasm emission over `ctx.structFields`/`funcMap`, no
checker queries).

### Loose ends and things the next lane should know

- **`Object.getOwnPropertyNames(/ab/g)` answers 0 on this base, not 1.** The
  #3920 header and this spec's control both state 1. Measured 0 BEFORE and 0
  AFTER, so it is not a regression from this change — but the documented
  expectation is stale, and a control that "passes" by matching a wrong number
  is worth nothing. Someone should re-derive it.
- **The tombstone round trip is only fixed for the COMPUTED spelling.**
  `delete n.type; n.type = "U"` with a LITERAL key still leaves `"type" in n`
  false: the literal write goes through `__set_member_type`, which stores the
  slot directly and never sees the resurrect helper. That is the
  "static-read tombstone coherence" divergence the spec put out of scope,
  observed from the write side. Fixing it means teaching
  `fillMemberSetDispatch` to call `__instance_field_resurrect` too.
- **Bag list contention is unmeasured at provider scale.** Instance expandos
  share `$__closure_prop_head` with closures (O(n) `ref.eq` walk). Acorn's hot
  node fields are flow-grown STRUCT fields, so they take the write-through path
  and never touch the bag — which is why the provider build did not regress
  (183 s, in the spec's 166-180 s band). If a future workload does put many
  instances in the bag, the fix order is: own head global first, hidden
  per-struct `$bag` slot second.

### Verification results (senior-dev, 2026-08-08) — every control, measured

All standalone numbers from the faithful lane (`runTest262File(…, "standalone")`,
`TEST262_FULL_RUNTIME_EVAL=1`, provider REBUILT on the measured revision —
183 s AFTER / 180 s BEFORE, both canary-verified). Base for every A/B is this
branch's own HEAD, restored by FILE COPY (never `git stash` in a worktree).

| lever / control | before | after | verdict |
| --- | ---: | ---: | --- |
| **the 24 annexB `…-skip-early-err-try` files** | 0 / 24 | **24 / 24** | ✅ all 24 flip |
| `language/eval-code/` (347 files, direct + indirect) | ≤ 315 pass | 315 pass / 32 fail | ✅ **zero pass→fail** — all 32 AFTER-failures re-measured on the base: `pass=0 fail=32` |
| 131-file class-eval list | 61 pass | **62 pass** | ✅ ≥ 61, and one file flips |
| #4071 bucket (`Object.keys(new Date(0))`, `Object.keys(/ab/g)`, `gOPN(/ab/g)`, `gOPN(new Date(0))`) | 0/0/0/0 | 0/0/0/0 | ✅ unchanged |
| #3537 vec carrier family (write/read/`in`/keys/length/delete) | 11111 | 11111 | ✅ unchanged |
| #3468 closure carrier family (same round trip) | 11111 | 11111 | ✅ unchanged |
| equivalence suite (host byte-neutrality), shards 1–4 | — | no new regressions; 10 baseline failures now PASS | ✅ |
| `optimize: 3` (the dogfood harness's lane) | — | identical answers, 102,855 → 43,476 bytes | ✅ wasm-opt keeps the arms |

The one class-eval flip is
`language/statements/class/elements/private-setter-visible-to-direct-eval-on-initializer.js`.
The architect's A5 prediction of **0** flips there was very nearly right; the
list is otherwise `super` / `new.target` / private-name Phase-1 refusals, which
this substrate does not touch.

The 32 `language/eval-code/` residual failures are `new.target` (4), `super`
(6), `non-definable-global` (6), `var-env-*` (13), `realm`/`lex-env-heritage`
(2), `this-value-func-strict-caller` (1) — none in this family, all failing on
the base too.

Provider-unit parse canaries after the change: `var { a } = {}` **ok**, plain
`catch ({ f })` **ok**, 2-level collide **ok**, 1-level collide still a raise
(correct — stock acorn's own "already declared"), longhand ok, copy-fidelity
**1111** (was `16000000`, i.e. both parses raised).

### #2200 follow-up 1 — re-measured, and it is NOT fixed. But here is a better repro.

The task asked whether S1 fixes the "provider self-compile silently drops
index-store slot reuse" defect. **It does not.** Measured by appending the
idiom's minimal shape to the REAL provider source (so it compiles in the same
unit) — no revert of `installLoopCtx` needed, and none was made:

| canary (inside the provider unit) | correct | measured |
| --- | ---: | ---: |
| A `push("first"); pop(); push("second"); topLabel()` | 1 | **2** (stale slot) |
| I `findLabel("target")` visible ∧ `findLabel("popped")` gone | 11 | **0** (new ctx invisible AND stale one still found) |
| E reused slot must not expose the popped ctx's mutable array | 1 | **2** (stale) |

**What is new here is the isolation.** #2200 recorded that "a minimal
ordinary-compile probe does NOT reproduce" and told the next lane to A/B against
the provider build rather than a toy module. Running the *identical* canaries as
a toy unit — once plainly, once **under
`RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS`** — answers **1 / 11 / 1, correct, both
times**. So:

- the defect is **not** in the provider's compile options (the obvious suspect,
  now eliminated);
- it is a property of the provider **UNIT** — 462 KB of concatenated source —
  which points at something that degrades with unit size or cross-module type
  resolution, not at a flag;
- and `.tmp/probe-4194/slot-reuse-2200.mjs` + `slot-reuse-toy.mjs` are a
  self-contained A/B pair that reproduces it in ~220 s without touching
  `src/interp`, which is what #2200's follow-up was missing.

`installLoopCtx` must stay, and the `loops\[this\.loopTop\] =` grep must stay at
zero, until that is fixed.

---

      currently-passing files in the same clauses; report both — belongs to
      the flag-ON test262 run (next slice per the #3927 program).
