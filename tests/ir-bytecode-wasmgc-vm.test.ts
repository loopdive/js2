import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { BytecodeEmitter, BytecodeSink, OP } from "../src/ir/backend/bytecode-emitter.js";
import { type FuncEntry, type Program, runProgram, runSink } from "../src/ir/backend/bytecode-vm.js";
import type { BlockType } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";

// #1584 slice (b) — the Wasm-GC-native dispatch loop.
//
// #1715 proved the #1713 backend seam can target a bytecode stream run by a
// HOST-TS dispatch loop (triple equivalence: runSink == WasmGC-src == JS). This
// file proves slice (b)'s acceptance criterion from the #1584 contract (PR #955
// §"Slice (b)"): the dispatch loop, **compiled BY js2wasm to Wasm-GC**, runs the
// same bytecode and equals the TS-interpreted VM. That makes the equivalence a
// QUADRUPLE:
//
//     host-TS VM  ==  Wasm-GC-compiled VM  ==  WasmGC-compiled source  ==  JS
//     (runSink)       (compile(bytecode-vm.ts))  (compile(src))          (eval)
//
// Critically — per the contract's slice-(b) acceptance test #2 — the Wasm-GC VM
// arm compiles **the actual `src/ir/backend/bytecode-vm.ts` file**, not a hand-
// kept copy. `compileVmModule()` reads that file at test time and applies only
// the minimal mechanical transforms a "compile the dispatch loop itself" step
// needs (drop the host `import`, inline the `OP.*` numbers, drop the
// `BytecodeSink`-typed `runSink` helper which is out of the numeric subset, and
// append an in-module-build entry because `number[]` can't cross the export ABI
// — the #1700 gap). The dispatch-loop body itself is compiled verbatim, so if
// anyone edits `bytecode-vm.ts`, THIS test compiles the edited loop — there is
// no second copy to drift.
//
// Contract discipline (#1584 one-owner rule): the `OP` enum + `BytecodeSink` are
// owned by sdev-emitter in `bytecode-emitter.ts`; this slice imports them
// READ-ONLY. The bytecode for the VM arms is produced by the SAME
// `BytecodeEmitter` the #1715 proof uses. Encoding is the #1715 STACK machine
// (the contract's §1a staging note: build on stack first; the reg+acc flip is a
// later coordinated bump owned by slice (a)).

const E = new BytecodeEmitter();

// The production `BytecodeEmitter.emitConst` (per the #1713/#1584 trait, landed
// by the emitter slice) takes an IR `const` instr, not a bare number. For these
// numeric proofs the only path needed is the f64 literal → a single
// `CONST <poolIdx>`. This wrapper builds that IR const instr, mirroring the
// emitter slice's own `emitNumberConst` so both test suites drive the production
// signature identically. (Keeping this here, not in the VM, preserves the
// VM-owns-only-bytecode-vm.ts boundary.)
function emitNumberConst(value: number, out: BytecodeSink): void {
  E.emitConst(
    {
      kind: "const",
      result: null,
      resultType: null,
      value: { kind: "f64", value },
    },
    "proof",
    out,
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const VM_FILE = resolve(__dirname, "../src/ir/backend/bytecode-vm.ts");

/**
 * Read the real `bytecode-vm.ts` and turn it into a self-contained module that
 * `compile()` can lower, WITHOUT copying the dispatch-loop body. The four
 * transforms are exactly what a "compile the dispatch loop itself" step needs;
 * none touches the loop logic:
 *   1. drop the `import` line — a compiled Wasm module has no host TS to import.
 *   2. inline `OP.NAME` -> its numeric value (from the imported enum) so the
 *      switch arms are integer-literal cases.
 *   3. drop `runSink` — it is typed against `BytecodeSink` (an object), outside
 *      the numeric subset; the VM entry under test is `runBytecode`.
 *   4. append an exported entry that builds `code` / `constPool` / `args`
 *      in-module (the #1700 export-ABI constraint: `number[]` can't be a param).
 */
function compileVmModule(
  entryParams: readonly string[],
  code: readonly number[],
  constPool: readonly number[],
  argInit: readonly string[],
): string {
  let src = readFileSync(VM_FILE, "utf8");
  // 1. drop every import line (host-only).
  src = src.replace(/^import\b[^\n]*\n/gm, "");
  // 2. inline OP.NAME numeric values. Replace LONGER names first: some opcode
  //    names are prefixes of others (e.g. `CALL` is a prefix of `CALL_REF`, and
  //    `GLOBAL_GET`/`GLOBAL_SET` share `GLOBAL`), and `replaceAll` on the prefix
  //    would corrupt the longer token (`OP.CALL_REF` -> `23_REF`). Descending
  //    name length guarantees the longest match is substituted first.
  for (const [name, value] of Object.entries(OP).sort((a, b) => b[0].length - a[0].length)) {
    src = src.replaceAll(`OP.${name}`, String(value));
  }
  // 3. drop the runSink convenience (BytecodeSink-typed -> out of subset). It is
  //    the trailing exported helper; cut from its doc-comment to EOF.
  src = src.replace(/\/\*\* Convenience[\s\S]*$/m, "");
  // 4. append the in-module-build entry.
  const params = entryParams.map((p) => `${p}: number`).join(", ");
  const entry = `
export function run(${params}): number {
  const code: number[] = [${code.join(", ")}];
  const constPool: number[] = [${constPool.join(", ")}];
  const args: number[] = [${argInit.join(", ")}];
  return runBytecode(code, constPool, args);
}
`;
  return src + entry;
}

/**
 * Multi-function variant of {@link compileVmModule} (#1584 a1). Builds a
 * `Program` (function table + entry) in-module and calls `runProgram`, so the
 * compiled-VM arm exercises the CALL family. Same four transforms as
 * `compileVmModule`; the appended entry constructs each `FuncEntry` literal and
 * the `Program` wrapper inline (the #1700 export-ABI constraint: object/array
 * params can't cross the boundary, so the program is built inside the module).
 */
function compileProgramModule(
  entryParams: readonly string[],
  functions: ReadonlyArray<{
    code: readonly number[];
    constPool: readonly number[];
    arity: number;
    nLocals: number;
    exceptionTable?: ReadonlyArray<{
      tryStart: number;
      tryEnd: number;
      catchTarget: number;
      spAtEntry: number;
    }>;
  }>,
  entry: number,
  argInit: readonly string[],
): string {
  let src = readFileSync(VM_FILE, "utf8");
  src = src.replace(/^import\b[^\n]*\n/gm, "");
  for (const [name, value] of Object.entries(OP).sort((a, b) => b[0].length - a[0].length)) {
    src = src.replaceAll(`OP.${name}`, String(value));
  }
  // Drop the trailing BytecodeSink-typed convenience helper (out of subset).
  src = src.replace(/\/\*\* Convenience[\s\S]*$/m, "");
  const params = entryParams.map((p) => `${p}: number`).join(", ");
  const fnLiterals = functions
    .map((f) => {
      // exceptionTable defaults to [] (no try regions); a4 cases pass entries.
      const excEntries = (f.exceptionTable ?? [])
        .map(
          (e) =>
            `{ tryStart: ${e.tryStart}, tryEnd: ${e.tryEnd}, catchTarget: ${e.catchTarget}, spAtEntry: ${e.spAtEntry} }`,
        )
        .join(", ");
      return `{ code: [${f.code.join(", ")}], constPool: [${f.constPool.join(", ")}], arity: ${f.arity}, nLocals: ${f.nLocals}, exceptionTable: [${excEntries}] }`;
    })
    .join(",\n    ");
  const entrySrc = `
export function run(${params}): number {
  const functions: FuncEntry[] = [
    ${fnLiterals}
  ];
  const program: Program = { functions: functions, entry: ${entry} };
  const args: number[] = [${argInit.join(", ")}];
  return runProgram(program, args);
}
`;
  return src + entrySrc;
}

// ── Compile + run a WasmGC export taking only number params ────────────────
async function runWasm(src: string, fn: string, args: number[]): Promise<number> {
  const r = await compile(src, { fileName: "vm.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const withExports = imports as { setExports?: (e: unknown) => void };
  if (typeof withExports.setExports === "function") {
    withExports.setExports(instance.exports);
  }
  const f = (instance.exports as Record<string, (...a: number[]) => number>)[fn];
  return f(...args);
}

describe("#1584 slice (b) — Wasm-GC-native dispatch loop (quadruple equivalence)", () => {
  // ── f(a, b) = a + b ───────────────────────────────────────────────────────
  it("arithmetic: host-VM == WasmGC-VM == WasmGC-src == JS for f(a,b)=a+b", async () => {
    const src = `export function f(a: number, b: number): number { return a + b; }`;
    const js = (a: number, b: number): number => a + b;

    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.add", s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    const vmMod = compileVmModule(["a", "b"], s0.code, s0.constPool, ["a", "b"]);

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      expect(runSink(sink(), [a, b])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b])).toBe(expected);
      expect(await runWasm(src, "f", [a, b])).toBe(expected);
    }
  });

  // ── g(a) = { let x = a * 2; return x } (local + const + mul + store/load) ─
  it("local+mul: host-VM == WasmGC-VM == WasmGC-src == JS for g(a)={let x=a*2;return x}", async () => {
    const src = `export function g(a: number): number { let x = a * 2; return x; }`;
    const js = (a: number): number => {
      const x = a * 2;
      return x;
    };

    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(2, s);
      E.emitBinary("f64.mul", s);
      E.emitLocalSet(1, s);
      E.emitLocalGet(1, s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    // args[0] = a (param), args[1] = x (declared local, zero-init)
    const vmMod = compileVmModule(["a"], s0.code, s0.constPool, ["a", "0"]);

    for (const a of [3, -4, 0, 1.5, 1000]) {
      const expected = js(a);
      expect(runSink(sink(), [a, 0])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a])).toBe(expected);
      expect(await runWasm(src, "g", [a])).toBe(expected);
    }
  });

  // ── h(a, b) = a > 0 ? a + b : a - b (conditional branch + JZ/JMP) ─────────
  it("branch: host-VM == WasmGC-VM == WasmGC-src == JS for h(a,b)=a>0?a+b:a-b", async () => {
    const src = `export function h(a: number, b: number): number { return a > 0 ? a + b : a - b; }`;
    const js = (a: number, b: number): number => (a > 0 ? a + b : a - b);

    const sink = (): BytecodeSink => {
      const s = new BytecodeSink();
      // cond: a > 0 — emitted into the outer sink, left on the stack for emitIf.
      E.emitLocalGet(0, s);
      emitNumberConst(0, s);
      E.emitBinary("f64.gt", s);
      // then arm: a + b — pre-lowered into its own child sink, as lower.ts builds
      // each arm's body before handing it to the production emitIf.
      const thenArm = E.newSink();
      E.emitLocalGet(0, thenArm);
      E.emitLocalGet(1, thenArm);
      E.emitBinary("f64.add", thenArm);
      // else arm: a - b
      const elseArm = E.newSink();
      E.emitLocalGet(0, elseArm);
      E.emitLocalGet(1, elseArm);
      E.emitBinary("f64.sub", elseArm);
      const emptyBlock: BlockType = { kind: "empty" };
      E.emitIf(emptyBlock, thenArm, elseArm, s);
      E.emitReturn(s);
      return s;
    };
    const s0 = sink();
    const vmMod = compileVmModule(["a", "b"], s0.code, s0.constPool, ["a", "b"]);

    for (const [a, b] of [
      [5, 3],
      [-2, 7],
      [0, 9], // boundary → else
      [1.5, -0.5],
      [-100, -1],
    ]) {
      const expected = js(a, b);
      expect(runSink(sink(), [a, b])).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b])).toBe(expected);
      expect(await runWasm(src, "h", [a, b])).toBe(expected);
    }
  });

  // ── NEG + the remaining compare opcodes through the compiled VM ──────────
  // f/g/h don't hit NEG or CMP_LT/GE/LE/EQ; exercise them so the Wasm-GC
  // dispatch arm covers every opcode `bytecode-vm.ts` implements.
  it("WasmGC-VM covers NEG and all CMP_* opcodes", async () => {
    // k(a) = -a ; LOAD 0, NEG, RET
    const negSink = new BytecodeSink();
    E.emitLocalGet(0, negSink);
    E.emitUnary("f64.neg", negSink);
    E.emitReturn(negSink);
    const negMod = compileVmModule(["a"], negSink.code, negSink.constPool, ["a"]);
    for (const a of [3, -4, 0, 1.5]) {
      expect(runSink(negSink, [a])).toBe(-a);
      expect(await runWasm(negMod, "run", [a])).toBe(-a);
    }

    const compares: Array<[Parameters<typeof E.emitBinary>[0], (a: number, b: number) => number]> = [
      ["f64.lt", (a, b) => (a < b ? 1 : 0)],
      ["f64.ge", (a, b) => (a >= b ? 1 : 0)],
      ["f64.le", (a, b) => (a <= b ? 1 : 0)],
      ["f64.eq", (a, b) => (a === b ? 1 : 0)],
    ];
    for (const [op, ref] of compares) {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary(op, s);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [1, 2],
        [2, 2],
        [3, 2],
        [-1, -1],
      ]) {
        const expected = ref(a, b);
        expect(runSink(s, [a, b]), `host ${op}(${a},${b})`).toBe(expected);
        expect(await runWasm(mod, "run", [a, b]), `wasm ${op}(${a},${b})`).toBe(expected);
      }
    }
  });

  // ── #1584 production opcodes: DIV / CMP_NE / TEE / GLOBAL_GET/SET / SELECT /
  // DROP, exercised through BOTH the host VM (runSink) and the compiled VM. ──
  // These are the additive op-set #958 committed to the emitter; this confirms
  // bytecode-vm.ts realizes each, with host-VM == Wasm-GC-VM equivalence.
  it("WasmGC-VM == host-VM for DIV / CMP_NE / SELECT / TEE / DROP / GLOBAL_*", async () => {
    // DIV: f(a,b) = a / b
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.div", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [6, 3],
        [7, 2],
        [-9, 3],
        [1, 4],
      ]) {
        expect(runSink(s, [a, b]), `host div(${a},${b})`).toBe(a / b);
        expect(await runWasm(mod, "run", [a, b]), `wasm div(${a},${b})`).toBe(a / b);
      }
    }
    // CMP_NE: f(a,b) = (a != b) ? 1 : 0
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      E.emitLocalGet(1, s);
      E.emitBinary("f64.ne", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b"], s.code, s.constPool, ["a", "b"]);
      for (const [a, b] of [
        [1, 1],
        [1, 2],
        [-3, -3],
      ]) {
        const exp = a !== b ? 1 : 0;
        expect(runSink(s, [a, b]), `host ne(${a},${b})`).toBe(exp);
        expect(await runWasm(mod, "run", [a, b]), `wasm ne(${a},${b})`).toBe(exp);
      }
    }
    // SELECT: f(a,b,c) = (c != 0) ? a : b. Operand order per OP.SELECT: a, b, cond.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s); // a
      E.emitLocalGet(1, s); // b
      E.emitLocalGet(2, s); // cond
      s.emit(OP.SELECT);
      E.emitReturn(s);
      const mod = compileVmModule(["a", "b", "c"], s.code, s.constPool, ["a", "b", "c"]);
      for (const [a, b, c] of [
        [10, 20, 1],
        [10, 20, 0],
        [-5, 5, 7],
      ]) {
        const exp = c !== 0 ? a : b;
        expect(runSink(s, [a, b, c]), `host select(${a},${b},${c})`).toBe(exp);
        expect(await runWasm(mod, "run", [a, b, c]), `wasm select(${a},${b},${c})`).toBe(exp);
      }
    }
    // TEE: f(a) = { local1 = (a+1) [tee leaves it on stack]; return top * 2 }.
    // sequence: LOAD a, CONST 1, ADD, TEE 1, CONST 2, MUL, RET → (a+1)*2.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(1, s);
      E.emitBinary("f64.add", s);
      E.emitLocalTee(1, s); // peek -> local1, leaves (a+1) on stack
      emitNumberConst(2, s);
      E.emitBinary("f64.mul", s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a", "0"]);
      for (const a of [3, -4, 0, 1.5]) {
        const exp = (a + 1) * 2;
        expect(runSink(s, [a, 0]), `host tee(${a})`).toBe(exp);
        expect(await runWasm(mod, "run", [a]), `wasm tee(${a})`).toBe(exp);
      }
    }
    // DROP: f(a) = { push a; push 99; DROP; return top } → a (99 discarded).
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(99, s);
      E.emitDrop(s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a"]);
      for (const a of [3, -4, 0, 1.5]) {
        expect(runSink(s, [a]), `host drop(${a})`).toBe(a);
        expect(await runWasm(mod, "run", [a]), `wasm drop(${a})`).toBe(a);
      }
    }
    // GLOBAL_SET / GLOBAL_GET: f(a) = { global0 = a*3; return global0 }.
    {
      const s = new BytecodeSink();
      E.emitLocalGet(0, s);
      emitNumberConst(3, s);
      E.emitBinary("f64.mul", s);
      E.emitGlobalSet(0, s);
      E.emitGlobalGet(0, s);
      E.emitReturn(s);
      const mod = compileVmModule(["a"], s.code, s.constPool, ["a"]);
      for (const a of [3, -4, 0, 1.5]) {
        expect(runSink(s, [a]), `host global(${a})`).toBe(a * 3);
        expect(await runWasm(mod, "run", [a]), `wasm global(${a})`).toBe(a * 3);
      }
    }
  });

  // ── #1584 a1 call family: CALL (direct) + CALL_REF (indirect via funcref) ──
  // The VM becomes a multi-frame call-stack machine over a function table.
  // PROGRAM A drives a direct CALL between two functions through BOTH the host
  // VM (runProgram) and the compiled VM (compileProgramModule), asserting
  // host-VM == Wasm-GC-VM == JS. PROGRAM B drives CALL_REF over a synthesized
  // funcref-on-stack; the null-funcref (f64(-1)) case must trap.
  it("a1: CALL — host-VM == WasmGC-VM == JS for main(a,b)=add(a,b)", async () => {
    // functions[1] = add(a,b) = a + b   →  LOAD 0; LOAD 1; ADD; RET
    const add = new BytecodeSink();
    E.emitLocalGet(0, add);
    E.emitLocalGet(1, add);
    E.emitBinary("f64.add", add);
    E.emitReturn(add);
    // functions[0] = main(a,b) = add(a,b)  →  LOAD 0; LOAD 1; CALL 1; RET
    const main = new BytecodeSink();
    E.emitLocalGet(0, main);
    E.emitLocalGet(1, main);
    main.emit(OP.CALL, 1); // CALL funcIdx 1 (add)
    E.emitReturn(main);

    const functions: FuncEntry[] = [
      {
        code: main.code.slice(),
        constPool: main.constPool.slice(),
        arity: 2,
        nLocals: 2,
        exceptionTable: [],
      },
      {
        code: add.code.slice(),
        constPool: add.constPool.slice(),
        arity: 2,
        nLocals: 2,
        exceptionTable: [],
      },
    ];
    const program: Program = { functions, entry: 0 };
    const js = (a: number, b: number): number => a + b;

    const vmMod = compileProgramModule(
      ["a", "b"],
      functions.map((f) => ({
        code: f.code,
        constPool: f.constPool,
        arity: f.arity,
        nLocals: f.nLocals,
      })),
      0,
      ["a", "b"],
    );

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      expect(runProgram(program, [a, b]), `host CALL add(${a},${b})`).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b]), `wasm CALL add(${a},${b})`).toBe(expected);
    }
  });

  it("a1: CALL_REF — host-VM dispatches funcref≡f64(tableIdx); null≡f64(-1) traps", async () => {
    // functions[1] = add(a,b) = a + b. functions[0] = entry that pushes
    // a, b, then the funcref f64(1) on top, then CALL_REF.
    const add = new BytecodeSink();
    E.emitLocalGet(0, add);
    E.emitLocalGet(1, add);
    E.emitBinary("f64.add", add);
    E.emitReturn(add);

    // entry: LOAD 0; LOAD 1; CONST f64(1) [funcref=tableIdx 1]; CALL_REF <typeIdx>; RET
    const entry = new BytecodeSink();
    E.emitLocalGet(0, entry);
    E.emitLocalGet(1, entry);
    emitNumberConst(1, entry); // funcref ≡ f64(1)
    entry.emit(OP.CALL_REF, 0); // typeIdx operand is informational
    E.emitReturn(entry);

    const functions: FuncEntry[] = [
      {
        code: entry.code.slice(),
        constPool: entry.constPool.slice(),
        arity: 2,
        nLocals: 2,
        exceptionTable: [],
      },
      {
        code: add.code.slice(),
        constPool: add.constPool.slice(),
        arity: 2,
        nLocals: 2,
        exceptionTable: [],
      },
    ];
    const program: Program = { functions, entry: 0 };

    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [7, 7],
    ]) {
      expect(runProgram(program, [a, b]), `host CALL_REF add(${a},${b})`).toBe(a + b);
    }

    // null-funcref: push f64(-1) then CALL_REF → must trap.
    const nullEntry = new BytecodeSink();
    E.emitLocalGet(0, nullEntry);
    E.emitLocalGet(1, nullEntry);
    emitNumberConst(-1, nullEntry); // null funcref sentinel
    nullEntry.emit(OP.CALL_REF, 0);
    E.emitReturn(nullEntry);
    const nullProgram: Program = {
      functions: [
        {
          code: nullEntry.code.slice(),
          constPool: nullEntry.constPool.slice(),
          arity: 2,
          nLocals: 2,
          exceptionTable: [],
        },
        {
          code: add.code.slice(),
          constPool: add.constPool.slice(),
          arity: 2,
          nLocals: 2,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    expect(() => runProgram(nullProgram, [1, 2]), "null funcref CALL_REF traps").toThrow(/null funcref/);
  });

  // ── #1584 a2 struct/object family: STRUCT_NEW / STRUCT_GET / STRUCT_SET ──
  // Heap objects (VM-global), struct ref ≡ f64(heapIndex), null ≡ f64(-1).
  // mk(a,b){ const o = {x:a, y:b}; return o.x + o.y } proves host-VM ==
  // Wasm-GC-VM == JS for new + read; a STRUCT_SET round-trip and a null-struct
  // trap round out the family.
  it("a2: STRUCT_NEW/GET — host-VM == WasmGC-VM == JS for mk(a,b)={x:a,y:b}; x+y", async () => {
    // field0 = x, field1 = y (canonical order). Sequence:
    //   LOAD 0(a); LOAD 1(b); STRUCT_NEW 2 -> ref      ; STORE 2 (o)
    //   LOAD 2; STRUCT_GET 0 (o.x)
    //   LOAD 2; STRUCT_GET 1 (o.y)
    //   ADD; RET
    const s = new BytecodeSink();
    E.emitLocalGet(0, s); // a  (field0 = x)
    E.emitLocalGet(1, s); // b  (field1 = y)
    s.emit(OP.STRUCT_NEW, 2); // -> struct ref on stack
    E.emitLocalSet(2, s); // o = ref (local 2)
    E.emitLocalGet(2, s);
    s.emit(OP.STRUCT_GET, 0); // o.x
    E.emitLocalGet(2, s);
    s.emit(OP.STRUCT_GET, 1); // o.y
    E.emitBinary("f64.add", s);
    E.emitReturn(s);
    const js = (a: number, b: number): number => {
      const o = { x: a, y: b };
      return o.x + o.y;
    };
    const program: Program = {
      functions: [
        {
          code: s.code.slice(),
          constPool: s.constPool.slice(),
          arity: 2,
          nLocals: 3,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    const vmMod = compileProgramModule(
      ["a", "b"],
      [{ code: s.code, constPool: s.constPool, arity: 2, nLocals: 3 }],
      0,
      ["a", "b", "0"], // args[0]=a, args[1]=b, args[2]=o (struct local, 0-init)
    );
    for (const [a, b] of [
      [2, 3],
      [-5, 10],
      [0.5, 0.25],
      [100, -100],
    ]) {
      const expected = js(a, b);
      expect(runProgram(program, [a, b]), `host struct(${a},${b})`).toBe(expected);
      expect(await runWasm(vmMod, "run", [a, b]), `wasm struct(${a},${b})`).toBe(expected);
    }
  });

  it("a2: STRUCT_SET round-trip + null-struct (f64(-1)) traps", () => {
    // set(a){ const o={x:0}; o.x = a*3; return o.x } → field0 = x.
    //   CONST 0; STRUCT_NEW 1 -> ref; STORE 1 (o)
    //   LOAD 1; LOAD 0; CONST 3; MUL; STRUCT_SET 0   (o.x = a*3; stack [ref,val])
    //   LOAD 1; STRUCT_GET 0; RET
    const s = new BytecodeSink();
    emitNumberConst(0, s); // initial x = 0
    s.emit(OP.STRUCT_NEW, 1);
    E.emitLocalSet(1, s); // o (local 1)
    E.emitLocalGet(1, s); // ref (deeper)
    E.emitLocalGet(0, s); // a
    emitNumberConst(3, s);
    E.emitBinary("f64.mul", s); // a*3 (value on top)
    s.emit(OP.STRUCT_SET, 0); // o.x = a*3
    E.emitLocalGet(1, s);
    s.emit(OP.STRUCT_GET, 0); // o.x
    E.emitReturn(s);
    const program: Program = {
      functions: [
        {
          code: s.code.slice(),
          constPool: s.constPool.slice(),
          arity: 1,
          nLocals: 2,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    for (const a of [3, -4, 0, 1.5]) {
      expect(runProgram(program, [a]), `host struct-set(${a})`).toBe(a * 3);
    }

    // null-struct: push f64(-1) then STRUCT_GET → must trap.
    const nullGet = new BytecodeSink();
    emitNumberConst(-1, nullGet); // null struct ref
    nullGet.emit(OP.STRUCT_GET, 0);
    E.emitReturn(nullGet);
    const nullProgram: Program = {
      functions: [
        {
          code: nullGet.code.slice(),
          constPool: nullGet.constPool.slice(),
          arity: 0,
          nLocals: 0,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    expect(() => runProgram(nullProgram, []), "null struct STRUCT_GET traps").toThrow(/null struct/);
  });

  // ── #1584 a3 control-flow: JNZ (the exact dual of JZ; br_if maps here) ──
  // block/loop/br/br_if add NO opcode — the emitter resolves them to
  // JZ/JNZ/JMP + backpatched absolute targets. JNZ=28 is the only VM addition.
  // count(n) = a post-test (do-while) loop that runs `i++` while i < n. The
  // do-while shape (test at the BOTTOM, JNZ loop-back) is the natural fit for a
  // single backward JNZ; a pre-test `while` would use a JZ-exit + JMP-back pair.
  // For n>=1 it returns n; the JS reference mirrors the same do-while so they
  // agree (n=1 → exactly one iter). The point is the JNZ backward loop-back.
  //   CONST 0; STORE 1 (i=0)
  //   header:  LOAD 1; CONST 1; ADD; STORE 1   (i++)
  //            LOAD 1; LOAD 0; CMP_LT          (i < n ? 1 : 0)
  //            JNZ header                       (loop back while i<n)
  //   LOAD 1; RET                               (return i)
  // NB: this drives a HAND-BUILT bytecode loop stream through both VMs — it does
  // NOT lower a real loop FUNCTION through lower.ts end-to-end (loop-body i32/
  // struct ops still hit the requireInstrSink fence, later families). So it
  // proves the JNZ dispatch arm + a backward loop-back through the compiled
  // Wasm-GC-VM, not end-to-end loop compilation.
  it("a3: JNZ dispatch — host-VM == WasmGC-VM == JS for a hand-built do-while loop", async () => {
    const s = new BytecodeSink();
    emitNumberConst(0, s); // i = 0
    E.emitLocalSet(1, s); // STORE 1
    const header = s.here(); // loop-header address (absolute)
    E.emitLocalGet(1, s); // i
    emitNumberConst(1, s);
    E.emitBinary("f64.add", s); // i + 1
    E.emitLocalSet(1, s); // i = i + 1
    E.emitLocalGet(1, s); // i
    E.emitLocalGet(0, s); // n
    E.emitBinary("f64.lt", s); // i < n
    s.emit(OP.JNZ, header); // if nonzero (i<n) → loop back to header
    E.emitLocalGet(1, s); // i
    E.emitReturn(s);

    // Mirror the SAME do-while semantics (post-test) so the reference agrees.
    const js = (n: number): number => {
      let i = 0;
      do {
        i++;
      } while (i < n);
      return i;
    };
    const program: Program = {
      functions: [
        {
          code: s.code.slice(),
          constPool: s.constPool.slice(),
          arity: 1,
          nLocals: 2,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    const vmMod = compileProgramModule(
      ["n"],
      [{ code: s.code, constPool: s.constPool, arity: 1, nLocals: 2 }],
      0,
      ["n", "0"], // args[0]=n, args[1]=i (0-init)
    );
    for (const n of [1, 2, 5, 10, 100]) {
      const expected = js(n);
      expect(runProgram(program, [n]), `host count(${n})`).toBe(expected);
      expect(await runWasm(vmMod, "run", [n]), `wasm count(${n})`).toBe(expected);
    }
  });

  // ── #1584 a3 emitter stream-shape asserts (verbatim mirror of emitter2's a3
  // proof streams) — block/loop/br/br_if resolve to JZ/JNZ/JMP + backpatched
  // absolute targets, so the VM-side hand-built stream must equal the emitter's.
  it("a3: emitter stream shapes — JNZ/JMP backpatch (canonical + nested De Bruijn)", () => {
    // canonical `block{ loop{ cond; br_if 1(exit); body; br 0(continue) } }`:
    //   LOAD 0; JNZ 8(exit); LOAD 1; JMP 0(header)
    const canonical = new BytecodeSink();
    E.emitLocalGet(0, canonical);
    canonical.emit(OP.JNZ, 8);
    E.emitLocalGet(1, canonical);
    canonical.emit(OP.JMP, 0);
    expect(canonical.code).toEqual([OP.LOAD, 0, OP.JNZ, 8, OP.LOAD, 1, OP.JMP, 0]);

    // nested `block{loop{ block{loop{ br_if 1; br 0 }; br 0 }}}`:
    //   LOAD 0; JNZ 6(inner exit); JMP 0(inner header); JMP 0(outer header)
    const nested = new BytecodeSink();
    E.emitLocalGet(0, nested);
    nested.emit(OP.JNZ, 6);
    nested.emit(OP.JMP, 0);
    nested.emit(OP.JMP, 0);
    expect(nested.code).toEqual([OP.LOAD, 0, OP.JNZ, 6, OP.JMP, 0, OP.JMP, 0]);
  });

  // ── #1584 a4 try-throw family (THROW / TRY_START / TRY_END) ──
  // table-scan model: per-function exceptionTable, THROW unwinds to the innermost
  // covering handler (and across CALL frames). TRY_START/TRY_END are no-ops.
  // Runnable execution cases via the compiled VM (compileProgramModule now
  // threads exceptionTable) plus an emitter stream-shape mirror.
  it("a4: THROW/catch — host-VM == WasmGC-VM for try{throw 42}catch(e){return e}", async () => {
    // TRY_START<ct>; CONST 42; THROW; TRY_END; JMP end; ct: STORE 0; LOAD 0; RET
    const s = new BytecodeSink();
    const tsIdx = s.here();
    s.emit(OP.TRY_START, -1); // catchTarget backpatched
    const protStart = s.here();
    emitNumberConst(42, s);
    s.emit(OP.THROW);
    const protEnd = s.here();
    s.emit(OP.TRY_END);
    const toEnd = s.code.length;
    s.emit(OP.JMP, -1);
    const ct = s.here();
    E.emitLocalSet(0, s); // bind e
    E.emitLocalGet(0, s);
    E.emitReturn(s);
    s.code[toEnd + 1] = s.here(); // patch JMP→end
    s.code[tsIdx + 1] = ct; // patch TRY_START catchTarget (informational)
    const excTable = [{ tryStart: protStart, tryEnd: protEnd, catchTarget: ct, spAtEntry: 0 }];

    const program: Program = {
      functions: [
        {
          code: s.code.slice(),
          constPool: s.constPool.slice(),
          arity: 0,
          nLocals: 1,
          exceptionTable: excTable,
        },
      ],
      entry: 0,
    };
    const vmMod = compileProgramModule(
      [],
      [
        {
          code: s.code,
          constPool: s.constPool,
          arity: 0,
          nLocals: 1,
          exceptionTable: excTable,
        },
      ],
      0,
      ["0"], // local 0 = e (0-init)
    );
    expect(runProgram(program, []), "host throw/catch").toBe(42);
    expect(await runWasm(vmMod, "run", []), "wasm throw/catch").toBe(42);
  });

  it("a4: THROW unwinds across CALL frames; uncaught aborts the program", () => {
    // B(): throw 7  (no handler).  A(): try{ CALL B }catch(e){ return e }.
    const B = new BytecodeSink();
    emitNumberConst(7, B);
    B.emit(OP.THROW);
    E.emitReturn(B);

    const A = new BytecodeSink();
    const tsIdx = A.here();
    A.emit(OP.TRY_START, -1);
    const protStart = A.here();
    A.emit(OP.CALL, 1); // CALL B
    const protEnd = A.here();
    A.emit(OP.TRY_END);
    const toEnd = A.code.length;
    A.emit(OP.JMP, -1);
    const ct = A.here();
    E.emitLocalSet(0, A);
    E.emitLocalGet(0, A);
    E.emitReturn(A);
    A.code[toEnd + 1] = A.here();
    A.code[tsIdx + 1] = ct;

    const caught: Program = {
      functions: [
        {
          code: A.code.slice(),
          constPool: A.constPool.slice(),
          arity: 0,
          nLocals: 1,
          exceptionTable: [
            {
              tryStart: protStart,
              tryEnd: protEnd,
              catchTarget: ct,
              spAtEntry: 0,
            },
          ],
        },
        {
          code: B.code.slice(),
          constPool: B.constPool.slice(),
          arity: 0,
          nLocals: 0,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    expect(runProgram(caught, []), "throw across CALL → caught by A").toBe(7);

    // Same B, but the entry has NO handler → the throw escapes the program.
    const noHandler = new BytecodeSink();
    noHandler.emit(OP.CALL, 1);
    E.emitReturn(noHandler);
    const uncaught: Program = {
      functions: [
        {
          code: noHandler.code.slice(),
          constPool: noHandler.constPool.slice(),
          arity: 0,
          nLocals: 0,
          exceptionTable: [],
        },
        {
          code: B.code.slice(),
          constPool: B.constPool.slice(),
          arity: 0,
          nLocals: 0,
          exceptionTable: [],
        },
      ],
      entry: 0,
    };
    expect(() => runProgram(uncaught, []), "uncaught throw aborts").toThrow(/uncaught throw/);
  });

  // ── Sanity: the host VM still rejects malformed; the emitter rejects ops ──
  // outside the #1584 production subset. (The subset has grown with #958:
  // f64.div / f64.ne are now IN-subset, so the out-of-subset probe uses ops the
  // production emitter still rejects — a binary not in binopToOpcode and a unary
  // that isn't f64.neg.)
  it("host VM rejects malformed + out-of-subset ops", () => {
    const s = new BytecodeSink();
    emitNumberConst(1, s); // never RET → runs off the end
    expect(() => runSink(s, [])).toThrow(/unknown opcode/);
    // f64.min has no opcode in the production subset → emitter throws.
    expect(() => E.emitBinary("f64.min", s)).toThrow(/not in the #1584/);
    // Only f64.neg is a supported unary; i32.eqz is rejected.
    expect(() => E.emitUnary("i32.eqz", s)).toThrow(/not in the #1584/);
  });
});
