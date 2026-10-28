// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7151 — a comparator-less `sort()` on a module-level array stored as the
// externref-element vec (`$__vec_externref`: a `const keys = []` filled by
// `push` / `for…in`) lowered to the #2502 no-op on gc native-first and
// standalone, so `keys.sort().join(",")` printed the unsorted order. It now
// runs SortCompare (§23.1.3.30.2) over the elements: undefined last, the rest by
// ToString in code-unit order. Pinned: each program's output equals V8's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const show = `.map((v) => String(v)).join("|")`;

const PROGRAMS: Record<string, string> = {
  "for…in keys": `const keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\nconsole.log(keys.sort().join(","));`,
  "pushed strings": `const s = []; s.push("c"); s.push("a"); s.push("b");\nconsole.log(s.sort().join());`,
  "pushed numbers": `const n = []; n.push(3); n.push(1); n.push(2);\nconsole.log(n.sort().join());`,
  "numbers compare as strings": `const n = []; n.push(10); n.push(9); n.push(1); n.push(100);\nconsole.log(n.sort().join());`,
  "reassigned to a literal": `let keys = [];\nfor (const k in { b: 1, a: 2 }) keys.push(k);\nkeys = ["z", "y"];\nconsole.log(keys.sort().join(","));`,
  "undefined sorts last": `const m = []; m.push(10); m.push(undefined); m.push("b"); m.push(9); m.push(undefined); m.push("a");\nconsole.log(m.sort()${show});`,
  "null sorts as 'null'": `const m = []; m.push("o"); m.push(null); m.push("m"); m.push(undefined); m.push("p");\nconsole.log(m.sort()${show});`,
  "booleans and signs": `const m = []; m.push(true); m.push(false); m.push(-1); m.push(0);\nconsole.log(m.sort()${show});`,
  "sorts in place": `const m = []; m.push("b"); m.push("a");\nm.sort();\nconsole.log(m.join());`,
  "empty and single": `const e = []; const o = []; o.push("x");\nconsole.log(String(e.sort().length) + o.sort().join());`,
  // SortCompare step 5: ToString(Symbol) throws, an element's own toString throwing propagates.
  "Symbol element throws TypeError": `const m = []; m.push("b"); m.push(Symbol("s")); m.push("a");\nlet r = "none"; try { m.sort(); } catch (e) { r = String(e instanceof TypeError); }\nconsole.log(r);`,
  "throwing toString propagates": `const k = []; k.push({ toString() { throw new RangeError("x"); } }); k.push("a");\nlet q = "none"; try { k.sort(); } catch (e) { q = String(e instanceof RangeError); }\nconsole.log(q);`,
  "stable for equal ToString": `const st = []; st.push(10); st.push("10"); st.push(1); st.push("1");\nst.sort();\nconsole.log(String(st[0] === 1) + String(st[1] === "1") + String(st[2] === 10) + String(st[3] === "10"));`,
  // Spec: the undefineds, then the holes (SortIndexedProperties leaves them trailing).
  "hole after undefined": `const g: any[] = ["b", , "a", undefined];\ng.sort();\nconsole.log([0, 1, 2, 3].map((i) => String(i in g)).join(" ") + " " + String(g[0]) + String(g[1]) + String(g[2]));`,
  "inside a function (control)": `function f() { const s = []; s.push("c"); s.push("a"); return s.sort().join(); }\nconsole.log(f());`,
};

function runV8(src: string): string[] {
  const out: string[] = [];
  new Function("console", src.replace(": any[]", ""))({ log: (...a: unknown[]) => out.push(a.map(String).join(" ")) });
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
    fileName: src.includes(": any[]") ? "probe.ts" : "probe.js",
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

describe("#7151 comparator-less sort over an externref-element vec", () => {
  for (const target of ["gc", "standalone", "wasi"] as const) {
    for (const [name, src] of Object.entries(PROGRAMS)) {
      // wasi answers `i in g` wrongly for a holey array even without `sort`
      // (pre-existing), so the hole row is pinned on the other two lanes only.
      if (target === "wasi" && name === "hole after undefined") continue;
      it(`${target === "gc" ? "gc native-first" : target}: ${name}`, async () => {
        expect(await runWasm(src, target)).toEqual(runV8(src));
      });
    }
  }
});
