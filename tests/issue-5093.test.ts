// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5093 — a spread call into a method that HAS formals.
//
// #4782 fixed the ZERO-formal arm (`emitSetExtrasArgv`). The other arm —
// `methodParamCount > 0`, which routes to `compileSpreadCallArgs` — was broken
// in four distinguishable ways, all pre-existing at 655b3ab2ef:
//
//   1. `arguments` read `null` for every spread-sourced element (the arm never
//      published `__extras_argv` at all);
//   2. `arguments.length` counted each spread NODE as one argument;
//   3. an inline-literal spread (`...[1]`) contributed NOTHING to the formals,
//      so `method(a, b)` took its `b` from the NEXT spread — an off-by-one that
//      is really a dropped argument; and
//   4. when nothing else filled the slot, the same dropped argument left the
//      call with fewer operands than the callee's arity: an INVALID module
//      ("not enough arguments on the stack"), i.e. a hard instantiate error.
//
// Root causes: (3)/(4) an inline array literal lowers to a TUPLE struct
// (`_0`, `_1`, …), which `compileSpreadCallArgs`'s vec readers cannot expand;
// (1)/(2) the formal-ful arm never routed through the `__argc`/`__extras_argv`
// protocol, whose split point is a RUNTIME value once a spread is involved.
//
// node is the oracle for every value below.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

type Mode = { readonly name: string; readonly standalone?: boolean };
const MODES: readonly Mode[] = [{ name: "host" }, { name: "standalone", standalone: true }];

async function runModule(src: string, mode: Mode = { name: "host" }): Promise<unknown> {
  const result = await compileMulti({ "./main.js": src }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...(mode.standalone ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors?.map((e) => e.message).join("; ")).toBe(true);
  // Every shape must produce a module that VALIDATES — defect 4 was a hard
  // instantiate failure, not a wrong value.
  expect(WebAssembly.validate(result.binary), "binary should validate").toBe(true);
  const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (imports as { setInstance?: (i: unknown) => void }).setInstance?.(instance);
  (imports as { __setExports?: (e: unknown) => void }).__setExports?.(instance.exports);
  (instance.exports as Record<string, Function>).__module_init?.();
  const wrapped = wrapExports(instance.exports as Record<string, Function>) as Record<string, () => unknown>;
  return wrapped.t!();
}

const SUM_BODY = "arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3]";
const MIXED_CALL_TAIL = "const tail = [2, 3];";

describe("#5093 — spread into a formal-ful callee", () => {
  for (const mode of MODES) {
    describe(mode.name, () => {
      // ── Defect 1: `arguments` contents, across every receiver shape. ──────
      it("D1 class prototype receiver: mixed spread fills `arguments`", async () => {
        // 4 + 42 + 1 + 2 + 3. Was `null` (no extras vec was ever published).
        expect(
          await runModule(
            `class C { method(a) { return ${SUM_BODY}; } }
             export function t() { ${MIXED_CALL_TAIL} return C.prototype.method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(52);
      });

      it("D1 instance receiver: mixed spread fills `arguments`", async () => {
        expect(
          await runModule(
            `class C { method(a) { return ${SUM_BODY}; } }
             export function t() { ${MIXED_CALL_TAIL} return new C().method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(52);
      });

      it("D1 plain function: mixed spread fills `arguments`", async () => {
        expect(
          await runModule(
            `function f(a) { return ${SUM_BODY}; }
             export function t() { ${MIXED_CALL_TAIL} return f(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(52);
      });

      it("CONTROL object-literal method stays correct", async () => {
        // Already correct before the fix — pinned so the fix cannot trade one
        // receiver shape for another.
        expect(
          await runModule(
            `const o = { method(a) { return ${SUM_BODY}; } };
             export function t() { ${MIXED_CALL_TAIL} return o.method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(52);
      });

      it("CANARY zero-formal arm (#4782) is undisturbed", async () => {
        expect(
          await runModule(
            `class C { method() { return ${SUM_BODY}; } }
             export function t() { ${MIXED_CALL_TAIL} return C.prototype.method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(52);
      });

      // ── Defect 2: the spread contributes its RUNTIME element count. ───────
      it("D2 `arguments.length` counts spread elements, not spread nodes", async () => {
        // 42, 1, 2, 3 → 4. Was 1 (the formal count; each spread counted as 0).
        expect(
          await runModule(
            `class C { method(a) { return arguments.length; } }
             export function t() { ${MIXED_CALL_TAIL} return C.prototype.method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(4);
      });

      it("D2 a short call reports fewer arguments than formals", async () => {
        // `arguments.length` is 1 even though the callee declares two params.
        expect(
          await runModule(
            `class C { method(a, b) { return arguments.length * 100 + a + (b === undefined ? 7 : 0); } }
             export function t() { return C.prototype.method(...[1]); }`,
            mode,
          ),
        ).toBe(108);
      });

      it("D2 an empty spread contributes nothing", async () => {
        expect(
          await runModule(
            `class C { method(a) { return arguments.length * 100 + (a === undefined ? 7 : 0); } }
             export function t() { const tail = []; return C.prototype.method(...tail); }`,
            mode,
          ),
        ).toBe(7);
      });

      // ── Defect 3: formals bind by position AFTER the spread is flattened. ─
      it("D3 two formals bind by position across a literal spread", async () => {
        // a = 42, b = 1. Was 44: `...[1]` was dropped and `b` took tail[0] = 2.
        expect(
          await runModule(
            `class C { method(a, b) { return a + b; } }
             export function t() { ${MIXED_CALL_TAIL} return C.prototype.method(42, ...[1], ...tail,); }`,
            mode,
          ),
        ).toBe(43);
      });

      it("D3 a literal spread fills BOTH formals", async () => {
        expect(
          await runModule(
            `class C { method(a, b) { return a * 10 + b; } }
             export function t() { return C.prototype.method(...[7, 8]); }`,
            mode,
          ),
        ).toBe(78);
      });

      it("D3 a literal spread followed by a trailing positional", async () => {
        expect(
          await runModule(
            `class C { method(a, b) { return a * 10 + b; } }
             export function t() { return C.prototype.method(...[7], 8); }`,
            mode,
          ),
        ).toBe(78);
      });

      it("D3 a RUNTIME-length spread straddles two formals", async () => {
        // a = 1, b = 2, arguments.length = 3 — the split point is dynamic.
        expect(
          await runModule(
            `class C { method(a, b) { return a * 10 + b + arguments.length; } }
             export function t() { const tail = [1, 2, 3]; return C.prototype.method(...tail); }`,
            mode,
          ),
        ).toBe(15);
      });

      // ── Defect 4: no spread shape may emit an invalid module. ─────────────
      it("D4 literal-only spread into a single formal validates and binds", async () => {
        // Was: WebAssembly.instantiate() — "not enough arguments on the stack
        // for local.set". `runModule` asserts validity for every case.
        expect(
          await runModule(
            `class C { method(a) { return a; } }
             export function t() { return C.prototype.method(...[7, 8]); }`,
            mode,
          ),
        ).toBe(7);
      });

      it("D4 the same shape on an instance receiver", async () => {
        expect(
          await runModule(
            `class C { method(a) { return a; } }
             export function t() { return new C().method(...[7, 8]); }`,
            mode,
          ),
        ).toBe(7);
      });

      it("D4 a defaulted parameter survives a short literal spread", async () => {
        expect(
          await runModule(
            `class C { method(a, b = 9) { return a * 100 + b * 10 + arguments.length; } }
             export function t() { return C.prototype.method(...[1]); }`,
            mode,
          ),
        ).toBe(191);
      });

      // ── Shapes that must not regress. ─────────────────────────────────────
      it("REG a spread source is evaluated exactly once", async () => {
        expect(
          await runModule(
            `let n = 0;
             function src() { n++; return [1, 2]; }
             class C { method(a) { return arguments.length * 100 + a; } }
             export function t() { const r = C.prototype.method(...src()); return r + n; }`,
            mode,
          ),
        ).toBe(202);
      });

      it("REG a spread followed by a trailing positional reaches `arguments`", async () => {
        expect(
          await runModule(
            `class C { method(a) { return arguments.length * 100 + arguments[0] + arguments[1] + arguments[2]; } }
             export function t() { const tail = [1, 2]; return C.prototype.method(...tail, 9); }`,
            mode,
          ),
        ).toBe(312);
      });

      it("REG a class method's `arguments` stays UNMAPPED (class bodies are strict)", async () => {
        // node: `arguments[0] = 5` does NOT reflect into `a`, so 1 + 2 = 3.
        expect(
          await runModule(
            `class C { method(a) { arguments[0] = 5; return a + arguments.length; } }
             export function t() { const tail = [1, 2]; return C.prototype.method(...tail); }`,
            mode,
          ),
        ).toBe(3);
      });

      it("REG a formal read AFTER an `arguments` write is unaffected by the spread", async () => {
        // Sloppy-mode MAPPED `arguments` write-back is a separate, pre-existing
        // gap (`f(1)` with no spread at all answers the same way), so this pins
        // only what this issue owns: the spread call binds `a` and counts the
        // arguments exactly as the identical non-spread call does.
        expect(
          await runModule(
            `function f(a) { return a + arguments.length; }
             export function t() { const tail = [1, 2]; return f(...tail) * 10 + f(1, 2); }`,
            mode,
          ),
        ).toBe(33);
      });

      it("REG a callee that ignores `arguments` keeps its positional lowering", async () => {
        expect(
          await runModule(
            `class C { method(a, b) { return a * 10 + b; } }
             export function t() { const tail = [1, 2, 3]; return C.prototype.method(...tail); }`,
            mode,
          ),
        ).toBe(12);
      });

      it("REG a plain function binds two formals across a mixed spread", async () => {
        expect(
          await runModule(
            `function f(a, b) { return a * 100 + b * 10 + arguments.length; }
             export function t() { ${MIXED_CALL_TAIL} return f(1, ...tail); }`,
            mode,
          ),
        ).toBe(123);
      });

      it("REG a nested spread call inside a spread call", async () => {
        expect(
          await runModule(
            `class C { method(a) { return arguments.length * 10 + a; } }
             function inner() { return [3, 4]; }
             export function t() { return C.prototype.method(...inner()) + C.prototype.method(1, ...inner()); }`,
            mode,
          ),
        ).toBe(54);
      });

      it("REG three formals, short runtime spread", async () => {
        expect(
          await runModule(
            `class C { method(a, b, c) { return arguments.length * 100 + a + (b === undefined ? 20 : 0) + (c === undefined ? 3 : 0); } }
             export function t() { const tail = [1]; return C.prototype.method(...tail); }`,
            mode,
          ),
        ).toBe(124);
      });
    });
  }

  // ── Host-only: value shapes the standalone lane still lowers wrongly. ─────
  // These fail on the standalone lane for reasons OUTSIDE this issue (string
  // and null element carriers through the extras vec — the same shapes are
  // wrong on the zero-formal arm there too). They are pinned host-only rather
  // than skipped so the formal-ful arm keeps real coverage for them.
  describe("host-only value carriers", () => {
    it("a string formal comes through the flattened list", async () => {
      expect(
        await runModule(
          `class C { method(s) { return s + "|" + arguments.length + "|" + arguments[1]; } }
           export function t() { return C.prototype.method(...["x", "y"]); }`,
        ),
      ).toBe("x|2|y");
    });

    it("booleans and nulls survive the roundtrip", async () => {
      expect(
        await runModule(
          `class C { method(a) { return (a === true ? 1 : 0) + (arguments[1] === null ? 20 : 0) + arguments.length * 100; } }
           export function t() { return C.prototype.method(...[true, null]); }`,
        ),
      ).toBe(221);
    });

    it("a spread of a string iterates into the formals", async () => {
      expect(
        await runModule(
          `class C { method(a) { return arguments.length * 10 + (a === "a" ? 1 : 0); } }
           export function t() { return C.prototype.method(..."ab"); }`,
        ),
      ).toBe(21);
    });
  });
});
