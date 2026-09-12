// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCanonicalIrDialect, DIALECT_NAMES } from "../scripts/lib/check-canonical-ir-dialect.mjs";

const repo = resolve(import.meta.dirname, "..");
const canonical = "ir/core/dialect/js.ts";
const legacy = "ir/dialect/js.ts";
const host = "ir/core/nodes.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-canonical-dialect-"));
  roots.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), text);
  };
  const declarations = DIALECT_NAMES.map(
    (name: string) => `export interface ${name} { readonly kind: '${name}'; }`,
  ).join("\n");
  const names = DIALECT_NAMES.join(", ");
  const forwarder = `export type { ${names} } from '../core/dialect/js.js';`;
  const assembly = `import type { ${names} } from './dialect/js.js';\nexport type { ${names} } from './dialect/js.js';`;
  put(canonical, declarations);
  put(legacy, forwarder);
  put(host, assembly);
  put("ir/nodes.ts", `export type { ${names} } from './core/nodes.js';`);
  return { root, put, declarations, forwarder, assembly, run: () => checkCanonicalIrDialect(root) };
}

function positive(f: ReturnType<typeof fixture>) {
  const report = f.run();
  expect(report.failures).toEqual([]);
  expect(report.declarations).toBe(27);
}

describe("#3518 complete nodes preserves a single dialect assembly boundary", () => {
  it("pins the nonempty 27-interface contract", () => {
    expect(DIALECT_NAMES).toHaveLength(27);
    expect(new Set(DIALECT_NAMES).size).toBe(27);
    positive(fixture());
  });

  it.each([canonical, legacy, host])("fails closed if required %s disappears", (file) => {
    const f = fixture();
    positive(f);
    rmSync(resolve(f.root, file));
    expect(f.run().failures.join("\n")).toContain("required canonical dialect boundary source is missing");
  });

  it.each([
    ["type import", "import type { IrInstrAwait } from '../ir/core/dialect/js.js';"],
    ["single-quoted multiline import", "import type {\nIrInstrAwait\n} from '../ir/core/dialect/js.js';"],
    ["inline type query", "type Hidden = import('../ir/core/dialect/js.js').IrInstrAwait;"],
    ["type re-export", "export type { IrInstrAwait } from '../ir/core/dialect/js.js';"],
    ["dynamic import", "const hidden = import('../ir/core/dialect/js.js');"],
    ["require", "const hidden = require('../ir/core/dialect/js.js');"],
    ["import equals", "import hidden = require('../ir/core/dialect/js.js');"],
    ["legacy facade import", "import type { IrInstrAwait } from '../ir/dialect/js.js';"],
  ])("rejects an outside %s", (_name, source) => {
    const f = fixture();
    positive(f);
    f.put("codegen/consumer.ts", source);
    expect(f.run().failures.join("\n")).toContain("imports the JS dialect outside");
  });

  it("does not allow the old union host to import the dialect directly", () => {
    const f = fixture();
    positive(f);
    f.put("ir/nodes.ts", "export type { IrInstrAwait } from './core/dialect/js.js';");
    expect(f.run().failures.join("\n")).toContain("imports the JS dialect outside");
  });

  it("does not exempt the canonical host from the type-only rule", () => {
    const f = fixture();
    positive(f);
    f.put(host, `${f.assembly}\nconst hidden = import('./dialect/js.js');`);
    expect(f.run().failures.join("\n")).toContain("imports the JS dialect outside");
  });

  it.each([
    (source: string) => source.replace("export type", "export"),
    (source: string) => `${source}\nexport const hidden = 1;`,
    (source: string) => `${source}\nexport interface Duplicate { readonly kind: 'duplicate'; }`,
    () => "export type * from '../core/dialect/js.js';",
    (source: string) => source.replace("IrInstrAwait,", ""),
    (source: string) => source.replace("IrInstrAwait,", "IrInstrAwait as Alias,"),
  ])("requires an exact legacy forwarder, not an implementation or partial facade", (change) => {
    const f = fixture();
    positive(f);
    f.put(legacy, change(f.forwarder));
    expect(f.run().failures.join("\n")).toContain("exact 27-name type-only compatibility forwarder");
  });

  it("rejects an omitted canonical re-export", () => {
    const f = fixture();
    positive(f);
    f.put(host, f.assembly.replaceAll("IrInstrAwait,", ""));
    expect(f.run().failures.join("\n")).toContain("does not explicitly type-re-export every canonical dialect");
  });

  it("rejects renamed or duplicated dialect declarations without shrinking the denominator", () => {
    const f = fixture();
    positive(f);
    f.put(canonical, f.declarations.replace("IrInstrAwait", "RenamedAwait"));
    expect(f.run().failures.join("\n")).toContain("exactly the 27 reviewed dialect interfaces");
    f.put(canonical, `${f.declarations}\nexport interface IrInstrAwait { readonly kind: 'await'; }`);
    expect(f.run().failures.join("\n")).toContain("exactly the 27 reviewed dialect interfaces");
  });

  it("ignores an unrelated directory with the same name", () => {
    const f = fixture();
    f.put("wit/dialect/vocab.ts", "export type V = number;");
    f.put("wit/consumer.ts", "import type { V } from './dialect/vocab.js';");
    positive(f);
  });

  it("requires canonical files by default, even when no moved file survives", () => {
    const f = fixture();
    const working = resolve(f.root, "production-default");
    mkdirSync(resolve(working, "src/ir"), { recursive: true });
    const result = spawnSync(process.execPath, [resolve(repo, "scripts/check-ir-dialect.mjs")], {
      cwd: working,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required canonical dialect boundary source is missing");
    const command = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8")).scripts["check:ir-dialect"];
    expect(command).toBe("node scripts/check-ir-dialect.mjs");
  });
});
