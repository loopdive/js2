> **Published copy (Session C, 2026-10-10).** Private proposal; commits `0ea339c8`/`4c1e8239` exist only in C's container. Apply `6931-proposal.patch.txt` on base `dbf5b4f7` (sha256 `af06d338…d893`, 15,562 bytes; `git apply --check` passes). `SHA256SUMS.txt` hashes the original layout: the patch is stored as `.patch.txt`, files over 500 KB are in `raw-large.tar.gz` (sha256 `e85ebcf5…1149`, list in `raw-large.MANIFEST.txt`). Verified by C on publish: patch hash, `sha256sum -c` on the original directory, new test 6/6, `npm run typecheck` exit 0.
>
> **Caveat found by C on publish:** the refusal is a `TypeError` only *inside* the module. A JS caller of the export sees an opaque `WebAssembly.Exception` (the `probe-boundary` rerun prints `THROW Exception: undefined`), not a JS `TypeError` with the message. This is how standalone exceptions cross the boundary generally; flagged so A can decide whether that is acceptable.

# #6931 — private root-cause and fix proposal (for Session A)

Base: canonical main `dbf5b4f74b37d67e525b2af36fd1fe49803b1348`. Worktree
`/home/user/js2/.claude/worktrees/agent-a4022d934675184ae`, local branch
`proposal-6931-standalone-host-eq` (HEAD `4c1e8239`). Not pushed, no PR, no claim.
Patch: `6931-proposal.patch` (`git diff dbf5b4f7..HEAD`). All raw receipts are in `raw/`;
the scripts that produced them are copied there as `raw/script-*.txt`.

## 1. Root cause (verified)

A "host value" here means any non-null externref that is not a Wasm GC value. In a pure
standalone module, that covers a JS string, an object, `undefined`, `true`, and a heap
number such as `1.5`. Only i31-range integers (`1`, `5`) and `null` internalize to
something the module can read. The issue table missed `1.5`, which traps too
(`raw/base-probe-6931.tsv`).

### IR path (`eqUsed`, `eqStr`, `neUsed`: `emitted+body`)

V8 stack (`raw/base-trap-ir.txt`):
`__str_to_number (wasm-function[51]:0xacbf) ← __extern_loose_eq ← eqUsed`.

1. `src/ir/integration.ts` `emitLooseEq` (~L9644) calls `__extern_loose_eq`, which is
   built by `src/codegen/any-helpers.ts::ensureExternLooseEqHelper` (~L935). That helper
   calls `__any_from_extern` on both operands, then `__any_eq`.
2. `any-helpers.ts::ensureAnyFromExternHelper` handles only native carriers. Every other
   value, including JS `undefined`, `true` and `1.5`, falls to the legacy
   `fallbackStringAny` arm (~L585/L620), which builds tag 5 with the raw externref in
   field 4. This is the default regime: `honestAnyBoxing` is off.
3. `src/codegen/any-eq-helpers.ts::registerAnyLooseEqHelper`, cross-tag arm
   (tag 5 vs tags 2..4), runs `tag5ToNumber` (`any-helpers.ts` ~L1654). The
   `ref.test $BoxedNumber`/i31 check fails, so the else arm runs `call __str_to_number`.
4. **Trapping instruction:** `ref.cast (ref $AnyString)` in the `__str_to_number`
   prelude, emitted by
   `src/runtime/wasmgc/values/string-number-bodies.ts::buildStringToNumberPrelude`, L67
   (`local.get 0; any.convert_extern; ref.cast anyStr; call __str_flatten`).
5. `o == "1"` has the same tag (5 vs 5), so it goes to the same-tag arm
   `tag5ValueEqThen` → `tag5StringEqThen` (`any-helpers.ts` ~L1271). That arm is guarded
   by `ref.test $AnyString`, which fails for a host string, so the answer is a **silent
   `0`**. This is wrong for `"1"`, `{valueOf:()=>1}` and `true`.

### Legacy path (`eqUsed` is `unsupported` in the `probe-native` shape)

There is no trap. The legacy lowering is the native-first externref cascade in
`src/codegen/binary-ops-typed-dispatch.ts::compileTypedBinaryDispatch` (~L696–1170) when
`semanticProviders === "native-first"`. For a host value:

- every `__typeof_number`, `__typeof_boolean`, `__typeof_bigint` and `__typeof_object`
  call returns 0;
- the `ref.test $AnyString` string arms fail;
- the `ref.test eq` identity arm fails.

It therefore falls to `ref.is_null(l) && ref.is_null(r)`, which gives a **silent `0`**.

In `raw/base-trap-legacy.txt` the selector happened to IR-claim `eqUsed` (the export
shape differs), and it traps through the IR route. The `LEGACY_SRC` shape (copied from
`probe-native`) is what keeps it legacy.

## 2. Semantics chosen and why

**Decision: a deliberate, catchable in-module `TypeError` when loose `==`/`!=` meets a
host value on `--target standalone`.** The message is
`"Cannot compare a host JavaScript value with == in a standalone module"`.

The check sits where the value is used, not where it enters `any`. Admission and opaque
pass-through are unchanged: `ident("x")` still round-trips. Native values, including
everything the module creates itself, are unaffected.

Why not (a), a separate foreign tag that is false except for identity:

- **Undecidable.** Without imports, Wasm sees a host value only as an opaque anyref that
  is not `eq`. It cannot tell `"1"`, `{}`, `undefined`, `true` or `1.5` apart, yet Node
  answers `"1" == 1` → true, `{} == 1` → false, `undefined == null` → true and
  `1.5 == 1.5` → true. Any fixed answer is wrong for some input.
- **Identity cannot be decided either.** Host references are not `eq`, so `ref.eq`
  cannot run on them.
- **No sanctioned host-string read in pure standalone.** `__str_from_extern`,
  `__str_to_extern` and `__str_is_native` belong to the JS-host bridge. They are gated
  on `jsValueBoundary(ctx) && !ctx.strictNoHostImports`
  (`native-strings.ts::ensureNativeStringBoundaryBridge`) and marshal through
  `__str_to_mem`/`__str_from_mem` host imports (`string-ops.ts` ~L825: "#1618/#1759: the
  extern bridge … is JS-host-only"). So a host string cannot be compared; refusing is
  the only honest answer.

Why at the use site and not by rejecting at the boundary:

- Rejecting at entry would break today's opaque pass-through (`ident`), and would mean
  deciding whether host values may enter standalone `any` at all. That is your design
  call (open question 1).
- The use-site refusal fits either answer. If you later reject at admission, the guard
  becomes unreachable but stays correct.

Precedents:

- Standalone already throws deliberate, catchable errors for things it cannot do
  natively: `char-at-transfer.ts:144` (TypeError) and `expressions/standalone-crypto.ts:29`
  (ReferenceError). Both go through the shared `buildThrowJsErrorInstrs`, which in
  standalone uses the in-module `__new_TypeError` and adds no host import.
- The standalone boundary ABI expects the embedder to pass native carriers. That is why
  `__box_number`, `__box_boolean`, `__any_box_undefined` and `__dynamic_boundary_tag`
  are exported.
- The honest `__any_from_extern` arm already notes that host-opaque values are
  "unreachable in standalone/wasi; kept total".

What "host value" means in the guard: `!ref.is_null(x) && !ref.test eq (any.convert_extern x)`.
Every standalone carrier is `eq`: `$AnyValue`, `$AnyString`, the number and boolean
boxes, i31, structs, arrays and closures. So the test matches exactly the values the
module did not create.

Behaviour change worth knowing: the refusal also replaces answers that were right by
accident before (`{} == 1` → `0`, `"x" == "1"` → `0`). Standalone scope rows go from
13+14 matches (IR+legacy) to 9+6 matches, with every other row a deliberate throw
(`raw/*-probe-6931.tsv`). Under the "no silent wrong answers" rule this is intended: the
module cannot tell an accidentally right `0` from a wrong one.

## 3. Hunks (file::function → likely owner)

| File::function | Change | Owner |
| --- | --- | --- |
| `src/codegen/any-eq-helpers.ts`::`STANDALONE_HOST_EQ_MESSAGE` (module-private const) | refusal text | A (shared lowering) |
| `src/codegen/any-eq-helpers.ts`::`ensureStandaloneHostEqGuard` (new, exported) | emits `__standalone_host_eq_guard(externref)->externref`: null or `eq` → return the argument, otherwise throw the in-module TypeError. Returns `undefined` unless `ctx.standalone`. Builds the throw before minting its own handle | A (shared lowering) |
| `src/codegen/any-eq-helpers.ts`::`anyOperandHostGuard` (new) | null-safe `struct.get $AnyValue 4` → guard → `drop` | A |
| `src/codegen/any-eq-helpers.ts`::`registerAnyEqHelpers` | resolves the guard and passes the prologue down | A |
| `src/codegen/any-eq-helpers.ts`::`registerAnyLooseEqHelper` | new `hostGuard` param, prepended to the `__any_eq` body. Empty on non-standalone targets, so the body is byte-identical there. Covers the IR path (`__extern_loose_eq` → `__any_eq`) and any other `__any_eq` caller | A |
| `src/codegen/coercion-engine.ts`::`guardHostEqOperand` (new) + import | returns "operand already externref". For loose equality on standalone, emits `call __standalone_host_eq_guard` on the operand on the stack | codegen (coercion engine / A) |
| `src/codegen/binary-ops-typed-dispatch.ts`::`compileTypedBinaryDispatch` → `boxOperandToExternref` (first line) + import line | `if (operandType.kind === "externref") return;` becomes `if (guardHostEqOperand(ctx, fctx, operandType, isLoose)) return;`. Covers the legacy cascade. Strict `===` is untouched. Net 0 lines in this god-file and god-function | codegen (legacy lowering) |
| `tests/issue-6931-standalone-host-loose-eq.test.ts` (new) | public `compile()` on gc and standalone, Node as oracle; see §5 | test |

## 4. Measured before → after (all runs in this session)

| Measurement | Base `dbf5b4f7` | After `4c1e8239` | Raw |
| --- | --- | --- | --- |
| Issue probe, standalone scope rows (IR) | 13 match / **14 TRAP** / **3 WRONG** | 9 match / 21 deliberate-throw / 0 TRAP / 0 WRONG | `base-probe-6931.tsv`, `after-probe-6931.tsv` |
| Issue probe, standalone scope rows (legacy) | 14 match / **6 WRONG** | 6 match / 14 deliberate-throw / 0 WRONG | same |
| Issue probe, gc rows | all match | identical rows (diffed) | same |
| Original probes `probe-boundary` / `probe-native` | traps and `exported("1") = 0` | deliberate throws | `base-probe-*.txt`, `after-probe-*.txt` |
| `tests/issue-6931-*.test.ts` | 3 failed / 3 passed (fails for the right reasons: `RuntimeError: illegal cast`, no throw, `tryEq(1.5)` → 0) | 6/6 passed | `base-issue-6931-test.txt`, `after-issue-6931-test.txt` |
| gc sha256, 13 playground examples + 5 probes | — | **18/18 byte-identical** | `sha256-base-vs-after.tsv` |
| standalone sha256, same corpus | — | 4 identical (`dom/calendar`, `js/builtins`, `js/classes`, `probe:no-eq`); 14 changed: +258/+259 B (playground, `probe:strict-only`), +298 to +325 B (probes with an externref loose `==`) | `sha256-base-vs-after.tsv` |
| `npm run -s typecheck` | 0 | 0 | `*-gate-typecheck.txt` |
| `check-loc-budget` | 0 | 0 (net +112 LOC, base merge-base = dbf5b4f7; also 0 with `LOC_GATE_BASE=dbf5b4f7`) | `*-gate-loc-budget*.txt` |
| `check-func-budget` | 0 | 0 (also with explicit base) | `*-gate-func-budget*.txt` |
| `check-coercion-sites` | 0 | 0 | |
| `check:oracle-ratchet` | 0 | 0 | |
| `check:dead-exports` | 0 | 0 (same "graph OPEN; strict modeled closure FAIL" informational lines at base and after) | |
| `check:ir-fallbacks` | 0 | 0 | |
| `check-compiler-boundaries --mode inventory --base dbf5b4f7` | 0, `inventoryValid: true` | 0, `inventoryValid: true` | `*-gate-compiler-boundaries.txt` |
| Related tests (224 files: grep `__any_eq\|loose\|any-eq\|#2081`, `#2175`, `issue-6921*`, standalone files named eq/equal/boundary/loose/any/extern/foreign/host) | 2866 tests: 2707 pass / **81 fail** / 77 skip | **identical per-test status table** (2707 / 81 / 77; same 81 names) | `{base,after}-related-tests.tsv`, `{base,after}-related-failures.txt`, `related-failures-diff.txt` (empty) |
| `node scripts/equivalence-gate.mjs` | 22 failing / 1748 passing, EXIT 0 | 22 / 1748, EXIT 0; failure lines identical | `{base,after}-equivalence-gate.txt` |

Notes on the measurements:

- The heavy runs (related tests and equivalence gate) ran on `0ea339c8`. The only later
  commit, `4c1e8239`, removes an unused `export` keyword. All 36 corpus binaries are
  byte-identical between `0ea339c8` and `4c1e8239` (`after-0ea339c8-sha256.tsv` vs
  `after-sha256.tsv`). Typecheck, the gates and the issue test were re-run on `4c1e8239`.
- The 81 related-test failures already fail on base, and the status of every test is
  unchanged after the patch. They were not investigated. They include timeout- and
  environment-sensitive suites run under load with `--maxWorkers=2`, so treat them as
  this box's base, not as main's.
- The first base run of the equivalence gate and related tests overlapped my source
  edits. I discarded it and re-ran base with the source restored to `dbf5b4f7`
  (`raw/base-heavy-head.txt` records a clean tree).

## 5. Test (`tests/issue-6931-standalone-host-loose-eq.test.ts`)

- IR functions stay `emitted+body` on both targets, so the test cannot silently move to
  the legacy path.
- On gc, IR and legacy sources match Node for all 10 inputs.
- On standalone, IR path: `1`, `5` and `null` match Node. Each of the 7 host inputs
  throws a `WebAssembly.Exception` (not a `RuntimeError`) whose payload, rendered in the
  module through `__exn_render_prepare`/`__exn_render_char`, is exactly
  `TypeError: Cannot compare a host JavaScript value with == in a standalone module`.
  `r.imports` is empty.
- On standalone, legacy path: `eqUsed` and `exported` are asserted `unsupported`. Values
  the program creates itself (`viaStr`, `viaBool`, `viaObj`, `viaUndef`) still match
  Node, and host inputs get the same deliberate error.
- On standalone, the refusal is catchable inside the module:
  `try { o == 1 } catch (e) { e instanceof TypeError }` returns 2 for every host input.

## 6. Gates or pins deliberately left failing

None. No baseline, hash-pin or `compiler-boundaries.json` file was touched.

The patch needs no `loc-budget-allow` grant: `binary-ops-typed-dispatch.ts`, which is over
1,500 lines, nets 0 lines. The issue file `plan/issues/6931-*.md` is not on `dbf5b4f7`,
so the patch does not add or touch it.

## 7. Open questions for A

1. **Admission.** Should host values be rejected when they enter standalone `any`
   (export parameters / `__any_from_extern`) instead of at the point of use? Rejecting at
   entry would also cover the cases below, but it breaks today's opaque round-trip
   (`ident("x") → "x"`). This patch takes no position.
2. **Same blind spot, not fixed here (observed only):**
   - `o == null` with a raw JS `undefined` answers `0`; Node answers `1`
     (`isNull`, legacy, `after-probe-6931.tsv`).
   - Strict `o === 1.5` with a JS heap number would answer false.

   Should strict equality and the nullish fast path refuse as well?
3. **WASI** is not guarded: the gate is `ctx.standalone`. A JS embedder that calls WASI
   exports with raw values has the same defect. Should the gate become
   `environment !== "javascript"`?
4. **`hostBridge: "always"` standalone and linked standalone peers (#6420).** The guard
   fires there too. Confirm that no legitimate JS-owned value reaches `__any_eq` or the
   cascade in those lanes (none did in the 224 related files).
5. **Size.** Every standalone binary that contains `__any_eq` grows by about 258 B
   (guard function + message + 2×null-safe prologue), whether or not it ever compares a
   host value. If `__any_eq` were emitted on demand, or the guard placed only in
   `__extern_loose_eq` plus the cascade, binaries that never do externref loose `==`
   would be unchanged. The cost is that `__any_eq` reached by other routes stays
   unguarded.
6. **Wording and error class.** I chose TypeError for consistency with
   `char-at-transfer`. Should the message name the boxing exports?
7. **Hook side note.** lint-staged's pre-commit backup uses `git stash` internally,
   which is the shared stack across worktrees. The stack was empty before and after both
   commits.
