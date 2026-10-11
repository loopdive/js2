// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6642 (#5383 S60) — a BigInt reached through DYNAMIC DISPATCH loses its
// bigint-ness on BOTH sides of the generic externref ABI.
//
// This is the residual S59 left open (its `## Root Cause` §4). S59 attributed
// it to `coercionPlan` (coercion-plan.ts) lacking a bigint-brand column; a
// trace of the actual emitter (S60) shows `coercionPlan` is NEVER reached for
// this shape. The real mechanism is two brand DROPS, one per direction:
//
// BOX side — `buildClosureResultBoxing` (codegen/closures/result-boxing.ts).
// A method/property declared `bigint` compiles to a native monomorphic
// `() -> i64` closure body. When it is reached through dynamic dispatch the
// `__call_fn_*` ABI has to hand back an externref, and that arm boxed EVERY
// i64 as a NUMBER: `f64.convert_i64_s; __box_number`. Two losses in one line —
// `f64.convert_i64_s` rounds anything above 2^53 (217175010123456789n →
// …792), and `__box_number` erases bigint-ness outright. The i32 arm right
// next to it already preserved the `boolean` and `symbol` brands the same way
// this now preserves `bigint`; the i64 arm simply had no brand column.
//
// UNBOX side — `compileBinaryExpression`'s BigInt arm (codegen/binary-ops.ts).
// Both-operands-BigInt compiled each side with a BARE `{ kind: "i64" }` hint.
// `coerceType`'s `externref → i64` row already picks §7.1.13 `__to_bigint`
// over `__unbox_number; i64.trunc_sat_f64_s` — but ONLY when the target
// carries `bigint: true`. With the bare hint it took the plain-NUMBER path, so
// the comparison ran against `0`.
//
// Invisible whenever the operand is natively i64 (a literal, an i64 local),
// which is why the whole BigInt suite stayed green: it only bites when the
// value arrives BOXED. Silent too — no trap, no diagnostic, just a wrong
// number, which is how twelve `Temporal/ZonedDateTime/prototype/{add,
// epochNanoseconds}` rows failed with `«…,…»` SameValue mismatches.
//
// TEETH (revert-and-measure on 8a95c4dace, S59's head):
//   - method-call case  → `f() === 0` (expected 1)
//   - property-read case→ `f() === 0` (expected 1)
//   - linked Object.is  → `0` (expected 1)
// All three pass with the two fixes. Recorded in the issue file.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/** Compile one standalone module and call its exported `f`. */
async function runStandalone(src: string): Promise<unknown> {
  const result = await compile(src, STANDALONE as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(result.binary!);
  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as unknown as Record<string, () => unknown>).f!();
}

describe("#6642 a BigInt survives dynamic dispatch in a standalone module", () => {
  it(
    "a bigint returned by a dynamically dispatched METHOD compares === against a matching literal",
    { timeout: 600_000 },
    async () => {
      // 217175010123456789n is deliberately > 2^53: the old
      // `f64.convert_i64_s` box rounded it to …792, so even a bigint-aware
      // unbox alone could not have recovered it.
      expect(
        await runStandalone(`
          const NS = Object.freeze({
            __proto__: null,
            giveBigInt() { return 217175010_123_456_789n; },
          });
          export function f(): number {
            return NS.giveBigInt() === 217175010123456789n ? 1 : 0;
          }
        `),
      ).toBe(1);
    },
  );

  it(
    "a bigint read from a dynamically dispatched PROPERTY compares === against a matching literal",
    { timeout: 600_000 },
    async () => {
      expect(
        await runStandalone(`
          const NS = Object.freeze({
            __proto__: null,
            bigVal: 217175010_123_456_789n,
          });
          export function f(): number {
            return NS.bigVal === 217175010123456789n ? 1 : 0;
          }
        `),
      ).toBe(1);
    },
  );

  it(
    "a NON-matching literal still compares false (the fix is not a blanket `true`)",
    { timeout: 600_000 },
    async () => {
      expect(
        await runStandalone(`
          const NS = Object.freeze({
            __proto__: null,
            giveBigInt() { return 217175010_123_456_789n; },
          });
          export function f(): number {
            return NS.giveBigInt() === 217175010123456788n ? 1 : 0;
          }
        `),
      ).toBe(0);
    },
  );

  it(
    "a native (UNBRANDED) i64 method result keeps the legacy number box — no behaviour change",
    { timeout: 600_000 },
    async () => {
      // `type i64 = number` is the native-annotation carrier: an i64 with NO
      // bigint brand. It must keep boxing as a NUMBER, which is what makes the
      // brand column a column and not a blanket switch.
      expect(
        await runStandalone(`
          type i64 = number;
          const NS = Object.freeze({
            __proto__: null,
            giveNative(): i64 { return 42; },
          });
          export function f(): number {
            return NS.giveNative() === 42 ? 1 : 0;
          }
        `),
      ).toBe(1);
    },
  );
});

describe("#6642 a BigInt survives a standalone link boundary", () => {
  it("Object.is(<linked-provider bigint>, <matching literal>) answers true", { timeout: 900_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-6642-s60-"));
    const packageRoot = join(root, "node_modules", "ns6642");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns6642", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(
      join(packageRoot, "index.js"),
      `
        export const NS = Object.freeze({
          __proto__: null,
          giveBigInt() { return 217175010_123_456_789n; },
        });`,
    );
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
        [consumerEntry]:
          `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n` +
          `export function f(): number { return Object.is(NS.giveBigInt(), 217175010123456789n) ? 1 : 0; }\n`,
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
    expect((instance.exports as unknown as Record<string, () => unknown>).f!()).toBe(1);
  });
});
