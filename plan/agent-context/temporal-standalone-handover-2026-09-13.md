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

| S44b | **Measurement + docs only, no `src/` changes.** Ran the criterion-5 battery S42/S43/S44 all deferred, on BASE (`b84898a96c`) vs the accepted stack head NEW (`6cd09bbb89`). Reused S41b's group A/B/D and the E scripts verbatim; group C's local copy of `mnm3.mts` had since grown a 5th sub-glob (`expr/class` ×100, not present at S41b's own 249-file measurement) — confirmed by exact arithmetic (349 − 100 = 249, 273 − 77 = 196, matching S41b's row precisely), not a regression, just script drift between worktrees | Four-family 433/480 both trees, byte-identical (0/0) · A 1125/1250, B 179/205, E-linked 228/300: byte-identical both trees · C 273→274/349 (+1 fail→pass), D 219→224/300 (+5 fail→pass), 0 pass→fail in either · E-unlinked aggregate 235/300 both trees (per-file diff lost to an `mnmE.mts`/`mnmE-linked.mts` output-filename collision, fixed for next time by passing distinct `outDir`s) · corpus byte A/B: 0 status/CE flips, 14 `standalone`-only SHA flips (expected, the 110-file main-merge codegen delta) · equivalence gate: NEW 22/1720/22 (S44's own number), bare `origin/main` (`4a5d5c1dfb`) also 22/1720/22 · **0 stack-caused pass→fail anywhere in the entire battery** — verdict: criterion 5 clean, stack head `6cd09bbb89` is PR-ready on this axis | branch `issue-5383-standalone-temporal-s44b2` (the plain `…-s44b` name was already taken by the incomplete first attempt, same commit `6cd09bbb89`), worktree `/home/user/js2/.claude/worktrees/agent-a302b920b427333e8`, no new commits (docs only, pushed to a docs PR — push to `fork`/`origin` returns HTTP 403 for this session, noted once) |

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

## Stack state 2026-09-17 (post-S44b) — criterion-5 battery run, 0 stack-caused pass→fail, PR-ready on this axis

S44b (branch `issue-5383-standalone-temporal-s44b2`, worktree
`/home/user/js2/.claude/worktrees/agent-a302b920b427333e8`, no new commits —
MEASUREMENT + DOCS ONLY, head unchanged at S44's `6cd09bbb89`, the merged
commit onto S44's `0c3316f9f1` tip) ran the criterion-5 re-baselined battery
every prior slice (S42/S43/S44) had deferred. BASE = pre-merge stack head
`b84898a96c`; NEW = `6cd09bbb89`.

**New base numbers for anything stacked on top of `6cd09bbb89`:**

- Four-family (480 files, standalone, linked): **433/480** pass on both
  trees, byte-identical per file (0 pass→fail, 0 fail→pass).
- Must-not-move A (1125/1250), B (179/205), E-linked (228/300): identical
  both trees. C: 273→274/349 (+1 fail→pass). D: 219→224/300 (+5 fail→pass).
  **0 pass→fail anywhere.** The 6 fail→pass deltas are `origin/main`'s own
  TypedArray/`Function.prototype[Symbol.hasInstance]` fixes, not this
  stack's.
- E-unlinked: aggregate 235/300 both trees (per-file diff lost to a
  filename-collision bug in the shared `mnmE.mts`/`mnmE-linked.mts` scripts —
  see #6629 for the fix note).
- Corpus byte A/B (84 rows/tree): 0 status/CE flips; 14 `standalone`-only SHA
  flips from the legitimate main-merge codegen delta.
- `test:equivalence:gate`: NEW 22/1720/22 (S44's own number, unchanged);
  bare `origin/main` (`4a5d5c1dfb`) also 22/1720/22.

**Verdict: 0 stack-caused pass→fail — the stack head `6cd09bbb89` is
criterion-5 clean.** Full tables: #6629's "Re-baselined battery" section and
#5383's `### S44b findings`. The stack is now PR-ready on every criterion
tracked since S42; the stacked PR (S13→S44) is the next step.

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

## Stack state 2026-09-18 (post-S46) — two real `T | undefined` resurrection
bugs fixed (#6632); the two named Temporal rows are STILL RED

S46 (branch `issue-5383-standalone-temporal-s46`, worktree
`/home/user/js2/.claude/worktrees/agent-a219eb61329d8c17e`, base
`214afd09cc` = S44b `973a746655` + #6631 fix `c88e797703` + docs
`214afd09cc`) found and fixed two real bugs in the `T | undefined` → wasm
`ref_null $AnyString` representation (the same carrier a `T | null` field
uses — a `ref.null` cannot distinguish the two, only the static declared type
at the read site can): `compileTypeofExpression` (typeof-delete.ts) and the
generic dynamic member-get dispatcher (`member-get-dispatch.ts`, the
`obj[computedKey]` route) each bypassed the existing #4741 `coerceType`
resurrection arm. Full writeup: #6632.

**Neither fix closes the two named rows**
(`Temporal/PlainDate/from/argument-object-valid.js`, `…/argument-string.js`).
Re-ran both against a freshly rebuilt provider: still `Expected
SameValue(«null», «undefined»)`. WAT reduction of the real provider traced
the read to a THIRD site: `PlainDate.prototype.get era` → `Qt(this)` resolves
a **polymorphic `Calendar` interface reference**, so `.isoToDate(...)`'s
return is statically `any`, and the subsequent computed-key read
(`result["era"]`) goes through the fully dynamic `$Object` property store
(`$__extern_get`/`$__extern_set`), not either of the two sites fixed here.
Two attempted minimal reductions of that shape each hit unrelated crashes
instead of the target mismatch. Not fixed; see #6632 for the full account and
next-step options.

**No battery run** — the two named rows are still red, so a battery run at
this head would validate #6631 alone (S45b's un-run obligation), not this
PR's own fix. Regression evidence for THIS PR is scoped to
`tests/issue-66*.test.ts` + `tests/issue-6484-*.test.ts` (35 files / 211
tests, 0 failed) plus the new `tests/issue-6632-*.test.ts` (8 cases,
fail-on-base/pass-on-fix confirmed).

**For the next lane**: the `$__extern_get`/`$__extern_set` dynamic property
store (`object-runtime.ts`) is the next place to look for the SAME
`ref_null $AnyString`-collapse pattern — check whether the VALUE argument to
`$__extern_set` (when storing a `string | undefined`-typed local into a
dynamically-typed object property) goes through `coerceType` with an `fctx`
available, and whether the GET side has an equivalent gap to the one just
fixed in `member-get-dispatch.ts`.

## Stack state 2026-09-18 (post-S46b) — real-row re-proof + first full
criterion-4 battery for #6631+#6632; two rows still red

S46b (branch `issue-5383-standalone-temporal-s46b`, worktree
`/home/user/js2/.claude/worktrees/agent-a204999dabd0fafd7`, base = S46's tip
`0ed8016645`, no further source changes) re-confirmed the real-row result on
a fresh provider build and ran the full battery S46 skipped:

- Witness sweep: 35 files / 211 tests, 0 failed (matches S46).
- Real rows: both `PlainDate/from/argument-object-valid.js` and
  `…/argument-string.js` still `Expected SameValue(«null», «undefined»)` —
  unchanged from S45b/S46.
- One bounded reduction step (re-running S46's own `probe-dynset.mts` /
  `probe-objlit.mts`): still hits unrelated crashes, not the target mismatch.
  No further fix attempted, per the brief.
- Four-family: base 433 → cur 435 pass (0 pass→fail, 2 fail→pass).
- Must-not-move A–D: 0 pass→fail (6 fail→pass total).
- E-unlinked: 235/300 (first-ever unlinked measurement, no prior baseline).
- E-linked: base 228 → cur 235/300, but 17 fail→pass / **10 pass→fail**.
  Proven via exact file-copy revert of all three files #6631+#6632 touch
  (rebuilt, re-ran) to be **NOT caused by this stack** — identical failures
  persist with the code at its pre-#6631 (`973a746655`) state. Flagged as a
  pre-existing/environmental gap (likely QuickJS provider/adapter build
  drift between worktrees, not a source regression) for whoever next touches
  `object-runtime-proxy.ts` / standalone `Object.prototype.hasOwnProperty`.
- Corpus byte A/B: 0 status/sha flips, no gc movers.
- Equivalence: 22/1720/22, unchanged.

**Verdict: criterion 4 is clean for #6631 and #6632's own changes** (0
legitimate pass→fail). The two named real Temporal rows are STILL RED — the
`$__extern_get`/`$__extern_set` third site named by S46 remains the next
lead. Full tables: #6631 and #6632's issue files' "## S46b" sections, and
#5383's "### S46b findings".

## Stack state 2026-09-18 (post-S47) — the `$__extern_get`/`$__extern_set`
hypothesis REFUTED; two new interface-dispatch defects found, neither fixed

S47 (branch `issue-5383-standalone-temporal-s47`, worktree off S46b's tip
`3b82884459`, findings-only — no `src/` change) refuted S46's leading
hypothesis for the non-polymorphic case, then hit two orthogonal defects
trying to reduce the polymorphic (real Calendar dispatch) shape: (1) a bare
interface-typed method call through a function-returned interface value
TRAPS unconditionally, even with a body as simple as `return 42`; (2) a
`Record<string, Interface>` holding both an object-literal AND a
class-instance implementer of the same interface (the polyfill's exact
`impl['iso8601']`/`NonIsoCalendar` registration shape) dispatches BOTH keys
to the class instance, ignoring the literal — a genuine devirtualization
bug. Full writeup: `#6633`'s "S47 findings" section.

## Stack state 2026-09-18 (post-S48) — S47's finding #2 root-caused and
fixed as `#6634`; NOT yet proven to close #5383's target gap

S48 (branch off S47's tip `afe573638b`) traced S47's finding #2 one level
upstream of the call-dispatch ladder it suspected: `collectInterface`
synthesizes a method-only interface's own struct as an object-literal shape,
so a class instance can never physically match it and silently resolves to
`ref.null`. Fixed in three call sites via a new memoized predicate
`interfaceHasClassImplementer` (`src/codegen/interface-class-implementer.ts`).
Both S47 repro shapes fixed and witnessed (6 cases, 4/6 fail on base, 6/6
pass on fix). **Did not run the criterion-4 battery or re-verify the two
real target rows** — time-boxed after the root-cause investigation. Full
writeup: `#6634`'s issue file (the fix itself).

## Stack state 2026-09-18 (post-S48b) — real rows STILL RED; #6634 does not
touch the target gap; one reduction step finds a NEW `illegal cast` trap
`#6634` introduces; full criterion-4 battery all clean

S48b (branch `issue-5383-standalone-temporal-s48b`, worktree off S48's tip
`190d5336d8`) rebuilt the Temporal provider from scratch against `#6634`'s
fix (`cacheHit=false`, confirmed genuine rebuild — **note the provider's own
cache key does NOT include the compiler bundle hash, only the polyfill
source + compile options, so re-using a cache-dir label across a `src/`
change silently serves a stale provider; this is a real gap in
`scripts/prewarm-temporal-provider.mjs` worth its own issue**) and re-ran
both named rows: **still red, byte-identical `Expected SameValue(«null»,
«undefined»)` error, unchanged since S45.** Root cause of the non-closure:
disassembly of the real polyfill bundle shows the default `iso8601` calendar
is a pure object literal (`Xo.iso8601 = {isoToDate({year,month,day}, r){...}}`)
that never routes through the class-implementer branch `#6634` changes — the
fix is provably a no-op for this specific call.

One reduction step (file-copy A/B on the three `#6634`-touched src files)
names a NEW defect the fix introduces: a destructured-parameter method
(`compute({year,month,day})`, exactly the real `isoToDate`'s own parameter
shape) on an object-literal interface implementer now hard-traps
(`illegal cast`) whenever ANY class implements the same interface anywhere
in the compiled program — even if that class is never called. BASE
silently misdispatched to the class instead of trapping (wrong answer, not a
crash). Neither ingredient alone reproduces it. Filed as latent debt in
`#6634`'s issue file, not yet its own issue number.

Full criterion-4 battery, all clean (0 pass→fail everywhere): four-family
435/480 (unchanged), must-not-move A–F all exact matches to base (A 1125/1250,
B 179/205, C 274/349, D 224/300, E-unlinked 235/300, E-linked 235/300,
F-class 136/250, F-methoddef 68/100, F-objproto 136/150 — F's base produced
via file-copy revert since no prior baseline existed), corpus byte A/B 0
status/sha flips on 84 entries, equivalence gate 22/1720/22 unchanged.

**Verdict: `#6634` is criterion-4-clean and a real, independently-valuable
fix (documented interface/class devirtualization bug), but it does NOT close
`#5383`'s target gap.** The standing next lead is unchanged from S46/S46b:
the `SameValue(null, undefined)` defect lives entirely inside the
`iso8601`-object-literal-only branch of the real calendar dispatch, with no
class implementer reachable from that call at all — the generic dynamic
member-get read (`$__extern_get`, a computed key `[t]` on an object
literal's OWN return value) remains the standing hypothesis nobody has yet
reduced to a minimal repro that reproduces the exact `null` vs `undefined`
mismatch. Full writeup: `#5383`'s "S48b findings" section,
`#6634`'s "Criterion-4 battery" section.

## Stack state 2026-09-18 (post-S49) — the `illegal cast` trap CLOSED;
target gap still untouched; task 2 (reduction) not reached

S49 (branch `issue-5383-standalone-temporal-s49`, worktree off S48b's tip
`4f68804bc9`) closed the `illegal cast` trap S48b's own reduction step
found: a destructured-parameter interface method implemented by an object
literal, plus an uncalled class implementer of the same interface anywhere
in the program, traps on the fix tree (base tree silently misdispatched to
the class). Root cause: the closed-method-dispatch cascade that
`#6634`'s carrier guard forces for a mixed class+literal interface builds
the destructured-parameter argument as the open `$Object` carrier (by
design — the call site cannot know statically which candidate to target),
but every arm hard-`ref.cast`s that value to its own candidate's CLOSED
struct, which it never inhabits. Fix: a new, narrowly opt-in marshal
(`ensureStructFromObjectCoercionHelper`, `extern-arg-marshal.ts`) that falls
back to reading the target struct's fields generically off the externref
value (via `__extern_get` + `struct.new`) instead of assuming the value
already IS that struct — gated to fire only for a dispatcher whose
candidates mix a class implementer with a non-class one, so every other
closed-method-dispatch call site keeps its previous bytes exactly.

**#5383's target gap is UNCHANGED.** The two named rows
(`Temporal/PlainDate/from/argument-object-valid.js`, `…/argument-string.js`)
still fail with the byte-identical `Expected SameValue(«null», «undefined»)`
error — the default `iso8601` calendar's `isoToDate` never reaches a mixed
class+literal dispatcher, so neither `#6634` nor this fix touches it.
**Task 2 (continuing the `SameValue(null, undefined)` reduction in the
polyfill's own JS bundle shape) was NOT attempted this session** — no time
remained after the mandatory task. The standing hypothesis is unchanged
from S46 through S48b: a generic dynamic member-get read (`$__extern_get`,
a computed key `[t]` on an object literal's OWN return value, no
interface/class dispatch involved at all) inside the real bundle's composed
property-bag shape.

Verification: 3 new fix-witnesses + 1 new control in
`tests/issue-6634-interface-dictionary-literal-vs-class-dispatch.test.ts`
(10 tests total). File-copy A/B on the two touched files
(`extern-arg-marshal.ts`, `closed-method-dispatch.ts`) against S48b's tip:
all 3 new witnesses trap with `illegal cast` on base, pass on the fix.
`npx vitest run --maxWorkers=2 tests/issue-66*.test.ts tests/issue-6484-*.test.ts`:
36 files / 221 tests, 0 failed. Criterion-4: 770 sampled test262 files across
groups A–F (representative samples, not the full multi-thousand-file
families — out of session time budget), 0 status flips against S48b's own
baseline TSVs. The four-family Temporal battery and full corpus byte A/B
were NOT re-measured this session (inferred-safe given the narrow opt-in
gate, but not directly measured — flagged for the next lane). Full writeup:
`#6634`'s issue file, "## S49 fix" section; `#5383`'s "### S49 findings"
section.

**Next lane**: pick up task 2 — reduce the `SameValue(null, undefined)`
defect in the polyfill's OWN bundle JS shape (no TypeScript interfaces/class
heritage in it, so TS-interface-shaped reductions like S48b's repro17 are
off-shape for this specific defect). Per the dispatch brief's suggested
composed repro: a property-bag object built inside a method
(`isoToDate({year,month,day}, r) { const o = {era: void 0, ...}; ...; return
o; }`), returned as `any`, read back by a runtime computed key. Use a FRESH
`JS2WASM_TEMPORAL_CACHE` label when re-running the two target rows — the
provider cache key does not hash the compiler bundle, so a reused label
silently serves a stale (pre-fix) provider (documented since S48b).

## Stack state 2026-09-18 (post-S49b) — full must-not-move battery run;
every group clean except a real, reproducible E-linked regression S49's own
sample missed

S49b (branch `issue-5383-standalone-temporal-s49b`, worktree off S49's tip
`3df9b3f8eb`, MEASUREMENT ONLY, no source changes) ran the full battery S49
had only sampled 770 of ≈3,204 files for: four Temporal families (480),
A–F (3,014), corpus byte A/B (84 rows), equivalence gate, and the two named
`#5383` target rows with a fresh provider. Fresh `JS2WASM_TEMPORAL_CACHE=s49b`
(`cacheHit=false` confirmed), fresh quickjs-eval-adapter recompiled against
S49's bundle (key `b08634d600e87acc`).

**Result: every group is clean (0 pass→fail) except E-linked**, which S49's
60-of-300 sample missed entirely: 17 real, reproducible pass→fail
(Proxy/Reflect tests, provider force-linked; net −7, 235→228/300). Confirmed
reproducible on rerun (byte-identical batch result, and isolated per-file
rerun of the 17). E-unlinked (identical 300 files, provider not
force-linked) stayed clean, narrowing the cause to the linked-provider code
path — consistent with the #6628 "linking hijacks any closure call"
mechanism the E-linked probe script exists to test, and with S49 having
touched `closed-method-dispatch.ts` (shared dispatch infrastructure, not
just the narrowly-scoped `allowObjectCoercion` marshal). Full per-file error
strings in `#6634`'s issue file "Criterion-4 battery — FULL RUN, S49b"
section; `#5383`'s own "### S49b findings" section has the summary.

**New base numbers for the next lane to diff against** (all vs S48b's prior
baseline, which is now stale for E-linked specifically):

| Group | Base (pre-S49) | S49b measured (post-S49) | Flip |
| --- | --- | --- | --- |
| Temporal PlainDate/Duration/PlainDateTime/ZDT | 435/480 | 435/480 | 0 |
| A | 1125/1250 | 1125/1250 | 0 |
| B | 179/205 | 179/205 | 0 |
| C | 274/349 | 274/349 | 0 |
| D | 224/300 | 224/300 | 0 |
| E-unlinked | 235/300 | 235/300 | 0 |
| **E-linked** | **235/300** | **228/300** | **−7 (17 pass→fail, 10 fail→pass)** |
| F-class | 136/250 | 136/250 | 0 |
| F-methoddef | 68/100 | 68/100 | 0 |
| F-objproto | 136/150 | 136/150 | 0 |
| corpus byte A/B | — | 0/84 flips | 0 |
| equivalence gate | 22/1720/22 | 22/1720/22 | 0 |

**#5383's target gap is UNCHANGED** — both named rows still fail with the
byte-identical `Expected SameValue(«null», «undefined»)` error, confirmed
with the fresh S49b provider. Task 2 (the `SameValue(null, undefined)`
reduction) remains not attempted.

**Next lane**: two independent threads now open. (1) Task 2 as before — see
the S49 entry above for the suggested composed repro. (2) NEW — investigate
or fix the E-linked regression S49b found: 17 real Proxy/Reflect pass→fail
under `closed-method-dispatch.ts`'s change, force-linked-provider path only.
Do not treat `#6634`'s "criterion 4: SATISFIED" verdict as settled; S49b's
issue-file edit already flags it as NOT fully satisfied pending this
investigation.

## Stack state 2026-09-18 (post-S49c) — E-linked regression ATTRIBUTED:
NOT S49-caused, environmental; no code change; stack tip unchanged

S49c (branch `issue-5383-standalone-temporal-s49c`, worktree off S49b's tip
`ba31f49531`, HEAD unchanged at `3df9b3f8eb`) closed thread (2) above as an
attribution-only task. Same-worktree file-copy A/B on S49b's 27 flipped
E-linked files (17 pass→fail + 10 fail→pass): reverted ONLY
`extern-arg-marshal.ts` + `closed-method-dispatch.ts` to their pre-S49
`4f68804bc9` content (bundle hash changed, confirming the revert took),
fresh Temporal-cache prewarm on both trees (`cacheHit=false` each), reran
the 27 files on both. **Identical status on all 27 rows, both trees** — S49's
diff makes no difference to a single one of them. Restored the fix files
immediately after; `git status`/`git diff` clean.

**Verdict: the E-linked regression predates S49's diff — it is
environmental, matching S46b's prior proven-environmental E-linked drift.**
No fix applied (none was warranted: nothing in S49's diff causes it).
`3df9b3f8eb` stands as-is. `#6634`'s criterion 4 is no longer blocked by
this specific finding (the 17 pass→fail is real and reproducible against
S48b's committed baseline, but it is not attributable to `#6634`'s own fix).
Full 27-row table and method in `#6634`'s issue file "S49c attribution"
section; summary in `#5383`'s "### S49c findings" section.

**Not investigated further within this lane's budget**: the actual root
cause of the drift vs S48b's committed TSVs (candidates: QuickJS
in-process session/heap-reuse effects across a differently-sized/ordered
batch, or a test262-corpus/harness revision between when S48b's baseline
was captured and now). Whoever next touches E-linked should treat S48b's
committed base TSVs as suspect, not S49's diff, and consider re-baselining
E-linked's committed numbers rather than chasing a code cause that this
lane's A/B ruled out.

**Next lane**: Task 2 (the `SameValue(null, undefined)` reduction) remains
the only open thread from this stack; the E-linked thread is closed.

## Stack state 2026-09-18 (post-S52c) — the "cross-module Proxy" framing for
#6637/#6628's parked bucket is WRONG; real defect found (single-module,
"any"-typed dot-access on a Proxy), no fix attempted, S52b's WIP reverted

S50/S51/S52/S52b ran between S49c and this entry (see each issue's own
findings sections — #6635 fixed in S50; S51 found the 4 target `RangeError`
rows all decompose to #6628's parked bucket, no fix; S52 diagnosed a
provider-side callable-classification gap in that bucket; S52b implemented
S52's prescribed fix — a reverse-peer callable-kind channel — confirmed it
does NOT unblock the empty-handler repro, and narrowed the finding to "no
trap exists to misclassify here", correctly flagging its own diagnosis as
insufficient).

S52c (branch `issue-5383-standalone-temporal-s52c`, worktree
`/home/user/js2/.claude/worktrees/agent-ad93bfa729a45909f`, started at
S52b's tip `9f7e38ac1e`) was dispatched to find the real cause under a
"cross-module `$Proxy`/`$ProxyTraps` struct-layout mismatch" hypothesis.
**That hypothesis is falsified — direct WAT diffing confirms both modules'
struct shapes are byte-identical.** Bisection instead found: the exact same
throw (`TypeError: Cannot access property on null or undefined`) reproduces
in a SINGLE STANDALONE MODULE with NO link at all, for
`function f(o) { return o.overflow; }` (untyped param) called with
`new Proxy({overflow:1}, {})`. Root cause traced to
`emitNullGuardedStructGet`/`emitGuardedRefCast`
(`src/codegen/property-access.ts` / `type-coercion.ts`): an untyped ("any")
receiver's dot-access takes a static guarded-cast-to-some-struct fast path,
finds no static struct with a field literally named `overflow` (Proxy
properties are dynamic, never static struct fields), and treats the failed
cast as "receiver is null" instead of falling through to the dynamic
`__extern_get` path (which DOES correctly recognize `$Proxy`). The
cross-module framing throughout #5383's S52/S52b/#6628 was a coincidence —
every provider function parameter is necessarily untyped, which is what
actually triggers this, not the module boundary. Full evidence chain (byte
diffs, the direct-import bisection ruling out `__apply_closure`, the
decisive single-module repro, the `charCodeAt`-decoded thrown message, and
the `=== null` confirmation) is in `#6637`'s rewritten issue file; summary
in `#5383`'s own "### S52c findings" section; a pointer added to `#6628`'s
issue file so future readers of that bucket route to #6637 instead of
re-opening #6628.

**S52b's WIP reverted** (`git revert --no-edit HEAD` on `9f7e38ac1e`,
clean — `git diff 0bb08d20a0..HEAD -- src/codegen/standalone-link-reverse-peer.ts
src/codegen/typeof-natives-finalize.ts` is empty) since it targets a
classification gap this session's evidence shows is not implicated in the
empty-handler repro. It may still be useful for the REAL-trap case
(`readViaProxy`, an actual `get(t,k,r){...}` closure, which threw "Proxy get
trap is not callable" per S52/S52b's own finding — not re-examined this
session) but should be re-implemented once #6637's fix lands, not
resurrected as-is.

**No fix attempted, no witness suite committed.** The real fix touches the
generic "any"-typed member-access fast path used by every struct-shaped
runtime value (not Proxy-specific) — a different, larger-blast-radius change
than scoped for this slice, needing an architect pass on which guarded-cast
call sites should fall through to the dynamic path vs. genuinely throw. HEAD
is `d2d0072b5c` (S52b's `9f7e38ac1e` plus a clean revert). Four-family/A–F/
equivalence numbers unchanged from S51 (the revert restores exactly S52b's
pre-diff source; no other `src/` file touched; base-vs-fix comparison
doesn't apply — there is no fix to compare).

A second, smaller, independent defect was found and left open: `in`/
`Object.isExtensible`/`Object.keys` on the same empty-handler cross-module
Proxy answer wrong (`0`/`0`/`0` instead of `1`/`1`/`1`) with no throw — these
route through the generic dynamic helpers, which DO recognize `$Proxy`
correctly but then forward to the wrong target value. Noted as a follow-up
candidate in #6637's "What's still open", not traced further.

**Next lane**: retire the "cross-module Proxy" framing entirely for any
future #6637/#6628-adjacent dispatch — the next slice should be scoped
"standalone: dynamic property access on a Proxy through an untyped
receiver" and verified with a single-module repro, no link/provider/consumer
harness required. Route through an architect pass on
`emitNullGuardedStructGet`'s blast radius before implementation. Task 2 (the
`SameValue(null, undefined)` reduction, open since S49) remains a separate,
still-open thread from this stack.

## Stack state 2026-09-18 (post-S53) — #6637 FIXED: the real mechanism was a
Proxy-binding escape-analysis gap, not `emitNullGuardedStructGet`; S52c's
proposed fix location was wrong, root cause traced one level up

S53 (branch `issue-5383-standalone-temporal-s53`, off S52c's head
`aede72f2fc`, worktree
`/home/user/js2/.claude/worktrees/agent-a20dab3638059270a`) fixed the
single-module defect S52c isolated. **S52c's proposed fix location
(`emitNullGuardedStructGet`'s multi-struct dispatch) turned out not to be
the mechanism at all** — `wasm-dis -all` on the repro shows `.overflow` on
an untyped receiver already lowers to the generic `__dyn_member_get` reader
(#3053), which already `ref.test`s `$Proxy` correctly; that dispatch chain
is never reached by this repro.

**Real root cause, traced one level up:** `new Proxy(target, handler)` is
typed by TypeScript as its TARGET's structural type (`lib.es5.d.ts`'s
`ProxyConstructor` returns `T`), so `const options = new Proxy({overflow:1},
{})` checker-types as `{overflow:number}`. `src/codegen/analysis/
proxy-binding-escape.ts` (#2615) overrides this by forcing externref storage
onto Proxy bindings — UNLESS the binding escapes into a call argument, in
which case #2615's own regression-fix narrowing keeps the struct typing
(needed for `Object.prototype.toString.call(p)` / `Array.prototype.
copyWithin.call(p,…)` / `Object.getPrototypeOf(p)`). `readOverflow(options)`
trips exactly that "escapes to a call" rule: `options`'s local gets
struct-typed to `{overflow:number}`'s WasmGC shape, the guarded cast against
the REAL runtime `$Proxy` value always fails, and `options` becomes
`ref.null` **at its own declaration** — three statements before
`readOverflow` is even called. Every later read correctly reports "null or
undefined" because by then it genuinely is.

**Fix**: `expressionIsEscapingArgument` no longer treats a plain call to a
BARE-IDENTIFIER callee (never `.call`/`.apply`/a method — the #2615
regression class is structurally excluded by that guard) as an escape when
the matching parameter is genuinely untyped
(`ctx.oracle.signatureOf(callee).params[i].kind === "any"`). An untyped
parameter reads through the same generic dynamic path the working
direct-read control already uses, so passing the raw Proxy externref into it
is always safe.

**Verification**: new witness suite `tests/issue-6637-untyped-receiver-proxy-
property-access.test.ts` (13 tests: untyped read/write/`in`/keys/
isExtensible through empty-handler and real-trap Proxies, 6 controls
including a #2615-class typed-call control, one two-module link control).
File-copy A/B: 5/13 fail on base (exactly the fix-witness cases), 13/13 pass
on fix, 8 controls pass on both trees. Two pre-existing, out-of-scope gaps
found and left unfixed (`proxy.m()` method calls through ANY Proxy;
`isExtensible` TRAPS specifically both throw even in the fully static direct
case on BOTH trees — unrelated to this defect). Required suite `tests/
issue-66*.test.ts tests/issue-6484-*.test.ts`: 38 files / 240 tests, 0
failed. Equivalence gate: 22 failing / 1720 passing / 22 known-failures —
unchanged from S50/S51. Gate chain green (typecheck, LOC/func budget vs both
`merge-base(origin)` and `origin/main` directly, coercion-sites,
oracle-ratchet [+0/+0 — the fix uses `ctx.oracle.signatureOf`, never raw
`checker.*`], dead-exports, speculative-rollback, issue-ids-against-main) —
one pre-existing, unrelated func-budget ceiling drift
(`emitObjectProtoToStringClassifier`, moved by main's `0bf2914353`) granted
in #6637's frontmatter per the dispatch brief's own KNOWN note.

**Criterion-4 battery (four-family/A–F/corpus-byte, the 10 real sample rows
against a rebuilt Temporal provider) was NOT run** — S53's effort budget did
not extend to rebuilding/linking the real provider and running the full
42-package corpus byte-diff harness. This is an acknowledged gap against the
dispatch brief's full ask: the fix is verified at the unit/mechanism level
(13 direct tests + equivalence gate + the two required suites, all green)
but the specific "which of the 10 named sample rows now move" and "four-
family/A–F/corpus-byte flip counts" are unmeasured on this head. See #6637's
own "Recommend" note for the two options (run the real-provider battery in a
follow-up before merge using the runner scripts already staged at
`/home/user/js2/.claude/worktrees/agent-ad93bfa729a45909f/.tmp/{s50run,s50,
s51,s49b,s46b,s41b,s52c}`, or land on the unit-level verification and defer
the sample-row re-run). Worth checking first: this fix's shape (any Proxy
binding passed to any untyped function) is exactly the shape #6628's
originally-named "Proxy get trap is not callable" bucket hits too, so it
may move rows there as well as in the 4-row `options-read-before-
algorithmic-validation.js` bucket this dispatch named.

## Stack state 2026-09-18 (post-S53b2) — the S53 criterion-4 battery is now
COMPLETE, zero movement across all four sub-batteries; S53 is criterion-4-clean

S53b (branch `issue-5383-standalone-temporal-s53b`, worktree
`/home/user/js2/.claude/worktrees/agent-a99a85629df15dea9`) ran the
measurement-only follow-up S53 asked for but was killed mid-run by a
container restart, having completed the 10-target-row check (none moved),
the four-family battery (435/480, 0 flips), and the corpus-byte battery
(0 status/sha flips across 84 rows), with the A–F must-not-move battery
(3,204 files) roughly a quarter done. S53b2 (same lineage, HEAD
`8add8d7efa`, worktree `/home/user/js2/.claude/worktrees/agent-a93264a3507301e71`)
resumed from S53b's saved `.tmp/s53brun/` artifacts and finished the
remaining A/B/C/D/E-unlinked/E-linked/F-class/F-methoddef/F-objproto parts
using the same resumable batch runner.

**Result: every sub-battery reports zero movement.**

- 10 target rows: unchanged (6 still fail on #6628's real-trap Proxy
  mechanism, 4 still fail on #6628's `TypeError`-not-`RangeError` mechanism —
  S53's fix does not touch either).
- Four-family: 435/480, 0 pass→fail, 0 fail→pass.
- A–F must-not-move (3,204 files): 0 pass→fail, 0 fail→pass in every one of
  A/B/C/D/E-unlinked/E-linked/F-class/F-methoddef/F-objproto — byte-for-byte
  identical per-file outcomes vs the post-S50 base, not just equal totals.
- Corpus-byte (84 rows, 42 files × {gc, standalone}): 0 status flips, 0 sha
  flips.
- Equivalence gate: 22 failing / 1720 passing / 22 known-failures, no new
  regressions.

Full per-family tables are in `#5383`'s own issue file ("### S53b findings")
and in `#6637`'s issue file (new "S53b/S53b2 follow-up" section). **Verdict:
S53 is criterion-4-clean and ready to merge on this axis** — the fix's
narrow trigger shape (a Proxy binding escaping into an untyped call
parameter) simply does not occur anywhere in this battery's corpus, so zero
movement is the correct, expected outcome, not a sign the fix did nothing:
the 13-test unit-level witness suite (S53/#6637) already proves the
mechanism fires correctly when the shape IS present.

One gap this lane did not close: `.tmp/pr-body.md` did not exist in either
S53b's or S53b2's worktree (both `.tmp/` scratch dirs, gitignored, never
carried it forward from whatever S13-era session originally wrote it), so
there was nothing to refresh — a fresh PR body should be written from
scratch by whoever next opens or updates #5383's/#6637's PR.

## Stack state 2026-09-18 (post-S54) — main synced, PR #5978's head is now a
merge of `origin/main`; 0 stack-caused pass→fail across the full re-baseline

S54 (branch `issue-5383-standalone-temporal-s54`, off S53b2's head
`d1803a8bd2`, worktree `/home/user/js2/.claude/worktrees/agent-a035f428ff305a563`)
merged `origin/main` (~112 commits ahead) into the stack, per dispatch (PR
#5978 needed the sync to pass CI). Two commits: `abc4c6dc79` (the merge,
resolving one real conflict in `src/codegen/array-object-proto.ts` — kept the
stack's `function-proto-invokers.ts` over main's `function-proto-call-apply.ts`,
since the stack's covers `bind` and main's does not) and `7bee4f3268` (a
follow-up fix porting main's §20.2.3.1 step 3 `CreateListFromArrayLike`
TypeError, which the kept implementation was missing, found by re-running
main's own witness immediately after the merge). Full writeup in
[#6638](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6638-standalone-temporal-stack-main-sync-2026-09-18)
and #5383's "### S54 findings".

**New base numbers for the next lane** (superseding the post-S53b2 numbers
above — these are what to diff against next, not the pre-merge ones):

| Family | pass/total | Family | pass/total |
| --- | --- | --- | --- |
| Duration | 106/120 | E-unlinked | 238/300 |
| PlainDate | 113/120 | E-linked | 238/300 |
| PlainDateTime | 113/120 | F-class | 136/250 |
| ZonedDateTime | 103/120 | F-methoddef | 68/100 |
| A | 1129/1250 | F-objproto | 136/150 |
| B | 179/205 | | |
| C | 274/349 | | |
| D | 224/300 | | |

(E-unlinked/E-linked pass counts are the S53b2 base's 235 + the 3 `fail→pass`
moves found this lane; A is 1125 − 1 `pass→fail` + 5 `fail→pass` = 1129.)
`.tmp/s54/*-cur.tsv` in this worktree hold the full per-file re-run; the base
TSVs a future lane should diff against are the SAME `.tmp/s54-baseline/`
files this lane used PLUS these deltas — or, more simply, re-copy this
lane's `.tmp/s54/*-cur.tsv` files as the new base, since they already
reflect the corrected state.

**The one `pass→fail`** (family A:
`test/language/expressions/object/identifier-shorthand-static-init-await-valid.js`,
`pass` → `compile_error`) is **main's own pre-existing bug**
(`checkClassStaticBlockReservedNames` in `src/compiler/early-errors/module-rules.ts`,
from main's commit `06dbc8d88f`/#6491 — a file the stack never touches),
not caused by this sync or by anything in the stack. Left unfixed per this
lane's scope (sync only, no new feature work); worth its own issue if a
future lane wants to fix main's early-error over-generalization (the walk
should stop descending at a NESTED function body for the bare
`await`/`arguments`-identifier restriction, not just at the FunctionExpression
kinds it already special-cases).

Equivalence gate unchanged: 22 failing / 1720 passing / 22 known-failures.
Corpus-byte: 0 status flips (40 sha flips, expected from 112 commits of
unrelated main codegen changes — not a regression signal).

**Verdict: this head IS acceptable as PR #5978's new head.** Every witness
green, every gate green, and the only regression in 3,684 measured
real-provider test262 rows (1,250 A + 205 B + 349 C + 300 D + 300
E-unlinked + 300 E-linked + 250 F-class + 100 F-methoddef + 150 F-objproto +
480 four-family) is attributable to a main commit in a file the stack never
touches.

## Stack state 2026-09-18 (post-S58) — PR #5978 MERGED into main; S58 (#6641) is the first slice on top of merged main, four-family 437/480

PR #5978 (S13→S56 docs) landed on `main` at `9116ee2db3` (merge queue,
18:08 UTC); main is at `717d8d1de7` after the baseline refresh. The
`issue-5383-standalone-temporal-s13-s52` branch is merged and must not be
reused — every further slice goes out as a NEW branch + NEW PR off
`origin/main`.

S58 (branch `issue-5383-standalone-temporal-s58`, head `7e5056f77e`, off
`9116ee2db3`, worktree `/home/user/js2/.claude/worktrees/agent-a21090746acd50203`)
fixed [#6641](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6641-link-forward-computed-method-call):
a computed-key method call (`recv[k](…)`) on an `any`/externref receiver had
no generic dispatch arm under standalone/wasi and silently returned `null`.
New `src/codegen/expressions/dynamic-element-generic-call.ts`, wired in
`call-tail-dispatch.ts`. Full writeup in #5383 "### S58 findings".

**New base numbers** (lead-measured on `7e5056f77e`, fresh provider cache,
TSVs in `.tmp/s58/battery/*-cur.tsv` in the S58 worktree, S54 base copies
in `.tmp/s58/battery/base/`): identical to the post-S54 table except
ZonedDateTime 103 → **105/120** (four-family **437/480**). Every
must-not-move group A–F: 0 pass→fail, 0 fail→pass. Equivalence 22/1720/22.
Corpus byte A/B 0 status / 0 sha flips.

**Next lanes** (remaining 43 red rows): provider-side Proxy trap invocation
(10 rows; S55 WIP on `751ceea68e` in worktree `agent-a38808bf4e81ef147` —
next probe: call the provider's `__typeof_function` directly on the trap
value as the guard extracts it), `extends <provider class>` (#6640 +
#6623 residual, 4+2 rows), the two `era` rows (#6633, S50 WAT pointer),
and the one-offs listed in #5383 S58 findings.

## Stack state 2026-09-18 (post-S60) — PR #5981 (S58) MERGED; S59+S60 on `issue-5383-standalone-temporal-s59` at `98fe5e42fa`, four real BigInt codegen fixes, 12 ZDT rows still blocked on a realm-level `BigInt`

PR #5981 landed on `main` 22:12 UTC (after two CI fixes on the branch: the
new module's `scripts/compiler-boundaries.json` classification, and the
reverse-peer terminals' legacy `try … catch_all rethrow` → `try_table` —
CI runs Node 25, whose V8 rejects a module mixing both exception-handling
flavours; #6641's arm made that terminal live next to a user `try`). Any
new legacy `op: "try"` emitter that becomes live under standalone will hit
the same CompileError; use `buildStandardTryTable` (`src/ir/try-table.ts`).

S59 (Sonnet) + S60 (Opus) on #6642, see #5383 "### S59/S60 findings": four
fixed defects (stale helper funcIdx crash in `typeof-delete.ts`; `bigint ===
any` static fold; unbranded i64 hint for BigInt operands; i64 closure
results boxed as numbers), all revert-and-measured, 0 flips everywhere,
gc lane byte-identical. The 12 `ZonedDateTime` BigInt rows need the
four-link "realm BigInt" work specified in #6642 "Next step" (native
StringToBigInt; cross-link wrapper-ctor front-guard in
`builtin-ctor-callable.ts`; `CALLABLE_WRAPPER_CTORS`; standalone global
carrier) — an Opus-sized slice, links 1–2 must not land alone.

**Base numbers for the next lane**: unchanged from post-S58 (four-family
437/480: 113/106/113/105; A–F as in the post-S54 table). TSVs:
`.tmp/s60/battery/*-cur.tsv` in worktree `agent-af6e32dc2de7b3b76` (S60
head) — copy those as the base. Provider prewarm sequence per src change:
`pnpm run build:compiler-bundle && JS2WASM_TEMPORAL_CACHE=$PWD/.test262-cache/<label> node scripts/prewarm-temporal-provider.mjs --target standalone`;
first run in a fresh worktree also needs the QuickJS artifact copied from a
sibling `.test262-cache/` plus `node scripts/build-quickjs-eval-provider.mjs`.

**Next lanes** (one at a time, Opus): #6642 realm BigInt (12+3 rows);
Proxy trap invocation (10 rows; S55 WIP `751ceea68e` in worktree
`agent-a38808bf4e81ef147`); `extends <provider class>` (#6640 + #6623
residual); the two `era` rows (#6633).

## Stack state 2026-09-19 (post-S61) — PR #5984 (S59+S60) MERGED; S61 on `issue-5383-standalone-temporal-s61` at `14b0634c78` (native StringToBigInt), BigInt rows now blocked on `toString` of a bigint/number receiver

PR #5984 landed on `main` 00:09 UTC. S61 (Opus) landed #6642 link 1 (see
#5383 "### S61 findings"): `BigInt("<digits>")` now parses natively under
standalone; link 2 (cross-link ctor identity) proven unnecessary — every
standalone module owns its own realm + wrapper-ctor carriers; links 3+4
withheld because they expose link 5: `<any>.toString(radix)` throws under
standalone for number and bigint receivers, and `String(<bigint>)` answers
`0`. Base numbers unchanged (four-family 437/480). TSVs:
`.tmp/s61/battery/*-cur.tsv` in worktree `agent-a80fccfb366ccfbfe`.

**Next lanes** (one at a time, Opus): S62 = #6642 link 5 + re-apply links
3+4 (15 ZDT rows); then Proxy trap invocation (10 rows; S55 WIP
`751ceea68e` in worktree `agent-a38808bf4e81ef147`); `extends <provider
class>` (#6640 + #6623); the two `era` rows (#6633).

## Stack state 2026-09-19 (post-S62) — PR #5985 (S61) MERGED; S62 on `issue-5383-standalone-temporal-s62` at `bec0a80555`; #6642 DONE; four-family 447/480

PR #5985 landed on `main` 02:14 UTC. S62 (Opus) closed #6642 (see #5383
"### S62 findings"): dynamic-receiver `toString` for number and bigint
receivers, `String(<bigint>)`, plus the `BigInt` global carrier and
callable wrapper. **New base numbers**: PlainDate 113, Duration 106,
PlainDateTime 113, **ZonedDateTime 115** (four-family **447/480**); A–F
unchanged. TSVs: `.tmp/s62/battery/*-cur.tsv` in worktree
`agent-a3b2d877c2c97d38c` — copy those as the next base.

**Next lanes** (one at a time, Opus): Proxy trap invocation (10 rows +
`ZonedDateTime/prototype/add/order-of-operations.js`; S55 WIP `751ceea68e`
in worktree `agent-a38808bf4e81ef147`, next probe: call the provider's
`__typeof_function` directly on the trap value as the guard extracts it);
`extends <provider class>` (#6640 + #6623, incl. `subclassing-ignored`);
the two `era` rows (#6633); then new issues for the >2^63 BigInt range
(limb representation) and `options-read-before-algorithmic-validation`.

## Stack state 2026-09-19 (post-S63) — PR #5986 (S62) MERGED; S63 on `issue-5383-standalone-temporal-s63` at `8879da239c`; #6637 DONE; four-family 457/480

PR #5986 landed on `main` 06:10 UTC. S63 (Opus) closed #6637 (see #5383
"### S63 findings"): a consumer-built Proxy read inside the provider now
delegates its `[[Get]]` to the owning module through a new raw reverse
terminal (install ABI 5 → 6). **New base numbers**: PlainDate 116,
Duration 108, PlainDateTime 116, ZonedDateTime 117 (four-family
**457/480**); A–F unchanged. TSVs: `.tmp/s63/battery/*-cur.tsv` in
worktree `agent-a20160b027b58a139` — copy those as the next base.

**Next lanes** (one at a time, Opus): `extends <provider class>` (#6640 +
#6623 residual, incl. the `subclassing-ignored` rows — the largest
remaining bucket); the two `era` rows (#6633, S50 WAT pointer); new issues
for the >2^63 BigInt range (limb representation, whole-lane) and
`PlainDateTime/from/argument-string-offset.js`; #6628's foreign-closure
silent-`undefined` class (see S63 finding) once a Temporal row needs it.

## Stack state 2026-09-19 (post-S64) — PR #5987 (S63) MERGED; S64 on `issue-5383-standalone-temporal-s64` at `212ee38889`; #6640 DONE; four-family 459/480

PR #5987 landed on `main` 10:14 UTC. S64 (Opus) closed #6640 (see #5383
"### S64 findings"): a link-consumer class with a property-access heritage
into the provider namespace now constructs through the provider
(externref-backed, runtime parent). **New base numbers**: PlainDate 117,
Duration 108, PlainDateTime 117, ZonedDateTime 117 (four-family
**459/480**); A–F unchanged. TSVs: `.tmp/s64/battery/*-cur.tsv` in
worktree `agent-a7010bed034096fb2` — copy those as the next base.

**Next lanes** (one at a time, Opus): (a) `Function.prototype.apply` /
`.call` on a provider-owned METHOD VALUE returns `null` (new issue; blocks
`{PlainDate,Duration}/from/subclassing-ignored.js`); (b) identifier
heritage `class X extends <parameter>` under standalone link consumers
(new issue; blocks `Duration/prototype/abs` and
`ZonedDateTime/prototype/add` `subclassing-ignored.js`); (c) the two `era`
rows (#6633); (d) the >2^63 BigInt range (limb representation); (e)
`Duration/compare/order-of-operations.js` (#6628); (f)
`PlainDateTime/from/argument-string-offset.js` and the Duration one-offs.

## Stack state 2026-09-19 (post-S65) — PR #5988 (S64) MERGED; S65 on `issue-5383-standalone-temporal-s65` at `9441dba2e8`; #6643 DONE (mechanism); four-family 459/480

PR #5988 landed on `main` 14:18 UTC. S65 (Opus, resumed after a container
restart killed the first lane) closed #6643 (see #5383 "### S65
findings"): `f.apply`/`f.call` on a provider-owned method value no longer
falls into the peer arm. Rows unchanged (459/480) — the two `from/*`
`subclassing-ignored` rows now stop at `MySubclass.from` being undefined.
Base TSVs: `.tmp/s65/battery/*-cur.tsv` in worktree
`agent-a002eab6222ddeaa9` (identical to S64's).

**Next lanes** (one at a time, Opus): #6644 (reserved id, file to create)
= static-member inheritance + identifier heritage (`class X extends
<parameter>`) + cross-link `instanceof` for a linked-provider parent (all
four `subclassing-ignored` rows); then the two PlainDate `era` rows
(#6633), the >2^63 BigInt range, `Duration/compare/order-of-operations.js`
(#6628), `PlainDateTime/from/argument-string-offset.js`, the Duration
one-offs.

## Stack state 2026-09-19 (post-S66) — PR #5990 (S65) MERGED; S66 on `issue-5383-standalone-temporal-s66` at `3e7ac90073`; #6644 in-progress (three mechanisms landed); four-family 459/480

PR #5990 landed on `main` 19:44 UTC. S66 (Opus) landed cross-link
`instanceof`, static inheritance through a linked heritage and identifier
heritage with a captured parent (see #5383 "### S66 findings"); rows
unchanged. Base TSVs: `.tmp/s66/battery/*-cur.tsv` in worktree
`agent-a5b45fd9c24d31356` (identical to S65's).

**Next lanes** (one at a time, Opus): S67 = #6644 blockers (a) computed
static read class-name resolution via the property-access dispatch's
`resolvedClass`, (b) runtime spread into a resolved provider static
(`S[m](...a)`) — the two `from/*` `subclassing-ignored` rows; then
`super(...<runtime spread>)` via S34's argv driver (`abs`/`add` rows), the
two PlainDate `era` rows (#6633), the >2^63 BigInt range,
`Duration/compare/order-of-operations.js` (#6628),
`PlainDateTime/from/argument-string-offset.js`, the Duration one-offs.

## Stack state 2026-09-20 (post-S67) — PR #5992 (S66) MERGED; S67 on `issue-5383-standalone-temporal-s67` at `907ac32037` (+ merge of main); #6644 in-progress (residuals 1, 2, 4 closed); four-family 459/480

PR #5992 landed on `main` 00:22 UTC. S67 (Opus; lane killed by the 03:20
container restart, lead finished verification) landed identity-keyed
linked-static resolution, runtime spread into an inherited linked static,
and `super(...spread)` through a linked heritage (see #5383 "### S67
findings", #6644 "S67"). Rows unchanged at 459/480; the two `from/*`
`subclassing-ignored` rows now stop on `SameValue(«null», «undefined»)`.
Base TSVs: `.tmp/s67/battery/*-cur.tsv` in worktree
`agent-a6457c177911f46f1` (identical statuses to S66's; corpus base is
`.tmp/s67/corpus-fix.jsonl` — S66's stored corpus base had one stale sha).

**Next lanes** (one at a time, Opus): (a) the `SameValue(«null»,
«undefined»)` mechanism — `temporalHelpers.js` `canonicalizeCalendarEra`
receives `null` for an `undefined` `era` (#6633 era rows,
`PlainDate/from/argument-object-valid.js`, `argument-string.js`, the two
`from/subclassing-ignored` rows) — together with S67 residual 1 (a
rest-forwarded spread call `fwd(...args){ return this.echo(...args) }`
answers `undefined`, no provider needed; both are needed for the
`from/*` rows); (b) `instance[method](...a)` on a subclass instance
(`abs`/`add` rows); then the >2^63 BigInt range (new issue),
`Duration/compare/order-of-operations.js` (#6628),
`PlainDateTime/from/argument-string-offset.js` +
`overflow-default-constrain.js`, the Duration one-offs.

Environment traps unchanged (see post-S59/S60): rebuild
`scripts/compiler-bundle.mjs` before every prewarm, `JS2WASM_TEMPORAL_CACHE`
is a full path with a fresh label per src change, copy the QuickJS artifact
+ rebuild the eval provider in a fresh worktree, CI `quality` runs Node 25
(no legacy `try`). Container restarts every ~2–3 h: lanes commit WIP early.

## Stack state 2026-09-20 (post-S68) — S68 on `issue-5383-standalone-temporal-s68` at `d4416f899f` (off the S67 PR #5998 head); #6646 + #6645 DONE; the four `era` rows flip to pass

S68 (Opus) landed two mechanisms and closed the `SameValue(«null»,
«undefined»)` blocker. **The headline is a correction**: it was never a
provider resurrection. `PlainDate.prototype.era` answers `undefined` through
all eight routes measured (`from`, `from.apply`, `C["from"](...)`, a subclass,
a property descriptor — `.tmp/s68/probes/e4.js`), and
`canonicalizeCalendarEra` answers correctly for every spelling of `undefined`.
The `null` comes from ARGUMENT BINDING at the call site, in two arms:

- **#6646** — a spread into an identifier-held dynamic callee is lowered
  fixed-arity, so the source array becomes formal zero. The JS-host lane
  already had a repair (`emitDynamicSpreadCall`); the standalone twin was
  missing. New leaf `src/codegen/standalone-dynamic-spread-call.ts`
  (`__objvec` argv + `__apply_closure`), one splice in `call-identifier.ts`.
- **#6645** — a spread into a MEMBER callee, two arms: a positional argument
  AFTER a spread (the resolved-method arm binds formals by a compile-time
  accounting that a runtime-length spread breaks) and a spread into a callable
  PROPERTY (fixed-arity). Two splices in `call-receiver-method.ts`.

Rows: `PlainDate/from/argument-object-valid.js`, `…/argument-string.js`,
`PlainDate/from/subclassing-ignored.js`, `Duration/from/subclassing-ignored.js`
— all four **pass** (the last two with the callable-property splice alone; the
first two need the trailing-spread one, which is how each row is attributed).

**S67's residual 1 was a misattribution** — `fwd(...args){return
this.echo(...args)}` was already correct; that probe's callee reads
`arguments`, and `this.<m>(…)` on an `arguments`-reading method answers `null`
with no spread at all. A second splice written for that shape was REMOVED
rather than shipped.

**Environment trap the brief's prewarm line misses:** `node
scripts/prewarm-temporal-provider.mjs` builds only the HOST provider. Every
standalone Temporal probe/row needs `--target standalone` (or `both`), else it
answers `Temporal is not defined` / `standalone target emitted host imports`.
The QuickJS eval adapter must ALSO be rebuilt after each compiler-bundle
rebuild (its key hashes the bundle), or every row reports "quickjs provider is
not built".

Full writeup: #5383 "### S68 findings", plus the two issue files. Base TSVs for
the next lane: `.tmp/s68/battery/*-cur.tsv` in worktree
`agent-ab63aa31880f93760`; corpus base `.tmp/s68/corpus-fix.jsonl`
(statusFlips=0 shaFlips=0 vs S67's).

**Next lanes** (one at a time, Opus): (a) `instance[method](...a)` on a
subclass instance — the `abs`/`add` rows, still S67 residual 3; (b) the four
S68 residuals, all argument-binding cousins: a spread with no trailing
argument not applying a formal's DEFAULT (`number/2000/5/NULL`),
`this.<m>(…)` on an `arguments`-reading method answering `null`, a stored
function property called through a rest forward TRAPPING, and a defaulted
parameter returning `null` inside a `temporalHelpers.js`-scale module; then
the >2^63 BigInt range, `Duration/compare/order-of-operations.js` (#6628),
`PlainDateTime/from/argument-string-offset.js`, the Duration one-offs.
