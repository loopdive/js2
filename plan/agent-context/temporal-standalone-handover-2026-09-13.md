# Handover — standalone Temporal (#5383), session of 2026-09-12 → 2026-09-13

Supersedes `temporal-standalone-handover-2026-09-12.md`. Covers slices S6 → S13
and the infrastructure incidents that shaped the day.

**Scope, unchanged from the owner directive of 2026-09-07:** a real `Temporal`
global for `--target standalone`, standalone only. No host-lane work.

## The one-paragraph state

The `Temporal` global under `--target standalone` is the unmodified
`@js-temporal/polyfill` (+ `jsbi`), compiled by js2wasm to a separately linked
provider; nothing is re-implemented. Every slice fixes the COMPILER so the
polyfill compiles and behaves under standalone — the polyfill is the corpus that
exposes general codegen defects. The linked test262 lane (three families ×
120 rows: `Temporal/PlainDate`, `Temporal/Duration`,
`Temporal/ZonedDateTime/prototype`) went **0 → 177/360** with **0 pass→fail at
every step**. On `main` today: 170/360 (through S11). S12 is open and parked
as collateral of a main-side floor breach (below); S13 is complete and local.
The artifact is still OPT-IN in CI (#5407, link cost → default-on, is not
started). Acceptance criterion 4 of #5383 is therefore still open.

## Slice table (this session)

| slice | root cause fixed | lane delta | PR |
| --- | --- | --- | --- |
| S6 | `Object.prototype.toString` for a value that crossed the link (#5406) | — | #5864 → landed via #5875 |
| S7 | `__to_primitive` early-out lacked the `$Symbol` arm; module with `eval` + provider refused at init (#6432) | 0 → 44 | #5870 → landed via #5875 |
| S8 | composed RegExp patterns (template literal / `[…].join`) folded to the native engine (#5404) | 44 → 85 | #5875 (merged) |
| S9 | table-free `Intl.DateTimeFormat` for UTC / `Etc/GMT±N` in the provider shim (#6442) | 85 → 122 | #5885 (merged) |
| S10 | native `concat`/`sort` arms for `any`-receiver Array calls (#6447) | 122 → 139 | #5896 (merged) |
| S11 | a dynamic class object answers `.prototype` (#6457) | 139 → 170 | #5900 (merged) |
| S12 | static arity for a spread from a `const` array binding into `new` (#6460) | 170 → 170 (bucket moved, rows die one step later) | #5909 (open, held — collateral) |
| S13 | `Object.create(<value>.prototype)` produces a compiled instance (#6464) | 170 → 177 | branch `issue-5383-standalone-temporal-s13`, PR not yet opened (GitHub outage) |
| S14 | ONE dynamic `new <value>()` in the harness poisoned every provider value (#6479) | 177 → 199 | branch `…-s14`, stacked on S13, unpushed (GitHub 403) |
| S15 | array-HOF callback asserted a nullable element non-null — the `sn()` bucket (#6480) | 199 → 201 | branch `…-s15`, stacked on S14, unpushed |
| S16 | null native-string element binding truthiness; `void 0`/`undefined` comparison (#6481, #6482) | 201 → 202 (`sn()` bucket fully retired) | branch `…-s16`, stacked on S15, unpushed |
| S17 | the link was ONE-DIRECTIONAL: runtime-installed reverse channel so the provider can read a consumer-built bag (#6478) | 202 → 232 (solo-corrected 233) | branch `…-s17`, stacked on S16, unpushed |
| S18 | provider can CALL a method on a consumer-owned receiver — the reverse method-call hop (#6483); the `called value is not a function` bucket is TWO defects, neither at S17's guard | 232 → 232 (PlainDate 93 → 93, 0 flips; bucket did not move — criterion 4 NOT met for this slice) | branch `…-s18`, stacked on S17, unpushed |
| S19 | diagnosis only, no compiler change: the consumer→provider half is NOT at the link — every dispatch layer is correct and `Duration.from`'s body (`sn()`) returns null on its own; ends at the polyfill's intrinsic registry, `new (ce("%Temporal.Duration%"))(1)` fails its own brand check in ONE module. Three single-module reductions filed as #6484 | — (not measured, tree byte-identical to base) | branch `…-s19`, stacked on S18, unpushed |
| S20 | host-free dynamic `new (<call>)(…)`: no arm matched, fell to a nonexistent host import and emitted `ref.null` without evaluating the arguments (#6485) — the "brand check" clause was wrong, no instance was ever created. Lane restarted once (container restart, WIP salvaged from disk) | 233 → 245 (Duration 56 → 64, ZDT 84 → 88; 12 fail→pass, 0 pass→fail) | branch `…-s20b`, stacked on S19, unpushed |
| S21 | per-name method ladders (`__call_m_*`, `__call_toString`/`valueOf`) tested class by STRUCTURAL `ref.test`, so field-less WeakMap-state classes all matched — the #4618 `__tag` guard now applies to them via `class-arm-tag-guard.ts` (#6486) | 244 → 249 (94/65/90; 0 pass→fail; `Duration.from("P1Y").toJSON()` → `P1Y`) | branch `…-s21`, stacked on S20b, unpushed |
| S22 | `Object.getPrototypeOf(<runtime-only callable>)` answered null in standalone; now `__is_callable ? Function.prototype : __getPrototypeOf` (#6487) — the 7 rows were `*/builtin.js`, NOT the gOPD descriptor residual | 249 → 256 (96/68/92; 0 pass→fail) | branch `…-s22`, stacked on S21, unpushed |
| S23 | fourth `called value is not a function` cause: `n.toPrecision(a)` on a number PRIMITIVE through an `any` receiver — `__extern_method_call` had no primitive-receiver arm (#6488, `number-primitive-method-call.ts`); the candidate list in the brief was wrong, the instrument-the-sites method was right | 258 → 271 (97/77/97; 0 pass→fail; bucket 10 → 0) | branch `…-s23`, stacked on S22, unpushed |
| S24 | dynamic `new NS.wide(…)` above arity 8 (`MAX_NATIVE_CONSTRUCT_ARITY`) emitted null without evaluating args (#6489) — upstream of the `expected a string, not null` bucket (9 → 0). Lane restarted once (container restart; WIP commit + partial TSVs salvaged). `const C = NS.wide; new C(…)` → null is a DIFFERENT, arity-independent residual, pinned | 271 → 300 (101/97/102; 0 pass→fail; 29 fail→pass) | branch `…-s24b`, stacked on S23, unpushed |
| S25 | dynamic `new <value>` had no IsConstructor step — `new` on a method/arrow/builtin did not throw TypeError (#6490, `construct-is-constructor-guard.ts`); `not-a-constructor.js` is 123 files under Temporal and 536 corpus-wide, so the "4 rows" sized the sample, not the defect. Lane restarted once (WIP + all four family TSVs salvaged) | 300 → 304 (103/99/102; PlainDateTime 104 → 106; 0 pass→fail; one fail→pass in `language/expressions/new/` must-not-move, same defect) | branch `…-s25b`, stacked on S24b, unpushed |
| S26 | a heterogeneous ARRAY LITERAL trapped at CONSTRUCTION: element zero's closed struct carrier was guard-cast onto a string/number/boolean/vec sibling, and `ref.as_non_null` on the null answer dereferenced a null pointer (#6491) — the gap #4289's own doc comment names and declines ("another widening's business"), with no other widening. BOTH of the brief's named hypotheses were wrong: `__class_construct_dispatch` discriminates by IDENTITY not structurally (its illegal cast is a hard `ref.cast` in `externArgCoercionInstrs` for a formal typed by inference from its default), and the `__closure_N` null bucket is ≥2 mechanisms, the larger not a closure defect at all | 410 → 411 (104/99/102/106; 0 pass→fail; 1 of 38 message buckets moves, 7 → 6; 604 must-not-move rows, 0 flips) | branch `…-s26`, stacked on S25b, unpushed (GitHub 403) |

Fix commits also on main: the speculative-rollback gate fix on S2m (9501ffca13),
the `test262` gitlink restoration (#5892), the revert of #5871/#5882 (#5914).

## Attribution lesson (seven of eight slices)

S9→S13 were each handed a bucket attributed to the link boundary (#5406) and
each found the defect in module-local standalone codegen instead, reproducible
in ONE standalone module with no provider. S12 was handed a module-local
attribution and found the residual was cross-module. **The census decides;
reduce in a single module first, cross the link only if that passes.**
S14–S16 repeated the pattern (all module-local). S17 was the first slice where the
boundary attribution held — and even there the three NAMED mechanisms were all
wrong; the miss was on the provider side, which had no peer at all.

**Ids 6474–6477 collided with main** (hand-picked while `--allocate` could not
write): S14–S16 were renumbered to #6479–#6482 and merged forward S14→S17;
`check:issue-ids:against-main` is green on S17. Always `--allocate`; if the write
fails, `--check` + the gate before committing.

## Remaining buckets (post-S17 sample, 120 fail pooled) and the next census targets

- `called value is not a function` **15** — two defects. (a) provider calls
  `o.m()` on a consumer carrier: FIXED by S18 (#6483). (b) consumer calls
  `Temporal.Duration.from("P0Y")` on a provider receiver: a literal-named member
  call takes a per-name `__call_m_<name>` dispatch path with no link-boundary
  arm — REFUTED by S19 (the "works" rows were `typeof null`). Real end: the
  provider's intrinsic registry — `new (ce("%Temporal.Duration%"))(1)` yields an
  instance that fails its class's brand check; single module, no link. S20
  FIXED by S20 (#6485) — the real cause was `new (<call>)(…)` with no dynamic-new
  arm. Next: a method call by name on a statically-unknown receiver resolves
  through a per-name ladder with NO runtime class test and takes the
  LAST-DECLARED class declaring the name (`f(new A())` → `"UB"`); in the
  provider `Duration.from("P1Y").toJSON()` → *invalid receiver*, `toString()`
  → `Number.prototype.toString`. FIXED by S21 (#6486). Two homes of the same
  defect remain: the `__call_@@toPrimitive` ladder (entries carry no struct
  name) and same-shaped OBJECT LITERALS (no `__tag`). S19's #6484 A/B/C
  (`C[k](…)` foldable-key arg shift; `o[k](a)` → null; class-derived method
  value `b.g()` → null) follow.
- post-S21 top buckets: `prototype Expected SameValue(«null», «[object Function]»)`
  **7** (a prototype-descriptor read — the S11-era `gOPD(K,"prototype")` residual;
  FIXED by S22 — it was `Object.getPrototypeOf(Temporal.X.compare)` in
  `*/builtin.js`, not a descriptor read). Post-S22 (solo-corrected): `called
  value is not a function` 10 → **0** (S23, #6488) · post-S23 top: `expected a
  string, not null` 9 → **0** (S24, #6489). Post-S24: no dominant cause left in
  the 360-row sample — `Calling as constructor Expected a TypeError` 4 · `Proxy
  get trap is not callable` 4 · `illegal cast in __class_construct_dispatch()` 2
  · `Cannot read properties of undefined (reading 'equals')` 2 · the `const C =
  NS.wide; new C(…)` null residual. S25 fixed the non-constructor `new`
  (#6490). Post-S25, four families (480 rows, 70 residual rows in 40 buckets, 33
  of them ≤2 rows): `Proxy get trap is not callable` **6** · `dereferencing a
  null pointer in __closure_N()` **6** · `illegal cast in
  __class_construct_dispatch()` **4** (a wasm trap — plausibly S21's structural
  `ref.test` problem on the CONSTRUCT ladder). S25's lesson: size a candidate by
  its test262 family corpus-wide, not by rows in the Temporal sample. S26
  dispatched on the `illegal cast` trap + closure null pointer (branch `…-s26`,
  stacked on S25b). Standing: #5407 (link cost; the families now run solo at
  60 s, slowest cell 22.6 s) · `expected a string, not null` 8 · `Object method called on null or
  undefined` 6 · `Expected a RangeError but got undefined` 6 · `__closure_N()`
  null pointer 5 · `Calling as constructor` 4 · `Proxy get trap` 4. Of the 6
  `Object method called on null or undefined`, FOUR are `calendar-temporal-object`
  rows (PlainDate/compare, PlainDate/from, Duration/compare, ZDT/prototype/equals)
  — one error, invisible in sampled runs under the 15 s cap. Residuals: `toFixed`/
  `toExponential` via `any` receiver, `x.toString(16)` · `Missing internal slot slot-years` 7 ·
  `Object method called on null or undefined` 5 · `__closure_N()` null pointer 5 ·
  `Expected a RangeError but got undefined` 5 · `Calling as constructor` 4 ·
  `Proxy get trap is not callable` 4.
- Known residuals pinned by executable expectations: `typeof <provider
  instance>` = `"function"` (now also the cause of the 3 S17 pass→fail rows —
  RangeError instead of TypeError for a provider-owned wrong-typed `calendar`);
  cross-link `instanceof` false; `gOPD(K, "prototype")` miss; `const a = m[1]`
  checker-keyed dispatch traps; `new` with arity > 8; `slice/reverse/includes/
  splice/flat` on an `any` receiver; `PlainDate#add(bag)`/`#until(…, options)`
  answer `""`.
- Then #5407: link cost (linked/unlinked compile ratio 1.76–1.83×, 60 KB row
  at the 15 s budget) → make the artifact default-on in CI.

## Incidents worth knowing (all resolved unless stated)

1. **`test262` submodule replaced by a symlink** (dfecafa7e9, S6 grounding
   commit; reached main inside #5875 at 02:38 UTC). On runners the corpus path
   dangled and every shard-running merge_group died at collection in ~15 s
   with empty results; docs-only PRs kept main looking green. Fixed by #5892
   (gitlink restored at b363f29d3c). Guard: `git ls-tree HEAD test262` must be
   `160000`; the worktree harness keeps replacing it locally — `rm -rf test262
   && git checkout -- test262` before staging, never stage it.
2. **Two PRs merged unvalidated inside that window** — #5882 (issue-6416,
   `__extras_argv`) broke `super`/`arguments` spread rows; #5871 (issue-6412,
   async Promise carrier) broke 174 `for-await-of` rows with a compile error.
   The standalone high-water floor (#2097) caught the combined −157 only at
   12:34 UTC on S12's group. Reverted by #5914 (merged 13:46). The owning lanes
   must re-land with green shards. S12 (#5909) stays held until re-based and
   released once.
3. **New `speculative-rollback` gate** in `quality` flags raw `fctx.body.length
   = mark`; route through `snapshotSpeculative`/`rollbackSpeculative`.
4. **Provider cache is NOT keyed on the compiler.** `temporalProviderCacheKey`
   fingerprints polyfill source + shim + options only; after a codegen edit use
   a fresh `JS2WASM_TEMPORAL_CACHE` dir — the only tell is `cacheHit=false`.
5. **QuickJS eval provider needs two files**: `.test262-cache/quickjs-artifact-*/
   libquickjs.wasm` AND `.test262-cache/quickjs-eval-adapter-<hash>.wasm`, as
   real files (a `cp -a` of a symlinked cache into a reaped worktree reads as
   present and fails every row with a uniform Temporal-shaped error).
6. **Family samples at load ≲ 2**; concurrent lanes produce spurious
   compile-timeout CEs. Every CE↔fail flip must be re-run solo at 60 s on BOTH
   trees before it is reported.
7. **A backgrounded `git push` wrapper's exit status is not the push's**; a
   pre-push typecheck without `node_modules` fails silently. Verify with
   `git ls-remote`.
8. **GitHub write access expired at 14:25 UTC** (push → 403 with no
   Authorization header; GitHub MCP → "invalid session"). Reads still work.
   Needs a connector reconnect. At handover time S12's re-base, S13's PR, and
   this file are local-only.

## Process that worked

Fable writes the plan/brief, one Opus senior-developer lane at a time in its
own worktree (4-core spawn gate), census-first, one root cause per slice,
base by file-copy revert on the same tree, byte A/B with the `gc` lane
identical, full gate chain before every commit, PR stacked on the previous
slice, coordinator validates the head and opens the PR, queue shepherded
every 40 minutes.
