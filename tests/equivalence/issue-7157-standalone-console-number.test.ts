// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7157 — host-free `console.log` dropped number and boolean arguments: the
// legacy lowering (taken for multi-argument calls and for any module-init the
// IR does not claim, e.g. once the JSON helpers or an untyped function are in
// the module) appended nothing for a scalar, so `console.log(1)` printed an
// empty line and `console.log("a", 1)` printed "a ". WASI printed booleans as
// 1/0 and truncated fractions. Each program's output must equal V8's, with every
// argument converted by `String(x)` and joined by one space.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports, instantiateWasm } from "../../src/runtime.js";

const PROGRAMS: Record<string, string> = {
  "number alone": `console.log(1);`,
  "string then number": `console.log("a", 1);`,
  "JSON helpers linked": `console.log(1);\nconsole.log("a", 1);\nconsole.log(JSON.stringify({}));`,
  "untyped function linked": `function f(x) { return x === 1 }\nconsole.log(f(1));\nconsole.log(1);`,
  "special numbers": `console.log(1.5, -0, NaN, Infinity);`,
  booleans: `console.log(true);\nconsole.log(1 === 1, false);`,
  "number in a template": "const n = 42;\nconsole.log(`n=${n}`, `${1.5}`);",
  "multi-argument joins": `console.log("a", 1, true, "b");\nconsole.log(-5, 0.1 + 0.2, 1e21, 123456789012);`,
  "untyped arithmetic": `function g(x) { return x + 1 }\nconsole.log(g(1), g(2.5));\nconsole.log(g(1));`,
  "int32 values": `let i = 3 | 0;\nconsole.log(i, i * 2);`,
  bigint: `console.log(1n, "x", -8n);`,
  "single arguments": `console.log(1.5);\nconsole.log(NaN);\nconsole.log(true);\nconsole.log(JSON.stringify({}));\nconsole.log(1);`,
};

// The gc lane hands each argument to the host console separately, one line per
// argument: only single-argument programs are comparable there.
const GC_PROGRAMS = ["number alone", "untyped function linked", "single arguments"];
// WASI still prints "[object]" for a bigint argument.
const NOT_ON_WASI = new Set(["bigint"]);

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src)({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
  return out;
}

type Lane = "standalone" | "standalone-off" | "gc" | "wasi";

async function compileOn(src: string, lane: Lane) {
  const result = await compile(src, {
    fileName: "probe.js",
    deferTopLevelInit: true,
    ...(lane === "standalone" ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
    ...(lane === "standalone-off" ? { target: "standalone" as const, hostBridge: "off" as const } : {}),
    ...(lane === "wasi" ? { target: "wasi" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

function runWasi(binary: Uint8Array): string[] {
  const ref: { memory?: WebAssembly.Memory } = {};
  const bytes: number[] = [];
  const wasi = {
    fd_write(_fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = new DataView(ref.memory!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        for (const b of new Uint8Array(ref.memory!.buffer, ptr, len)) bytes.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
    random_get(): number {
      return 0;
    },
    clock_time_get(): number {
      return 0;
    },
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), { wasi_snapshot_preview1: wasi, env: {} });
  ref.memory = instance.exports.memory as WebAssembly.Memory;
  const exp = instance.exports as Record<string, () => void>;
  (exp._start ?? exp.__module_init)!();
  return new TextDecoder().decode(Uint8Array.from(bytes)).split("\n").slice(0, -1);
}

async function runWasm(src: string, lane: Lane): Promise<string[]> {
  const result = await compileOn(src, lane);
  if (lane === "wasi") return runWasi(result.binary);
  if (lane === "gc") {
    const out: string[] = [];
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    const origLog = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      (instance.exports as Record<string, () => void>).__module_init?.();
    } finally {
      console.log = origLog;
    }
    return out;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exp = instance.exports as Record<string, (i?: number) => number>;
  exp.__module_init?.();
  const len = exp.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
  return sink.split("\n").slice(0, -1);
}

describe("#7157 console.log of numbers and booleans", () => {
  for (const [name, src] of Object.entries(PROGRAMS)) {
    it(`standalone: ${name}`, async () => {
      expect(await runWasm(src, "standalone")).toEqual(runV8(src));
    });
    // Without the host bridge the sink has no readout exports: the module must
    // still validate and run.
    it(`standalone hostBridge off: ${name}`, async () => {
      const result = await compileOn(src, "standalone-off");
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      (instance.exports as Record<string, () => void>).__module_init?.();
    });
    if (!NOT_ON_WASI.has(name)) {
      it(`wasi: ${name}`, async () => {
        expect(await runWasm(src, "wasi")).toEqual(runV8(src));
      });
    }
  }
  for (const name of GC_PROGRAMS) {
    it(`gc native-first: ${name}`, async () => {
      expect(await runWasm(PROGRAMS[name]!, "gc")).toEqual(runV8(PROGRAMS[name]!));
    });
  }
});
