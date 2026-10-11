// #6791 — a compiled `Promise.reject(x)` is no longer pre-marked handled.
//
// The host `Promise_reject` builtin used to attach a no-op `catch` to every
// promise it returned, so a rejection the program then dropped never reached
// Node's `unhandledRejection` (a native run reports it). The no-op catch only
// existed for the `for await` sync drive (#2978), which binds element promises
// without awaiting them; that drive now marks its own elements instead.
//
// The signal under test is process-global (`--unhandled-rejections=strict`
// turns an unhandled rejection into a non-zero exit), so each program runs in a
// child process. The parent compiles; the child only instantiates and runs.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.ts";

const root = resolve(import.meta.dirname, "..");
const runtimeUrl = pathToFileURL(resolve(root, "src/runtime.ts")).href;

const runner = `
  import { buildImports } from ${JSON.stringify(runtimeUrl)};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { binary, manifest, stringPool } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const imports = buildImports(manifest, undefined, stringPool);
  const { instance } = await WebAssembly.instantiate(Buffer.from(binary, "base64"), imports);
  imports.setInstance?.(instance);
  let out;
  try {
    out = await instance.exports.run();
  } catch (e) {
    out = "threw: " + (e?.message ?? String(e));
  }
  console.log("RESULT " + JSON.stringify(out));
  // Give the host rejection tracker a macrotask turn to fire.
  await new Promise((r) => setTimeout(r, 50));
`;

/** Compile on the JS-host lane, run `run()` in a strict-rejections child. */
async function runStrict(src: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors?.map((e) => e.message).join("; ")).toBe(true);
  const payload = JSON.stringify({
    binary: Buffer.from(r.binary).toString("base64"),
    manifest: r.imports,
    stringPool: r.stringPool,
  });
  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", runner],
    { cwd: root, input: payload, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  expect(child.error).toBeUndefined();
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe("#6791 — dropped Promise.reject reaches unhandledRejection", () => {
  test("a dropped `Promise.reject(err)` exits 1 under --unhandled-rejections=strict", async () => {
    const { code, stdout, stderr } = await runStrict(`
      export function run(): number {
        Promise.reject(new Error("dropped-6791"));
        return 1;
      }
    `);
    expect(stdout).toContain("RESULT 1");
    expect(stderr).toContain("dropped-6791");
    expect(code).toBe(1);
  }, 60_000);

  test("a handled `Promise.reject` stays silent", async () => {
    const { code, stdout, stderr } = await runStrict(`
      export async function run(): Promise<number> {
        let caught = 0;
        await Promise.reject(new Error("handled")).catch(() => { caught++; });
        return caught;
      }
    `);
    expect(stdout, stderr).toContain("RESULT 1");
    expect(code, stderr).toBe(0);
  }, 60_000);

  test("for await over an async iterator whose next() rejects: one rejection, caught", async () => {
    const { code, stdout, stderr } = await runStrict(`
      export async function run(): Promise<number> {
        let caught = 0;
        const it: any = {
          [Symbol.asyncIterator]() {
            return { next() { return Promise.reject(new Error("boom")); } };
          },
        };
        await 0;
        try {
          for await (const x of it) {}
        } catch (e) {
          caught++;
        }
        return caught;
      }
    `);
    expect(stdout, stderr).toContain("RESULT 1");
    expect(code, stderr).toBe(0);
  }, 60_000);

  test("for await sync drive over rejected elements (#2978 shape) marks the elements it drops", async () => {
    // A sync iterator that never reports done and yields a fresh rejected
    // promise per step: the host-lane sync drive cannot await them and stops
    // at the #2978 step cap, dropping ~100k rejected elements on the way.
    const { code, stdout, stderr } = await runStrict(`
      let returnCount = 0;
      async function drive() {
        const syncIterator: any = {
          [Symbol.iterator]() {
            return {
              next() { return { value: Promise.reject("reject"), done: false }; },
              return() { returnCount += 1; return {}; },
            };
          },
        };
        for await (const _ of syncIterator) {}
      }
      export async function run(): Promise<number> {
        let caught = 0;
        try {
          await drive();
        } catch (e) {
          caught++;
        }
        return caught * 10 + returnCount;
      }
    `);
    expect(stdout, stderr).toContain("RESULT 11");
    expect(code, stderr).toBe(0);
  }, 60_000);

  test("for await over a struct iterator and over an array of rejected promises stays silent", async () => {
    const { code, stdout, stderr } = await runStrict(`
      class It {
        i = 0;
        next(): { value: Promise<number>; done: boolean } {
          this.i++;
          if (this.i > 3) return { value: Promise.resolve(0), done: true };
          return { value: Promise.reject(new Error("r" + this.i)), done: false };
        }
        [Symbol.iterator]() { return this; }
      }
      async function direct() {
        for await (const _ of new It()) {}
      }
      async function array() {
        const arr = [Promise.reject(new Error("a"))];
        for await (const _ of arr) {}
      }
      export async function run(): Promise<number> {
        try { await direct(); } catch (e) {}
        try { await array(); } catch (e) {}
        return 1;
      }
    `);
    expect(stdout, stderr).toContain("RESULT 1");
    expect(code, stderr).toBe(0);
  }, 60_000);
});
