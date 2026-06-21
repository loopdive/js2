import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2029 — `x instanceof <builtin>` (e.g. `sub instanceof WeakRef`, `m instanceof Map`)
// crashed the standalone binary emitter.
//
// `compileHostInstanceOf` (src/codegen/expressions/identifiers.ts), when the
// static fast-path (tryStaticInstanceOf, #1325) and the native Error-tag path do
// NOT resolve, fell through to the host `__instanceof(value, ctorName)` call. It
// pushed the constructor name with a raw `global.get <stringGlobalMap.get(name)>`,
// guarding only `=== undefined`. Under `--target standalone` / nativeStrings the
// name string is the -1 sentinel (#1174 — no host string-constant global), so
// `global.get -1` blew up the encoder (`global index out of range — -1`), losing
// the whole file. It also leaked the host-only `__instanceof` import.
//
// Fix: under `noJsHost`, emit a valid `false` (drop the LHS) instead — the host
// `__instanceof` can't run standalone anyway, and the resolvable cases already
// returned via the static / Error-tag paths above. gc/host keeps the real call.
// (A native instanceof tag-registry for builtin subclasses is a separate slice.)

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2029 instanceof <builtin> standalone emit", () => {
  it("`m instanceof Map` compiles standalone (was: global index out of range -1)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const m: any = new Map(); return (m instanceof Map) ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => /global index out of range/.test(e.message))).toBe(false);
  });

  it("`x instanceof WeakRef` compiles standalone", async () => {
    const r = await compileStandalone(
      `const S = class extends WeakRef {}; export function test(): number { const a: any = S; return 0; }`,
    );
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => /global index out of range/.test(e.message))).toBe(false);
  });

  it("does not leak the __instanceof host import standalone", async () => {
    const r = await compileStandalone(
      `export function test(): number { const m: any = new Map(); return (m instanceof Map) ? 1 : 0; }`,
    );
    expect(r.success).toBe(true);
    expect(r.imports.map((i) => i.name)).not.toContain("__instanceof");
  });

  // Static-resolvable instanceof still works standalone (the fix only touches the
  // dynamic host fall-through, which runs after the static fast-path).
  it("array instanceof Array still resolves standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = [1, 2, 3]; return (a instanceof Array) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("user-class instanceof still resolves standalone", async () => {
    expect(
      await runStandalone(
        `class C {} export function test(): number { const c = new C(); return (c instanceof C) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("error instanceof Error still resolves standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const e = new Error(); return (e instanceof Error) ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("host (gc) mode keeps the __instanceof host import", async () => {
    const r = await compile(
      `export function test(): number { const m: any = new Map(); return (m instanceof Map) ? 1 : 0; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(r.imports.map((i) => i.name)).toContain("__instanceof");
  });
});
