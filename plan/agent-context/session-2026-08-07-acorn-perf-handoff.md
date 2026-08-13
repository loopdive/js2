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
| #4216 | `__box_number` provability: DON'T BUILD; byte-ranked census; root-test CI coverage |
| #4218 | per-type baseline correction; `copyNode` retraction; #3920 as hard blocker |

Open at handoff: **#4217** (split default-ON, ejected once on a merge conflict
with #4218 and re-pushed), **#4219** (#3920 reflection fix), and the
constant-box-hoisting slice if it reports.

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

**The next slice is #4213's emission**, and it was **blocked on #3920** (below)
until PR #4219. The blocker was not incidental: a per-type-layout receiver is
*usually* dynamic — the analysis pins a single label only where exactly one is
provable — so every unpinned receiver took precisely the broken reflective path,
and **no differential could distinguish a correct split from a broken one**.

⚠ **RETRACTED, do not rebuild on it.** An earlier revision of this file blamed
#4211's silent wrong-AST divergence on acorn's `copyNode`
(`for (var prop in node) newNode[prop] = node[prop]`). Two independent
measurements disprove it — `for…in` yielded nothing, and `copyNode` executes
**zero times** on this corpus (0 of 25 sites). The three reflective passes #4211
wired did fix the divergence, but **the mechanism is unknown**.

Untouched by anything: **dynamic property lookup 13.5 % + call dispatch 8.1 %**.

## The reflection defect — #3920, and the shape of its fix

**Three of five reflective surfaces answered as if a compiled object had no
properties at all**, whenever its receiver arrived dynamically. Fixed in PR
#4219: objects yielding ≥1 own key went **15 / 32,506 (0.05 %) → 32,502 (99.99 %)**.

The discriminator was never the operation — it is the receiver's **static type**.
A statically-typed receiver never enters the dynamic runtime, so it passes on all
five; three break the moment the receiver is `any`. Testing the wrong spelling
makes the bug look absent, and that cost a full cross-lane disagreement.

| receiver | `Object.keys` | `in` | `for…in` | `hasOwnProperty` | `gOPN` |
| --- | ---: | ---: | ---: | ---: | ---: |
| statically typed | ✓ | ✓ | ✓ | ✓ | ✓ |
| `any` / laundered | **✗** | **✗** | **✗** | ✓ | ✓ |

**The trap, and the most transferable thing in this file: `Object.keys` was
correct on a builtin PRECISELY BECAUSE it was broken on user classes.** No
closed-struct arms ⇒ it enumerated nothing ⇒ and nothing is the right answer for
`Date`. So adding arms fixes the user-class case and breaks the builtin case *in
the same move*. That makes #4071's earlier revert **structural, not a tuning
failure**, and "build the user-declared-vs-builtin predicate FIRST, then share"
the only ordering that works. Reading the 3-for-3 helper split as "copy the
working three onto the failing three" ships the Date/RegExp leak.

Two corollaries worth keeping:

- **A leak was already live** through the one surface that had arms:
  `gOPN(/ab/g)` answered 7 internal RegExp fields, `gOPN(new Date(0))` answered 1.
  Both now 0. The `Date` row was on no record anywhere before this session.
- **Test both directions or the result is untrustworthy.** A regression test that
  only checks a user class passes while builtins silently start leaking.
- `isSyntheticStructName` is **not** that predicate and cannot be widened into it —
  it screens only `Wrapper*` / `$AnyValue` / `__vec_*` / `__arr_*`.

`status:` stays `in-progress`: a property first written *outside* a constructor
is not stored on the closed struct in **either** lane (#3537 expando storage), so
two acceptance criteria remain. Assertions encoding that as expected were removed
rather than pinned. Cost of the fix: binary **+2.11 %** — real, and correctness.

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
- **A passing reflective test proved nothing while enumeration was dead.** A
  differential reported "identical" across all 64 names and was comparing
  `undefined` with `undefined` — 15 of 32,506 objects yielded any key. It was
  nearly shipped as coverage. `cold-tail-differential.mjs` now reports
  `enumeratingNodes` and prints a loud `VACUOUS` warning; **always report the
  denominator.**
- **Fixing the obvious half looks like success.** Repairing the key *source* got
  `Object.keys` working and left `for…in` at zero — the loop re-checks every key
  it yields through a *second* helper that was also unarmed.

## Cross-lane coordination — what worked and what it cost

Three lanes ran concurrently on overlapping files. Four corrections came out of
the exchanges that **no single lane would have found**: the vacuous test, the
retracted `copyNode` mechanism, a probe-shape confound, and the
accidental-correctness trap. Every one changed what a fixer should do.

The cost was real too: three rounds went to settling a two-cell disagreement.
What finally converged it, named independently by both lanes:

- **Put the fixture IN the message, not a description of it.** Two summaries
  cannot settle a measurement disagreement; the symmetric run can.
- **Elimination narrows to the right hypothesis even when it finds nothing.** One
  lane ruled out structural canonicalization (its own leading theory), optimize
  level, class spelling, and its own branch — by swapping in `origin/main` blobs,
  not merely toggling its flag — which left "how the probes are written" as the
  only candidate standing. That is where the fault was.
- **The disagreement was a probe defect, not a measurement one**: one lane's
  `Object.keys`/`in` probes used a *typed* receiver while only its `for…in` probe
  laundered through `id(x): any`. Two different code paths reported as one
  contradiction.
- **Address agents by agent name, not claim slug.** Two lanes bounced repeatedly
  trying to reach `opus-forin` (a claim identity, unaddressable). Route through
  the coordinator when a name does not resolve.
- **Do not let a second lane rewrite a shared issue file.** Both lanes declined
  to edit a section the other had just written, recording their correction in
  their own file and asking the owner to fold it in — a correction merged into a
  conflict resolution is a correction lost.

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
- **#3920 was the real home** for the enumeration work, and is fixed in PR #4219
  (`status: in-progress` — two criteria remain, blocked on #3537).
- ⚠ **A `PreToolUse` hook fires on every merge advising "run equiv tests, create
  proof, then ff-only to main".** That contradicts `CLAUDE.md`, which is explicit
  that all merges go through PRs + CI and that `git merge` on main directly is
  never used. Every agent correctly refused; two escalated it independently after
  it kept firing. **Unresolved — needs a human decision**: either the hook is
  stale and should be fixed, or it is intentional and must come from a person.
  The risk is narrow but real: it is an instruction to bypass CI arriving with
  system authority, and it only takes one agent trusting it over the written rule.
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

---

# Update — 2026-08-12

**The allocation program described above is finished, and the picture has
changed.** Full detail is in #4157 under the four `2026-08-12` headings; this is
the short version so the next lane knows what is still true.

**Standing: still ~7× on `standalone-dynamic`.** The wins landed, but they moved
GC, not the total.

## What changed

| bucket | 08-07 | 08-12 |
| --- | ---: | ---: |
| gc-engine | 23.1 % | **2.97 %** |
| dynamic-lookup | 13.5 % | **21.15 %** |
| call-dispatch | 8.1 % | **11.39 %** |

GC went from largest bucket to ninth. `__extern_get` (9.22 %) is now the hottest
frame in the profile — ahead of every compiled acorn function. The two buckets
this handoff flagged as "untouched by anything" are now 32.5 % together, and are
the whole remaining addressable story. Of the 100.3 ms gap in the 08-08
cross-runtime table, ~9 ms is closed; helpers with no Node counterpart carry
about 55 % of what remains.

## Do NOT re-attempt (two more nulls, same helper)

The exhaustion list above grows by two, and this pair is stronger than the
others because they attack from opposite ends and both land on zero:

| lever | result |
| --- | --- |
| skip the declared-field ladder for plain-`$Object` receivers | null, ±0.3 pp |
| abstract-`eq` casts instead of RTT casts on the cache hit path | null, ±0.5 pp |

The first removed **14,770 instructions** of provably-dead work from the miss
path; the second removed two RTT checks from the hit path and shrank the binary.
Neither moved the bucket. **`__extern_get`'s 9 % is not made of instructions
removable from inside it** — at 21.7 ns / ~45 cycles per call, what is left is
call overhead, the props-array pointer chase, and branch behaviour. Do not spend
another A/B cycle on the body.

Both experiments are written up in #4157 in enough detail to rebuild; neither is
in the tree.

## The one thing that is priced above the measurement floor

**Site- or name-local inline caching — remove the CALL, not the work inside it.**

The numbers that make it the only live candidate:

- **506,752 `__extern_get` calls per parse**, **87.24 % served from the existing
  per-key cache** (#3673). First time that cache has been measured.
- Thrash (populated but owner/props missed) is only **3.77 %**, so "make the
  cache smarter" — N-way, shape-keyed — is priced out too.
- Serving 87 % of half a million calls from ~10 inline instructions instead of a
  call plus ~40 is worth **on the order of 5 % of runtime**.
- **1,812 static call sites**, but the top **15 callers carry 90.6 %** of the
  time — so inline at the hot callers, not everywhere (all 1,812 would cost
  roughly +40 KB). The selection rule must be corpus-independent for the same
  reason #3927's field ranking had to be.

What it needs: an entry-returning form of `__extern_get` (caching the *value* is
unsound — in-place value updates must stay visible, which is why the existing
cache stores the `$PropEntry`), per-name cache globals, and correct fallback for
accessor / tombstone / non-`$Object` receivers. Note the hot acorn names
(`locations`, `ranges`, `ecmaVersion`, `onToken`) get **no**
`__get_member_<name>` dispatcher today because no closed struct carries them —
which is exactly the condition for emitting a direct `__extern_get` call, so the
slice has to widen dispatcher reservation as well.

## Instrument note

**`JS2WASM_ALLOC_CENSUS_CALLS` is broken** — it instruments, then emits a module
that fails to compile with a stack-type error at an instrumented call. It fails
loudly rather than miscounting, but per-caller attribution is unavailable, and
that is the instrument the slice above wants for verifying its caller targeting.
The per-type census (`JS2WASM_ALLOC_CENSUS=1`) is unaffected. Not filed as its
own issue: `claim-issue.mjs --allocate` reports the open-PR scan DEGRADED in this
container (no `gh`), and reserving against a degraded universe is how #4215 was
burned.

## Still true from above

`#3920` (the `in`-operator / enumeration defect) and the known-red root tests are
unchanged. Wall-clock A/Bs under ~10 % remain unresolvable on this box — every
number here is bucket share with order-reversal controls.
