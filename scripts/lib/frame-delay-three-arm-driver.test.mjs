import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractPublicArmSource, addManifestAdmission, parseArguments } from "../verify-frame-delay-three-arm.mjs";
import { ORIGINAL_INSTRUMENTS, sha } from "./frame-delay-three-arm-contract.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// The extractor authenticates the complete source file before extracting its
// public arm; storing just the arm would bypass that original API contract.
const originalBytes = (path) => {
  const bytes = readFileSync(
    new URL("./fixtures/frame-delay-original-instruments/" + path.split("/").at(-1) + ".txt", import.meta.url),
  );
  assert.equal(sha(bytes), ORIGINAL_INSTRUMENTS[path], "immutable historical fixture " + path);
  return bytes;
};
for (const path of [
  "tests/issue-3518-async-frame-body-source-preservation.test.ts",
  "tests/helpers/native-delay-combinator-source-receipts.mjs",
]) {
  test(path + " original body preserved and adapted source parses without execution", () => {
    const bytes = originalBytes(path);
    const body = extractPublicArmSource(bytes, ORIGINAL_INSTRUMENTS[path]);
    const program = addManifestAdmission(body);
    assert.equal(program.source.replace(program.admission, ""), body);
    assert.equal(program.source.split('if (arm === "baseline") {').length, 2);
    assert(
      program.source.indexOf("assertAdmission") < program.source.indexOf('const compiler = await load("src/index.ts")'),
    );
    execFileSync(process.execPath, ["--input-type=module", "--check"], { input: program.source });
  });
  test(path + " current modified instrument is not historical authority", () => {
    const bytes = originalBytes(path);
    assert.doesNotThrow(() => extractPublicArmSource(bytes, ORIGINAL_INSTRUMENTS[path]));
    const current = readFileSync(root + path);
    assert.notEqual(sha(current), ORIGINAL_INSTRUMENTS[path], "control requires the observed current source change");
    assert.throws(
      () => extractPublicArmSource(current, ORIGINAL_INSTRUMENTS[path]),
      /original recorder source hash mismatch/,
    );
  });
  test(path + " changed instrument rejected", () => {
    assert.throws(() =>
      extractPublicArmSource(Buffer.concat([originalBytes(path), Buffer.from("\n")]), ORIGINAL_INSTRUMENTS[path]),
    );
  });
}
test("ambiguous or interpolated recorder rejected", () => {
  for (const source of [
    "",
    "const publicArmSource = String.raw`hello ${world}`;",
    "const publicArmSource = String.raw`one`;\nconst publicArmSource = String.raw`two`;",
  ]) {
    const bytes = Buffer.from(source);
    assert.throws(() => extractPublicArmSource(bytes, sha(bytes)));
  }
});
test("missing or duplicate snapshot anchor rejected", () => {
  for (const body of ["", "const before = snapshot();\nconst before = snapshot();"])
    assert.throws(() => addManifestAdmission(body));
});
test("CLI never executes implicitly", () => {
  assert.throws(() => parseArguments([]));
  assert.throws(() => parseArguments(["--manifest", root + "package.json", "--manifest-sha256", "0".repeat(64)]));
  assert.throws(() => parseArguments(["--execute", "--execute"]));
  assert.throws(() => parseArguments(["--execute", "--unknown"]));
});
