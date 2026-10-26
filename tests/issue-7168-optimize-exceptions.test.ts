// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7168 — native-first exception code must survive wasm-opt. Binaryen's
// remove-unused-brs turns a locally caught `throw` into a fall-through value,
// typing the try_table `(result (ref extern))`; V8 12.4 (Node 22, a supported
// engine) executes a try_table with such a block type as `unreachable`.
// optimize.ts re-shapes it. Node 23+ runs the shape fine, so the execution
// checks only bite on Node 22; the SHAPE checks (no ref-typed try_table left
// in the -O3 output) catch a regression on any Node, CI's included.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { mayContainUnsafeTryTable, reshapeUnsafeTryTables } from "../src/optimize-try-table-shape.js";
import { optimizeBinaryAsync } from "../src/optimize.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const CORPUS = resolve(__dirname, "differential/corpus");
const corpus = (rel: string) => readFileSync(resolve(CORPUS, rel), "utf-8");

const MIN_THROW_NEW_ERROR = `try { throw new Error("boom"); } catch (e) { console.log("caught"); }
console.log("after");`;
const MIN_MESSAGE = `try { throw new Error("boom"); } catch (e) { console.log(e.message); }`;

const WASM_OPT = join(createRequire(import.meta.url).resolve("binaryen/package.json"), "..", "bin", "wasm-opt");
const FEATURES = ["--all-features", "--disable-custom-descriptors", "--disable-compact-imports"];
/** A try_table whose block type is a ref type — the shape V8 12.4 mis-executes. */
const UNSAFE_TRY_TABLE = /try_table[^\n]*\(result \(ref/;

/** Binaryen's printed text of WAT source (no passes). */
function printWat(wat: string): string {
  return execFileSync(WASM_OPT, ["-", "--print", ...FEATURES], {
    input: wat,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: 1 << 28,
  });
}

// The fresh-context review's soundness probe for the rewriter (PR #6929).
const SHAPES_WAT = `(module
 (import "e" "x" (global $gx externref))
 (type $S (struct (field i32)))
 (tag $e (param i32))
 (tag $e0)
 (memory 1)
 (data (i32.const 0) "(try_table (result (ref extern)) ) ) (\\"")
 ;; f1: nested unsafe try_tables, inner throw caught by OUTER catch
 (func $f1 (export "f1") (param $x i32) (result i32)
  (block $h0
   (return
    (i32.add (i32.const 1000)
     (block $c (result i32)
      (return
       (struct.get $S 0
        (try_table $outer (result (ref $S)) (catch $e $c)
         (struct.new $S
          (i32.add (i32.const 100)
           (struct.get $S 0
            (try_table $inner (result (ref $S)) (catch $e0 $h0)
             (if (i32.eq (local.get $x) (i32.const 1)) (then (throw $e (i32.const 42))))
             (if (i32.eq (local.get $x) (i32.const 2)) (then (throw $e0)))
             (struct.new $S (i32.const 5)))))))))))))
  (i32.const -1))
 ;; f2: br out of a loop to the try_table's own label and to an outer label
 (func $f2 (export "f2") (param $n i32) (result i32)
  (local $i i32)
  (block $h
   (return
    (block $done (result i32)
     (struct.get $S 0
      (try_table $tt (result (ref $S)) (catch_all $h)
       (loop $L
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $done (i32.const 77) (i32.eq (local.get $i) (i32.const 50)))
        (br_if $tt (struct.new $S (local.get $i)) (i32.ge_s (local.get $i) (local.get $n)))
        (br $L))
       (unreachable))))))
  (i32.const -1))
 ;; f4: catch_all_ref and catch_ref (multi-value label)
 (func $f4 (export "f4") (param $x i32) (result i32)
  (drop
   (block $car (result exnref)
    (return
     (i32.add (i32.const 3)
      (tuple.extract 2 0
       (block $cr (type $tr) (result i32 exnref)
        (return
         (struct.get $S 0
          (try_table (result (ref $S)) (catch_ref $e $cr) (catch_all_ref $car)
           (if (i32.eq (local.get $x) (i32.const 1)) (then (throw $e (i32.const 10))))
           (if (i32.eq (local.get $x) (i32.const 2)) (then (throw $e0)))
           (struct.new $S (i32.const 9)))))))))))
  (i32.const 200))
 (type $tr (func (result i32 exnref)))
 ;; f5: multi-value try_table with a ref
 (func $f5 (export "f5") (param $x i32) (result i32)
  (local $t (tuple i32 (ref null $S)))
  (block $h
   (local.set $t
    (try_table (result i32 (ref $S)) (catch_all $h)
     (if (local.get $x) (then (throw $e0)))
     (tuple.make 2 (i32.const 4) (struct.new $S (i32.const 6)))))
   (return (i32.add (tuple.extract 2 0 (local.get $t)) (struct.get $S 0 (tuple.extract 2 1 (local.get $t))))))
  (i32.const -5))
 ;; f6: odd names
 (func $"we(ird) \\"name" (export "f6") (param $x i32) (result i32)
  (block $"lab(el" (result i32)
   (return
    (struct.get $S 0
     (try_table $"t)t(" (result (ref $S)) (catch $e $"lab(el")
      (if (local.get $x) (then (throw $e (i32.const 61))))
      (struct.new $S (i32.const 60)))))))
 ;; f7: (ref extern) result + i32.load of data still intact
 (func $f7 (export "f7") (param $x i32) (result i32)
  (block $h
   (drop
    (try_table (result (ref extern)) (catch_all $h)
     (if (local.get $x) (then (throw $e0)))
     (ref.as_non_null (global.get $gx))))
   (return (i32.load8_u (i32.const 1))))
  (i32.const -7))
)
`;

function printBinary(binary: Uint8Array): string {
  return execFileSync(WASM_OPT, ["-", "--print", ...FEATURES], {
    input: binary,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: 1 << 28,
  });
}

async function optimizedShape(source: string, opts: Record<string, unknown>): Promise<string> {
  const r = await compile(source, { fileName: "issue-7168.js", optimize: true, ...opts });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return printBinary(r.binary);
}

/**
 * Run `body` with a fake `wasm-opt` first on PATH (the #6742 pattern). The
 * fake sees the real binary as REAL_WASM_OPT and its own argv as `args`.
 */
async function withFakeWasmOpt<T>(script: string, body: () => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "js2-wasm-opt-7168-"));
  const fake = join(root, "wasm-opt");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("--disable-compact-imports"); process.exit(0); }
${script}
`,
  );
  chmodSync(fake, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [root, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  process.env.REAL_WASM_OPT = WASM_OPT;
  try {
    return await body();
  } finally {
    process.env.PATH = previousPath;
    Reflect.deleteProperty(process.env, "REAL_WASM_OPT");
    rmSync(root, { recursive: true, force: true });
  }
}

/** The `-O` run of the fake: hand the input back as the "optimized" output. */
const FAKE_OPTIMIZE = `fs.copyFileSync(args[0], args[args.indexOf("-o") + 1]);`;

/**
 * A valid module whose code holds the byte run `1f 64 6a 00` that the
 * pre-scan cannot tell from a try_table — `local.get 31` (`20 1f`),
 * `f64.gt` (`64`), `i32.add` (`6a`), `unreachable` (`00`) — and no try_table.
 */
function falsePositiveModule(): Uint8Array {
  const type = [0x60, 32, ...Array<number>(32).fill(0x7c), 1, 0x7f];
  const body = [0x00, 0x41, 0x01, 0x20, 0x00, 0x20, 0x1f, 0x64, 0x6a, 0x00, 0x0b];
  return new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...[0x01, type.length + 1, 0x01, ...type],
    ...[0x03, 0x02, 0x01, 0x00],
    ...[0x0a, body.length + 2, 0x01, body.length, ...body],
  ]);
}

const REF_TRY_TABLE_WAT = `(module
 (import "env" "mk" (func $mk (result externref)))
 (tag $t (param externref))
 (func (export "f") (result externref)
  (block $b (result externref)
   (try_table (result (ref extern)) (catch $t $b)
    (ref.as_non_null (call $mk))))))`;

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((res) => setTimeout(res, 0));
}

/** gc lane, native-first (no semanticProviders pin), as scripts/diff-test.ts runs it. */
async function runGc(source: string, optimize: boolean): Promise<string[]> {
  const r = await compile(source, { fileName: "issue-7168.js", optimize, deferTopLevelInit: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    await drain();
  } finally {
    console.log = log;
  }
  return lines;
}

/** standalone / wasi lanes: no JS host; capture WASI fd_write if imported. */
async function runNoHost(source: string, target: "standalone" | "wasi", optimize: boolean): Promise<string> {
  const r = await compile(source, { fileName: "issue-7168.js", optimize, target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(r.binary);
  let out = "";
  // Bound after instantiation; fd_write only runs once start() executes.
  const memory: { current?: WebAssembly.Memory } = {};
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] ??= {};
    imports[imp.module]![imp.name] =
      imp.name === "fd_write"
        ? (_fd: number, iovs: number, count: number, written: number) => {
            const view = new DataView(memory.current!.buffer);
            let total = 0;
            for (let k = 0; k < count; k++) {
              const ptr = view.getUint32(iovs + 8 * k, true);
              const len = view.getUint32(iovs + 8 * k + 4, true);
              out += new TextDecoder().decode(new Uint8Array(memory.current!.buffer, ptr, len));
              total += len;
            }
            view.setUint32(written, total, true);
            return 0;
          }
        : () => 0;
  }
  const instance = new WebAssembly.Instance(mod, imports as WebAssembly.Imports);
  memory.current = instance.exports.memory as WebAssembly.Memory | undefined;
  const start = (instance.exports._start ?? instance.exports.__module_init) as (() => void) | undefined;
  start?.();
  return out;
}

const PROGRAMS: Array<[name: string, source: () => string, gcExpected: string[] | null]> = [
  ["minimised: throw new Error in try", () => MIN_THROW_NEW_ERROR, ["caught", "after"]],
  ["minimised: e.message of a thrown Error", () => MIN_MESSAGE, ["boom"]],
  ["corpus control/07-try-catch", () => corpus("control/07-try-catch.js"), ["caught:boom", "after"]],
  ["corpus builtins/10-error-classes", () => corpus("builtins/10-error-classes.js"), ["true", "type problem", "true"]],
  // Native-first gc does not yet print the async result unoptimized either; the
  // optimize gate only requires that -O3 not change (or trap) the outcome.
  ["corpus builtins/09-async-await", () => corpus("builtins/09-async-await.js"), null],
];

describe("#7168 exception code survives wasm-opt", () => {
  it("re-shapes only try_tables whose block type V8 12.4 mis-executes", () => {
    const unsafe = `(func $f
  (drop
   (block $b (result externref)
    (try_table $t (result (ref extern)) (catch $tag$0 $b)
     (call $mk "a)(\\"")
    )
   )
  )
 )`;
    const out = reshapeUnsafeTryTables(unsafe);
    expect(out).toContain(
      "(block $__js2_tt0 (result (ref extern)) (try_table (catch $tag$0 $b) (br $__js2_tt0 (block $t (result (ref extern))",
    );
    expect(out).toContain("))) (unreachable))");
    expect(out).toContain(`(call $mk "a)(\\"")`);
    expect(reshapeUnsafeTryTables(unsafe.replace("(result (ref extern))", "(result externref)"))).toBeNull();
    expect(reshapeUnsafeTryTables(unsafe.replace("(result (ref extern))", "(result i32)"))).toBeNull();
    expect(reshapeUnsafeTryTables(unsafe.replace("(result (ref extern)) ", ""))).toBeNull();
  });

  it("re-shapes the reviewer's shapes fixture and keeps every result", () => {
    // Nested unsafe try_tables, br/br_if to the try_table's own label from a
    // loop, catch with a value, catch_ref / catch_all_ref, a multi-value
    // try_table, names that need quotes, and try_table text inside a data
    // segment. Original bytes do not even compile on Node 22.
    const printed = printWat(SHAPES_WAT);
    expect(printed).toMatch(UNSAFE_TRY_TABLE);
    const reshaped = reshapeUnsafeTryTables(printed);
    expect(reshaped).not.toBeNull();
    const binary = execFileSync(WASM_OPT, ["-", "-o", "-", ...FEATURES], {
      input: reshaped!,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const reprinted = printBinary(binary);
    // Only the data segment still mentions a ref-typed try_table.
    const lines = reprinted.split("\n").filter((l) => UNSAFE_TRY_TABLE.test(l));
    expect(lines).toEqual([expect.stringContaining("(data ")]);
    // Multi-value try_tables (`(type $N) (result ...)`) run fine on V8 12.4 and are left alone.
    expect(reprinted).toMatch(/\(try_table \(type \$\d+\) \(result i32 \(ref \$\w+\)\)/);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), { e: { x: "hello" } });
    const results: string[] = [];
    for (const [name, f] of Object.entries(instance.exports)) {
      if (typeof f !== "function") continue;
      for (const a of [0, 1, 2, 3, 100]) results.push(`${name}(${a})=${(f as (x: number) => number)(a)}`);
    }
    expect(results.join(" ")).toBe(
      "f1(0)=105 f1(1)=1042 f1(2)=-1 f1(3)=105 f1(100)=105 f2(0)=1 f2(1)=1 f2(2)=2 f2(3)=3 f2(100)=77 " +
        "f4(0)=9 f4(1)=13 f4(2)=200 f4(3)=9 f4(100)=9 f5(0)=10 f5(1)=-5 f5(2)=-5 f5(3)=-5 f5(100)=-5 " +
        "f6(0)=60 f6(1)=61 f6(2)=61 f6(3)=61 f6(100)=61 f7(0)=116 f7(1)=-7 f7(2)=-7 f7(3)=-7 f7(100)=-7",
    );
  });

  it("pre-scan: hits a real ref-typed try_table in code, ignores pairs outside code or that do not decode", () => {
    const real = execFileSync(WASM_OPT, ["-", "-o", "-", ...FEATURES], {
      input: REF_TRY_TABLE_WAT,
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(mayContainUnsafeTryTable(new Uint8Array(real))).toBe(true);
    const safe = execFileSync(WASM_OPT, ["-", "-o", "-", ...FEATURES], {
      input: REF_TRY_TABLE_WAT.replace("(result (ref extern))", "(result externref)"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(mayContainUnsafeTryTable(new Uint8Array(safe))).toBe(false);
    // The pair inside a data segment is not code.
    const data = execFileSync(WASM_OPT, ["-", "-o", "-", ...FEATURES], {
      input: '(module (memory 1) (data (i32.const 0) "\\1f\\64\\6f\\01\\00\\00\\00"))',
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(mayContainUnsafeTryTable(new Uint8Array(data))).toBe(false);
    // `local.get 31; f64.gt; i32.const 1` — the byte after the pair (0x41) is no heap type.
    const fp = falsePositiveModule();
    const noHeap = fp.slice();
    noHeap[noHeap.length - 3] = 0x41;
    expect(mayContainUnsafeTryTable(noHeap)).toBe(false);
  });

  it("a pre-scan false positive whose print fails keeps the OPTIMIZED bytes", async () => {
    const raw = falsePositiveModule();
    expect(WebAssembly.validate(raw)).toBe(true);
    expect(mayContainUnsafeTryTable(raw)).toBe(true);
    const result = await withFakeWasmOpt(
      `if (args.includes("--print")) { process.stderr.write("print exploded\\n"); process.exit(1); }
${FAKE_OPTIMIZE}`,
      () => optimizeBinaryAsync(raw, { level: 3, timeoutMs: 20_000 }),
    );
    expect(result.optimized).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.timedOut).toBeUndefined();
    expect(result.binary).toEqual(raw);
  }, 60_000);

  it("a confirmed ref-typed try_table whose re-assembly times out ships unoptimized with timedOut", async () => {
    const raw = new Uint8Array(
      execFileSync(WASM_OPT, ["-", "-o", "-", ...FEATURES], {
        input: REF_TRY_TABLE_WAT,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    expect(mayContainUnsafeTryTable(raw)).toBe(true);
    const timeoutMs = 6_000;
    const result = await withFakeWasmOpt(
      `if (args.includes("--print")) { process.stdout.write(cp.execFileSync(process.env.REAL_WASM_OPT, args)); process.exit(0); }
if (args[0].endsWith(".wat")) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); }
${FAKE_OPTIMIZE}`,
      () => optimizeBinaryAsync(raw, { level: 3, timeoutMs }),
    );
    expect(result.optimized).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.binary).toEqual(raw);
    // The message names the budget that was left for re-assembly, not the full timeoutMs.
    const applied = Number(/timed out after (\d+) ms/.exec(result.warning ?? "")?.[1]);
    expect(applied).toBeGreaterThan(0);
    expect(applied).toBeLessThan(timeoutMs);
  }, 60_000);

  for (const [name, source, gcExpected] of PROGRAMS) {
    it(`${name}: -O3 output has no ref-typed try_table (gc native-first, standalone, wasi)`, async () => {
      for (const opts of [{ deferTopLevelInit: true }, { target: "standalone" }, { target: "wasi" }]) {
        expect(await optimizedShape(source(), opts), JSON.stringify(opts)).not.toMatch(UNSAFE_TRY_TABLE);
      }
    }, 120_000);

    it(`${name}: gc native-first -O3 matches unoptimized`, async () => {
      const unopt = await runGc(source(), false);
      if (gcExpected) expect(unopt).toEqual(gcExpected);
      expect(await runGc(source(), true)).toEqual(unopt);
    }, 120_000);

    for (const target of ["standalone", "wasi"] as const) {
      it(`${name}: ${target} -O3 runs and matches unoptimized`, async () => {
        const unopt = await runNoHost(source(), target, false);
        expect(await runNoHost(source(), target, true)).toBe(unopt);
      }, 120_000);
    }
  }
});
