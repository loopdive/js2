// Parent integration target: scripts/lib/frame-delay-three-arm-admission.test.mjs.
// Scratch invocation: FD_ADMISSION_CONTRACT=/absolute/path/to/contract.mjs node --test THIS_FILE
// Synthetic unit controls only: no compiler, runner, historical arm, filesystem
// writes, real Git invocation, or substitutions for production hash constants.
// Deliberate limits: no fully admitted historical manifest; late arm aliases,
// Git index/status rejection, repair postimage/patch drift, and evidence drift
// are NOT covered. A two-file synthetic source must stop at the immutable floor.
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const override = process.env.FD_ADMISSION_CONTRACT;
if (override) assert(isAbsolute(override), "FD_ADMISSION_CONTRACT must be absolute");
const contractURL = override
  ? pathToFileURL(override)
  : new URL("./frame-delay-three-arm-contract.mjs", import.meta.url);
const contract = await import(contractURL.href); // Contract only; never import the runner.
const { sha, readManifest, sourceSnapshot, assertAdmission, ORIGINAL_INSTRUMENTS, SPEC } = contract;
const contractRoot = resolve(dirname(fileURLToPath(contractURL)), "../..");
const realRead = fs.readFileSync.bind(fs);
const contractDigest = sha(realRead(contractURL));
// Original instrument bytes are data, never imported/evaluated. Only these small
// fixed instrument files are read from the checkout; no source census/dependencies.
const instrumentBytes = new Map(
  Object.keys(ORIGINAL_INSTRUMENTS).map((path) => [path, realRead(join(contractRoot, path))]),
);
for (const [path, bytes] of instrumentBytes) assert.equal(sha(bytes), ORIGINAL_INSTRUMENTS[path], path);
instrumentBytes.set("scripts/lib/frame-delay-three-arm-contract.mjs", realRead(contractURL));
instrumentBytes.set("scripts/verify-frame-delay-three-arm.mjs", Buffer.from("synthetic inert runner bytes"));

const BASE = "/__frame_delay_synthetic_only__";
const INSTRUMENT = BASE + "/instrument";
const ARM = BASE + "/original";
const DEPENDENCIES = BASE + "/dependencies";
const MANIFEST = BASE + "/manifest.json";
const gitOverrides = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];
const relevantControls = () =>
  Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /^(JS2WASM_|IR_VERIFY_|TSX_|NODE_|ESBUILD_)/.test(key))
      .sort(),
  );

function fixture() {
  const nodes = new Map();
  const gitCalls = [];
  function directory(path) {
    if (nodes.has(path)) return;
    nodes.set(path, { kind: "directory" });
    if (path !== "/") directory(dirname(path));
  }
  function file(path, bytes) {
    directory(dirname(path));
    nodes.set(path, { kind: "file", bytes: Buffer.from(bytes) });
  }
  function lookup(path) {
    const node = nodes.get(String(path));
    if (!node) throw Object.assign(new Error("synthetic missing: " + path), { code: "ENOENT" });
    return node;
  }
  function realpath(path) {
    const node = lookup(path);
    return node.kind === "link" ? realpath(node.target) : String(path);
  }
  function read(path, options) {
    const node = lookup(realpath(path));
    assert.equal(node.kind, "file", "synthetic read requires regular file");
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? node.bytes.toString(encoding) : Buffer.from(node.bytes);
  }
  function list(path, options) {
    path = realpath(path);
    assert.equal(lookup(path).kind, "directory");
    assert.equal(options?.withFileTypes, true);
    return [...nodes]
      .filter(([entry]) => entry !== path && dirname(entry) === path)
      .map(([entry, node]) => ({
        name: entry.slice(path.length + 1),
        isDirectory: () => node.kind === "directory",
        isFile: () => node.kind === "file",
        isSymbolicLink: () => node.kind === "link",
      }));
  }
  function git(command, args, options) {
    assert.equal(command, "git", "no executable other than stubbed read-only Git permitted");
    assert.deepEqual(args, ["-C", ARM, "rev-parse", "HEAD"], "unexpected command is never forwarded");
    assert.deepEqual(options, { encoding: "utf8" });
    gitCalls.push([...args]);
    return SPEC.frame.head + "\n";
  }
  for (const [path, bytes] of instrumentBytes) file(join(INSTRUMENT, path), bytes);
  file(process.execPath, "synthetic node executable bytes; never executed");
  file(ARM + "/src/z.ts", "synthetic z");
  file(ARM + "/src/nested/a.ts", "synthetic a");
  file(DEPENDENCIES + "/entry.js", "synthetic dependency; never imported");
  nodes.set(ARM + "/node_modules", { kind: "link", target: DEPENDENCIES });
  const sourceFiles = [
    ["src/nested/a.ts", sha("synthetic a")],
    ["src/z.ts", sha("synthetic z")],
  ];
  const manifest = {
    schema: "frame-delay-three-arm-execution-v1",
    status: "REVIEWED_FOR_EXECUTION",
    instrumentRoot: INSTRUMENT,
    instruments: Object.fromEntries([...instrumentBytes].map(([path, bytes]) => [path, sha(bytes)])),
    environment: {
      node: process.execPath,
      nodeSha256: sha(read(process.execPath)),
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      execArgv: ["--max-old-space-size=2048"],
      controls: relevantControls(),
    },
    dependencies: {
      root: DEPENDENCIES,
      count: 1,
      sha256: sha(JSON.stringify([["entry.js", "file", sha("synthetic dependency; never imported")]])),
    },
    suites: {
      frame: {
        original: { root: ARM, head: SPEC.frame.head, sourceFiles, sourceSha256: sha(JSON.stringify(sourceFiles)) },
        repaired: {},
        candidate: {},
      },
      delay: {},
    },
  };
  file(MANIFEST, JSON.stringify(manifest));
  return { nodes, gitCalls, file, read, realpath, list, git, manifest };
}

// All calls to these tests are synchronous. Restore named builtin bindings and
// process controls in finally, including on an assertion failure. Never forward
// an unrecognized filesystem read or subprocess call to the host.
function isolated(t, callback) {
  const originalArgs = process.execArgv;
  const keys = [...gitOverrides, "NODE_OPTIONS", "JS2WASM_SYNTHETIC_ADMISSION_CONTROL"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const mocks = [];
  try {
    for (const key of gitOverrides) delete process.env[key];
    delete process.env.JS2WASM_SYNTHETIC_ADMISSION_CONTROL;
    process.env.NODE_OPTIONS = "--max-old-space-size=2048";
    process.execArgv = ["--max-old-space-size=2048"];
    const f = fixture();
    mocks.push(
      t.mock.method(fs, "readFileSync", f.read),
      t.mock.method(fs, "realpathSync", f.realpath),
      t.mock.method(fs, "readdirSync", f.list),
    );
    mocks.push(t.mock.method(childProcess, "execFileSync", f.git));
    for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"])
      mocks.push(
        t.mock.method(childProcess, method, () => {
          throw new Error("subprocess forbidden: " + method);
        }),
      );
    syncBuiltinESMExports();
    callback(f);
  } finally {
    for (const mocked of mocks.reverse()) mocked.mock.restore();
    syncBuiltinESMExports();
    process.execArgv = originalArgs;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const syntheticTest = (name, callback) => test(name, { concurrency: false }, (t) => isolated(t, (f) => callback(f, t)));
const admit = (f) => assertAdmission(f.manifest, INSTRUMENT);
const assertion = (message) => (error) => error.code === "ERR_ASSERTION" && error.message.includes(message);
const floorRejection = (error) =>
  error.code === "ERR_ASSERTION" && error.actual === 2 && error.expected === SPEC.frame.count;

syntheticTest("control: unchanged manifest digest/status parses exactly (not execution admission)", (f, t) => {
  assert.deepEqual(readManifest(MANIFEST, sha(f.read(MANIFEST))), f.manifest);
  t.diagnostic("contract SHA256=" + contractDigest + "; in-memory filesystem/Git only; zero arm runs");
});
syntheticTest("stale manifest digest rejects changed bytes before parsing", (f) => {
  const digest = sha(f.read(MANIFEST));
  f.file(MANIFEST, f.read(MANIFEST).toString() + "\n");
  assert.throws(() => readManifest(MANIFEST, digest), assertion("execution manifest digest"));
});
for (const [name, bytes, message] of [
  [
    "review-only status",
    JSON.stringify({ schema: "frame-delay-three-arm-execution-v1", status: "REVIEW_ONLY" }),
    "not execution-approved",
  ],
  ["missing status", JSON.stringify({ schema: "frame-delay-three-arm-execution-v1" }), "not execution-approved"],
  [
    "wrong schema",
    JSON.stringify({ schema: "other", status: "REVIEWED_FOR_EXECUTION" }),
    "frame-delay-three-arm-execution-v1",
  ],
])
  syntheticTest("authenticated manifest rejects " + name, (f) => {
    f.file(MANIFEST, bytes);
    assert.throws(() => readManifest(MANIFEST, sha(bytes)), assertion(message));
  });
syntheticTest("authenticated malformed JSON rejects", (f) => {
  f.file(MANIFEST, "{");
  assert.throws(() => readManifest(MANIFEST, sha("{")), SyntaxError);
});
syntheticTest("malformed digest rejects before any manifest read", (f) => {
  f.nodes.delete(MANIFEST);
  assert.throws(() => readManifest(MANIFEST, "not-a-digest"), { code: "ERR_ASSERTION" });
});
syntheticTest("missing manifest fails closed with ENOENT", (f) => {
  f.nodes.delete(MANIFEST);
  assert.throws(() => readManifest(MANIFEST, "0".repeat(64)), { code: "ENOENT" });
});

syntheticTest("control: sorted recursive source inventory has exact content hashes and HEAD", (f) => {
  assert.deepEqual(sourceSnapshot(ARM), f.manifest.suites.frame.original);
  assert.equal(f.gitCalls.length, 1);
});
syntheticTest("control: admission reaches immutable source count floor, never synthetic PASS", (f) => {
  assert.throws(() => admit(f), floorRejection);
  assert.equal(f.gitCalls.length, 1);
});
for (const [name, mutate] of [
  ["new unlisted entry", (f) => f.file(ARM + "/src/new.ts", "new entry, not a Git-index simulation")],
  ["missing entry", (f) => f.nodes.delete(ARM + "/src/z.ts")],
  ["changed content", (f) => f.file(ARM + "/src/z.ts", "changed")],
  [
    "stale census hash",
    (f) => {
      f.manifest.suites.frame.original.sourceSha256 = "0".repeat(64);
    },
  ],
])
  syntheticTest("admission rejects source census: " + name, (f) => {
    mutate(f);
    assert.throws(() => admit(f), assertion("source census drift"));
    assert.equal(f.gitCalls.length, 1);
  });
for (const kind of ["link", "fifo", "socket"])
  syntheticTest("source snapshot rejects nonregular " + kind + " before Git", (f) => {
    f.nodes.set(ARM + "/src/z.ts", { kind, target: ARM + "/src/nested/a.ts" });
    assert.throws(() => sourceSnapshot(ARM), assertion("nonregular source: src/z.ts"));
    assert.equal(f.gitCalls.length, 0);
  });
syntheticTest("missing source directory fails before Git", (f) => {
  f.nodes.delete(ARM + "/src");
  assert.throws(() => sourceSnapshot(ARM), { code: "ENOENT" });
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("missing root fails before Git", (f) => {
  f.nodes.delete(ARM);
  assert.throws(() => sourceSnapshot(ARM), { code: "ENOENT" });
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("noncanonical arm-root alias rejects before census floor", (f) => {
  const alias = BASE + "/alias";
  f.nodes.set(alias, { kind: "link", target: ARM });
  f.nodes.set(alias + "/node_modules", { kind: "link", target: DEPENDENCIES });
  f.manifest.suites.frame.original.root = alias;
  assert.throws(() => admit(f), assertion("canonical root"));
});
syntheticTest("instrument root mismatch fails before source access", (f) => {
  f.manifest.instrumentRoot = ARM;
  assert.throws(
    () => admit(f),
    (e) => e.code === "ERR_ASSERTION" && e.actual === INSTRUMENT && e.expected === ARM,
  );
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("arm pointing to a different dependency root rejects", (f) => {
  f.nodes.set(ARM + "/node_modules", { kind: "link", target: INSTRUMENT });
  assert.throws(() => admit(f), assertion("unpinned dependency root"));
});
syntheticTest("dependency bytes drift rejects before source access", (f) => {
  f.file(DEPENDENCIES + "/entry.js", "changed");
  assert.throws(() => admit(f), assertion("complete dependency census drift"));
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("dependency symlink escape rejects before source access", (f) => {
  f.nodes.set(DEPENDENCIES + "/escape", { kind: "link", target: INSTRUMENT });
  assert.throws(() => admit(f), assertion("dependency symlink escapes pinned tree"));
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("unsafe extra instrument path rejects complete pin set", (f) => {
  f.manifest.instruments["../escape"] = sha("unused");
  assert.throws(() => admit(f), assertion("complete instrument pins"));
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("instrument byte drift rejects before source access", (f) => {
  const path = "scripts/verify-frame-delay-three-arm.mjs";
  f.file(join(INSTRUMENT, path), "changed inert bytes");
  assert.throws(() => admit(f), assertion("file pin: " + path));
  assert.equal(f.gitCalls.length, 0);
});
for (const key of gitOverrides)
  syntheticTest("Git environment override rejects before filesystem access: " + key, (f) => {
    process.env[key] = "/synthetic/forbidden";
    // Absent root would throw ENOENT if rejection happened too late.
    f.nodes.delete(INSTRUMENT);
    assert.throws(() => admit(f), assertion("Git-root override must be absent: " + key));
    assert.equal(f.gitCalls.length, 0);
  });
syntheticTest("NODE_OPTIONS mismatch rejects before source access", (f) => {
  process.env.NODE_OPTIONS = "--max-old-space-size=512";
  assert.throws(() => admit(f), assertion("same reviewed parent/child controls required"));
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("unexpected runtime control rejects before source access", (f) => {
  process.env.JS2WASM_SYNTHETIC_ADMISSION_CONTROL = "unreviewed";
  assert.throws(() => admit(f), assertion("unexpected runtime environment"));
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("coordinator argv mismatch rejects before source access", (f) => {
  f.manifest.environment.execArgv = ["--max-old-space-size=512"];
  assert.throws(
    () => admit(f),
    (e) =>
      e.code === "ERR_ASSERTION" &&
      e.actual?.[0] === "--max-old-space-size=512" &&
      e.expected?.[0] === "--max-old-space-size=2048",
  );
  assert.equal(f.gitCalls.length, 0);
});
syntheticTest("matching argv without mandatory heap flag still rejects", (f) => {
  process.execArgv = [];
  f.manifest.environment.execArgv = [];
  assert.throws(() => admit(f), assertion("explicit coordinator heap required"));
  assert.equal(f.gitCalls.length, 0);
});
