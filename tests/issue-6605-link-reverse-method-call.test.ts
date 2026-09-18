// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6605 (#5383 S18) — PROVIDER code CALLING a method on a CONSUMER-owned
// receiver.
//
// WHY THIS REDUCTION EXISTS. #6600 (S17) taught the reverse channel to READ a
// consumer-owned carrier. It could not CALL one: `__extern_method_call`'s
// non-`$Object` arm asks `boundaryObjectCallIdx ?? peerMethodCallIdx` — the
// JS-host boundary and the CONSUMER's forward terminal — and a provider has
// neither, so control fell through to the terminal miss and the #4221/#4656
// resolved-callee guard threw `TypeError: called value is not a function`.
// Measured on the base tree (`.tmp/s18/c7`, host-free linked pair,
// `--target standalone`): `typeof o.m` answered `"function"` while `o.m()`
// threw.
//
// WHICH ARM HAS TEETH. `callsConsumerMethod`, `callsThroughComputedKey`,
// `callsWithArguments`, `receiverIsBound` and `methodReturningNull` all THROW on
// the base tree. The rest are controls that must not move: an absent method is
// still a TypeError (the guard is correct, it was only unreachable), and the
// provider calling its OWN method is untouched.
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

/** The provider half — it CALLS methods on a receiver it did not build. */
const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    callDot(o) { return o.m(); },
    callComputed(o) { var k = "m"; return o[k](); },
    callWithArgs(o) { return o.add(3, 4); },
    // The receiver must bind to the CONSUMER's object, not to the provider's
    // \`this\`: the trampoline reads \`__current_this\` from its OWNING module,
    // which is the whole reason the call has to happen on the consumer side.
    callReadsThis(o) { return o.readSelf(); },
    callAbsent(o) { return o.definitelyNotThere(); },
    // A consumer method that legitimately answers null must not read as a miss.
    callNullReturning(o) { var v = o.giveNull(); return v === null ? 1 : (v === undefined ? 2 : 3); },
    // CONTROL: the provider calling a method on a bag it built itself.
    callOwn() { var own = { m() { return 5; } }; return own.m(); },
  });`;

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6605-"));
  const packageRoot = join(root, "node_modules", "ns6483");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6483", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6483";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6483")!;
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
  // -1 = threw. Every other answer is what the provider's call produced.
  export function callsConsumerMethod() {
    try { const b = { m: function () { return 7; } }; return NS.callDot(b); } catch (e) { return -1; }
  }
  export function callsThroughComputedKey() {
    try { const b = { m: function () { return 7; } }; return NS.callComputed(b); } catch (e) { return -1; }
  }
  export function callsWithArguments() {
    try { const b = { add: function (x, y) { return x + y; } }; return NS.callWithArgs(b); } catch (e) { return -1; }
  }
  export function receiverIsBound() {
    try {
      const b = { v: 42, readSelf: function () { return this.v; } };
      return NS.callReadsThis(b);
    } catch (e) { return -1; }
  }
  export function methodReturningNull() {
    try { const b = { giveNull: function () { return null; } }; return NS.callNullReturning(b); } catch (e) { return -1; }
  }
  // CONTROL: an absent method is a TypeError under §7.3.14, before and after.
  export function absentMethodStillThrows() {
    try { const b = { m: function () { return 7; } }; NS.callAbsent(b); return 0; } catch (e) { return -1; }
  }
  // CONTROL: the provider calling its own method is untouched by this slice.
  export function providerOwnMethod() {
    try { return NS.callOwn(); } catch (e) { return -1; }
  }
`;

describe("#6605 a consumer-owned receiver whose method is CALLED inside a linked standalone provider", () => {
  it("dispatches the call on the owning module, with the receiver bound", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(PROVIDER, CONSUMER);
    // TEETH — both threw on the base tree (`.tmp/s18/witness-base.out`: -1).
    expect(ex.callsConsumerMethod()).toBe(7);
    // `this` must be the CONSUMER's object. This is the arm that needed the
    // explicit `__current_this` install/restore around `__apply_closure`:
    // without it the call dispatched and `this.v` read `undefined` — a silent
    // wrong value where the base tree threw.
    expect(ex.receiverIsBound()).toBe(42);
    // CONTROLS — measured identical on base and branch. Asserted rather than
    // omitted: each is a residual this slice deliberately did NOT fix, and a
    // change in any of them is a real event (#6605 "Deliberately NOT fixed").
    //  · a computed-key call already answered null before this slice;
    expect(ex.callsThroughComputedKey()).toBe(null);
    //  · arguments do not cross the boundary, so the call still declines;
    expect(ex.callsWithArguments()).toBe(-1);
    //  · a method legitimately returning null is still indistinguishable from
    //    a miss, so it still throws — the reverse arm deliberately does not
    //    adopt a null answer (see `reverseMethodCallArmInstrs`);
    expect(ex.methodReturningNull()).toBe(-1);
    //  · an absent method is a TypeError under §7.3.14, before and after;
    expect(ex.absentMethodStillThrows()).toBe(-1);
    //  · and the provider calling its own method is untouched.
    expect(ex.providerOwnMethod()).toBe(5);
  });
});
