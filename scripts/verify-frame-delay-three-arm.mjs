// Additive orchestrator. Integrate at scripts/verify-frame-delay-three-arm.mjs.
// Original tests/recorders are read as authenticated text, never imported.
import assert from "node:assert/strict";
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  SPEC,
  ORIGINAL_INSTRUMENTS,
  sha,
  readManifest,
  assertAdmission,
  validateReceipt,
  compareSuite,
  sourceSnapshot,
} from "./lib/frame-delay-three-arm-contract.mjs";

const SCHEMA = "frame-delay-three-arm-execution-v1";
const STATUS = "REVIEWED_FOR_EXECUTION";
const CONTRACT_PATH = "scripts/lib/frame-delay-three-arm-contract.mjs";
const SUITES = Object.freeze({
  frame: Object.freeze({
    sourcePath: "tests/issue-3518-async-frame-body-source-preservation.test.ts",
    sourceSha256: ORIGINAL_INSTRUMENTS["tests/issue-3518-async-frame-body-source-preservation.test.ts"],
    originalHead: SPEC.frame.head,
    receiptPrefix: "FRAME_BODY_RECEIPT=",
    progressPrefix: "FRAME_BODY_PROGRESS=",
  }),
  delay: Object.freeze({
    sourcePath: "tests/helpers/native-delay-combinator-source-receipts.mjs",
    sourceSha256: ORIGINAL_INSTRUMENTS["tests/helpers/native-delay-combinator-source-receipts.mjs"],
    originalHead: SPEC.delay.head,
    receiptPrefix: "DELAY_COMBINATOR_RECEIPT=",
    progressPrefix: "DELAY_COMBINATOR_PROGRESS=",
  }),
});
const ROLES = ["original", "repaired", "candidate"];
const childArm = (role) => (role === "original" ? "baseline" : role);
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const save = (path, value) => writeFileSync(path, json(value), { flag: "wx" });
const errorInfo = (error) => ({ name: error?.name ?? "Error", message: String(error?.message ?? error) });
function writeAll(fd, input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    assert(written > 0, "zero-length evidence write");
    offset += written;
  }
}

export function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(["--manifest", "--manifest-sha256", "--execute"].includes(key), "unknown argument: " + key);
    assert(!Object.hasOwn(options, key), "duplicate argument: " + key);
    if (key === "--execute") options[key] = true;
    else {
      assert(args[i + 1] && !args[i + 1].startsWith("--"), "missing value: " + key);
      options[key] = args[++i];
    }
  }
  assert(options["--execute"] === true, "explicit --execute required; no implicit run");
  assert(isAbsolute(options["--manifest"] ?? ""), "explicit absolute manifest path required");
  assert.match(options["--manifest-sha256"] ?? "", /^[0-9a-f]{64}$/);
  return { manifestPath: realpathSync(options["--manifest"]), digest: options["--manifest-sha256"] };
}

export function extractPublicArmSource(source, expectedHash) {
  assert.equal(sha(source), expectedHash, "original recorder source hash mismatch");
  const text = source.toString("utf8");
  const matches = [...text.matchAll(/^(?:export )?const publicArmSource = String\.raw`/gm)];
  assert.equal(matches.length, 1, "exactly one authenticated publicArmSource declaration");
  const start = matches[0].index + matches[0][0].length;
  const end = text.indexOf("`", start);
  assert(end >= start && text.slice(end, end + 2) === "`;", "unrecognized raw literal boundary");
  const body = text.slice(start, end);
  assert(!body.includes("${"), "interpolated child source is not supported");
  assert(!body.endsWith("\\"), "escaped template delimiter is not supported");
  assert.equal(body.split('const compiler = await load("src/index.ts");').length, 2);
  return body;
}

export function addManifestAdmission(body) {
  const anchor = "const before = snapshot();";
  assert.equal(body.split(anchor).length, 2, "one original snapshot admission anchor");
  const admission = `// Additive manifest admission; original child body and baseline guard follow unchanged.
const [__fdManifestPath, __fdDigest, __fdInstrumentRoot, __fdSuite, __fdRole, __fdContractHash] = process.argv.slice(3);
assert(["frame", "delay"].includes(__fdSuite), "unknown suite");
assert(["original", "repaired", "candidate"].includes(__fdRole), "unknown role");
assert.equal(arm, __fdRole === "original" ? "baseline" : __fdRole, "role/child-arm mismatch");
assert.equal(hash(readFileSync(__fdManifestPath)), __fdDigest, "manifest changed before child admission");
const __fdHelper = join(__fdInstrumentRoot, "${CONTRACT_PATH}");
assert.equal(hash(readFileSync(__fdHelper)), __fdContractHash, "contract helper changed before child import");
const __fdContract = await import(pathToFileURL(__fdHelper).href);
const __fdManifest = await __fdContract.readManifest(__fdManifestPath, __fdDigest);
assert.equal(__fdManifest.schema, "${SCHEMA}");
assert.equal(__fdManifest.status, "${STATUS}");
await __fdContract.assertAdmission(__fdManifest, __fdInstrumentRoot, {suite: __fdSuite, role: __fdRole});
const __fdPin = __fdManifest.suites[__fdSuite][__fdRole];
assert.equal(root, realpathSync(__fdPin.root), "manifest root mismatch");
const __fdSnapshot = await __fdContract.sourceSnapshot(root);
assert.equal(__fdSnapshot.head, __fdPin.head, "child HEAD drift");
assert.deepEqual(__fdSnapshot.sourceFiles, __fdPin.sourceFiles, "child source inventory drift");
assert.equal(__fdSnapshot.sourceSha256, __fdPin.sourceSha256, "child source census drift");
// End additive admission.
`;
  const adapted = body.replace(anchor, admission + anchor);
  assert.equal(adapted.replace(admission, ""), body, "child program changed beyond admission insertion");
  return { source: adapted, admission, originalSha256: sha(body), adaptedSha256: sha(adapted) };
}

async function verifyPin(pin) {
  assert(pin && isAbsolute(pin.root), "manifest arm root must be absolute");
  assert.match(pin.head, /^[0-9a-f]{40}$/);
  assert(Array.isArray(pin.sourceFiles) && pin.sourceFiles.length > 1000);
  assert.match(pin.sourceSha256, /^[0-9a-f]{64}$/);
  const snapshot = await sourceSnapshot(pin.root);
  assert.equal(snapshot.head, pin.head, "arm HEAD drift");
  assert.deepEqual(snapshot.sourceFiles, pin.sourceFiles, "arm source inventory drift");
  assert.equal(snapshot.sourceSha256, pin.sourceSha256, "arm source census drift");
  return {
    root: realpathSync(pin.root),
    head: snapshot.head,
    sourceFiles: snapshot.sourceFiles.length,
    sourceSha256: snapshot.sourceSha256,
  };
}

// Buffer fragments, not repeated concatenation of a multi-megabyte JSON string.
async function readSavedReceipt(logPath, receiptPrefix, progressPrefix, receiptPath, progressPath) {
  let fragments = [],
    length = 0,
    count = 0,
    report;
  const progressFd = openSync(progressPath, "wx");
  function consume() {
    const line = Buffer.concat(fragments, length);
    fragments = [];
    length = 0;
    const receiptTag = Buffer.from(receiptPrefix),
      progressTag = Buffer.from(progressPrefix);
    if (line.subarray(0, receiptTag.length).equals(receiptTag)) {
      count++;
      assert.equal(count, 1, "duplicate terminal receipt; full stdout retained");
      const bytes = line.subarray(receiptTag.length);
      writeFileSync(receiptPath, bytes, { flag: "wx" }); // Persist before JSON validation/comparison.
      report = JSON.parse(bytes.toString("utf8"));
    } else if (line.subarray(0, progressTag.length).equals(progressTag)) {
      writeAll(progressFd, line.subarray(progressTag.length));
      writeAll(progressFd, "\n");
    }
  }
  try {
    for await (const chunk of createReadStream(logPath)) {
      let start = 0,
        end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const piece = chunk.subarray(start, end);
        fragments.push(piece);
        length += piece.length;
        consume();
        start = end + 1;
      }
      if (start < chunk.length) {
        const piece = chunk.subarray(start);
        fragments.push(piece);
        length += piece.length;
      }
    }
    if (length) consume();
  } finally {
    closeSync(progressFd);
  }
  assert.equal(count, 1, "missing terminal receipt; full stdout retained");
  return report;
}

async function executeArm({
  manifest,
  manifestPath,
  digest,
  instrumentRoot,
  suite,
  role,
  directory,
  program,
  helperHash,
}) {
  assert.equal(sha(readFileSync(manifestPath)), digest, "manifest changed before arm");
  await assertAdmission(manifest, instrumentRoot);
  const pin = manifest.suites[suite][role];
  const admitted = await verifyPin(pin);
  const base = join(directory, suite + "-" + role);
  const stdoutPath = base + ".stdout.log",
    stderrPath = base + ".stderr.log";
  const stdoutFd = openSync(stdoutPath, "wx"),
    stderrFd = openSync(stderrPath, "wx");
  const args = [
    "--max-old-space-size=2048",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    program.source,
    pin.root,
    childArm(role),
    manifestPath,
    digest,
    instrumentRoot,
    suite,
    role,
    helperHash,
  ];
  const started = {
    suite,
    role,
    childArm: childArm(role),
    ...admitted,
    node: process.execPath,
    nodeSha256: sha(readFileSync(realpathSync(process.execPath))),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    nodeOptions: "--max-old-space-size=2048",
    preload: "tsx",
    programSha256: program.adaptedSha256,
    sourceProgramPath: join(directory, suite + "-child.mjs"),
    manifestPath,
    manifestSha256: digest,
  };
  let terminal,
    ioError = null;
  try {
    terminal = await new Promise((resolveTerminal) => {
      let child,
        spawnError = null;
      try {
        child = spawn(process.execPath, args, {
          cwd: pin.root,
          env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolveTerminal({
          ...started,
          code: null,
          signal: null,
          spawnError: errorInfo(error),
          completedAt: new Date().toISOString(),
        });
        return;
      }
      started.pid = child.pid ?? null;
      try {
        save(base + "-started.json", started);
      } catch (error) {
        ioError = error;
      } // Never kill a live child on recorder failure.
      console.log(JSON.stringify({ suite, role, pid: started.pid, root: pin.root, stdoutPath, stderrPath }));
      child.stdout.on("data", (chunk) => {
        try {
          writeAll(stdoutFd, chunk);
        } catch (error) {
          ioError ??= error;
        }
      });
      child.stderr.on("data", (chunk) => {
        try {
          writeAll(stderrFd, chunk);
        } catch (error) {
          ioError ??= error;
        }
      });
      child.stdout.on("error", (error) => {
        ioError ??= error;
      });
      child.stderr.on("error", (error) => {
        ioError ??= error;
      });
      child.once("error", (error) => {
        spawnError = errorInfo(error);
      });
      child.once("close", (code, signal) =>
        resolveTerminal({
          ...started,
          code,
          signal,
          spawnError,
          ...(ioError ? { recorderError: errorInfo(ioError) } : {}),
          completedAt: new Date().toISOString(),
        }),
      );
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  save(base + "-terminal.json", terminal);
  let postAdmissionError;
  try {
    await assertAdmission(manifest, instrumentRoot);
    assert.equal(sha(readFileSync(manifestPath)), digest, "manifest changed during arm");
    await verifyPin(pin);
  } catch (error) {
    postAdmissionError = error;
    save(base + "-post-admission-error.json", errorInfo(error));
  }
  let report, receiptError;
  try {
    report = await readSavedReceipt(
      stdoutPath,
      SUITES[suite].receiptPrefix,
      SUITES[suite].progressPrefix,
      base + "-receipt.json",
      base + "-progress.jsonl",
    );
  } catch (error) {
    receiptError = error;
    save(base + "-receipt-error.json", errorInfo(error));
  }
  assert(
    !terminal.spawnError && !terminal.recorderError && terminal.code === 0 && terminal.signal === null,
    `child incomplete: ${suite}/${role}; terminal preserved at ${base}-terminal.json`,
  );
  if (receiptError) throw receiptError;
  if (postAdmissionError) throw postAdmissionError;
  assert.equal(report.arm, childArm(role), "receipt role mismatch");
  await validateReceipt(report, suite, pin);
  save(base + "-validated.json", {
    complete: true,
    receiptPath: base + "-receipt.json",
    receiptSha256: sha(readFileSync(base + "-receipt.json")),
    terminalPath: base + "-terminal.json",
  });
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const { manifestPath, digest } = parseArguments(args);
  const instrumentRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const manifest = await readManifest(manifestPath, digest);
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.status, STATUS, "manifest has not been approved for execution");
  // The contract owns exact instrument/dependency/environment/prior-evidence admission.
  await assertAdmission(manifest, instrumentRoot);
  assert.equal(sha(readFileSync(manifestPath)), digest, "manifest digest drift");
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
  ])
    assert(process.env[key] === undefined, "Git-root override must be absent: " + key);
  for (const suite of Object.keys(SUITES)) {
    const roots = [];
    for (const role of ROLES) roots.push((await verifyPin(manifest.suites[suite][role])).root);
    assert.equal(new Set(roots).size, 3, "O/R/C realpaths must be distinct within " + suite);
    assert.equal(manifest.suites[suite].original.head, SUITES[suite].originalHead);
  }
  const helperHash = sha(readFileSync(join(instrumentRoot, CONTRACT_PATH)));
  const programs = {};
  for (const [suite, definition] of Object.entries(SUITES)) {
    const body = extractPublicArmSource(
      readFileSync(join(instrumentRoot, definition.sourcePath)),
      definition.sourceSha256,
    );
    assert(body.includes(`if (arm === "baseline") {`));
    assert(body.includes(definition.originalHead), "historical baseline guard missing");
    programs[suite] = addManifestAdmission(body);
    assert.equal(programs[suite].adaptedSha256, manifest.programs[suite], "independently pinned adapted program");
  }
  mkdirSync(join(instrumentRoot, ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(instrumentRoot, ".tmp", "frame-delay-three-arm-"));
  const manifestSnapshot = readFileSync(manifestPath);
  assert.equal(sha(manifestSnapshot), digest, "manifest changed before evidence snapshot");
  writeFileSync(join(directory, "manifest-snapshot.json"), manifestSnapshot, { flag: "wx" });
  save(join(directory, "run-started.json"), {
    schema: SCHEMA,
    status: "RUNNING",
    manifestPath,
    digest,
    instrumentRoot,
    helperHash,
    environmentAdmission: "assertAdmission; full environment validated but secrets not copied to logs",
    sequence: Object.keys(SUITES).flatMap((suite) => ROLES.map((role) => ({ suite, role }))),
  });
  for (const [suite, program] of Object.entries(programs)) {
    writeFileSync(join(directory, suite + "-child.mjs"), program.source, { flag: "wx" });
    save(join(directory, suite + "-program.json"), {
      container: SUITES[suite],
      originalSha256: program.originalSha256,
      adaptedSha256: program.adaptedSha256,
      admissionSha256: sha(program.admission),
      onlyChange: "one additive admission insertion",
    });
  }
  console.log(JSON.stringify({ status: "RUNNING", directory }));
  const comparisons = {};
  try {
    for (const suite of Object.keys(SUITES)) {
      const reports = {};
      for (const role of ROLES)
        reports[role] = await executeArm({
          manifest,
          manifestPath,
          digest,
          instrumentRoot,
          suite,
          role,
          directory,
          program: programs[suite],
          helperHash,
        });
      const result = await compareSuite(reports.original, reports.repaired, reports.candidate);
      const exact = (a, b) => isDeepStrictEqual(a.fixtures, b.fixtures) && isDeepStrictEqual(a.rows, b.rows);
      assert.equal(
        typeof result.originalCandidateExact,
        "boolean",
        "compareSuite originalCandidateExact boolean required",
      );
      assert.equal(
        typeof result.repairedCandidateExact,
        "boolean",
        "compareSuite repairedCandidateExact boolean required",
      );
      assert.equal(result.originalCandidateExact, exact(reports.original, reports.candidate));
      assert.equal(result.repairedCandidateExact, exact(reports.repaired, reports.candidate));
      assert.equal(result.pass, result.repairedCandidateExact && result.lateImportExact !== false);
      if (suite === "frame") assert.equal(typeof result.lateImportExact, "boolean");
      // The contract returns a compact mismatch index, never full multi-MB expected/actual values.
      comparisons[suite] = result;
      save(join(directory, suite + "-comparison.json"), result);
    }
    await assertAdmission(manifest, instrumentRoot);
    assert.equal(sha(readFileSync(manifestPath)), digest, "manifest changed before verdict");
    const pass = Object.values(comparisons).every((result) => result.pass === true);
    const verdict = {
      status: pass ? "PASS" : "FAIL",
      completePopulation: true,
      sourceAdmission: true,
      instrumentIntegrity: true,
      semanticOracles: true,
      originalEvidencePreserved: true,
      comparisons,
      closureCertified: false,
      physicalAcceptanceCertified: false,
      retirementCertified: false,
    };
    save(join(directory, "verdict.json"), verdict);
    console.log(
      JSON.stringify({
        status: verdict.status,
        directory,
        comparisons: Object.fromEntries(
          Object.entries(comparisons).map(([suite, result]) => [
            suite,
            {
              originalCandidateExact: result.originalCandidateExact,
              repairedCandidateExact: result.repairedCandidateExact,
            },
          ]),
        ),
      }),
    );
    return pass ? 0 : 1;
  } catch (error) {
    save(join(directory, "incomplete.json"), {
      status: "INCOMPLETE",
      error: errorInfo(error),
      comparisons,
      instruction: "No retry, kill or gate waiver; inspect retained terminals and complete raw logs.",
    });
    console.error(JSON.stringify({ status: "INCOMPLETE", directory, error: errorInfo(error) }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ status: "ADMISSION_FAILED", error: errorInfo(error) }));
      process.exitCode = 1;
    });
}
