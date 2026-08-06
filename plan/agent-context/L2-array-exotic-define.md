# Handoff — L2 (array exotic `[[DefineOwnProperty]]`, §15.4.5.1) → fable lane

**Agent**: `ttraenkler/L2-array-exotic-define` (opus senior-dev, mis-routed; handed
off 2026-08-06 before any compiler code was written).
**Owning issue**: #3251 (array-descriptor overlay substrate). Claim RELEASED.
**Worktree** (kept alive, read it): `/home/user/js2/.claude/worktrees/agent-a3165b91ced05c998/`
**Branch**: `issue-3251-s2-array-exotic-define` — contains ONLY this doc. No
source changes. Nothing to rebase around.

The valuable output of this session is (a) a **working, CI-aligned scoped
measurement instrument** for the lever, (b) a **measured baseline**, and (c) two
findings that change how the work should be approached. Read §1 and §2 first.

---

## 1. Finding that re-scopes the work: the lever is NOT blocked, and the prior
## S2+S3 implementation already exists, unmerged, on the fork

Unlike the #4160 case that motivated the "check what fails first" warning, this
lever is **not gated behind a different mechanism**. The canonical case
reproduces exactly as filed, and the measured failure clusters line up 1:1 with
the S2/S3 slices that #3251's own implementation plan already defines. S1 landed
(PR #3327); S2 and S3 were **implemented and validated but never merged**.

They are on the fork, reachable from this container:

```bash
git fetch https://github.com/ttraenkler/js2 \
  issue-3251-array-overlay-s1:refs/remotes/fork/issue-3251-array-overlay-s1 \
  issue-3251-s2-write-enforcement:refs/remotes/fork/issue-3251-s2-write-enforcement \
  issue-3251-s4-forin:refs/remotes/fork/issue-3251-s4-forin
```

| branch | tip | content |
| --- | --- | --- |
| `fork/issue-3251-array-overlay-s1` | `5d21e0103` | S1 (this is what merged as PR #3327) |
| `fork/issue-3251-s2-write-enforcement` | `766af9b98` | **S2 write enforcement + S3 ArraySetLength + plural `defineProperties` vec fix** |
| `fork/issue-3251-s4-forin` | `be7b292cc` | stacked on S2: S4 for-in merge |

Size of the S2+S3 delta (`git diff fork/issue-3251-array-overlay-s1 fork/issue-3251-s2-write-enforcement`):

```
 src/codegen/object-runtime-descriptors.ts |  38 +-
 src/codegen/vec-overlay.ts                | 596 +++++++++++++++++++++++++++++-
 tests/issue-3251-s2.test.ts               | 119 ++++++
 tests/issue-3251-s3.test.ts               | 218 ++++++++++
 tests/issue-3251.test.ts                  |   4 +-
```

S4 adds a further +277 in `vec-overlay.ts` and `tests/issue-3251-s4.test.ts`.

### The catch: **these branches share NO ancestry with this container's `origin/main`**

```
$ git merge-base origin/main fork/issue-3251-s2-write-enforcement   # exit 1, no common ancestor
$ git rev-list --count origin/main                                   # 453
$ git rev-list --count fork/issue-3251-s2-write-enforcement          # 25702
```

This checkout's `loopdive/js2` history is a reconstruction, so **you cannot
merge or cherry-pick** — you must port the diff by hand as a patch.

How far the target file has drifted since S1:

- `vec-overlay.ts`: S1 = 1364 lines, current `origin/main` = 1748 lines, and
  `diff -u` between them is 924 lines. So a naive `git apply` of the 596-line S2
  patch will not land; expect to re-apply hunk by hunk against current
  structure. The 10 hunks are listed by `git diff … -- src/codegen/vec-overlay.ts`.
- `object-runtime-descriptors.ts`: **the S2 hunk here is already superseded.**
  S2 widened `Object.defineProperties`' Type(O) gate to accept a `$__vec_base`
  target. Current main does that differently and more thoroughly under **#4047**
  (see the long comment at `src/codegen/object-runtime-descriptors.ts:1301-1325`
  — "This used to be `ref.test $Object(O)` and refused everything else"). **Skip
  that hunk**; the vec arms (`vecOverlayArm`, lines 148-157, 402, 723, 2549) are
  already wired on main.

So the realistic shape of the work is: **port the S2+S3 `vec-overlay.ts` hunks
onto current main, drop the descriptors hunk, bring the three test files.** That
is a real port, not a rebase, but it is a port of *validated* logic — much
cheaper than re-deriving it.

---

## 2. Finding that will bite you: the local in-process runner is BLIND on half
## this lever unless you shim the runtime-eval provider

`tests/test262-runner.ts` (`runTest262File`, the authoritative in-process path)
**does not supply the `js2wasm:runtime-eval` provider namespace**.
`scripts/test262-worker.mjs` does (lines 102-107, 1849-1853); the in-process
runner has no mention of it at all (`grep -n "runtime-eval" tests/test262-runner.ts`
→ nothing).

Why it matters here specifically: **every test that `includes: [propertyHelper.js]`
links that namespace** in standalone mode. `test262/harness/propertyHelper.js:31`
reads the global `Function` value (`Function.prototype.call.bind(...)`), which
trips `sourceUsesRuntimeEvalBoundary` / `isGlobalFunctionValueReference`
(`src/codegen/index.ts:3196`, `:5951`) and makes the module a runtime-eval
consumer. `propertyHelper` is the dominant include on this lever.

Measured effect on my 162-file list:

| | pass | files dying at `Import #1 module="js2wasm:runtime-eval": module is not an object or func` |
| --- | ---: | ---: |
| unshimmed local run | 0 | **82 / 162 (51%)** |
| shimmed (CI-aligned) | 1 | 0 |

Unshimmed, the top signature was that instantiate error, not any of the
baseline's signatures — i.e. **the instrument was measuring its own gap and
would have reported +0 for a correct fix on half the lever.** This is a
different failure mode from the #4160 trap, and it is not visible from the
error text unless you know to look.

I did **not** fix `tests/test262-runner.ts` (out of lane, and it is also used by
`scripts/validate-test262-baseline.ts`). Worth filing separately — the local
runner and the worker have already been unified once for the exception renderer
(#3613) and this is the same class of drift.

---

## 3. The instrument (reuse it — it is CI-aligned and takes ~8 min per A/B)

Two files in the worktree's `.tmp/` (gitignored, so they are reproduced in full
below). Both are known-good.

Prerequisites, re-run **before every measurement** so the provider cache key
tracks the compiler you are measuring:

```bash
cd <worktree>
./node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
./node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
mkdir -p .test262-cache
NODE_OPTIONS="--max-old-space-size=3072" node scripts/build-runtime-eval-provider.mjs --refusal-only
```

(the refusal provider builds in ~3.5s; `--refusal-only` is the right tier for a
scoped diagnostic run.)

Run:

```bash
grep -v '^#' .tmp/L2-array-exotic-defineownproperty-15.4.5.1.txt | grep -v '^$' > .tmp/l2-list.txt
node .tmp/l2-run.mjs .tmp/l2-list.txt .tmp/l2-after.jsonl 3 8
```

3 workers × batch 8 → **~7m45s** for 162 files on this 4-core box. Batching is
safe: `runOriginalHarnessVariant` calls `restoreHostBuiltins()` on entry
(`tests/test262-runner.ts:4130`), so realm poisoning does not leak across files
in a batch.

**Instrument-responsiveness check (brief §3) is NOT yet done** — I never had a
change to A/B. Do it: revert one ported hunk, confirm the score moves back.

### `.tmp/l2-child.mts`

```ts
// L2 scoped test262 runner child: runs the given test files in standalone mode
// and prints one `L2RESULT <json>` line each. The parent restarts a child per
// batch.
//
// NOTE: tests/test262-runner.ts (the in-process runner) does NOT supply the
// `js2wasm:runtime-eval` provider namespace that scripts/test262-worker.mjs
// injects for the standalone lane. Every test that `includes:
// [propertyHelper.js]` links that namespace (propertyHelper reads the global
// `Function` value at line 31), so without the shim 82/162 of this lever's
// files die at instantiate with "module is not an object or func" instead of
// running. We monkey-patch WebAssembly.instantiate here to mirror the worker.
import { resolve } from "node:path";
// @ts-ignore — plain .mjs helper
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  instantiateRuntimeEvalNamespace,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";

let providerModule: WebAssembly.Module | null | undefined;
function getProvider(): WebAssembly.Module | null {
  if (providerModule !== undefined) return providerModule;
  providerModule = selectCachedRuntimeEvalProvider().module ?? null;
  return providerModule;
}

const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
(WebAssembly as any).instantiate = async (src: any, imports?: any) => {
  try {
    const mod = src instanceof WebAssembly.Module ? src : new WebAssembly.Module(src);
    const needs = WebAssembly.Module.imports(mod).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE);
    if (needs && imports && !imports[RUNTIME_EVAL_IMPORT_MODULE]) {
      const pm = getProvider();
      if (pm) imports[RUNTIME_EVAL_IMPORT_MODULE] = instantiateRuntimeEvalNamespace(pm);
    }
    const instance = await origInstantiate(mod as any, imports);
    return src instanceof WebAssembly.Module ? instance : { module: mod, instance };
  } catch {
    return origInstantiate(src, imports);
  }
};

const { runTest262File } = await import("../tests/test262-runner.js");

const root = process.env.TEST262_ROOT ?? resolve(process.cwd(), "test262");
for (const rel of process.argv.slice(2)) {
  const abs = resolve(root, "test", rel);
  const category = rel.split("/").slice(0, 2).join("/");
  try {
    const r = await runTest262File(abs, category, 30000, "standalone");
    console.log(
      "L2RESULT " + JSON.stringify({ file: rel, status: r.status, error: (r.error ?? "").slice(0, 220) }),
    );
  } catch (e: any) {
    console.log(
      "L2RESULT " +
        JSON.stringify({ file: rel, status: "harness_error", error: String(e?.message ?? e).slice(0, 220) }),
    );
  }
}
process.exit(0);
```

### `.tmp/l2-run.mjs`

```js
// L2 scoped test262 A/B harness.
//   node .tmp/l2-run.mjs <list.txt> <out.jsonl> [workers] [batch]
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , listPath, outPath, workersArg, batchArg] = process.argv;
const WORKERS = Number(workersArg ?? 3);
const BATCH = Number(batchArg ?? 8);

const files = readFileSync(listPath, "utf8")
  .split("\n").map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

const batches = [];
for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));

const results = new Map();
let next = 0, done = 0;

function runBatch(batch) {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", ".tmp/l2-child.mts", ...batch], {
      stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith("L2RESULT ")) { const r = JSON.parse(line.slice(9)); results.set(r.file, r); }
      }
    });
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      for (const f of batch) if (!results.has(f)) results.set(f, { file: f, status: "child_crash", error: "" });
      done += batch.length;
      process.stderr.write(`\r${done}/${files.length}   `);
      resolve();
    });
  });
}

async function worker() { while (next < batches.length) await runBatch(batches[next++]); }

await Promise.all(Array.from({ length: WORKERS }, worker));
process.stderr.write("\n");

const ordered = files.map((f) => results.get(f));
writeFileSync(outPath, ordered.map((r) => JSON.stringify(r)).join("\n") + "\n");
const counts = {};
for (const r of ordered) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(JSON.stringify(counts, null, 2));
console.log(`pass ${counts.pass ?? 0} / ${files.length}`);
```

---

## 4. Measured baseline (this is your "before")

Current `origin/main` @ `176e4408f`, `--target standalone`, 162-file lever list,
CI-aligned (shimmed) instrument. Raw per-file JSONL kept at
`/home/user/js2/.claude/worktrees/agent-a3165b91ced05c998/.tmp/l2-before.jsonl`.

**`pass 1 / 162`** — the single pass is
`built-ins/Object/defineProperties/15.2.3.7-6-a-271.js`; 2 are `compile_error`
(`15.2.3.7-6-a-163.js`, `15.2.3.6-4-257.js`, both *compilation timeout*, worth a
second look — they may be a separate hang, not a semantics gap); the other 159
are `fail`.

Signature clusters (normalised; `#` = digits elided):

```
  33  Expected a TypeError to be thrown but no exception was thrown at all
  20  Expected obj[#] to be writable, but was not.
  15  Expected obj[#] to equal #, actually null
  10  arr.length    Expected SameValue(«#», «#»)
  10  arrObj.length Expected SameValue(«#», «#»)
   7  length should be an own property
   6  Expected obj[property] to equal #, actually null
   6  arr[#] Expected SameValue(«#», «#»)
   6  Expected obj[property] to be writable, but was not.
   5  Expected true but got false
   3  arrObj.hasOwnProperty("#") !== true
   3  # descriptor value should be undefined; # value should be undefined
   3  RuntimeError: array element access out of bounds in __module_init()
   2  (e instanceof RangeError) expected true
   2  property descriptor should be enumerable
   2  TypeError: Cannot redefine property: configurable attribute of a non-configurable property
   2  Expected obj[length] to be writable, but was not.
   2  RuntimeError: illegal cast in __closure_#()
   2  RuntimeError: array element access out of bounds in __extern_get_idx()  (via __vec_dp_value)
   2  compile_error: compilation timeout
   2  [].length = # throws a RangeError — none thrown
   2  RuntimeError: float unrepresentable in integer range in __call_fn_method_#()
   … 16 further singletons
```

This matches the lever list's own header signatures closely, so the instrument
agrees with the 2026-08-06 baseline. (One difference: the baseline header shows
21 × "Expected obj[#] to be writable"; I measure 20 + 6 on the `obj[property]`
variant.)

### Cluster → slice mapping

| cluster | count | owned by |
| --- | ---: | --- |
| `Expected obj[#] to be writable, but was not` (+`obj[property]` variant) | **26** | **S2** — `verifyWritable` writes `obj[name]` and checks it stuck; the plain-write path does not go through the companion (setter never invoked / `writable:false` handling absent). This is exactly S1's documented boundary "plain writes do not yet honor `writable:false` / invoke setters". |
| `Expected obj[#] to equal #, actually null` (+`obj[property]`) | **21** | **S2** — read/companion staleness + accessor `get` not consulted on the path `verifyEqualTo` takes. |
| `arr.length` / `arrObj.length` SameValue, `length should be an own property`, `[].length = #` RangeError | **29** | **S3** — ArraySetLength §10.4.2.1 + `gOPD("length")`. S1 explicitly left `"length"` as a legacy no-op. |
| `Expected a TypeError to be thrown` | **33** | split S2/S3 — the length-shrink-stops-at-non-configurable subset is S3; the redefine-legality subset is S2. |
| `RuntimeError: … out of bounds in __extern_get_idx() via __vec_dp_value` | 2 | a real S1 bug surfaced by the overlay OOB grow path — worth a look, it is a trap not a wrong answer. |

The two dominant buckets (26 + 21 = 47) are **S2**, and 29 more are **S3**. So
the S2+S3 port is aimed squarely at ~76-109 of the 162 without touching anything
else. That is the "largest coherent slice"; do S2 first and measure before
adding S3.

---

## 5. What I would do next, in order

1. Fetch the three fork branches (§1). Read `fork/issue-3251-s2-write-enforcement`'s
   **branch copy of `plan/issues/3251-array-descriptor-overlay-substrate.md`**
   first — the on-main copy says the
   branch copies "carry fuller resume notes (S2/S3 validation detail, probe
   lists) than this on-main copy". I did not read them; do.
2. Port the S2 `vec-overlay.ts` hunks only (drop the `object-runtime-descriptors.ts`
   hunk, superseded by #4047). Bring `tests/issue-3251-s2.test.ts`.
3. Measure. Expect the two `writable`/`actually null` clusters (47) plus part of
   the TypeError cluster to move. **Verify instrument responsiveness** by
   reverting one hunk.
4. Then S3 (`tests/issue-3251-s3.test.ts`), measure again, ship as a second PR
   if S2 is already a coherent win — a merged +47 beats an unmerged +109.
5. Only then consider S4 (for-in) and the two compile-timeout files.

Adjacency to be careful about, unchanged from my brief: **#4159** (typed-lane
`array.get` bypasses the overlay accessor — in-bounds accessor define read
through a statically-typed local returns the stale element) and **#4160**
(prototype-chain index inheritance; `src/codegen/proto-index-store.ts` and the
`protoIndexDirty` / `vecAccessorDescriptorDirty` pre-scan flags in
`src/codegen/array-holes.ts` already exist on main — check them before writing
new dirty-flag machinery). Neither is in the way of S2/S3.

---

## 6. Dead ends / things not worth repeating

- **Do not try `git merge`, `git rebase` or `git cherry-pick` from the fork
  branches.** No common ancestor with this container's `origin/main` (§1). It is
  a manual patch port.
- **Do not port the S2 `object-runtime-descriptors.ts` hunk.** Superseded by
  #4047 on main; re-applying it would re-narrow a gate that was deliberately
  widened.
- **Do not trust an unshimmed local standalone run of anything that includes
  `propertyHelper.js`.** See §2 — it silently measures the runner's own
  runtime-eval gap.
- The heavyweight `pnpm run test:262` path (`scripts/run-test262-vitest.sh`) is
  the wrong tool for this A/B: it takes a global `flock`, so with four agents on
  the box it serialises, and it enumerates all 43k tests per shard even under
  `TEST262_PATH_FILTER`. The scoped harness in §3 is ~8 min and takes no lock.

## 7. Housekeeping

- Claim on #3251 **released** (`claim-issue.mjs --release`). Issue frontmatter on
  `main` was never modified — it is still `status: ready`, which is correct.
- Worktree `/home/user/js2/.claude/worktrees/agent-a3165b91ced05c998/` left in
  place deliberately: it holds `.tmp/l2-before.jsonl` (the measured baseline),
  the built `scripts/compiler-bundle.mjs` / `runtime-bundle.mjs`, and the
  prebuilt `.test262-cache/runtime-eval-refusal-*.wasm`. Remove it once the
  fable agent has what it needs.
