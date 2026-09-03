// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5290 — an omittable parameter must reach the callee as `undefined`.
//
// `parameterMayBeOmitted` widens `size?: number` / `@param {number=} size` /
// `@param {number} [size]` to externref on the callee side, precisely so a
// caller that omits the argument delivers `undefined` and not a padded `0`.
// Two derivations of the same signature did not honour it:
//
//   1. the DECLARED-signature wrapper the identifier call path builds, so a
//      function reached through it (a default export) padded `0` again;
//   2. the closure boundary's own JSDoc check, which tested the bracketed
//      `[size]` tag only when the parameter had no type node — i.e. never,
//      since `@param {number} [size]` has one.
//
// (2) is not merely a wrong answer: the `typeof` lowering takes an externref,
// so a bracketed parameter guarded by `typeof` emitted an INVALID module.
//
// Witness for both: webpack's `formatSize`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** `typeof` guard first, then a numeric use — webpack's `formatSize` shape. */
const BODY = `{ if (typeof size !== "number") return "unknown"; if (size <= 0) return "zero"; return "n"; }`;

async function runProject(files: Record<string, string>): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-omittable-param-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // The bracketed-JSDoc defect shows up HERE, not at compile time.
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

const CALL_DEFAULT = `import f from "./mod.js";\nexport function test(): any { return (f as any)(); }`;
const CALL_NAMED = `import { f } from "./mod.js";\nexport function test(): any { return (f as any)(); }`;

describe("#5290 omittable parameter ABI", () => {
  it("delivers undefined through an ESM default export", async () => {
    expect(
      await runProject({
        "mod.js": `/** @param {number=} size */\nconst f = (size) => ${BODY};\nexport default f;\n`,
        "entry.ts": CALL_DEFAULT,
      }),
    ).toBe("unknown");
  });

  it("delivers undefined through a CommonJS `module.exports`", async () => {
    expect(
      await runProject({
        "mod.js": `/** @param {number=} size */\nconst f = (size) => ${BODY};\nmodule.exports = f;\n`,
        "entry.ts": CALL_DEFAULT,
      }),
    ).toBe("unknown");
  });

  it("honours the bracketed `@param {number} [size]` spelling", async () => {
    expect(
      await runProject({
        "mod.js": `/** @param {number} [size] */\nexport const f = (size) => ${BODY};\n`,
        "entry.ts": CALL_NAMED,
      }),
    ).toBe("unknown");
  });

  it("keeps the `{number=}` spelling working", async () => {
    expect(
      await runProject({
        "mod.js": `/** @param {number=} size */\nexport const f = (size) => ${BODY};\n`,
        "entry.ts": CALL_NAMED,
      }),
    ).toBe("unknown");
  });

  it("still passes a supplied argument through unchanged", async () => {
    expect(
      await runProject({
        "mod.js": `/** @param {number=} size */\nconst f = (size) => ${BODY};\nexport default f;\n`,
        "entry.ts": `import f from "./mod.js";\nexport function test(): any { return [f(5), f(0), f(-1)]; }`,
      }),
    ).toEqual(["n", "zero", "zero"]);
  });

  // webpack's own `formatSize`, when its pinned dogfood package is present.
  // The cache is a local artifact, not a repo fixture, so the case reports the
  // package it needs rather than failing a CI checkout that never had it — the
  // five cases above already pin the compiler behaviour on their own.
  it("matches webpack's formatSize across its whole unit table", async () => {
    const dist = join(process.cwd(), "tests/dogfood/.npm-compat/webpack/package/lib/util/formatSize.js");
    if (!existsSync(dist)) {
      expect(existsSync(dist), "skipped: run `pnpm run dogfood:webpack` to populate the pinned package").toBe(false);
      return;
    }
    expect(
      await runProject({
        "entry.ts": `import formatSize from ${JSON.stringify(dist)};
export function test(): any {
  return [(formatSize as any)(), formatSize(Number.NaN), formatSize(0), formatSize(-1), formatSize(1000), formatSize(2048), formatSize(2560)];
}`,
      }),
    ).toEqual(["unknown size", "unknown size", "0 bytes", "0 bytes", "1000 bytes", "2 KiB", "2.5 KiB"]);
  });
});
