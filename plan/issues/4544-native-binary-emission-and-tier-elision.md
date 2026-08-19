---
id: 4544
title: "Native binary emission: size/startup baseline, and pay-for-what-you-use elision of the dynamic tier"
status: in-progress
sprint: current
created: 2026-08-17
updated: 2026-08-19
priority: high
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
# Part B (tier elision) depends on 4541; Part A (AOT an existing linear module
# and record size/startup) depends on NOTHING and is the evidence gate for
# ADR-0021. The blanket depends_on was wrong and would have parked the one
# measurement that should run first — corrected 2026-08-17.
depends_on: []
related: [2776, 4236, 4541]
# id 4544 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4544 — Native binaries, measured; and not paying for the tier you don't use

Slice 6 of #4538. Delivers the actual goal — a binary — and the property that
keeps the tier from taxing programs that never touch it.

## Sequencing — Part A is unblocked, Part B is not

**Part A is DONE (2026-08-19) — see [Part A — results](#part-a--results-measured-2026-08-19).**
AOT-compiling an existing linear-target module and recording size/startup
depended on no other slice, and it was the evidence gate for
[ADR-0021](../../docs/adr/0021-native-backend-targets-c.md). The numbers are
adequate, so the direct C backend stays deferred indefinitely — now on evidence
rather than on absence of it. Part B (tier elision) genuinely needs #4541 and
remains open; this issue stays open for it.

## Part A — native binary emission

The linked module is a standalone WASI module (five `wasi_snapshot_preview1`
imports, no JS host). Turning it into a native executable is an
ahead-of-time-compile step over output we already produce, not new lowering:
`wasmtime compile`, `wasm2c` + a C compiler, and WAMR AOT are the candidate
routes.

Pick one as the supported default by measuring, and record the others as
evaluated with their numbers. This route is deliberately chosen over writing a
native backend: it reuses fully-covered output and adds no second lowering path
to maintain. If binary size or startup later proves inadequate, that is the
evidence that would justify revisiting — and this slice's baseline is what makes
that argument possible.

## Part B — pay-for-what-you-use

The engine artifact is **measured** at 1,011,134 bytes raw / 350,017 gzipped at
`-O2` (`-Oz` gives 626,104 / 261,243, at a measured ~23% cost on both eval and
per-property time, which is why `-O2` is the default — the boxed tier is by
definition running code we could not compile).

That is a fixed cost, and it must be **conditional**. A program whose dynamic
residue is empty must link none of it and emit exactly what it emits today. Two
consequences worth designing for, not discovering:

- Whether a program has a residue is a **whole-program property**, so the
  decision belongs where the link is decided, not per function.
- Feature-subset builds of the artifact are already measured in #4236 (including
  a split regex module) — the elision decision should compose with those rather
  than being all-or-nothing.

## Acceptance criteria

- [ ] A native binary is produced from a linear-target program and runs, with
      the exact command recorded so it is reproducible.
- [ ] Size and startup are recorded as a **committed baseline artifact**, with
      the measurement command and container shape named — a number without its
      provenance is attribution, not measurement.
- [ ] A typed-only program links **none** of the engine and is byte-identical
      to today's output (emit-identity proof).
- [ ] A program with a residue links the tier automatically, with no flag
      required, and the size delta between the two is reported.
- [ ] The AOT route chosen is justified against at least one alternative with
      both sets of numbers.

## Validation

- Emit-identity proof for the typed-only path, against a base copy captured
  before the first edit.
- Startup measured as a distribution over repeated runs, not a single sample.
- The binary runs the differential fixture set with output matching Node.

## Part A — results (measured 2026-08-19)

**The AOT route is adequate, and the gate on ADR-0021 closes on size and
startup.** A real program compiles to a **22.9 KB self-contained native
executable** that starts **0.14–0.20 ms above bare process creation** — within
noise of a hand-written C binary doing the same arithmetic. Even the whole
QuickJS dynamic tier links into **one 1.60 MB binary that evaluates JavaScript
in 0.64 ms**. Nothing here is inadequate, so nothing here justifies building a
second lowering path.

Artifact: [`benchmarks/results/native-aot-baseline.json`](../../benchmarks/results/native-aot-baseline.json)
· generator: `scripts/benchmark-native-aot.mjs` · 201 rounds/lane ·
`generatedAt` 2026-08-19T04:01:36Z · 4-core x86_64 container, kernel 6.18.5,
clang 18.1.3, Node v22.22.2, other agents active.

```bash
pnpm run build:compiler-bundle
node scripts/benchmark-native-aot.mjs --runs 201
```

### The corpus, and why these programs

Six programs, all compiled `--target linear`. Four are the landing benchmark
corpus (`fib`, `fib-recursive`, `string-hash`, `object-ops` — the same source
bytes the competitive benchmarks consume), one is the emit-identity corpus
(`collections`, the only curated program that pulls in the linear backend's
Map/Set open-addressing runtime), and one is a purpose-written `noop` for
startup isolation. A hello-world alone would have flattered AOT on both axes.

**The backend choice is forced, not preferred.** `wasm2c` and WAMR have no
WasmGC support, so only the **linear** backend's output can feed all three
routes; the WasmGC `wasi` target is AOT-able by at most one of them. This
baseline is therefore inherently about the linear lane — which is where #4538
lives anyway.

All six link **zero imports** (verified in the artifact's per-program
`imports: []`), so none of them pays for the dynamic tier.

### Size — raw bytes / gzip -9

| program | `.wasm` (today) | wasmtime `.cwasm` | WAMR `.aot` | **wasm2c native** (stripped) |
| --- | --- | --- | --- | --- |
| noop | 4,986 / 1,942 | 35,288 / 12,812 | 15,828 / 6,048 | 22,944 / 7,486 |
| fib | 4,943 / 1,882 | 35,296 / 12,639 | 15,796 / 5,996 | 22,944 / 7,448 |
| fib-recursive | 4,948 / 1,884 | 35,360 / 12,754 | 16,036 / 6,067 | 22,944 / 7,502 |
| string-hash | 6,040 / 2,427 | 43,864 / 15,169 | 19,496 / 7,697 | 31,136 / 9,092 |
| object-ops | 5,190 / 2,073 | 35,496 / 13,331 | 16,512 / 6,342 | 27,040 / 7,957 |
| collections | 6,488 / 2,395 | 47,960 / 16,123 | 25,420 / 8,687 | 35,224 / 9,264 |

**The artifact column is the misleading one.** Two of the three routes produce a
module that still needs its engine at run time:

| must also ship | raw | gzip |
| --- | --- | --- |
| wasmtime 27.0.0 CLI | 42,240,592 | 12,137,059 |
| iwasm 2.2.0, **built AOT-only from source** | 305,776 | 117,950 |
| iwasm 2.2.0, prebuilt release | 52,153,728 | — |
| wasm2c native | **nothing** | — |

So the honest shipped size for one program (`fib`):

| route | shipped bytes | vs wasm2c |
| --- | --- | --- |
| **wasm2c native** | **22,944** | 1x |
| WAMR AOT + minimal iwasm | 321,572 | 14.0x |
| wasmtime AOT + wasmtime CLI | 42,275,888 | 1,843x |

Against the floor: a hand-written C `fib` at the same `clang -O2 -fwrapv` is
**14,528 bytes**, and an empty `int main(void){return 0;}` is **14,440**. So
wasm2c's whole cost — the translated module plus wabt's `wasm-rt` — is **8,504
bytes over an empty C binary**, and the finished thing is **1.58x** a
hand-written C program.

### Startup — ms above the process-exec floor

Every program is invoked at the argument where its loop body runs **zero
times**, so this times instantiation, not work. Lanes are interleaved in a
rotating order and each round also times an exec-floor binary; the figure is the
median of the **per-round paired differences** over 201 rounds. Filesystem cache
warm. Resolution is about ±0.5 ms, so anything under ~1 ms means
"indistinguishable from bare process creation".

| program | wasm-jit | wasmtime AOT | WAMR AOT | **wasm2c native** |
| --- | --- | --- | --- | --- |
| noop | 4.719 | 4.380 | 4.679 | **0.196** |
| fib | 4.805 | 4.532 | 4.766 | **0.142** |
| fib-recursive | 4.718 | 4.373 | 4.761 | **0.151** |
| string-hash | 5.023 | 4.681 | 4.932 | **0.204** |
| object-ops | 4.880 | 4.513 | 4.824 | **0.153** |
| collections | 4.968 | 4.510 | 4.899 | **0.179** |

Denominators, same units, same harness:

| lane | above floor |
| --- | --- |
| hand-written C `fib`, clang -O2 | 0.011 |
| wasm2c native `fib` (re-timed beside it) | 0.061 |
| Node instantiating the same `.wasm` | 42.63 |
| WAMR AOT under the **prebuilt** 52 MB iwasm | 12.245 |

Exec floor itself: 4.155 ms p50 — which includes roughly 1 ms of the harness's
own `spawnSync` cost (cross-checked against a Python `subprocess` timer). That
is exactly why the tables quote `aboveFloorMs` and not the absolute p50.

**Two findings that change what you would do:**

1. **AOT buys almost nothing for startup.** wasmtime JIT → wasmtime AOT is
   4.81 → 4.53 ms, about **6 %**. The ~4.5 ms is engine and CLI initialisation,
   not compilation — Cranelift compiling a 5 KB module was never the cost. So
   "AOT-compile the Wasm" is not, by itself, a startup answer. The win comes
   from **removing the engine**, which only the wasm2c route does: ~**30x** less
   startup than any engine-hosted lane.
2. **Which iwasm you build decides whether WAMR looks good or bad.** The
   prebuilt release is a 52 MB developer build (interpreter + AOT + JIT +
   debug); merely loading it costs 12.2 ms. Built AOT-only from source it is
   305 KB and 4.8 ms — 170x smaller and 2.5x faster on the *same* `.aot` file.
   Recording the prebuilt as "WAMR" would have libelled the route.

### The dynamic tier, measured separately and never blended

None of the corpus programs link QuickJS, so the tables above are what a normal
typed program pays. The engine, reproduced from
`scripts/quickjs-artifact/build.sh` at `-O2` (1,016,254 raw / 352,007 gzip —
matching #4236's recorded 1,011,134 / 350,017 to within toolchain drift):

| form | raw | gzip |
| --- | --- | --- |
| `libquickjs.wasm` | 1,016,254 | 352,007 |
| wasmtime `.cwasm` | 3,917,128 | 1,908,082 |
| WAMR `.aot` | 1,888,868 | 747,411 |
| **wasm2c native, self-contained, evaluates JS** | **1,595,952** | **703,681** |

That binary is the recommended route exercised on the hardest input the project
has. It links the entire engine plus a ~40-line implementation of the five
`wasi_snapshot_preview1` imports (`scripts/native-aot-corpus/qjs-driver.c` — no
uvwasi, no WASI SDK at run time), and it answers:

```
$ qjs-native '1+1'                            -> 2
$ qjs-native '[1,2,3].map(x=>x*7).join("-")'  -> 7-14-21
$ qjs-native 'JSON.stringify({a:1,b:[2,3]})'  -> {"a":1,"b":[2,3]}
```

Startup **0.644 ms above the exec floor**, including creating a QuickJS runtime
and context and evaluating `1+1` — still less than any engine-hosted lane needs
to instantiate a 5 KB module containing no engine at all.

So the with-tier / without-tier size delta is roughly **1.60 MB vs 22.9 KB**, a
70x step. That is the number that makes Part B's elision worth building; it is
not an argument against the AOT route, which handles both ends.

### Route evaluation

| route | verdict | evidence |
| --- | --- | --- |
| **wasm2c + C compiler** | **supported default** | smallest deliverable (22.9 KB, 1.58x the hand-written-C floor), startup at the process floor, no runtime to ship, and it survives the 1 MB engine |
| WAMR AOT (`wamrc` + minimal `iwasm`) | keep as the sandboxed alternative | 321 KB shipped, 4.8 ms. 14x the size and ~30x the startup, but you retain a real Wasm sandbox and a stable embedding API — the right pick when isolation matters more than bytes |
| wasmtime AOT (`wasmtime compile`) | not a shipping route | 42 MB shipped. Its AOT mode buys 0.38 ms over its own JIT. Excellent as a development/host runtime, which is what it already is here |

**One provisioning caveat that is load-bearing for the recommendation:** the
vendored `wasm2c` is `wabt.js` — wabt itself compiled to Wasm — and it runs out
of linear memory on large inputs. It trapped with `RuntimeError: memory access
out of bounds` on the QuickJS artifact after emitting a truncated 2 MB `.c`
file. A **natively built** wabt translates the same module fine (12.7 MB of C).
The npm build is adequate for corpus-sized programs and is kept as the
zero-install fallback, but anything engine-sized needs the native one. The
generator prefers a native build when present and records which one it used.

### What this means for ADR-0021 — the gate CLOSES

[ADR-0021](../../docs/adr/0021-native-backend-targets-c.md) fixes C as the
target *if* a direct native backend is ever built, and makes building one
conditional: *"If those numbers prove inadequate on size or startup, the
alternative is a direct native backend."*

**They are not inadequate.** On the condition the ADR actually names, this
measurement closes the gate:

- **Size** — 22.9 KB self-contained for a real program, 1.58x a hand-written C
  binary. A direct backend cannot beat that by enough to matter; the 8.5 KB of
  daylight between wasm2c and hand-written C is the entire prize.
- **Startup** — 0.14–0.20 ms above bare process creation, statistically
  indistinguishable from hand-written C at this harness's resolution. There is
  nothing left to win.

The ADR should stay **Accepted as a target choice** and its schedule should stay
deferred — now on evidence rather than on absence of it. Concretely: the honest
price the ADR names for the backend ("finishing `ir-full-coverage` first") does
not have to be paid, and #2855's sequencing is unaffected.

**One thing this does NOT settle, stated plainly.** ADR-0021 rejects Wasm→C on a
**throughput** argument — that `quickjs.c → Wasm → C → clang` destroys the
aliasing and control-flow structure the C optimiser needs, so the engine runs
measurably slower than compiling it directly. This slice measured size and
startup only, so that objection is **untested here and remains open**. Two
things bound it, though:

- It is an argument about the **engine**, and no typed program links the engine.
  For the corpus — the case a normal program is in — it does not arise.
- Where it does arise there is an obvious escape the ADR does not need a new
  backend for: **the engine is already C**, so a native build can link
  `libquickjs` compiled directly by clang and send only *our* generated code
  through wasm2c. That removes the intermediate Wasm from exactly the code the
  objection is about. That is a design note, not a measurement — it is the
  natural follow-up if throughput ever becomes the binding constraint.

Filing a throughput follow-up is the right next step **only if** something
actually demands it; on size and startup, the question is answered.

### What was not measured

- **Throughput.** Size and startup only. See above.
- **Non-linear-backend programs.** The linear backend compiles a typed subset,
  so this measures the subset that exists today. `array-sum` from the landing
  corpus does not compile under it (`Type 'number' is not assignable to type
  'never'`) and was excluded rather than quietly dropped.
- **Cross-platform.** One x86_64 Linux container. No macOS/ARM figures.
- **Cold filesystem cache.** Deliberately warm, and stated as such.

### One measurement bug worth recording

The first version of the harness closed over the wrong argument, so the two
wasmtime lanes were timed with the **correctness** argument while WAMR and
wasm2c were timed with the **startup** argument. Every program hid it except
`fib-recursive`, where arg 30 is 1.3M recursive calls — a stable, reproducible
+5.7 ms that read exactly like a real wasmtime weakness on recursion, and
survived two full 201-round runs looking like signal. It was caught only by
re-running one lane standalone and failing to reproduce it. The generator now
records each timed lane's exact `argv` in the artifact so the same class of
error is visible rather than lucky to find. Two related corrections in the same
pass: `/bin/true` is coreutils and does locale setup, which made two lanes come
out with impossible *negative* excess until it was replaced with a real empty
binary; and interleaving a 48 ms Node lane against 1 ms native lanes injected
the same distortion until the denominators were split by magnitude.

### Acceptance criteria — Part A

- [x] A native binary is produced from a linear-target program and runs, with
      the exact command recorded (`commands` in the artifact; per-lane `argv`
      per program).
- [x] Size and startup recorded as a committed baseline artifact with
      measurement command and container shape named.
- [x] The AOT route chosen is justified against alternatives with both sets of
      numbers — against **two**, plus a hand-written-C floor and an exec floor.
- [~] "A typed-only program links **none** of the engine": confirmed as far as
      today's code allows — all six corpus programs emit `imports: []` and
      4.9–6.5 KB, linking no engine. The *byte-identity* half of that criterion
      needs elision code to compare against and belongs to Part B.
- [ ] "A program with a residue links the tier automatically" — **Part B**,
      depends on #4541, out of scope for this slice.

## Non-goals

- A native (C or LLVM) code-generation backend. If the AOT route's numbers
  prove inadequate, that is a separate, evidence-backed proposal — the
  measurement this slice produces is its precondition.
- Component Model / WASI P3 packaging (#2776) — adjacent, separately tracked.
