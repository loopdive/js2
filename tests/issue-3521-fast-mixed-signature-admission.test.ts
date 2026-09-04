// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Register the low-level codegen delegates used by generateModule.
import "../src/codegen/expressions.js";

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing outcome for ${name}`);
  return observed;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  (imports as { setExports?: (value: Record<string, Function>) => void }).setExports?.(exports);
  return exports;
}

async function compileWithPoisonedDirectFunctionBodies(
  source: string,
  names: string,
  options: Parameters<typeof compile>[1],
): Promise<CompileResult> {
  const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = names;
    return await compile(source, options);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
  }
}

/** The prepared route: IR owns the body, the poisoned direct body never ran. */
const PREPARED = {
  kind: "emitted",
  prepareAttempts: 1,
  directBodyEmissions: 0,
  irBodyEmissions: 1,
  legacyBodyEmitted: false,
  irBodyEmitted: true,
  preparedComponentId: expect.stringMatching(/^prepared-component:/),
};

// Every position is drawn from the #4514 carrier-fixed family and mixed
// freely, which is exactly what neither landed fast predicate admits: the
// all-scalar one refuses a string/vector position, and the JS-host
// pass-through one refuses anything but an all-`string` signature under
// `nativeStrings: false`.
const MIXED_SHAPES = [
  { name: "len", source: "export function len(s: string): number { return s.length; }" },
  { name: "c", source: "export function c(s: string): number { return s.charCodeAt(0); }" },
  { name: "t", source: "export function t(n: number): string { return `n=${n}`; }" },
  { name: "eq", source: "export function eq(a: string, b: string): boolean { return a === b; }" },
  { name: "longer", source: "export function longer(s: string, n: number): boolean { return s.length > n; }" },
  { name: "bs", source: 'export function bs(b: boolean): string { return b ? "y" : "n"; }' },
  { name: "snb", source: "export function snb(s: string, n: number): boolean { return s.length === n; }" },
  { name: "bstr", source: "export function bstr(b: boolean, s: string): string { return b ? s : s; }" },
  {
    name: "sum",
    source:
      "export function sum(xs: number[]): number { let t = 0; for (let i = 0; i < xs.length; i = i + 1) { t = t + xs[i]; } return t; }",
  },
  {
    name: "range",
    source:
      "export function range(n: number): number[] { const out: number[] = []; for (let i = 0; i < n; i = i + 1) { out.push(i); } return out; }",
  },
  {
    name: "anyTrue",
    source:
      "export function anyTrue(xs: boolean[]): boolean { for (let i = 0; i < xs.length; i = i + 1) { if (xs[i]) { return true; } } return false; }",
  },
  {
    name: "joinLen",
    source: "export function joinLen(xs: number[], s: string): number { return xs.length + s.length; }",
  },
  // All-`string` WITH native strings belongs to this predicate, not to the
  // JS-host pass-through one — which is why the routing suite's former
  // `nativeStrings: true` refusal moved here as an admission.
  { name: "echo", source: "export function echo(value: string): string { return value; }" },
] as const;

const ADMITTING_LANES = [
  ["fast", { fast: true }],
  ["fast-hostStr", { fast: true, nativeStrings: false }],
] as const;

describe("#3521 R2-F1 fast-lane mixed string/scalar signature admission", () => {
  // (a) contract — every mixed shape prepares in both admitting fast lanes.
  for (const [lane, laneOptions] of ADMITTING_LANES) {
    for (const shape of MIXED_SHAPES) {
      // `echo` is all-string, so under `nativeStrings: false` it is the JS-host
      // pass-through predicate's shape and already prepared before R2-F1.
      const ownedHere = !(lane === "fast-hostStr" && shape.name === "echo");
      it(`prepares ${shape.name} in ${lane} before direct emission`, async () => {
        const result = await compileWithPoisonedDirectFunctionBodies(shape.source, shape.name, {
          fileName: `r2f1-${shape.name}-${lane}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...laneOptions,
        });

        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(result.irFirstSkipped, `${shape.name}/${lane}`).toContain(shape.name);
        expect(outcome(result, shape.name), `${shape.name}/${lane} ownedHere=${ownedHere}`).toMatchObject(PREPARED);
      });
    }
  }

  // (a) runtime oracle — the prepared bodies compute the same answers. Only the
  // externref lane can be driven from JS for the string shapes; a `$vec` cannot
  // be passed in, so the vector shapes run through a scalar wrapper.
  it("preserves scalar and string behaviour through the prepared route", async () => {
    const result = await compileWithPoisonedDirectFunctionBodies(
      `
      export function len(s: string): number { return s.length; }
      export function c(s: string): number { return s.charCodeAt(0); }
      export function t(n: number): string { return \`n=\${n}\`; }
      export function eq(a: string, b: string): boolean { return a === b; }
      export function longer(s: string, n: number): boolean { return s.length > n; }
      export function bs(b: boolean): string { return b ? "y" : "n"; }
      `,
      "len,c,t,eq,longer,bs",
      {
        fileName: "r2f1-runtime-oracle.ts",
        experimentalIR: true,
        fast: true,
        nativeStrings: false,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const exports = await instantiate(result);
    expect(exports.len!("abc")).toBe(3);
    expect(exports.c!("a")).toBe(97);
    expect(exports.t!(1)).toBe("n=1");
    expect(exports.eq!("a", "a")).toBe(1);
    expect(exports.eq!("a", "b")).toBe(0);
    expect(exports.longer!("abc", 2)).toBe(1);
    expect(exports.bs!(1)).toBe("y");
  });

  it("preserves vector behaviour through the prepared route", async () => {
    const result = await compileWithPoisonedDirectFunctionBodies(
      `
      function sum(xs: number[]): number { let t = 0; for (let i = 0; i < xs.length; i = i + 1) { t = t + xs[i]; } return t; }
      function range(n: number): number[] { const out: number[] = []; for (let i = 0; i < n; i = i + 1) { out.push(i); } return out; }
      function anyTrue(xs: boolean[]): boolean { for (let i = 0; i < xs.length; i = i + 1) { if (xs[i]) { return true; } } return false; }
      export function main(): number { return sum(range(4)) + (anyTrue([false, true]) ? 1 : 0); }
      `,
      "sum,range,anyTrue,main",
      {
        fileName: "r2f1-vec-oracle.ts",
        experimentalIR: true,
        fast: true,
        nativeStrings: false,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    for (const name of ["sum", "range", "anyTrue"]) {
      expect(outcome(result, name), name).toMatchObject(PREPARED);
    }
    // 0 + 1 + 2 + 3 = 6, plus 1 for the true element.
    expect((await instantiate(result)).main!()).toBe(7);
  });

  // (b) byte convergence — VECTOR shapes only. The string shapes already
  // converge before this slice (the fast arm was never their byte difference),
  // so a string pin here could not detect a revert of the new disjunct.
  const VEC_SHAPES = MIXED_SHAPES.filter((shape) => ["sum", "range", "anyTrue"].includes(shape.name));
  for (const shape of VEC_SHAPES) {
    it(`emits ${shape.name} byte-identically to its non-fast twin`, async () => {
      const sha = async (options: Record<string, unknown>): Promise<string> => {
        const result = await compile(shape.source, {
          fileName: `r2f1-converge-${shape.name}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          ...options,
        } as never);
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        return createHash("sha256").update(result.binary).digest("hex");
      };

      expect(await sha({ fast: true, nativeStrings: false }), `${shape.name} fast-hostStr vs host`).toBe(await sha({}));
      expect(await sha({ fast: true }), `${shape.name} fast vs native`).toBe(await sha({ nativeStrings: true }));
    });
  }

  // (c) refusals that actually REACH the fast arm and stay refused. `string[]`
  // is deliberately outside the family: the non-fast lanes do not agree that
  // slot is stable, so the fast arm has nothing to mirror.
  it("keeps a string[] signature on the direct route in fast lanes", async () => {
    const source = 'export function first(xs: string[]): string { return xs.length > 0 ? xs[0] : ""; }';
    for (const [lane, laneOptions] of ADMITTING_LANES) {
      const result = await compileWithPoisonedDirectFunctionBodies(source, "first", {
        fileName: `r2f1-string-vec-${lane}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        ...laneOptions,
      });
      expect(result.success, lane).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n"), lane).toContain(
        "injected direct function-body poison: first",
      );
    }
  });

  it("keeps reference and async positions on the direct route in fast lanes", async () => {
    const refusals = [
      ["object-param", "op", "export function op(o: { a: number }): number { return o.a; }"],
      ["callable-param", "cp", "export function cp(f: (n: number) => number): number { return f(1); }"],
      ["destructured-param", "dp", "export function dp({ a }: { a: number }): number { return a; }"],
      ["async", "asm", "export async function asm(n: number): Promise<number> { return n; }"],
    ] as const;

    for (const [label, name, source] of refusals) {
      const result = await compileWithPoisonedDirectFunctionBodies(source, name, {
        fileName: `r2f1-refusal-${label}.ts`,
        experimentalIR: true,
        fast: true,
        trackIrOutcomes: true,
      });
      expect(result.success, label).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n"), label).toContain(
        `injected direct function-body poison: ${name}`,
      );
    }
  });

  // The lane rule: `nativeStrings: false` outside the exact JS-host lane fixes
  // no string carrier, so a string position is refused there. Pinned on a
  // pass-through shape, which compiles on the base in those lanes — a MIXED
  // string shape fails there for reasons that predate this slice.
  it("refuses string positions in fast lanes with no string carrier", async () => {
    const source = "export function echo(value: string): string { return value; }";
    const carrierlessLanes = [
      ["standalone", { target: "standalone", nativeStrings: false }],
      ["wasi", { target: "wasi", nativeStrings: false, strictNoHostImports: false }],
      ["strictNoHostImports", { strictNoHostImports: true, nativeStrings: false }],
    ] as const;

    for (const [lane, laneOptions] of carrierlessLanes) {
      const result = await compileWithPoisonedDirectFunctionBodies(source, "echo", {
        fileName: `r2f1-carrierless-${lane}.ts`,
        experimentalIR: true,
        fast: true,
        trackIrOutcomes: true,
        ...laneOptions,
      });
      expect(result.success, lane).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n"), lane).toContain(
        "injected direct function-body poison: echo",
      );
    }
  });

  // (c) neutrality — shapes rejected before the admission chain is reached at
  // all. Their unchanged routes are evidence the slice moved nothing else, not
  // evidence that the new predicate refused them.
  it("leaves select-stage rejections untouched in fast lanes", async () => {
    const neutral = [
      ["default-mixed", "dm", 'export function dm(s: string = "x", n: number = 1): number { return s.length + n; }'],
      ["generic-mixed", "gm", "export function gm<T>(v: T, n: number): number { return n; }"],
    ] as const;

    for (const [label, name, source] of neutral) {
      const result = await compile(source, {
        fileName: `r2f1-neutral-${label}.ts`,
        experimentalIR: true,
        fast: true,
        trackIrOutcomes: true,
      });
      expect(result.success, label).toBe(true);
      expect(result.irFirstSkipped ?? [], label).not.toContain(name);
      expect(outcome(result, name), label).toMatchObject({
        stage: "select",
        directBodyEmissions: 1,
        irBodyEmissions: 0,
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
  });

  // (d) the route-off control — with IR-first off the direct body must run.
  it("keeps a mixed signature direct when the IR route is off", async () => {
    const result = await compileWithPoisonedDirectFunctionBodies(
      "export function len(s: string): number { return s.length; }",
      "len",
      {
        fileName: "r2f1-route-off.ts",
        experimentalIR: false,
        fast: true,
        nativeStrings: false,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: len",
    );
  });

  // (e) a mixed component — a string leaf and a boolean caller close in ONE
  // prepared component, which catches a hidden patch-after-direct.
  it("closes a string leaf and a scalar caller in one prepared component", async () => {
    const result = await compileWithPoisonedDirectFunctionBodies(
      `
      function len(s: string): number { return s.length; }
      export function flag(b: boolean): number { return len("ab") + (b ? 1 : 0); }
      `,
      "len,flag",
      {
        fileName: "r2f1-mixed-component.ts",
        experimentalIR: true,
        fast: true,
        nativeStrings: false,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const leaf = outcome(result, "len");
    const caller = outcome(result, "flag");
    expect(leaf).toMatchObject(PREPARED);
    expect(caller).toMatchObject(PREPARED);
    expect(leaf.preparedComponentId).toBe(caller.preparedComponentId);
    expect((await instantiate(result)).flag!(1)).toBe(3);
  });

  // (f) vec residue — on the base the overlay row for this module shipped a
  // dead `string_constants` import global, an `$exn` tag and an `__exn_tag`
  // export, all left behind by the direct body (measured: 1445 -> 1349 bytes
  // in `fast-hostStr`, and the WAT diff is exactly that removal plus index
  // renumbering). Preparing before direct emission means the residue is GONE,
  // not merely moved. Pinned on the single-function module that was measured:
  // adding a caller with an array literal reintroduces `string_constants`
  // legitimately, through the IR body rather than as direct residue.
  it("strips the direct body's dead residue from a prepared vector row", async () => {
    const source =
      "export function sum(xs: number[]): number { let t = 0; for (let i = 0; i < xs.length; i = i + 1) { t = t + xs[i]; } return t; }";
    const result = await compileWithPoisonedDirectFunctionBodies(source, "sum", {
      fileName: "r2f1-vec-residue.ts",
      experimentalIR: true,
      fast: true,
      nativeStrings: false,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(outcome(result, "sum")).toMatchObject(PREPARED);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(result.binary);
    expect(text).not.toContain("Cannot access property on null or undefined");
    expect(text).not.toContain("__exn_tag");

    // The residue is real on the base: the unpoisoned direct route still ships it.
    const direct = await compile(source, {
      fileName: "r2f1-vec-residue-direct.ts",
      experimentalIR: false,
      fast: true,
      nativeStrings: false,
    });
    expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
    const directText = new TextDecoder("utf-8", { fatal: false }).decode(direct.binary);
    expect(directText).toContain("Cannot access property on null or undefined");
    expect(directText).toContain("__exn_tag");
  });
});
