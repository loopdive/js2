# Backlog index

Lightweight pointer index for unscheduled issues that need sprint candidacy. Authoritative status lives in each issue file's frontmatter.

## Sprint 57 — acorn dogfood + backend-agnostic IR (2026-05-29)

Architectural sprint (no pass-count target; zero-regression guard). Goals:
[`self-hosting-dogfood`](../../goals/self-hosting-dogfood.md),
[`backend-agnostic-ir`](../../goals/backend-agnostic-ir.md). Plan:
[sprints/57.md](../sprints/57.md).

Track 1 — acorn dogfood:
- [#1710](../1710-acorn-dogfood-harness.md) — acorn harness: compile + validate + diff-AST vs node-acorn — high, medium, **ready (s57)**.
- [#1711](../1711-acorn-failure-surface-triage.md) — triage harness surface → file sized child issues — high, medium, **ready (s57)**, depends on #1710.
- [#1712](../1712-acorn-acceptance-differential-ast.md) — acceptance: compiled acorn AST == node-acorn — high, hard, **backlog→ready** after #1710/#1711.
- Prior blockers #1679/#1690/#1690b are **done**.

Track 2 — backend-agnostic IR (all need architect spec; #1713 blocking):
- [#1713](../1713-ir-backend-emitter-trait-seam.md) — BackendEmitter trait + WasmGC bias audit + WasmGcEmitter (pure refactor, zero conformance delta) — high, hard, **ready (s57), needs arch spec**.
- [#1714](../1714-ir-two-backend-proof-linear.md) — lower one IR node kind to BOTH WasmGC + linear via the trait (primary proof) — high, hard, **backlog→ready** after #1713.
- [#1715](../1715-ir-bytecode-proof-point.md) — minimal bytecode emitter + dispatch loop for an IR subset (stretch proof) — medium, hard, **backlog→ready** after #1713.
- Feeds [#1584](../1584-wasm-gc-native-interpreter.md) (in-Wasm bytecode interpreter) — gated on both tracks + #1712.

## Standalone (--target wasi) host-import audit (2026-05-25) — goal `standalone-mode`

Empirical per-construct audit of remaining JS-host (`env.*`) leaks under `--target wasi`. Audit record: [#1662](../1662-standalone-host-import-audit.md) (done). Each genuine remaining leak is owned by a tracking issue; new gaps filed where the cited issue was closed without coverage or no native-engine issue existed. Already-tracked: Map/Set → #1103, number→string → #1335, RegExp → #682/#1474, closures/callbacks → #1470, JSON Phase 2 → #1599. Expected/wont-fix (not filed): eval, Proxy, with, dynamic import, full Intl collation.

- [#1662](../1662-standalone-host-import-audit.md) — Audit record + findings table (done) — high, easy.
- [#1666](../1666-standalone-invalid-wasm-native-string-number-lowering.md) — **Bug**: `--target wasi` emits *invalid* (non-instantiable) wasm for class/closure/callback-array-methods/number→string/regex/generator/typed-array — `__str_flatten`/`__str_to_extern` type mismatch + unbound late global (`0xffffffff`). More severe than a leak (won't instantiate even with a host). Fix first — masks #1664. — high, hard, ready.
- [#1663](../1663-standalone-parseint-parsefloat-native.md) — Pure-Wasm `parseInt`/`parseFloat`/`Number(string)`. `env.parseInt`/`env.parseFloat` still leak; #1471 (the cited owner) closed without implementing them. — medium, medium, ready.
- [#1664](../1664-standalone-extern-object-iterator-residual.md) — Residual `__extern_*`/`__register_*`/`__iterator*`/`__array_*`/`__get_undefined` leaks after #1472 landed partial. class/super, typed-array `.set`/`.subarray`, Map/Set. — medium, hard, ready (after #1666).
- [#1665](../1665-standalone-native-generators.md) — Wasm-native generators (state-machine lowering) to retire `__gen_*`/`__create_generator*`/`__iterator*` host scheduler. Currently only owned by the #1376 IR telemetry gate, not a native-engine issue. — medium, hard, ready (after #1666).

## Harvest 2026-05-24b (fixable test262 compile-error causes — CE decomposition)

Decomposed the 1,367 `compile_error` results in `test262-current.jsonl`. The
528 `invalid Wasm binary` CEs were sub-clustered by validator error; sub-causes
already enumerated in #1522 / #1543 / #1556 are not re-filed.


## Harvest 2026-05-24 (new issues from test262 error analysis)

- [#1591](1591-class-elements-same-line-multi-definition.md) — class/elements same-line / stacked member definitions lost or reordered — **~294 fails**, high priority (formerly 779b)
- [#1592](1592-ary-ptrn-elision-rest-holes-dstr.md) — Array pattern elision holes / rest-array consume wrong iterator step — **~305 fails**, high priority
- [#1593](1593-default-init-triggers-on-null-should-be-undefined-only.md) — Destructuring default init triggers on `null` (spec: undefined-only) — **~165 fails**, easy
- [#1594](1594-annexb-strict-function-code-tdz-referenceerror.md) — AnnexB strict function-code / class name-binding TDZ not throwing ReferenceError — **~100 fails**, medium
- [#1595](1595-arraybuffer-transfer-methods-not-implemented.md) — ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented — **~40 fails**, medium
- [#1596](1596-function-prototype-apply-call-not-accessible.md) — Function.prototype.apply / .call not accessible on compiled Wasm functions — **~46 fails**, high

## Destructuring-lane sweep follow-ups (2026-05-24)

From the dev-1553b destructuring-lane verification sweep.

- [#1658](../1658-destructured-function-param-default-not-applied.md) — Destructured/scalar **function-parameter** default not applied: returns 30 where 40 is expected on the real runtime (distinct from the object/array decl-mode #1553b/#1553d which are done) — high, medium, **ready**. NOT currently caught by CI (see #1659); depends on #1659 for gating.
- [#1659](../1659-ci-equivalence-tests-not-run.md) — CI does not run `tests/equivalence/` (OOMs in runner) so genuine equivalence regressions (e.g. #1658) land silently. Options: shard like test262 / constrained workers / `--no-threads` / separate scheduled job. Sub-item: fix `__extern_get` harness-fidelity gap in `tests/equivalence/helpers.ts` so the suite runs clean — high, medium, **ready**. Gates CI-visibility of #1658.

## Sprint 55 — repo structure / website (2026-05-24)

- [#1656](../1656-group-website-files-into-website-dir.md) — Consolidate all website/frontend files under `website/` (components, dashboard, playground, index.html, public, frame-nav-sync.js, images, vite.config.ts, CNAME) — medium, medium, **ready (sprint 55)**. Needs architect spec (`arch(#1656)`) before dev; lands as one PR. Related: #1583, #1590.
- [#1657](../1657-mq-test262-paths-filter.md) — Skip `merge_group` test262 shards for non-src changes while keeping the "merge shard reports" required check green — medium, medium, **in-review (sprint 55)**. Conservative path detector (`scripts/test262-paths-match.sh`) + `changes` job gate the queue's shard matrix; fail-safe runs shards on any doubt. Related: #1656.
- [#1661](../1661-readme-programmatic-api-host-imports.md) — README programmatic-API example fails: `instantiate(binary, {})` but default JS-host mode emits `string_constants` + `env.*` imports, so the empty-imports snippet throws `Import #0 "string_constants"`. Recommend switching the example to standalone / no-host mode (#1471–#1474) so it genuinely runs under `{}`, and document the default-vs-standalone import requirement — **high**, easy, **ready (sprint 55)**. Plan-only; from guest271314 GitHub #601. Same theme as #389 (docs imply standalone behavior default mode doesn't deliver). Related: #1471, #1472, #1473, #1474, #1530.
- [#1667](../1667-dx-generate-import-object.md) — **DX feature**: `compile()` should return a ready-to-pass import object for default/JS-host mode, so `WebAssembly.instantiate(r.binary, r.importObject)` works out of the box (no hand-wiring) — surfaces the runtime the CLI already emits as `<name>.imports.js` through the programmatic API. Complements #1661 (docs): #1661 documents the standalone zero-import path; #1667 adds the JS-host convenience. Host-imports-required stays the explicit default; standalone/`wasi` remains the recommended portable default — **medium**, medium, **ready**. From guest271314 GitHub #601. Related: #601, #1661, #1471.

## WASI Native Messaging — AssemblyScript-reference alignment (2026-05-24)

Compiler gaps blocking full convergence of `examples/native-messaging/host.ts`
(#1530) on the reference `nm_assemblyscript.ts`. #1654 is the root (unblocks
both others); #1653 is the keystone for the read side + continuous loop.

- [#1654](../1654-wasi-dataview-arraybuffer-invalid-module.md) — DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under `--target wasi` — high, medium, **root (ready)**
- [#1653](../1653-wasi-process-stdin-read-binary.md) — `process.stdin.read(buffer, offset?)` binary incremental stdin read (keystone) — high, hard, **depends on #1654**
- [#1655](../1655-wasi-process-stdout-write-arraybuffer.md) — `process.stdout.write(ArrayBuffer)` accept ArrayBuffer arg, not only Uint8Array literal — medium, easy, **depends on #1654**

## Governance / legal — CLA gate (2026-05-24)

- [#1660](../1660-real-cla-gate.md) — Replace the placeholder `cla-check` workflow with a real CLA signature/approval gate — **DONE**. Self-hosted in-repo gate: signatures recorded in `.github/cla/signatures.json` via an affirmative PR comment; internal authors (org members / maintainer / `*[bot]`) exempt, external humans sign by comment. CLA version tied to `CLA.md` hash for re-acceptance. Promotion to a *required* branch-protection check is deferred to an admin (documented follow-up in the issue) so the gate can't deadlock the internal merge queue before exemption is proven. Related: #1530.

## Spec-compliance easy wins (from #1563 gap analysis, 2026-05-21)

- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol argument must throw TypeError (§7.1.3 step 3) — ~12 fails, easy
- ~~[#1565](1565-toBoolean-bigint-i64-eqz.md)~~ — DONE (merged PR #541 in s55)
- ~~[#1566](1566-toNumber-symbol-throws-typeError.md)~~ — DONE (merged PR #541 in s55)

## Developer experience / docs

- [#1590](1590-first-5-min-ux-docs-and-hints.md) — First-5-minutes UX: Wasmtime run docs, coverage-honesty section, CLI run-hint, standalone I/O docs, pitch-language accuracy, "compare to…" section — docs+CLI only, 6 commits in order, easy

## Carry-over from earlier analysis

- [#779a](779a-class-dstr-method-tramp-residual.md) — class/dstr method-tramp residual (gen/async-gen/private/static) — **~727 fails**, ready
- [#779d](779d-object-literal-dstr-residual.md) — object-literal dstr non-method residuals — **~132 fails**, ready
- [#779e](779e-arguments-object-residual.md) — arguments-object mapped/trailing-comma/sloppy-strict residuals — **~134 fails**, ready
- [#846](846-assert-throws-not-thrown-built.md) — assert.throws not thrown: built-in methods accept invalid args silently — **~2,799 fails**, ready
- [#1319](../sprints/50/1319-cannot-convert-to-primitive-symbol-toprimitive.md) — Cannot convert object to primitive (Symbol.toPrimitive chain) — **~150 fails**, ready
- [#1529](1529-codegen-illegal-cast-at-closure-and-destructuring-boundaries.md) — illegal cast at closure/dstr boundaries — **~197 fails**, backlog
- [#1555](1555-destructure-param-array-streaming-iterator.md) — destructureParamArray streaming IteratorStep refactor — ready
- [#1568](1568-object-bigint-symbol-auto-box.md) — Object(BigInt) / Object(Symbol) auto-box wrappers — ready
- [#1564](1564-toNumeric-symbol-throws-typeError.md) — ToNumeric: Symbol → TypeError — ~12 fails, easy

- [#1600](1600-finalizationregistry-host-delegate-noop-stub.md) — FinalizationRegistry host-delegate (JS mode, like WeakRef) + no-op standalone stub; clears ~12 CEs. Faithful standalone finalization stays out of scope (→ #1101).

## Test262 triage — untracked failure causes (PO, 2026-05-29)

New issues from a fresh main-baseline (`.test262-cache/test262-current.jsonl`,
48,117 records) root-cause triage. Dedup'd against all open issues; clusters
already covered by open issues (dstr WasmGC type-mismatch → #1556/#1623;
Promise non-constructor → #1528/#1694; Set set-like → #1627/#1646/#1674; bind
fidelity → #1463) were NOT re-filed.

- [#1716](../1716-spec-gap-toprimitive-residual-object-property-key-coercion.md) — **RESIDUAL of done #1090/#1319/#1525**: `Cannot convert object to primitive value` still thrown in 111 paths (Object property-key + String/RegExp/JSON/Date `this`-value coercion) — **high**, medium, **ready**
- [#1717](../1717-arraybuffer-prototype-slice-not-implemented.md) — `ArrayBuffer.prototype.slice` not implemented (`slice is not a function`, 17 fails) — medium, medium, **ready**
- [#1718](../1718-iterator-sequencing-helpers-concat-zip-flatmap.md) — Iterator sequencing helpers (`Iterator.concat`/`zip`/`zipKeyed`) + `Iterator.prototype.flatMap` not implemented (101 fails; distinct from done #1340) — medium, hard, **ready**
- ~~[#1719](../1719-array-destructuring-ignores-overridden-array-prototype-iterator.md) — Array destructuring ignores overridden `Array.prototype[Symbol.iterator]` (`items[Symbol.iterator]` must be a function, 71 fails)~~ — **DONE** 2026-05-30 (CPR read-drive across decl/for-of/param/assignment, PRs #963/#968/#976). Follow-ups: #1749 (spread), #1750 (TS-cast form).

### ES3 / edition-0 conformance → Sprint 57 (Track 3)

- [#1720](../1720-es3-incdec-reference-evaluation-order-null-base.md) — ES3: prefix/postfix inc-dec reference evaluated once before null deref (`base[prop()]++`, sputnik S11.x, ~10 fails) — medium, medium, **ready (sprint 57)**
- [#1721](../1721-es3-subclass-function-object-instanceof.md) — ES3 (residual of #1455): `class extends Function`/`extends Object` instanceof returns false (4 fails) — medium, medium, **ready (sprint 57)**
- [#1722](../1722-es3-assignmenttargettype-early-syntaxerror.md) — ES3: AssignmentTargetType early SyntaxError not raised (yield/arrow as assignment target, 4 fails) — low, medium, **ready (sprint 57)**
- [#1511](../1511-spec-gap-arguments-object-mapped-and-trailing-comma.md) — **MOVED to sprint 57** (was sprint 52): arguments object mapped semantics / descriptors / trailing-comma length — covers the ES3 mapped-arguments cluster (~19 edition-0 fails) — high, medium, **review**
- ~~[#1756](../1756-optimize-bare-require-breaks-esm-bundlers.md) — optimize.ts bare `require()` breaks ESM bundlers (bun build/deno compile); binaryen TLA (GH #986)~~ — **DONE** 2026-05-31 (routed bare requires through the existing createRequire shim; --optimize verified 272<412 B)
