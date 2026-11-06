// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7155 — on the no-host lanes the native `__object_assign` (object spread +
// Object.assign) treated an array source like an open object and copied the
// vec's internal fields, so `{ ...[5, 6] }` had keys `length,data` and
// stringified as `{"length":2}`. It now copies the array's index properties
// "0".."length-1" (holes skipped), integer keys first as #7148 requires.
// Pinned: each program's output equals V8's on gc native-first, standalone, wasi.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const PROGRAMS: Record<string, string> = {
  "spread keys": `const c = { ...[5, 6] };\nconsole.log(Object.keys(c).join());`,
  "spread JSON": `const c = { ...[5, 6] };\nconsole.log(JSON.stringify(c));`,
  "Object.assign": `const c = Object.assign({}, [5, 6]);\nconsole.log(Object.keys(c).join() + " " + JSON.stringify(c));`,
  "later key overwrites index": `const c = { ...["a", "b"], 1: "x" };\nconsole.log(JSON.stringify(c));`,
  "index overwrites earlier key": `const c = { 1: "x", ...["a", "b"] };\nconsole.log(JSON.stringify(c));`,
  "named key after spread": `const c = { ...["a", "b"], z: 1 };\nconsole.log(Object.keys(c).join());`,
  "holey array skips holes": `const h: any[] = [1, , 3];\nconst c = { ...h };\nconsole.log(Object.keys(c).join() + " " + JSON.stringify(c));`,
  "any[] mixed values": `const m: any[] = [1, "two", true, null];\nconst c = { ...m };\nconsole.log(JSON.stringify(c));`,
  "nested arrays as values": `const n = [[1, 2], [3]];\nconst c = { ...n };\nconsole.log(Object.keys(c).join() + " " + JSON.stringify(c));`,
  "number[]": `const a: number[] = [1.5, 2];\nconst c = { ...a };\nconsole.log(JSON.stringify(c));`,
  "string[]": `const a: string[] = ["p", "q", "r"];\nconst c = { ...a };\nconsole.log(JSON.stringify(c));`,
  "empty array": `const e: number[] = [];\nconst c = { ...e };\nconsole.log(String(Object.keys(c).length) + " " + JSON.stringify(c));`,
  "spread string unchanged": `const c = { ..."hi" };\nconsole.log(Object.keys(c).join() + " " + JSON.stringify(c));`,
  "spread object unchanged": `const o = { x: 1, y: 2 };\nconst c = { ...o };\nconsole.log(Object.keys(c).join() + " " + JSON.stringify(c));`,
  // An untyped receiver: a \`const c = { ...[7, 8] }\` binding still unrolls the
  // checker's \`{ [n]: number; length; push; … }\` shape statically (pre-existing).
  "for-in over spread result": `function f(o) { const ks = []; for (const k in o) ks.push(k); return ks.join(); }\nconst r = f({ ...[7, 8] });\nconsole.log(r);`,
  "any-typed array source": `function f(o) { return JSON.stringify({ ...o }) + JSON.stringify(Object.assign({}, o)); }\nconst r = f([5, 6]);\nconsole.log(r);`,
  "Object.entries": `const c = { ...[7, 8] };\nconsole.log(Object.entries(c).map((e) => e[0] + "=" + e[1]).join(";"));`,
};

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src.replace(/: (any|number|string)\[\]/g, ""))({
    log: (...a: unknown[]) => out.push(a.map(String).join(" ")),
  });
  return out;
}

function runWasi(binary: Uint8Array): string[] {
  const ref: { mem?: WebAssembly.Memory } = {};
  const bytes: number[] = [];
  const wasi = {
    fd_write(_fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      const view = new DataView(ref.mem!.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        for (const b of new Uint8Array(ref.mem!.buffer, ptr, len)) bytes.push(b);
        total += len;
      }
      view.setUint32(nwritten, total, true);
      return 0;
    },
    proc_exit(): void {},
  };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(binary), { wasi_snapshot_preview1: wasi });
  ref.mem = inst.exports.memory as WebAssembly.Memory;
  const exp = inst.exports as Record<string, () => void>;
  (exp.__module_init ?? exp._start)?.();
  return new TextDecoder()
    .decode(Uint8Array.from(bytes))
    .split("\n")
    .filter((l) => l.length > 0);
}

// On wasi, `console.log(<inline call result>)` prints "[object]" whatever the
// value (pre-existing, also without `sort`); a bound value prints faithfully.
const bindLogged = (src: string): string =>
  src.replace(/console\.log\((.*)\);$/gm, "{ const __o = $1; console.log(__o); }");

async function runWasm(src: string, target: "standalone" | "gc" | "wasi"): Promise<string[]> {
  if (target === "wasi") src = bindLogged(src);
  const result = await compile(src, {
    fileName: /: (any|number|string)\[\]/.test(src) ? "probe.ts" : "probe.js",
    deferTopLevelInit: true,
    ...(target === "standalone" ? { target: "standalone" as const, hostBridge: "always" as const } : {}),
    ...(target === "wasi" ? { target: "wasi" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  if (target === "wasi") return runWasi(result.binary);
  const out: string[] = [];
  let exp: Record<string, (...a: number[]) => number>;
  if (target === "gc") {
    // The default (native-first) gc lane, run the way scripts/diff-test.ts runs it.
    const built = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
    built.setInstance?.(instance);
    exp = instance.exports as typeof exp;
    const origLog = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      exp.__module_init?.();
    } finally {
      console.log = origLog;
    }
    return out;
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  exp = instance.exports as typeof exp;
  exp.__module_init?.();
  const len = exp.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < len; i++) sink += String.fromCharCode(exp.__stdout_char!(i) & 0xffff);
  for (const line of sink.split("\n")) if (line.length > 0) out.push(line);
  return out;
}

describe("#7155 object spread / Object.assign of an array copies its indices", () => {
  for (const target of ["gc", "standalone", "wasi"] as const) {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      // wasi's \`__extern_has_idx\` has no hole arm and its string spread copies
      // nothing — both pre-existing and independent of the array arm.
      if (target === "wasi" && (name === "holey array skips holes" || name === "spread string unchanged")) continue;
      it(`${target === "gc" ? "gc native-first" : target}: ${name}`, async () => {
        expect(await runWasm(src, target)).toEqual(runV8(src));
      });
    }
  }
});
