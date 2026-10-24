// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 function-object receivers. #6823 required parameter/result type
// evidence before a member call/write on a top-level function object could be
// claimed, because the planner refused to mint the canonical receiver plan
// without it. A RECEIVER-only use never reads that signature: the accessor's
// externref is boxed straight into the dynamic carrier and every member
// call/write dispatches dynamically (Get, then Call with `this` = receiver). The
// planner now mints that plan with an opaque all-dynamic signature for an
// unannotated target (census arm 4: `assert._toString(…)` in `assert`,
// `assert._isSameValue(…)` in `compareArray`), so the evidence gate is gone for
// receivers; VALUE uses (the S3c self-guarded constructor) still need evidence.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

type Target = "standalone" | "gc";

function options(target: Target) {
  return { target, skipSemanticDiagnostics: true, trackIrOutcomes: true, deferTopLevelInit: true } as const;
}

function outcome(result: CompileResult, name: string) {
  const rows = (result.irOutcomes ?? []).filter((row) => row.displayName === name);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function run(result: CompileResult, target: Target): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (target === "standalone") {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    target === "standalone" ? {} : (result.importObject as WebAssembly.Imports),
  );
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

// A caller of a LEGACY-owned target defers its prepared component
// (`r2Withdrawal: unsealed-component`) and ships its IR body through the patch
// route — measured identically for a fully annotated legacy-owned target, so
// it is not a property of the missing evidence.
function expectIrOwned(result: CompileResult, name: string): void {
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const row = outcome(result, name);
  expect(row.irBodyEmitted, JSON.stringify(row)).toBe(true);
  expect(row.kind).toBe("emitted");
}

function memberSource(declaration: string): string {
  return `${declaration}
    subject.equal = function (a, b) { return a === b; };
    export function run(): number { return subject.equal(1, 1) ? 1 : 0; }`;
}

describe("#7106 function-object receivers need no signature evidence", () => {
  for (const target of ["standalone", "gc"] as const) {
    for (const [name, declaration] of [
      ["missing parameter and result", "function subject(value) { return arguments[0]; }"],
      ["missing parameter", "function subject(value): number { return arguments[0]; }"],
      ["missing result", "function subject(value: number) { return arguments[0]; }"],
      ["an inferred (IR-owned) signature", "function subject() { return 0; }"],
    ]) {
      it(`claims a member call on a receiver with ${name} (${target})`, async () => {
        const result = await compile(memberSource(declaration!), options(target));
        expectIrOwned(result, "run");
        expect(await run(result, target)).toBe(1);
      });
    }

    it(`claims a member write on an unannotated receiver (${target})`, async () => {
      const result = await compile(
        `function subject(value) { return arguments[0]; }
         subject.extra = 0;
         function write(): void { subject.extra = 7; }
         export function run(): number { write(); return subject.extra === 7 ? 1 : 0; }`,
        options(target),
      );
      expectIrOwned(result, "write");
      expect(await run(result, target)).toBe(1);
    });

    it(`binds \`this\` to the receiver legacy wrote the member on (${target})`, async () => {
      // The member closure is legacy-owned (module-init); the IR caller must
      // reach the SAME canonical function object and pass it as \`this\`.
      const result = await compile(
        `function subject(value) { return arguments[0]; }
         subject.tag = 5;
         subject.self = function () { return this === subject && this.tag === 5; };
         function probe(): boolean { return subject.self() ? true : false; }
         export function run(): number { return probe() ? 1 : 0; }`,
        options(target),
      );
      expectIrOwned(result, "probe");
      expect(await run(result, target)).toBe(1);
    });

    it(`runs the compareArray shape against an unannotated assert (${target})`, async () => {
      const result = await compile(
        `function assert(mustBeTrue, message) { if (mustBeTrue === true) { return; } throw message; }
         assert._isSameValue = function (a, b) {
           if (a === b) { return a !== 0 || 1 / a === 1 / b; }
           return a !== a && b !== b;
         };
         function compareArray(a, b) {
           if (b.length !== a.length) { return false; }
           for (var i = 0; i < a.length; i++) {
             if (!assert._isSameValue(b[i], a[i])) { return false; }
           }
           return true;
         }
         /** @returns {number} */
         export function run() {
           var r = 0;
           if (compareArray([1, 2, 3], [1, 2, 3])) r += 1;
           if (!compareArray([1, 2], [1, 2, 3])) r += 2;
           if (!compareArray([0], [-0])) r += 4;
           if (compareArray([NaN], [NaN])) r += 8;
           if (!compareArray(["a"], ["b"])) r += 16;
           return r;
         }`,
        { ...options(target), allowJs: true, fileName: "issue-7106-compare-array.js" },
      );
      expectIrOwned(result, "compareArray");
      expect(await run(result, target)).toBe(31);
    });
  }

  it("preserves the prepared call through an explicitly typed target", async () => {
    const result = await compile(
      memberSource("function subject(value: number): number { return value; }"),
      options("standalone"),
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "run")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      directBodyEmissions: 0,
      preparedComponentId: expect.any(String),
    });
    expect(await run(result, "standalone")).toBe(1);
  });

  it("preserves JSDoc parameter and result evidence", async () => {
    const result = await compile(
      memberSource("/** @param {number} value @returns {number} */ function subject(value) { return value; }").replace(
        "export function run(): number",
        "/** @returns {number} */ export function run()",
      ),
      { ...options("standalone"), allowJs: true, fileName: "issue-7106-member-evidence.js" },
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "run")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      directBodyEmissions: 0,
      preparedComponentId: expect.any(String),
    });
    expect(outcome(result, "run")).not.toHaveProperty("r2Withdrawal");
    expect(await run(result, "standalone")).toBe(1);
  });
});
