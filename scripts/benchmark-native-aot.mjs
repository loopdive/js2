// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * scripts/benchmark-native-aot.mjs — #4544 Part A: the native-binary
 * size/startup baseline that gates ADR-0021.
 *
 * WHY THIS EXISTS
 * ---------------
 * ADR-0021 records that a *direct* native backend would emit C — but explicitly
 * "as a target choice, not a schedule". Whether that backend gets built at all
 * is gated on this measurement: if ahead-of-time-compiling the Wasm we ALREADY
 * emit is adequate on size and startup, the second lowering path stays deferred
 * indefinitely. A result showing AOT is adequate closes the gate, and that is a
 * useful outcome, not a disappointing one. So this script is deliberately
 * neutral: it measures every route the issue names and reports ratios with both
 * sides identified.
 *
 * WHAT IT MEASURES
 * ----------------
 * Four lanes over one corpus, all from the SAME emitted `.wasm`:
 *
 *   | lane            | artifact              | needs at run time        |
 *   | --------------- | --------------------- | ------------------------ |
 *   | `wasm-jit`      | `.wasm`               | wasmtime (compiles cold) |
 *   | `wasmtime-aot`  | `.cwasm`              | wasmtime                 |
 *   | `wamr-aot`      | `.aot`                | iwasm                    |
 *   | `wasm2c-native` | a native ELF          | nothing                  |
 *
 * `wasm-jit` is the BASELINE the other three are ratios against — it is the
 * standalone path we ship today. `wasm2c-native` is the only lane that yields a
 * self-contained executable; the other two AOT lanes produce a module that
 * still needs its runtime, which is why `shippedBytes` is reported next to
 * `artifactBytes` and is the honest size number for them.
 *
 * Two further denominators, because a ratio needs both sides named:
 *   - `c-native`: the same algorithm hand-written in C at -O2. The floor —
 *     what a native binary "should" cost when no Wasm was ever involved.
 *   - `node`: Node instantiating the same `.wasm`. Context for startup only.
 *
 * NOT FOOLING OURSELVES ABOUT STARTUP
 * -----------------------------------
 *   - Every program is invoked with the argument that makes its workload
 *     ~empty (`arg 0`: zero loop trips), plus a dedicated `noop` program. So
 *     these are instantiation timings, not workload timings.
 *   - Wall clock is measured around the whole PROCESS (exec -> exit), because
 *     that is what a CLI user actually waits for.
 *   - Reported as a DISTRIBUTION (min / p50 / p90 / max) over N runs, never a
 *     single sample, after a discarded warmup round. The filesystem cache is
 *     therefore WARM; that is stated in the artifact rather than left implied.
 *
 * TOOLCHAIN — none of this ships in the container. Exact provisioning:
 *
 *   # wasmtime 27.0.0 (Cranelift AOT)
 *   curl -sSL -o wasmtime.tar.xz \
 *     https://github.com/bytecodealliance/wasmtime/releases/download/v27.0.0/wasmtime-v27.0.0-x86_64-linux.tar.xz
 *   tar xf wasmtime.tar.xz   # -> wasmtime-v27.0.0-x86_64-linux/wasmtime
 *
 *   # WAMR 2.2.0 (wamrc compiler + iwasm runtime), prebuilt releases
 *   curl -sSL -o wamrc.tar.gz \
 *     https://github.com/bytecodealliance/wasm-micro-runtime/releases/download/WAMR-2.2.0/wamrc-2.2.0-x86_64-ubuntu-22.04.tar.gz
 *   curl -sSL -o iwasm.tar.gz \
 *     https://github.com/bytecodealliance/wasm-micro-runtime/releases/download/WAMR-2.2.0/iwasm-2.2.0-x86_64-ubuntu-22.04.tar.gz
 *
 *   # wasm2c ships in the repo already, via the `wabt` npm package:
 *   #   node_modules/.bin/wasm2c   (wabt 1.0.39)
 *   # its C runtime is NOT in that package and is fetched from the matching tag:
 *   curl -sSL --remote-name-all \
 *     https://raw.githubusercontent.com/WebAssembly/wabt/1.0.39/wasm2c/{wasm-rt.h,wasm-rt-impl.h,wasm-rt-impl.c,wasm-rt-mem-impl.c,wasm-rt-impl-tableops.inc,wasm-rt-mem-impl-helper.inc}
 *
 * USAGE
 *   pnpm run build:compiler-bundle
 *   node scripts/benchmark-native-aot.mjs [--runs N] [--out PATH]
 *
 * Tool locations are discovered on PATH and under `.tmp/toolchain/`; override
 * with WASMTIME / WAMRC / IWASM / WASM2C / CC. Every produced binary lands in
 * `.tmp/` — only the MEASUREMENTS are committed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "./compiler-bundle.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(REPO_ROOT, ".tmp", "native-aot");
const DEFAULT_OUT = join(REPO_ROOT, "benchmarks", "results", "native-aot-baseline.json");

// ---------------------------------------------------------------- corpus --

/**
 * Real programs, not a hello-world — a trivial program flatters AOT on both
 * axes. Four come from the landing benchmark corpus (the same source bytes the
 * competitive benchmarks consume) and one from the emit-identity corpus, which
 * is the only curated program that pulls in the linear backend's Map/Set
 * open-addressing runtime.
 *
 * `arg` is the startup-isolation argument: the value at which the program's
 * loop body executes zero times, so a wall-clock run is dominated by process
 * exec + instantiation. `checkArg`/`expect` are the correctness check that the
 * native binary really ran the program.
 */
const CORPUS = [
  {
    id: "noop",
    label: "Empty (startup isolation)",
    source: "scripts/native-aot-corpus/noop.ts",
    arity: 1,
    arg: 0,
    checkArg: 7,
    expect: 7,
  },
  {
    id: "fib",
    label: "Fibonacci loop",
    source: "website/public/benchmarks/competitive/programs/fib.js",
    arity: 1,
    arg: 0,
    checkArg: 30,
    expect: 832040,
  },
  {
    id: "fib-recursive",
    label: "Fibonacci recursion",
    source: "website/public/benchmarks/competitive/programs/fib-recursive.js",
    arity: 1,
    arg: 0,
    checkArg: 30,
    expect: 832040,
  },
  {
    id: "string-hash",
    label: "String build + hash",
    source: "website/public/benchmarks/competitive/programs/string-hash.js",
    arity: 1,
    arg: 0,
    checkArg: 100,
    expect: null, // filled from the wasm-jit lane, then required to agree
  },
  {
    id: "object-ops",
    label: "Object property ops",
    source: "website/public/benchmarks/competitive/programs/object-ops.js",
    arity: 1,
    arg: 0,
    checkArg: 100,
    expect: null,
  },
  {
    id: "collections",
    label: "Map/Set hash-table runtime",
    source: "scripts/emit-identity-corpus/collections.ts",
    arity: 0,
    arg: null,
    checkArg: null,
    expect: 232,
  },
];

// ------------------------------------------------------------ tool lookup --

function findTool(envVar, candidates) {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  for (const c of candidates) {
    const p = c.startsWith("/") ? c : join(REPO_ROOT, c);
    if (existsSync(p)) return p;
  }
  const which = spawnSync("sh", ["-c", `command -v ${envVar.toLowerCase()}`], {
    encoding: "utf-8",
  });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

const TOOLS = {
  wasmtime: findTool("WASMTIME", [".tmp/toolchain/wasmtime-v27.0.0-x86_64-linux/wasmtime"]),
  wamrc: findTool("WAMRC", [".tmp/toolchain/wamr/wamrc"]),
  // The MINIMAL, AOT-only iwasm built from WAMR source — not the prebuilt
  // release. This is not a detail: the release `iwasm` is a 52 MB
  // developer build (interpreter + AOT + JIT + debug) and merely loading it
  // costs ~7 ms, which would have been recorded as WAMR's startup and
  // misrepresented the route by ~170x on size and ~2.4x on time. The minimal
  // build is what an embedder would actually ship. Built with:
  //   cmake -S wasm-micro-runtime/product-mini/platforms/linux -B build \
  //     -DWAMR_BUILD_AOT=1 -DWAMR_BUILD_INTERP=0 -DWAMR_BUILD_JIT=0 \
  //     -DWAMR_BUILD_FAST_JIT=0 -DWAMR_BUILD_LIBC_WASI=1 \
  //     -DWAMR_BUILD_LIBC_BUILTIN=1 -DWAMR_BUILD_SIMD=0 -DCMAKE_BUILD_TYPE=Release
  //   cmake --build build -j"$(nproc)"
  iwasm: findTool("IWASM", [".tmp/toolchain/wamr-min/iwasm", ".tmp/toolchain/iwasm/iwasm"]),
  // Kept only so the size table can name what the convenient prebuilt costs.
  iwasmRelease: findTool("IWASM_RELEASE", [".tmp/toolchain/iwasm/iwasm"]),
  // Prefer a NATIVE wabt build over the vendored npm one. The `wabt` npm
  // package is wabt.js — wabt itself compiled to Wasm — and it runs out of
  // linear memory on large inputs: it traps with `RuntimeError: memory access
  // out of bounds` on the 1 MB QuickJS artifact after emitting a truncated
  // 2 MB .c file. The native build translates the same module fine (12.7 MB of
  // C). The npm build is adequate for the corpus programs and is kept as the
  // zero-install fallback, but anything engine-sized needs the native one:
  //   git clone --depth 1 -b 1.0.39 --recursive https://github.com/WebAssembly/wabt.git
  //   cmake -S wabt -B wabt-build -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF
  //   cmake --build wabt-build -j"$(nproc)" --target wasm2c
  wasm2c: findTool("WASM2C", [".tmp/toolchain/wabt-build/wasm2c", "node_modules/.bin/wasm2c"]),
  cc: process.env.CC || "clang",
  wasmRt: join(REPO_ROOT, ".tmp", "toolchain", "wasm-rt"),
};

function toolVersion(bin, args = ["--version"]) {
  if (!bin) return null;
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] || null;
}

// ------------------------------------------------------------- measurement --

function sizes(path) {
  const buf = readFileSync(path);
  return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
}

const EXEC_FLOOR_LANE = "__exec-floor";

/**
 * Time several lanes INTERLEAVED, plus an exec-floor lane, and report both the
 * raw distribution and a PAIRED excess over the floor.
 *
 * Three things this shape is deliberately buying:
 *
 * 1. **Interleaving.** Running 30 samples of lane A then 30 of lane B lets
 *    container load drift between the blocks and land entirely on one lane. One
 *    round = one sample of every lane, in a fixed order, so a load spike is
 *    charged to all lanes at once. (Measured while building this: `/bin/true`
 *    read 3.9 ms during a busy pass and 2.3 ms during a quiet one — a 1.6 ms
 *    swing, which is larger than the difference this whole issue is about.)
 *
 * 2. **A paired floor, in a rotating order.** Every round also times
 *    `/bin/true`. The reported `aboveFloorMs` is the median of the PER-ROUND
 *    differences, so the constant cost of process creation — and of this
 *    harness's own spawn overhead — cancels instead of being subtracted from
 *    two separately-drifting medians. The lane order rotates each round so no
 *    lane is systematically first (see the comment on `order` below).
 *
 *    RESOLUTION: residual position/scheduling effects are worth roughly
 *    ±0.5 ms on this container. An `aboveFloorMs` under about 1 ms means
 *    "indistinguishable from bare process creation", not "exactly this much".
 *
 * 3. **Reporting the harness's own cost.** Node's `spawnSync` is not free:
 *    cross-checked against a Python `subprocess` timer on the same binaries,
 *    it adds roughly 1 ms per spawn. That inflates every ABSOLUTE number here
 *    by a constant. It is recorded rather than hidden, and it is exactly what
 *    `aboveFloorMs` removes — which is why `aboveFloorMs`, not `p50Ms`, is the
 *    number to quote.
 */
/** Path to the compiled exec-floor binary; set once by `main`. */
let EXEC_FLOOR_BIN = "/bin/true";

function timeLanes(lanes, runs) {
  const names = Object.keys(lanes);
  const samples = Object.fromEntries([...names, EXEC_FLOOR_LANE].map((n) => [n, []]));
  const stdouts = {};
  const errors = {};

  const once = (bin, args) => {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(bin, args, { encoding: "utf-8" });
    const t1 = process.hrtime.bigint();
    return { ms: Number(t1 - t0) / 1e6, r };
  };

  // The floor is just another lane in the rotation, not a privileged first
  // measurement. Keeping it permanently first gave it a systematic ordering
  // penalty: in a block whose other lanes included a ~48 ms Node start, the
  // floor read ~0.8 ms HIGH and two lanes came out with NEGATIVE excess — an
  // impossible result that is a giveaway for exactly this bias. Rotating the
  // start index each round spreads any position effect evenly across lanes.
  const order = [EXEC_FLOOR_LANE, ...names];
  const binOf = (n) => (n === EXEC_FLOOR_LANE ? EXEC_FLOOR_BIN : lanes[n].bin);
  const argsOf = (n) => (n === EXEC_FLOOR_LANE ? [] : lanes[n].args);

  // Warmup round, discarded: the filesystem cache is WARM for every timed run.
  for (const n of order) once(binOf(n), argsOf(n));

  for (let i = 0; i < runs; i++) {
    for (let j = 0; j < order.length; j++) {
      const n = order[(i + j) % order.length];
      const { ms, r } = once(binOf(n), argsOf(n));
      if (n !== EXEC_FLOOR_LANE) {
        if (r.status !== 0) errors[n] = `exit ${r.status}: ${(r.stderr ?? "").slice(0, 200)}`;
        stdouts[n] = (r.stdout ?? "").trim().split("\n").pop() ?? "";
      }
      samples[n].push(ms);
    }
  }

  const stats = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { minMs: round3(s[0]), p50Ms: round3(q(0.5)), p90Ms: round3(q(0.9)), maxMs: round3(s[s.length - 1]) };
  };
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const out = { runs, execFloor: stats(samples[EXEC_FLOOR_LANE]) };
  for (const n of names) {
    const paired = samples[n].map((v, i) => v - samples[EXEC_FLOOR_LANE][i]);
    out[n] = {
      // The EXACT argv that was timed. Recorded because the acceptance criteria
      // ask for reproducibility, and because the one real bug found while
      // building this harness was a lane being timed with the wrong argument —
      // invisible in a summary, obvious the moment the argv is written down.
      argv: relArgv([lanes[n].bin, ...lanes[n].args]),
      ...stats(samples[n]),
      // The headline: cost above bare process creation, paired per round.
      aboveFloorMs: round3(median(paired)),
      stdout: stdouts[n],
      ...(errors[n] ? { error: errors[n] } : {}),
    };
  }
  return out;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Strip the absolute repo/worktree prefix out of anything that goes into the
 * committed artifact. Without this every path is `/home/<user>/.../worktrees/
 * agent-<hash>/...`, which is noise in a file meant to be read and diffed on
 * another machine.
 */
const relPath = (s) => String(s).split(`${REPO_ROOT}/`).join("");
const relArgv = (argv) => argv.map(relPath);

// ----------------------------------------------------------------- build --

function sh(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status}):\n${r.stderr ?? r.stdout}`);
  }
  return r;
}

async function main() {
  const argv = process.argv.slice(2);
  const runs = Number(argv[argv.indexOf("--runs") + 1]) || 30;
  const outPath = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : DEFAULT_OUT;

  // `iwasmRelease` is optional — it only enriches the size table.
  for (const k of ["wasmtime", "wamrc", "iwasm", "wasm2c", "cc"]) {
    if (TOOLS[k] === null) {
      console.error(`missing tool: ${k}. See the provisioning commands in this script's header.`);
      process.exit(1);
    }
  }
  if (!existsSync(join(TOOLS.wasmRt, "wasm-rt-impl.c"))) {
    console.error(`missing wasm2c runtime sources under ${TOOLS.wasmRt} — see header.`);
    process.exit(1);
  }

  rmSync(WORK, { recursive: true, force: true });
  for (const d of ["wasm", "cwasm", "aot", "c", "bin"]) {
    mkdirSync(join(WORK, d), { recursive: true });
  }

  // Built before any timing: every lane is paired against it.
  EXEC_FLOOR_BIN = join(WORK, "bin", "exec-floor");
  sh(
    TOOLS.cc,
    ["-O2", "-o", EXEC_FLOOR_BIN, join(REPO_ROOT, "scripts", "native-aot-corpus", "exec-floor.c")],
    "cc (exec floor)",
  );
  spawnSync("strip", [EXEC_FLOOR_BIN]);

  const programs = [];

  for (const p of CORPUS) {
    process.stdout.write(`\n=== ${p.id}\n`);

    // 1. Emit the linear-backend module. The linear backend is the ONLY one
    //    all three AOT routes can consume: wasm2c and WAMR have no WasmGC, so
    //    `--target wasi` (WasmGC + WASI) is not AOT-able by two of the three.
    const src = readFileSync(join(REPO_ROOT, p.source), "utf-8");
    const res = await compile(src, { target: "linear" });
    if (!res.success || !res.binary) {
      throw new Error(`${p.id}: compile failed: ${res.errors?.[0]?.message}`);
    }
    const wasmPath = join(WORK, "wasm", `${p.id}.wasm`);
    writeFileSync(wasmPath, res.binary);

    const mod = await WebAssembly.compile(res.binary);
    const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);

    const runArgs = p.arity === 0 ? [] : [String(p.arg)];
    const checkArgs = p.arity === 0 ? [] : [String(p.checkArg)];

    // 2. wasmtime AOT
    const cwasmPath = join(WORK, "cwasm", `${p.id}.cwasm`);
    sh(TOOLS.wasmtime, ["compile", wasmPath, "-o", cwasmPath], "wasmtime compile");

    // 3. WAMR AOT
    const aotPath = join(WORK, "aot", `${p.id}.aot`);
    sh(TOOLS.wamrc, ["-o", aotPath, wasmPath], "wamrc");

    // 4. wasm2c -> native ELF
    const cDir = join(WORK, "c");
    // Alphanumeric only. wasm2c escapes every non-alphanumeric character in the
    // module name when it builds C symbols — `-` becomes `0x2D` and even `_`
    // becomes `__` — so any separator here desynchronises the driver's macros
    // from the generated header.
    const modName = p.id.replace(/[^a-z0-9]/gi, "");
    const cPath = join(cDir, `${modName}.c`);
    // `-n` is required, not cosmetic: without it wasm2c derives the C symbol
    // prefix from the embedded module name and hex-escapes anything not
    // C-identifier-safe (`fib-recursive` -> `w2c_fib0x2Drecursive_run`), which
    // no fixed driver template can name.
    sh(TOOLS.wasm2c, [wasmPath, "-n", modName, "-o", cPath], "wasm2c");
    const binPath = join(WORK, "bin", `${p.id}`);
    // -fwrapv: ADR-0021 names signed-overflow wrap as a semantic requirement of
    // any C target. wasm2c already emits wrapping idioms, but pinning it here
    // makes the build match the ADR's stated constraint rather than rely on it.
    sh(
      TOOLS.cc,
      [
        "-O2",
        "-fwrapv",
        "-o",
        binPath,
        `-I${TOOLS.wasmRt}`,
        `-I${cDir}`,
        `-DMOD_NAME=${modName}`,
        `-DMOD_HEADER="${modName}.h"`,
        ...(p.arity === 0 ? ["-DARITY0"] : []),
        join(REPO_ROOT, "scripts", "native-aot-corpus", "driver.c"),
        cPath,
        join(TOOLS.wasmRt, "wasm-rt-impl.c"),
        join(TOOLS.wasmRt, "wasm-rt-mem-impl.c"),
        "-lm",
      ],
      "cc (wasm2c native)",
    );
    const strippedPath = `${binPath}-stripped`;
    sh("cp", [binPath, strippedPath], "cp");
    spawnSync("strip", [strippedPath]);

    // ---- correctness: every lane must agree, on a REAL argument ----
    // `progArgs` is a REQUIRED parameter, not a closed-over default. It was
    // originally closed over `checkArgs`, which silently timed the two wasmtime
    // lanes with the correctness argument while WAMR and wasm2c were timed with
    // the startup argument. Every program hid it except `fib-recursive`, where
    // arg 30 is 1.3M recursive calls — a reproducible +5.7 ms that looked
    // exactly like a real wasmtime weakness on recursion. Timing the WORKLOAD
    // when you meant to time STARTUP is the trap this whole measurement is
    // supposed to avoid; keep the argument explicit at every call site.
    const wasmtimeInvoke = (art, extra, progArgs) => ["run", ...extra, "--invoke", "run", art, ...progArgs];
    const outputs = {
      "wasm-jit": sh(TOOLS.wasmtime, wasmtimeInvoke(wasmPath, [], checkArgs), "check jit").stdout.trim(),
      "wasmtime-aot": sh(
        TOOLS.wasmtime,
        wasmtimeInvoke(cwasmPath, ["--allow-precompiled"], checkArgs),
        "check cwasm",
      ).stdout.trim(),
      "wamr-aot": sh(TOOLS.iwasm, ["-f", "run", aotPath, ...checkArgs], "check aot")
        .stdout.trim()
        .replace(/:f64$/, ""),
      "wasm2c-native": sh(binPath, checkArgs, "check native").stdout.trim(),
    };
    // Node is the oracle — the acceptance criteria ask for output matching Node,
    // not merely for the four Wasm lanes agreeing with each other.
    outputs.node = sh(
      process.execPath,
      [join(REPO_ROOT, "scripts", "native-aot-corpus", "node-runner.mjs"), wasmPath, ...checkArgs],
      "check node",
    ).stdout.trim();

    // iwasm's `-f` printer emits 6 significant digits (`3.67299e+07`), so an
    // exact string compare would flag a PRINTER artifact as a computation
    // difference. Comparing at the weakest printer's precision is the honest
    // resolution of the measurement, and it is recorded as such rather than
    // silently widened.
    const sig6 = (v) => Number(Number(v).toPrecision(6));
    const distinct = [...new Set(Object.values(outputs).map(sig6))];
    if (distinct.length !== 1) {
      throw new Error(`${p.id}: lanes disagree: ${JSON.stringify(outputs)}`);
    }
    if (p.expect !== null && sig6(p.expect) !== distinct[0]) {
      throw new Error(`${p.id}: expected ${p.expect}, lanes produced ${distinct[0]}`);
    }

    // ---- startup: workload ~empty, interleaved, paired against the exec floor ----
    const startup = timeLanes(
      {
        "wasm-jit": { bin: TOOLS.wasmtime, args: wasmtimeInvoke(wasmPath, [], runArgs) },
        "wasmtime-aot": {
          bin: TOOLS.wasmtime,
          args: wasmtimeInvoke(cwasmPath, ["--allow-precompiled"], runArgs),
        },
        "wamr-aot": { bin: TOOLS.iwasm, args: ["-f", "run", aotPath, ...runArgs] },
        "wasm2c-native": { bin: binPath, args: runArgs },
      },
      runs,
    );

    programs.push({
      id: p.id,
      label: p.label,
      source: p.source,
      value: distinct[0],
      checkArg: p.checkArg,
      // Kept verbatim, including iwasm's lossy printer, so the agreement claim
      // above can be re-checked from the artifact rather than trusted.
      outputs,
      imports,
      size: {
        "wasm-jit": sizes(wasmPath),
        "wasmtime-aot": sizes(cwasmPath),
        "wamr-aot": sizes(aotPath),
        "wasm2c-native": sizes(binPath),
        "wasm2c-native-stripped": sizes(strippedPath),
        generatedCBytes: statSync(cPath).size,
      },
      startup,
    });
    console.log(
      `  wasm ${sizes(wasmPath).raw}B  cwasm ${sizes(cwasmPath).raw}B  aot ${sizes(aotPath).raw}B  native ${sizes(strippedPath).raw}B(stripped)`,
    );
    console.log(
      `  startup above exec floor: jit ${startup["wasm-jit"].aboveFloorMs}ms  wasmtime-aot ${startup["wasmtime-aot"].aboveFloorMs}ms  wamr-aot ${startup["wamr-aot"].aboveFloorMs}ms  native ${startup["wasm2c-native"].aboveFloorMs}ms`,
    );
  }

  // ------------------------------------------------- denominators --------
  // A ratio needs both sides named. `c-native` is the floor: the same loop in
  // C, compiled by the same clang, never having been Wasm.
  process.stdout.write("\n=== denominators\n");
  const cFloorSrc = join(REPO_ROOT, "scripts", "native-aot-corpus", "fib-floor.c");
  const cFloorBin = join(WORK, "bin", "fib-c-floor");
  sh(TOOLS.cc, ["-O2", "-fwrapv", "-o", cFloorBin, cFloorSrc], "cc (c floor)");
  spawnSync("strip", [cFloorBin]);
  const cFloorCheck = sh(cFloorBin, ["30"], "c floor check").stdout.trim();
  if (Number(cFloorCheck) !== 832040) {
    throw new Error(`c floor produced ${cFloorCheck}, expected 832040`);
  }
  // TWO blocks, not one. Interleaving only cancels drift between lanes of
  // COMPARABLE cost: putting Node's ~48 ms start in the same rounds as two
  // ~1 ms native binaries let the expensive lane disturb whichever lane
  // followed it, and the paired medians came out NEGATIVE for the two
  // floor-speed lanes. Grouping by magnitude fixes it. (The per-program blocks
  // above are already homogeneous — every lane there is 4–10 ms.)
  const denomFast = timeLanes(
    {
      "c-native": { bin: cFloorBin, args: ["0"] },
      "wasm2c-native-fib": { bin: join(WORK, "bin", "fib"), args: ["0"] },
    },
    runs,
  );
  const denomSlow = timeLanes(
    {
      node: {
        bin: process.execPath,
        args: [join(REPO_ROOT, "scripts", "native-aot-corpus", "node-runner.mjs"), join(WORK, "wasm", "fib.wasm"), "0"],
      },
      ...(TOOLS.iwasmRelease && TOOLS.iwasmRelease !== TOOLS.iwasm
        ? {
            "wamr-aot-release-iwasm": {
              bin: TOOLS.iwasmRelease,
              args: ["-f", "run", join(WORK, "aot", "fib.aot"), "0"],
            },
          }
        : {}),
    },
    runs,
  );
  const denomStartup = { ...denomFast, ...denomSlow, execFloor: denomFast.execFloor };

  const cFloor = {
    note: "fib(n) hand-written in C, same clang -O2 -fwrapv, stripped. The floor: what a native binary costs in size and startup when no Wasm was ever involved. `wasm2c-native-fib` is re-timed alongside it so the two are directly comparable.",
    size: sizes(cFloorBin),
    startup: denomStartup["c-native"],
    wasm2cNativeSameRound: denomStartup["wasm2c-native-fib"],
  };

  const execFloor = {
    note: "scripts/native-aot-corpus/exec-floor.c — `int main(void){return 0;}`, same clang, stripped. The process exec + dynamic-loader + libc-start floor that EVERY lane pays, plus this harness's own ~1 ms spawnSync overhead. No process-based route can start faster. It is what `aboveFloorMs` subtracts. NOT /bin/true: coreutils does locale setup worth ~0.5 ms, which showed up as impossible negative excesses on the floor-speed lanes.",
    binary: sizes(EXEC_FLOOR_BIN),
    startup: denomStartup.execFloor,
  };

  const nodeFloor = {
    note: "node instantiating the same fib .wasm. Context for startup only; Node's own boot dominates and nobody would ship this as a native binary.",
    startup: denomStartup.node,
  };

  const wamrReleaseLane = denomStartup["wamr-aot-release-iwasm"] ?? null;

  // What you actually SHIP for the two lanes that keep a runtime.
  const runtimeSizes = {
    wasmtime: {
      path: relPath(TOOLS.wasmtime),
      ...sizes(TOOLS.wasmtime),
      note: "wasmtime 27.0.0 official release CLI. Required at run time by the wasm-jit and wasmtime-aot lanes.",
    },
    iwasm: {
      path: relPath(TOOLS.iwasm),
      ...sizes(TOOLS.iwasm),
      note: "iwasm 2.2.0 built AOT-ONLY from source (interpreter/JIT/SIMD off) — what an embedder would actually ship. Required at run time by the wamr-aot lane.",
    },
    iwasmRelease:
      TOOLS.iwasmRelease && TOOLS.iwasmRelease !== TOOLS.iwasm
        ? {
            path: relPath(TOOLS.iwasmRelease),
            ...sizes(TOOLS.iwasmRelease),
            startup: wamrReleaseLane,
            note: "The PREBUILT iwasm 2.2.0 release, for contrast only. A full developer build (interpreter + AOT + JIT + debug). Recorded because reaching for the convenient prebuilt is the obvious mistake here and it misstates WAMR badly on both axes — compare its bytes and its aboveFloorMs against the minimal build above.",
          }
        : null,
    "wasm2c-native": {
      path: null,
      raw: 0,
      gzip: 0,
      note: "Nothing. The wasm2c lane's binary IS the whole deliverable — wabt's wasm-rt is statically linked into it and is already counted in each program's wasm2c-native size.",
    },
  };

  // The dynamic tier, measured separately and NEVER blended into the numbers
  // above: none of the corpus programs link it (they are typed, eval-free).
  const qjs = join(REPO_ROOT, ".tmp", "quickjs-artifact", "libquickjs.wasm");
  let dynamicTier = null;
  if (existsSync(qjs)) {
    const cw = join(WORK, "cwasm", "libquickjs.cwasm");
    const ao = join(WORK, "aot", "libquickjs.aot");
    sh(TOOLS.wasmtime, ["compile", qjs, "-o", cw], "wasmtime compile quickjs");
    sh(TOOLS.wamrc, ["-o", ao, qjs], "wamrc quickjs");
    dynamicTier = {
      note: "The QuickJS boxed-tier artifact (#4236), built by scripts/quickjs-artifact/build.sh at -O2. Reported SEPARATELY and never blended with the corpus: no corpus program links it (all are typed and eval-free). This is what a program WITH a dynamic residue would additionally pay.",
      source: ".tmp/quickjs-artifact/libquickjs.wasm",
      buildInfo: JSON.parse(readFileSync(join(REPO_ROOT, ".tmp", "quickjs-artifact", "build-info.json"), "utf-8")),
      size: {
        "wasm-jit": sizes(qjs),
        "wasmtime-aot": sizes(cw),
        "wamr-aot": sizes(ao),
      },
    };

    // The recommended route, exercised on the hardest input the project has.
    // A recommendation that only survives 5 KB corpus programs would be worth
    // very little: this links the WHOLE engine into one native executable and
    // evaluates JavaScript in it. Needs a native wasm2c (see the TOOLS note).
    const qjsC = join(WORK, "c", "qjs.c");
    const w2c = spawnSync(TOOLS.wasm2c, [qjs, "-n", "qjs", "-o", qjsC], { encoding: "utf-8" });
    if (w2c.status !== 0) {
      dynamicTier.wasm2cNative = {
        status: "FAILED",
        detail: `${TOOLS.wasm2c} could not translate the engine: ${(w2c.stderr ?? "").split("\n")[0].slice(0, 200)}`,
        note: "Recorded as a failure rather than dropped. If this is the npm `wabt` build, it is the known heap limit — build wabt natively.",
      };
    } else {
      const qjsBin = join(WORK, "bin", "qjs-native");
      sh(
        TOOLS.cc,
        [
          "-O2",
          "-fwrapv",
          "-o",
          qjsBin,
          `-I${TOOLS.wasmRt}`,
          `-I${join(WORK, "c")}`,
          join(REPO_ROOT, "scripts", "native-aot-corpus", "qjs-driver.c"),
          qjsC,
          join(TOOLS.wasmRt, "wasm-rt-impl.c"),
          join(TOOLS.wasmRt, "wasm-rt-mem-impl.c"),
          "-lm",
        ],
        "cc (quickjs native)",
      );
      spawnSync("strip", [qjsBin]);
      // Correctness first: it must actually evaluate JavaScript, not merely link.
      const evalChecks = [
        ["1+1", "2"],
        ['[1,2,3].map(x=>x*7).join("-")', "7-14-21"],
        ["JSON.stringify({a:1,b:[2,3]})", '{"a":1,"b":[2,3]}'],
      ];
      const evalResults = evalChecks.map(([src, want]) => {
        const got = sh(qjsBin, [src], "quickjs native eval").stdout.trim();
        if (got !== want) throw new Error(`quickjs native: ${src} -> ${got}, expected ${want}`);
        return { src, got };
      });
      const qjsStartup = timeLanes({ "quickjs-native": { bin: qjsBin, args: ["1+1"] } }, runs);
      dynamicTier.wasm2cNative = {
        status: "ok",
        note: "The whole engine linked into ONE self-contained native executable via the recommended route, evaluating real JavaScript. Nothing else ships alongside it. Startup includes instantiating a QuickJS runtime + context and evaluating `1+1`. The five wasi_snapshot_preview1 imports are implemented in scripts/native-aot-corpus/qjs-driver.c — about forty lines, no uvwasi, no WASI SDK at run time.",
        generatedCBytes: statSync(qjsC).size,
        size: sizes(qjsBin),
        evalResults,
        startup: qjsStartup["quickjs-native"],
        execFloor: qjsStartup.execFloor,
      };
    }
  }

  const artifact = {
    issue: 4544,
    part: "A",
    title: "Native binary emission: size/startup baseline",
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/benchmark-native-aot.mjs",
    gates: "docs/adr/0021-native-backend-targets-c.md",
    container: {
      arch: process.arch,
      platform: process.platform,
      cpus: (() => {
        try {
          return execFileSync("nproc", { encoding: "utf-8" }).trim();
        } catch {
          return null;
        }
      })(),
      kernel: execFileSync("uname", ["-r"], { encoding: "utf-8" }).trim(),
      node: process.version,
      note: "Shared 4-core container; startup numbers carry scheduler noise, which is why the distribution is reported rather than a single sample.",
    },
    methodology: {
      backend:
        "--target linear (linear memory). The linear backend is the only one all three AOT routes can consume: wasm2c and WAMR have no WasmGC support, so the WasmGC `wasi` target is AOT-able by at most one of the three.",
      startup:
        "Whole-process wall clock (exec to exit), argument chosen so the program's loop body runs ZERO times, one discarded warmup then N timed rounds, filesystem cache WARM. Lanes are interleaved in a rotating order within each round, and each round also times an exec-floor binary; QUOTE `aboveFloorMs` (median of per-round differences), not `p50Ms` — the absolute figures include ~1 ms of this harness's own spawnSync cost. Resolution is about +/-0.5 ms, so an aboveFloorMs under ~1 ms means indistinguishable from bare process creation.",
      size: "Raw and gzip -9. The honest size for a lane is artifact + whatever must ship with it: see denominators.runtimeSizes. wasm2c-native ships nothing else, so its binary IS its shipped size.",
      correctness:
        "Every lane is re-run on a REAL argument and all four lane outputs must agree with each other AND with Node before any timing is recorded. Agreement is checked at 6 significant digits because iwasm's `-f` printer is lossy; raw per-lane outputs are kept in each program's `outputs`.",
      dynamicTier:
        "Measured separately. No corpus program links QuickJS (all are typed and eval-free), so the corpus numbers are what a normal program pays.",
    },
    toolchain: {
      wasmtime: toolVersion(TOOLS.wasmtime),
      wamrc: toolVersion(TOOLS.wamrc),
      iwasm: toolVersion(TOOLS.iwasm, ["--version"]),
      // Path as well as version: the npm and native builds report the SAME
      // version string (1.0.39) but do not have the same capability — only the
      // native one can translate the engine.
      wasm2c: `${toolVersion(TOOLS.wasm2c)} (${TOOLS.wasm2c.includes("node_modules") ? "npm wabt.js build" : "native build"} at ${relPath(TOOLS.wasm2c)})`,
      cc: toolVersion(TOOLS.cc),
      wasmRtSource: "wabt 1.0.39 wasm2c/ (fetched at the matching tag; see script header)",
    },
    commands: {
      "wasm-jit": "wasmtime run --invoke run <prog>.wasm <arg>",
      "wasmtime-aot":
        "wasmtime compile <prog>.wasm -o <prog>.cwasm && wasmtime run --allow-precompiled --invoke run <prog>.cwasm <arg>",
      "wamr-aot": "wamrc -o <prog>.aot <prog>.wasm && iwasm -f run <prog>.aot <arg>",
      "wasm2c-native":
        "wasm2c <prog>.wasm -o <prog>.c && clang -O2 -fwrapv -o <prog> scripts/native-aot-corpus/driver.c <prog>.c wasm-rt-impl.c wasm-rt-mem-impl.c -lm && ./<prog> <arg>",
      "c-floor": "clang -O2 -fwrapv -o fib-c-floor scripts/native-aot-corpus/fib-floor.c && ./fib-c-floor <arg>",
    },
    runs,
    programs,
    denominators: { cFloor, execFloor, nodeFloor, runtimeSizes },
    dynamicTier,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
