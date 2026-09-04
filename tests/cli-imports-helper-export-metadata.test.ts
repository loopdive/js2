import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The CLI's generated `<name>.imports.js` must carry enough metadata for a
// consumer to get MARSHALLED exports, not opaque WasmGC handles.
//
// The API path hands `result.exportSignatures`/`exportBoundaryPolicies` to
// `wrapExports` (or uses `wrapCompiledExports`), but a CLI compile ends at the
// filesystem: before `wrapInstance` existed, a post-CLI consumer could
// instantiate the module and still only see raw handles — `makePoint(1, 2)`
// came back as an opaque struct that JSON-serializes to `undefined`. The
// metadata was already inside the emitted adapter manifest; nothing wired it
// to `wrapExports`.

const CLI = path.resolve("src/cli.ts");
const TSX = path.resolve("node_modules/.bin/tsx");

const SOURCE = `export function makePoint(x: number, y: number): { x: number; y: number } {
  return { x, y };
}
`;

function compile(): { dir: string; helper: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cli-imports-helper-"));
  writeFileSync(path.join(dir, "pt.ts"), SOURCE);
  execFileSync(TSX, [CLI, path.join(dir, "pt.ts"), "--quiet", "-o", dir], {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf-8",
  });
  return {
    dir,
    helper: readFileSync(path.join(dir, "pt.imports.js"), "utf-8"),
  };
}

describe("CLI imports helper — export metadata", () => {
  it("emits wrapInstance() wired to the manifest's export metadata", () => {
    const { helper } = compile();
    expect(helper).toContain("export function wrapInstance(");
    expect(helper).toContain("signatures: adapterManifest.exportSignatures");
    expect(helper).toContain("boundaryPolicies: adapterManifest.exportBoundaries");
    // The metadata must actually be populated — a helper wired to empty maps
    // would pass the wiring assertions above and still marshal nothing.
    expect(helper).toContain('"makePoint"');
  }, 120_000);

  it("returns marshalled exports from instantiateBytes, unlike the raw instance", async () => {
    const { dir, helper } = compile();
    // The emitted helper imports the published proxy package name; in-repo the
    // runtime lives at src/index.ts. Rewriting the specifier keeps this test
    // honest about the helper's own code (it is otherwise byte-for-byte).
    const rewritten = path.join(dir, "pt.imports.mjs");
    writeFileSync(rewritten, helper.replace('from "js2wasm"', `from ${JSON.stringify(path.resolve("src/index.ts"))}`));

    const runner = path.join(dir, "run.mts");
    writeFileSync(
      runner,
      `import { readFileSync } from "node:fs";
import { instantiateBytes } from ${JSON.stringify(rewritten)};
const { instance, exports } = await instantiateBytes(readFileSync(${JSON.stringify(path.join(dir, "pt.wasm"))}));
console.log(JSON.stringify({
  wrapped: exports.makePoint(1, 2),
  raw: instance.exports.makePoint(1, 2) ?? null,
}));
`,
    );
    const out = execFileSync(TSX, [runner], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf-8",
    });
    const parsed = JSON.parse(out.trim().split("\n").pop()!);
    expect(parsed.wrapped).toEqual({ x: 1, y: 2 });
    // The raw export hands back an opaque WasmGC handle, which is exactly the
    // state this helper exists to spare the consumer.
    expect(parsed.wrapped).not.toEqual(parsed.raw);
  }, 180_000);
});
