// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6682 — `new Set(iterable)` / `new Map(iterable)` leaked a detached body into
// `ctx.liveBodies` and tripped the #2182 invariant.
//
// WHY THIS REDUCTION EXISTS. `emitCollectionAdderGuard` (the §24.2.1.1 step 5
// `Get(set, "add")` / IsCallable guard) swaps `fctx.body` to a `throwArm`,
// registered it with `ctx.liveBodies.add(throwArm)` and never deleted it. The
// function body therefore exits with one more live body than it entered with,
// and `compileFunctionBody` throws
// `codegen invariant (#2182): liveBodies unbalanced … (entry=0, exit=1)`.
// The guard is emitted only when the module writes a NAMED property onto a
// builtin prototype (`ctx.protoNamedDirty`), which is why a one-file copy of
// axios's `redactConfig` with local stubs compiled fine: the write lives in
// axios's `utils.js`. Measured on the base tree (2026-09-26): the axios
// standalone-dynamic npm-compat lane stopped at
// `Internal error compiling function 'redactConfig': codegen invariant (#2182)`.
//
// The guard also left the real body and the detached `thenArm` off the
// late-import shifter's walk while the TypeError was emitted; the fix rides the
// real body on `savedBodies` and both arms on `liveBodies`, then releases them.
//
// WHICH ARM HAS TEETH. The `standalone` cases FAIL on the base tree (the whole
// module fails to compile). The js-host (`gc`) cases are the control: that lane
// never registers `__protoidx_has_r`, so the guard is a no-op and the lane
// compiled on both trees.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "standalone" | "gc";

async function run(target: Target, source: string): Promise<Record<string, () => number>> {
  const result = (await compile(source, {
    target,
    ...(target === "standalone" ? { hostBridge: "off" } : {}),
    fileName: "/p.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
  } as never)) as unknown as {
    success: boolean;
    errors?: { message: string }[];
    binary?: Uint8Array;
    importObject?: WebAssembly.Imports & { __setInstance?: (i: unknown) => void };
  };
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  const imports = target === "standalone" ? {} : (result.importObject ?? {});
  const { instance } = await WebAssembly.instantiate(result.binary as Uint8Array, imports);
  (imports as { __setInstance?: (i: unknown) => void }).__setInstance?.(instance);
  return instance.exports as unknown as Record<string, () => number>;
}

/** The named builtin-prototype write is what arms the adder guard. */
const DIRTY = `(Array.prototype as any).__extra = 1;`;

const REDACT_SHAPE = `
${DIRTY}
function redact(config: any, redactKeys: string[]): number {
  const lowerKeys = new Set(redactKeys.map((k) => String(k).toLowerCase()));
  const seen: any[] = [];
  const visit = (source: any): any => {
    if (source === null || typeof source !== "object") return source;
    if (seen.indexOf(source) !== -1) return undefined;
    seen.push(source);
    const result: any = {};
    for (const [key, value] of Object.entries(source)) {
      result[key] = lowerKeys.has(key.toLowerCase()) ? "[REDACTED]" : visit(value);
    }
    seen.pop();
    return result;
  };
  const out = visit(config);
  return out.Auth === "[REDACTED]" && out.url === "u" ? 1 : 0;
}
export function redacted(): number { return redact({ url: "u", Auth: "secret" }, ["AUTH"]); }
export function setSize(): number { return new Set([1, 2, 2, 3]).size; }
export function mapSize(): number { return new Map([["a", 1], ["b", 2]]).size; }
export function weakSetBuilds(): number { const k = {}; return new WeakSet([k]).has(k) ? 1 : 0; }
`;

const NULL_ADDER = `
${DIRTY}
export function nullAdderThrows(): number {
  (Set.prototype as any).add = null;
  try {
    new Set([1]);
    return 0;
  } catch (e) {
    return e instanceof TypeError ? 1 : 2;
  }
}
`;

describe("#6682 collection adder guard keeps liveBodies balanced", () => {
  for (const target of ["standalone", "gc"] as const) {
    describe(target, () => {
      it("compiles the redactConfig shape and answers the redacted snapshot", async () => {
        const exports = await run(target, REDACT_SHAPE);
        expect(exports.redacted()).toBe(1);
      });

      it("keeps Set / Map / WeakSet iterable construction working", async () => {
        const exports = await run(target, REDACT_SHAPE);
        expect(exports.setSize()).toBe(3);
        expect(exports.mapSize()).toBe(2);
        expect(exports.weakSetBuilds()).toBe(1);
      });
    });
  }

  it("standalone: a null Set.prototype.add still throws TypeError from the guard", async () => {
    const exports = await run("standalone", NULL_ADDER);
    expect(exports.nullAdderThrows()).toBe(1);
  });
});
