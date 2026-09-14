// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6488 (#5383 S23) — `x.toPrecision(p)` on a number PRIMITIVE reached through
// an `any` receiver threw `TypeError: called value is not a function` under
// `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. `__extern_method_call` dispatches
// `ref.test $Object` → resolve-and-apply, ELSE the vec / closure-prop arms, ELSE
// `buildProtoNamedMethodMissArm`'s terminal miss. A bare number primitive
// (`$box_number` / i31) is none of those three, so it reached the terminal,
// whose consult is the #4160/#4176 proto-index store — the table of members a
// MODULE installed on a builtin prototype. `Number.prototype`'s BUILTIN members
// are not in it, the consult answered null, and #4221's absent-callee guard
// turned that into the TypeError. The ANSWER machinery was never missing: the
// identical call on a statically-typed receiver answered `"1.23e+3"` on the same
// base tree (`staticReceiverUnchanged` below, `1` on both).
//
// WHICH ASSERTIONS HAVE TEETH. Every `dynamic*` / `*Receiver` probe answered
// `-1` (threw) on the base, measured by file-copy revert of the three changed
// files (`.tmp/s23base/`, probe `.tmp/s23/c8.mjs`, both labels on this tree; the
// diff is exactly the eight rows asserted as teeth).
// `dynamicPrecisionOutOfRange` is the sharper one: the base threw a TypeError
// there too, so a test that only asserted "throws" would have passed on the
// base — it asserts the THROWN KIND is RangeError (§21.1.3.5 step 5), which was
// `2` on base and is `1` here.
//
// CONTROLS that must not move — all measured identical on base and branch:
// a statically-typed receiver, a string receiver, a boolean receiver, an absent
// member, and — the one a PREPENDED arm can genuinely get wrong — a member the
// MODULE installed on `Number.prototype`, which §10.5 says outranks the builtin.
// That probe lives in its own module because a `Number.prototype` write changes
// the whole module's dispatch, and the first cut of this arm regressed it from
// `"user2"` to the builtin's `"5.0"` before the proto-store consult was added.
//
// `absentMemberStillThrows` asserts `0`, i.e. `(5).nosuch()` does NOT throw.
// That is the pre-existing standalone gap, identical on both trees, and it is
// asserted rather than skipped so this arm cannot silently start claiming an
// absent member.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object. Every probe answers
// a NUMBER — a standalone module's string is a WasmGC array the host cannot
// decode, so every comparison happens INSIDE the module.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function singleModule(source: string): Promise<Record<string, () => unknown>> {
  const entry = "/__main.js";
  const result = await compileMulti({ [entry]: source }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (i: unknown) => void }).__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

const SINGLE = `
  function ask(x, p) { return x.toPrecision(p); }
  function ask0(x) { return x.toPrecision(); }

  // 1 = the §21.1.3.5 answer, 0 = any other value, -1 = threw.
  export function dynamicToPrecision() {
    try { return ask(1234.5678, 3) === "1.23e+3" ? 1 : 0; } catch (e) { return -1; }
  }
  export function dynamicNoArgument() {
    try { return ask0(1234.5678) === "1234.5678" ? 1 : 0; } catch (e) { return -1; }
  }
  export function dynamicNonFinite() {
    try { return ask(NaN, 3) === "NaN" ? 1 : 0; } catch (e) { return -1; }
  }
  export function dynamicNegative() {
    try { return ask(-1234.5678, 5) === "-1234.6" ? 1 : 0; } catch (e) { return -1; }
  }
  export function dynamicSmallExponent() {
    try { return ask(0.0000001234, 3) === "1.23e-7" ? 1 : 0; } catch (e) { return -1; }
  }
  export function smallIntReceiver() {
    try { return ask(7, 2) === "7.0" ? 1 : 0; } catch (e) { return -1; }
  }
  export function wrapperReceiver() {
    try { return ask(new Number(1234.5678), 3) === "1.23e+3" ? 1 : 0; } catch (e) { return -1; }
  }
  // §21.1.3.5 step 5 — the KIND matters: base threw a TypeError (2) here, so
  // "it throws" alone would have passed on the base.
  export function dynamicPrecisionOutOfRange() {
    try { ask(1, 0); return 0; } catch (e) { return e instanceof RangeError ? 1 : (e instanceof TypeError ? 2 : 3); }
  }

  // CONTROLS — measured identical on base and branch.
  export function staticReceiverUnchanged() {
    try { return (1234.5678).toPrecision(3) === "1.23e+3" ? 1 : 0; } catch (e) { return -1; }
  }
  export function absentMemberStillThrows() {
    try { (5).nosuch(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
  }
  export function stringReceiverUnchanged() {
    try { ask("abc", 3); return 0; } catch (e) { return 1; }
  }
  export function booleanReceiverUnchanged() {
    try { ask(true, 3); return 0; } catch (e) { return 1; }
  }
`;

const OVERRIDE = `
  function ask(x, p) { return x.toPrecision(p); }
  export function userOverrideWins() {
    Number.prototype.toPrecision = function (p) { return "user" + p; };
    try { return ask(5, 2) === "user2" ? 1 : 0; } catch (e) { return -1; }
  }
`;

const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    // The polyfill's exact-arithmetic shape: a number PRIMITIVE receiver reached
    // through an \`any\` parameter, INSIDE the provider — which is where the nine
    // Temporal rows' failing call actually happens.
    precise(n, p) { try { return n.toPrecision(p) === "1.23e+3" ? 1 : 0; } catch (e) { return -1; } },
    tag: 7,
  });`;

async function linkedPair(consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6488-"));
  const packageRoot = join(root, "node_modules", "ns6488");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6488", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6488";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6488")!;
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
  return instance.exports as unknown as Record<string, () => unknown>;
}

const CONSUMER = `
  export function providerPrecision() {
    try { return NS.precise(1234.5678, 3); } catch (e) { return -1; }
  }
  // CONTROL: a non-callable provider member keeps its existing answer.
  export function providerTag() {
    try { return NS.tag === 7 ? 1 : 0; } catch (e) { return -1; }
  }
`;

describe("#6488 number-primitive dynamic method call (standalone)", () => {
  it("answers §21.1.3.5 for an `any` number receiver, and keeps every other receiver", async () => {
    const ex = await singleModule(SINGLE);
    // TEETH — every one of these answered -1 (threw `called value is not a
    // function`) on the base tree.
    expect(ex.dynamicToPrecision()).toBe(1);
    expect(ex.dynamicNoArgument()).toBe(1);
    expect(ex.dynamicNonFinite()).toBe(1);
    expect(ex.dynamicNegative()).toBe(1);
    expect(ex.dynamicSmallExponent()).toBe(1);
    expect(ex.smallIntReceiver()).toBe(1);
    expect(ex.wrapperReceiver()).toBe(1);
    // TEETH, sharper: base threw a TypeError (2); §21.1.3.5 step 5 says RangeError.
    expect(ex.dynamicPrecisionOutOfRange()).toBe(1);
    // CONTROLS — identical on base and branch.
    expect(ex.staticReceiverUnchanged()).toBe(1);
    expect(ex.stringReceiverUnchanged()).toBe(1);
    expect(ex.booleanReceiverUnchanged()).toBe(1);
    // The pre-existing gap, pinned so this arm cannot start claiming an absent
    // member: `(5).nosuch()` does not throw, on base and on branch alike.
    expect(ex.absentMemberStillThrows()).toBe(0);
  });

  it("lets a module-installed `Number.prototype` member outrank the builtin", async () => {
    const ex = await singleModule(OVERRIDE);
    // Correct on BASE and on branch; the first cut of the arm broke it.
    expect(ex.userOverrideWins()).toBe(1);
  });

  it("answers for a number primitive inside a separately linked provider", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(CONSUMER);
    // TEETH — -1 on the base tree; this is the nine-row Temporal bucket's shape.
    expect(ex.providerPrecision()).toBe(1);
    // CONTROL — identical on base and branch.
    expect(ex.providerTag()).toBe(1);
  });
});
