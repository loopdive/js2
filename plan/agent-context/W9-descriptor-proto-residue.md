# W9 — the descriptor family's "of prototype object" residue (2026-08-06)

**Agent**: `ttraenkler/W9-descriptor-proto-residue` (senior-dev, fable lane).
**Branch**: `issue-4187-standalone-hasown-delete-fold` (docs-only: this file +
`plan/issues/4187-standalone-hasown-const-fold-ignores-delete.md`).
**Issue filed**: #4187 (claimed on
`origin/issue-assignments`, pr_scan=degraded — `gh` absent in this container,
#4151; allocation used `--allow-unscanned`, CI id-gate backstops).

## Verdict first: the 44-file slice is SUBSUMED — do not implement it

| 44-file "-1 of prototype object" list (`.tmp/w9-list44.txt` in worktree `agent-a7cf4452a1666951b`) | pass |
| --- | ---: |
| `origin/main` (431ea77d55) | **0 / 44** |
| `origin/issue-4176-standalone-proto-named-keys` (W4's unmerged branch, PR body in `W4-proto-followups.md`) | **43 / 44** |

Instrument: W5's CI-aligned shimmed runner (runtime-eval provider shim per
#4162), compiler bundle + provider **rebuilt per tree** (cache keys differed
per build, confirming the instrument tracked the tree — both directions).
The 44 = the 54 failing `-1.js` variants minus 10 unrelated; brand split
Object 12 (Math/JSON/Arguments carriers) + 4 × {Function, RegExp, Array,
Number, Boolean, Date, Error, String} — exactly W5's census.

The brief's suspicion was right: **W4's #4176 per-brand named-key companions
ARE this slice's fix.** The three mechanisms compose on that branch: the proto
write lands (keep-arm), the carrier survives to the runtime applier
(reify pass-through), and ToPropertyDescriptor's `[[Get]]` consults the
receiver-brand companion. Any parallel implementation would be duplicate
work. **Priority action is landing #4176, not new code.**

## The 1 residue file — root-caused, filed as #4187, deliberately NOT fixed here

`15.2.3.6-3-86-1.js` (inherited `configurable`) fails for a reason unrelated
to proto chains: **the standalone `hasOwnProperty` const-fold ignores a
runtime `delete`.** Chain of evidence (all runtime-measured through the real
runner, then artifact-verified):

- delete works: post-delete `gOPD = none`, `Object.keys` empty,
  `Object.hasOwn(obj,k) = false`;
- `obj.hasOwnProperty(k) = true` — and in the **executed** wasm (dumped via an
  instantiate hook + `wasm-dis`) that spelling emits **no call at all**: it
  was constant-folded to true. `__hasOwnProperty` and `__object_hasOwn`
  bodies are byte-identical and truthful; the call site is the liar.
- Root cause is explicit in source: `object-ops.ts` ~4610 gates the #2726
  routing signals `!ctx.standalone`, with a comment saying standalone routing
  "awaits the sidecar-awareness substrate" — a substrate that has since
  landed (#1629 S6 native define, #4010 bags, #4098 tombstone screens, #6613
  closed-struct arms). The mode-agnostic signal covers only inline-literal
  descriptors; this test's descriptor is an identifier, and the #3663
  inherited-flag fold routes its define down the NoValue lane, so nothing
  routes and the shape-widened fold wins.
- Class size in the 558-file descriptor lever: **9** files with the
  define+delete+hasOwn shape (2 already fixed on unmerged #4180). Fix sketch
  (narrow delete-observed pre-scan gate, or re-measure dropping the
  standalone gate entirely) is in #4187.

Not fixed here because: single-digit yield, and the file it changes is a
three-way collision zone today — see next.

## ESCALATION for main: #4176 and #4180 CONFLICT in `src/codegen/object-ops.ts`

Verified with `git merge-tree --write-tree
origin/issue-4176-standalone-proto-named-keys
origin/issue-4180-descriptor-struct-reify` → **content conflict** (exit 1).
Both branches independently rewrote the same #2372 `emitDescriptorStructReify`
gate hunk:

- W4 (#4176): skip-list — `__vec_*` / `__StandaloneRegExp` / `__Date` pass
  through as externref;
- W5 (#4180): `isDescriptorTranscribableStruct` in new
  `property-descriptor-shape.ts` — a plausible-descriptor test (literal
  structs always transcribe; other structs only with a §6.2.5.6 field name;
  else pass through).

Whichever lands second needs a manual `[CONFLICT]` resolution. **Recommend
keeping W5's predicate** — it subsumes W4's skip list, fails closed on future
compiler-minted structs (W5's PR body argues this), and W5's measured +12 and
W4's measured +76 should both survive under it. The +43 measured above was on
W4's branch alone; re-measure the union after resolution (the 44-list runs in
~4 min on 4 workers).

## Instrument fidelity trap (cost me ~2h; #4187 records it too)

Local `compile(src, {target:"standalone", emitWat:true})` — even with the
runner's option flags copied — is NOT the executed artifact. The runner wraps
the test body inside `export function test(): number { try { … } }` with
hoisted vars and rewritten asserts (`wrapTest`, `fileName: "test.ts"`).
Lowering decisions (const-fold vs runtime call) flip between the two shapes; I
chased an "impossible" identical-functions-different-answers contradiction
until dumping the real bytes. Reusable tools in worktree
`agent-a7cf4452a1666951b/.tmp/`: `w9-child-dump.mts` (instantiate hook that
writes every module's bytes), `w9-run.mjs`/`w9-child.mts` (scoped A/B runner,
W5 lineage), `w9-wrap.mts` (approximate — do not trust it over the dump).

## What was deliberately left undone

- No fix for #4187 (reasons above; next actor should branch from whatever
  descriptor substrate has landed, per the predecessor-stacking rule).
- No re-measure of the 44 on the #4176+#4180 union (blocked on the conflict
  resolution).
- The W5-named sibling slices (typed-array own-predicate routing, Error/Math/
  JSON carriers, TypeError arms) remain as decomposed in
  `W5-descriptor-residue.md` — nothing here changes their sizing.
