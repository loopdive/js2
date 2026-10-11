---
id: 6766
title: "ES2015 standalone: a Proxy as [[Prototype]] — link carrier in `$Object.$proto`, per-hop trap dispatch, receiver-threaded [[Set]]"
status: in-progress
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 5196, 5316, 2046, 4721, 5268]
loc-budget-allow:
  # 2026-09-30 (#6766 plan): the per-hop proxy arms are NEW emitted-code paths
  # in the five prototype walkers, the link producers in the three prototype
  # writers, and a `$Object` field append. Heavy pieces go in the NEW leaf
  # `src/codegen/object-runtime-proxy-chain.ts`; the listed files grow by
  # wiring (an arm splice per walker, one `ref.null any` per `struct.new`).
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-chain.ts
  - src/codegen/dynamic-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/literals.ts
  - src/codegen/context/types.ts
  - scripts/compiler-boundaries.json
func-budget-allow:
  # 2026-09-30 (#6766 implementation): wiring only — the heavy bodies live in
  # the new leaf object-runtime-proxy-chain.ts. buildObjectPrototypeHelpers
  # gains the link-native registration + the canonicalize / getPrototypeOf /
  # SameValue hooks; ensureObjectRuntime gains the `protoLink` field, the
  # own-write registration gate, the reserved set-walk hooks and the arm fill
  # call; fillDynamicProtoHelpers gains the one `protoLink` null its sentinel
  # `struct.new $Object` needs; ensureProxyRuntime gains the 3-argument
  # [[Set]] dispatch's call into the leaf's receiver-observable forward.
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/dynamic-proto.ts::fillDynamicProtoHelpers
---

## Problem

Standalone cannot put a Proxy in a prototype chain. `$Object.$proto` is
`(ref null $Object)` and `$Proxy` is a sibling struct (not a subtype — the
#2009 canonicalization hazard, `src/codegen/object-runtime.ts:1233-1247`), so
`Object.create(proxy)` and `Object.setPrototypeOf(o, proxy)` store the proxy's
TARGET (`__proxy_get_target_if_absent`, `object-runtime-prototype.ts:366-421`,
reached from `canonicalizeProtoArg` at `:423`) or `null` when a `get` trap
exists. No trap ever fires on an inherited read/write/`in`, and
`Object.getPrototypeOf(heir)` is not the proxy.

Measured on `origin/main` @ `eb57f327` (2026-09-30), standalone,
`.tmp/probe.mts`-style module (`var __r = 0; …; export function readResult()`):

| probe | program | main | node |
| --- | --- | --- | --- |
| p1 | `receiver = Object.create(new Proxy({}, {set(t,k,v,r){log++; ctx = this===handler}}))`; `receiver.prop = 1` → `log*10 + ctx` | **0** | 11 |
| p3 | `child = Object.create(new Proxy({}, {get(t,k,r){ return r===proxy ? 1 : 2 }}))`; `child.attr*10 + proxy.attr` | **NaN** | 21 |
| p4 | `getPrototypeOf(Object.create(proxy)) === proxy` (1) + `proxy.isPrototypeOf(child)` (2) + plain-object control (4) + `setPrototypeOf(s, proxy)` then `getPrototypeOf(s) === proxy` (8) | **6** | 15 |
| p5 | `g = getPrototypeOf(Object.create(new Proxy({attr:5}, {})))`: `g===null` 1, `g===target` 4, `g===proxy` 8, `child.attr===5` 16 | **1** | 24 |

p5 shows the current answer is neither the target nor the proxy — the
chain is simply cut (`$proto = null`, and `child.attr` reads nothing).

This is #5196 cluster **B** ("proxy as `[[Prototype]]` + receiver threading",
12 rows), whose Step 4 design was written on 2026-09-01 but never
implemented (#5196 closed with B recorded as "own issue"; see its
`Recorded, not fixed` table row B). Since then #5316 r5 landed the receiver
primitive that Step 4-c needed: `__reflect_set_receiver(target, key, value,
receiver) -> i32` (`src/codegen/object-runtime-ordinary-set.ts`,
`reserveOrdinarySetWithReceiver` `:212` / `fillOrdinarySetWithReceiver` `:238`
/ `noteReflectSetReceiverCall` `:495`) and its proxy twin
`__proxy_set_receiver_dispatch(proxy, key, value, receiver)`
(`object-runtime-proxy.ts:1189-1204`, registered only when the primitive was
reserved). So the receiver half exists; what is missing is the LINK
representation and the per-hop arms.

### Rows (ES2015, standalone, non-pass on the 2026-09-29 22:47 UTC baseline)

Core — the proxy-as-prototype mechanism is the FIRST failing assertion
(10 rows; all must pass):

- `built-ins/Proxy/set/call-parameters-prototype.js`
- `built-ins/Proxy/set/call-parameters-prototype-index.js`
- `built-ins/Proxy/set/call-parameters-prototype-dunder-proto.js`
- `built-ins/Proxy/set/trap-is-null-receiver.js`
- `built-ins/Proxy/set/trap-is-missing-receiver-multiple-calls.js`
- `built-ins/Proxy/set/trap-is-missing-receiver-multiple-calls-index.js`
- `built-ins/Proxy/get/trap-is-undefined-receiver.js`
- `built-ins/Proxy/has/call-in-prototype.js`
- `built-ins/Proxy/has/call-in-prototype-index.js`
- `built-ins/Proxy/has/call-object-create.js`

Measure — the link is one of several mechanisms in the row (report each
row's verdict; a pass is a bonus, a residual gets its mechanism named):

- `built-ins/Proxy/get/trap-is-{missing,null,undefined}-target-is-proxy.js`
- `built-ins/Proxy/has/trap-is-{missing,undefined}-target-is-proxy.js`
- `built-ins/Proxy/defineProperty/trap-is-null-target-is-proxy.js`
- `built-ins/Proxy/setPrototypeOf/trap-is-null-target-is-proxy.js`
- `built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js`
- `built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-prototype-chain-set.js`
- `built-ins/Object/prototype/__proto__/set-cycle-shadowed.js`
- `built-ins/Function/prototype/Symbol.hasInstance/value-get-prototype-of-err.js`

Row lists: `.tmp/6766/core.txt` and `.tmp/6766/measure.txt` (paths relative
to `test262/test/`, one per line — the format `scripts/run-test262-paths.mts`
takes).

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order-preserving: steps 1–3 land together (a link with no arms is a chain
cut in a new place), step 4 is measure-first, step 5 is the record. Type
queries go through `ctx.oracle`, never `ctx.checker`.

### Step 0 — base copies and the before-state

- `mkdir -p .tmp/6766 && git archive origin/main src | tar -x -C .tmp/6766/base-src`
  (the revert copy; `rsync` is not installed).
- Write the four probes above into `.tmp/6766/p{1,3,4,5}.js` and a runner
  (`.tmp/6766/probe.mts`: `compile(source, { target: "standalone", allowJs:
  true, skipSemanticDiagnostics: true, deferTopLevelInit: true })`,
  instantiate, `__module_init`, `readResult`). Record the main answers.
- Run `core.txt` and `measure.txt` on the UNMODIFIED tree with
  `flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts <list> --isolate --standalone`
  (paths under `test262/test/`, i.e. `built-ins/…`, no `test/` prefix) →
  `.tmp/6766/core-base.log`, `.tmp/6766/measure-base.log`.

### Step 1 — representation: the proxy LINK field on `$Object`

- Append ONE field to `objectFields` (`object-runtime.ts` ~`:1218-1231`, after
  `nextSeq`): `{ name: "protoLink", type: { kind: "anyref" }, mutable: true }`.
  Append-only; do not renumber. Every `struct.new $Object` pushes one more
  `ref.null any` — there are exactly four sites (grep
  `struct.new", typeIdx: objectTypeIdx` / `types.objectTypeIdx`):
  `object-runtime.ts:2257` (`__new_plain_object`),
  `object-runtime-prototype.ts:636` (`__object_create`),
  `dynamic-proto.ts:602`, and
  `src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts:35`. Add a
  `PROTO_LINK_FIELD = 6` const next to the field list and use it everywhere
  (no bare `fieldIdx: 6`).
- A LINK is a fresh `$Object` with empty props, `$proto = null`,
  `flags = 0`, `protoLink = <the $Proxy>`. It is never handed to the program
  (`__getPrototypeOf` unwraps it, step 3), so it needs no flag bit; the
  non-null `protoLink` IS the discriminator. Do not reuse `0x10`/`0x20`/`0x40`
  (taken: `FLAG_INTERNAL`, vec-overlay) or `0x08`/`0x80`.
- Register a native `__proto_link_new(externref proxy) -> (ref $Object)` and
  `__proto_link_of(ref null $Object) -> externref` (the proxy, or null extern
  when the object is not a link) in the NEW leaf
  `src/codegen/object-runtime-proxy-chain.ts` (add it to
  `scripts/compiler-boundaries.json` the way H6 added
  `array-proxy-receiver.ts` — run
  `node scripts/check-compiler-boundaries.mjs --mode inventory` to confirm).
- Byte identity: everything in this issue is gated on `ctx.proxyDirty` (the
  H6 pre-scan flag, set at `src/codegen/array-holes.ts:189` when the source
  mentions the identifier `Proxy`). The field append itself changes the
  `$Object` type for EVERY module; that is accepted (one extra
  `ref.null any` per `struct.new`). Everything else — the natives, the arms,
  the producers — is emitted only when `ctx.proxyDirty`.

### Step 2 — producers: store a link instead of unwrapping

All three writers reach the argument through `canonicalizeProtoArg`
(`object-runtime-prototype.ts:423-428`), which today calls
`__proxy_get_target_if_absent` first. Under `ctx.proxyDirty`, replace that
first call with `__proto_link_wrap(externref) -> externref`: a `$Proxy`
argument (trap or no trap) becomes `extern.convert_any(__proto_link_new(p))`;
anything else passes through unchanged. Keep `__proxy_get_target_if_absent`
registered (other callers, #4721) but stop calling it from
`canonicalizeProtoArg`.

- `__object_create` (`:593-649`) — the link flows through the existing
  `ref.test $Object` → store path. `Object.create(proxy, descriptors)` is the
  same native plus the call-site descriptor materialisation; nothing extra.
- `__object_setPrototypeOf` (`:651+`) and its `_status` twin (`:708`
  region): (a) the SameValue step 2 must compare the CURRENT link's proxy
  with the requested proxy (`__proto_link_of(current) ref.eq
  any.convert_extern(requested)`), not the link object; (b) the cycle walk
  (step 4) must stop at a link (a proxy prototype ends OrdinarySetPrototypeOf's
  loop per §10.1.2.1 step 8.b: "If p.[[GetPrototypeOf]] is not the ordinary
  object internal method, set done to true") — emit `protoLink != null →
  break`. `set-cycle-shadowed.js` is the row for this.
- The `__proto__:` literal key (`literals.ts:554-566`) and the `__proto__`
  setter (`builtin-value-read.ts:1412`) both call `__object_setPrototypeOf`;
  verify with `call-parameters-prototype-dunder-proto.js` that no earlier
  arm intercepts a proxy value there.
- Compile-site side effects, at every `Object.create(<expr>)` /
  `Object.setPrototypeOf(<o>, <expr>)` / `__proto__` producer when
  `ctx.proxyDirty`: call `reserveOrdinarySetWithReceiver(ctx)` +
  `noteReflectSetReceiverCall(ctx)` (so `__reflect_set_receiver` and
  `__proxy_set_receiver_dispatch` exist for step 3) and set
  `ctx.inheritedSetDescriptorDirty = true` (so `__extern_set_decide`'s chain
  walk is emitted at all — `src/codegen/inherited-set-gate.ts` header). A
  simpler, equally correct gate: do all three once in the pre-scan when
  `proxyDirty` is set, and measure whether the H6 reach set stays
  byte-identical (it should: modules that mention `Proxy` already pay for
  the proxy runtime).

### Step 3 — consumers: one arm per walker, in `object-runtime-proxy-chain.ts`

Each walker gets a `fill<Walker>ProxyLinkArm(ctx)` that splices the arm at
the top of its prototype loop, following the `definedFuncAt` + `body`
splice idiom of `fillObjectAssignProxySourceArm`
(`object-runtime-enumeration.ts:1590`) and the H6 `fillProxyDispatch` guards
(`object-runtime-proxy.ts:1885-1960`). Call them from the finalize site that
calls `fillProxyDispatch` (`src/codegen/index.ts`; grep `fillProxyDispatch`).
Every arm: `cursor.protoLink != null → <proxy op>(extern(protoLink), key,
ORIGINAL receiver) ; return`. The ORIGINAL receiver is param 0 of the walker
(the object the program named), never the cursor.

| walker | where the loop reads `$proto` | arm |
| --- | --- | --- |
| `__extern_get` | `object-runtime.ts` inherited walk, the `loop` at ~`:2601-2660` whose cursor is local 9 (`struct.get objectTypeIdx fieldIdx 0` at `:2566`) | `return __proxy_get_dispatch(link, key, receiver)` — it already takes a receiver (`object-runtime-proxy.ts:1176`) |
| `__extern_set_decide` (#4504 walk, `:2471-2698`) and `__extern_set_own`'s inherited-accessor arm (`:2847-2960`, cursor local 10) | same shape | `__proxy_set_receiver_dispatch(link, key, value, receiver)`; return its boolean as the decision (`SET_DECISION_HANDLED` when the trap/forward ran). Its trap-absent arm runs `__reflect_set_receiver(target, key, value, receiver)`, which creates the own property on the HEIR (§10.1.9.2 step 2.c–e) — `trap-is-missing-receiver-multiple-calls.js` observes exactly the gopd/defineProperty traps that walk fires |
| `__extern_has` / `__extern_has_with_implicit_object_proto` (`:3820-3950`) | the `$proto` loop | `return __proxy_has_dispatch(link, key, receiver)` |
| `__getPrototypeOf` (`object-runtime-prototype.ts:513-591`, `protoFieldAnswer`) | reads `$proto` once | if the field is a link, answer `__proto_link_of(field)` (the PROXY), else the existing answer |
| `__isPrototypeOf` (`:922-960`) | seed + loop | when the cursor is a link: `Reflect`-style — the proxy's `[[GetPrototypeOf]]` is the trap (`__proxy_gpo_dispatch`, `object-runtime-proxy.ts:1897`); compare identity against the PROXY (`__proto_link_of`) before hopping, then continue from `__proxy_gpo_dispatch(link)` |
| for-in / `Object.keys` inherited enumeration (`object-runtime-enumeration.ts:607` region) | its `$proto` hop | stop at a link and append `__proxy_ownkeys_names_dispatch(link)` filtered by enumerability through `__proxy_gopd_dispatch` (the #5268 2.4 filter); if that is more than the slice can carry, stop at the link and record it (no ES2015 core row needs for-in over a proxy prototype) |
| `__object_setPrototypeOf` cycle loop | step 2 (b) | `break` at a link |

Audit — these also read `$proto` (field 0) and must be classified as "walks
(needs the arm)" or "links only (no change)": `dynamic-proto.ts:566`,
`vec-proto-link.ts` (4 reads, 3 writes), `promise-subclass-proto-link.ts`,
`promise-dynamic-member-read.ts` (3), `proto-function-value.ts`,
`src/runtime/wasmgc/values/prototype-chain-bodies.ts`,
`object-runtime.ts:1793/1810` (`objectTerminalAllowsImplicitProto`). Write
the classification into the record; a walker left without an arm is a
silent chain cut, which is worse than today's null.

Receiver rule for the trap `this`: the handler (`phandler`), never the
receiver — the dispatch drivers already do this (`fillProxyDispatch`
threads `handler` as `thisVal`); `call-parameters-prototype.js` asserts it.

### Step 4 — measure, then the exotic-target residue

Re-run `core.txt` (all 10 must pass) and `measure.txt`. For each residual
name the first failing assertion and its mechanism; the `*-target-is-proxy`
rows also need the F cluster (exotic targets: array `length`, `new
String("str")` indices, RegExp accessors, function `name`/`length` —
#5196 Step 6, #5268) and are NOT this slice's to finish. Do not build a
second array/string MOP inside the proxy runtime.

### Step 5 — pins, controls, gates, record

- Pin suite `tests/issue-6766-proxy-as-prototype.test.ts`: p1, p3, p4, p5
  as "RED on base" pins (assert the node answer), plus three guards that
  answer the same on both trees: a plain `Object.create({})` chain read, a
  `Object.create(null)` write, and `Object.setPrototypeOf(o, {})` identity.
  The file must be red on `.tmp/6766/base-src` (swap `src/` in, run, swap
  back) — write the base verdict into the record.
- Controls (0 pass → non-pass, per-path set diff, `--isolate`): every
  currently-passing ES2015 standalone row under `built-ins/Proxy/**`,
  `built-ins/Reflect/**` and `built-ins/Object/**` (extract from
  `.test262-cache/test262-standalone-current.jsonl`, `status:"pass"`; ~900
  rows, ~40 min under the lock — run it once, at the end, on the merged
  tree).
- Byte identity outside `proxyDirty`: compile 20 rows from
  `language/expressions/object/**` that do not mention `Proxy` on base and
  branch and compare `sha256` of `.binary`. The `$Object` field append WILL
  move bytes; report that honestly and show the diff is only the extra
  `ref.null any` per `struct.new` (compare `wasm-objdump -d` or the
  instruction count).
- Gates, run bare and chained: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)` for loc/func, plus
  `npm run -s check:host-import-policy` (if present in `package.json`),
  `node scripts/check-compiler-boundaries.mjs --mode inventory`, and `npm
  run -s typecheck`. `check:dead-exports` leaves ~80 MB in
  `.tmp/core-node-execution-*` (#6764) — delete it after the run.
- Record: append `### 2026-09-30 — #6766 implementation (Opus)` to THIS
  file with the before/after row tables, the walker audit table, the pins'
  base verdict, the control diff, the byte-identity note, and residuals with
  mechanisms; then a one-paragraph pointer in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md` under a new
  `### 2026-09-30 — #6766 …` heading.

## Acceptance criteria

- The 10 core rows pass on standalone (`--isolate`), measured on the
  branch with `origin/main` merged in.
- p1 = 11, p3 = 21, p4 = 15, p5 = 24 on the branch; the pin file is red on
  the base sources.
- 0 pass → non-pass across the `Proxy`/`Reflect`/`Object` control.
- Every `$proto` reader in the audit table is classified; every walker has
  its arm or a recorded reason.
- All gates green; `src/ir/select.ts` untouched; growth grants in this
  file's frontmatter only.

## Lane protocol

- Worktree: `git worktree add /home/user/js2/.claude/worktrees/issue-6766 -b issue-6766-proxy-proto-link origin/main`,
  then `ln -s /home/user/js2/node_modules <wt>/node_modules` and
  `ln -s /home/user/js2/test262 <wt>/test262` (the hook does not provision
  them here). Never edit `/home/user/js2` itself — it is the BASE tree the
  lead measures against.
- One test262 runner at a time on this 4-core box: every
  `run-test262-paths.mts` invocation goes through
  `flock /tmp/claude-0/t262.lock …`. Rebuild the QuickJS adapter after a
  `src/` change if a row reports "provider is not built":
  `npx tsx scripts/build-quickjs-eval-provider.mjs`.
- Commit early and push the branch immediately (`git push -u origin
  <branch>`; the pre-push hook is slow — run it with output redirected to a
  log, then confirm with `git ls-remote origin <branch>`). Do NOT open a PR:
  the lead verifies the pushed head and opens it.
- Commit format: subject ends with ` ✓`; author `Thomas Tränkler
  <git@thomas.traenkler.com>`, committer `Claude <noreply@anthropic.com>`
  (`GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git
  -c user.name="Thomas Tränkler" -c user.email=git@thomas.traenkler.com
  commit -m "<msg>"`); trailers `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>`, `Claude-Session:
  https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`, `Model: Claude
  Opus 5.5 High`. Never `--no-verify`.
- No `git stash`; A/B by file copy from `.tmp/6766/base-src`.

### 2026-09-30 — #6766 implementation (Opus)

Branch `issue-6766-proxy-proto-link`, merged with `origin/main` @ `d0e6abb8`
(every table below), then again @ `54a85ebd`: on that tree typecheck, all
gates, the pin file plus `issue-1898`/`issue-1837` (19/19) and the 21 core +
measure rows were re-run — identical verdicts (10 pass: core 6, measure 4).
The 643-row control was measured on the `d0e6abb8` merge only; the
`d0e6abb8..54a85ebd` delta touches no file this branch changes (the new
String-exotic descriptor bodies belong to the unwired native-backend layout).
All runs standalone, `--isolate`, serialized under the shared lock.

**Result.** Core **6/10** (base 0/10), measure **4/11** (base 1/11), probes
p1/p3/p4/p5 = node (11/21/15/24; base 0/NaN/6/1). The four core rows still red
fail on mechanisms OTHER than the link (below, with evidence) — acceptance
criterion 1 does not hold.

#### What landed (and why)

- **Representation** — `$Object` gains an appended `protoLink` anyref
  (`PROTO_LINK_FIELD = 6`, guarded against renumbering in `objectFields`). A LINK
  is a fresh empty `$Object` (`$proto` null, flags 0) holding the `$Proxy`; the
  non-null field is the discriminator. Every legacy `struct.new $Object` pushes
  one `ref.null any`: `emitWrapperBuildTail`, `__new_plain_object` (via
  `withProtoLinkNull`, see deviations), `__object_create`, the dynamic-proto
  sentinel.
- **Producers** — `canonicalizeProtoArg` calls `__proto_link_wrap` (a `$Proxy`,
  trap or no trap → new link; anything else unchanged) instead of
  `__proxy_get_target_if_absent` (still registered, now unreferenced in the
  link regime). `__object_create`, `__object_setPrototypeOf{,_status}`, the
  `__proto__:` literal and the `__proto__` setter all reach it.
  `__object_setPrototypeOf{,_status}` step 2 compares two links by the Proxy
  they hold (`__proto_link_same`); the cycle walks stop at a link by
  construction (its `$proto` is null — §10.1.2.1 8.b).
- **Consumers** — `fillProtoLinkArms` (new leaf
  `src/codegen/object-runtime-proxy-chain.ts`) splices one arm after the cursor
  null check of every prototype walk loop (`local.get C; ref.is_null …; hop
  struct.get $Object 0; local.set C`), right after `ensureProxyRuntime`:
  `[[Get]]` → `__proxy_get_dispatch(proxy, ToPropertyKey(P), receiver)` with the
  `__extern_get` explicit receiver; `[[HasProperty]]` → `__extern_has(proxy,
  key)`; `[[Set]]` (#4504 decide walk) → `__reflect_set_receiver(proxy, key, V,
  receiver)` → HANDLED/REFUSED; the terminal predicate answers 0 at a link (the
  Proxy already answered; no implicit `%Object.prototype%`); `__isPrototypeOf`
  continues from a link through the Proxy's own `[[GetPrototypeOf]]`
  (`__proto_link_chain_from`, identity by `ref.eq` on `eq`) and a Proxy RECEIVER
  is compared as itself (the #4721 target unwrap is dropped there too).
  `__getPrototypeOf` answers the linked Proxy.
- **[[Set]] without #4504** — `__extern_set` / `__reflect_set` get a reserved
  `__proto_link_set_walk(obj, key, V) -> 0|1|2` (first of: a link → the
  receiver-threaded set, an own entry → 0) at the own-miss position; so a
  refusing trap throws in strict code and answers `false` to `Reflect.set`
  in both #4504 modes (pin p9).
- **Receiver-side write** — §10.1.9.2 3.d-e is OWN-only. `writeOnReceiver`
  wrote through `__extern_set(receiver)`, a full [[Set]] that walks back into
  the link → infinite recursion; in the link regime it now writes through
  `__extern_set_own` first (registration widened from #4504-only to
  `inheritedSetRuntimeActive || protoLinkActive`); its UNADMITTED (not a
  `$Object`) answer keeps the old write.
- **Trap-absent 3-argument [[Set]]** — `__proxy_set_dispatch` forwarded
  `__extern_set(target, …)`, dropping Receiver = proxy. When the proxy has a
  `getOwnPropertyDescriptor` or `defineProperty` trap (the only case where the
  receiver-side [[GetOwnProperty]]/[[DefineOwnProperty]] is observable) it now
  forwards through `__reflect_set_receiver(target, key, V, proxy)` and publishes
  the boolean on the #4504 channel (`protoLinkReceiverSetForward`). Fixes
  `trap-is-missing-receiver-multiple-calls{,-index}.js`.
- **Keys** — every arm hands the trap `__to_property_key(P)` (`0 in heir` asks
  `has` for `"0"`; a Symbol passes unchanged).

Deviations from the plan, each deliberate:

1. `src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts` is NOT edited:
   `buildOrdinaryObjectCreateBody` also serves the native-backend recipe
   (`ordinary-object-storage-definitions.ts`) whose `$Object` declaration
   (`object-layouts.ts`, "kept in the legacy storage order") stays 6-field; the
   legacy caller appends the null via `withProtoLinkNull`. Recorded here so the
   native-backend layout can adopt the field when it is wired in.
2. `__proto_link_new` / `__proto_link_of` are folded into `__proto_link_wrap`
   plus an inline `struct.get $Object 6`; no separate natives.
3. Arms are spliced at build time right after `ensureProxyRuntime` (bodies are
   still their builders' output; later finalize fills only unshift), not at the
   `fillProxyDispatch` finalize site.
4. No `inheritedSetDescriptorDirty` forcing: both #4504 modes carry their own
   arm, so non-link modules' [[Set]] lowering is untouched.
5. Coercion-vocabulary neutral: arms route through existing i32 chokepoints
   (`__extern_has`, `__reflect_set_receiver`) instead of `__is_truthy`.

#### Walker audit — every `$proto` (field 0) reader

| reader | kind | status |
| --- | --- | --- |
| `__extern_get` loop (`object-get-bodies.ts` hop) | walks | arm → `__proxy_get_dispatch` |
| `__extern_has` main + fnctor loops (`object-runtime.ts`) | walks | arm (both loops) → `__extern_has(proxy)` |
| `__extern_set_decide` seed + loop | walks | arm → `__reflect_set_receiver` |
| `__extern_set` / `__reflect_set` without #4504 | own-miss create | reserved `__proto_link_set_walk` |
| `__extern_set` `inheritedAccessorArm` (vecAccessorDescriptorDirty, no #4504) | walks (accessor only) | ends at a link (null `$proto`); the set walk right after takes the link — no arm needed |
| `__object_terminal_allows_implicit_proto` | walks | arm → 0 |
| `__extern_has_with_implicit_object_proto` | via the two above | covered |
| `__getPrototypeOf` `protoFieldAnswer` | reads once | answers the Proxy |
| `__object_setPrototypeOf{,_status}` SameValue | reads once | link-aware `__proto_link_same` |
| `__object_setPrototypeOf{,_status}` cycle loops | walks | stops at a link by construction (§10.1.2.1 8.b) — no arm |
| `__isPrototypeOf` (`prototype-chain-bodies.ts`) | walks | arm + Proxy-receiver front arm |
| `__object_keys_forin` (`object-runtime-enumeration.ts:607`) | walks | stops at the link — **residual**: a Proxy prototype's keys are not enumerated (no ES2015 core row) |
| `dynamic-proto.ts` `__struct_proto_set` cycle walk | walks | stops at a link (the #802 slot stores the raw proxy, never a link) — links only |
| `vec-proto-link.ts` (4 reads, 3 writes) | bag `$proto` | never holds a link in this slice (no vec producer) — links only |
| `promise-subclass-proto-link.ts` (3) | walks (Promise-subclass `instanceof`) | ends at a link → false — **residual** (a proxy between an object and a Promise-subclass prototype; no ES2015 row) |
| `promise-dynamic-member-read.ts` (3) | reads bag `$proto` of a `$Promise` subclass instance | links only |
| `proto-function-value.ts:457` | null test on a callable's bag `$proto` | links only |
| `to-primitive-wrapper-bodies.ts` (2) | walks (wrapper ToPrimitive) | ends at a link — **residual** (a wrapper with a Proxy prototype) |
| `ordinary-object-access-bodies.ts:55` | walks | native-backend pipeline, not wired to production — links only |
| `native-dynamic-instanceof.ts` | via `__isPrototypeOf` | covered |

#### Core rows (10) — base `eb57f327` vs branch (merged `d0e6abb8`)

| row | base | branch | now fails at / mechanism |
| --- | --- | --- | --- |
| `set/call-parameters-prototype.js` | fail L49 | **pass** | |
| `set/call-parameters-prototype-index.js` | fail L51 | fail L51 | vec receiver (residual R1) |
| `set/call-parameters-prototype-dunder-proto.js` | fail L52 | **pass** | |
| `set/trap-is-null-receiver.js` | fail L26 | fail L26 | part 1, before any link (R2); the link half passes alone |
| `set/trap-is-missing-receiver-multiple-calls.js` | fail L63 | **pass** | |
| `set/trap-is-missing-receiver-multiple-calls-index.js` | fail L64 | **pass** | |
| `get/trap-is-undefined-receiver.js` | fail L24 | fail L24 | part 1, before any link (R2); the link half passes alone |
| `has/call-in-prototype.js` | fail L41 | **pass** | |
| `has/call-in-prototype-index.js` | fail L43 | fail L43 | vec receiver (R1) |
| `has/call-object-create.js` | fail L36 | **pass** | |

**The plan's premise does not hold for 4 of the 10**: on base their FIRST
failing assertion is not the link. `.tmp/6766/t/recv-part2.js` (the second
halves of `trap-is-null-receiver.js` and `trap-is-undefined-receiver.js`
alone, through the real runner) passes on the branch.

- **R1 — vec receivers** (`…-prototype-index.js`, `call-in-prototype-index.js`).
  `Object.setPrototypeOf(array, proxy)` stores nothing: a vec's [[Prototype]]
  lives in its #3537 bag `$proto` (vec-proto-link.ts), whose
  `__object_setPrototypeOf`/`__getPrototypeOf` arms exist only when an
  Array-rooted class linked; and the typed lane never asks a prototype —
  `1 in array` is an inline `i < length` compare, `array[0] = 1` an inline store
  (WAT of both rows). Needs a vec slice: link-regime vec arms in the two
  natives, `in` routed through `__extern_has_idx` (the #4159 overlay hand-off)
  with a bag-link miss arm, and hole/OOB stores consulting the bag link.
- **R2 — the proxy binding's slot** (`trap-is-{null,undefined}-receiver.js`
  part 1). `var p = new Proxy(target, …)` escapes into
  `assert.sameValue(…, p)`, a PROPERTY-ACCESS callee, which #6637's
  `calleeParamIsUntyped` (`analysis/proxy-binding-escape.ts`) does not exempt,
  so the binding takes the target literal's struct slot and the Proxy is
  MATERIALIZED into a fresh struct at the declaration (`$__mod_p (ref null 84)`;
  the extern→struct coercion `struct.new 84`s a copy). Candidate fix: accept a
  property-access callee whose declarations all live in non-`.d.ts` sources and
  whose matching parameter is implicit-any (lib `.call`/`.apply` receivers, the
  #2615 class, stay excluded by their `.d.ts` declarations).
  `trap-is-null-receiver.js` additionally needs the trap-absent 3-argument
  [[Set]] to keep Receiver = proxy for an ACCESSOR on the target (`set: null`
  + `set attr(v)`); `protoLinkReceiverSetForward` takes that path only when a
  gopd/defineProperty trap can observe the receiver.

#### Measure rows (11)

| row | base | branch | mechanism of the first failure |
| --- | --- | --- | --- |
| `get/trap-is-missing-target-is-proxy.js` | fail L24 | fail | L24 (`Object.create(regExpProxy).lastIndex`) now PASSES (checked alone, `.tmp/6766/t/getproxy-l24.js`); the reported message is L25's `regExpProxy[Symbol.match]` → `undefined` (F cluster: RegExp `@@match` through a proxy of a proxy — the runner prints L24) |
| `get/trap-is-null-target-is-proxy.js` | fail L25 | fail L25 | F: `stringProxy.length` (String exotic `length` through a proxy) |
| `get/trap-is-undefined-target-is-proxy.js` | pass | pass | |
| `has/trap-is-missing-target-is-proxy.js` | fail L24 | fail L24 | F: `Reflect.has(regExpProxy, "ignoreCase")` (RegExp accessor on a proxy target) |
| `has/trap-is-undefined-target-is-proxy.js` | fail L33 | **pass** | |
| `defineProperty/trap-is-null-target-is-proxy.js` | fail | fail (same message) | `plainObject.bar` after defining an accessor through a proxy of a proxy with `defineProperty: null` — not a link |
| `setPrototypeOf/trap-is-null-target-is-proxy.js` | fail L35 | fail L35 | nested-proxy [[SetPrototypeOf]] forward with V = null does not reach the ordinary target — not a link |
| `TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js` | fail | fail (same) | a TypedArray in [[Prototype]] position (`Object.create(ta)`, first part — no Proxy): `$Object.$proto` cannot hold a TA carrier either, plus §10.4.5.5 with Receiver ≠ O |
| `…/key-is-canonical-invalid-index-prototype-chain-set.js` | fail | fail (same) | same |
| `Object/prototype/__proto__/set-cycle-shadowed.js` | fail L35 | **pass** | |
| `Function/prototype/Symbol.hasInstance/value-get-prototype-of-err.js` | fail L24 | **pass** | |

#### Pins — `tests/issue-6766-proxy-as-prototype.test.ts`

Seven RED-on-base pins (p1 base 0, p3 NaN, p4 6, p5 1, `in`/heir-write 14,
keys/revocation 26, strict refusal 1111 — each the node answer on the branch)
and three guards. Run against the base sources by swapping `src/` for
`.tmp/6766/base-src` (base `eb57f327`): **7 failed, 3 guards passed**; on the
branch 10/10.

#### Byte identity outside the Proxy regime

20 rows sampled across `language/expressions/object/**` without `Proxy`,
compiled through the original harness with the runner's standalone options,
base `d0e6abb8` vs branch: 19 compile on both (1 is a negative-syntax row that
fails on both), **0/19 byte-identical, as expected** — every difference is the
`$Object` type line (`+ (field $protoLink (mut anyref))`) plus one
`ref.null any` per `struct.new $Object` (43-59 per module: `__new_plain_object`
is inlined at its call sites), **0 unexplained WAT lines**, +89…+121 bytes per
module (`.tmp/6766/bytes.log`).

#### Other test files

`issue-1898`/`issue-1837` (the `$Object` arity/field guards), `issue-4721`,
`issue-4602`, `issue-4749`, `issue-3768`, `issue-6684`, `issue-5239`,
`issue-5316-r4/r5/r6` green. `issue-2046` (2 failures) and `issue-4504` (14
failures, after building `scripts/{compiler,runtime}-bundle.mjs`) fail
IDENTICALLY on the base sources (stale compile-refusal expectations; harness
variant-count assertions) — its Proxy subtest ("forwards Proxy trap success
and refusal through Reflect and strict assignment") passes on both.

#### Control — 643 rows, 0 pass → non-pass attributable to the branch

Set (from the 2026-09-29 22:47 UTC standalone baseline artifact
`.test262-cache/test262-standalone-current.jsonl`, `status:"pass"` only): every
ES2015 row under `built-ins/{Proxy,Reflect,Object}/**` (567 — the plan's ~900
estimate counted all editions) ∪ every row of ANY edition whose source
mentions `Proxy` (362, the `proxyDirty` reach set — these are the modules
whose layout and walkers the link regime actually changes) = **643** unique
rows. Run on the branch merged with `d0e6abb8`, standalone, `--isolate`, six
chunks under the lock.

| | rows |
| --- | --- |
| pass on the branch | 635 |
| non-pass on the branch | 8 |
| of those, non-pass with the SAME message on base `d0e6abb8` (`.tmp/6766/basetree`) | 8 |
| **pass → non-pass attributable to the branch** | **0** |
| gained (baseline-pass set, so none possible) | 0 |

The 8 are `built-ins/Temporal/*/prototype/toJSON/{basic,options}.js` — they
pass in the CI standalone baseline but not in this container on either tree:
`Duration/…/options.js` is a compile refusal ("standalone target emitted host
imports: env::__temporal_duration_to_string (#2961)"), the other 7 throw a
host `TypeError` at the `toJSON` call. A local-vs-CI environment difference,
not this change. One further row
(`built-ins/JSON/stringify/replacer-array-proxy-revoked-realm.js`) first
failed on "quickjs provider is not built"; after
`npx tsx scripts/build-quickjs-eval-provider.mjs` it passes.
