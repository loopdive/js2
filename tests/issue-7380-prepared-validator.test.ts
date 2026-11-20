// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 PR 3 — the Prepared validator, one check per stage boundary. Each seed takes the real stage input of one
// small program, changes one field of a copy, and calls the stage's check directly; its twin calls the check on the
// same copy unchanged. Seed 16 shows what stops a broken module when the validator is off: the binary emitter's index
// check and the engine gate.
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { gateEmittedModule } from "../src/compiler/validation.js";
import { emitBinary } from "../src/emit/binary.js";
import type { CompileError } from "../src/index.js";
import { mapNestedBuffers, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import type { PreparedIrBackendOptions, PreparedIrProgram } from "../src/ir/program.js";
import { PreparedValidatorError, validatePreparedStage } from "../src/ir/program/prepared-validator.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import type { WasmModule } from "../src/ir/types.js";
import { preparedValidationEnabled } from "../src/shared/contracts/prepared-validation.js";
import { assertPhysicalModule } from "../src/wasm/physical/validate-module.js";

// One program reaches every stage input the seeds change: a call (f), a source global (x), a runtime function
// (`%` calls __fmod), an intrinsic with a provider (the thrown number is boxed).
const SOURCE = "var x = 7; function f() { return x % 3; } x = f() + 1; if (x !== 2) throw 1;";
const OPTIONS: PreparedIrBackendOptions = {
  backend: "wasmgc",
  target: "standalone",
  sharedExceptionTag: false,
  utf8Storage: false,
  sourceMap: false,
  moduleName: "test",
};

let program: PreparedIrProgram;
let module: WasmModule;

beforeAll(async () => {
  let captured: PreparedIrProgram | undefined;
  const stop = subscribePreparedIrProgram((event) => {
    if (event.phase === "prepared") captured = event.program;
  });
  const result = await compile(SOURCE, {
    wholeProgram: { kind: "prepared-program-required", version: 1 },
    backend: "wasmgc",
    target: "standalone",
    allowJs: true,
    fileName: "test.js",
  } as never);
  stop();
  expect(result.success).toBe(true);
  program = captured!;
  const accepted = acceptPreparedIrProgram(program, OPTIONS);
  if (accepted.kind !== "accepted") throw new Error("the seed program must be accepted");
  module = emitAcceptedIrProgram(accepted).module;
});

const fnNamed = (fns: readonly IrFunction[], name: string): IrFunction => fns.find((fn) => fn.name === name)!;
const block0 = (fn: IrFunction) => fn.blocks[0]!;
/** `fn` with its first block's instruction list rewritten. */
const withInstrs = (fn: IrFunction, rewrite: (instrs: readonly IrInstr[]) => readonly IrInstr[]): IrFunction => ({
  ...fn,
  blocks: [{ ...block0(fn), instrs: rewrite(block0(fn).instrs) }, ...fn.blocks.slice(1)],
});
/** The program with one semantic body replaced. */
const withBody = (name: string, rewrite: (fn: IrFunction) => IrFunction): PreparedIrProgram => ({
  ...program,
  ir: { ...program.ir, functions: program.ir.functions.map((fn) => (fn.name === name ? rewrite(fn) : fn)) },
});
/** The program with its one runtime projection rewritten. */
const withProjection = (
  rewrite: (
    prepared: PreparedIrProgram["runtime"][number]["prepared"],
  ) => PreparedIrProgram["runtime"][number]["prepared"],
): PreparedIrProgram => ({
  ...program,
  runtime: program.runtime.map((projection) => ({ ...projection, prepared: rewrite(projection.prepared) })),
});
/** `instr` and every instruction nested in it, with each intrinsic's provider removed. */
const withoutProviders = (instr: IrInstr): IrInstr => {
  const mapped = mapNestedBuffers(instr, (buffer) => buffer.map(withoutProviders));
  if (mapped.kind !== "intrinsic") return mapped;
  const { provider: _provider, ...stripped } = mapped;
  return stripped;
};
const funcCount = (m: WasmModule) => m.imports.filter((row) => row.desc.kind === "func").length + m.functions.length;
/** The module with an instruction placed in front of the startup body. */
const withLeadingInstr = (instr: WasmModule["functions"][number]["body"][number]): WasmModule => ({
  ...module,
  functions: module.functions.map((fn) => (fn.name === "__module_init" ? { ...fn, body: [instr, ...fn.body] } : fn)),
});
const fmodIndex = (): number =>
  funcCount(module) - module.functions.length + module.functions.findIndex((fn) => fn.name === "__fmod");
const seed12 = (): WasmModule => withLeadingInstr({ op: "call", funcIdx: funcCount(module) });
const seed13 = (): WasmModule => withLeadingInstr({ op: "global.get", index: module.globals.length });
/** The startup body given the signature of `__fmod`, `(f64, f64) -> f64`. */
const seed15 = (): WasmModule => {
  const fmod = module.functions.find((fn) => fn.name === "__fmod")!;
  return {
    ...module,
    functions: module.functions.map((fn) => (fn.name === "__module_init" ? { ...fn, typeIdx: fmod.typeIdx } : fn)),
  };
};

type ModuleFunction = WasmModule["functions"][number];
const withFunction = (name: string, rewrite: (fn: ModuleFunction) => ModuleFunction): WasmModule => ({
  ...module,
  functions: module.functions.map((fn) => (fn.name === name ? rewrite(fn) : fn)),
});
const seedRetypedLocals = (): WasmModule =>
  withFunction("f", (fn) => ({
    ...fn,
    locals: fn.locals.map((local) => (local.type.kind === "f64" ? { ...local, type: { kind: "i32" } } : local)),
  }));
const seedWrongGlobal = (): WasmModule => {
  const x = module.globals.findIndex((global) => global.type.kind === "f64");
  const text = module.globals.findIndex((global) => global.type.kind === "ref");
  return withFunction("f", (fn) => ({
    ...fn,
    body: fn.body.map((instr) => (instr.op === "global.get" && instr.index === x ? { ...instr, index: text } : instr)),
  }));
};
const seedWrongArguments = (): WasmModule =>
  withFunction("<module-init>", (fn) => ({
    ...fn,
    body: fn.body.flatMap((instr) =>
      instr.op === "call"
        ? [
            { op: "i32.const", value: 0 } as const,
            { op: "i32.const", value: 0 } as const,
            { op: "call", funcIdx: fmodIndex() } as const,
          ]
        : [instr],
    ),
  }));
/** The error codes the engine gate (stage 5) reports for the module's bytes. */
const engineGate = (value: WasmModule): string[] => {
  const errors: CompileError[] = [];
  gateEmittedModule(emitBinary(value), {}, errors, ts.createSourceFile("test.js", SOURCE, ts.ScriptTarget.Latest));
  return errors.map((error) => error.code ?? "");
};

/** Stage 1 reports errors instead of throwing; the stage 2 caller turns them into one invariant error. */
function stage1(fn: IrFunction): void {
  const errors = verifyIrFunction(fn);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
}
const stage2 = (value: PreparedIrProgram) => () =>
  validatePreparedStage("prepared program", () => assertPreparedIrProgram(value));
const stage4 = (value: WasmModule) => () => validatePreparedStage("physical module", () => assertPhysicalModule(value));

interface Seed {
  readonly stage: string;
  readonly seed: string;
  readonly twin: () => () => void;
  readonly altered: () => () => void;
  readonly expected: RegExp;
}

const SEEDS: readonly Seed[] = [
  {
    stage: "1 lowered IR",
    seed: "an i32.and operand replaced by an f64 value (wrong type)",
    twin: () => () => stage1(fnNamed(program.ir.functions, "f")),
    altered: () => () =>
      stage1(
        withInstrs(fnNamed(program.ir.functions, "f"), (instrs) =>
          instrs.map((instr) => (instr.kind === "binary" && instr.op === "i32.and" ? { ...instr, lhs: 0 } : instr)),
        ),
      ),
    expected: /i32\.and/,
  },
  {
    stage: "1 lowered IR",
    seed: "a use of a value id no instruction defines",
    twin: () => () => stage1(fnNamed(program.ir.functions, "<module-init>")),
    altered: () => () =>
      stage1(
        withInstrs(fnNamed(program.ir.functions, "<module-init>"), (instrs) =>
          instrs.map((instr) => (instr.kind === "binary" ? { ...instr, rhs: 99 } : instr)),
        ),
      ),
    expected: /99/,
  },
  {
    stage: "1 lowered IR",
    seed: "a block whose terminator branches to a block that does not exist",
    twin: () => () => stage1(fnNamed(program.ir.functions, "f")),
    altered: () => () => {
      const fn = fnNamed(program.ir.functions, "f");
      stage1({
        ...fn,
        blocks: [{ ...block0(fn), terminator: { kind: "br", branch: { target: 7, args: [] } } as never }],
      });
    },
    expected: /nonexistent block 7/,
  },
  {
    stage: "2 prepared program",
    seed: "a call whose target has no ABI entry",
    twin: () => stage2(withBody("<module-init>", (fn) => fn)),
    altered: () =>
      stage2(
        withBody("<module-init>", (fn) =>
          withInstrs(fn, (instrs) =>
            instrs.map((instr) =>
              instr.kind === "call"
                ? { ...instr, target: { ...instr.target, binding: { kind: "unit", unitId: "ir-unit:v1:absent" } } }
                : instr,
            ),
          ),
        ),
      ),
    expected: /prepared validator \(prepared program\): body .* references missing body ir-unit:v1:absent/,
  },
  {
    stage: "2 prepared program",
    seed: "two ABI entries with one binding id (duplicate slot)",
    twin: () => stage2({ ...program, abi: { ...program.abi, entries: [...program.abi.entries] } }),
    altered: () =>
      stage2({ ...program, abi: { ...program.abi, entries: [...program.abi.entries, program.abi.entries[0]!] } }),
    expected: /prepared validator \(prepared program\): program ABI duplicates a binding/,
  },
  {
    stage: "2 prepared program",
    seed: "a body whose result type differs from its ABI contract",
    twin: () => stage2(withBody("f", (fn) => ({ ...fn }))),
    altered: () => stage2(withBody("f", (fn) => ({ ...fn, resultTypes: [{ kind: "val", val: { kind: "i32" } }] }))),
    expected: /prepared validator \(prepared program\): body .* lacks its exact declared ABI/,
  },
  {
    stage: "2 prepared program",
    seed: "an intrinsic whose provider is removed from the manifest (missing provider)",
    twin: () => stage2(withProjection((prepared) => ({ ...prepared }))),
    altered: () =>
      stage2(
        withProjection((prepared) => ({
          ...prepared,
          manifest: {
            ...prepared.manifest,
            providers: prepared.manifest.providers.filter((row) => row.feature !== "js.number.box"),
          },
        })),
      ),
    expected: /prepared validator \(prepared program\): .*intrinsic js\.number\.box has 0 selected providers/,
  },
  {
    stage: "2 prepared program",
    seed: "an intrinsic whose provider the manifest selects twice",
    twin: () => stage2(withProjection((prepared) => ({ ...prepared }))),
    altered: () =>
      stage2(
        withProjection((prepared) => ({
          ...prepared,
          manifest: {
            ...prepared.manifest,
            providers: [
              ...prepared.manifest.providers,
              prepared.manifest.providers.find((row) => row.feature === "js.number.box")!,
            ],
          },
        })),
      ),
    expected: /prepared validator \(prepared program\): .*intrinsic js\.number\.box has 2 selected providers/,
  },
  {
    stage: "2 prepared program",
    seed: "an intrinsic stripped of the provider legalization attached",
    twin: () => stage2(withProjection((prepared) => ({ ...prepared }))),
    altered: () =>
      stage2(
        withProjection((prepared) => ({
          ...prepared,
          functions: prepared.functions.map((fn) => ({
            ...fn,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.map(withoutProviders),
            })),
          })),
        })),
      ),
    expected: /prepared validator \(prepared program\): .*intrinsic js\.number\.box has no provider/,
  },
  {
    stage: "2 prepared program",
    seed: "a dyn.member_get left in a body",
    twin: () => stage2(withProjection((prepared) => ({ ...prepared }))),
    altered: () =>
      stage2(
        withProjection((prepared) => ({
          ...prepared,
          functions: prepared.functions.map((fn) =>
            fn.name === "f"
              ? withInstrs(fn, (instrs) => [
                  { kind: "dyn.member_get", recv: 0, key: 0, result: 98, resultType: null } as never,
                  ...instrs,
                ])
              : fn,
          ),
        })),
      ),
    expected: /prepared validator \(prepared program\): body .* retains dyn\.member_get after legalization/,
  },
  {
    stage: "2 prepared program",
    seed: "a dynamic result type left on a projection body",
    twin: () => stage2(withProjection((prepared) => ({ ...prepared }))),
    altered: () =>
      stage2(
        withProjection((prepared) => ({
          ...prepared,
          functions: prepared.functions.map((fn) =>
            fn.name === "f" ? { ...fn, resultTypes: [{ kind: "dynamic" } as never] } : fn,
          ),
        })),
      ),
    expected: /prepared validator \(prepared program\): body .* retains a dynamic type after legalization/,
  },
  {
    stage: "4 physical module",
    seed: "a call with funcIdx equal to the function count (out-of-range index)",
    twin: () => stage4({ ...module }),
    altered: () => stage4(seed12()),
    expected: /prepared validator \(physical module\): unresolved function index/,
  },
  {
    stage: "4 physical module",
    seed: "a global.get past the last global",
    twin: () => stage4({ ...module }),
    altered: () => stage4(seed13()),
    expected: /prepared validator \(physical module\): unresolved global index/,
  },
  {
    stage: "4 physical module",
    seed: "a global of a type index past the last type",
    twin: () => stage4({ ...module, globals: [...module.globals] }),
    altered: () =>
      stage4({
        ...module,
        globals: module.globals.map((global, index) =>
          index === 0 ? { ...global, type: { kind: "ref_null", typeIdx: 9999 } } : global,
        ),
      }),
    expected: /prepared validator \(physical module\): unresolved type index 9999/,
  },
  {
    stage: "4 physical module",
    seed: "a ref.func of a function nothing declares",
    twin: () => stage4({ ...module }),
    altered: () => stage4(withLeadingInstr({ op: "ref.func", funcIdx: fmodIndex() })),
    expected: /prepared validator \(physical module\): undeclared ref\.func target/,
  },
  {
    stage: "4 physical module",
    seed: "a global export past the last global",
    twin: () => stage4({ ...module, exports: [{ name: "g", desc: { kind: "global", index: 0 } }] }),
    altered: () =>
      stage4({ ...module, exports: [{ name: "g", desc: { kind: "global", index: module.globals.length } }] }),
    expected: /prepared validator \(physical module\): unresolved global export index/,
  },
  {
    stage: "4 physical module",
    seed: "a local of a type index past the last type",
    twin: () => stage4({ ...module }),
    altered: () =>
      stage4({
        ...module,
        functions: module.functions.map((fn) =>
          fn.name === "__module_init"
            ? { ...fn, locals: [...fn.locals, { name: "seed", type: { kind: "ref_null", typeIdx: 9999 } }] }
            : fn,
        ),
      }),
    expected: /prepared validator \(physical module\): unresolved type index 9999/,
  },
  {
    stage: "4 physical module",
    seed: "two exports with one name",
    twin: () => stage4({ ...module, exports: [{ name: "a", desc: { kind: "func", index: 0 } }] }),
    altered: () =>
      stage4({
        ...module,
        exports: [
          { name: "a", desc: { kind: "func", index: 0 } },
          { name: "a", desc: { kind: "func", index: 1 } },
        ],
      }),
    expected: /prepared validator \(physical module\): duplicate export name a/,
  },
  {
    stage: "4 physical module",
    seed: "a start function with a parameter",
    twin: () => stage4({ ...module }),
    altered: () => stage4(seed15()),
    expected: /prepared validator \(physical module\): start function must have signature \(\) -> \(\)/,
  },
];

describe("#7380 — the Prepared validator rejects one seeded defect per row and accepts its twin", () => {
  it("runs with the validator on, as every test does", () => {
    expect(preparedValidationEnabled()).toBe(true);
  });

  for (const { stage, seed, twin, altered, expected } of SEEDS) {
    it(`stage ${stage}: ${seed}`, () => {
      expect(twin()).not.toThrow();
      expect(altered()).toThrow(expected);
    });
  }

  it("a stage 2 to 4 violation is an internal validator error that names its stage, never a refusal", () => {
    const thrown = (() => {
      try {
        stage4(seed12())();
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(PreparedValidatorError);
    expect((thrown as PreparedValidatorError).stage).toBe("physical module");
  });

  // Seed 16: with stages 2 to 4 off (a production compile), the broken modules still never report success. The
  // binary emitter refuses an index out of range (compile() reports it as "Binary emit error"); a well-indexed but
  // ill-typed module reaches the engine gate, which reports `invalid-module`.
  it.each([
    ["12", seed12, /function index out of range/],
    ["13", seed13, /global index out of range/],
  ])("stage 5: seed %s is refused by the binary emitter", (_name, seeded, expected) => {
    expect(() => emitBinary(seeded())).toThrow(expected);
  });

  it("stage 5: seed 15 emitted to bytes is an invalid-module error", () => {
    expect(engineGate(module)).toEqual([]);
    expect(engineGate(seed15())).toEqual(["invalid-module"]);
  });

  // Defects every index still resolves under: stages 2 to 4 accept them, and only the engine gate stage 5
  // (`gateEmittedModule`, run by `finalizePipelineModule` on every compile, validator on or off) rejects them.
  it.each([
    ["f's f64 locals retyped to i32", seedRetypedLocals],
    ["f reads the string global where it read the f64 global x", seedWrongGlobal],
    ["startup passes two i32 values to __fmod (f64, f64)", seedWrongArguments],
  ])("stage 5: %s passes stage 4 and is an invalid-module error", (_name, seeded) => {
    expect(stage4(seeded())).not.toThrow();
    expect(engineGate(seeded())).toEqual(["invalid-module"]);
  });
});
