// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, validateEmittedBinary } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Re-declared, not imported: the probe module runs its compile on import.
// Same convention as `eslint-graph-probe.ts` vs `compile-project-probe.ts`.
const COMPILE_FILES_VALIDATE_PROBE_MARKER = "__JS2_COMPILE_FILES_VALIDATE_PROBE__";

/**
 * #4420 — a compile could report `success: true` and hand back a module the
 * engine rejects. Two halves, both pinned here.
 *
 * PART 1 — the gate. `success` only ever meant "codegen finished". The opt-in
 * `validate: true` option makes it mean "the engine accepts these bytes":
 * `validateEmittedBinary` (src/optimize.ts) is the single implementation of the
 * validate-then-recover-the-engine-detail idiom, shared by the CLI's
 * refuse-to-publish check (#3338), the optimizer's own output check (#1941) and
 * this option.
 *
 * PART 2 — the miscompile the gate exposed. Compiling the compiler's own
 * `src/emit/binary.ts` produced
 *   `Compiling function #103:"encodeInstr" failed: struct.get[0] expected type
 *    (ref null 2), found local.tee of type f64`
 * from `const hasElse = instr.else && instr.else.length > 0;`. `Instr` is an
 * INTERSECTION (`(…variants…) & { sourcePos?: SourcePos }`), so its narrowed
 * receiver never registers a WasmGC struct and the read goes through the
 * dynamic property dispatch. There the Phase-3 (#1269) result narrowing voted
 * on every struct in the module carrying a field NAMED `else` — the only one
 * being the all-f64 `OP` opcode table — and collapsed the read of an `Instr[]`
 * to f64, while the enclosing `.length` still emitted the typed
 * `struct.get $__vec_externref 0`. The vote is now admissible only when the
 * access's own static type is externref (genuinely dynamic); a concrete
 * `ref`/`ref_null` access type may not be overruled by a name collision.
 */

// The minimized construct, reduced from `encodeInstr`. Every ingredient is
// load-bearing: the union must be INTERSECTED (otherwise the narrowed receiver
// registers an anon struct that also carries `else`, the field-kind vote then
// disagrees, and the defect hides), the numeric table must collide on the
// property NAME, and the read must be an array whose `.length` is taken.
const MINIMIZED = `
  type Pos = { line: number };

  type Node = ({ op: "block"; body: Node[] } | { op: "if"; then: Node[]; else?: Node[] }) & { pos?: Pos };

  const OP = { block: 2, if: 4, else: 5 };

  function encode(n: Node): number {
    if (n.op === "if") {
      const hasElse = n.else && n.else.length > 0;
      return hasElse ? OP.else : OP.if;
    }
    return OP.block;
  }

  export function main(): number {
    const withElse: Node = { op: "if", then: [], else: [{ op: "block", body: [] }] };
    const without: Node = { op: "if", then: [] };
    return encode(withElse) * 10 + encode(without);
  }
`;

describe("#4420 Part 2 — dynamic-dispatch result narrowing vs. a typed access", () => {
  it("emits a module the engine accepts", async () => {
    const result = await compile(MINIMIZED, {});
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    // Before the fix: `struct.get[0] expected type (ref null 2), found
    // local.tee of type f64` — reported by the engine, not by the compiler.
    expect(validateEmittedBinary(result.binary).detail ?? "").toBe("");
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("computes the right answer through the dynamic read", async () => {
    const result = await compile(MINIMIZED, {});
    expect(result.success).toBe(true);
    const instance = await instantiateWithRuntime(result);
    // `else` present → OP.else (5); absent → OP.if (4).
    expect((instance.exports.main as () => number)()).toBe(54);
  });
});

describe("#4420 Part 1 — the opt-in validate gate", () => {
  it("validateEmittedBinary reports the engine's detail for rejected bytes", () => {
    // A well-formed header followed by a garbage section: `validate` says no,
    // and the detail string is what makes such a failure diagnosable at all.
    const bogus = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0x7f, 0x7f, 0x7f]);
    const verdict = validateEmittedBinary(bogus);
    expect(verdict.valid).toBe(false);
    expect(verdict.detail !== undefined && verdict.detail.length > 0).toBe(true);
  });

  it("accepts a valid module and leaves the emitted bytes untouched", async () => {
    const source = `export function add(a: number, b: number): number { return a + b; }`;
    const gated = await compile(source, { validate: true });
    expect(gated.success).toBe(true);
    expect(gated.errors.filter((e) => e.severity === "error")).toEqual([]);
    const ungated = await compile(source, {});
    expect(gated.binary.length).toBe(ungated.binary.length);
  });
});

describe("#4420 acceptance — self-compiling src/emit/binary.ts", () => {
  // Cost note: ~14 s wall on an 8-core container (a real compiler source file
  // plus its whole import graph, ~270 KB of Wasm), so the test carries an
  // explicit timeout well past vitest's 5 s default.
  //
  // Run OUT OF PROCESS, like `compile-project-probe.ts`: the fork pool caps a
  // worker at 512 MB (`VITEST_FORK_MAX_OLD_SPACE_SIZE`) and this graph exhausts
  // that heap, which surfaces as a worker crash — an infrastructure failure,
  // not a verdict — rather than as a test result.
  it("returns success under the validate gate and yields a module WebAssembly.compile accepts", () => {
    const probe = fileURLToPath(new URL("./helpers/compile-files-validate-probe.ts", import.meta.url));
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", probe, "src/emit/binary.ts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 240_000,
      },
    );
    const marked = (child.stdout ?? "")
      .split("\n")
      .find((line) => line.startsWith(COMPILE_FILES_VALIDATE_PROBE_MARKER));
    expect(marked, `probe produced no verdict:\n${child.stderr ?? ""}`).toBeDefined();
    const report = JSON.parse(marked!.slice(COMPILE_FILES_VALIDATE_PROBE_MARKER.length)) as {
      success: boolean;
      binaryByteLength: number;
      engineAccepts: boolean;
      engineError: string | null;
      errors: { message: string }[];
    };
    // The two axes, asserted separately and in this order: the engine's
    // verdict is the ground truth, and `success` is only trustworthy because
    // the gate now derives it from that verdict.
    expect(report.engineError ?? "").toBe("");
    expect(report.engineAccepts).toBe(true);
    expect(report.success, report.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(report.binaryByteLength).toBeGreaterThan(0);
  }, 300_000);
});
