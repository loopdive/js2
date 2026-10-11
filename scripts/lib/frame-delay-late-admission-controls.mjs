// Opt-in late admission controls. No compiler, comparison, or filesystem writes.
// Example: NODE_OPTIONS=--max-old-space-size=2048 node --max-old-space-size=2048
//   THIS_FILE --contract /abs/contract.mjs --manifest /abs/review.json --manifest-sha256 SHA
// Integration target: scripts/lib/frame-delay-late-admission-controls.mjs
// One real review preflight records OBSERVED read digests/metadata/Git output.
// Later controls replay that frozen snapshot, NOT current filesystem admission.
// No production constants, source counts, or contract functions are replaced.
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert(["--contract", "--manifest", "--manifest-sha256"].includes(key));
  assert(!Object.hasOwn(options, key));
  assert(process.argv[i + 1]);
  options[key] = process.argv[i + 1];
}
for (const key of ["--contract", "--manifest"]) assert(isAbsolute(options[key] ?? ""));
assert.match(options["--manifest-sha256"] ?? "", /^[a-f0-9]{64}$/);
const native = {
  read: fs.readFileSync,
  realpath: fs.realpathSync,
  list: fs.readdirSync,
  git: childProcess.execFileSync,
  hash: crypto.createHash,
};
const digest = (bytes) => native.hash("sha256").update(bytes).digest("hex");
const manifestBytes = native.read(options["--manifest"]);
assert.equal(digest(manifestBytes), options["--manifest-sha256"], "explicit review manifest digest");
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.status, "REVIEW_REQUIRED_NOT_AUTHORIZED");
const contractSha256 = digest(native.read(options["--contract"]));
assert.equal(contractSha256, manifest.instruments["scripts/lib/frame-delay-three-arm-contract.mjs"]);
const { assertReviewAdmission } = await import(pathToFileURL(options["--contract"]).href);
const roots = new Set(Object.values(manifest.suites).flatMap((arms) => Object.values(arms).map((pin) => pin.root)));
const cache = { reads: new Map(), realpaths: new Map(), lists: new Map(), git: new Map() };
const tagged = new WeakMap();
const replacements = [];
const results = [];
const counters = {
  nativeReads: 0,
  nativeReadBytes: 0,
  nativeRealpaths: 0,
  nativeLists: 0,
  nativeGit: 0,
  replayReads: 0,
  replayHashes: 0,
  comparisonRuns: 0,
  compilerInvocations: 0,
};
let phase = "capture";
let gitOverride = null;
function replace(object, key, value) {
  const previous = object[key];
  replacements.push(() => {
    object[key] = previous;
  });
  object[key] = value;
}
function observed(map, key) {
  assert(map.has(key), "UNOBSERVED_REPLAY_ACCESS: " + key);
  return map.get(key);
}
function stableRecord(map, key, value) {
  if (map.has(key)) assert.deepEqual(map.get(key), value, "read drift during real positive control: " + key);
  else map.set(key, value);
}
function read(path, encoding) {
  assert.equal(typeof path, "string");
  assert.equal(encoding, undefined, "unexpected non-hash read");
  if (phase === "capture") {
    const bytes = native.read(path);
    counters.nativeReads++;
    counters.nativeReadBytes += bytes.length;
    tagged.set(bytes, { path });
    return bytes;
  }
  const expectedDigest = observed(cache.reads, path);
  const token = Buffer.from("OBSERVED_READ_TOKEN:" + path);
  tagged.set(token, { path, expectedDigest });
  counters.replayReads++;
  return token;
}
// Only digest-only reads use replay tokens. Hashes of freshly constructed census
// strings still use genuine SHA256, so source/dependency census logic is exercised.
// A replay token's digest is what the REAL positive preflight computed, never a
// manifest expectation. No file bytes or expected production constants are forged.
function createHash(algorithm, hashOptions) {
  assert.equal(algorithm, "sha256");
  assert.equal(hashOptions, undefined);
  let hasher,
    inputTag,
    updates = 0;
  const wrapper = {
    update(input, encoding) {
      assert.equal(++updates, 1, "contract hash shape changed; reassess replay");
      inputTag = Buffer.isBuffer(input) ? tagged.get(input) : undefined;
      if (phase !== "replay" || !inputTag) hasher = native.hash(algorithm).update(input, encoding);
      return wrapper;
    },
    digest(encoding) {
      assert.equal(updates, 1);
      assert.equal(encoding, "hex");
      if (phase === "replay" && inputTag) {
        counters.replayHashes++;
        return inputTag.expectedDigest;
      }
      const hash = hasher.digest(encoding);
      if (phase === "capture" && inputTag) stableRecord(cache.reads, inputTag.path, hash);
      return hash;
    },
  };
  return wrapper;
}
function realpath(path) {
  assert.equal(typeof path, "string");
  if (phase === "replay") return observed(cache.realpaths, path);
  const value = native.realpath(path);
  counters.nativeRealpaths++;
  stableRecord(cache.realpaths, path, value);
  return value;
}
function list(path, options) {
  assert.deepEqual(options, { withFileTypes: true });
  let entries;
  if (phase === "capture") {
    entries = native
      .list(path, options)
      .map((e) => ({ name: e.name, directory: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() }));
    counters.nativeLists++;
    stableRecord(cache.lists, path, entries);
  } else entries = observed(cache.lists, path);
  return entries.map((e) => ({
    name: e.name,
    isDirectory: () => e.directory,
    isFile: () => e.file,
    isSymbolicLink: () => e.link,
  }));
}
function git(command, args, options) {
  assert.equal(command, "git");
  assert.equal(args[0], "-C");
  assert(roots.has(args[1]), "unreviewed Git root");
  const tail = args.slice(2);
  assert(
    [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain", "--untracked-files=all", "--", "src"],
      ["ls-files", "--others", "--exclude-standard", "--", "src"],
    ].some((allowed) => JSON.stringify(allowed) === JSON.stringify(tail)),
    "Git command not read-only allowlisted",
  );
  assert.deepEqual(options, { encoding: "utf8" });
  const key = JSON.stringify(args);
  if (phase === "replay") {
    const original = observed(cache.git, key);
    return gitOverride?.key === key ? gitOverride.value : original;
  }
  // Prevent optional Git status/index refresh writes; no production environment
  // control is changed and only read-only Git commands reach the host.
  const result = native.git(command, args, { ...options, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  counters.nativeGit++;
  stableRecord(cache.git, key, result);
  return result;
}
function runCase(name, mutation, expectedMessage = null) {
  const start = performance.now();
  const input = structuredClone(manifest);
  const before = { ...counters };
  gitOverride = null;
  try {
    mutation?.(input);
    assert.equal(input.status, "REVIEW_REQUIRED_NOT_AUTHORIZED");
    if (expectedMessage) {
      let caught;
      try {
        assertReviewAdmission(input, manifest.instrumentRoot);
      } catch (error) {
        caught = error;
      }
      assert(caught, "mutation was admitted: " + name);
      assert.equal(caught.code, "ERR_ASSERTION", "must reach contract assertion, not an IO/replay failure");
      assert(caught.message.includes(expectedMessage), "wrong rejection: " + caught.message);
    } else assertReviewAdmission(input, manifest.instrumentRoot);
    if (phase === "replay") {
      for (const key of ["nativeReads", "nativeReadBytes", "nativeRealpaths", "nativeLists", "nativeGit"])
        assert.equal(counters[key], before[key], "replay touched host: " + key);
      assert.equal(
        counters.replayReads - before.replayReads,
        counters.replayHashes - before.replayHashes,
        "every replay token was hashed",
      );
    }
    const row = {
      name,
      phase,
      expectedAssertion: expectedMessage,
      pass: true,
      elapsedMs: Math.round(performance.now() - start),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  } finally {
    gitOverride = null;
  }
}
try {
  replace(fs, "readFileSync", read);
  replace(fs, "realpathSync", realpath);
  replace(fs, "readdirSync", list);
  replace(crypto, "createHash", createHash);
  replace(childProcess, "execFileSync", git);
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "fork"])
    replace(childProcess, key, () => {
      throw new Error("comparison/subprocess launch forbidden: " + key);
    });
  syncBuiltinESMExports();
  runCase("positive: real complete review preflight", null);
  phase = "replay";
  runCase("positive: frozen observed snapshot admits unchanged review manifest", null);
  for (const suite of ["frame", "delay"]) {
    runCase(
      suite + ": original/repaired root alias",
      (m) => {
        m.suites[suite].repaired.root = m.suites[suite].original.root;
      },
      "aliased original/repaired roots",
    );
    runCase(
      suite + ": missing repair difference entry",
      (m) => {
        m.repairs[suite].difference.pop();
      },
      "unapproved repair hunk/postimage",
    );
    runCase(
      suite + ": changed repair postimage",
      (m) => {
        m.repairs[suite].difference[0].postimageSha256 = "0".repeat(64);
      },
      "unapproved repair hunk/postimage",
    );
    runCase(
      suite + ": reordered repair difference",
      (m) => {
        m.repairs[suite].difference.reverse();
      },
      "unapproved repair hunk/postimage",
    );
    runCase(
      suite + ": stale patch digest",
      (m) => {
        m.repairs[suite].sha256 = "0".repeat(64);
      },
      "patch drift",
    );
    const other = suite === "frame" ? "delay" : "frame";
    runCase(
      suite + ": wrong patch path with original digest",
      (m) => {
        m.repairs[suite].patch = m.repairs[other].patch;
      },
      "patch drift",
    );
    runCase(
      suite + ": substituted patch with matching observed digest",
      (m) => {
        m.repairs[suite].patch = m.repairs[other].patch;
        m.repairs[suite].sha256 = m.repairs[other].sha256;
      },
      "unapproved patch",
    );
  }
  runCase(
    "cross-suite original root alias",
    (m) => {
      m.suites.delay.original.root = m.suites.frame.original.root;
    },
    "aliased original/repaired roots",
  );
  for (let i = 0; i < manifest.evidence.length; i++) {
    runCase(
      "evidence " + i + ": changed digest",
      (m) => {
        m.evidence[i].sha256 = "0".repeat(64);
      },
      "original evidence denominator",
    );
    runCase(
      "evidence " + i + ": wrong path preserving approved digest population",
      (m) => {
        m.evidence[i].path = m.evidence[(i + 1) % m.evidence.length].path;
      },
      "original receipt changed",
    );
  }
  runCase(
    "missing historical evidence",
    (m) => {
      m.evidence.pop();
    },
    "original evidence denominator",
  );
  runCase(
    "duplicate historical evidence",
    (m) => {
      m.evidence[1] = structuredClone(m.evidence[0]);
    },
    "original evidence denominator",
  );
  runCase(
    "observed Git output mutation: original source dirty",
    (m) => {
      gitOverride = {
        key: JSON.stringify([
          "-C",
          m.suites.frame.original.root,
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          "src",
        ]),
        value: " M src/index.ts\n",
      };
    },
    "original/candidate source dirty",
  );
  runCase(
    "observed Git output mutation: repaired untracked source",
    (m) => {
      gitOverride = {
        key: JSON.stringify([
          "-C",
          m.suites.frame.repaired.root,
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          "src",
        ]),
        value: "src/untracked.ts\n",
      };
    },
    "untracked source",
  );
  runCase("positive: unchanged frozen snapshot after all negative controls", null);
} catch (error) {
  results.push({ name: "STOP", pass: false, error: { name: error.name, message: error.message } });
  process.exitCode = 1;
} finally {
  for (const restore of replacements.reverse()) restore();
  syncBuiltinESMExports();
}
// Detect direct manifest/contract edits across the bounded probe; do not repeat
// the expensive live census or pretend frozen replay observes later root changes.
assert.equal(
  digest(native.read(options["--manifest"])),
  options["--manifest-sha256"],
  "manifest changed during controls",
);
assert.equal(digest(native.read(options["--contract"])), contractSha256, "contract changed during controls");
console.log(
  "LATE_ADMISSION_EVIDENCE=" +
    JSON.stringify({
      schema: "frame-delay-late-admission-controls-v1",
      manifestSha256: options["--manifest-sha256"],
      contractSha256,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      status: process.exitCode ? "FAIL" : "PASS",
      tests: results.length,
      passed: results.filter((r) => r.pass).length,
      nativeObservation: "one full real review preflight; optional Git index writes disabled",
      replay:
        "observed file SHA256 values, directory/link metadata and read-only Git results; census strings rehashed normally; zero host IO in replay",
      limitations: [
        "not execution approval",
        "not a repeated live filesystem admission",
        "real OS Git dirty/untracked behavior not exercised by synthetic output mutations",
        "final protected-original/candidate-repaired alias assertions not independently reached; earlier root/census defenses reject first",
        "no compiler or comparison arms",
      ],
      counters,
      cacheEntries: Object.fromEntries(Object.entries(cache).map(([key, value]) => [key, value.size])),
      results,
    }),
);
