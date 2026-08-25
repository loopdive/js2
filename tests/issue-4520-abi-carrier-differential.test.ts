// #4520 — differential gate for the ABI carrier oracles.
//
// `hasFullyAnnotatedScalarAbi` (select-stage caller-closure certification)
// promises that for every certified declaration the direct and IR front-ends
// derive the SAME wasm signature — so a legacy caller's pre-emitted `call`
// stays valid when the IR overlay owns the callee. Until now that promise was
// argued in comments only; the `mname` episode (#3518 notes, 2026-08-15)
// showed such arguments go wrong in both directions.
//
// The witness used here is semantic, not textual: in the host-free lanes
// (standalone / wasi — the ONLY lanes where the certification is consulted;
// `demoteOnLegacyCallerPolicy` is false in host mode, structurally) each cell
// compiles one module whose only caller of `f` is deliberately unclaimable
// (it contains `**`, rejected at `expr-binary-op-**`), once with the IR
// overlay on and once pure-legacy. If certification granted a divergent
// carrier, the overlay-patched module could not validate (a wasm `call` is
// type-checked against the callee's declared signature at validation time)
// or would diverge at run time. So: certification granted ⇒ callee actually
// IR-claimed ⇒ module validates ⇒ run value identical to pure legacy.
//
// Denied cells assert the predicate refuses them and record whether the
// denial is a genuine divergence or conservative-but-sound (the
// `mname`-style false-exclusion class stays visible instead of latent).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { hasFullyAnnotatedScalarAbi } from "../src/codegen/ir-legacy-caller-abi.js";
import { ts } from "../src/ts-api.js";

const REPO = join(__dirname, "..");

interface Cell {
  readonly key: string;
  /** Declaration of `f` — the certification subject. */
  readonly decl: string;
  /** Body of the unclaimable caller `probe(): number`; must contain `**`. */
  readonly probeBody: string;
  /** Expected `hasFullyAnnotatedScalarAbi` verdict (evidence: not overridden). */
  readonly certified: boolean;
  /**
   * Expected standalone claim outcome for `f`. Usually === certified; a
   * certified cell whose BODY the IR cannot lower documents the split here
   * (certification is a signature proof, not a body-lowerability proof).
   */
  readonly expectClaimed: boolean;
  /** For denied cells: diverge (carriers really differ) vs conservative. */
  readonly why: string;
}

const CELLS: readonly Cell[] = [
  // ---- certified surface: every position annotated from the scalar family --
  {
    key: "number-param-number-return",
    decl: `export function f(a: number): number { return a * 2; }`,
    probeBody: `const y = 2 ** 1; return f(y) * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "number → f64 in both front-ends",
  },
  {
    key: "boolean-param",
    decl: `export function f(a: boolean): number { return a ? 3 : 4; }`,
    probeBody: `const y = 2 ** 1; return f(y > 1) * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "boolean → i32 in both front-ends",
  },
  {
    key: "string-param",
    decl: `export function f(a: number, s: string): number { return a + s.length; }`,
    probeBody: `const y = 2 ** 1; return f(y, "abc") * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "string → one nativeStrings-keyed carrier in both front-ends (the mname proof)",
  },
  {
    key: "string-return",
    decl: `export function f(a: number): string { return a > 1 ? "long" : "s"; }`,
    probeBody: `const y = 2 ** 1; return f(y).length * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "same carrier pair on the return position",
  },
  {
    key: "number-array-param",
    decl: `export function f(a: number[]): number { return a.length + a[0]; }`,
    probeBody: `const y = 2 ** 1; return f([7, 8, 9]) * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "number[] → the interned (ref_null $vec_f64) both sides",
  },
  {
    key: "boolean-array-param",
    decl: `export function f(a: boolean[]): number { return a.length; }`,
    probeBody: `const y = 2 ** 1; return f([true, false]) * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "boolean[] → the interned i32-element vec both sides",
  },
  {
    key: "boolean-return",
    decl: `export function f(a: number): boolean { return a > 1; }`,
    probeBody: `const y = 2 ** 1; return (f(y) ? 7 : 3) * 10 + y;`,
    certified: true,
    expectClaimed: true,
    why: "boolean return → i32 both sides",
  },
  {
    key: "void-return",
    decl: `let seen = 0;\nexport function f(a: number): void { seen = a; }`,
    probeBody: `const y = 2 ** 1; f(y); return y * 10;`,
    certified: true,
    expectClaimed: true,
    why:
      "void → no result both sides; the module-scope write is claimable since " +
      "#2856 capability C (module-scope mutable bindings)",
  },
  // ---- denied surface ------------------------------------------------------
  {
    key: "optional-param",
    decl: `export function f(a: number, s?: string): number { return a + (s ? s.length : 0); }`,
    probeBody: `const y = 2 ** 1; return f(y, "abc") * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: arity/undefined-sentinel handling is part of the ABI",
  },
  {
    key: "default-param",
    decl: `export function f(a: number, b: number = 5): number { return a + b; }`,
    probeBody: `const y = 2 ** 1; return f(y) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: legacy default-application rewrites the effective signature",
  },
  {
    key: "rest-param",
    decl: `export function f(a: number, ...rest: number[]): number { return a + rest.length; }`,
    probeBody: `const y = 2 ** 1; return f(y, 1, 2) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: rest packing is a calling-convention rewrite",
  },
  {
    key: "destructured-param",
    decl: `export function f([a, b]: number[]): number { return a + b; }`,
    probeBody: `const y = 2 ** 1; return f([3, 4]) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: bindingPatternParamNeedsWiden widens the param to externref regardless of annotation",
  },
  {
    key: "string-array-param",
    decl: `export function f(a: string[]): number { return a.length; }`,
    probeBody: `const y = 2 ** 1; return f(["a", "b"]) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why:
      "conservative: the string-vec ELEMENT carrier is a vec-layout decision " +
      "(getOrRegisterVecType vs resolvePositionType element arm) the predicate " +
      "does not reproduce — candidate for a follow-up widening with its own proof",
  },
  {
    key: "nested-array-param",
    decl: `export function f(a: number[][]): number { return a.length; }`,
    probeBody: `const y = 2 ** 1; return f([[1], [2]]) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: a vec whose element is a vec is unrepresentable in prepared-vector-support (#4470)",
  },
  {
    key: "unannotated-param",
    decl: `export function f(a): number { return a ? 1 : 0; }`,
    probeBody: `const y = 2 ** 1; return f(y) * 10 + y;`,
    certified: false,
    expectClaimed: true,
    why:
      "denied by THIS predicate (implicit positions are the #4186 split-brain " +
      "surface) but still claimed: the production legacyCallerAbiIsProjected " +
      "wiring carries a separate, pre-existing implicit/projected-param " +
      "certification arm that owns this family — the two oracles partition the " +
      "surface rather than overlap",
  },
  {
    key: "unannotated-return",
    decl: `export function f(a: number) { return a * 2; }`,
    probeBody: `const y = 2 ** 1; return f(y) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "conservative: the inferred return could be provable scalar, but inference is not syntax — no annotation, no proof",
  },
  {
    key: "async-fn",
    decl: `export async function f(a: number): Promise<number> { return a; }`,
    probeBody: `const y = 2 ** 1; f(y); return y * 10;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: prepareAsyncCallableAbi rewrites the signature",
  },
  {
    key: "generator-fn",
    decl: `export function* f(a: number): Generator<number> { yield a; }`,
    probeBody: `const y = 2 ** 1; f(y); return y * 10;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: the generator state-struct rewrites the signature",
  },
  {
    key: "generic-fn",
    decl: `export function f<T>(a: number): number { return a; }`,
    probeBody: `const y = 2 ** 1; return f(y) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "diverge: call-site specialisation rewrites the signature per instantiation",
  },
  {
    key: "object-literal-type-param",
    decl: `export function f(a: { p: number }): number { return a.p; }`,
    probeBody: `const y = 2 ** 1; return f({ p: y }) * 10 + y;`,
    certified: false,
    expectClaimed: false,
    why: "conservative: object carriers depend on shape-struct decisions the predicate does not reproduce",
  },
];

function parseDecl(cell: Cell): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("t.ts", cell.decl, ts.ScriptTarget.Latest, true);
  let found: ts.FunctionDeclaration | undefined;
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "f") found = node;
  });
  if (!found) throw new Error(`cell ${cell.key}: no function f in decl`);
  return found;
}

function moduleSource(cell: Cell): string {
  return `${cell.decl}\nexport function probe(): number { ${cell.probeBody} }\n`;
}

const WASI_STUB = { wasi_snapshot_preview1: new Proxy({}, { get: () => () => 0 }) } as never;

async function compileLane(
  source: string,
  target: "standalone" | "wasi",
  legacy: boolean,
): Promise<{ binary: Uint8Array; claimed: boolean }> {
  const options = legacy ? { fileName: "t.ts", target, experimentalIR: false } : { fileName: "t.ts", target };
  const result = await compile(source, options as never);
  expect(result.success, result.success ? "" : result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!result.success) throw new Error("unreachable");
  return { binary: result.binary, claimed: (result.irCompiledFuncs ?? []).includes("f") };
}

describe("#4520 ABI carrier differential gate", () => {
  it("the predicate's grant/deny surface matches the row table", () => {
    for (const cell of CELLS) {
      const decl = parseDecl(cell);
      const verdict = hasFullyAnnotatedScalarAbi(decl, { returnCarrierIsOverridden: () => false });
      expect(verdict, `${cell.key}: ${cell.why}`).toBe(cell.certified);
    }
  });

  it("without override evidence, non-void returns are fail-closed", () => {
    const scalar = parseDecl(CELLS.find((c) => c.key === "number-param-number-return")!);
    expect(hasFullyAnnotatedScalarAbi(scalar)).toBe(false);
    const voidCell = parseDecl(CELLS.find((c) => c.key === "void-return")!);
    // void needs no evidence: there is no return carrier to override.
    expect(hasFullyAnnotatedScalarAbi(voidCell)).toBe(true);
    const overridden = parseDecl(CELLS.find((c) => c.key === "string-return")!);
    expect(hasFullyAnnotatedScalarAbi(overridden, { returnCarrierIsOverridden: () => true })).toBe(false);
  });

  for (const target of ["standalone", "wasi"] as const) {
    describe(`${target}: certification ⇒ claim + validation + value parity vs pure legacy`, () => {
      for (const cell of CELLS) {
        it(cell.key, async () => {
          const source = moduleSource(cell);
          const ir = await compileLane(source, target, false);
          const legacy = await compileLane(source, target, true);
          expect(legacy.claimed, "legacy lane must not claim anything").toBe(false);
          expect(ir.claimed, `claim outcome for ${cell.key}: ${cell.why}`).toBe(cell.expectClaimed);
          // A certified-and-claimed callee under an unclaimed legacy caller is
          // exactly the overlay-into-legacy-call shape the closure guards; a
          // divergent carrier could not validate.
          expect(WebAssembly.validate(ir.binary as BufferSource)).toBe(true);
          expect(WebAssembly.validate(legacy.binary as BufferSource)).toBe(true);
          const run = async (binary: Uint8Array): Promise<unknown> => {
            const { instance } = await WebAssembly.instantiate(binary as BufferSource, WASI_STUB);
            return (instance.exports as { probe: () => unknown }).probe();
          };
          const irValue = await run(ir.binary);
          const legacyValue = await run(legacy.binary);
          expect(typeof irValue).toBe("number");
          expect(irValue, `${cell.key}: IR-overlay value must equal pure-legacy value`).toBe(legacyValue);
        });
      }
    });
  }

  it("every IrType family is considered (add a row or an exclusion note for a new kind)", () => {
    const nodes = readFileSync(join(REPO, "src/ir/nodes.ts"), "utf-8");
    const union = /export type IrType =([\s\S]*?)\n\nexport /.exec(nodes);
    expect(union, "IrType union not found in src/ir/nodes.ts").toBeTruthy();
    const kinds = [...union![1]!.matchAll(/readonly kind: "([a-z0-9.-]+)"/g)].map((m) => m[1]!).sort();
    // Considered by this gate: val/string/vec through the certified rows;
    // object/closure/callable/class/extern/union/boxed/dynamic are outside the
    // certified surface by design (denied rows document object; the reference
    // families are r2StableSignatureType's separate admission question).
    expect(kinds).toEqual(
      ["boxed", "callable", "class", "closure", "dynamic", "extern", "object", "string", "union", "val", "vec"],
      "IrType gained/lost a family — extend the #4520 row table (or its exclusion notes) before updating this list",
    );
  });

  it("the certified keyword surface of the predicate matches the row table", () => {
    const src = readFileSync(join(REPO, "src/codegen/ir-legacy-caller-abi.ts"), "utf-8");
    const keywords = [...new Set([...src.matchAll(/SyntaxKind\.(\w+)/g)].map((m) => m[1]!))].sort();
    expect(keywords).toEqual(
      ["AsyncKeyword", "BooleanKeyword", "NumberKeyword", "StringKeyword", "VoidKeyword"],
      "the certified surface changed — add matching rows (granted AND denied neighbors) before updating this list",
    );
  });
});
