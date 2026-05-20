---
id: axios-tier1-survey
title: "axios Tier 1 compile/validate survey (probe of `axios@1.16.1`)"
status: survey
created: 2026-05-20
owner: tech-lead
priority: high
area: codegen, resolver, runtime
goal: npm-library-support
related: [1032, 1042, 1043, 1044, 1276, 1287, 1289, 1558]
---

# axios Tier 1 — compile/validate survey

Anticipatory survey to land alongside `tests/stress/axios-tier1.test.ts` and
populate the actionable issue tail for goal **#1032** (Compile axios to Wasm —
Node builtins as host imports). Mirrors the methodology of
`react-tier1-survey.md` and `eslint-next-layer-survey.md`: drive
`compileProject` against each plausible entry point and document — at the
granularity of "compiles OK / validates OK / instantiates OK" — what works
on `main` today.

Package surveyed: **`axios@1.16.1`** (newly added as a dev dep on this branch).

## Method

```ts
import { compileProject } from "./src/index.ts";
const r = compileProject(entry, { allowJs: true });
// r.success — type-checks + emits a binary
const validates = WebAssembly.validate(r.binary);
// new WebAssembly.Module(r.binary) — same as validate, but exposes the first error
```

Probe script: `.tmp/probe-axios.ts` (slot 1-3) + `.tmp/probe-axios-rest.ts`
(slot 4-10, one-entry-per-process so a hang in one entry does not hide
others). Both gitignored under `.tmp/`. The split was forced because the
single-script probe wedged silently on entry 4 (`index.js`) — see below.

## Results matrix

| Entry | Compile? | Validate? | First blocker |
|-------|----------|-----------|---------------|
| **1.** TS `import axios from "axios"` (default) | OK (4 250 B) | OK | clean — type-only import, empty body |
| **2.** TS `import { Axios, AxiosError } from "axios"` (named) | OK (4 250 B) | OK | clean — type-only import, empty body |
| **3.** `node_modules/axios/dist/node/axios.cjs` (5 469 LOC) | OK (502 107 B) | **FAIL** | `AxiosHeaders_set` — `any.convert_extern[0]` expected externref, found `global.get` of type `(ref null 555)` @+100906 |
| **4.** `node_modules/axios/index.js` (ESM aggregator) | **HANG** (>180 s) | n/a | `compileProject` never returns |
| **5.** `node_modules/axios/lib/utils.js` | OK (70 284 B) | **FAIL** | `isBuffer` — `fallthru[0]` expected i32, got f64 @+12234 |
| **6.** `node_modules/axios/lib/core/Axios.js` | **HANG** (>60 s) | n/a | `compileProject` never returns |
| **7.** `node_modules/axios/lib/core/AxiosError.js` | OK (224 333 B) | **FAIL** | `AxiosHeaders_set` — same `any.convert_extern` externref vs `ref null 50` mismatch |
| **8.** `node_modules/axios/lib/axios.js` | **HANG** (>60 s) | n/a | `compileProject` never returns |
| **9.** `node_modules/axios/lib/adapters/http.js` | **HANG** (>60 s) | n/a | `compileProject` never returns |
| **10.** `node_modules/axios/lib/adapters/fetch.js` | OK (4 677 930 B) | **FAIL** | `isBuffer` — same `fallthru[0]` i32 vs f64 mismatch @+113227 |

Three distinct blocker families surface across the 10 entries:

- **NEW issue 1** — **compileProject hangs** on every entry that pulls the
  full `lib/core/Axios.js` module graph (entries 4, 6, 8, 9). This is the
  most severe blocker — it gates four of the seven "real source" entries
  and dominates the Tier 1 ladder.
- **NEW issue 2** — `AxiosHeaders.prototype.set` validates as
  `any.convert_extern[0] expected externref, found global.get of type (ref null N)`
  (entries 3 and 7). Type-coercion bug in extern boxing of a WasmGC struct
  value.
- **NEW issue 3** — `isBuffer` validates as
  `fallthru[0] expected i32, got f64` (entries 5 and 10). Same return-type
  unification family as ESLint **#1558** and the React-tier1 `mapIntoArray`
  finding.

The bare-package TS shim entries (1, 2) compile + validate clean because
TypeScript's resolver routes the named import through the bundled
`index.d.ts`, so the JS body is never walked. They are an upper bound on
"works today" but offer no runtime — exports are empty.

---

## NEW issue 1 — `compileProject` hangs on `lib/axios.js`-rooted graphs

### Affected entries
- `node_modules/axios/index.js` (entry 4)
- `node_modules/axios/lib/axios.js` (entry 8)
- `node_modules/axios/lib/core/Axios.js` (entry 6)
- `node_modules/axios/lib/adapters/http.js` (entry 9)

Each hangs `compileProject` indefinitely; a 60-180 second timeout always
hits. The process is hot (~100% CPU, 1.5 GB RSS) — not deadlocked, just not
returning. Killing it with SIGTERM is the only escape.

### Likely source-code site
The four hanging entries share one thing: they transitively import
`lib/core/Axios.js`. The two non-hanging "real source" entries
(`lib/utils.js`, `lib/core/AxiosError.js`) do not import it. So the regression
is reachable via `lib/core/Axios.js` specifically. That file pulls in:

```js
// lib/core/Axios.js head:
import utils from './../utils.js';
import buildURL from '../helpers/buildURL.js';
import InterceptorManager from './InterceptorManager.js';
import dispatchRequest from './dispatchRequest.js';
import mergeConfig from './mergeConfig.js';
import buildFullPath from './buildFullPath.js';
import validator from '../helpers/validator.js';
import AxiosHeaders from './AxiosHeaders.js';
```

A reasonable hypothesis is that one of these — likely
`InterceptorManager.js`, `dispatchRequest.js`, or `AxiosHeaders.js` — induces
either:
- A non-terminating module-resolution loop (mutual `require()` / `import` between two files that cycle through `axios`-internal helpers);
- A non-terminating IR-rewrite / inference pass (axios uses heavy
  `Object.defineProperty(...)` setter chains in `AxiosHeaders` — pattern
  matching may loop);
- A non-terminating trampoline-emission for chained method-on-object dispatch
  (during early triage one of the four hanging entries showed an unbounded
  stream of `[TRAMP-EOMC] __obj_meth_tramp___anon_*` debug lines —
  several thousand emissions for the same handful of method names with
  monotonically rising counter suffixes).

### Reproducer
```ts
import { compileProject } from "./src/index.ts";
// any of these will hang in 60-180 s with no progress:
compileProject("node_modules/axios/lib/core/Axios.js", { allowJs: true });
compileProject("node_modules/axios/lib/axios.js",       { allowJs: true });
compileProject("node_modules/axios/lib/adapters/http.js",{ allowJs: true });
compileProject("node_modules/axios/index.js",            { allowJs: true });
```

### Proposed issue title
`compileProject hangs on axios lib/core/Axios.js module graph (4 distinct entry points)`

### Feasibility
**hard** — diagnosing a non-terminating compile requires bisecting the
import graph (start from `lib/core/Axios.js`, stub out imports one by one
until the hang reproduces minimally) and then attaching a node `--inspect`
to identify which compiler pass is looping. The fix could be small (e.g. a
visited-set in a recursive helper) or structural (e.g. trampoline-counter
reset between repeated lowerings of the same call shape).

### Bug class
**CODEGEN bug** — non-termination. Severity: critical for axios Tier 1
(four of seven real-source entries gated on this one issue).

### Shared with other libs?
- **Not seen with React** — React's `cjs/react.production.js` compiles in
  ~6 s.
- **Not seen with ESLint** — ESLint's largest entry (`lib/api.js`, 953 KB
  binary) compiles in ~30 s.
- **Not seen with lodash** — individual lodash modules compile sub-second.
- **Unique to axios** in the current survey set. The trampoline-emission
  loop hypothesis suggests it triggers on a code shape axios uses heavily
  — likely the `AxiosHeaders` prototype with its dynamic property setters.

---

## NEW issue 2 — `AxiosHeaders.set` extern boxing of a WasmGC struct value

### Affected entries
- `node_modules/axios/dist/node/axios.cjs` (entry 3)
- `node_modules/axios/lib/core/AxiosError.js` (entry 7)

(`AxiosError.js` reaches `AxiosHeaders` indirectly through axios's normal
module graph; the validator surfaces the same function name in both.)

### Reproducer
```ts
import { compileProject } from "./src/index.ts";
const r = compileProject(
  "node_modules/axios/dist/node/axios.cjs",
  { allowJs: true },
);
expect(r.success).toBe(true);                       // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true);  // currently fails
```

### Error
```
WebAssembly.Module(): Compiling function #202:"AxiosHeaders_set" failed:
  any.convert_extern[0] expected type externref,
  found global.get of type (ref null 555) @+100906
```

For `lib/core/AxiosError.js` the same function emits the same error at
`@+25479` with a different struct type index (`(ref null 50)`), confirming
the issue is structural, not a one-off index slip.

### Likely source-code site
`axios/lib/core/AxiosHeaders.js:154-189` — `AxiosHeaders.prototype.set`:

```js
set(header, valueOrRewrite, rewrite) {
  const self = this;

  function setHeader(_value, _header, _rewrite) {
    const lHeader = normalizeHeader(_header);
    if (!lHeader) {
      throw new Error('header name must be a non-empty string');
    }
    const key = utils.findKey(self, lHeader);
    if (!key || self[key] === undefined || _rewrite === true ||
        (_rewrite === undefined && self[key] !== false)) {
      self[key || _header] = normalizeValue(_value);  // ← assigns f64/extern value to a WasmGC global
    }
  }
  // ...
}
```

The codegen lowers `self[key || _header] = normalizeValue(_value)` to a
`global.set` against a WasmGC struct field, then tries to box the resulting
value through `any.convert_extern` for downstream extern use. The boxing
expects the input to already be `externref` but the optimizer left it as a
typed struct reference.

### Proposed issue title
`AxiosHeaders.set: any.convert_extern expects externref, got WasmGC struct ref (coercion gap on extern boxing of typed struct)`

### Feasibility
**medium** — same family as the `coerceType` helpers in
`src/codegen/type-coercion.ts`. The fix is a coercion case for
`ref null <typeIdx>` → `externref` via `extern.convert_any` before the
`any.convert_extern` (or, more cleanly, in `coerceToExternref`). Comparable
to the `ref/ref_null → externref` case already documented in CLAUDE.md.

### Bug class
**CODEGEN bug** — extern boxing missing for the `WasmGC struct → externref`
direction. The `externref → WasmGC` direction is handled; this is the
inverse, surfacing on a write into a host-typed property.

### Shared with other libs?
- **Possibly shared with React** — `react.production.js` does similar
  dynamic property assignment on the element `props` object. Not yet
  observed because Tier 1d validation already fails earlier on `mapIntoArray`.
- **Not shared with ESLint** — `eslint/lib/api.js` uses
  `Object.defineProperty` with separate getter/setter functions, which hits
  a different lowering path.
- **Not shared with lodash** — lodash avoids dynamic property writes.

---

## NEW issue 3 — `isBuffer`: `fallthru[0]` expected i32, got f64

### Affected entries
- `node_modules/axios/lib/utils.js` (entry 5)
- `node_modules/axios/lib/adapters/fetch.js` (entry 10)

### Reproducer
```ts
import { compileProject } from "./src/index.ts";
const r = compileProject(
  "node_modules/axios/lib/utils.js",
  { allowJs: true },
);
expect(r.success).toBe(true);                       // currently passes
expect(WebAssembly.validate(r.binary)).toBe(true);  // currently fails
```

### Error
```
WebAssembly.Module(): Compiling function #68:"isBuffer" failed:
  type error in fallthru[0] (expected i32, got f64) @+12234
```

### Likely source-code site
`axios/lib/utils.js:31-43` — `isBuffer`:

```js
function isBuffer(val) {
  let result;
  result = (val !== null) && (val !== undefined) && (val.constructor !== null) &&
    (val.constructor !== undefined) && (typeof val.constructor.isBuffer === 'function') &&
    (val.constructor.isBuffer(val));
  return result;
}
```

The chained `&&` builds an i32 (boolean) along the early-exit branches,
but the **final** `val.constructor.isBuffer(val)` is a generic extern call
whose return value the inference widens to f64 (the default for unknown
JS returns in the externref-arithmetic path). The fallthru-merged result
mixes i32 from the short-circuit returns with f64 from the host call, and
the wasm validator rejects the inconsistency.

### Proposed issue title
`axios/lib/utils.js: isBuffer && chain fallthru type mismatch (i32 vs f64 from final extern call)`

### Feasibility
**medium** — same family as **#1558** (`Linter_verifyAndFix` `f64.eq[0]`)
and the React-tier1-survey "NEW issue 1" (`mapIntoArray` fallthru).
Likely a single shared fix: when an `&&` chain's terminal operand is an
externref/f64 call result, the i32 short-circuit branches must coerce to
the same width before fallthru merging. Either widen the i32 branches to
f64 or narrow the extern-call result to i32 via `i32.eqz` + invert.

### Bug class
**CODEGEN bug** — number-type unification across `&&` short-circuit and
final-operand branches.

### Shared with other libs?
- **Shared with ESLint #1558** — same `f64`/`i32` fallthru mismatch in
  `Linter_verifyAndFix`.
- **Shared with React** — same fallthru mismatch in `mapIntoArray` (see
  `react-tier1-survey.md` NEW issue 1).
- **Not yet seen in lodash** — but lodash's individual function modules
  are too small to have surfaced it. Likely lurks in any
  numeric-with-shortcut function.

**Pattern strength: this is now seen in THREE separate libraries.** Strong
candidate for an umbrella issue: "Codegen: unify return-type across `&&`
fallthru branches when one side is f64 / externref and the other is i32".

---

## Tier-1 recommendation

After landing the three NEW issues above, the axios Tier 1 ladder
(`tests/stress/axios-tier1.test.ts`) should progress as follows:

| Rung | Today | After NEW issue 1 (hang) | After NEW issue 2 (extern boxing) | After NEW issue 3 (fallthru) |
|------|-------|--------------------------|-----------------------------------|------------------------------|
| 1a. bare-package TS entry compiles                 | pass | pass | pass | pass |
| 1b. bare-package binary validates                  | pass | pass | pass | pass |
| 1c. `dist/node/axios.cjs` direct compile succeeds  | pass | pass | pass | pass |
| 1d. `dist/node/axios.cjs` binary validates         | fail | fail | **pass** | pass (extern + fallthru both required) |
| 1e. `lib/axios.js` compile succeeds                | **hang** | **pass** | pass | pass |
| 1f. trivial `axios.get(url)` runs end-to-end       | fail | fail (needs #1042 await + #1044 host imports) | fail | fail |

So the dependency chain for the smoke test is:

```
axios-Tier-1 (rung 1f — real GET against httpbin.org)
  └─ #1044 Node host imports (http/https/url/zlib/stream/buffer/events/util)
  └─ #1042 Real async/await state-machine lowering
  └─ NEW issue 1 (compileProject hang on lib/core/Axios.js graph)
  └─ NEW issue 2 (extern boxing for WasmGC struct → externref on property write)
  └─ NEW issue 3 (fallthru type unification in && chains — shared umbrella w/ #1558)
  └─ Buffer global registration (called out by #1032 architect note, not yet filed)
```

## Acceptance criteria (this survey)

- [x] Ten plausible entry points probed (bare-package TS shim, CJS bundle, ESM aggregator, 5 real source files, 2 adapters).
- [x] Three representative blockers captured (the hang, the extern boxing, the fallthru) with reproducer + likely source line + proposed issue title + feasibility + bug class.
- [x] Cross-library applicability noted: NEW issue 3 is shared with ESLint #1558 and the React `mapIntoArray` finding; NEW issue 1 appears unique to axios so far; NEW issue 2 is plausibly shared with React but not yet confirmed.
- [x] Tier ladder mapping shows which rung unblocks after each fix.
- [x] `tests/stress/axios-tier1.test.ts` filed alongside this survey, pre-skipped at rungs that depend on unlanded issues.

## Non-goals

- Filing the actual sprint issues — that is the PO's job once the next sprint planning starts. This survey just provides the actionable inputs.
- Running Tier 2 (core class graph), Tier 3 (browser adapter), or Tier 4 (Node adapter + real GET). Tier 1 must compile + validate first.
- Solving any of the blockers. This is a survey, not an implementation PR.
- Diagnosing the deeper cause of the hang. The reproducer reduces it to four entry points; bisecting the import graph is implementation work.
