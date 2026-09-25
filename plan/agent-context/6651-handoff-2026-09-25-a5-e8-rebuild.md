# #6651 handoff — 2026-09-25: A5 / E8 rebuilds suspended, next lever measured

Session `session_01FEGi3DmyPRPD5dx4kWU8hs`. Stopped at the user's request
("stop this lane, wrap up and open pr — the other will resume this").
Companion to
[#6651](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6651-es2015-standalone-100pct-execution-plan).

## Read these first

1. **Two slices are in flight as WIP PRs, both labelled `wip`** (so
   `auto-enqueue` will not take them). Their code is **pushed** — resume from
   the branch, not from a local worktree:

   | slice | PR | branch | pushed WIP |
   | --- | --- | --- | --- |
   | A5 — `yield` in computed keys; `yield*` inside a `for-of` body | #6101 | `claude/es6-test262-standalone-g10c7u` | _see PR head_ |
   | E8 — standalone `toLocaleString` value bodies + TypedArray helper | #6103 | `claude/es6-6651-e8-rebuild` | _see PR head_ |

   Each lane appended a `#### Suspended again — 2026-09-25` block under its
   slice in the #6651 file **on its own branch**: what is implemented, what was
   measured, which controls were not run, and the resume commands. Read that
   block on the branch, not on `main`.

2. **The plan lane that originally suspended A5 and E8 is dead** (confirmed by
   the user on 2026-09-25). Its unpushed commits `a80f49d064` / `215c200895`
   are unrecoverable; these PRs are rebuilds from the records it wrote. There
   is no twin to reconcile.

3. **Remove `wip` only after the controls pass.** Neither original lane nor
   this one had run the corpus controls for these slices when they stopped.
   The list is in each slice's record; the short form is: manifest
   before/after compared per path, compile-all byte differential on **both**
   targets with verdicts on every changed-bytes row, playground/benchmark byte
   identity, equivalence gate, `check:ir-fallbacks`, the family pin suites, and
   the slice's own pins red on the base.

## State of the goal at wrap-up

Measured from the 2026-09-24 baselines (standalone
`test262-standalone-current.jsonl`, host `test262-current.jsonl`, both fetched
with `--force` and checked by internal timestamp, not by exit code). Edition
classification by `scripts/generate-editions.ts`.

| ES2015 standalone | rows |
| --- | ---: |
| total | 11,704 |
| pass | **10,922 (93.32 %)** |
| non-pass | 782 |
| — cross-realm (`$262.createRealm` / `*-realm.js`) | 90 |
| — reachable | 691 |
| — reachable **and** already passing on host | 218 |

Per cluster manifest (`plan/agent-context/6651/*.txt`), realm rows excluded:

| cluster | reachable non-pass | of which host-pass |
| --- | ---: | ---: |
| A generators | 46 | 13 |
| B RegExp | 21 | 13 |
| C class / object / super | **127** | 20 |
| D Promise | 39 | 18 |
| E TypedArray | 81 | 40 |
| F Proxy / Reflect | 57 | 29 |
| G for-of / iterators | 86 | 22 |
| H builtins misc | 147 | 59 |
| I language misc | 87 | 4 |

**"Host passes" is not the same as "cheap".** Cross-realm rows pass on host
(it has real realms) and can never pass standalone, which is why they are
excluded above; several host-passing rows below are also blocked on
prerequisites unrelated to the port.

## The next lever, measured: `yield` inside a spread element (proposed A6)

**16 ES2015 rows, all `fail` on standalone AND on host** — so one fix to the
shared native generator lowering moves both lanes. The same family has 32
more rows in ES2018 and 24 in ES2022 (72 total, all non-pass on both lanes).

The shape, from `language/expressions/class/gen-method/yield-spread-arr-multiple.js`:

```js
*gen() { yield [...yield yield]; }
iter.next(false);
item = iter.next(['a', 'b', 'c']);   // the inner yield resumes with the array
item = iter.next(item.value);        // the outer yield resumes; spread must iterate it
assert.compareArray(item.value, ['a', 'b', 'c']);
```

It compiles today but resumes wrong: `Cannot access property on null or
undefined` (10 rows) or `value is not iterable` (6). The spread's source is a
suspended value that is not plumbed back as the thing to iterate.

The 16 ES2015 rows:
`language/{expressions,statements}/class/gen-method{,-static}/yield-spread-arr-{single,multiple}.js` (8),
`language/expressions/generators/{,named-}yield-spread-arr-{single,multiple}.js` (4),
`language/statements/generators/yield-spread-arr-{single,multiple}.js` (2),
`language/expressions/object/method-definition/gen-yield-spread-arr-{single,multiple}.js` (2).

**Sequence it after A5.** A5 creates `src/codegen/generator-yield-nested.ts`,
whose spec-order atom walk (each atom before the last yield is a yield,
REPLAYABLE, or CAPTURED once via `captureContinuationOperand`) is the natural
home for a `SpreadElement` atom. Building it in parallel with A5 would put two
lanes in the same new file. Host-probe first, as the method note in #6651 asks
— these rows fail on host too, so the probe is whether a host-lane fix exists
to port (it does not), not whether to bother.

## Levers checked and deliberately NOT taken

Recorded so the next lane does not re-derive them.

- **`Object.prototype.toString` refusal (#4119) — 16 rows, but not a lever.**
  9 of the 16 are TypedArray / ArrayBuffer rows whose real assertion is
  prototype identity, which does not hold yet; removing the refusal exposes
  those assertions rather than passing them. #4119 is `blocked` on #4449,
  #4490, #2375 and #2175, and a previous lane explicitly rejected the
  constant-tag shortcut. Of the other 7: 2 are Proxy rows (cluster F's) and 5
  fail on host too. Its claim record (`ttraenkler/dev-4119-g4`, 2026-08-03,
  branch gone) is stale, but the block is real.
- **B8, dynamic RegExp patterns — 5 host-passing rows.** Needs a runtime
  pattern compiler for the standalone engine. Small yield for a large
  mechanism.
- **D, `Promise_all/allSettled/any` host-import leaks — 6 rows.**
  `resolve-throws-iterator-return-is-not-callable` shapes fall back to a host
  import. They fail on host too, so admitting them natively is not known to
  pass them.
- **G, `GeneratorFunction` rows.** Most need `GeneratorFunction` built from a
  source string, which the plan already classes as eval-provider work
  (`__runtime_new_function` has no generator mode), not lowering.
- **The earlier `claude/es6-5198-regexp-exec-protocol` branch (+7 rows) is
  superseded.** All 9 rows it targeted — its 7 plus the 2 it declined — pass
  on `main` through cluster B's slices B2–B7. Abandon it; do not PR it.

## Environment facts

- The box has 4 cores. Two lanes running corpus controls at once saturate it
  (load 3.3); heavy commands were serialized with
  `flock /tmp/claude-0/t262.lock <cmd>`. Keep doing that with more than one
  lane.
- Disk is a fixed allowance: it reached 92 % used. Removing worktrees whose
  commits are all on `main` (`git log origin/main..HEAD` empty, clean tree)
  freed 8 GB. `git worktree remove --force` on those only.
- `gh` is not installed here; `claim-issue.mjs --allocate` therefore reports
  its open-PR scan as degraded and refuses. `claim-issue.mjs --check` and
  `pre-dispatch-gate.mjs` still work and are worth running.
- **A WIP PR is the claim the dispatch gate actually sees.** A pushed branch
  is invisible to it; an open PR referencing the issue is not.
