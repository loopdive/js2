// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 — a no-catch finally must not catch and repeat its own throwing clone.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compileTryStatement } from "../src/codegen/statements/exceptions.js";
import { deduplicateLocals, restoreLocals, snapshotLocals } from "../src/codegen/context/locals.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
import type { Instr } from "../src/ir/types.js";
import { walkInstructions } from "../src/codegen/walk-instructions.js";

async function run(source: string, target: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5267.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...(target === "standalone" ? { target } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  if (target === "standalone") expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports.probe();
}

const completions = ["normal", "throw", "return", "break", "continue"] as const;

for (const target of ["gc", "standalone"] as const) {
  describe(`#5267 finally executes once (${target})`, () => {
    for (const completion of completions) {
      for (const throwingFinally of [false, true]) {
        for (const nested of [false, true]) {
          it(`${completion}, ${throwingFinally ? "throwing" : "normal"} finally, ${nested ? "nested-if" : "plain"} exit`, async () => {
            const abrupt = {
              normal: "",
              throw: "throw pending;",
              return: "return 7;",
              break: "break outer;",
              continue: "continue outer;",
            }[completion];
            const transfer = nested ? `if (true) { if (true) { ${abrupt} } }` : abrupt;
            const region = `try { trace = trace * 10 + 1; ${transfer} }
              finally { trace = trace * 10 + 2; ${throwingFinally ? "throw replacement;" : ""} }
              trace = trace * 10 + 3;`;
            // Module-init cases exercise direct statement lowering. Returns
            // necessarily use a function; both routes retain exact effects.
            const body =
              completion === "return"
                ? `function work() { ${region} return 8; } result = work();`
                : completion === "break" || completion === "continue"
                  ? `outer: for (var i = 0; i < 1; i++) { ${region} } result = 8;`
                  : `${region} result = 8;`;
            const expectedTrace = completion === "normal" && !throwingFinally ? 123 : 12;
            const expectedResult = throwingFinally || completion === "throw" ? 0 : completion === "return" ? 7 : 8;
            const expectedIdentity = throwingFinally ? 2 : completion === "throw" ? 1 : 0;
            expect(
              await run(
                `
              var trace = 0, result = 0, identity = 0;
              var pending = { sentinel: 1 }, replacement = { sentinel: 2 };
              try { ${body} } catch (e) {
                identity = e === replacement ? 2 : e === pending ? 1 : 9;
              }
              export function probe() { return trace * 100 + result * 10 + identity; }
            `,
                target,
              ),
            ).toBe(expectedTrace * 100 + expectedResult * 10 + expectedIdentity);
          });
        }
      }
    }

    it("resets on repeated loop entry before a later pending throw", async () => {
      expect(
        await run(
          `
        var trace = 0, identity = 0, sentinel = { sentinel: 1 };
        for (var i = 0; i < 3; i++) {
          try {
            try { if (i === 1) throw sentinel; }
            finally { trace = trace * 10 + i + 1; }
          } catch (e) { if (e === sentinel) identity++; }
        }
        export function probe() { return trace * 10 + identity; }
      `,
          target,
        ),
      ).toBe(1231);
    });

    it("nested finalizers each run once and outer replacement preserves identity", async () => {
      expect(
        await run(
          `
        var trace = 0, identity = 0;
        var first = { sentinel: 1 }, inner = { sentinel: 2 }, outer = { sentinel: 3 };
        try {
          try {
            try { trace = 1; throw first; }
            finally { trace = trace * 10 + 2; throw inner; }
          } finally { trace = trace * 10 + 3; throw outer; }
        } catch (e) { identity = e === outer ? 1 : 9; }
        export function probe() { return trace * 10 + identity; }
      `,
          target,
        ),
      ).toBe(1231);
    });

    it("recursive calls have independent finally state", async () => {
      expect(
        await run(
          `
        var trace = 0, identity = 0, sentinel = { sentinel: 1 };
        function descend(n) {
          try { if (n > 0) descend(n - 1); }
          finally { trace = trace * 10 + n + 1; throw sentinel; }
        }
        try { descend(2); } catch (e) { identity = e === sentinel ? 1 : 9; }
        export function probe() { return trace * 10 + identity; }
      `,
          target,
        ),
      ).toBe(1231);
    });

    it("nested-loop clones retain break/continue depths", async () => {
      expect(
        await run(
          `
        var trace = 0;
        outer: for (var i = 0; i < 2; i++) {
          for (var j = 0; j < 2; j++) {
            try { if (true) { if (true) { break; } } }
            finally { trace = trace * 10 + i + 1; if (i === 0) continue outer; else break outer; }
          }
          trace = 999;
        }
        export function probe() { return trace; }
      `,
          target,
        ),
      ).toBe(12);
    });

    for (const finalCompletion of ["return", "break", "continue"] as const) {
      it(`a finally ${finalCompletion} overrides a nested pending throw`, async () => {
        const transfer = finalCompletion === "return" ? "return 7;" : `${finalCompletion} outer;`;
        expect(
          await run(
            `
          var trace = 0, caught = 0, result = 0;
          function work() {
            outer: for (var i = 0; i < 1; i++) {
              try { if (true) { if (true) { trace = 1; throw 9; } } }
              finally { trace = trace * 10 + 2; ${transfer} }
              trace = 999;
            }
            return 8;
          }
          try { result = work(); } catch (e) { caught = 1; }
          export function probe() { return trace * 100 + result * 10 + caught; }
        `,
            target,
          ),
        ).toBe(finalCompletion === "return" ? 1270 : 1280);
      });
    }

    it("source names, closure reads and literal direct-eval reads stay visible", async () => {
      // Global module-init eval reads fail on the unchanged baseline too.
      // Function-local bindings exercise the private-slot lookup invariant
      // without depending on that unrelated global-eval capability (#5267 MD).
      expect(
        await run(
          `
        export function probe() {
          var __finally_entered_0 = 4, finally$entered$0 = 5, observed = 0, count = 0;
          var sentinel = { sentinel: 1 };
          var read = function() { return __finally_entered_0 + finally$entered$0; };
          try { try {} finally { count++; observed = read() + eval("__finally_entered_0 + finally$entered$0"); throw sentinel; } }
          catch (e) { if (e !== sentinel) return -1; }
          if (count !== 1) return -2;
          return observed;
        }
      `,
          target,
        ),
      ).toBe(18);
    });

    it("a normal finally preserves a pending throw by object identity", async () => {
      expect(
        await run(
          `
        var count = 0, identity = 0, sentinel = { sentinel: 1 };
        try { try { throw sentinel; } finally { count++; } }
        catch (e) { identity = e === sentinel ? 1 : 9; }
        export function probe() { return count * 10 + identity; }
      `,
          target,
        ),
      ).toBe(11);
    });

    it("generator IteratorClose happens once after a throwing consumer finally", async () => {
      expect(
        await run(
          `
        var count = 0, closed = 0, identity = 0, sentinel = { sentinel: 1 };
        function* values() { try { yield 1; } finally { closed++; } }
        try { for (var value of values()) { try {} finally { count++; throw sentinel; } } }
        catch (e) { identity = e === sentinel ? 1 : 9; }
        export function probe() { return count * 100 + closed * 10 + identity; }
      `,
          target,
        ),
      ).toBe(111);
    });
  });
}

function emptyRegion(standardized: boolean) {
  // Empty blocks need no checker or runtime helpers; use the real statement
  // emitter to inspect its private-slot contract in both EH encodings.
  const ctx = { exnTagIdx: 0, standalone: standardized, wasi: false } as CodegenContext;
  const fctx = {
    params: [{ name: "argument", type: { kind: "i32" } }],
    locals: [],
    localMap: new Map(),
    body: [],
    savedBodies: [],
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    tempFreeList: new Map(),
  } as unknown as FunctionContext;
  const file = ts.createSourceFile("empty.js", "try {} finally {}", ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stmt = file.statements[0] as ts.TryStatement;
  return { ctx, fctx, emit: () => compileTryStatement(ctx, fctx, stmt) };
}

function flatten(body: Instr[]): Instr[] {
  const result: Instr[] = [];
  walkInstructions(body, (instr) => result.push(instr));
  return result;
}

describe("#5267 private marker and handler structure", () => {
  for (const standardized of [false, true]) {
    it(`resets outside protection, prepends fresh clone writes and never registers a source/temp name (${standardized})`, () => {
      const { fctx, emit } = emptyRegion(standardized);
      emit();
      expect(fctx.locals[0]).toEqual({ name: "finally@entered$1", type: { kind: "i32" } });
      expect(fctx.localMap.has("finally@entered$1")).toBe(false);
      expect(fctx.tempFreeList?.size).toBe(0);
      expect(fctx.body.slice(0, 2)).toEqual([
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 1 },
      ]);
      expect(fctx.body[2]!.op).toBe(standardized ? "block" : "try");
      const writes = flatten(fctx.body).filter((i) => i.op === "local.set" && i.index === 1);
      expect(writes).toHaveLength(3); // reset, normal clone, handler clone
      expect(new Set(writes).size).toBe(3);
      expect(fctx.savedBodies).toEqual([]);
      expect(fctx.breakStack).toEqual([]);
      expect(fctx.continueStack).toEqual([]);
      if (!standardized) {
        const region = fctx.body[2]!;
        expect(region.op).toBe("try");
        if (region.op !== "try") throw new Error("expected legacy try");
        expect(region.catchAll?.slice(0, 2)).toEqual([
          { op: "local.get", index: 1 },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "rethrow", depth: 1 }] },
        ]);
        expect(region.catchAll?.at(-1)).toEqual({ op: "rethrow", depth: 0 });
      } else {
        const guard = flatten(fctx.body).find((i) => i.op === "if");
        expect(guard?.op).toBe("if");
        if (guard?.op !== "if") throw new Error("expected payload guard");
        expect(guard.then).toEqual([
          { op: "local.get", index: 2 },
          { op: "throw", tagIdx: 0 },
        ]);
      }
    });

    it(`distinct slots survive numeric remapping and rollback (${standardized})`, () => {
      const { fctx, emit } = emptyRegion(standardized);
      fctx.locals.push({ name: "__duplicate", type: { kind: "i32" } }, { name: "__duplicate", type: { kind: "i32" } });
      emit();
      const first = fctx.locals.find((l) => l.name.startsWith("finally@"))!;
      emit();
      const markers = fctx.locals.filter((l) => l.name.startsWith("finally@"));
      expect(markers).toHaveLength(2);
      expect(markers[0]).toBe(first);
      expect(markers[0]!.name).not.toBe(markers[1]!.name);
      deduplicateLocals(fctx);
      for (const marker of markers) {
        const index = fctx.params.length + fctx.locals.indexOf(marker);
        expect(flatten(fctx.body).filter((i) => i.op === "local.set" && i.index === index)).toHaveLength(3);
        expect(fctx.localMap.has(marker.name)).toBe(false);
      }
      // Rollback is a separate fresh context: locals snapshots precede
      // deduplication in production, and callers discard tentative bodies.
      const rolled = emptyRegion(standardized);
      const rollback = snapshotLocals(rolled.fctx);
      rolled.emit();
      restoreLocals(rolled.fctx, rollback);
      rolled.fctx.body.length = 0;
      rolled.emit();
      expect(rolled.fctx.locals[0]!.name).toBe("finally@entered$1");
      expect(rolled.fctx.body[1]).toEqual({ op: "local.set", index: 1 });
    });
  }
});

describe("#5267 legacy catch_all preserves foreign host exceptions", () => {
  for (const fromFinally of [false, true]) {
    it(`propagates a host exception from ${fromFinally ? "finally" : "try"} with one finalizer execution`, async () => {
      const result = await compile(
        `
        var count = 0;
        try { ${fromFinally ? "" : "console.log(1);"} }
        finally { count++; ${fromFinally ? "if (true) { if (true) { console.log(1); } }" : ""} }
        export function probe() { return count; }
      `,
        { allowJs: true, fileName: "issue-5267-host.js", skipSemanticDiagnostics: true, deferTopLevelInit: true },
      );
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(result.imports.some((i) => i.module === "env" && i.name === "console_log_number")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const sentinel = new Error("foreign host sentinel");
      let calls = 0;
      imports.env.console_log_number = () => {
        calls++;
        throw sentinel;
      };
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const exports = instance.exports as Record<string, () => unknown>;
      let caught: unknown;
      try {
        exports.__module_init();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBe(sentinel);
      expect(calls).toBe(1);
      expect(exports.probe()).toBe(1);
    });
  }
});
