# W14 — annexB eval-code lever (2026-08-06): context + PR body

Agent `ttraenkler/W14-annexb-eval-code`. Branch
`issue-4137-acorn-forin-instance-keys` on `origin` (this checkout's `origin`
**is** upstream `loopdive/js2`; there is no `fork` remote). No PR — `gh` is
unauthenticated here (401).

**Nothing was fixed. Two things were measured and one issue was filed.** The
42-file lever refuted its framing: neither arm is an Annex B defect, and neither
is fixable in this lane without work that belongs to other issues.

---

## PR body (verbatim)

Files **#4194** and records two measurements. No compiler change.

### 1. The lever, measured with a control

Population: the 42 standalone ES5-label failures under
`annexB/language/eval-code/` (2026-08-06 published baseline). Control: the 427
files in the same directory that currently pass.

| build | lever pass / 42 | control pass / 427 |
| --- | ---: | ---: |
| `origin/main` (431ea77d55) | 1 | 427 |
| + `origin/issue-4182-annexb-global-blockfn` merged | **17** | **427** |

**+16, zero regressions.** Both control runs are the full 427, not a sample.

The instrument was validated before any claim: the baseline run agrees with the
published standalone jsonl on **41 of 42** files (the one disagreement is
`func-if-decl-no-else-eval-func-existing-block-fn-update.js`, a
`compile_timeout` in CI that passes locally), and the control proves the runner
can see a pass — a lever-only instrument cannot tell "my fix did nothing" from
"my runner cannot see a pass".

### 2. `issue-4182-annexb-global-blockfn` is worth +16 in a directory nobody
attributed to it

All 16 flips are `annexB/language/eval-code/**-existing-block-fn-update`. Every
one has the same outer shape — `{ function f(){ return 'first declaration'; } }`
at script top level — whose AOT binding does not exist on `main`, so eval's
B.3.3 `SetMutableBinding` has nothing to update.

The eval→AOT write-back itself is **not** broken, which is the part worth
recording because it is the obvious wrong suspect. Probe `p11.js`, one file, four
outer forms, all four correct on plain `main`:

| outer binding | eval'd code | result |
| --- | --- | --- |
| `var v1 = 'first'` | `v1 = "second"` | second |
| `var v2 = 'first'` | `var v2 = "second"` | second |
| `var v3 = 'first'` | `{ function v3(){ return "second"; } }` | second |
| `function v4(){ return 'first' }` | `{ function v4(){ return "second"; } }` | second |

Only the form with **no AOT binding at all** fails. So the family is purely
#4182-downstream; there is no separate eval-side defect here.

### 3. #4194 — the other 24 files are a compiled-acorn defect, three layers deep

The 24 `*-skip-early-err-try` files all fail as `SyntaxError: NaN`. Root cause,
A/B'd on the real pinned acorn tarball: **in `--target standalone` a constructed
instance has no expando substrate.**

| surface, instance with ctor fields + a later `n.name = "f"` | standalone | js-host |
| --- | ---: | ---: |
| `for (const p in n)` — keys seen | **0** | all |
| `Object.keys(n).length` | **0** | 2 |
| `("type" in n) + ("name" in n)` | **neither** | both |
| read back `n.name` after writing it | **undefined** | `"f"` |

Acorn's `copyNode` is `for (var prop in node) { newNode[prop] = node[prop] }`
over a `Node` instance, and it is called on exactly one path — **object-property
shorthand**. It returns a blank node, so `checkLValPattern` reads
`type === undefined`, falls through to `checkLValSimple`'s `default:` arm, and
raises. Compile the tarball twice changing **only** `copyNode`:

| build | `var { a } = {}` | `var { a: b } = {}` | `catch ({ f }) {{ function f(){} }}` | `var o = { f }` |
| --- | --- | --- | --- | --- |
| stock | **raise** | ok | **raise** | ok |
| copyNode patched | ok | ok | ok | ok |

Consequence well beyond these 24: **no standalone `eval`/`Function` parses object
destructuring shorthand.** `var {a}={}`, `let {f}={}`, `function g({f}){}`,
`({f}={})`, `for (var {f} of [])`, `catch ({f})` all reject; `{a: b}`, `[a]` and
object-*expression* `{f}` are fine.

Fixing that alone flips **zero** of the 24. Two more layers, both measured:

- **Layer 2** — with a shorthand-free but semantically identical oracle
  (`catch ({ f: f })`, which stock compiled acorn *can* parse) the interpreter
  refuses: `interp/emitter: unsupported in Phase 1: catch destructuring
  (ObjectPattern)`. #4137 arm 3 / #2928 Phase 2.
- **Layer 3** — B.3.5 exempts only a `BindingIdentifier`; a *destructuring*
  CatchParameter must **cancel** the Annex B synthetic var. #4137 built
  `SIMPLE_CATCH_SCOPE_LABEL` for the exempt half; the cancelling half has never
  been reached by any input.

Not attempted here on purpose: layer 1 is `#4098` / `#4010` rows 4-7 greenfield
and the adjacent widening carries a **measured -5** on record (#4071,
`Object.keys` over closed structs). Landing it unmeasured at the tail of a budget
window is the shape of failure this project already has receipts for.

### 4. Correction to #4137's arm 3

#4137's handoff attributes `SyntaxError: NaN` to an `any`-typed compound `+` in
`src/codegen/expressions/operator-assignment.ts` and to a second compiled-acorn
**scope-tracking** defect, handing on a `pa9.ts`/`pa10.ts` probe pair. The
message corruption is real but **cosmetic**; the verdict-changing defect is
`copyNode`, and it is not scope tracking. `err.pos` is `NaN` as well as
`err.message`, which a `message += string` bug cannot explain — on genuine syntax
errors (`var 1 = 2;`, `(`, `a b c`) node-acorn gives `Unexpected token (1:N)` with
`err.pos = N` and compiled acorn gives message `"NaN"`, `err.pos = NaN`. Anyone
starting from the scope tracker will not find the bug.

**#4137 was NOT edited** — it is still claimed by `ttraenkler/L3-annexb-hoisting`
on `origin/issue-assignments` and owner pins are absolute. The correction lives
in #4194 so the next lane finds it.

---

## 5. Requested side-measurement — the shape of annexB `function-code` (50 failures)

Asked for by the lead before dispatching anyone at that bucket. **No fix, shape
only.** Note it is **50**, not 49 (the census's 49 omits the one `compile_error`).

First, the decisive negative: **`issue-4182-annexb-global-blockfn` flips 0 of the
50** (measured on the same stacked build that scored +16 in eval-code). It is
global-scope only; function-code needs its own work.

These are **pure AOT** — no `eval` anywhere. Every test declares a function whose
body contains a block-level function declaration, and asserts §B.3.3.1
(FunctionDeclarationInstantiation) behaviour:

```js
var init, changed;
(function() {
  init = f;                       // want undefined — the FDI-created var binding
  f = 123;
  changed = f;
  { function f() {  } }
}());
assert.sameValue(init, undefined, 'binding is initialized to `undefined`');
assert.sameValue(changed, 123,    'binding is mutable');
```

By test **case** (the suffix after `-func-`; the prefix is only the syntactic
form — `block-decl` / `if-decl-*` / `switch-*` — and is NOT the mechanism):

| case | fail/total | dominant signature |
| --- | ---: | --- |
| `skip-dft-param` | 8/8 | `binding is not initialized to undefined` — got `NaN`, want `123` |
| `init` | 8/8 | `binding is initialized to undefined` — got a function |
| `existing-block-fn-update` | 8/8 | `"first declaration"` vs `"second declaration"` |
| `no-skip-try` | 7/8 | `Initialized binding created prior to evaluation` |
| `existing-fn-update` | 5/8 | `"outer declaration"` vs `"inner declaration"` |
| `existing-var-update` | 3/8 | `"number"` vs `"function"` |
| `existing-fn-no-init` | 3/8 | `"inner declaration"` vs `"outer declaration"` |
| `block-scoping` | 3/8 | **`illegal cast [in f() ← __module_init]`** |
| `skip-early-err-{try,for-in,for-of}` | 3/24 | `An uninitialized binding is not created following evaluation` |
| `function-redeclaration-switch` | 1/1 | **`compile_error: Cannot redeclare block-scoped variable 'a'`** |
| `skip-arguments` | 1/1 | `""` vs `"[object Arguments]"` |

Three groups, and they are **not** one dispatch:

- **A — the var binding is never created at FDI (34 files):** `init`,
  `skip-dft-param`, `no-skip-try`, `existing-fn-update`, `existing-var-update`,
  `existing-fn-no-init`. This is `annexBOuterBindings` in FDI — **#2200 Phase 2**,
  whose last attempt (#1769) cost **-1180** and was reverted. Do not dispatch this
  without a local test262 slice over the buckets that regressed.
- **B — the binding exists but the block-fn assignment does not update it
  (8 files):** `existing-block-fn-update`. This is the **function-scope twin of
  what #4182 just solved for global scope** — same case name, same assertion pair,
  same mechanism one scope down. Plausibly a bounded extension of an
  already-reviewed design rather than the Phase-2 rewrite. Best value in the
  bucket, and it is separable from group A.
- **C — crashes / compile failures, orthogonal to Annex B semantics (5 files):**
  3× `illegal cast [in f() ← __module_init]` (`block-scoping`), 1 compile_error
  (`Cannot redeclare block-scoped variable 'a'`), 1 `skip-arguments`. A hard cast
  trap is a codegen bug that happens to live here; it needs no FDI change and can
  be taken by anyone.

Population and control lists are `.tmp/lever/fc.txt` (50) and
`.tmp/lever/fc-control.txt` (109 currently-passing) — regenerate from the
standalone jsonl with a two-line filter on
`test/annexB/language/function-code/`.

## Instrument (reproduce before trusting any number above)

Three separate traps, all of which have cost other lanes time today:

1. `tests/test262-runner.ts`'s in-process `runTest262File` does **not** attach
   the `js2wasm:runtime-eval` provider namespace (#4162, filed, unmerged). Do not
   use it for this lane; mirror `tests/test262-shared.ts`'s normal path instead —
   `CompilerPool(n, "unified")` + `assembleOriginalHarness` + strict rerun. That
   harness is `.tmp/lever/run.mts` (list → json) and `.tmp/lever/probe.mts`
   (arbitrary file → verdict).
2. Build order is not optional: esbuild `src/index.ts → scripts/compiler-bundle.mjs`
   **and** `src/runtime.ts → scripts/runtime-bundle.mjs`, then
   `node scripts/build-runtime-eval-provider.mjs` (~100 s; its cache key folds in
   the compiler-bundle hash, so redo it after **every** source change being
   A/B'd), then run with `TEST262_FULL_RUNTIME_EVAL=1`. Without the flag the
   REFUSAL tier answers and every eval test reports
   `dynamic code evaluation is not supported`.
3. A fresh worktree's `test262` / `node_modules` may be symlinked into **another
   agent's worktree** (this one was, into `agent-a788d4f5a3ccb09f5`) — that
   vanishes when they clean up. Repoint them at the shared checkout.

## Preserved probes

`.tmp/` is gitignored and dies with the worktree. Everything load-bearing is
restated in #4194; these are the two that are hardest to re-derive.

### The standalone-vs-host expando table (`.tmp/probe/forin-lanes.mts`)

Compile ONE source twice — `{ target: "standalone" }` vs the host default — and
call all four exports. ~10 s total; it is the fastest way to re-confirm #4194.

```ts
class Node {
  type: any; start: any;
  constructor(start: any) { this.type = "Identifier"; this.start = start; }
}
export function seesFields(): number {          // standalone 0, host 111
  const n: any = new Node(7); n.name = "f";
  let seen = 0;
  for (const p in n) {
    if (p === "type") seen += 1;
    if (p === "start") seen += 10;
    if (p === "name") seen += 100;
  }
  return seen;
}
export function keysLen(): number {             // standalone 0, host 2
  const n: any = new Node(7); n.name = "f";
  return Object.keys(n).length;
}
export function hasType(): number {             // standalone 0, host 11
  const n: any = new Node(7); n.name = "f";
  return ("type" in n ? 1 : 0) + ("name" in n ? 10 : 0);
}
export function readsBack(): number {           // standalone 101, host 111
  const n: any = new Node(7); n.name = "f";
  return (n.type === "Identifier" ? 1 : 0) + (n.name === "f" ? 10 : 0) + (n.start === 7 ? 100 : 0);
}
```

Host-lane instantiation needs `compileAndInstantiate` from
`src/runtime-instantiate.ts` (a bare `WebAssembly.Instance` fails on `env::*`).

### The copyNode A/B (`.tmp/probe/acorn-copynode-ab.mjs`)

Compile `tests/dogfood/setup-acorn.mjs`'s pinned tarball twice (~50 s each),
replacing exactly this text and nothing else:

```js
// stock
pp$2.copyNode = function(node) {
  var newNode = new Node(this, node.start, this.startLoc);
  for (var prop in node) { newNode[prop] = node[prop]; }
  return newNode
};
// patched — enough fields for an Identifier key
pp$2.copyNode = function(node) {
  var newNode = new Node(this, node.start, this.startLoc);
  newNode.type = node.type; newNode.start = node.start; newNode.end = node.end;
  newNode.name = node.name; newNode.loc = node.loc; newNode.range = node.range;
  return newNode
};
```

Append numeric-only probes (nothing may cross the boundary as a string):

```ts
export function pos_x(): number {
  try { parse(<src>, { ecmaVersion: 2022, sourceType: "script" }); return -1; }
  catch (e: any) { const p = e.pos; if (p !== p) return -3; return p === undefined ? -2 : p; }
}
```

`-1` = parsed, `-3` = raised with a NaN pos. Stock gives `-3` for
`var { a } = {}` and `catch ({ f })`; patched gives `-1` for both.

## What I deliberately left undone

- **#4194 itself.** Reasons above: greenfield substrate, a -5 on the adjacent
  widening, and two further layers behind it so layer 1 alone banks nothing.
  Whoever takes it should split the **write** half (a dynamic assignment to an
  instance is currently dropped) from the **enumeration** half, and must NOT
  widen `for-in` and `Object.keys` with one switch — the -5 lives on the
  `Object.keys`-over-builtin-structs side.
- **The `NaN` message/pos channel.** Independent, cosmetic, flips nothing, but it
  is why the shorthand bug survived this long. Both `err.message` and `err.pos`
  are numerified, so it is not only the `message += " (" + line + ":" + col + ")"`
  concat that #4137 identified.
- **`direct/script-decl-lex-no-collision.js`** — the 42nd file, a singleton
  (`Expected SameValue(«function () { [native code] }», «1»)`), untouched.
- **The 12 non-annexB `SyntaxError: NaN` files** (`language/{expressions,
  statements}/class`). Same acorn root cause; they may need only layer 1, which
  cannot be tested until layer 1 exists.
