---
id: 4194
title: "standalone: a constructed instance has no expando substrate — for-in/Object.keys/`in` see 0 keys and a dynamic write is DROPPED; this is what makes compiled acorn reject `{ f }` destructuring in every eval"
status: done
completed: 2026-08-08
pr: 4232
assignee: "ttraenkler/fable-3927-emission"
sprint: current
created: 2026-08-06
updated: 2026-08-08
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
   sidecar expando, not the ctor fields). Not this slice's lane; recorded so
   the next host-lane pass starts from the current truth, not this file's
   old table.

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
  sees. **Pre-existing #3920-family enumeration residual on that receiver
  class — newly measurable precisely because the write half now works.**
  Whoever runs the flag-ON conformance pass should expect this class.

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
      currently-passing files in the same clauses; report both — belongs to
      the flag-ON test262 run (next slice per the #3927 program).
