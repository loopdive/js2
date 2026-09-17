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
| S14 | ONE dynamic `new <value>()` in the harness poisoned every provider value (#6601) | 177 → 199 | branch `…-s14`, stacked on S13, unpushed (GitHub 403) |
| S15 | array-HOF callback asserted a nullable element non-null — the `sn()` bucket (#6602) | 199 → 201 | branch `…-s15`, stacked on S14, unpushed |
| S16 | null native-string element binding truthiness; `void 0`/`undefined` comparison (#6603, #6604) | 201 → 202 (`sn()` bucket fully retired) | branch `…-s16`, stacked on S15, unpushed |
| S17 | the link was ONE-DIRECTIONAL: runtime-installed reverse channel so the provider can read a consumer-built bag (#6600) | 202 → 232 (solo-corrected 233) | branch `…-s17`, stacked on S16, unpushed |
| S18 | provider can CALL a method on a consumer-owned receiver — the reverse method-call hop (#6605); the `called value is not a function` bucket is TWO defects, neither at S17's guard | 232 → 232 (PlainDate 93 → 93, 0 flips; bucket did not move — criterion 4 NOT met for this slice) | branch `…-s18`, stacked on S17, unpushed |
| S19 | diagnosis only, no compiler change: the consumer→provider half is NOT at the link — every dispatch layer is correct and `Duration.from`'s body (`sn()`) returns null on its own; ends at the polyfill's intrinsic registry, `new (ce("%Temporal.Duration%"))(1)` fails its own brand check in ONE module. Three single-module reductions filed as #6606 | — (not measured, tree byte-identical to base) | branch `…-s19`, stacked on S18, unpushed |
| S20 | host-free dynamic `new (<call>)(…)`: no arm matched, fell to a nonexistent host import and emitted `ref.null` without evaluating the arguments (#6607) — the "brand check" clause was wrong, no instance was ever created. Lane restarted once (container restart, WIP salvaged from disk) | 233 → 245 (Duration 56 → 64, ZDT 84 → 88; 12 fail→pass, 0 pass→fail) | branch `…-s20b`, stacked on S19, unpushed |
| S21 | per-name method ladders (`__call_m_*`, `__call_toString`/`valueOf`) tested class by STRUCTURAL `ref.test`, so field-less WeakMap-state classes all matched — the #4618 `__tag` guard now applies to them via `class-arm-tag-guard.ts` (#6608) | 244 → 249 (94/65/90; 0 pass→fail; `Duration.from("P1Y").toJSON()` → `P1Y`) | branch `…-s21`, stacked on S20b, unpushed |
| S22 | `Object.getPrototypeOf(<runtime-only callable>)` answered null in standalone; now `__is_callable ? Function.prototype : __getPrototypeOf` (#6609) — the 7 rows were `*/builtin.js`, NOT the gOPD descriptor residual | 249 → 256 (96/68/92; 0 pass→fail) | branch `…-s22`, stacked on S21, unpushed |
| S23 | fourth `called value is not a function` cause: `n.toPrecision(a)` on a number PRIMITIVE through an `any` receiver — `__extern_method_call` had no primitive-receiver arm (#6610, `number-primitive-method-call.ts`); the candidate list in the brief was wrong, the instrument-the-sites method was right | 258 → 271 (97/77/97; 0 pass→fail; bucket 10 → 0) | branch `…-s23`, stacked on S22, unpushed |
| S24 | dynamic `new NS.wide(…)` above arity 8 (`MAX_NATIVE_CONSTRUCT_ARITY`) emitted null without evaluating args (#6611) — upstream of the `expected a string, not null` bucket (9 → 0). Lane restarted once (container restart; WIP commit + partial TSVs salvaged). `const C = NS.wide; new C(…)` → null is a DIFFERENT, arity-independent residual, pinned | 271 → 300 (101/97/102; 0 pass→fail; 29 fail→pass) | branch `…-s24b`, stacked on S23, unpushed |
| S25 | dynamic `new <value>` had no IsConstructor step — `new` on a method/arrow/builtin did not throw TypeError (#6612, `construct-is-constructor-guard.ts`); `not-a-constructor.js` is 123 files under Temporal and 536 corpus-wide, so the "4 rows" sized the sample, not the defect. Lane restarted once (WIP + all four family TSVs salvaged) | 300 → 304 (103/99/102; PlainDateTime 104 → 106; 0 pass→fail; one fail→pass in `language/expressions/new/` must-not-move, same defect) | branch `…-s25b`, stacked on S24b, unpushed |
| S26 | a heterogeneous ARRAY LITERAL trapped at CONSTRUCTION: element zero's closed struct carrier was guard-cast onto a string/number/boolean/vec sibling, and `ref.as_non_null` on the null answer dereferenced a null pointer (#6613) — the gap #4289's own doc comment names and declines ("another widening's business"), with no other widening. BOTH of the brief's named hypotheses were wrong: `__class_construct_dispatch` discriminates by IDENTITY not structurally (its illegal cast is a hard `ref.cast` in `externArgCoercionInstrs` for a formal typed by inference from its default), and the `__closure_N` null bucket is ≥2 mechanisms, the larger not a closure defect at all | 410 → 411 (104/99/102/106; 0 pass→fail; 1 of 38 message buckets moves, 7 → 6; 604 must-not-move rows, 0 flips) | branch `…-s26`, stacked on S25b, unpushed (GitHub 403) |
| S27 | an object literal with a `get`/`set` accessor was NULL-DROPPED by the RETURN slot: the host `$Object` was guard-cast into the closed struct the checker infers from the accessor's return type, `ref.null` was stored, and the first read was a `struct.get` on null (#6614). The rule already existed — `functionReturnsHostObjectLiteralCarrier` — but is reached only from the two `ts.FunctionDeclaration` sites and only for source-file-level statements, so it fired for exactly ONE spelling of "a function that returns an object"; a method, arrow, function expression, class method, nested function and IIFE all trapped. `TemporalHelpers.toPrimitiveObserver` is the object-literal-METHOD row. S26's three-symptoms-one-shape reading resolved to TWO defects, not three: the null return and the "lost side effect" are the same one, and `[object Object]` is lane-INDEPENDENT (gc agrees) so it is out of a standalone slice | 411 → 419 (107/100/109/103; 0 pass→fail; 2 of 38 message buckets retired to ZERO). **Corpus-wide the two target families are 93 files and go 14 → 79 pass (+65, 0 pass→fail)** — the 120-file sample sees 8 of it | branch `…-s27`, stacked on S26, unpushed (GitHub 403) |
| S28 | the dynamic argument marshal answered the DECLARED type where the caller supplied a DYNAMIC value: `externArgCoercionInstrs`' ref arm emitted a non-null `ref.cast`, so a parameter typed only by its own default initializer (`cal = "iso8601"` ⇒ `string`) TRAPPED on `undefined` and on every wrong-typed value — killing the instance, so the spec-mandated TypeError the callee's own body would have thrown never ran (#6615). The brief's MECHANISM was right (first time in S9–S28 that an inherited attribution survived reduction); its suggested fix was not — an extern-carrier fallback cannot inhabit a `(ref null $string)` formal, and the established widening is keyed by `ts.Type` IDENTITY, which for `string` is shared with every string in the module. Three arms instead: `undefined` → typed null (the ref-lane twin of #5380's f64 sentinel, so the callee's own prologue runs the default), inhabiting value → the same cast, everything else → a catchable TypeError INSTANCE. Arms 1 and 3 are reachable ONLY where the cast already trapped, so 0 pass→fail is a proof, not a sample. The first cut moved NOTHING across the link and the tell was the prewarm stamp's byte count being identical to S26/S27's: the polyfill provider compiles no dynamic `new <value>` site of its own, so `exportsConsumedByWasm` needed its own post-bodies arming site | 419 → 423 (109/100/111/103; 0 pass→fail; 1 of 37 message buckets retired to ZERO; 356 must-not-move rows, 0 flips). **Corpus-wide the two target families are 13 files and go 3 → 13 pass** | branch `…-s28`, stacked on S27, unpushed (GitHub 403) |
| S29 | the known-callee ARGUMENT ABI was missing from four arms: a spread into a STATIC or OBJECT-LITERAL method bound the spread SOURCE as one positional argument (an inline array literal is a tuple struct, so those modules did not even VALIDATE), and a `static f(...rest)` formal arrived NULL with no spread at the call site at all (#6616). The two halves had to ship together — the spread half alone turns the forwarding shape from a wrong value into an UNCATCHABLE trap, measured in that intermediate state. The brief's mechanism was wrong in an instructive way: `typeof NS.PD.from.apply` IS `undefined` across the link, exactly as predicted, and it is irrelevant — `f.apply(…)` as a CALL never reads that member, and the dispatcher's `Cannot read properties of undefined (reading 'X')` names where the receiver was CONSUMED, not produced. The receiver was already undefined two frames up, in `TemporalHelpers.checkSubclassingIgnoredStatic(...args) { this.checkStaticInvalidReceiver(...args) }`. FIRST slice in the stack whose fix is deliberately NOT gated to standalone: the defect is lane-independent, so gc bytes move too (5 unarmed byte controls identical on both lanes bound it instead) | 423 → 423 (109/100/111/103; 0 pass→fail, 0 fail→pass; 6 of 57 residual rows move bucket, `reading 'apply'` 2 → 0; 270 must-not-move rows incl. the whole apply/call/bind + subclass corpus, 0 flips). **Corpus-wide the two target families are 61 files, 8 → 8 pass, and `reading 'apply'` goes 10 → 0** — the family moves from one failure to the NEXT. All **45** `subclassing-ignored.js` now stop on ONE assertion: `Object.getPrototypeOf(<instance from a linked provider class>)` is null (and `instanceof` across the link says "no" for a provider-minted instance, despite #5354) — the largest single-cause block left, reduced and ready | branch `…-s29`, stacked on S28, unpushed (GitHub 403) |
| S30 | the prototype LINK of a compiled class instance was invisible to every dynamic reader: the native `__getPrototypeOf` walks `$Object.$proto` and a class instance is a closed `$ClassName` struct, so `Object.getPrototypeOf(x)` answered **null** for any `x` the checker could not name — total across the link, where nothing has a checker type (#6617). Fixed by `__std_class_instance_proto` (the standalone twin of the host lane's #5347 dispatcher: `ref.test` + `__tag` + `ref.eq`, most-derived first, declines the class OBJECT) plus a `__js2wasm_link_get_prototype_of` boundary terminal, because only the OWNER can answer a `__tag` fact about its own struct. The terminal wraps the DISPATCHER, not the provider's `__getPrototypeOf` — the wider wrapper would publish the provider's `%Object.prototype%`, a foreign intrinsic. Verified against the REAL polyfill, not only synthetically: `getPrototypeOf(new Temporal.Duration(1)) === Temporal.Duration.prototype` is now true. The 45-file family STILL does not move, because a second cause kills the row two lines earlier — `construct.prototype` on a parameter reads `undefined`, and that read is CONTENT-SENSITIVE (answers `object` as soon as any other member read shares the module). Filed as #6617 R1 with six one-variable reductions | 423 → 423 (109/100/111/103; 0 pass→fail, 0 fail→pass; the 34-bucket message table identical count for count; 270 must-not-move rows incl. the whole prototype-MOP + instanceof + subclass corpus, 0 flips). **Corpus-wide the 45 `subclassing-ignored.js` are 0 → 0 pass, all messages byte-identical** | branch `…-s30`, stacked on S29, unpushed (GitHub 403) |

| S31 | the CALL-side twin of #6612's IsConstructor guard: a class VALUE reached through a PROPERTY-ACCESS method call (`ns.C()`, `ns` a linked provider's namespace) fell through `__extern_method_call`'s resolved-callee guard to `__apply_closure`'s legacy `null` instead of throwing TypeError — `C()` (#4483) and `const f = C; f()` (#6420) already threw, `ns.C()` did not (#6618). Fixed by one narrow arm in `resolved-callee-guard.ts`: throw when `__typeof_function() && !__is_callable()` — the two natives share every classifier arm except a class-constructor identity, so that conjunction can only be true for a class and stays silent (not a wrong throw) for anything the callable classifier fails to recognise, since `__typeof_function` shares the same base arms. Mirrors #6612's `__typeof_function`-narrowing discipline exactly, on the CALL side rather than the CONSTRUCT side | 423 → 426 (110/101/112/103; 0 pass→fail, 3 fail→pass — one `constructor.js` per moved family; 423 must-not-move rows across three groups, 0 flips). **Corpus-wide the 16 `constructor.js` files go 8 → 16, +8, 0 pass→fail.** Byte A/B is NOT a null control this time: the new arm lives in the shared `__extern_method_call` native's body, so three UNARMED controls (`f()` bare value, `ns.fn()`, `new ns.C(...)`) move by the same +42 B as the armed case — reported as collateral, not claimed as a null result; every `gc`-lane artifact stays byte-identical | branch `issue-5383-standalone-temporal-s31`, stacked on S30, worktree `agent-ad2753ab9922532ba`, commit `0728f3094e` |
| S32 | the f64 twin of #6615: `extern-arg-marshal.ts`'s f64 arm called `__unbox_number` directly with no guard, so a dynamic construct argument into an `f64` formal silently unboxed a Symbol/BigInt to `NaN` instead of throwing TypeError (§7.1.4 ToNumber) — `new Temporal.Duration(Symbol())`/`(0n)` (#6619). Fixed by `__unbox_number_checked`, mirroring #6615's `armExternRefArgTypeGuard`/`ForLinkedProvider` arming discipline exactly, gated by a new `moduleHasF64TypedConstructFormal` (mirrors #6615's ref-formal gate field for field). **This slice's PRIMARY probing budget went to #6617's R1 first** (the dispatch brief's designated target): reduced past the S30/S31 hand-off's six probes to a single precise trigger — ANY dynamic `new <any-typed-value>(...)` call anywhere in a module (not necessarily the same class) flips every dynamic `.prototype` read on a provider-linked class from `object` to `undefined`, traced to `sourceHasDynamicTaConstruct`'s (#2872) conservative whole-module TypedArray pre-scan arming `proto-index-store.ts`'s UNRELATED companion machinery via the shared `ctx.moduleUsesDynTaView` flag (roughly doubles `__extern_get`'s compiled body, 1,656 → 3,473 WAT lines) — but the exact key-specific wrong arm inside that machinery was not pinned down within budget, so per the dispatch brief's fallback clause the slice moved to the f64 target instead of an under-verified patch. R1 itself is UNCHANGED this slice (45 `subclassing-ignored.js` files stay 0 → 0) | 426 → 427 (110/102/112/103 — Duration 101→102; 0 pass→fail, 1 fail→pass — `Duration/invalid-type.js`; 231 must-not-move rows, 0 REAL flips — 22 raw diffs are a `JS2WASM_EVAL_ENGINE=interpreter`-only measurement artifact, not caused by this fix). **`Duration/from/invalid-type.js` is a DIFFERENT mechanism, unfixed** (object-literal property extraction inside the provider's own `.from()` body, never reaches this marshal) — filed as R-from | branch `issue-5383-standalone-temporal-s32`, stacked on S31, worktree `agent-a5bb4e4f194f460d4`, commit `2d2f277396` (WIP) |
| S33 | #6617 R1, finished: `ta-dyn-mop.ts`'s `__extern_get` `$__ta_ctor` receiver arm used a BARE `ref.test $__ta_ctor` — `{kind: i32, brand: i32}` — which WasmGC canonicalizes as structurally IDENTICAL to a field-less provider class's compiled root (`{__tag: i32, __shape_brand: i32}`, #2158/#2009), so once ANY unrelated dynamic `new <any>(...)` in the consumer armed `ctx.taCtorTypeIdx`, the arm misclassified `Temporal.Duration`'s class-object value as a TypedArray constructor and its "prototype" key check returned the wrong per-kind view-prototype glue instead of falling through to the correct `__js2wasm_link_member_get` boundary call (#6620). Bisected by forcing `ctx.moduleUsesDynTaView` with NO real construct in source (still broke) then disabling arms one at a time (disabling ONLY this one restored correctness with every other TA-dyn-view arm active). This EXACT collision shape was already discovered and fixed once — `taCtorIdentityTestInstrs`'s own doc comment (#5194 r3 review F1) measures the IDENTICAL symptom on `new qi.Duration(...)`/`new qi.PlainDate(...)` on this SAME provider — but that brand-VALUE-checked fix was applied at two OTHER call sites and missed this one. Fixed by routing this arm through the same helper | R1 fixed and verified (fix-witness error message moved from `undef` to `object`, the SAME `.prototype` read, in isolation and corpus-wide). **Corpus-wide the 45 `subclassing-ignored.js` files: 0 → 0 pass** — every one of them now fails at the NEXT assertion instead (`SameValue(«null», «null»)`, the ALREADY-DOCUMENTED `new construct(...)` residual S30's hand-off named — filed as R-construct, not reduced further this slice). A repo-wide grep found the SAME bare-`ref.test $__ta_ctor` pattern unguarded at 7 OTHER call sites (`dataview-native.ts` ×5, `property-access-dispatch.ts`, `ta-ctor-meta.ts` ×2) — none reduced to a concrete failing row this slice, filed as R-other-bare-ref-test | branch `issue-5383-standalone-temporal-s33`, stacked on S32, worktree `agent-aed1c0f7249eaba1d`, commit `df228b60da` |
| S35 | two independent root causes at the SAME structural-collision pattern, #6622: **Mechanism A** — `reflect-construct-native.ts`'s `__reflect_is_constructor`/`__is_native_reflect_target` each had a bare `ref.test $__ta_ctor` (every other site already routes through `taCtorIdentityTestInstrs`); the wrong `IsConstructor(instance)` answer fed the S11/S22 `typeof <provider instance>` = `"function"` residual. **Mechanism B** — `object-runtime-prototype.ts`'s `__isPrototypeOf` never seeded its walk from a class instance's link; fixed with `classInstanceIsPrototypeOfSeed`, reusing `__getPrototypeOf` per #6617 R2's own conclusion. Both verified against the real provider: `typeof (new Temporal.Duration(1))` flips `"function"`→`"object"`; `Temporal.Duration.prototype.isPrototypeOf(new Temporal.Duration(1))` flips `"no"`→`"yes"`. Session interrupted by a container restart after the fix landed but before the acceptance batteries ran; resumed same tree, same commit, fresh worktree — the interruption is why this row posts two measurement dates | 430/480 four-family (111/104/112/103; 0 pass→fail, 0 fail→pass) · **45-file `subclassing-ignored.js` corpus-wide: 0 → 0, NOT moved** — traced (not just observed) to a THIRD mechanism this slice found but did not fix: `checkSubclassConstructorUndefined`'s `Object.getPrototypeOf(result)` is a genuine real `null` when `result` comes from a Temporal method called on a `class MySubclass extends Temporal.X` instance — the method's return value loses its prototype link specifically for subclass receivers, distinct from Mechanisms A/B and from the `instanceof` residual. (The matching "null" in the harness's `SameValue(«null», «null»)` message is a stringification artifact, not a second real null — `String(construct.prototype)` itself prints `"null"` even though the object is real; corrects an earlier in-session draft that misread the pair as `«false», «true»`.) 1,634-row must-not-move (3 groups), 0 flips · corpus byte A/B: 0/42 `gc` moved, 14/42 `standalone` moved, all still `ok` · equivalence gate run to completion: 22/1720/22, unchanged | branch `issue-5383-standalone-temporal-s35b`, worktree `agent-ae83090ead799d8a4`, commit `fea60d2716` (fix WIP `4836b86615`, docs `e081699c86` + `9e29065dae` + `fea60d2716`) |

Fix commits also on main: the speculative-rollback gate fix on S2m (9501ffca13),
the `test262` gitlink restoration (#5892), the revert of #5871/#5882 (#5914).

## Stack state after the 2026-09-16 sync

The stack head is the S30 branch (`issue-5383-standalone-temporal-s30`, worktree
`agent-a85bfa9733f9bc958`), merged with `origin/main` at 66405a1244 (71 commits)
in 908f9aaebf. On that tip: typecheck, loc/func (also against origin/main — the
inherited `src/runtime.ts`/`buildImports` red is gone), coercion-sites,
oracle-ratchet, dead-exports, speculative-rollback, issue-ids:against-main,
update-issues — all green; `check:compiler-boundaries` red with
`inventory-valid-architecture-incomplete`, verified red on `origin/main` itself
(not the stack's). All 19 stack witness suites pass (83 tests; the #6607 pin
for residual 2 was flipped to its #6617-fixed answer in 778bcd006f).
Equivalence gate 22/1720 baseline. Pushes still 403 (since 2026-09-13 14:25);
the Opus weekly limit is exhausted until 2026-09-18 21:00 UTC, so S31 onward
run on a smaller model until then.

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
write): S14–S16 were renumbered to #6601–#6604 and merged forward S14→S17;
`check:issue-ids:against-main` is green on S17. Always `--allocate`; if the write
fails, `--check` + the gate before committing. **Second collision, 2026-09-15:**
with pushes blocked for ~40 h, `origin/main` took 6478–6483 too. The whole
S14–S26 stack was renumbered ONCE MORE, in order, to a far block
**#6478–#6491 → #6600–#6613** on the S26 tip (6516c62a30); the per-branch
issue files on S14–S25 still carry the old ids, so those branches cannot be
PR'd individually without the same renumber — land the stack from the S26 tip
(or replay `.tmp/renumber.py` per branch) once GitHub is back.

## Remaining buckets (post-S17 sample, 120 fail pooled) and the next census targets

- `called value is not a function` **15** — two defects. (a) provider calls
  `o.m()` on a consumer carrier: FIXED by S18 (#6605). (b) consumer calls
  `Temporal.Duration.from("P0Y")` on a provider receiver: a literal-named member
  call takes a per-name `__call_m_<name>` dispatch path with no link-boundary
  arm — REFUTED by S19 (the "works" rows were `typeof null`). Real end: the
  provider's intrinsic registry — `new (ce("%Temporal.Duration%"))(1)` yields an
  instance that fails its class's brand check; single module, no link. S20
  FIXED by S20 (#6607) — the real cause was `new (<call>)(…)` with no dynamic-new
  arm. Next: a method call by name on a statically-unknown receiver resolves
  through a per-name ladder with NO runtime class test and takes the
  LAST-DECLARED class declaring the name (`f(new A())` → `"UB"`); in the
  provider `Duration.from("P1Y").toJSON()` → *invalid receiver*, `toString()`
  → `Number.prototype.toString`. FIXED by S21 (#6608). Two homes of the same
  defect remain: the `__call_@@toPrimitive` ladder (entries carry no struct
  name) and same-shaped OBJECT LITERALS (no `__tag`). S19's #6606 A/B/C
  (`C[k](…)` foldable-key arg shift; `o[k](a)` → null; class-derived method
  value `b.g()` → null) follow.
- post-S21 top buckets: `prototype Expected SameValue(«null», «[object Function]»)`
  **7** (a prototype-descriptor read — the S11-era `gOPD(K,"prototype")` residual;
  FIXED by S22 — it was `Object.getPrototypeOf(Temporal.X.compare)` in
  `*/builtin.js`, not a descriptor read). Post-S22 (solo-corrected): `called
  value is not a function` 10 → **0** (S23, #6610) · post-S23 top: `expected a
  string, not null` 9 → **0** (S24, #6611). Post-S24: no dominant cause left in
  the 360-row sample — `Calling as constructor Expected a TypeError` 4 · `Proxy
  get trap is not callable` 4 · `illegal cast in __class_construct_dispatch()` 2
  · `Cannot read properties of undefined (reading 'equals')` 2 · the `const C =
  NS.wide; new C(…)` null residual. S25 fixed the non-constructor `new`
  (#6612). Post-S25, four families (480 rows, 70 residual rows in 40 buckets, 33
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
