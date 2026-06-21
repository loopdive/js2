import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2029 — `DisposableStack`/`AsyncDisposableStack` static value reads crashed
// the standalone binary emitter instead of refusing loudly.
//
// These two explicit-resource-management constructors were absent from
// `BUILTIN_CTOR_NAMES` (`src/codegen/property-access.ts`). A static read such as
// `DisposableStack.prototype` therefore fell through BOTH the standalone
// built-in handler (refuse-loud / native proto) AND the host `__get_builtin`
// fallback, landing in a generic member path that emitted `global.get -1` (the
// -1 string-global sentinel) → `Binary emit error: global index out of range —
// -1` standalone, losing the whole file.
//
// Listing them routes the read to the dual-mode handler: a loud, located
// refusal standalone (no poisoned index — satisfies the #2029 "refuse loudly,
// never poison the encoder" criterion) and `__get_builtin` under gc/host. This
// matches every other builtin ctor (`Map.prototype`/`Map.length` already
// refuse-loud standalone).

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

function hasEncoderRangeCrash(r: Awaited<ReturnType<typeof compile>>): boolean {
  return r.errors.some((e) => /global index out of range/.test(e.message));
}

describe("#2029 DisposableStack/AsyncDisposableStack static read standalone", () => {
  it("DisposableStack.prototype does not crash the encoder (refuses loudly)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = DisposableStack.prototype; return 1; }`,
    );
    expect(hasEncoderRangeCrash(r)).toBe(false);
    if (!r.success) {
      expect(r.errors[0]?.message).toMatch(/DisposableStack\.prototype built-in static/);
    }
  });

  it("AsyncDisposableStack.prototype does not crash the encoder", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = AsyncDisposableStack.prototype; return 1; }`,
    );
    expect(hasEncoderRangeCrash(r)).toBe(false);
  });

  it("DisposableStack.prototype.move (chained) does not crash the encoder", async () => {
    const r = await compileStandalone(
      `export function test(): number { const p: any = DisposableStack.prototype.move; return 1; }`,
    );
    expect(hasEncoderRangeCrash(r)).toBe(false);
  });

  it("host (gc) mode still compiles DisposableStack.prototype", async () => {
    const r = await compile(`export function test(): number { const p: any = DisposableStack.prototype; return 1; }`, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    });
    expect(r.success).toBe(true);
  });

  it("new DisposableStack() still compiles standalone (unaffected)", async () => {
    const r = await compileStandalone(`export function test(): number { const s = new DisposableStack(); return 1; }`);
    expect(r.success).toBe(true);
  });
});
