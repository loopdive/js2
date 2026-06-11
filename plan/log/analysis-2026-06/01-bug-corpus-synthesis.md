# Bug-corpus synthesis — June 2026 (root-cause families)

> Input: all 170 issue files in `plan/issues/` with `created: 2026-06-10/11` —
> the upstream architecture-review issues (#1916–#1950), the fork deep-audit
> (#1951–#1985), the June-10/11 behavioral audit (#1986–#2035), the standalone
> gap buckets + follow-ups (#2036–#2048), and the operator/standalone singles
> (#2049–#2084). Cross-read against
> `docs/architecture/compiler-quality-review-2026-06.md` (the upstream review).
> Every claim cites issue IDs; mechanism citations are taken from the issues'
> own Root cause / Implementation Plan sections.
>
> Status at time of writing: done = #1995, #1996, #1999, #2034, #2043;
> in-progress = #2039; spec'd (`## Implementation Plan` present) = #1989,
> #2009, #2043, #2044. #2072/#2080 re-rated hard and routed to
> senior-developer (commit 1bb8be691: "type-unaware AnyValue boxing root
> cause").

---

## 1. Family taxonomy

Thirteen root-cause families plus a meta/prevention bucket. Counts are primary
memberships; "×" marks notable cross-memberships (an issue is listed once as
primary, in the appendix).

### F1 — SILENT: fail-soft emission (silent fallbacks, dropped args, graceful defaults) — ~24 issues

**Members:** #1918, #1921, #1937, #1939, #1940, #1955, #1958, #1966, #1967,
#1968, #1992, #2002, #2010, #2013, #2019, #2032, #2046, #2049, #2050, #2053,
#2054, #2067, #2069, #2076. (× #1923 invisible IR demotions, × #1974 linear `%`.)

**Severity profile:** almost entirely *silent wrong values* — the worst class.
`a.unshift(x)` is a no-op returning 0 (#1966, the string `"unshift"` appears
nowhere in `src/`); `fn.call(thisArg,…)` evaluates and drops `thisArg`
(#2069); `Math.max(...arr)` → NaN via generic SpreadElement unwrap (#2054);
`startsWith(s, pos)` drops `pos` by import-arity truncation (#2002);
JSON.parse's reviver is never compiled (#2013); `o?.m()` is never routed to
optional-call codegen (#2049); for-of silently breaks at 1,000,000 iterations
(#2067).

**Structural defect:** the compiler prefers emitting *something* over
refusing — dispatchers without default arms (`codegen-linear/index.ts:519-732`
#1937; `emit/binary.ts:728-1678` #1939), a string-prefix compile-failure gate
(`compiler.ts:731` only fails on `"Codegen error:"`, #1921), stack-balance
lossy fixups that patch type holes with `drop; f64.const 0 / ref.null`
(`stack-balance.ts:709-755`, #1918), generic method-call fallthrough that
drops receiver+args and unboxes null (#1966, #1967), and fixed-arity import
signatures that truncate extra arguments with no diagnostic (#2002, #1955,
#1958, #2013).

**Single change that prevents the class:** make fail-loud the invariant —
default-arm `throw` in every dispatcher/encoder, replace the string-prefix
gate with structured severities (#1921), and ratchet remaining silent paths
to zero the way IR fallbacks are ratcheted (#1918's fixup ratchet). Plus one
**arity audit**: any builtin bridge must either compile all argument
expressions or refuse.

### F2 — REPR: type-erasing value representation (boxing tags by ValType, no boolean/undefined brand) — ~16 issues

**Members:** #1926, #1957, #1961, #1975 (linear flavor), #1987, #1995 (done),
#2004, #2005, #2006, #2016, #2030, #2044, #2051, #2055, #2072, #2080.
(× #1935 undefined-sentinel, × #2034 done.)

**Severity profile:** silent wrong values, plus traps where the wrong tag is
later cast (#2006 `${null}` illegal cast; #2072 notes `typeof` traps on a
boolean boxed as number).

**Structural defect:** lowering picks representation and box tags from the
**Wasm ValType, not the JS type**. The smoking gun is #2072:
`coerceType(from → AnyValue)` (`src/codegen/type-coercion.ts:1178+`) boxes
`true` (an i32) via `__any_box_i32` with tag 2 = *number* — so `String(true)`
is "1" and `typeof` traps. Downstream symptoms: booleans stringify "1"/"0"
(#2005, #2016, #2030 — "i32 result lacks boolean brand"); `undefined`
collapses to NaN/0 in numeric slots (#1957, #2004, #2030, #2051 — the
short-circuited `?.` pushes the lowered type's *default value*); 0 vs −0
boxed under different tags makes `0 === -0` false (#1987);
`string|undefined` unions compare by ref identity (#1961); empty-string
truthiness checked as ref-non-null (#2080); `ref.null` arrives at the host as
`null` when it means `undefined` (#1995); BigInt rides untagged externref/i64
(#2044); the IR embeds backend ValType in `IrType` so it *cannot* express
these brands (#1926). The linear backend repeats the defect with raw-pointer
truthiness (#1975). #2055 is the numeric-flavor twin: an i32 `numericHint`
silently truncates the *other* f64 operand of a relational.

**Single change:** a **branded value-representation decision** — JS-type-aware
box tags (boolean, undefined, null, string, bigint as first-class tags) chosen
from the *checker type*, not the lowered ValType, plus a boolean/undefined
brand for unboxed i32/f64 slots. #2044 is the open architect decision for the
BigInt corner; #2072/#2080 (senior-routed) are the standalone half. This is
**upstream of** the coercion engine (#1917): a single coercion engine fed
untagged values still cannot recover the JS type.

### F3 — COERCE: coercion-engine divergence & ToPrimitive shortcuts — ~13 issues

**Members:** #1917 (umbrella), #1986, #1988, #1990, #1997, #2007, #2014,
#2022, #2034 (done), #2058, #2059, #2063, #2081. (× #1989, #1993.)

**Severity profile:** silent wrong values + one TypeError-throwing path
(#1990) + traps (#2007 illegal cast).

**Structural defect:** four independently-maintained coercion matrices that
disagree (#1917: `type-coercion.ts:980`, `:2695`, `stack-balance.ts:1179`,
`:678`), and operator lowerings that skip the spec's ToPrimitive /
ApplyStringOrNumericBinaryOperator steps: `===` between any and number
applies **ToNumber** — strict equality is literally looser than `==`
(#1986: `null === 0` → true); `__any_add` skips ToPrimitive entirely
(#1988: `[] + []` → 0); `+` with a runtime string in an any slot does numeric
addition (#2058); relationals never do string comparison (#2059); `obj + ""`
uses string hint instead of default hint (#2022); `switch` unifies all cases
into one comparison domain, violating per-case StrictEquality (#2063);
standalone `==` between two anys compares references (#2081) or leaks
`env.__host_loose_eq` into a zero-import binary (#2073 → F12); numeric keys
never go through ToPropertyKey (#2014).

**Single change:** #1917's single coercion engine, **co-designed with F2's
brands** — one `applyBinaryOperator`/`toPrimitive` lowering consulted by
`+`, `==`, `===`, relationals, switch, and template literals, in both lanes.

### F4 — HOST: host-boundary marshaling & ABI glue defects — ~14 issues

**Members:** #1915, #1932, #1933, #1935, #1969, #1994, #1996 (done), #1998,
#2008, #2015, #2028, #2070, #2071, #2083. (× #2025, #2013.)

**Severity profile:** silent data corruption (#1996 `[[1,2]].flat()` →
`[null,null]`; #1969 concat appends a vec as one opaque element) and
uncatchable traps (#1998 join on externref elements; #2070 closures pushed
into arrays wrapped as host callbacks then invoked as Wasm closure structs;
#2028 Promise executor resolve/reject traps null deref; #2015 `this`-routing
through `__extern_method_call` throws).

**Structural defect:** Wasm↔host value marshaling is decided **ad hoc per
call site**. WasmGC vecs cross the boundary opaque in some bridges and
converted in others; closures are wrapped as host callbacks on some paths
(`__make_callback`) and kept as structs on others, with the
`HOST_CALLBACK_METHODS` allowlist dead code (#2070); the ~200-name env ABI
has no version handshake (#1932) and module-level host state bleeds across
instances (#1933); `undefined` doubles as an in-band "absent" sentinel
(#1935). #2083 shows the same glue exported per-module dominating
small-binary size. #2071 needs an externref ctor-return ABI — a marshaling
contract question.

**Single change:** one **marshaling layer** with a declared deep-conversion
contract (vec ⇄ JS array, closure ⇄ callback, struct ⇄ object) that every
bridge import goes through, plus the versioned ABI (#1932). This is also the
gate for the standalone lane: every ad-hoc bridge is a future import leak
(F12).

### F5 — ERR: error-model divergence (traps where catchable JS errors are required) — ~10 issues

**Members:** #1954, #1972, #2000, #2003, #2012, #2017, #2025, #2031, #2061,
#2084 (write half). (× #2024, #2077, #2062.)

**Severity profile:** uncatchable RuntimeError traps replacing TypeError /
RangeError / ReferenceError (#2003 charCodeAt OOB traps instead of NaN; #2017
getter-only assignment traps "illegal cast"; #2025 extracted-method call
traps; #2031 destructuring traps on `array.copy` with an unclamped source
offset), **missing** errors (#1954 parameter-default TDZ; #2000 Array(len)
RangeError; #2012 freeze never throws), and broken handler plumbing (#1972
`return_call` inside try makes catch unreachable; #2061 cloned finally
branch depths off by the abrupt site's extra nesting).

**Structural defect:** runtime checks lower to Wasm traps (or to nothing)
instead of to the compiler's own catchable JS-exception mechanism; there is
no shared "throw JS TypeError/RangeError" helper that bounds checks,
integrity checks, and callable checks all route through. The try/catch
lowering itself has two control-flow correctness bugs (#1972, #2061) that
make handlers unreachable.

**Single change:** a single `throwJsError(kind, msg)` lowering used by every
guard the compiler emits + an audit converting trap-emitting guards; fix the
two handler-reachability bugs first (they make the rest unobservable).

### F6 — CLASS: class / prototype / property-model gaps — ~12 issues

**Members:** #1965, #1971, #1991, #2018, #2020, #2021, #2023, #2024, #2026,
#2027, #2082. (× #2011, #2071, #2078, #2084 read half.)

**Severity profile:** wrong values and traps in core OO idioms: derived
construction never runs the base ctor **body** — `super(args)` writes args
positionally into parent struct fields (#1965, sprint-61 max); implicit
derived ctors are synthesized with **zero params** so `new Dog("rex")`
constructs with name=null (#2082); `new.target` is constant `i32 1` (#2023);
classes are not first-class values (#2026); inherited statics unreachable
(#2020); `in` never consults the prototype chain (#1991); any `return` in a
base ctor traps null deref (#2018); array-literal element type taken from
the first element ignores the contextual base-class annotation (#2021).
#1971 is the triage container proving six "done" property-model issues have
reproducible residuals on main.

**Structural defect:** classes lower to flat WasmGC structs + statically
dispatched functions with **no constructor-as-function object and no
prototype object** — anything that treats a class as a value, walks the
chain, or relies on ctor-body execution order falls off the model.

**Single change:** an architect-level decision on the class object model
(ctor function value + chain representation), then the ctor-body fixes
(#1965/#2082/#2078) as its first consumers.

### F7 — BIND: binding environment, capture, and mutation-tracking defects — ~12 issues

**Members:** #1951, #1953, #1970, #1999 (done), #2011, #2052, #2057, #2062,
#2064, #2065, #2066, #2068. (× #1982, #1966, #2019.)

**Severity profile:** mix of invalid-Wasm CEs (#1951 recursive const-arrows,
#1953 captured loop var mutated in body) and silent wrong values (#2068
nested `fact()` recursion resolves to the unknown-identifier fallback
(`ref.null extern` → `__unbox_number(null)` → 0); #2011 object-literal
accessors capture *copies*; #2057 `isStaticNaN` traces initializers ignoring
reassignment; #2062 rethrow ignores catch-param reassignment; #2064
if-branch `let` permanently shadows the outer binding in `fctx.localMap`;
#2065/#2066 for-of/for-in iterate stale snapshots; #1970 Map destructuring
reuses a stale conversion buffer every iteration; #2052 `||=` calls the
getter twice).

**Structural defect:** there is no single answer to "is this binding mutated /
captured / forward-referenced?" — each lowering keeps its own snapshot
(localMap shadows, hoisted length/data, cached conversion buffers,
initializer traces) and forgets to invalidate it. The IR shows the same
defect shape in #1982 (lazy use-site emission reorders reads past writes — a
missing effect/alias dependency).

**Single change:** a shared binding-info analysis (assigned? captured?
declaration order?) consulted by closure capture, const-folding, snapshot
caching, and scope-map save/restore; an effect-ordering rule in IR lazy
emission (#1982).

### F8 — DUP: duplicated lowering paths drifting — ~9 issues

**Members:** #1919, #1920, #1922, #1927, #1931, #1934, #1948, #2033, #2047.
(× #1917 four coercion matrices, × #1955 fromCharCode duplicated host+native,
× #2005/#2006 template-literal vs binary-concat stringification divergence.)

**Severity profile:** mostly latent, but with confirmed shipping defects:
every ordinary `while (i < limit)` silently demotes off the IR path because
DCE never walks `while.loop` condition buffers (#1922, probe-verified);
peephole misses `catchAll` bodies (#1920); multi-file compiles silently skip
early errors/IR/hardened mode (#1927); two standalone `Array.isArray`
implementations merged concurrently in the same sprint, one dead (#2047);
spread and destructuring don't consult the iterator protocol that for-of
consults (#2033); 23 probe-compile-and-rollback sites leak locals/imports/
types (#1919).

**Structural defect:** per-construct re-implementation with an existing "good
twin" (the review's cross-cutting finding 2). Divergence is the breeding
mechanism by which F1/F2/F3 symptoms recur after point fixes.

**Single change:** mechanical consolidation onto the good twin per pair —
highest payoff-per-risk in the upstream review, and the corpus confirms the
breeding continues during normal sprint work (#2047).

### F9 — IDX: index-space fragility (late-import shifts) — 6 issues

**Members:** #1916, #1984, #1985, #2029, #2043 (done), #2079.

**Severity profile:** invalid-Wasm CEs at emit time, at scale: 497 standalone
tests die with `Binary emit error: u32 out of range: -1` (#2029); standalone
generators regressed to "function index out of range" CEs (#2079). ≥7
historical regressions trace to this one decision (#1916).

**Structural defect:** absolute function indices baked into instruction
streams; any late import shifts every defined-function index, and three
coexisting shift/relocation regimes must find every captured copy (#1985: a
`funcIdx` captured in a JS local is a stale value copy that can emit a
*valid-but-wrong* index that no range check catches).

**Single change:** #1916 symbolic function references (the IR already proved
the fix, `ir/nodes.ts:22-28`). #2043 (emit-time validation, done) converted
silent corruption into loud CEs; #1984 (freeze-point discipline) and #1985
(stale-proof `{ idx }` cells) are the incremental hardening steps until
#1916 lands.

### F10 — SHAPE: shape/name-keyed identity collisions — 4 issues

**Members:** #1978, #1983, #1989, #2009. (× #2045 name-keyed linear buffer
registry.)

**Severity profile:** small family, outsized wrongness: two same-shape
literals share field names at the host boundary so `JSON.stringify(b)`
prints the *other* literal's keys, and spread override order breaks (#2009);
the **last** same-shape literal's `valueOf` wins for *all* instances (#1989 —
the eqref path falls back to `ctx.valueOfClosureTypes.get(name)`, name-keyed
at `literals.ts:1486-1489`, dispatch at `type-coercion.ts:1928-2074`); a
class method `A.m` registered as synthetic `A_m` collides with a user
function `A_m` (#1983); a user function named `main` gets the module-init
body spliced into it (#1978 — WASI infinite recursion).

**Structural defect:** identity decided by canonicalized structural shape
(WasmGC iso-recursive types + the compiler's own `anonStructHash` dedup,
`index.ts:9331` per #2009's plan) or by synthesized name strings, instead of
per-instance/per-declaration identity.

**Single change:** instance-carried identity — #2009's spec (hidden i32
shape-id field keying a module-level field-name table) plus #1989's spec
(per-instance funcref dispatch via `call_ref`; already half-implemented on
the ref-path at `type-coercion.ts:1853-1920`, independent of #2009).

### F11 — SPEC: builtin-algorithm spec shortcuts — ~11 issues

**Members:** #1952, #1956, #1959, #1960, #1963, #1964, #1993, #2001, #2035,
#2056, #2060. (× #2000, #2003.)

**Severity profile:** wrong values in well-specified corners: `slice` swaps
bounds like `substring` (#1956); the native regex VM lacks the RepeatMatcher
empty-iteration progress guard and per-iteration capture reset
(#1959/#1960); default `sort` is numeric, not lexicographic ToString
(#1993); `%` computed as `a - trunc(a/b)*b` instead of fmod —
Infinity/0/precision loss at extreme ratios (#2056); `hypot` inlined without
scaling (#2060); sparse holes materialize as element-type defaults and HOFs
visit them (#2001); generator return value leaks into iteration (#2035);
strict-module `arguments` is mapped (#1952); native trim's whitespace set
incomplete (#1963); native string for-of yields code units (#1964).

**Structural defect:** implementations written from memory of the spec, not
from the fetched spec (the repo's own `feedback_spec_first_fixes` rule).
They stay invisible because the test262 oracle is deliberately weakened
(#1945 — expected-error types discarded, `assert.sameValue(x, undefined)`
stripped).

**Single change:** none structural — but #1945 (oracle precision) is the
*detector* that keeps this family from re-accumulating; each member is an
independent, mostly-easy fix with a spec citation.

### F12 — LANE: backend-lane parity (standalone buckets + linear backend) — ~18 issues

**Members (standalone):** #1962, #2036, #2037, #2038, #2039 (in-progress),
#2040, #2041, #2042, #2073, #2074, #2075, #2077, #2078. **Members
(linear):** #1938, #1974, #1975→F2, #1976, #1977, #2045.

**Severity profile:** the standalone buckets aggregate ~5,400 host-pass
tests (#2036 ~500, #2037 683, #2038 ~470, #2039 ~1,135, #2040 ~1,750, #2041
544, #2042 ~340; #2029's 497 counted under F9). The linear lane has
memory-safety-class bugs: `Array.push` past capacity silently corrupts
adjacent heap objects — no growth, no bounds checks (#1977); `%` returns the
RHS because the PercentToken case is empty (#1974); string relationals
compare memory addresses and `.length` returns UTF-8 byte count (#1976);
the Uint8Array path has a name-keyed buffer registry and no bounds checks
(#2045).

**Structural defect:** mostly **not a separate root cause** — the standalone
buckets decompose into F2 (any boxing: #2072/#2080), F4 (import leaks:
#2073/#2075 — every ad-hoc host bridge becomes an instantiation failure in a
zero-import binary), F9 (#2029/#2079), F6 (#2078), F5 (#2077). The genuinely
lane-local defects are the linear backend's prototype-grade array/string
runtime and missing native fallbacks (#1962 native string spread).

**Single change:** none single; route the buckets to their parent families
and hold the line with the standalone refusal layer
(`late-imports.ts:46-86`, the review's praised model) — plus #1977's
bounds/growth as the linear lane's correctness floor.

### F13 — IR-path unsound rewrites — 4 issues

**Members:** #1979, #1980, #1981, #1982. (Meta: #1922–#1926.)

**Severity profile:** module-bricking invalid Wasm with no fallback (#1980
numeric-truthiness loop condition), silent statement skipping (#1979 the
early-return-if rewrite is sound only when the then-arm terminates), silent
deletion of null guards (#1981 `=== null` constant-folded false for
class-typed values), read/write reordering (#1982).

**Structural defect:** rewrites/folds applied without their soundness
preconditions, and a verifier that checks **no per-instruction operand
types** (#1924) so #1980's invalid output sails through to the engine.

**Single change:** #1924 (instruction-level type rules in the IR verifier)
turns this family from silent miscompiles into demotions; the four bugs are
individually small.

### F-META — prevention infrastructure (not bug-breeding; for completeness)

#1923, #1924, #1925, #1928, #1929, #1930 (TypeOracle), #1931, #1936 (async
CPS), #1941 (differential `--optimize` — three reviewers converged on the
largest untested correctness surface), #1942, #1943, #1944, #1945, #1946,
#1947, #1948 (also F2-numeric), #1949, #1950, #1973 (`-O` output *rejected*
by stock V8/JSC — optimize is currently broken, not just untested), #2048
(process: merged-PR ⇒ done automation).

---

## 2. Leverage ranking

Rank = (bugs bred × user-visible impact × prevention leverage) ÷ fix cost.

| # | Family | Bred | Impact | Prevention leverage | Cost | Ownership status |
|---|--------|------|--------|--------------------|------|------------------|
| 1 | **F2 REPR** | ~16 + large share of standalone buckets | Silent wrong values in `String()`, truthiness, `===`, `?.` — the everyday language | One representation decision kills boolean/undefined/null/−0/bigint mis-tagging *and* unblocks F3 | M–L | **Partially owned**: #2072/#2080 senior-routed; #2044 architect decision open; #1926 unowned; no umbrella for "JS-type-driven box tags" in the host lane — **gap** |
| 2 | **F1 SILENT** | ~24 | Worst failure mode (silent), each instance narrow | Default arms + structured gate + arity audit are cheap and ratchetable | S–M | **Owned**: #1937/#1921/#1939/#1918 (review wave 1, #1937+#1941 rated critical); arity-audit bundle (#2002/#1955/#1958/#2013) unbundled — cheap sprint fodder |
| 3 | **F4 HOST** | ~14 + feeds F12's import leaks | Data corruption + uncatchable traps in arrays/closures/Promise; doubles as standalone import leaks | One marshaling layer prevents both lanes' classes | M | **Unowned as a family** — only ABI/state meta (#1932/#1933/#1935) exist; no "deep marshaling contract" issue — **gap** |
| 4 | **F3 COERCE** | ~13 | `===` looser than `==` (#1986) is conformance-poisonous | #1917 already designed; brands (F2) are its prerequisite | M | **Owned**: #1917 ready in sprint 61; per-operator members unbundled |
| 5 | **F6 CLASS** | ~12 | Breaks core OO (derived ctors, new.target, first-class classes) | One object-model decision | L | **Partially**: #1965 sprint-61 max; #2026/#2023 need an architect spec that doesn't exist — **gap** |
| 6 | **F7 BIND** | ~12 | CEs + silent wrong values in everyday closure/loop code | Shared binding-info analysis | M | **Unowned as a family**; members ready individually |
| 7 | **F5 ERR** | ~10 | Blocks try/catch-dependent test262 categories wholesale; #1945 hides the rest | One throwJsError helper + trap-site audit | S–M | **Unowned** — the review's biggest blind spot (§3) |
| 8 | **F8 DUP** | ~9 (breeds F1–F3 recurrence) | Latent, but #1922 demotes every while loop today | Each pair has a good twin; mechanical | S–M | **Owned**: review wave 2 (#1920/#1922/#1927/#1934/#1948) |
| 9 | **F9 IDX** | 6 (≈1,000 tests via #2029+#2079) | Loud CEs post-#2043, no longer silent | #1916 retires the class outright | L (#1916) / M (#1984/#1985) | **Owned**: #2043 done; #1916 sprint 61; #1984/#1985 ready |
| 10 | **F10 SHAPE** | 4 | Severe (wrong keys/valueOf for ALL same-shape objects) but narrow trigger | Both specs written | M | **Owned**: #2009 + #1989 spec'd, ready |
| 11 | **F13 IR** | 4 | Module-bricking + guard deletion, IR lane only | #1924 converts class → demotions | M | **Owned**: #1924 backlog |
| 12 | **F11 SPEC** | ~11 | Long-tail conformance | #1945 is the detector; members independent | S each | Members ready; #1945 backlog |
| 13 | **F12 LANE** | ~18 nominal | Standalone north star; linear memory-safety | Mostly decomposes into F2/F4/F9 | — | Buckets triaged; #1977 (linear heap corruption) is memory-unsafe and unscheduled |

**Key ranking judgment vs the upstream review:** the review's order is
fail-loud → gates → consolidations → strategic (TypeOracle/symbolic refs).
The corpus *confirms* fail-loud as wave 1 but **promotes value
representation (F2) above the consolidation wave**: 16 direct issues plus
the largest standalone bucket trace to type-erased boxing, and #1917's
coercion engine cannot deliver correct semantics over values whose JS type
it cannot recover. Conversely the review's perf items (#1946–#1950) rank
below every correctness family on this corpus and should stay parked —
except #1973, which is a correctness bug wearing a perf label (`-O` output
fails to instantiate on stock engines).

---

## 3. Cross-reference with the upstream review (#1916–#1950)

**Where the review and the empirical corpus agree (owned families):**

- F1 SILENT ↔ review finding 1 ("prefers emitting something over refusing"):
  #1918, #1921, #1937, #1939, #1940. The June audit added ~18 *user-visible
  instances* the review predicted but didn't enumerate (#1966, #2002, #2054,
  #2069…). The review's direction (ratchet silent paths to zero, extend
  #1858) stands, now with an empirical severity profile behind it.
- F8 DUP ↔ finding 2 (3–5 divergent copies): #1917, #1920, #1922, #1927,
  #1934, #1948. Corpus adds #2047 (two concurrent isArray fixes, one dead)
  as live proof the breeding continues during normal sprint work.
- F9 IDX ↔ finding 5: #1916/#1932; corpus adds the measured blast radius
  (#2029: 497 tests; #2079 generators) and the fork's hardening pair
  #1984/#1985 (filed as #2043 Options 3 and 2b).
- Gates ↔ finding 4: #1941–#1945; corpus adds #1973 — `-O` output is not
  just untested but *rejected by stock V8/JSC*, raising #1941's urgency from
  "critical" to "the lane is currently shipping broken binaries".

**Where the review has NO answer (gaps the corpus exposes):**

1. **F5 ERR (trap-vs-catchable error model)** — no #1916–#1950 issue
   addresses lowering runtime checks to catchable JS errors. 10+ empirical
   issues. The review's own oracle finding (#1945 — expected error *types*
   discarded by the runner) explains why its reviewers couldn't see this
   family in the test262 numbers.
2. **F6 CLASS (object model)** — the review grades WasmGC codegen C− but
   proposes no class/prototype representation work; #1965/#2023/#2026/#2082
   have no upstream parent issue.
3. **F10 SHAPE (identity collisions)** — entirely empirically discovered
   (#2009/#1989/#1983/#1978); nothing in the review anticipates
   name-keyed/shape-keyed dispatch as a bug class.
4. **F7 BIND (mutation/staleness)** — the review covers IR effect ordering
   implicitly (verifier gaps, #1924) but has nothing for the legacy path's
   snapshot/scope-map defects (#2064, #2065, #2057, #1970…).
5. **F4 HOST marshaling depth** — the review graded runtime/host interop
   **B**, its best near-codegen grade, on governance/ABI criteria
   (allowlist, regex engine). The corpus shows ~14 semantic marshaling
   defects (vec opacity, callback wrapping, this-routing). The B is right
   about *process* and wrong about *semantics*; #1932/#1933/#1935 don't
   cover the conversion contract.

**Where empirical data changes the review's priorities:**

- **#1917 (coercion engine) is necessary but not first.** F2's evidence
  (#2072's tag table; #1987; #2005) shows tags/brands are upstream of
  coercion; sequencing #1917 before a representation decision risks building
  the engine on values it cannot classify. Recommend co-spec with #2044 and
  the #2072/#2080 senior track.
- **#1937's "critical" rating is confirmed and the linear floor is lower
  than stated** — the fork audit found heap corruption (#1977) and
  address-order string compares (#1976) beyond the review's break/continue
  finding.
- **#1930 (TypeOracle) gains a concrete payoff list**: #2021 (element type
  from first element, contextual annotation ignored), #2055 (i32 hint
  truncation), #1981 (null-fold on class types) are all type-query-precision
  bugs an oracle boundary would centralize.
- **#1945 (oracle precision) is promoted from "medium" to a family
  detector**: F5 and F11 are structurally invisible until the runner stops
  discarding expected-error types and undefined-asserts.

---

## 4. Sprint-seed list (top families, dependency order)

### Seed A — Value representation (F2) [highest leverage]
1. #2044 — architect decision: branded value representation (extend scope
   from BigInt to boolean/undefined/null/string tags; co-design with #1917).
   *Gate for items 3–6.*
2. #2072 + #2080 — standalone any-boxing tags + truthiness (senior-routed,
   in flight; feeds the decision with implementation reality).
3. #1987 — box-tag-blind strict-eq numeric compare (small, independent).
4. #2005 + #2016 + #2030 — boolean-brand consumers (template literals,
   hasOwnProperty, IteratorResult.done): one fix pattern, three sites.
5. #1957 + #2004 + #2051 — undefined-brand consumers (explicit-undefined
   args, codePointAt OOB, optional-chain short-circuit value).
6. #1926 — remove ValType/typeIdx from IrType so the IR can carry brands.

### Seed B — Fail-loud + arity audit (F1) [cheapest per bug]
1. #1921 — structured compile-failure gate (unlocks honest signal for all
   the rest).
2. #1937 — linear default arms + break/continue; #1939 — encodeInstr default
   throw.
3. #2002 + #1955 + #1958 + #2013 — import-arity audit bundle (one
   mechanism: a builtin bridge must compile all argument expressions or
   refuse).
4. #1966 (+ MUTATING write-back audit at `array-methods.ts:2539`) + #2019 —
   silent-no-op mutations.
5. #2054 + #2053 — SpreadElement passthrough hazard (shared root).
6. #1918 — stack-balance strict mode + fixup ratchet (closes the class).

### Seed C — Host marshaling contract (F4)
1. NEW (needs filing): architect spec "deep marshaling contract at the host
   boundary" — single conversion layer; vec/closure/struct rules.
2. #1969 + #1998 + #1994 — vec marshaling members (apply the merged #1996
   deep-conversion pattern).
3. #2070 — closure-wrapping unification (revive or delete
   HOST_CALLBACK_METHODS).
4. #2015 + #2025 — receiver/`this` routing across the boundary.
5. #2028 — Promise executor callbacks (depends on 3).
6. #1932 — version the env ABI (independent, S).

### Seed D — Catchable error model (F5)
1. #1972 + #2061 — handler reachability first (otherwise the rest is
   unobservable in tests).
2. NEW (needs filing): shared `throwJsError(kind)` lowering + trap-site
   audit.
3. #2003 + #2031 — bounds guards → NaN/clamp per spec instead of trapping.
4. #2017 + #2024 — accessor-integrity TypeErrors.
5. #1954 + #2000 + #2012 — missing ReferenceError/RangeError/TypeError
   checks.
6. #1945 — oracle precision so CI can see this family at all.

### Seed E — Shape identity (F10) [specs already written]
1. #2009 — instance-carried shape-id (spec chosen: hidden appended i32 field
   + module-level field-name table; preserves `anonStructHash` dedup).
2. #1989 — per-instance funcref ToPrimitive dispatch (spec chosen: eqref
   path only; ref-path at `type-coercion.ts:1853-1920` already correct;
   independent of #2009).
3. #1983 — funcMap synthetic-name mangling with a reserved separator.
4. #1978 — stop name-keying the module-init splice on `main`.

### Seed F — Class object model (F6)
1. NEW (needs filing): architect spec — constructor-as-value + chain
   representation (decides #2023/#2026 feasibility).
2. #2082 — implicit derived-ctor params (independent, medium, high
   frequency).
3. #1965 — base-ctor body execution (sprint-61 max; informs the spec).
4. #2078 — standalone twin of 3.
5. #2020 + #2027 — static inheritance + static-init `this`.
6. #1991 — `in` prototype-chain walk.

---

## Appendix: full family membership (primary assignment, all 170)

- **F1 SILENT (24):** 1918 1921 1937 1939 1940 1955 1958 1966 1967 1968 1992
  2002 2010 2013 2019 2032 2046 2049 2050 2053 2054 2067 2069 2076
- **F2 REPR (16):** 1926 1957 1961 1975 1987 1995✓ 2004 2005 2006 2016 2030
  2044 2051 2055 2072 2080
- **F3 COERCE (13):** 1917 1986 1988 1990 1997 2007 2014 2022 2034✓ 2058
  2059 2063 2081
- **F4 HOST (14):** 1915 1932 1933 1935 1969 1994 1996✓ 1998 2008 2015 2028
  2070 2071 2083
- **F5 ERR (10):** 1954 1972 2000 2003 2012 2017 2025 2031 2061 2084
- **F6 CLASS (11):** 1965 1971 1991 2018 2020 2021 2023 2024 2026 2027 2082
- **F7 BIND (12):** 1951 1953 1970 1999✓ 2011 2052 2057 2062 2064 2065 2066
  2068
- **F8 DUP (9):** 1919 1920 1922 1927 1931 1934 1948 2033 2047
- **F9 IDX (6):** 1916 1984 1985 2029 2043✓ 2079
- **F10 SHAPE (4):** 1978 1983 1989 2009
- **F11 SPEC (11):** 1952 1956 1959 1960 1963 1964 1993 2001 2035 2056 2060
- **F12 LANE (19):** 1938 1962 1973 1974 1976 1977 2036 2037 2038 2039 2040
  2041 2042 2045 2073 2074 2075 2077 2078
- **F13 IR (4):** 1979 1980 1981 1982
- **F-META (17):** 1923 1924 1925 1928 1929 1930 1936 1941 1942 1943 1944
  1945 1946 1947 1949 1950 2048 + (1973 listed under F12 as the optimize
  lane-breaker)

(✓ = done at time of writing. Cross-memberships are noted inline in each
family section. Counts sum to 170.)
