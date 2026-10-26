// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7168 — native-first exception code must survive wasm-opt. Binaryen's
// remove-unused-brs turns a locally caught `throw` into a fall-through value,
// typing the try_table `(result (ref extern))`; V8 12.4 (Node 22) executes a
// try_table with such a block type as `unreachable`. optimize.ts re-shapes it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { reshapeUnsafeTryTables } from "../src/optimize-try-table-shape.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const CORPUS = resolve(__dirname, "differential/corpus");
const corpus = (rel: string) => readFileSync(resolve(CORPUS, rel), "utf-8");

const MIN_THROW_NEW_ERROR = `try { throw new Error("boom"); } catch (e) { console.log("caught"); }
console.log("after");`;
const MIN_MESSAGE = `try { throw new Error("boom"); } catch (e) { console.log(e.message); }`;

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

  for (const [name, source, gcExpected] of PROGRAMS) {
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
