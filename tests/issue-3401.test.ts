import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// #3401 — standalone URI carrier ROUTING gap. #2500 shipped the native
// decodeURI/encodeURI/decodeURIComponent/encodeURIComponent, but
// `collectExternDeclarations` (extern-declarations.ts) still registered the
// `env::*URI*` HOST import whenever an unrelated builtin (String.fromCharCode,
// new Error, …) dragged the URI name into `libReferencedNames`. That env
// import beat the URI finalize's native emit (`funcMap.has(name)` → skip), so
// the call leaked `env::decodeURI` — a host_import_leak CE in standalone
// (#2961). Root fix: extend the parseInt/parseFloat native-skip in
// collectExternDeclarations to the URI + escape/unescape family (all have
// standalone natives), so the finalize owns their native emit.
//
// The bug was CONTEXT-DEPENDENT (only leaked when a sibling builtin pulled the
// name into the lib-referenced set), which is why #2500 shipped green on its
// own isolated probes — so every case below deliberately co-locates a sibling
// builtin (String.fromCharCode / new Error) with the URI call.

interface Res {
  value: unknown;
  leaks: string[];
}

async function run(source: string): Promise<Res> {
  const r = await compile(source, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const leaks = WebAssembly.Module.imports(mod)
    .map((i) => `${i.module}::${i.name}`)
    .filter((n) => /decodeURI|encodeURI|::escape|::unescape/i.test(n));
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, leaks };
}

describe("#3401 — standalone URI carrier routing (host-free, with sibling builtins)", () => {
  it("decodeURI is host-free next to String.fromCharCode (the S15.1.3.* shape)", async () => {
    const r = await run(
      `export function test(): number {
         const b = String.fromCharCode(65);
         return decodeURI("%41") === b ? 1 : 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("decodeURIComponent is host-free next to new Error", async () => {
    const r = await run(
      `export function test(): number {
         const e = new Error("z");
         return decodeURIComponent("%41") === "A" ? 1 : 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("encodeURI is host-free next to String.fromCharCode", async () => {
    const r = await run(
      `export function test(): number {
         const b = String.fromCharCode(65);
         return encodeURI("A B") === "A%20B" ? 1 : 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("encodeURIComponent is host-free next to new Error", async () => {
    const r = await run(
      `export function test(): number {
         const e = new Error("z");
         return encodeURIComponent("a=b") === "a%3Db" ? 1 : 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("legacy escape is host-free next to String.fromCharCode", async () => {
    const r = await run(
      `export function test(): number {
         const b = String.fromCharCode(65);
         return escape("a b") === "a%20b" ? 1 : 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("malformed URI throws a native URIError (no host import) with sibling builtin present", async () => {
    const r = await run(
      `export function test(): number {
         const b = String.fromCharCode(65);
         try { decodeURI("%"); } catch (e) { return e instanceof URIError ? 1 : 2; }
         return 0;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(1);
  });

  it("loop-driven decodeURI with helper + fromCharCode (S15.1.3.* module shape) is host-free", async () => {
    // Faithful to the S15.1.3.1 module structure — a percent-hex helper, a loop,
    // decodeURI over a runtime-built string, and String.fromCharCode — but over
    // VALID single-octet ASCII escapes so the run doesn't hit an (unrelated)
    // malformed-UTF8 URIError. The point of this case is the host-freeness of
    // the whole module shape, which is what leaked before the fix.
    const r = await run(
      `export function test(): number {
         function decimalToPercentHexString(n: number): string {
           const hex = "0123456789ABCDEF";
           return "%" + hex[(n >> 4) & 0x0F] + hex[n & 0x0F];
         }
         let ok = 0;
         for (let c = 0x41; c <= 0x43; c++) {           // 'A'..'C'
           const s = decimalToPercentHexString(c);       // "%41".."%43"
           if (decodeURI(s) === String.fromCharCode(c)) ok++;
         }
         return ok;
       }`,
    );
    expect(r.leaks).toEqual([]);
    expect(r.value).toBe(3);
  });
});
