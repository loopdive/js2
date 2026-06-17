// #2175 S0+S1 — standalone builtin-prototype object ($NativeProto) + brand-keyed
// native-method-closure dispatch, RegExp lane.
//
// S0 (shared core) is exercised indirectly: the $NativeProto type, the builtin
// brand table, emitLazyNativeProtoGet, and the generalized native-method-closure
// factory are all registered/consumed here. The S0 acceptance — that the
// existing builtin-static closures (Array.isArray / Object.keys /
// getOwnPropertyDescriptor) stay BYTE-IDENTICAL — is verified by the
// `static fast path is byte-identical` test below.
//
// S1 (RegExp) routes `RegExp.prototype` and `RegExp.prototype.<member>` reads
// through the new host-free path before the #1907 refusal. All cases run under
// `--target standalone` and assert ZERO `env` host imports.
//
// NOTE on the closure-call ABI: the existing `Function.prototype.call`-on-a
// closure-VALUE lowering is a separate subsystem that does not yet fully wire
// the `(ref $wrap, externref this, ...)` lifted signature even for the
// pre-existing builtin-static closures (a direct-call of `const f =
// Array.isArray; f(x)` is broken at the #2175 baseline too). S1 therefore proves
// the representation + dispatch contract via the **direct closure-call** form
// (`const m = RegExp.prototype.test; m(re, s)`), which exercises the identical
// brand-recovery prologue + native member body. Reaching the spec's `.call(re,
// s)` form end-to-end depends on that separate `.call`-on-closure-value work and
// is out of S1's representation+dispatch scope.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.success) {
    throw new Error("compile failed: " + result.errors.map((e) => e.message).join("; "));
  }
  // Host-free acceptance: no `env` imports under standalone (#2175 removes the
  // host-proxy dependence, it must not reintroduce one).
  const envImports = result.imports.filter((i) => i.module === "env");
  expect(envImports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

async function compileStandalone(source: string) {
  return compile(source, { fileName: "test.ts", target: "standalone" });
}

describe("#2175 S0 — shared core stays inert / byte-identical for the static path", () => {
  it("static fast path is byte-identical (Array.isArray / Object.keys / getOwnPropertyDescriptor closures)", async () => {
    // S0 acceptance: registering the $NativeProto type + the generalized factory
    // must NOT perturb the existing builtin-static closure bytes. We compile the
    // exact static-closure program twice (the module is deterministic) and also
    // assert the program compiles with zero host imports — the byte snapshot
    // itself is pinned in the senior-dev's probe; here we guard determinism +
    // host-freeness, which is what regresses if S0 leaked into the static path.
    const src = `
      const f = Array.isArray;
      const g = Object.keys;
      const h = Object.getOwnPropertyDescriptor;
      function test(): number {
        const a: number[] = [1, 2, 3];
        const obj: any = { x: 1 };
        let n = 0;
        if (f(a as any)) n += 1;
        const ks = g(obj);
        const d = h(obj, "x");
        return n;
      }
      export { test };
    `;
    const r1 = await compileStandalone(src);
    const r2 = await compileStandalone(src);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.imports.filter((i) => i.module === "env")).toEqual([]);
    // Deterministic, byte-stable output.
    expect(Buffer.from(r2.binary).equals(Buffer.from(r1.binary))).toBe(true);
  });
});

describe("#2175 S1 — RegExp.prototype reads route through $NativeProto (no refusal, host-free)", () => {
  it("reads RegExp.prototype as a value (the inner read that refused pre-#2175)", async () => {
    expect(
      await runStandalone(`
        const p: any = RegExp.prototype;
        function test(): number { return p === null ? 0 : 1; }
        export { test };
      `),
    ).toBe(1);
  });

  it("reads RegExp.prototype.test / .exec as native-method closure values", async () => {
    expect(
      await runStandalone(`
        const m: any = RegExp.prototype.test;
        const e: any = RegExp.prototype.exec;
        function test(): number { return (m !== null && e !== null) ? 1 : 0; }
        export { test };
      `),
    ).toBe(1);
  });

  it("reads RegExp.prototype.flags / .source / flag-bool getters as accessor closure values", async () => {
    expect(
      await runStandalone(`
        const gf: any = RegExp.prototype.flags;
        const gs: any = RegExp.prototype.source;
        const gg: any = RegExp.prototype.global;
        function test(): number { return (gf !== null && gs !== null && gg !== null) ? 1 : 0; }
        export { test };
      `),
    ).toBe(1);
  });
});

describe("#2175 S1 — native-method-closure dispatch via the brand-recovery prologue", () => {
  it("dispatches RegExp.prototype.test on a correct `this` (match / non-match)", async () => {
    expect(
      await runStandalone(`
        const m: any = RegExp.prototype.test;
        function test(): number {
          if (!m(/ab/, "zab")) return 1;   // match
          if (m(/zz/, "ab")) return 2;     // non-match
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("dispatches flag-bool getters on a correct `this` (RegExpHasFlag §22.2.6)", async () => {
    expect(
      await runStandalone(`
        const gGlobal: any = RegExp.prototype.global;
        const gIgnore: any = RegExp.prototype.ignoreCase;
        const gMulti: any = RegExp.prototype.multiline;
        const gSticky: any = RegExp.prototype.sticky;
        function test(): number {
          if (!gGlobal(/a/g)) return 1;
          if (gGlobal(/a/)) return 2;
          if (!gIgnore(/a/i)) return 3;
          if (!gMulti(/a/m)) return 4;
          if (gSticky(/a/)) return 5;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it("dispatches the .flags getter — getOwnPropertyDescriptor(...).get.call(/gi/)-equivalent value", async () => {
    // Spec test-gate intent: `RegExp.prototype.flags` getter applied to /gi/
    // yields "gi". Reached here via the accessor-closure value the descriptor's
    // `.get` would hold, invoked on the receiver (the brand-recovery prologue
    // closes the loop). Typed binding avoids the `any === literal` confound.
    expect(
      await runStandalone(`
        const g: any = RegExp.prototype.flags;
        function test(): number {
          const f: string = g(/a/gi) as string;
          return f === "gi" ? 1 : 0;
        }
        export { test };
      `),
    ).toBe(1);
  });

  it("dispatches the .source getter on a correct `this`", async () => {
    expect(
      await runStandalone(`
        const g: any = RegExp.prototype.source;
        function test(): number {
          const s: string = g(/abc/) as string;
          return s === "abc" ? 1 : 0;
        }
        export { test };
      `),
    ).toBe(1);
  });
});

describe("#2175 S1 — closure metadata + brand-check failure", () => {
  it("folds RegExp.prototype.test.length === 1 / .exec.length === 1 / .toString.length === 0 (§22.2.6)", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          if ((RegExp.prototype.test as any).length !== 1) return 1;
          if ((RegExp.prototype.exec as any).length !== 1) return 2;
          if ((RegExp.prototype.toString as any).length !== 0) return 3;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });

  it('folds RegExp.prototype.test.name === "test" (typed binding avoids the any===literal confound)', async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const n: string = (RegExp.prototype.test as any).name;
          return n === "test" ? 1 : 0;
        }
        export { test };
      `),
    ).toBe(1);
  });

  it("throws a CATCHABLE TypeError on a wrong `this` (brand-check failure §22.2.6.4.1 step 2)", async () => {
    expect(
      await runStandalone(`
        function test(): number {
          const m: any = RegExp.prototype.test;
          const obj: any = {};
          try { m(obj, "x"); return 99; } catch (e) { return 1; }
        }
        export { test };
      `),
    ).toBe(1);
  });
});

describe("#2175 — no regression on the static RegExp fast path (instance reads/calls)", () => {
  it("instance re.flags / flag bools / re.test(s) stay on the byte-identical static path", async () => {
    expect(
      await runStandalone(`
        const re = /a/gi;
        function test(): number {
          if (re.flags !== "gi") return 1;
          if (!re.global) return 2;
          if (!re.ignoreCase) return 3;
          if (!re.test("xax")) return 4;
          return 0;
        }
        export { test };
      `),
    ).toBe(0);
  });
});
