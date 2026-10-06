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
  // Exercise the real statement emitter; empty blocks need no checker.
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
  return { fctx, emit: () => compileTryStatement(ctx, fctx, stmt) };
}

function flatten(body: Instr[]): Instr[] {
  const result: Instr[] = [];
  walkInstructions(body, (instr) => result.push(instr));
  return result;
}

function slot(fctx: FunctionContext, index: number) {
  expect(Number.isInteger(index)).toBe(true);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(index).toBeLessThan(fctx.params.length + fctx.locals.length);
  return index < fctx.params.length ? fctx.params[index]! : fctx.locals[index - fctx.params.length]!;
}

function balanced(fctx: FunctionContext) {
  expect(fctx.savedBodies).toEqual([]);
  expect(fctx.breakStack).toEqual([]);
  expect(fctx.continueStack).toEqual([]);
  expect(fctx.finallyStack ?? []).toEqual([]);
}

function ownHandler(body: Instr[], standardized: boolean) {
  const regions = body.filter((i) => i.op === (standardized ? "block" : "try"));
  expect(regions).toHaveLength(1);
  const region = regions[0]!;
  if (!standardized) {
    if (region.op !== "try") throw new Error("expected own legacy try");
    expect(region.catches ?? []).toEqual([]);
    expect(region.catchAll?.length).toBeGreaterThan(0);
    if (!region.catchAll) throw new Error("missing own catch_all");
    return { region, protectedBody: region.body, handler: region.catchAll };
  }
  if (region.op !== "block") throw new Error("expected own standard join block");
  expect(region.blockType).toEqual({ kind: "empty" });
  const payloadBlock = region.body[0];
  if (payloadBlock?.op !== "block") throw new Error("missing payload-result block");
  expect(payloadBlock.blockType).toEqual({ kind: "val", type: { kind: "externref" } });
  expect(payloadBlock.body).toHaveLength(2);
  const protectedTry = payloadBlock.body[0];
  if (protectedTry?.op !== "try_table") throw new Error("missing protected try_table");
  expect(protectedTry.catches).toEqual([{ kind: "catch", tagIdx: 0, depth: 0 }]);
  expect(payloadBlock.body[1]).toEqual({ op: "br", depth: 1 });
  expect(region.body.at(-1)).toEqual({ op: "br", depth: 0 });
  return { region, protectedBody: protectedTry.body, handler: region.body.slice(1, -1) };
}

function checkRegion(fctx: FunctionContext, body: Instr[], standardized: boolean) {
  const { region, protectedBody, handler } = ownHandler(body, standardized);
  const markerRead = handler[standardized ? 1 : 0];
  if (markerRead?.op !== "local.get") throw new Error("missing leading marker read");
  const marker = markerRead.index;
  expect(slot(fctx, marker).type.kind).toBe("i32");
  const guard = handler[standardized ? 2 : 1];
  if (guard?.op !== "if") throw new Error("missing own handler guard");
  expect(guard.blockType).toEqual({ kind: "empty" });
  expect(guard.else ?? []).toEqual([]);
  let payload: number | undefined;
  if (standardized) {
    expect(handler).toHaveLength(5);
    const capture = handler[0];
    if (capture?.op !== "local.set") throw new Error("missing pending payload capture");
    payload = capture.index;
    expect(slot(fctx, payload).type.kind).toBe("externref");
    expect(payload).not.toBe(marker);
    expect(guard.then).toEqual([
      { op: "local.get", index: payload },
      { op: "throw", tagIdx: 0 },
    ]);
    expect(handler.slice(3)).toEqual([
      { op: "local.get", index: payload },
      { op: "throw", tagIdx: 0 },
    ]);
    expect(flatten(handler).some((i) => i.op === "rethrow")).toBe(false);
    const gets = flatten(handler).filter((i) => i.op === "local.get" && i.index === payload);
    expect(gets).toHaveLength(2);
    expect(new Set(gets).size).toBe(2);
  } else {
    expect(handler).toHaveLength(3);
    expect(guard.then).toEqual([{ op: "rethrow", depth: 1 }]);
    expect(handler[2]).toEqual({ op: "rethrow", depth: 0 });
  }
  const reset = [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: marker },
  ];
  const before = body.slice(0, body.indexOf(region));
  const resetInside = JSON.stringify(protectedBody.slice(0, 2)) === JSON.stringify(reset);
  const resetOutside = JSON.stringify(before.slice(-2)) === JSON.stringify(reset);
  expect(Number(resetInside) + Number(resetOutside)).toBe(1);
  const resetStore = (resetInside ? protectedBody : before)[resetInside ? 1 : before.length - 1]!;
  const markPositions = protectedBody
    .flatMap((i, n) => (i.op === "local.set" && i.index === marker ? [n] : []))
    .filter((n) => !(resetInside && n === 1));
  expect(markPositions).toHaveLength(1);
  const markPosition = markPositions[0]!;
  expect(markPosition).toBeGreaterThan(resetInside ? 1 : 0);
  expect(protectedBody[markPosition - 1]).toEqual({ op: "i32.const", value: 1 });
  const markStore = protectedBody[markPosition]!;
  const writes = flatten(body).filter((i) => (i.op === "local.set" || i.op === "local.tee") && i.index === marker);
  expect(writes).toHaveLength(2);
  expect(writes.includes(resetStore)).toBe(true);
  expect(writes.includes(markStore)).toBe(true);
  expect(new Set(writes).size).toBe(2);
  for (const i of flatten(body)) {
    if (i.op === "local.get" || i.op === "local.set" || i.op === "local.tee") slot(fctx, i.index);
  }
  balanced(fctx);
  return { marker, payload, markerLocal: slot(fctx, marker) };
}

function privateMarker(fctx: FunctionContext, marker: number, sourceName: string) {
  const local = slot(fctx, marker);
  expect(marker).toBeGreaterThanOrEqual(fctx.params.length);
  expect(local.name).toContain("@");
  expect(local.name.startsWith("__")).toBe(false);
  expect(local.name).not.toBe(sourceName);
  expect([...fctx.localMap.values()]).not.toContain(marker);
  for (const bucket of fctx.tempFreeList?.values() ?? []) expect(bucket).not.toContain(marker);
  return local;
}

describe("#5267 private marker and handler structure", () => {
  for (const standardized of [false, true]) {
    it(`resets on entry and guards own handlers without replacing the pending exception (${standardized})`, () => {
      const { fctx, emit } = emptyRegion(standardized);
      emit();
      checkRegion(fctx, fctx.body, standardized);
    });

    it(`private guard slots preserve source bindings through remapping and rollback (${standardized})`, () => {
      // Sequential positive: duplicates precede both markers so dedup must shift them.
      const sequential = emptyRegion(standardized);
      sequential.fctx.locals.push(
        { name: "__duplicate", type: { kind: "i32" } },
        { name: "__duplicate", type: { kind: "i32" } },
      );
      const retainedDuplicate = sequential.fctx.locals[0]!;
      const slices: { start: number; end: number; marker: number; local: ReturnType<typeof slot> }[] = [];
      for (let n = 0; n < 2; n++) {
        const start = sequential.fctx.body.length;
        sequential.emit();
        const end = sequential.fctx.body.length;
        const checked = checkRegion(sequential.fctx, sequential.fctx.body.slice(start, end), standardized);
        privateMarker(sequential.fctx, checked.marker, "__duplicate");
        slices.push({ start, end, marker: checked.marker, local: checked.markerLocal });
      }
      expect(slices[0]!.local).not.toBe(slices[1]!.local);
      const duplicateRead: Instr = { op: "local.get", index: 2 };
      sequential.fctx.body.push(duplicateRead, { op: "drop" });
      const beforeCount = sequential.fctx.locals.length;
      deduplicateLocals(sequential.fctx);
      expect(sequential.fctx.locals.length, "sequential: actual duplicate removal").toBe(beforeCount - 1);
      expect(slot(sequential.fctx, duplicateRead.index)).toBe(retainedDuplicate);
      for (const slice of slices) {
        const after = checkRegion(sequential.fctx, sequential.fctx.body.slice(slice.start, slice.end), standardized);
        expect(after.marker, "sequential: shifted marker").toBe(slice.marker - 1);
        expect(after.markerLocal).toBe(slice.local);
        // localMap is a codegen map, not a post-dedup index contract.
        expect(after.markerLocal.name).toContain("@");
        expect(after.markerLocal.name.startsWith("__")).toBe(false);
      }
      for (const i of flatten(sequential.fctx.body)) {
        if (i.op === "local.get" || i.op === "local.set" || i.op === "local.tee") slot(sequential.fctx, i.index);
      }

      for (const booleanBrand of [false, true]) {
        const collision = emptyRegion(standardized);
        const sourceName = "__finally_ran_1";
        const source = {
          name: sourceName,
          type: booleanBrand ? { kind: "i32" as const, boolean: true as const } : { kind: "i32" as const },
        };
        collision.fctx.locals.push(source);
        collision.fctx.localMap.set(sourceName, 1);
        const priorMap = [...collision.fctx.localMap];
        collision.emit();
        const regionEnd = collision.fctx.body.length;
        const first = checkRegion(collision.fctx, collision.fctx.body, standardized);
        expect(first.marker, `source-local: booleanBrand=${booleanBrand}`).not.toBe(1);
        expect(slot(collision.fctx, 1)).toBe(source);
        expect(slot(collision.fctx, 1).type).toEqual(booleanBrand ? { kind: "i32", boolean: true } : { kind: "i32" });
        for (const [name, index] of priorMap) expect(collision.fctx.localMap.get(name)).toBe(index);
        const markerLocal = privateMarker(collision.fctx, first.marker, sourceName);
        const sourceRead: Instr = { op: "local.get", index: 1 };
        const tempIndex = collision.fctx.params.length + collision.fctx.locals.length;
        collision.fctx.locals.push(
          { name: "__unrelated", type: { kind: "i32" } },
          { name: "__unrelated", type: { kind: "i32" } },
        );
        const tempRead: Instr = { op: "local.get", index: tempIndex + 1 };
        collision.fctx.body.push(sourceRead, { op: "drop" }, tempRead, { op: "drop" });
        const count = collision.fctx.locals.length;
        deduplicateLocals(collision.fctx);
        expect(collision.fctx.locals.length).toBe(count - 1);
        expect(slot(collision.fctx, sourceRead.index)).toBe(source);
        const remapped = checkRegion(collision.fctx, collision.fctx.body.slice(0, regionEnd), standardized);
        expect(remapped.markerLocal).toBe(markerLocal);
        expect(slot(collision.fctx, sourceRead.index)).not.toBe(remapped.markerLocal);
        expect(tempRead.index).toBe(tempIndex);
        for (const i of flatten(collision.fctx.body)) {
          if (i.op === "local.get" || i.op === "local.set" || i.op === "local.tee") slot(collision.fctx, i.index);
        }
      }

      const parameter = emptyRegion(standardized);
      parameter.fctx.params[0]!.name = "__finally_ran_0";
      parameter.fctx.localMap.set("__finally_ran_0", 0);
      parameter.emit();
      const parameterEnd = parameter.fctx.body.length;
      const parameterMarker = checkRegion(parameter.fctx, parameter.fctx.body, standardized);
      expect(parameter.fctx.localMap.get("__finally_ran_0"), "parameter: source map").toBe(0);
      expect(parameterMarker.marker).not.toBe(0);
      privateMarker(parameter.fctx, parameterMarker.marker, "__finally_ran_0");
      const parameterRead: Instr = { op: "local.get", index: 0 };
      parameter.fctx.body.push(parameterRead, { op: "drop" });
      deduplicateLocals(parameter.fctx);
      expect(parameterRead.index).toBe(0);
      expect(checkRegion(parameter.fctx, parameter.fctx.body.slice(0, parameterEnd), standardized).markerLocal).toBe(
        parameterMarker.markerLocal,
      );

      // Rollback is separate from dedup: discard speculative instructions first.
      const rolled = emptyRegion(standardized);
      const source = { name: "__finally_ran_1", type: { kind: "i32" as const } };
      rolled.fctx.locals.push(source);
      rolled.fctx.localMap.set(source.name, 1);
      rolled.fctx.tempFreeList!.set("i32", [1]);
      const rollback = snapshotLocals(rolled.fctx);
      const originalLocals = [...rolled.fctx.locals];
      const bodyLength = rolled.fctx.body.length;
      rolled.emit();
      const first = checkRegion(rolled.fctx, rolled.fctx.body.slice(bodyLength), standardized);
      privateMarker(rolled.fctx, first.marker, source.name);
      const firstTypes = rolled.fctx.locals.map((local) => local.type);
      const firstCount = rolled.fctx.locals.length;
      rolled.fctx.tempFreeList!.get("i32")!.push(rolled.fctx.params.length + firstCount);
      rolled.fctx.body.length = bodyLength;
      restoreLocals(rolled.fctx, rollback);
      expect(snapshotLocals(rolled.fctx), "rollback: full metadata").toEqual(rollback);
      expect(rolled.fctx.locals).toEqual(originalLocals);
      expect(rolled.fctx.locals[0]).toBe(source);
      expect(rolled.fctx.body).toEqual([]);
      expect(rolled.fctx.tempFreeList!.get("i32")).toEqual([1]);
      balanced(rolled.fctx);
      rolled.emit();
      const second = checkRegion(rolled.fctx, rolled.fctx.body.slice(bodyLength), standardized);
      privateMarker(rolled.fctx, second.marker, source.name);
      expect(rolled.fctx.localMap.get(source.name)).toBe(1);
      expect(rolled.fctx.locals.length).toBe(firstCount);
      expect(rolled.fctx.locals.map((local) => local.type)).toEqual(firstTypes);
      expect(second.markerLocal).not.toBe(first.markerLocal);
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

describe("#5267 literal direct-eval source binding privacy", () => {
  for (const target of ["gc", "standalone"] as const) {
    for (const suffix of [8, 0]) {
      it(`preserves ${suffix === 8 ? "colliding" : "noncolliding"} parameter in typed and plain JS (${target})`, async () => {
        // AST literal-eval lowering naturally allocated __finally_ran_8.
        // Keep the observed collision and one noncolliding positive, not a sweep.
        for (const typed of [true, false]) {
          const name = `__finally_ran_${suffix}`;
          const source = `export function probe(${name}${typed ? ": number" : ""})${typed ? ": number" : ""} { try {} finally {} return eval("${name}"); }`;
          const result = await compile(source, {
            ...(typed ? {} : { allowJs: true }),
            fileName: `issue-5267-private.${typed ? "ts" : "js"}`,
            skipSemanticDiagnostics: true,
            deferTopLevelInit: true,
            emitWat: true,
            ...(target === "standalone" ? { target } : {}),
          });
          expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
          if (target === "standalone") expect(result.imports).toEqual([]);
          expect(WebAssembly.validate(result.binary)).toBe(true);
          const imports = buildImports(result.imports, undefined, result.stringPool);
          const { instance } = await WebAssembly.instantiate(result.binary, imports);
          imports.setInstance?.(instance);
          imports.setExports?.(instance.exports as Record<string, Function>);
          const exports = instance.exports as Record<string, (...args: number[]) => unknown>;
          exports.__module_init?.();
          expect(exports.probe(37)).toBe(37);
        }
      });
    }
  }
});
