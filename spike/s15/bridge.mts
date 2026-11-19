// S15 spike harness: Prepared program with lib_* stubs -> stubs replaced by legacy-lib imports -> run.
import { compile } from "../../src/test262/test262-prepared-entry.js";
import { compile as ordinary } from "../../src/index.js";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const B = "../../node_modules/.pnpm/binaryen@132.0.0/node_modules/binaryen/bin";
const FEAT = ["--enable-gc", "--enable-reference-types", "--enable-exception-handling", "--enable-tail-call", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", "--enable-multivalue"];
const bin = (t: string, ...a: string[]) => execFileSync(`${B}/${t}`, a, { encoding: "utf8", maxBuffer: 1 << 28 });

export async function prepared(src: string, file = "p.js") {
  const t0 = performance.now();
  const r: any = await compile(src, { wholeProgram: Object.freeze({ kind: "prepared-program-required", version: 1 }), backend: "wasmgc", target: "standalone", sourceMap: false, optimize: false, emitWat: false, fileName: file, allowJs: true } as any);
  if (!r.success) throw new Error("prepared refused: " + r.errors.map((e: any) => e.message).join(" | "));
  return { binary: r.binary as Uint8Array, ms: performance.now() - t0 };
}
/** Export the legacy module's exception tag as `__exn` (what a shared library module would do). */
export function exportTag(name: string, binary: Uint8Array) {
  writeFileSync(`${name}.libsrc.wasm`, binary);
  bin("wasm-dis", ...FEAT, `${name}.libsrc.wasm`, "-o", `${name}.libsrc.wat`);
  const lines = readFileSync(`${name}.libsrc.wat`, "utf8").split("\n");
  const t = lines.findIndex((l) => /^ \(tag \$tag\$0 .*\(param externref\)\)$/.test(l));
  if (t < 0) throw new Error("no legacy exception tag");
  lines.splice(t + 1, 0, ' (export "__exn" (tag $tag$0))');
  writeFileSync(`${name}.libtag.wat`, lines.join("\n"));
  bin("wasm-as", ...FEAT, `${name}.libtag.wat`, "-o", `${name}.libtag.wasm`);
  return new Uint8Array(readFileSync(`${name}.libtag.wasm`));
}
export async function legacy(src: string, file = "lib.ts") {
  const t0 = performance.now();
  const r: any = await ordinary(src, { target: "standalone", fileName: file } as any);
  if (!r.success) throw new Error("legacy refused: " + r.errors.map((e: any) => e.message).join(" | "));
  return { binary: r.binary as Uint8Array, ms: performance.now() - t0 };
}
/** Replace each defined `$lib_*` function by an import from `legacy-lib` with the same type. */
export function toImports(name: string, binary: Uint8Array, stubs: string[], shareTag = false) {
  writeFileSync(`${name}.wasm`, binary);
  bin("wasm-dis", ...FEAT, `${name}.wasm`, "-o", `${name}.wat`);
  const lines = readFileSync(`${name}.wat`, "utf8").split("\n");
  const imports: string[] = [];
  for (const stub of stubs) {
    const start = lines.findIndex((l) => l.startsWith(` (func $${stub} `));
    if (start < 0) throw new Error("stub not found: " + stub);
    const type = /\(type (\$\d+)\)/.exec(lines[start])![1];
    let end = start + 1;
    while (end < lines.length && !/^ \(/.test(lines[end]) && lines[end] !== ")") end++;
    lines.splice(start, end - start);
    imports.push(` (import "legacy-lib" "${stub}" (func $${stub} (type ${type})))`);
  }
  if (shareTag) {
    const t = lines.findIndex((l) => /^ \(tag \$tag\$0 \(type \$\d+\) \(param externref\)\)$/.test(l));
    if (t < 0) throw new Error("no Prepared exception tag");
    const type = /\(type (\$\d+)\)/.exec(lines[t])![1];
    lines.splice(t, 1);
    imports.push(` (import "legacy-lib" "__exn" (tag $tag$0 (type ${type}) (param externref)))`);
  }
  const at = lines.findIndex((l) => /^ \((global|tag|func|memory|table|elem|data|export)/.test(l));
  lines.splice(at, 0, ...imports);
  if (process.env.FINAL_STRINGS) {
    for (let i = 0; i < lines.length; i++) {
      // Prepared's leaf string types: ConsString (sub AnyString, 3 fields) and HashedString (sub NativeString, 8 fields).
      if (/^ \(type \$\d+ \(sub \$1 \(struct \(field i32\) \(field \(mut \(ref null \$1\)\)\)/.test(lines[i]) ||
          /^ \(type \$\d+ \(sub \$2 \(struct .*\(field \(mut anyref\)\) \(field \(mut anyref\)\) \(field \(mut anyref\)\)\)\)\)$/.test(lines[i]))
        lines[i] = lines[i].replace(/\(sub \$/, "(sub final $");
    }
  }
  writeFileSync(`${name}.bridged.wat`, lines.join("\n"));
  bin("wasm-as", ...FEAT, `${name}.bridged.wat`, "-o", `${name}.bridged.wasm`);
  return new Uint8Array(readFileSync(`${name}.bridged.wasm`));
}
export function merge(name: string, prep: Uint8Array, lib: Uint8Array) {
  writeFileSync(`${name}.lib.wasm`, lib);
  writeFileSync(`${name}.prep.wasm`, prep);
  const t0 = performance.now();
  bin("wasm-merge", ...FEAT, `${name}.lib.wasm`, "legacy-lib", `${name}.prep.wasm`, "prep", "-o", `${name}.merged.wasm`);
  const ms = performance.now() - t0;
  return { binary: new Uint8Array(readFileSync(`${name}.merged.wasm`)), ms };
}
function outcome(f: () => unknown): string {
  try {
    const v = f();
    return "returned" + (v === undefined ? "" : " " + String(v));
  } catch (e: any) {
    return `threw ${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 120)}`;
  }
}
export function runTwo(prep: Uint8Array, lib: Uint8Array) {
  const L = new WebAssembly.Instance(new WebAssembly.Module(lib), {});
  let P: WebAssembly.Instance;
  try {
    P = new WebAssembly.Instance(new WebAssembly.Module(prep), { "legacy-lib": L.exports as any });
  } catch (e: any) {
    return e instanceof WebAssembly.Exception ? "threw at instantiation (start)" : "link error: " + String(e?.message ?? e).slice(0, 200);
  }
  return outcome(() => (P.exports.__module_init as any)?.());
}
export function runOne(merged: Uint8Array) {
  let M: WebAssembly.Instance;
  try {
    M = new WebAssembly.Instance(new WebAssembly.Module(merged), {});
  } catch (e: any) {
    return e instanceof WebAssembly.Exception ? "threw at instantiation (start)" : "link error: " + String(e?.message ?? e).slice(0, 200);
  }
  return outcome(() => (M.exports.__module_init as any)?.());
}
export async function probe(name: string, prepSrc: string, stubs: string[], libSrc: string, shareTag = false) {
  const p = await prepared(prepSrc);
  const l = await legacy(libSrc);
  if (shareTag) l.binary = exportTag(name, l.binary);
  const s = toImports(name, p.binary, stubs, shareTag);
  const m = merge(name, s, l.binary);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(m.binary)).length;
  return {
    name,
    two: runTwo(s, l.binary),
    merged: runOne(m.binary),
    bytes: { prep: s.length, lib: l.binary.length, merged: m.binary.length, mergedImports: imports },
    ms: { prep: Math.round(p.ms), lib: Math.round(l.ms), merge: Math.round(m.ms) },
  };
}
