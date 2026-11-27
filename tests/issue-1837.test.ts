// #1837 — standalone Object.keys/values/entries (and the for-in / spread /
// JSON.stringify paths that consume them) emitted property keys in hash-bucket
// order instead of the ECMAScript OrdinaryOwnPropertyKeys order (§10.1.11.1):
// integer-index keys ascending first, then string keys in insertion order.
//
// The fix adds a per-entry insertion `seq` to $PropEntry and a monotonically
// increasing $Object.nextSeq, then routes all three enumeration helpers through
// a new __obj_ordered helper that compacts the live + enumerable entries into a
// fresh $PropMap in spec order (integer keys ascending via __obj_index_of_key,
// then string keys by seq).
//
// NOTE on observability: the standalone $ObjVec enumeration result currently
// only supports reading `.length` from compiled code — element string-equality,
// value-unbox, and charCodeAt on a $ObjVec slot are separate pre-existing gaps
// (the #1472 suite tests `.length` for the same reason). So these tests assert
// the ordering MACHINERY is wired in (helpers emitted + called, struct fields
// present, binary valid, correct length, no host object imports) rather than
// decoding the ordered keys back into JS strings.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const SETUP = `
  const o: any = {};
  // computed keys defeat shape inference so the genuine native open-hash $Object
  // path (not a closed WasmGC struct) is exercised — see the #1472 test note.
  const kb = "b"; const ka = "a"; const k2 = "2"; const k1 = "1";
  o[kb] = 1; o[ka] = 2; o[k2] = 3; o[k1] = 4;
`;

async function compileStandalone(body: string) {
  const src = `export function run(): number { ${SETUP} ${body} }`;
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r as typeof r & { wat?: string; imports: { module: string; name: string }[] };
}

describe("#1837 — standalone enumeration order", () => {
  it("emits the OrdinaryOwnPropertyKeys ordering helpers and routes Object.keys through them", async () => {
    const r = await compileStandalone(`const ks: any = Object.keys(o); return (ks.length as number);`);
    const wat = r.wat ?? "";
    // The new ordering machinery is present as defined functions.
    expect(wat).toMatch(/\(func \$__obj_ordered\b/);
    expect(wat).toMatch(/\(func \$__obj_index_of_key\b/);
    // $PropEntry gained the insertion-sequence field; $Object gained the counter.
    expect(wat).toMatch(/\(field \$seq /);
    expect(wat).toMatch(/\(field \$nextSeq /);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("Object.keys still counts every enumerable own key (4 here) after the reorder", async () => {
    const r = await compileStandalone(`const ks: any = Object.keys(o); return (ks.length as number);`);
    const instance = await instantiateWithRuntime(r);
    expect((instance.exports.run as () => number)()).toBe(4);
  });

  it("Object.values length is unchanged by the ordering pass", async () => {
    const r = await compileStandalone(`const vs: any = Object.values(o); return (vs.length as number);`);
    const instance = await instantiateWithRuntime(r);
    expect((instance.exports.run as () => number)()).toBe(4);
  });

  it("Object.entries length is unchanged by the ordering pass", async () => {
    const r = await compileStandalone(`const es: any = Object.entries(o); return (es.length as number);`);
    const instance = await instantiateWithRuntime(r);
    expect((instance.exports.run as () => number)()).toBe(4);
  });

  it("uses zero host object imports — the ordering is pure Wasm (standalone)", async () => {
    const r = await compileStandalone(`const ks: any = Object.keys(o); return (ks.length as number);`);
    const hostObjImports = r.imports.filter(
      (i) =>
        i.module === "env" &&
        (i.name.startsWith("__object_") || i.name.startsWith("__extern_") || i.name === "__for_in_keys"),
    );
    expect(hostObjImports).toEqual([]);
  });

  it('JS-host mode still produces spec order (reference oracle): "1","2","b","a"', async () => {
    // In JS-host mode Object.keys returns a real JS array whose elements ARE
    // decodable, so we can assert the exact spec ordering as a cross-check that
    // the expected order is what the standalone path is now built to reproduce.
    const src = `export function run(): string { ${SETUP}
      const ks: any = Object.keys(o);
      let s = "";
      for (let i = 0; i < (ks.length as number); i++) { s = s + (ks[i] as string); }
      return s;
    }`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const instance = await instantiateWithRuntime(r);
    expect((instance.exports.run as () => string)()).toBe("12ba");
  });
});
