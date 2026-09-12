// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let root: string;
const ownedChildren: { release: string; closed: boolean }[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "js2-temporal-acquisition-test-"));
  mkdirSync(join(root, "fixtures"));
  for (const file of [
    "setup-temporal-polyfill.mjs",
    "temporal-polyfill-pin.json",
    "fixtures/jsbi-4.3.0.tgz",
    "fixtures/js-temporal-polyfill-0.5.1.tgz",
  ])
    copyFileSync(resolve("tests/dogfood", file), join(root, file));
});
afterEach(async () => {
  for (const child of ownedChildren) {
    writeFileSync(child.release, "cleanup release");
    // The acquisition process synchronously waits for its tar child. Its
    // close therefore precedes fixture removal, including on assertion errors.
    await until(() => child.closed, 20000);
  }
  ownedChildren.length = 0;
  rmSync(root, { recursive: true, force: true });
}, 25000);

function script(force = false) {
  return `import { setupTemporalPolyfill, linkPolyfillSource } from ${JSON.stringify(pathToFileURL(join(root, "setup-temporal-polyfill.mjs")).href)};
    import { createHash } from "node:crypto";
    const paths = setupTemporalPolyfill({ force: ${force} });
    console.log(JSON.stringify({ ...paths, hash: createHash("sha256").update(linkPolyfillSource(paths).source).digest("hex") }));`;
}
function acquire(force = false) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script(force)], { encoding: "utf8" }));
}
function shim(source: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tar"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
async function until(predicate: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("acquisition barrier timed out");
    await new Promise((done) => setTimeout(done, 10));
  }
}

it("reuses a complete generation and force preserves existing readers", () => {
  const legacy = join(root, ".temporal-polyfill");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "legacy-partial"), "untouched");
  const first = acquire();
  const again = acquire();
  const fresh = acquire(true);
  expect(again.root).toBe(first.root);
  expect(fresh.root).not.toBe(first.root);
  expect(fresh.hash).toBe(first.hash);
  expect(readFileSync(first.jsbiEntryPath, "utf8")).toContain("export default JSBI;");
  expect(readFileSync(first.umdModulePath).length).toBeGreaterThan(0);
  expect(readFileSync(join(legacy, "legacy-partial"), "utf8")).toBe("untouched");
  expect(acquire().root).toBe(first.root);
});

it("rechecks corrupt tarballs even when a generation already exists", () => {
  const first = acquire();
  writeFileSync(join(root, "fixtures/jsbi-4.3.0.tgz"), "corrupt");
  expect(() => acquire()).toThrow(/integrity mismatch/);
  expect(existsSync(first.jsbiEntryPath)).toBe(true);
});

it("does not publish a failed extraction and cleans only its staging", () => {
  const env = shim(`const cp=require('node:child_process'),args=process.argv.slice(2);
    if(args.some(a=>a.endsWith('jsbi-4.3.0.tgz'))) {
      process.stderr.write('injected second-package extraction failure'); process.exit(41);
    }
    cp.execFileSync('/usr/bin/tar',args,{stdio:'inherit'});`);
  expect(() =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script()], { env, stdio: "pipe" }),
  ).toThrow();
  expect(readdirSync(join(root, ".temporal-polyfill/generations"))).toEqual([]);
  expect(acquire().hash).toHaveLength(64);
});

it("refuses an incomplete published generation without deleting it", () => {
  const first = acquire();
  writeFileSync(first.umdModulePath, "");
  expect(() => acquire()).toThrow(/empty Temporal UMD bundle/);
  expect(existsSync(first.root)).toBe(true);
  expect(readFileSync(first.umdModulePath).length).toBe(0);
});

it("never publishes partial JSBI bytes; concurrent loser validates the completed winner", async () => {
  const ready = join(root, "ready");
  const release = join(root, "release");
  const env = shim(`const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
    const args=process.argv.slice(2), dest=args[args.indexOf('-C')+1];
    if(args.some(a=>a.endsWith('jsbi-4.3.0.tgz'))) {
      const file=path.join(dest,'package/dist/jsbi.mjs');
      fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'partial');
      fs.writeFileSync(${JSON.stringify(ready)},file);
      const deadline=Date.now()+15000;
      while(!fs.existsSync(${JSON.stringify(release)})) {
        if(Date.now()>deadline) process.exit(42);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    cp.execFileSync('/usr/bin/tar',args,{stdio:'inherit'});`);
  const first = spawn(process.execPath, ["--input-type=module", "-e", script()], { env });
  const owned = { release, closed: false };
  ownedChildren.push(owned);
  let stdout = "",
    stderr = "";
  let spawnError: Error | undefined;
  first.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  first.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // Never reject in the background while the test is awaiting its barrier.
  first.once("error", (error) => {
    spawnError = error;
  });
  const done = new Promise<number | null>((finish) => {
    first.once("close", (code) => {
      owned.closed = true;
      finish(code);
    });
  });
  try {
    await until(() => existsSync(ready) || owned.closed);
    expect(existsSync(ready), spawnError?.message ?? stderr).toBe(true);
    const partial = readFileSync(ready, "utf8");
    // This is exactly the old visibility window: existence did not certify
    // completion, and the unchanged source-link assertion rejects these bytes.
    expect(readFileSync(partial, "utf8")).not.toContain("export default JSBI;");
    const pin = JSON.parse(readFileSync(join(root, "temporal-polyfill-pin.json"), "utf8"));
    const stage = partial.split("/jsbi/")[0]!;
    const oldReader = `import { linkPolyfillSource } from ${JSON.stringify(pathToFileURL(join(root, "setup-temporal-polyfill.mjs")).href)};
    linkPolyfillSource(${JSON.stringify({ entryModulePath: join(stage, pin.entryModule), jsbiEntryPath: partial })});`;
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", oldReader], { encoding: "utf8", stdio: "pipe" }),
    ).toThrow(/jsbi bundle no longer ends/);
    expect(readdirSync(join(root, ".temporal-polyfill/generations"))).toHaveLength(1);
    const winner = acquire();
    expect(winner.jsbiEntryPath).not.toBe(partial);
    writeFileSync(release, "go");
    await until(() => owned.closed, 20000);
    expect(await done, stderr).toBe(0);
    const loser = JSON.parse(stdout);
    expect(loser.root).toBe(winner.root);
    expect(loser.hash).toBe(winner.hash);
    expect(readdirSync(join(root, ".temporal-polyfill/generations"))).toEqual([winner.root.split("/").at(-1)]);
    expect(spawnError).toBeUndefined();
  } finally {
    // Release even when an earlier assertion fails. Do not kill only the
    // parent and orphan its paused tar shim against a deleted fixture root.
    writeFileSync(release, "finally release");
    await until(() => owned.closed, 20000);
    await done;
  }
}, 20000);
