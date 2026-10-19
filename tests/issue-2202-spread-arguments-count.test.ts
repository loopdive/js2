// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2202 — `arguments.length` (and the spread element VALUES) were wrong for a
// call with a spread argument. The closure / method call ABI feeds the callee's
// `arguments` object via the `__argc` + `__extras_argv` globals; `emitSetExtrasArgv`
// (src/codegen/statements/nested-declarations.ts) built the extras array with a
// STATIC `array.new_fixed(args.length - startIdx)` count, so each spread node
// counted as ONE slot and the spread *source* was stored as a single element.
// `obj.m(42, ...[1], ...arr)` therefore reported `arguments.length === 2` (want 4)
// and `arguments[1..]` were wrong. (Not generator/trailing-comma specific — the
// trailing comma is grammar-only, §13.3.8.)
//
// Fix: `emitSetExtrasArgv` is now spread-aware. When any extra is a spread it
// builds the extras array with a RUNTIME length, expanding each spread source by
// representation — a typed WasmGC vec ref (`[1,2]` literal lowers to a tuple
// struct; `number[]`/`any[]` to a `__vec_`) is read field-by-field directly,
// while an opaque iterable is materialized through the native
// `__array_from_iter_n` and indexed. The native path is shared by the JS,
// standalone, and WASI environments. Non-spread calls keep the static path.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
  { label: "wasi", opts: { target: "wasi" } },
];

async function run(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2202 — arguments.length for spread call args", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it("object method: arguments.length with spread + trailing comma", async () => {
        expect(
          await run(
            `let log = 0;
             const obj = { m(): void { log = arguments.length; } };
             const arr = [1, 2, 3];
             export function test(): number { obj.m(...(arr as any),); return log; }`,
            opts,
          ),
        ).toBe(3);
      });

      it("generator method: arguments.length with spread", async () => {
        expect(
          await run(
            `let log = 0;
             const obj = { *m(): any { log = arguments.length; yield; } };
             const arr = [1, 2, 3];
             export function test(): number { obj.m(...(arr as any),).next(); return log; }`,
            opts,
          ),
        ).toBe(3);
      });

      it("class method: mixed fixed + multi-spread arguments.length", async () => {
        expect(
          await run(
            `let log = 0;
             class C { m(): void { log = arguments.length; } }
             const arr = [2, 3];
             export function test(): number { new C().m(42, ...([1] as any), ...(arr as any),); return log; }`,
            opts,
          ),
        ).toBe(4);
      });

      it("C.prototype.method: inline-literal spread arguments.length", async () => {
        expect(
          await run(
            `let log = 0;
             class C { m(): void { log = arguments.length; } }
             export function test(): number { C.prototype.m(...[1, 2, 3]); return log; }`,
            opts,
          ),
        ).toBe(3);
      });

      it("static class method: arguments.length with spread", async () => {
        expect(
          await run(
            `let log = 0;
             class C { static m(): void { log = arguments.length; } }
             const arr = [1, 2];
             export function test(): number { C.m(0, ...(arr as any)); return log; }`,
            opts,
          ),
        ).toBe(3);
      });

      it("spread element VALUES reach arguments[i]", async () => {
        // m(42, ...[1], ...[2,3]) → args [42,1,2,3]
        // encode length*1000 + a0*100 + a2*10 + a3 = 4000 + 4200 + 20 + 3 = 8223
        expect(
          await run(
            `let r = 0;
             class C { m(): void {
               r = arguments.length * 1000 + (arguments[0] as number) * 100 + (arguments[2] as number) * 10 + (arguments[3] as number);
             } }
             const arr = [2, 3];
             export function test(): number { new C().m(42, ...([1] as any), ...(arr as any)); return r; }`,
            opts,
          ),
        ).toBe(8223);
      });

      it("no-spread arguments.length is unchanged (regression guard)", async () => {
        expect(
          await run(
            `let log = 0;
             const obj = { m(): void { log = arguments.length; } };
             export function test(): number { obj.m(1, 2, 3); return log; }`,
            opts,
          ),
        ).toBe(3);
      });

      // (#2202 Stage 1) Free function call with spread + trailing comma where
      // the callee reads `arguments`. The direct-call spread dispatch took
      // `compileSpreadCallArgs` (positional-slot only) which dropped the
      // runtime extras and left a stray operand on the stack → the callee saw
      // `arguments.length === 0` and the call trapped with a null-deref. The
      // 0-user-param callee now routes through the `__argc`/`__extras_argv`
      // protocol like every method path. `function ref()` is hoisted INSIDE the
      // wrapper `test()` here, so it is a *lifted nested* function with capture
      // params already on the stack — the fix pads only the slots after the
      // capture region (over-padding the captures was the original null-deref).
      it("nested function decl: mixed fixed + multi-spread arguments.length", async () => {
        expect(
          await run(
            `export function test(): number {
               let log = 0;
               const arr = [2, 3];
               function ref(): void { log = arguments.length; }
               ref(42, ...([1] as any), ...(arr as any),);
               return log;
             }`,
            opts,
          ),
        ).toBe(4);
      });

      it("nested function decl: spread element VALUES reach arguments[i]", async () => {
        // ref(42, ...[1], ...[2,3]) → args [42,1,2,3]
        // length*1000 + a0*100 + a2*10 + a3 = 4000 + 4200 + 20 + 3 = 8223
        expect(
          await run(
            `export function test(): number {
               let r = 0;
               const arr = [2, 3];
               function ref(): void {
                 r = (arguments.length as number) * 1000 + (arguments[0] as number) * 100 + (arguments[2] as number) * 10 + (arguments[3] as number);
               }
               ref(42, ...([1] as any), ...(arr as any),);
               return r;
             }`,
            opts,
          ),
        ).toBe(8223);
      });

      it("nested generator function decl: mixed spread arguments.length", async () => {
        expect(
          await run(
            `export function test(): number {
               let log = 0;
               const arr = [2, 3];
               function* ref(): any { log = arguments.length; yield; }
               ref(42, ...([1] as any), ...(arr as any),).next();
               return log;
             }`,
            opts,
          ),
        ).toBe(4);
      });
    });
  }

  // An `any`-typed spread source is an opaque externref (not a typed vec ref),
  // so this exercises the native materializer and indexed readers rather than
  // the direct typed-vec projection above.
  for (const { label, opts } of MODES) {
    it(`[${label}] any-typed spread source expands by runtime length`, async () => {
      expect(
        await run(
          `let log = 0;
           let arr: any;
           class C { m(): void { log = arguments.length; } }
           export function test(): number { arr = [1, 2, 3, 4]; new C().m(...arr); return log; }`,
          opts,
        ),
      ).toBe(4);
    });
  }
});
