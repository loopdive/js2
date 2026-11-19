import { legacy } from "./bridge.mts";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const B = "../../node_modules/.pnpm/binaryen@132.0.0/node_modules/binaryen/bin";
const progs: Record<string, string> = {
  objOnly: "export function f(): any { return { a: 1 }; }",
  keys: "export function f(o: any): number { return Object.keys(o).length; }",
  proto: "export function f(o: any): any { return Object.getPrototypeOf(o); }",
  str: "export function f(s: string): string { return s.toUpperCase(); }",
  parseInt: "export function f(s: any): number { return parseInt(s); }",
};
for (const [k, src] of Object.entries(progs)) {
  const l = await legacy(src);
  writeFileSync(`lay-${k}.wasm`, l.binary);
  const wat = execFileSync(`${B}/wasm-dis`, ["--enable-gc", "--enable-reference-types", "--enable-exception-handling", "--enable-tail-call", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-multivalue", `lay-${k}.wasm`], { encoding: "utf8", maxBuffer: 1 << 28 });
  const types = wat.split("\n").filter((x) => x.startsWith(" (type "));
  const obj = types.find((t) => /\(field \(mut i32\)\) \(field \(mut i32\)\) \(field \(mut i32\)\) \(field \(mut i32\)\)/.test(t) && /\(field \(mut \(ref null \$(\d+)\)\)\) \(field \(mut \(ref/.test(t));
  const hashed = types.find((t) => /\(field \(mut anyref\)\) \(field \(mut anyref\)\) \(field \(mut anyref\)\)\)\)\)$/.test(t));
  const cons = types.filter((t) => /\(struct \(field i32\) \(field \(mut \(ref null/.test(t));
  const tags = wat.split("\n").filter((x) => x.startsWith(" (tag ")).length;
  console.log(k, { bytes: l.binary.length, ms: Math.round(l.ms), types: types.length, tags, objectFields: obj ? (obj.match(/\(field/g) || []).length : "none", hashedFinal: hashed ? /sub final/.test(hashed) : "none", consFinal: cons.map((c) => /sub final/.test(c)) });
}
