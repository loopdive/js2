import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSourceSync } from "../src/compiler.js";
import { compile } from "../src/index.js";

const SOURCE = `export function main(value: number): number { return value + 1; }`;

describe("standalone cutover audit public routes", () => {
  it("labels the synchronous and both disk-backed compiler routes", async () => {
    const sync = compileSourceSync(SOURCE, {
      fileName: "cutover-sync.ts",
      target: "standalone",
      experimentalIR: false,
      trackIrOutcomes: true,
    });
    expect(sync.success).toBe(true);
    expect(sync.irBodyRouteAudit?.route).toBe("compileSourceSync");

    const directory = mkdtempSync(join(tmpdir(), "js2-cutover-routes-"));
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, SOURCE);
    try {
      for (const [api, route] of [
        ["compileFiles", "compileFiles"],
        ["compileProject", "compileProject"],
      ] as const) {
        const script = `
          import { createRequire } from "node:module";
          globalThis.require = createRequire(import.meta.url);
          import("./src/index.ts").then(({ ${api} }) => {
            return ${api}(${JSON.stringify(entry)}, {
              target: "standalone", experimentalIR: false, trackIrOutcomes: true,
            });
          }).then((result) => {
              if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\\n"));
              process.stdout.write(JSON.stringify({
                route: result.irBodyRouteAudit?.route ?? "missing",
                sources: result.irBodyRouteAudit?.sources.map((source) => source.sourceKey) ?? [],
                files: result.irBodyRouteAudit?.legacyEntries.map((entry) => entry.file) ?? [],
              }));
          });
        `;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(child.status, child.stderr || child.stdout).toBe(0);
        const audit = JSON.parse(child.stdout) as { route: string; sources: string[]; files: string[] };
        expect(audit.route).toBe(route);
        expect([...audit.sources, ...audit.files].every((file) => !file.includes(directory))).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not alter emitted bytes or WAT when observation is enabled", async () => {
    const options = {
      fileName: "cutover-byte-identity.ts",
      target: "standalone" as const,
      experimentalIR: false,
      emitWat: true,
    };
    const plain = await compile(SOURCE, options);
    const observed = await compile(SOURCE, { ...options, trackIrOutcomes: true });
    expect(plain.success).toBe(true);
    expect(observed.success).toBe(true);
    expect(observed.binary).toEqual(plain.binary);
    expect(observed.wat).toBe(plain.wat);
    expect(observed.imports).toEqual(plain.imports);
  });
});
