# Structure review delta — June 2026 bug corpus vs the upstream architecture review

> Delta analysis, 2026-06-11. Baseline: `docs/architecture/compiler-quality-review-2026-06.md`
> (commit da9e9813f, issues #1916–#1950) — findings there are NOT repeated; every
> finding below is tagged **COVERED by #X** / **EXTENDS #X** / **NEW**.
> Evidence corpus: the 121 June bug issues #1951–#2035 + #2049–#2084
> (118 of them cite at least one `src/` file; citation extraction below).

---

## 1. Hotspot map: size × June-bug density

`src/codegen/` is now **136,361 LOC** total (92,292 in flat files + 30,264 in
`expressions/` + 9,836 in `statements/` + context/registry/regex/helpers).
Cross-referencing `wc -l` against the count of June issues citing each file:

| File | LOC | June issues citing | Issues / KLOC |
|---|---|---|---|
| `src/runtime.ts` | 11,065 | **14** | 1.3 |
| `src/codegen/array-methods.ts` | 7,147 | **12** | 1.7 |
| `src/codegen/binary-ops.ts` | 2,796 | **11** | **3.9** |
| `src/codegen/expressions/calls.ts` | 11,440 | 10 | 0.9 |
| `src/codegen/literals.ts` | 3,008 | 8 | 2.7 |
| `src/codegen/string-ops.ts` | 2,528 | 7 | 2.8 |
| `src/codegen/statements/control-flow.ts` | 982 | 7 | **7.1** |
| `src/codegen/index.ts` | 11,783 | 7 | 0.6 |
| `src/codegen/property-access.ts` | 4,090 | 6 | 1.5 |
| `src/codegen/type-coercion.ts` | 2,906 | 5 | 1.7 |
| `src/codegen/class-bodies.ts` | 2,163 | 5 | 2.3 |
| `src/codegen/native-strings.ts` | 6,231 | 3 | 0.5 |

**The thesis is only half-confirmed, and the half that fails is the
interesting part.** Raw bug counts do track file size (runtime.ts,
array-methods.ts, calls.ts are top-5 by both). But **per-KLOC density peaks in
mid-size *semantics-bearing* files, not the giants**: `binary-ops.ts` (3.9/KLOC)
and `control-flow.ts` (7.1/KLOC) out-density `index.ts` (0.6) by 6–12×.
The binary-ops citations are almost entirely the any-coercion/equality family
(#1961 #1971 #1986 #1991 #2022 #2055 #2056 #2058 #2059 #2073 #2081) — i.e.
**bugs concentrate where one JS concept (coercion, equality, ToPrimitive) is
implemented in N divergent places**, exactly the upstream review's
cross-cutting finding §2, now with corpus-level quantification. Conversely
`native-strings.ts` (6.2 KLOC, 3 issues, 0.5/KLOC) shows a big file with a
*single* owner-concept and spec-cited helpers is not a bug hotspot — size
alone is not the predictor; concept duplication is.
**Verdict: EXTENDS upstream §2 with quantitative confirmation; refines #1098/#1172
(god-file audits) — splitting `index.ts`/`calls.ts` by size is lower value than
consolidating the coercion/equality concept now spread across binary-ops /
type-coercion / runtime / any-helpers.**

## 2. Duplicated-lowering inventory

Each row: concept, locations, drift bugs the duplication bred, consolidation cost.

### 2a. Coercion / ToString / concat (index only — detail belongs to the coercion analyst)
- 4 coercion matrices: `type-coercion.ts:980`, `:2695`, `stack-balance.ts:678`,
  `:1179` — **COVERED by #1917**.
- Concat operand coercion is a *fifth* semi-matrix: `compileNativeConcatOperand`
  (`string-ops.ts:84`), `compileAndCoerceConcatOperand` (`string-ops.ts:1092`),
  `compileBatchedConcat` (`string-ops.ts:1148`), plus the host bridge
  (#1969) and `$__any_to_string` standalone family. June bugs bred:
  #1999, #2005, #2006, #2007, #2058, #2072. **EXTENDS #1917** — the issue text
  enumerates 4 matrices; the concat operand path and the standalone
  any-to-string dispatcher are not in its inventory.
- **Critical gap in #1917's spec (NEW evidence)**: the #2072 dev investigation
  (`plan/issues/2072-standalone-any-to-string-object-object.md:54-83`) proved
  `coerceType(→AnyValue)` boxes **by Wasm ValType kind, not JS type** — `true`
  boxes as number (tag 2), `undefined`/`null` box as string (tag 5), native
  strings box as object (tag 6). The fix requires threading a **static-type
  hint into the coercion API**. #1917 (`plan/issues/1917-single-coercion-engine.md`)
  contains **zero mention** of TS-type hints — a consolidated engine built to
  its current spec would still box blind. #1917 must be specced as
  *(fromWasmType, toWasmType, staticJsType?) → instrs*, which is exactly the
  TypeOracle (#1930) seam. Affected queued bugs: #1986 #1987 #1988 #2058 #2059
  #2072 #2080 #2081 (+ #2014/#2015 any-object reads).

### 2b. `String.fromCharCode` — four code paths, three registration sites
- Host-import registration ×3: `declarations.ts:545-552` + `:1164-1171`
  (collect + add), `index.ts:1035-1043` (pre-registration to avoid shadowing),
  `index.ts:7258-7296` (a second scanner).
- Call lowering with two arms: `expressions/calls.ts:3531-3564`
  (native `__str_fromCharCode` vs host `String_fromCharCode`).
- Native helper: `native-strings.ts:4290-4311`.
- A fourth consumer, the O(n²) chunked extern converter, at
  `native-strings.ts:6127-6192`.
- Drift bug bred: **#1955** — args after the first silently dropped, on the
  host path AND the native fromCodePoint path *independently* (the
  single-arg assumption was copied into each). Cost: S–M — one
  `ensureFromCharCode(ctx)` accessor + one variadic lowering; the three
  scanners collapse into the registry (`src/codegen/registry/imports.ts`
  already exists, 288 LOC, underused). **NEW** (no upstream issue; adjacent
  to #1934's "domain tables" spirit but on the codegen side).

### 2c. Host vs native vs standalone triplication without shared scaffolding
- `Array.prototype.join`: `compileArrayJoin` (`array-methods.ts:4490`, GC-vec)
  vs `compileArrayJoinExtern` (`array-methods.ts:4447`) vs the standalone
  any-path. Bugs bred, one per variant: #1968 (empty join → null), #1998
  (externref elements illegal cast), #2074 (standalone null deref), #2075
  (standalone make-callback leak) — **4 issues, same method**.
- `sort`: default comparator duplicated across `array-methods.ts` and
  `timsort.ts` (#1993 cites both; #1967 gates).
- `isArray` predicate already has a fork-local consolidation issue: **#2047**
  (`unify-standalone-isarray-predicate`, ready/backlog).
- Pattern cost: each builtin re-derives element-load + ToString + null
  handling per representation. Consolidation: a per-builtin "element accessor
  + coercion" scaffold parameterized by representation — M per builtin family,
  but it is the *same* M repeatedly; doing it once for join/concat/toString
  covers ~8 queued issues. **EXTENDS #1917/#1934** — neither names the
  per-representation builtin scaffolding; the dual-backend principle
  (CLAUDE.md "dual-mode") guarantees this axis exists forever, so the
  scaffold is structural, not incidental.

### 2d. Class constructor synthesis — the canonical drift pair
- Externref-backed implicit derived ctor: `class-bodies.ts:1263-1289` —
  forwarding **fixed by #1833** (PR 1255, in-review).
- WasmGC-struct implicit derived ctor: `class-bodies.ts:1292-1356` —
  synthesized with **zero params**, `new Dog("rex")` → `name=null`
  (**#2082**, agent-verified still broken on main *after* #1833).
- Standalone third variant: #2078 (derived ctor base field zero); related
  family: #2020 (inherited statics), #2021 (subclass-of-array ordering).
- This is the cleanest corpus proof of the drift thesis: the same semantic
  rule ("implicit derived ctor forwards all args to super") was fixed in one
  twin while the other shipped broken for another release. Cost: S–M — extract
  one `synthesizeImplicitDerivedCtor(repr)` used by both paths (#2082's own
  fix-direction section says "port the #1833 fix onto the struct path";
  the *structural* fix is to make a second drift impossible). **NEW** as a
  structural finding (the upstream review never looked at class-bodies.ts).

### 2e. Capture/writeback machinery — closures vs accessors vs compound assign
- Canonical machinery: `ctx.boxedCaptures` ref-cells, owned by `closures.ts`
  (22 references) but threaded through **13 files**
  (object-ops, property-access, statements/variables, statements/loops,
  expressions/{assignment,identifiers,unary-updates,calls,calls-closures,new-super},
  statements/nested-declarations, node-process-api).
- Object-literal accessors (`literals.ts:299-528`) built a *parallel* closure
  path that **captures copies** → #2011 (writes through accessors never reach
  outer scope; getter pairs don't share state; feasibility: hard, sprint 61).
- Compound assignment on captured strings diverged again in
  `expressions/assignment.ts` → #1999 (illegal cast on `str +=` under capture).
- Cost: M — accessors must construct closures through the same
  capture-analysis + ref-cell path as arrow functions; #1999 falls out of
  routing compound-assign writeback through one helper. **NEW**
  (no upstream issue covers capture-machinery unification; #1946/#1947 touch
  closure *dispatch*, not capture *storage*).

## 3. Name-keyed registries — string keys where identities are needed

Inventory (the registry-of-record is `funcMap: Map<string, number>`,
`context/types.ts:434`; ~40 distinct key expressions feed it, 14 of them
computed `name` variables):

| Key pattern | Where minted | Collision/drift bug |
|---|---|---|
| `${Class}_${method}` | `class-bodies.ts` | **#1983** — user `function A_m()` vs `class A { m() }` breaks both paths (sprint 61) |
| `${structName}_valueOf` | `type-coercion.ts:1790` | **#1989** — ToPrimitive dispatch keyed by *struct shape name*: last same-shape literal's valueOf wins for ALL coercions |
| `WrapperNumber/String/Boolean_valueOf` | `any-helpers.ts:88-155` | reserved-name squatting in the same namespace |
| `__sget_<field>` / `__sset_<field>` per-field host-boundary exports | `object-ops.ts:994`, `:3048`, `literals.ts:2716` | **#2009** — structurally identical structs share field names at the host boundary; spread/Object.assign mislabel keys |
| getter/setter/trampoline/ctor/closure `*Name` keys | spread across codegen | latent — same namespace, no collision check |

**Upstream coverage check**: #1916 (symbolic function references, sprint 61,
hard) replaces baked *indices* with handles resolved at encode time — but its
proven prototype, `IrFuncRef { name }` (`src/ir/nodes.ts:22-31`), is **still a
string name**. #1916 as written fixes the *shift* fragility (upstream §5) and
the fork has already executed its first slice (#2043 done; #1984 freeze-point
and #1985 stale-proof index cells are the fork-local follow-ons, both ready).
It does **not** fix the *collision* class: a name-keyed symbolic ref collides
exactly like a name-keyed funcMap entry. **EXTENDS #1916 — the handle minted
during the migration must be a collision-free FuncId (declaration-site /
ts.Symbol-derived, name kept only as debug metadata), or #1983/#1989/#2009
survive the rewrite.** #1989/#2009 additionally need identity keyed by
*object/declaration*, not struct shape — that part is NEW (no upstream issue;
it is the "same family" the #2072 investigation names:
`#2009/#1989 struct-shape work`).

## 4. `as unknown as Instr`

Current count: **173** across src (CLAUDE.md's "158" is stale; the upstream
review already measured 173 on 2026-06-10 — **zero growth since, zero
burn-down either**). Distribution: `map-runtime.ts` 76, `json-runtime.ts` 24,
`expressions/builtins.ts` 23, `index.ts` 17, `expressions/calls.ts` 14,
`dataview-native.ts` 8, `async-scheduler.ts` 4, `iterator-native.ts` 3,
4 singletons. 76+24 = 58% sit in two runtime-ish files — the casts cluster
where GC array/struct ops outpaced the union. Cost of proper completion:
**S, type-only** — every casted op string is *already encoded* by
`encodeInstr` (it executes today), so completing the union is adding the
missing op literals + payload shapes to the `Instr` type and deleting casts;
no binary change. The risk it guards against is real and upstream-confirmed:
`encodeInstr` has no default arm (#1939), so a typo'd op string inside a cast
is **silently omitted from the binary**. Do the union completion *as part of*
#1939 (the default-throw makes the union the enforced contract).
**COVERED by #1095/#1526 (tracked, deliberately not re-filed upstream) +
#1939; delta: no progress, and the two-file concentration makes it cheaper
than the issue text assumes.**

## 5. CodegenContext god-object — measurement and whether the upstream plan suffices

Measured today: the interface spans `context/types.ts:430-1120` with
**~190 field declarations** (upstream review said "~150-field" — it has grown
and/or was undercounted; either way it is growing through the `context/`
extraction, which is only 1,638 LOC so far). Direct mutation sites:
**445 `ctx.<field> = …` assignments** across `src/codegen` (203 of them
`ctx.body =` — the body-swap pattern CLAUDE.md warns about), led by
`ctx.currentFunc =` ×41, `ctx.boxedCaptures =` ×20, `ctx.tdzFlagLocals =` ×15.

**Is #1930/#1931/#1934 sufficient? No — they don't touch this object at
all.** #1930 fences the *TS checker* (399 `getTypeAtLocation` sites measured
today, matching upstream's ~397), #1931 is `detectEarlyErrors`, #1934 is
`runtime.ts resolveImport`. None decompose CodegenContext; upstream
deliberately deferred god-files to #1098/#1172.

**Does the boxing/representation work (#1852, #2072/#2080 family) demand
context changes first? A narrow yes.** The #2072 root cause requires the
coercion engine to consult static JS types at every `coerceType(→AnyValue)`
call site — today that information is only reachable via `ctx.checker`
(a raw `ts.TypeChecker` field, `context/types.ts:433`). The wrong sequencing
is 9 boxing bugfixes each threading ad-hoc `ts.Type` params (adding to the
399-site leak #1930 exists to kill). The right sequencing is **small**: add
the TypeOracle as *one context field* with the 3–4 queries boxing needs
(`jsTypeTagOf(expr)`, nullability, primitive-kind) — a thin #1930 down-payment,
not a 190-field decomposition. Full CodegenContext decomposition can stay
deferred (#1172); it is not on the critical path for any June family.
**EXTENDS #1930 (defines its minimal first slice) / EXTENDS #1852.**

## 6. Sequencing — what unblocks the most queued work

Partial order (edges = "should land before"):

```
#1921 gate (S, still open: compiler.ts:731,:1033 unchanged)
   │  (cheap, do first — makes every later consolidation fail loud)
   ▼
#1917+type-hint (EXTENDED per §2a) ◄─ requires thin-TypeOracle slice of #1930 (§5)
   │  unblocks ~13 queued bugs: #1986 #1987 #1988 #2005 #2006 #2007 #2022
   │  #2058 #2059 #2072 #2080 #2081 (+#2014/#2015) — the largest single family
   ▼
#1916 symbolic refs ──┬─ mint collision-free FuncIds, not name strings (§3)
 (sprint 61; #1984/   │  unblocks #1983 #1989 #2009 (+#2011's dispatch half)
  #1985 are slices)   ▼
                identity-keyed registries (NEW)
single-ctor-synthesis (NEW, §2d — S/M) → unblocks #2082 #2078 #2020 #2021 now;
   independent of everything above, can run in parallel (sprint 61 already has #2082)
capture-machinery unification (NEW, §2e — M) → #2011 #1999; independent
fromCharCode/join/builtin scaffold (§2b/2c — S each) → #1955 #1968 #1998 #2074 #2075
```

**Can wait** (no June family blocked on them): #1927 pipeline driver,
#1931, #1934 (runtime.ts's 14 June citations are mostly *semantic gaps* —
#1991 prototype chain, #2013 reviver, #2028 executor — not structure drift;
#1935 covers the protocol part), #1926/#1925 IR representation (until the
class-method/async adoption waves), #1946/#1947/#1948 perf items, full
CodegenContext decomposition.

**Bottom line**: the June corpus does not contradict the upstream review — it
*prices* it. Three upstream issues (#1917, #1916, #1930) sit on the critical
path of ~20 of the 121 queued bugs, but two of them need spec amendments
(#1917: static-type hint; #1916: collision-free handles) before dev dispatch,
and three NEW consolidation issues should be filed (single ctor synthesis;
capture-machinery unification; per-builtin representation scaffold starting
with fromCharCode/join).

---

### Appendix: method
- Bug-density: for each June issue file (#1951–#2035, #2049–#2084), extracted
  `src/**.ts` citations (`grep -oE "src/[a-z0-9/_-]+\.ts"`, deduped per
  issue); counted distinct issues per file. 121 issues in range, 118 with
  citations.
- LOC: `wc -l` on 2026-06-11 main (`src/codegen` flat + subdirs; totals above).
- Casts: `grep -r "as unknown as Instr" src --include='*.ts'` = 173.
- Context fields: declarations matching `^  name?: ` within
  `context/types.ts:430-1120` = ~190; mutations `ctx\.[a-zA-Z]* =` in
  `src/codegen` = 445.
