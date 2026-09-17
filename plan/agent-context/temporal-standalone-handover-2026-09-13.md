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
| S36 | a NEW cross-module `__tag` collision (#6623): `class S extends <unresolved heritage>` (property-access into a linked namespace, or an identifier bound to a runtime parameter — test262's own `checkSubclassingIgnored(construct, …)` shape) compiles as an independent root struct; when field-less, its struct canonicalizes to the SAME WasmGC type as any other field-less class, and `standalone-class-instance-proto.ts`'s dispatcher disambiguates only by `__tag` — a per-module counter starting at 0 independently in every module. A consumer subclass can coincidentally share both shape AND tag with an unrelated provider class, so the dispatcher silently answers the WRONG (non-null) prototype for a genuine provider instance — worse than the `null` it should decline to. Fixed by `ctx.classDynamicUnresolvedHeritageSet`, excluding a flagged field-less class from the dispatcher's eligible list (declines instead of risking the false positive; #6620/S33 precedent). Does NOT move the 45-file headline — Duration's real tag does not collide with this specific test's lone `MySubclass`, so the base tree already declines for that pair; the headline's REAL blocker is traced to a THIRD, separate mechanism (`getPrototypeOf` on a dynamic METHOD CALL's return value, on an unresolved-heritage subclass receiver, does not reach the #6617/S30 link-boundary terminal the way a direct `new`/`.from()` construction already does) and is sized + filed in #6623, not fixed this slice | 430/480 four-family (111/104/112/103; 0 pass→fail, 0 fail→pass, unchanged from S35) · **45-file `subclassing-ignored.js` corpus-wide: 0 → 0, unchanged, byte-identical message set** · targeted synthetic probes: a receiver that never touches the colliding class flips from the WRONG `S.prototype`/`MySubclass.prototype` claim to a declined non-claim, both property-access and identifier heritage shapes · 1,649-row must-not-move (3 groups per the brief's exact spec), 0 flips, byte-identical `.tsv` diff · corpus byte A/B: 0/42 `gc` moved, 0/42 `standalone` moved (genuine null control) · equivalence gate: 22/1720/22, unchanged | branch `issue-5383-standalone-temporal-s36`, worktree `agent-a98e1ad0a40153323`, commit `0612e1a082` |
| S37 | `Object.isExtensible(<provider-owned value>)` answered `false` across the wasm<->wasm link boundary (#6624) — the FIRST assertion in every `built-ins/Temporal/*/builtin.js` file. `Object.isExtensible(v)` on an `any`-typed `v` compiles to the general (non-`_obj`) `__object_isExtensible` native, whose carrier-bag lookup recognises only four carrier kinds (vec/closure/error/#4194 instance-expando) via `ref.test` chains built from types the CONSUMER module itself registered. A value the PROVIDER minted (its class-object struct, or an instance of one of its classes) is a closed struct in the provider's own type space and, absent a structural accident, matches none of the consumer's four ladders, so the native fell to its non-object terminal (`false`). Reduced in the required order: single-module (no repro, oracle proves the class callable) → single-module `any`-indirection (no repro, the CONSUMER's own class is in its OWN ladder) → synthetic linked pair (repros for BOTH a class object and an instance) → real polyfill (confirmed, 9/129 `builtin.js` files). Fixed by a new `__js2wasm_link_is_extensible` boundary terminal, the same shape as #6617's `getPrototypeOf`: the provider forwards to its OWN already-correct `__object_isExtensible`; the consumer's `buildIntegrityPredicate` gains an optional `peerFallbackIdx`, threaded to exactly ONE predicate (`isFrozen`/`isSealed` untouched — no reported defect). ONE terminal fixes BOTH the class-object and the instance miss, a strict improvement beyond the assigned scope | corpus-wide, all 129 `built-ins/Temporal/**/builtin.js`: 120/129 pass both labels, 0 flips — all 9 failing files move PAST the `isExtensible` assertion to a later, already-documented residual (#6609's `getPrototypeOf(<class value>)` gap, mostly; `Now` moves to a DIFFERENT residual, `Object.prototype.toString`, being a namespace not a class) · four-family sample: 430/480 both labels (111/104/112/103; 0 pass→fail, 0 fail→pass) — an honest null, none of the 9 moved rows live in these families' first 120 files · provider bytes 3,311,638 B → 3,311,710 B (+72 B) · equivalence gate: 22/1720/22, unchanged · `tests/issue-66*.test.ts` (26 files / 122 tests incl. this slice's 5) all pass together | branch `issue-5383-standalone-temporal-s37`, worktree `agent-a0833b3654bad8722`, based on S36's FINAL tip `0612e1a082` |
| S38 | `Object.getPrototypeOf(<provider-owned CLASS OBJECT>)` answered `null` across the wasm<->wasm link boundary (#6625) — the exact residual S22/#6609 named and S37/#6624 confirmed as the blocker for 8/9 `builtin.js` files. `Object.getPrototypeOf(v)` on an `any`-typed `v` falls to #6609's dynamic dispatch, gated on `__is_callable`, which deliberately excludes class objects (no [[Call]]); the value then hit #6617's class-instance dispatcher, which explicitly declines a class-object identity match. Fixed by a new `__is_class_object` identity predicate (ref.eq against class-object singletons, never ref.test — a class object and its instances share one struct type and `__tag`) ORed into #6609's existing dynamic dispatch, plus a boundary-BOOLEAN (not value) terminal `__js2wasm_link_is_class_object` for the linked case — the value answered is always `Function.prototype` compiled on the caller's own side (S22's identity rule generalised). Scoped to base classes only (`ctx.classParentMap` filter); a subclass's answer stays unchanged (measured: an unfiltered predicate would have introduced a NEW wrong `true`, not merely left the residual unreduced). First cut was a separate function mirroring #6624's two-terminal shape; measured via `wasm-dis` to be minted but never called, because `tryEmitDynamicCallableGetPrototypeOf` returns `true` once its dispatch is emitted regardless of which internal branch fires, pre-empting any second sequential arm — folded into one function instead | corpus-wide, all 129 `built-ins/Temporal/**/builtin.js`: base 120/129, branch 128/129, 0 pass→fail, 8 fail→pass — exactly S37's named 8 files; `Now` (the 9th) unchanged, separate mechanism · four-family sample **completed to the full 480/480 spec in a follow-up measurement pass** (same tip, new worktree): 430/480 base → 433/480 fix, 0 pass→fail, +1 each in `PlainDate/builtin.js`, `Duration/builtin.js`, `PlainDateTime/builtin.js` (each sorts into its family's first-120 walk), `ZonedDateTime/prototype` unchanged — base reproduces S37's cited 111/104/112/103 exactly · must-not-move groups A/B/C completed same pass: 0 pass→fail across 1,804 rows (A/B exactly flat; C has one legitimate fail→pass, `class-definition-null-proto.js`, a correct `extends null` consequence of the fix's own design) · corpus byte A/B: 0/42 `gc` moved (confirms standalone-gating), 25/42 `standalone` moved, 0 CE/status flips · provider bytes 3,311,710 B → 3,312,720 B (+1,010 B) · equivalence gate: 22/1720/22, unchanged · `tests/issue-66*.test.ts` (27 files / 129 tests) all pass together (caught+fixed 2 stale #6617 assertions) | branch `issue-5383-standalone-temporal-s38`, worktree `agent-a4469f4a961812265`, based on S37's FINAL tip `783aaa3cbb`, WIP commit `665930876e`; follow-up measurement pass on branch `issue-5383-standalone-temporal-s38b`, worktree `agent-a59a9ea774b4522a7`, commits `4bef17b0e2` + `00001136f2` |
| S39 | audited #6620/S33's own `R-other-bare-ref-test` list — the remaining bare `ref.test $__ta_ctor`/`taCtorTypeIdx` receiver tests unfixed by #6620/#6622 (#6626): `dataview-native.ts` (5 sites: `emitTaCtorBytesPerElement`, `emitDynamicTaViewConstruct`, `emitTaDynCtorConstructFromLocals` ×2, `ensureTaFromArrayLikeHelper`), `property-access-dispatch.ts` (1 site, `$262.createRealm().global` receiver arm), `ta-ctor-meta.ts` (2 call sites, one the shared `isTaCtor()` helper reused at 5 `__builtinfn_get_meta`/`gopd`/`delete` splice points). All 8 now route through `taCtorIdentityTestInstrs`. Confirmed genuinely wrong on a purely LOCAL (no linking needed) field-less-class collision, by file-copy revert: `emitTaCtorBytesPerElement` — dynamic `.BYTES_PER_ELEMENT` on a tag-3 instance answered `2` (Int16Array's byte width) instead of `0`; `isTaCtor()` — dynamic `.prototype` answered `"object"` instead of `"undefined"`, `Object.getOwnPropertyDescriptor(x,"BYTES_PER_ELEMENT")` answered a real descriptor instead of `null`, `hasOwnProperty(x,"prototype")` answered `true` instead of `false`. The 3 remaining `dataview-native.ts` dynamic-`new ctor(...)` construct sites and the Realm site were fixed defensively (same answer-preserving pattern) but did NOT reproduce a wrong answer within this slice's budget — two reduction attempts (local field-less ctor value, linked cross-module provider ctor value, mirroring #6620's own harness) both answered correctly on base AND fixed `dataview-native.ts`, the exact mechanism that resolves them correctly not isolated | `tests/issue-6626-*.test.ts` (9 tests: 4 fix-witnesses, 5 controls) + full `tests/issue-66*.test.ts` suite (28 files / 138 tests) all pass together · **acceptance battery completed in a follow-up measurement-only pass (S39b, same tip, no `src/` changes)**: four-family sample 433/480 base → 433/480 fix, 0 pass→fail, 0 fail→pass (fully flat — the real polyfill's classes do not land on a colliding tag in these 4 families) · must-not-move groups A/B/C (S38b's definitions) **plus new group D** (`TypedArray`/`TypedArrayConstructors`/`DataView`, mandatory since #6626 touches TA-ctor identity directly): 2,004 rows total, 0 pass→fail, 0 fail→pass · corpus byte A/B: 0/42 moved on either target, 0 CE/status flips, provider bytes 3,312,720 B → 3,313,801 B (+1,081 B) · equivalence gate 22/1720/22, unchanged | branch `issue-5383-standalone-temporal-s39`, worktree `agent-a186b286db1775219`, based on S38's FINAL tip `ea2277af98`; follow-up measurement pass on branch `issue-5383-standalone-temporal-s39b`, worktree `agent-a889c03e3a2e34dff`, commit `9dd76f8a7a` |
| S40 | `Reflect.X(...)` (and 9 other well-known global namespaces — `JSON`/`Object`/`Array`/`String`/`Number`/`Symbol`/`Promise`/`Proxy`/`Intl`) must not seed the `numericFunctions` name-keyed oracle (#6627). A bare-identifier receiver `<recv>.m(…)` falls through to `sets.numericFunctions.has(m)` — "every visible function named `m` anywhere in the program returns a number" (#4122), sound for a genuine user instance but not for a static namespace call. This created a self-reinforcing fixpoint: an object-literal Proxy `get` trap (`get(target,key,receiver){ return Reflect.get(...); }`, the exact shape of `TemporalHelpers.propertyBagObserver`) seeds `numericFunctions` with `"get"` true; `Reflect.get(...)`'s own return then asks `numericFunctions.has("get")`, still true (the trap's own body hasn't been decided yet), so the trap's return stays numeric forever — its own single disqualifying use never removes it. Fixed with `NON_INSTANCE_GLOBAL_NAMESPACES`, a new exclusion set checked before the `numericFunctions` fallback. **Does NOT close the `Proxy get trap is not callable` bucket** — reduced to a 9-line linked-vs-unlinked repro (any package `link:`ed to the consumer at all flips the answer, regardless of whether `Reflect` is even used) with an unverified hypothesis: `ensureProxyRuntime`'s front-guard patch and `emitStandaloneLinkReverseLocalTerminals`'s `__extern_get` terminal-install both touch `__extern_get`'s identity/body in the same narrow window; which one clobbers the other was not pinned down (needs a WAT diff of `__extern_get`/`__proxy_get_dispatch`/`__module_init` between linked/unlinked builds of the repro — the next slice's first step) | `tests/issue-6627-reflect-namespace-numeric-inference.test.ts` (2 fix-witnesses, 3 controls) + full `tests/issue-66*.test.ts` (28 files / 138 tests) pass together · **acceptance battery completed in a follow-up measurement-only pass (S40b, same tip, no `src/` changes)**: four-family sample 433/480 base → 433/480 fix, 0 pass→fail, 0 fail→pass · must-not-move groups A/B/C/D (S39b's definitions, C reusing S39b's own 0:249 slice): 2,004 rows total, 0 pass→fail, 0 fail→pass · corpus byte A/B: 0/42 moved on either target (`gc` AND `standalone` — this fix is not standalone-gated), 0 CE/status flips, provider bytes unchanged (3,313,801 B, this fix touches only oracle inference, not codegen bytes emitted for the Temporal provider) · equivalence gate 22/1720/22, unchanged · the assigned 6-row bucket reproduces byte-for-byte unchanged (`Proxy get trap is not callable` on all 6) | branch `issue-5383-standalone-temporal-s40`, worktree `agent-a3729a08b14b90f31`, based on S39b's tip `9875b99735`; follow-up measurement pass on branch `issue-5383-standalone-temporal-s40b`, worktree `agent-ac138a7046842730e`, commit `66acff773f` |
| S41 | Traced the `Proxy get trap is not callable` mechanism past both of S40's named suspects (structurally byte-identical between linked/unlinked builds) into `fillApplyClosure`'s #6420 "peer-owned callable" front-guard (`object-runtime.ts` ~7766): it queries the linked PROVIDER "is this externref `[[Call]]`-able?" for EVERY value `__apply_closure` invokes, and under `canonicalRuntimeTypes` a purely LOCAL closure's WASM shape is structurally indistinguishable from the provider's own, so the provider's `ref.test`-based `__is_callable` wrongly answers "callable" and `__apply_closure` hijacks the call into the provider's own (unusable) apply terminal — confirmed with a WAT trace and a side-effect witness proving the trap body never runs. Fixed (#6628) for the direction S40's 9-line repro exercises: `fillProxyDispatch`'s trap-invoke drivers now call `__call_fn_method_<argCount>` directly, bypassing `__apply_closure` entirely, when the Proxy dispatch runs in the SAME module that built the trap. Two earlier attempts (a structural "is this locally owned" `ref.test` gate on the SHARED `__apply_closure`, tried against both the deduped closure-root list and the full per-site closure-type list) regressed `tests/issue-6605-*`/`tests/issue-6616-*` identically — `canonicalRuntimeTypes` makes that ambiguity undecidable on the shared function; fixing the call site instead sidesteps it. **Does NOT close the bucket**: the real corpus row is the OPPOSITE direction — the CONSUMER builds a Proxy and hands it to the PROVIDER, which reads a property on it from inside its own module; the trap found is unavoidably the consumer's, so the provider genuinely needs the OLD peer route this fix bypasses. A targeted reduction of exactly that shape (provider method reading a property on a parameter that is a consumer-built Proxy) throws an uncaught `WebAssembly.Exception` identically on BOTH base and fix — pre-existing, not a new regression, and the bucket's real remaining blocker | `tests/issue-6628-*.test.ts` (3 fix-witnesses, 4 controls) + full `tests/issue-66*.test.ts` (30 files / 150 tests) pass together · four-family sample 433/480 base → 433/480 fix (112/105/113/103 per family), 0 movement · corpus byte A/B (42 files × {gc,standalone}): 0 CE/status flips, 6 `standalone`-target SHA changes from `ensureProxyRuntime` being unconditional (none of the 6 files contain literal `Proxy`), benign · equivalence gate 22/1720/22, unchanged · must-not-move groups A/B/C/D **NOT run** (time-budget cutoff) · the assigned 6-row bucket reproduces byte-for-byte unchanged | branch `issue-5383-standalone-temporal-s41`, worktree `agent-a38577421023edc2b`, based on S40b's tip `ef08f7a8f0` |
| S41b | **Measurement + docs only, no `src/` changes.** Completed the must-not-move battery S41 flagged as "NOT run": groups A (1,250 files)/B (205)/C (249)/D (300), file-copy revert base (`ef08f7a8f0`) vs S41's merged fix (`680f8190fd`), `--target standalone`. Also added a new group E (`Proxy` first 200 + `Reflect` first 100, mandatory since #6628 is inside Proxy dispatch), run both unlinked (ordinary `runTest262File`) and linked — no harness knob forces a Temporal link onto a non-Temporal-tagged file without a `src/` change, so built a docs-only shadow-copy script that inserts `features: [Temporal]` as the first line of each file's `/*--- ... ---*/` block (flips `test262NeedsTemporalGlobal` without touching `test262/`) and runs the shadow copy through the same production `compileWithTemporalGlobal` path every Temporal-tagged row already takes | Groups A/B/C/D: 1125/179/196/219 pass (exact per-file match, 0 pass→fail, 0 fail→pass, matching the task's expected floor) · PlainDate re-confirmed 112/112 both states (fresh `JS2WASM_TEMPORAL_CACHE` per state, `cacheHit=false` at prewarm), 0 diff · group E unlinked: 235/300 both states, 0 diff · group E linked: base 220/300 → fix 228/300, 0 pass→fail, 8 fail→pass, all in the engine-triggered trap-dispatch family (`apply`/`has`/`get`/`getOwnPropertyDescriptor`/`getPrototypeOf`/`isExtensible`/`deleteProperty` × `call-parameters.js`/`call-in.js`/`call-with.js`) that `fillProxyDispatch`'s fix targets directly — verified two by hand (`Proxy/apply/call-parameters.js`, `Proxy/has/call-in.js`): `Test262Error: trap context is not the handler object` under base-linked, pass under fix-linked; the remaining ~64 linked failures on both trees are manual `.apply()`/`.call()` trap invocations inside the test harness itself, routed through the still-unfixed general `__apply_closure` peer guard (#6420), exactly as S41's write-up predicts for the direction this fix does NOT reach · equivalence gate re-run 22/1720/22, unchanged | branch `issue-5383-standalone-temporal-s41b`, based on S41's tip `d9d43e634d` |

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
- **`Proxy get trap is not callable` (S40/S40b, 2026-09-17): REDUCED, mechanism
  NAMED, still OPEN.** S40 (#6627) fixed an unrelated oracle fixpoint bug found
  while investigating this bucket (a `Reflect.get`-shaped Proxy trap was
  mis-inferred as numeric-returning) but confirmed by S40b's measurement battery
  that the fix is a no-op on this bucket — all 6 assigned rows
  (`{Duration,PlainDate,PlainDateTime}/from/order-of-operations.js`,
  `PlainDate/from` + `PlainDateTime/from`
  `observable-get-overflow-argument-primitive.js`,
  `ZonedDateTime/prototype/add/order-of-operations.js`) still answer
  `TypeError: Proxy get trap is not callable`, byte-for-byte unchanged. S40
  reduced the trigger to a 9-line repro: a consumer module with ANY package
  `link:`ed at all (content irrelevant, `Reflect` not required) flips a Proxy
  `get` trap's answer, vs. an unlinked consumer where the same trap answers
  correctly. Named-but-unverified hypothesis: `ensureProxyRuntime`
  (`object-runtime-proxy.ts`, patches the `ref.test $Proxy` front-guard onto
  `__extern_get`/`__extern_set`/`__extern_has`) and
  `emitStandaloneLinkReverseLocalTerminals`
  (`src/codegen/standalone-link-reverse-peer.ts`, builds the consumer's
  `localGet`/… terminals from `ctx.funcMap.get("__extern_get")`) both touch
  `__extern_get`'s identity/body in the same narrow compile window — whether
  one observes a stale copy of the other is the open question. Next step: a
  WAT diff of `__extern_get`/`__proxy_get_dispatch`/`__module_init` between
  linked and unlinked builds of the repro (full write-up:
  [#6627](6627-reflect-namespace-numeric-inference-fixpoint.md)).
- **`Proxy get trap is not callable` (S41, 2026-09-17): MECHANISM FOUND, ONE
  DIRECTION FIXED, bucket still OPEN — a second, deeper cross-module
  mechanism blocks it.** S41 traced S40's 9-line repro past both of its named
  suspects (both structurally byte-identical between linked/unlinked builds)
  into `fillApplyClosure`'s #6420 "peer-owned callable" front-guard
  (`object-runtime.ts` ~line 7766): under `canonicalRuntimeTypes` a purely
  LOCAL closure's WASM shape is structurally indistinguishable from the
  provider's own, so the provider's `ref.test`-based `__is_callable` wrongly
  answers "callable" for a closure it has never seen, hijacking the call into
  the provider's own (unusable) apply terminal. Fixed (#6628) for the
  direction S40's 9-line repro exercises — a module invoking its OWN local
  Proxy trap now bypasses `__apply_closure` and calls
  `__call_fn_method_<argCount>` directly. Real, independently verified (150
  existing tests + 7 new ones), 0 regressions, four-family sample unchanged
  433/480. **Does NOT close the bucket**: the real corpus row is the OPPOSITE
  direction — the CONSUMER builds a Proxy (`TemporalHelpers.propertyBagObserver`)
  and hands it to the PROVIDER, which reads a property on it FROM INSIDE ITS
  OWN MODULE; the trap found is unavoidably the consumer's, so the provider
  genuinely needs the OLD peer route the #6628 fix bypasses. A targeted
  reduction of exactly this shape (`.tmp/s41/crossmodule.mts`: a provider
  method reading a property on a parameter that is a consumer-built Proxy)
  throws an uncaught `WebAssembly.Exception` identically on BOTH the base
  tree and the #6628 fix — proving this is pre-existing and NOT a new
  regression, but also the bucket's real, still-unfixed blocker. Next slice:
  make BOTH directions correct at once — a module invoking its own local trap
  must dispatch locally (S41's fix), but a module invoking a trap it received
  from elsewhere must still reach the peer — needs either per-closure
  ownership tagging (a module-origin field set at `struct.new` time) or a
  different signal recorded at Proxy-CONSTRUCTION time that `$ptraps` can
  carry forward. Full write-up:
  [#6628](6628-standalone-proxy-trap-peer-callable-kind-misclassification.md).
  **S41b (2026-09-17, measurement + docs only)** completed the must-not-move
  battery S41 flagged as skipped — groups A/B/C/D (2,004 files) 0 pass→fail,
  0 fail→pass; a new group E (Proxy/Reflect, 300 files, unlinked AND a
  docs-only forced-link variant) also 0 pass→fail, with 8 fail→pass all
  explained by the fix's own targeted mechanism. No regression found; see the
  S41b row in the table above.

## Stack state 2026-09-17

Accepted head for `#5383`/`#6628` work is **S41's `d9d43e634d`** plus S41b's
measurement/docs commit on top (branch `issue-5383-standalone-temporal-s41b`).
A separate `origin/main` merge attempt on the S41 branch (commit `00f66676e9`,
main at `c698c755bb`, 130 commits ahead) is **NOT** part of the accepted
stack — it breaks 12 stack witnesses in `tests/issue-6609-*`,
`tests/issue-6617-*`, `tests/issue-6625-*` (all `Object.getPrototypeOf` paths)
and is parked on branch `s41-main-merge-attempt` for the S42 sync slice to
resolve properly rather than merged blind.

## Stack state 2026-09-17 (post-S42)

S42 (branch `issue-5383-standalone-temporal-s42`, worktree
`/home/user/js2/.claude/worktrees/agent-a25f7f5520f0cbb37`) merged
`origin/main` (`4a5d5c1dfb`) onto S41b's `b84898a96c` head — **clean merge,
zero conflicts** (merge commit `527310b81f`) — and fixed the 12-witness
`Object.getPrototypeOf` regression the earlier parked attempt
(`s41-main-merge-attempt`, `00f66676e9`) also hit: main's #6484 S1 iterator-
prototype branch in `call-builtin-static.ts` was short-circuiting BEFORE
reaching `tryEmitDynamicCallableGetPrototypeOf` (#6609/#6625's own
mechanism, unchanged since S41b), not a conflict in the mechanism's own
file. Fix + full root-cause chain: #6629. All 150 stack witnesses green
post-fix. One NEW pre-existing (not merge-caused) defect surfaced by the fix
— `ensureObjectRuntime`'s bootstrap bakes stale funcIdx values when a native
gets registered after it fires, reproduced independent of the merge on
`b84898a96c` itself — filed as #6630, not fixed (architecture-level, out of
scope for a sync). **The criterion-5 re-baselined measurement battery (four
families × 120 files, must-not-move A–D, E-unlinked/E-linked, corpus byte
diff, `test:equivalence:gate`) was NOT run this session** (time-boxed out by
the #6484 root-cause depth) — the next agent/tech lead must run it before
the stacked PR opens. New accepted head for further work:
`issue-5383-standalone-temporal-s42`'s tip (post #6629's commits).

## Stack state 2026-09-17 (post-S43) — NOT yet PR-ready

S43 (branch `issue-5383-standalone-temporal-s43`, worktree
`/home/user/js2/.claude/worktrees/agent-a9f7773b894731967`, head `e57ab2a0f9`
on top of S42's `16d8087885`) investigated #6630 and found its real shape is
BROADER than filed: `ensureObjectRuntime`'s bootstrap misdispatches later
`.call()`/`.apply()` calls whenever ANYTHING triggers it early/mid-expression
— not specifically `Function.prototype` reads (WAT evidence rules out the
originally-filed stale-funcIdx hypothesis; see #6630's S43 findings section).
Landed one real, regression-free fix: `tryEmitDynamicCallableGetPrototypeOf`
(`object-get-prototype-of.ts`) now only materialises `%Function.prototype%`
after proving the receiver is actually callable/class-object (was eager,
unconditional). Verified against `tests/issue-66*.test.ts tests/issue-6484-*
.test.ts` (32 files / 188 tests): 187 pass / 1 fail, unchanged before and
after — **no regression, but also does not close the one pre-existing
failure**, because that test's trigger is a THIRD, unrelated,
main-authored path (`ensureIterRecPrototypeHelper` /
`emitIteratorPrototypeSingleton`, `iterator-proto-next.ts`) that S43 did not
touch (out of the stated sync scope). #6630 stays `status: ready`, not
closed, with the corrected root-cause writeup and two remaining
architecture-level directions.

**This head is NOT PR-ready**: `tests/issue-6484-iterator-prototypes
.test.ts`'s `"%IteratorPrototype% is the shared parent"` case is still red.
The criterion-5 re-baselined measurement battery (S42's gap) is STILL not
run. Next agent must either land #6630's architecture-level fix or extend the
same lazy-materialisation treatment to `emitIteratorPrototypeSingleton`'s
`ensureObjectRuntime` trigger, then run the full battery, before this can be
the stacked PR head. New candidate head for further work:
`issue-5383-standalone-temporal-s43`'s tip (`e57ab2a0f9`).

## Stack state 2026-09-17 (post-S44) — #6630 CLOSED, this head IS the failing-case fix

S44 (branch `issue-5383-standalone-temporal-s44`, worktree
`/home/user/js2/.claude/worktrees/agent-ae02d763b3f66aedb`, head `0c3316f9f1`
on top of S43's `e57ab2a0f9`) found #6630's real gap was NOT a bootstrap
ordering/staleness defect at all — S43's own WAT evidence already ruled out
stale funcIdx values, and S44 traced the misdispatch one hop further: once
`%Function.prototype%` is materialized and wired as a closure's
`[[Prototype]]`, a `.call()`/`.apply()`/`.bind()` own-property lookup off
that closure legitimately walks the chain (correct §10.2 `[[Get]]`
precedence) and finds `%Function.prototype%`'s own `call`/`apply`/`bind`
property — which `makeGlue` (`array-object-proto.ts`) had never given a real
body for (only `toString`/`@@hasInstance` were wired), so it was always the
#2984 refusal closure. `closure-call-fast.ts`'s fast arm and
`closure-props.ts`'s `__closure_method_call` route 1 both correctly see that
as an own-property HIT and correctly defer to it — which then throws. No
ordering fix was needed; the fix was implementing the three missing glue
bodies (`src/codegen/function-proto-invokers.ts`), each forwarding to the
SAME generic "invoke any callable" primitives the runtime already has
(`__apply_closure` for call/apply, `__bind_dyn` for bind) rather than
special-casing WasmGC closures. Full trace, fix shape and verification in
#6630's own `### S44 findings` section (`plan/issues/6630-ensureobjectruntime-bootstrap-late-import-staleness.md`) — not
restated here.

**This head IS the failing-case fix and is candidate PR-ready** (pending the
criterion-5 re-baselined measurement battery, still S42's original gap, not
run by S44 either — out of S44's stated scope, see its dispatch brief).
`tests/issue-6484-iterator-prototypes.test.ts` is 11/11 green (previously
10/11). `tests/issue-66*.test.ts tests/issue-6484-*.test.ts`: 33 files / 194
tests, 0 failed. `tests/issue-64*.test.ts tests/issue-65*.test.ts`: 48 files
/ 441 passed / 1 skipped (442 total), 0 failed (S43's own measurement on this
sweep was 47/48 files, 440/442 — the one red being this issue's case; now 0
red). `npm run -s test:equivalence:gate`: 22 failing / 1720 passing / 22
known-failures — unchanged from S43's documented 22/1720/22, no new
regressions. New candidate head for further work / the criterion-5 battery:
`issue-5383-standalone-temporal-s44`'s tip (`0c3316f9f1`).

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
