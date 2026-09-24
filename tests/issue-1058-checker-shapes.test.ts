// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — shapes from the TypeScript checker that stopped `createTypeChecker`
// from compiling:
//   1. `interface NodeLinks` (types.ts) shares its name with checker.ts's
//      `function NodeLinks`, built by `new (NodeLinks as any)()`. A nested
//      function reserved with a `NodeLinks` struct parameter before that `new`
//      site compiled, then compiled against externref, and the compile failed
//      with "changed its full physical ABI after reservation".
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

type Built = { success: boolean; errors?: { message: string }[]; binary: Uint8Array };
type HostImports = WebAssembly.Imports & {
  setInstance?(instance: WebAssembly.Instance): void;
  __setInstance?(instance: WebAssembly.Instance): void;
};

async function instantiate(result: Built): Promise<Record<string, Function>> {
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const imports = (result as unknown as { importObject: HostImports }).importObject;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("#1058 TypeScript checker shapes", () => {
  it("keeps one representation for an interface named like a constructed function", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-1058-fnctor-name-"));
    writeFileSync(
      join(dir, "types.ts"),
      `export interface NodeLinks { flags: number; resolved?: number; label?: string; }
`,
    );
    writeFileSync(
      join(dir, "checker.ts"),
      `import { NodeLinks } from "./types.js";
function NodeLinks(this: NodeLinks) { this.flags = 0; }
export function createChecker(seed: number) {
  const nodeLinks: NodeLinks[] = [];
  const offsets: number[] = [seed];
  function record(links: NodeLinks, value: number): number {
    links.resolved = value + offsets[0];
    return links.resolved;
  }
  function getNodeLinks(id: number): NodeLinks {
    return nodeLinks[id] || (nodeLinks[id] = new (NodeLinks as any)());
  }
  function mark(id: number, value: number): number {
    const links = getNodeLinks(id);
    links.flags |= 1;
    return record(links, value) + links.flags;
  }
  return { mark, read: (id: number) => getNodeLinks(id).resolved ?? -1 };
}
`,
    );
    writeFileSync(
      join(dir, "entry.ts"),
      `import { createChecker } from "./checker.js";
export function run(): number {
  const checker = createChecker(100);
  const first = checker.mark(3, 20);
  return first * 1000 + checker.read(3);
}
`,
    );
    const ex = await instantiate((await compileProject(join(dir, "entry.ts"), { target: "gc" })) as unknown as Built);
    expect(ex.run!()).toBe(121120);
  });
});
