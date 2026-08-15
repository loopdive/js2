// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 4 — IR adoption of `switch` (block-per-case ladder) and
// labeled NON-loop blocks (`lbl: { ... break lbl; }` → `labeled.block`).
//
// Design (per the issue's Design-A spec + slice-3 bank):
//   - `IrInstrSwitch { disc, discSlot, tests, bodies, breakLabel }` — the
//     disc is evaluated ONCE into its slot (§14.12.9); dispatch is an
//     eq-chain (i32.eq/f64.eq against literal tests), or a `br_table` for a
//     dense-int i32 disc; bodies are laid out in source order so
//     fallthrough is the natural block exit; `break` reuses the slice-2/3
//     br.label + ctrlStack depth resolver against `breakLabel`.
//   - `IrInstrLabeledBlock { label, body }` — ONE Wasm block binding its
//     label for mode "break" only (the verifier's breakOnly env).
//   - Unlabeled `break` now binds the nearest LOOP OR SWITCH
//     (`cx.breakTargetLabel`), while `continue` keeps binding the nearest
//     loop (`cx.loopLabel`) — the §14.8/§14.9 split.
//   - `br_table` gained its real payload ({targets, defaultDepth}) in the
//     Instr union + binary encoder (was a fail-loud stub, #1939).
//
// The IR-vs-legacy divergence risk (#3566/#3567/#3568) is covered by
// dual-run value-equality tests: the same source compiled legacy and IR
// must produce identical VALUES for every dispatch shape.

import { describe, expect, it } from "vitest";
import type ts2 from "typescript";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";
import { emitBinary } from "../src/emit/binary.js";
import { peepholeOptimize } from "../src/codegen/peephole.js";
import { repairStructTypeMismatches } from "../src/codegen/fixups.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import {
  IrFunctionBuilder,
  irVal,
  lowerIrFunctionToWasm,
  verifyIrFunction,
  type IrInstr,
  type IrLowerResolver,
  type IrType,
} from "../src/ir/index.js";
import { createEmptyModule, type FuncTypeDef, type Instr } from "../src/ir/types.js";

const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });

async function runIr(src: string, arg?: unknown): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
  if (!r.success) {
    throw new Error(`compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: (a?: unknown) => unknown }).test(arg);
}

/** Compile once (legacy or IR), return the callable export. */
async function fnFor(src: string, experimentalIR: boolean): Promise<(a?: unknown) => unknown> {
  const r = await compile(src, { fileName: "test.ts", experimentalIR });
  if (!r.success) {
    throw new Error(
      `compile failed (${experimentalIR ? "IR" : "legacy"}):\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    );
  }
  const imps = buildImports(r.imports as never, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps as never);
  if (typeof (imps as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imps as { setExports: (e: unknown) => void }).setExports(instance.exports);
  }
  return (instance.exports as { test: (a?: unknown) => unknown }).test;
}

function selectionFor(source: string): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  const sel = planIrCompilation(sf, { experimentalIR: true });
  return new Set(sel.funcs);
}

describe("#2952 slice 4 — selector claims (switch / labeled block)", () => {
  it("claims a basic switch with breaks and a default", () => {
    const claimed = selectionFor(`
      export function test(n: number): number {
        let r = 0;
        switch (n) {
          case 1: r = 10; break;
          case 2: r = 20; break;
          default: r = 99;
        }
        return r;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims fallthrough and returns inside clauses", () => {
    const claimed = selectionFor(`
      export function test(n: number): number {
        switch (n) {
          case 1:
          case 2: return 12;
          case 3: return 3;
        }
        return 0;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("claims a labeled non-loop block (flips the slice-3 boundary)", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        blk: {
          n = 1;
          break blk;
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("does NOT claim a switch with a non-literal case test", () => {
    const claimed = selectionFor(`
      export function test(n: number, k: number): number {
        let r = 0;
        switch (n) {
          case k: r = 1; break;
          default: r = 2;
        }
        return r;
      }
    `);
    expect(claimed.has("test")).toBe(false);
  });

  // #2952 slice 6b/6a LIFTED this boundary: string-literal case tests now
  // dispatch through a `string.eq` chain that resolves to a clause index, and
  // a function ENDING in a switch is claimable when every clause terminates.
  // See tests/issue-2952-slice6.test.ts for the positive coverage; the
  // boundary that remains is the MIXED numeric/string test set.
  it("claims a switch with string case tests (slice-6b flip)", () => {
    const claimed = selectionFor(`
      export function test(s: string): number {
        switch (s) {
          case "a": return 1;
          default: return 0;
        }
      }
    `);
    expect(claimed.has("test")).toBe(true);
  });

  it("does NOT claim a switch mixing numeric and string case tests", () => {
    const claimed = selectionFor(`
      export function test(s: string): number {
        let r = 0;
        switch (s) {
          case "a": r = 1; break;
          case 2: r = 2; break;
          default: r = 0;
        }
        return r;
      }
    `);
    expect(claimed.has("test")).toBe(false);
  });

  it("does NOT claim `continue lbl` against a labeled BLOCK (break-only binding)", () => {
    const claimed = selectionFor(`
      export function test(): number {
        let n = 0;
        blk: {
          if (n === 0) { continue blk; }
          n = 1;
        }
        return n;
      }
    `);
    expect(claimed.has("test")).toBe(false);
  });
});

describe("#2952 slice 4 — switch runtime semantics (IR values verified against V8 semantics)", () => {
  const DISPATCH_SRC = `
    export function test(n: number): number {
      let r = 0;
      switch (n) {
        case 1: r = 10; break;
        case 2: r = 20; break;
        case 3: r = 30; break;
        default: r = 99;
      }
      return r;
    }
  `;

  it("dispatches each case + default", async () => {
    const f = await fnFor(DISPATCH_SRC, true);
    expect(f(1)).toBe(10);
    expect(f(2)).toBe(20);
    expect(f(3)).toBe(30);
    expect(f(0)).toBe(99);
    expect(f(42)).toBe(99);
    expect(f(1.5)).toBe(99);
  });

  it("fallthrough accumulates until the next break (§14.12)", async () => {
    const src = `
      export function test(n: number): number {
        let r = 0;
        switch (n) {
          case 1: r = r + 1;
          case 2: r = r + 10; break;
          case 3: r = r + 100;
          default: r = r + 1000;
        }
        return r;
      }
    `;
    const f = await fnFor(src, true);
    expect(f(1)).toBe(11); // case1 falls into case2, breaks
    expect(f(2)).toBe(10);
    expect(f(3)).toBe(1100); // case3 falls into default
    expect(f(9)).toBe(1000);
  });

  it("default in the MIDDLE falls through into the next case", async () => {
    const src = `
      export function test(n: number): number {
        let r = 0;
        switch (n) {
          case 1: r = 1; break;
          default: r = r + 50;
          case 2: r = r + 7; break;
          case 3: r = 3; break;
        }
        return r;
      }
    `;
    const f = await fnFor(src, true);
    expect(f(1)).toBe(1);
    expect(f(2)).toBe(7); // direct hit skips default
    expect(f(3)).toBe(3);
    expect(f(8)).toBe(57); // default runs, falls into case 2's body
  });

  it("no default + no match runs nothing (and no-clause switch is legal)", async () => {
    const src = `
      export function test(n: number): number {
        let r = 5;
        switch (n) {
          case 1: r = 1; break;
        }
        switch (n) {}
        return r;
      }
    `;
    const f = await fnFor(src, true);
    expect(f(1)).toBe(1);
    expect(f(2)).toBe(5);
  });

  it("NaN matches nothing; -0 matches case 0 (f64.eq semantics)", async () => {
    // NB: the switch must be NON-tail — a function ENDING in a switch is a
    // tail-position shape the statement-list walk doesn't claim (recorded
    // as a slice-5 residual in the issue).
    const src = `
      export function test(n: number): number {
        let r = 0;
        switch (n) {
          case 0: r = 1; break;
          default: r = 2;
        }
        return r;
      }
    `;
    expect(selectionFor(src).has("test")).toBe(true);
    const f = await fnFor(src, true);
    expect(f(-0)).toBe(1); // -0 === 0 under f64.eq — correct per §7.2.16
    expect(f(0)).toBe(1);
    expect(f(NaN)).toBe(2); // NaN matches nothing → default
  });

  it("return inside a clause exits the function (early-return arm)", async () => {
    const src = `
      export function test(n: number): number {
        switch (n) {
          case 1: return 100;
          case 2: return 200;
        }
        return 7;
      }
    `;
    const f = await fnFor(src, true);
    expect(f(1)).toBe(100);
    expect(f(2)).toBe(200);
    expect(f(3)).toBe(7);
  });

  it("statements after a break in a clause are dead code", async () => {
    const src = `
      export function test(n: number): number {
        let r = 0;
        switch (n) {
          case 1: {
            r = 1;
            break;
            r = 1000;
          }
          default: r = 9;
        }
        return r;
      }
    `;
    const f = await fnFor(src, true);
    expect(f(1)).toBe(1);
  });
});

describe("#2952 slice 4 — break/continue interplay (switch in loop, loop in switch)", () => {
  it("unlabeled break inside a switch inside a loop exits the SWITCH, not the loop", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          for (let i = 0; i < 4; i++) {
            switch (i) {
              case 1: break;
              case 2: n = n + 100; break;
              default: n = n + 1;
            }
          }
          return n;
        }
      `),
    ).toBe(102); // i=0: +1, i=1: nothing, i=2: +100, i=3: +1 — loop runs all 4
  });

  it("unlabeled continue inside a switch targets the enclosing LOOP", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          for (let i = 0; i < 4; i++) {
            switch (i) {
              case 1:
              case 2: continue;
              default: break;
            }
            n = n + 1;
          }
          return n;
        }
      `),
    ).toBe(2); // i=1,2 skip the tail increment; i=0,3 count
  });

  it("a loop inside a switch clause: break binds the inner loop", async () => {
    expect(
      await runIr(
        `
        export function test(n: number): number {
          let r = 0;
          switch (n) {
            case 1:
              while (r < 100) {
                r = r + 1;
                if (r === 5) { break; }
              }
              r = r + 1000;
              break;
            default: r = 7;
          }
          return r;
        }
      `,
        1,
      ),
    ).toBe(1005); // inner break at 5, then the clause tail runs, then switch break
  });

  it("labeled break from a switch clause exits an outer labeled loop", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          outer: for (let i = 0; i < 5; i++) {
            switch (i) {
              case 2: break outer;
              default: n = n + 1;
            }
          }
          return n;
        }
      `),
    ).toBe(2); // i=0,1 count; i=2 exits both switch and loop
  });

  it("`lbl: switch` — break lbl exits the switch (label aliases breakLabel)", async () => {
    expect(
      await runIr(
        `
        export function test(n: number): number {
          let r = 0;
          sw: switch (n) {
            case 1:
              r = 1;
              if (r === 1) { break sw; }
              r = 50;
              break;
            default: r = 9;
          }
          return r;
        }
      `,
        1,
      ),
    ).toBe(1);
  });
});

describe("#2952 slice 4 — labeled.block runtime semantics", () => {
  it("break lbl exits the labeled block, skipping its tail", async () => {
    expect(
      await runIr(
        `
        export function test(n: number): number {
          let r = 0;
          blk: {
            r = 1;
            if (n > 0) { break blk; }
            r = 100;
          }
          return r;
        }
      `,
        5,
      ),
    ).toBe(1);
  });

  it("labeled block falls through normally when not broken", async () => {
    expect(
      await runIr(
        `
        export function test(n: number): number {
          let r = 0;
          blk: {
            r = 1;
            if (n > 0) { break blk; }
            r = 100;
          }
          return r;
        }
      `,
        -1,
      ),
    ).toBe(100);
  });

  it("a loop inside a labeled block can break out of the BLOCK", async () => {
    expect(
      await runIr(`
        export function test(): number {
          let n = 0;
          blk: {
            while (n < 100) {
              n = n + 1;
              if (n === 3) { break blk; }
            }
            n = n + 1000; // skipped — the break exits the block, not just the loop
          }
          return n;
        }
      `),
    ).toBe(3);
  });
});

describe("#2952 slice 4 — IR vs legacy divergence guard (dual-run value equality)", () => {
  const SHAPES: ReadonlyArray<readonly [string, string, readonly unknown[]]> = [
    [
      "dispatch+default",
      `export function test(n: number): number {
        let r = 0;
        switch (n) { case 1: r = 10; break; case 2: r = 20; break; default: r = 99; }
        return r;
      }`,
      [0, 1, 2, 3, 1.5, -1],
    ],
    [
      "fallthrough chain",
      `export function test(n: number): number {
        let r = 0;
        switch (n) { case 1: r = r + 1; case 2: r = r + 10; break; case 3: r = r + 100; default: r = r + 1000; }
        return r;
      }`,
      [1, 2, 3, 4],
    ],
    [
      "mid default fallthrough",
      `export function test(n: number): number {
        let r = 0;
        switch (n) { case 1: r = 1; break; default: r = r + 50; case 2: r = r + 7; break; }
        return r;
      }`,
      [1, 2, 5],
    ],
    [
      "switch in loop with continue",
      `export function test(n: number): number {
        let acc = 0;
        for (let i = 0; i < n; i++) {
          switch (i) { case 1: continue; case 3: acc = acc + 100; break; default: acc = acc + 1; }
        }
        return acc;
      }`,
      [0, 2, 5],
    ],
    [
      "labeled block",
      `export function test(n: number): number {
        let r = 0;
        blk: { r = 1; if (n > 0) { break blk; } r = 100; }
        return r;
      }`,
      [1, 0, -2],
    ],
  ];

  for (const [name, src, args] of SHAPES) {
    it(`legacy and IR agree: ${name}`, async () => {
      // IR must claim the function — otherwise this test silently compares
      // legacy against legacy (the hybrid-divergence trap this suite exists
      // to catch).
      expect(selectionFor(src).has("test")).toBe(true);
      const legacy = await fnFor(src, false);
      const ir = await fnFor(src, true);
      for (const a of args) {
        expect(ir(a), `arg ${String(a)}`).toBe(legacy(a));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// br_table path — builder-constructed IR (an i32 disc is not reachable from
// TS sources today, where numbers lower to f64 → eq-chain dispatch)
// ---------------------------------------------------------------------------

function makeCtx(): CodegenContext {
  return createCodegenContext(createEmptyModule(), {} as unknown as ts2.TypeChecker, {
    fast: true,
    nativeStrings: true,
  });
}

function resolverFor(ctx: CodegenContext): IrLowerResolver {
  return {
    resolveFunc: () => {
      throw new Error("test resolver: no funcs");
    },
    resolveGlobal: () => {
      throw new Error("test resolver: no globals");
    },
    resolveType: () => {
      throw new Error("test resolver: no type refs");
    },
    internFuncType: (t: FuncTypeDef) => addFuncType(ctx, t.params, t.results, t.name),
  };
}

/** Build `select3(x: i32): f64` — switch (x) {0→10, 1→20, 2→fallthrough default→99}. */
function buildBrTableFunc(b: IrFunctionBuilder): void {
  const x = b.addParam("x", I32);
  b.openBlock();
  const out = b.declareSlot("out", { kind: "f64" });
  const discSlot = b.declareSlot("__switch_disc", { kind: "i32" });
  const breakLabel = b.freshLoopLabel();
  const setOut = (v: number, brk: boolean): readonly IrInstr[] =>
    b.collectBodyInstrs(() => {
      const c = b.emitConst({ kind: "f64", value: v }, F64);
      b.emitSlotWrite(out, c);
      if (brk) b.emitBrLabel(breakLabel, "break");
    });
  const bodies = [
    setOut(10, true), // case 0
    setOut(20, true), // case 1
    setOut(30, false), // case 2 — falls through into default
    setOut(99, false), // default (fallthrough target + no-match)
  ];
  b.emitSwitch({ disc: x, discSlot, tests: [0, 1, 2, null], bodies, breakLabel });
  const r = b.emitSlotRead(out);
  b.terminate({ kind: "return", values: [r] });
}

describe("#2952 slice 4 — br_table dispatch (i32 disc, builder IR through the real pipeline)", () => {
  it("emits a br_table and runs with correct dispatch + fallthrough", async () => {
    const b = new IrFunctionBuilder("select3", [F64], true);
    buildBrTableFunc(b);
    const fn = b.finish();
    expect(verifyIrFunction(fn)).toEqual([]);

    const ctx = makeCtx();
    const { func } = lowerIrFunctionToWasm(fn, resolverFor(ctx));
    // Structural: the dispatch chose br_table (dense 0..2 i32 keys).
    const hasBrTable = (instrs: readonly Instr[]): boolean =>
      instrs.some((i) => {
        if (i.op === "br_table") return true;
        if (i.op === "block" || i.op === "loop") return hasBrTable(i.body);
        if (i.op === "if") return hasBrTable(i.then) || (i.else ? hasBrTable(i.else) : false);
        return false;
      });
    expect(hasBrTable(func.body)).toBe(true);

    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, func);
    ctx.mod.exports.push({ name: "select3", desc: { kind: "func", index: handle } });
    repairStructTypeMismatches(ctx.mod);
    peepholeOptimize(ctx.mod);
    stackBalance(ctx.mod);
    const binary = emitBinary(ctx.mod);
    const { instance } = await WebAssembly.instantiate(binary as BufferSource, {});
    const select3 = instance.exports.select3 as (x: number) => number;
    expect(select3(0)).toBe(10);
    expect(select3(1)).toBe(20);
    expect(select3(2)).toBe(99); // case 2 writes 30, falls into default → 99
    expect(select3(7)).toBe(99); // out of range → br_table default
    expect(select3(-3)).toBe(99); // below min → wraps via i32.sub → default
  });
});
