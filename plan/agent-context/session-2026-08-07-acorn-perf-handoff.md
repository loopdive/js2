# Handoff — acorn performance lane, 2026-08-07

Goal for the session was "match Node on acorn parsing itself". It was cleared at
the end. This records where the work actually stands so the next lane does not
re-derive it.

**Standing: ~7.1× slower than Node on the `standalone-dynamic` lane, from ~8.1×.**
That lane is the only quotable one — `standalone`'s huge ratios are compile-time
folding of the parse, not speed.

## What landed

| PR | what |
| --- | --- |
| #4202 | first field the #743 inference program ever moved (`Scope.flags` → f64) |
| #4205 | ref/string consumer ABI: measured DO-NOT-BUILD |
| #4206 | local-variable typing spec: verified DO-NOT-IMPLEMENT |
| #4207 | ABI-parity diagnostic + rescue of an untracked module (see "process" below) |
| #4208 | regexp `.test` scratch reuse — −18.2 % of allocation *events*, ~0.4 pp |
| #4211 | hot/cold fnctor split, flag-OFF |
| #4212 | the `i31` lever is already spent; byte-ranked census; root-test CI coverage |
| #4213 | per-type layout **analysis** (no emission), flag-OFF |

Open at handoff: **#4216** (this PR — `__box_number` provability, DON'T BUILD),
**#4217** (split default-ON), **#4218** (per-type baseline correction).

## The one structural finding

**Every helper bucket the #4157 umbrella named has shrunk, and the total did not
fall proportionally — GC absorbed the difference and became the largest bucket
(18.5 → 23.1 %).** Allocation volume, not helper cost, is the binding constraint.

Then #4208 sharpened it: **allocation COUNT is the wrong denominator.** It removed
18.2 % of allocation events for ~0.4 pp, because those were the smallest objects.
Ranked by count × size, the AST node struct is ~77 % of all struct bytes.

## What is exhausted, and why — do not re-attempt these

The receiver-side type-inference route has now priced out **five** times, and each
negative is recorded with its number:

| lever | result |
| --- | --- |
| #4155 four receiver-side levers | null on wall |
| #4202 evaluator precision (3 rules) | 1 slot of 96 |
| #4205 ref/string consumer ABI | 1 candidate, **0 bytes** |
| #4206 local-variable typing | ≈0 movers, predicted and verified |
| #4216 `__box_number` specialization | 13.6 % of calls × ≲2 % of parse |

The cause is structural, not a missing heuristic: **acorn's types bottom out at
untyped exported-entrypoint parameters.** Each lever converts a handful of slots
and the values stay boxed.

Two of these are *permanently* closed, not "needs more work":

- **`i31` packing is already implemented** (`registry/imports.ts:1113-1160`) and
  99.31 % of the 556,923 `__box_number` calls per parse already take it. Only
  3,862 calls allocate, and **every one of them is the constant `Infinity`**.
- **The IR lattice cannot supply a second population** for integrality proofs: its
  `i32`/`u32` atoms come only from syntactic bitwise/shift producers, and anything
  a bitwise operator produced is *already* i32 at the emission point.

## Where the remaining work is

**Allocation, via struct layout.** Two techniques, both flag-gated:

- **#4217 — hot/cold split, now default-ON.** −28.3 % of all struct bytes,
  GC share −4.51 pp, ≈ −4.5 % wall. Its ranking is at the **static ceiling**: six
  corpus-independent proxies were scored against ground truth and none beat ~25 %
  tail rate, because the quantity being predicted (how often each node *kind*
  occurs) is a property of the corpus, not of the program being compiled.
- **#4213 — per-type layouts, analysis only.** 292 B → 98 B planned, with a **0 %
  residual rate** measured against ground truth (0 of 32,468 nodes overflow).
  Marginal gain over #4217's new default is **−30.7 %** (#4218 corrects the
  earlier −53.6 %, which was the combined figure quoted as marginal).

**These two overlap rather than compose on `Node`** — where a layout is proved,
the cold tail has nothing left to move. They are complementary *by verdict*: the
tail keeps its value on the `single-site` / `not-separable` / `no-sites` cases.

**The next slice is #4213's emission**, and its blocker is named: acorn's
`copyNode` does `for (var prop in node) newNode[prop] = node[prop]` — enumeration
plus a computed write — and it **never executes on this corpus** (0 of 25 sites).
So no amount of running acorn validates it. That is why #4213 stopped at analysis.

Untouched by anything: **dynamic property lookup 13.5 % + call dispatch 8.1 %**.

## Traps that cost real time today

- **The `generator` defect (#4217) was not the recorded suspect.** Hiding a carrier
  from the `ref.test` *arms* is correct; hiding it from the consumer-side narrowing
  *vote* is a bug. A boxed `true` was dragged through a number-unboxer: NaN → 0 →
  `false`, on all 32,506 nodes. It broke exactly one field of 64 because `generator`
  is the only ESTree name that is also a scalar slot on another constructor, and
  nothing structural diverged because the wrong answer was a constant `false`.
  **The same seam is worse for per-type layouts** — the vote's candidate set grows
  from one struct to N, and "this layout lacks the field" must not count as
  agreeing.
- **Census type numbering cannot be joined to `wasm-dis` indices** — `wasm-opt`
  renumbers types. This nearly recorded the node struct as 7 fields when it has 69.
  The census build prints shapes to stderr in the correct numbering.
- **Never pipe a command whose exit status or output you need.** A gate piped to
  `tail -3` hid its `FAILED` line and shipped a broken PR; a `tail -40` *inside* a
  command destroyed a 30-file measurement permanently.
- **A `.tmp/` instrument is not durable.** #4211's differential harness was gone by
  the time #4217 needed it, and rebuilding it consumed a large share of that slice.
  Both harnesses are now committed under `tests/dogfood/cold-tail-*.mjs`.
- **The main correctness differential is blind to standalone layout changes** — it
  runs in JS-host mode, where flow-grown fields are never native slots, and
  `JSON.stringify` returns `null` on closed fnctor structs.

## Process

- **Issue-id allocation is broken in this container.** `claim-issue.mjs --allocate`
  exits 6 twice over: the `fork` remote (`127.0.0.1:41729`) is unreachable, and
  the open-PR scan needs `gh`, which is not installed. Everything this session
  recorded went into existing issue files.
- **#4215 is a BURNED id — reserved, no file, permanently taken.** It was
  reserved for the `for…in` enumeration defect before a search found that bug
  already filed as **#3920** (`priority: high`, `sprint: current`,
  `status: ready`, whose Problem section already names it verbatim).
  `--release` undoes *claims*, not *reservations*, so it cannot be given back —
  the same hole that burned #3890/#3891. **Search `plan/issues/` for the
  symptom before reserving an id**; the allocator cannot tell you a bug is
  already filed under a different title.
- **#3920 needs an owner** and is the real home for the enumeration work.
- **A stale claim was force-taken.** #3927 was held by `ttraenkler/claude-fable-6`
  for >25 h with an empty branch, no PR, and that tier out of credits. Taken as
  `ttraenkler/opus-shape-split`. The fork-side assignment book was unreachable at
  the time, so "nobody was working it" rests on the books that could be read.
- **Two branches were rescued that had no PR and, in one case, no git object at
  all** — #4207's projection module and test existed only as *untracked* files in
  an ephemeral worktree. Both are inlined verbatim in the issue file. The tell was
  frontmatter carrying budget grants for edits that were not in the tree: the
  signature of a file-copy A/B whose restore step was skipped.

## Known-red on `main` at handoff

`tests/issue-3486-fnctor-constructor-identity.test.ts` and 4 in `issue-2608`,
verified pre-existing by swapping base blobs. See #3552 for why CI does not
surface these, and its still-open follow-up: detection exists (`issue-tests.yml`
post-merge), nothing consumes it.
