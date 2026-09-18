// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6642 (#5383 S59) — BigInt values crossing a standalone link boundary.
//
// THE DEFECT THIS EXISTS FOR. Twelve `test/built-ins/Temporal/ZonedDateTime`
// rows fail because a BigInt minted by the linked standalone Temporal
// PROVIDER (`zdt.add(...)`'s return, `zdt.epochNanoseconds`) does not survive
// the link to the CONSUMER: `SameValue`/`===`/`typeof` all answer as if the
// value were not a BigInt at all.
//
// Two of the (at least four) real, independent bugs this reduction found are
// fixed here. Neither alone moves the 12 target rows — a third, deeper
// residual (documented below and in the issue file) still blocks them — but
// both are genuine correctness fixes with their own witnesses, and the first
// is load-bearing for anything that reaches it (it crashes the module).
//
// FIX 1 — a stale `funcIdx` captured before a link-boundary shift
// (`typeof-delete.ts`). `typeof x === "bigint"` (and the bare `typeof x`
// cascade) captured the `__typeof_bigint`/`__typeof` helper's `funcIdx` from
// `ctx.funcMap` BEFORE compiling `x`. Compiling a cross-module link-boundary
// read can itself lazily register new imports, which shifts every
// already-registered defined-function index — but the captured local
// `funcIdx` sits in a bare TypeScript variable, not yet inside any emitted
// `Instr`, so the shifter (`shiftLateImportIndices`) cannot find and repair
// it. The stale value then baked a `call` into whatever function had since
// slid into that slot (`__box_bigint` in the reduction below) — a WasmGC
// VALIDATION ERROR (`WebAssembly.Module(): ... call[0] expected type i32,
// found block of type externref`), not just a wrong answer. Fixed by
// re-reading the funcIdx immediately before emitting the `call`, after the
// operand has been compiled.
//
// FIX 2 — an over-eager static fold for BigInt-vs-`any` strict equality
// (`binary-ops.ts`). `leftIsBigInt !== rightIsBigInt` (one side statically
// bigint, the other statically NOT) folded `===`/`!==` to a compile-time
// constant — correct when the non-bigint side is PROVABLY some other type
// (`5n === "5"` is always false), but WRONG when that side is typed
// `any`/`unknown`, which is exactly how a value read through a standalone
// link boundary is typed (the consumer's checker sees the provider only
// through an `any`-returning stub). `zdt.epochNanoseconds === 1n` (both
// operands genuinely bigint at runtime) compiled both sides for side effects,
// dropped both, and answered a hardcoded `false`. Fixed by routing an
// any/unknown non-bigint side through the native standalone `__extern_strict_eq`
// helper instead, which classifies both operands DYNAMICALLY (its existing
// `bigintArm` already does `ref.test`+`i64.eq` — it just never used to be
// reached for this shape).
//
// KNOWN RESIDUAL (tracked in plan/issues/6642-*.md, not asserted here as
// passing): a BigInt value returned through a DYNAMICALLY DISPATCHED closure
// call or property read (`NS.giveBigInt()`, `NS.bigVal` — the shape the 12
// target Temporal rows actually use) still compares wrong, with NO link
// involved at all (`const NS = Object.freeze({giveBigInt(){return 1n;}})`
// in a SINGLE standalone module reduces it). Root cause identified:
// `coercionPlan` (coercion-plan.ts) — the table `stack-balance.ts`'s post-hoc
// `fixBranchType` pass uses to reconcile a block's inferred externref result
// against its i64-bigint-branded expected type — has no bigint-brand column;
// it takes the plain-number `__unbox_number; i64.trunc_sat_f64_s` row instead
// of `__to_bigint`. Fixing it requires threading a THIRD helper funcIdx
// through `stack-balance.ts`'s ~16-function `boxNumberIdx`/`unboxNumberIdx`
// parameter chain, out of scope for this slice.
//
// A candidate THIRD/FOURTH fix — eagerly registering the `$BigInt` WasmGC
// struct in the frozen canonical runtime rec-group (`RUNTIME_RECGROUP_TYPE_NAMES`,
// #2527) so it canonicalizes identically across separately-compiled modules —
// was built and measured, then DROPPED: the second test below shows the
// engine ALREADY canonicalizes two independently-declared, structurally
// identical `$BigInt` structs without that change (isorecursive type
// equivalence for a size-1 rec group needs no shared registry, unlike the
// bigger String/Vec family this repo's canonical-recgroup module documents).
// Keeping an unproven, higher-risk architecture change out of the diff.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function linkedPair(
  provider: string,
  consumer: string,
): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6642-"));
  const packageRoot = join(root, "node_modules", "ns6642");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6642", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6642";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6642")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, (...args: unknown[]) => unknown>;
}

const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    giveBigInt() { return 217175010_123_456_789n; },
  });`;

describe("#6642 typeof across a linked standalone provider no longer crashes the module", () => {
  it(
    'compiles and runs `typeof <linked-provider-call>() === "bigint"` without a WasmGC validation error',
    { timeout: 600_000 },
    async () => {
      const CONSUMER = `
        export function f(): number {
          return typeof NS.giveBigInt() === "bigint" ? 1 : 0;
        }
      `;
      // TEETH — on the base tree this THREW at instantiation:
      // "WebAssembly.Module(): Compiling function ...:'f' failed: call[0]
      // expected type i32, found block of type externref" (a stale funcIdx
      // captured before the link-boundary call shifted the index space).
      const ex = await linkedPair(PROVIDER, CONSUMER);
      expect(() => ex.f()).not.toThrow();
      // The residual documented above means this still answers 0 rather than
      // the semantically-correct 1 — not asserted as a pass/fail contract
      // here, only that the module is valid and runs.
      expect(typeof ex.f()).toBe("number");
    },
  );
});

describe("#6642 BigInt-vs-`any` strict equality is no longer statically folded to false", () => {
  it("dynamically classifies an `any`-typed operand instead of assuming it can never be a BigInt", async () => {
    // No link boundary needed to isolate this one — an `any`-typed PARAMETER
    // reproduces the same static-type gap a link-boundary stub creates
    // (`NS.giveBigInt(): any` in the real defect), without also touching the
    // separate `stack-balance.ts` residual documented above (a parameter read
    // needs no post-hoc block-type fixup, unlike a dynamically-dispatched
    // call/property result).
    const srcA = `export function make(): any { let v: bigint = 217175010_123_456_789n; return v; }`;
    const resA = await compile(srcA, { ...STANDALONE, canonicalRuntimeTypes: true } as never);
    expect(resA.success, resA.success ? "" : resA.errors.map((e) => e.message).join("\n")).toBe(true);

    const srcB = `
      export function eqTrue(v: any): number { return v === 217175010123456789n ? 1 : 0; }
      export function eqFalseWrongValue(v: any): number { return v === 1n ? 1 : 0; }
      export function eqFalseNonBigInt(v: any): number { return v === 5 ? 1 : 0; }
    `;
    const resB = await compile(srcB, { ...STANDALONE, canonicalRuntimeTypes: true } as never);
    expect(resB.success, resB.success ? "" : resB.errors.map((e) => e.message).join("\n")).toBe(true);

    const modA = new WebAssembly.Module(resA.binary);
    const modB = new WebAssembly.Module(resB.binary);
    const instA = (await WebAssembly.instantiate(modA, {})) as unknown as { exports: { make: () => unknown } };
    const instB = (await WebAssembly.instantiate(modB, {})) as unknown as {
      exports: {
        eqTrue: (v: unknown) => number;
        eqFalseWrongValue: (v: unknown) => number;
        eqFalseNonBigInt: (v: unknown) => number;
      };
    };
    const v = instA.exports.make();
    // TEETH — on the base tree this answered 0: `leftIsBigInt !== rightIsBigInt`
    // (v is statically `any`, the literal is statically bigint) folded the
    // comparison to a hardcoded `false` without ever looking at the runtime
    // value.
    expect(instB.exports.eqTrue(v)).toBe(1);
    // Controls that must NOT flip: a genuinely different BigInt value, and a
    // genuinely non-BigInt comparand, both still correctly compare unequal.
    expect(instB.exports.eqFalseWrongValue(v)).toBe(0);
    expect(instB.exports.eqFalseNonBigInt(v)).toBe(0);
  });
});

describe("#6642 (measured, not a fix) a BigInt struct already canonicalizes across independently-compiled modules", () => {
  it('a value minted in module A is recognized as `typeof === "bigint"` by an UNRELATED module B', async () => {
    // This passes on the BASE tree too (verified) — WasmGC isorecursive type
    // equivalence for a size-1 rec group (js2wasm's private, per-module
    // `$BigInt` struct: one immutable i64 field, no self-reference) needs no
    // shared ABI registry the way the bigger String/Vec canonical rec-group
    // does. Kept as a regression guard for that property, not as a witness of
    // a change in this PR.
    const srcA = `export function make(): any { let v: bigint = 42n; return v; }`;
    const resA = await compile(srcA, {
      ...STANDALONE,
      canonicalRuntimeTypes: true,
      exportsConsumedByWasm: true,
    } as never);
    expect(resA.success, resA.success ? "" : resA.errors.map((e) => e.message).join("\n")).toBe(true);

    const srcB = `export function check(v: any): number { return typeof v === "bigint" ? 1 : 0; }`;
    const resB = await compile(srcB, { ...STANDALONE, canonicalRuntimeTypes: true } as never);
    expect(resB.success, resB.success ? "" : resB.errors.map((e) => e.message).join("\n")).toBe(true);

    const modA = new WebAssembly.Module(resA.binary);
    const modB = new WebAssembly.Module(resB.binary);
    const instA = (await WebAssembly.instantiate(modA, {})) as unknown as { exports: { make: () => unknown } };
    const instB = (await WebAssembly.instantiate(modB, {})) as unknown as {
      exports: { check: (v: unknown) => number };
    };
    const v = instA.exports.make();
    expect(instB.exports.check(v)).toBe(1);
  });
});
