import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const baseline = "9222d9a0342ea2828d3448e3d8828c5b329c293c";
const path = ".github/workflows/ci.yml";
const append = "tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts";
const parent = "scripts/hooks/run-linear-append-provenance.mjs";
const old = spawnSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" });
assert.equal(old.status, 0, old.stderr);
const current = readFileSync(path, "utf8");

function split(text) {
  const marker = "      - name: Run changed issue test file (advisory)\n";
  const next = "      - name: Report changed issue-test outcome\n";
  assert.equal(text.split(marker).length, 2, "exactly one advisory step");
  const begin = text.indexOf(marker);
  const end = text.indexOf(next, begin);
  assert.ok(end > begin, "following outcome step remains present");
  const run = text.indexOf("        run: |\n", begin);
  assert.ok(run > begin && run < end, "literal run body stays in named step");
  const start = run + "        run: |\n".length;
  let finish = end;
  while (text[finish - 1] === "\n") finish--;
  finish++;
  const raw = text.slice(start, finish);
  const lines = raw.trimEnd().split("\n");
  assert.ok(
    lines.every((line) => line.startsWith("          ")),
    "body indentation",
  );
  return {
    before: text.slice(0, start),
    raw,
    after: text.slice(finish),
    shell: lines.map((line) => line.slice(10)).join("\n") + "\n",
  };
}

const before = split(old.stdout);
const after = split(current);
assert.equal(after.before, before.before, "all bytes before released body unchanged");
assert.equal(after.after, before.after, "all bytes after released body unchanged");
const oldCommand = before.shell.slice(before.shell.indexOf("pnpm exec"));
const elseCommand = after.shell.slice(after.shell.indexOf("else\n") + 5, after.shell.lastIndexOf("fi\n"));
assert.equal(elseCommand.replace(/^  /gm, ""), oldCommand, "original else command bytes");
assert.equal(spawnSync("bash", ["-n"], { input: after.shell }).status, 0, "shell syntax");
assert.equal(
  createHash("sha256").update(readFileSync(parent)).digest("hex"),
  "3a154510e5f1280cb7dc71f2a89bae77386ba109990fecb71d586531d9c75e54",
  "production parent is unchanged",
);

// Shell functions record dispatch only. They do not execute or qualify the
// production parent, compiler, test population, identity or evidence receipt.
const recorder = `
node() { printf '%s\\0' node "$@"; return "$NODE_STATUS"; }
pnpm() { printf '%s\\0' pnpm "$@"; return "$PNPM_STATUS"; }
`;
function run(shell, file, nodeStatus = 0, pnpmStatus = 0) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", recorder + shell], {
    env: { ...process.env, ISSUE_TEST_FILE: file, NODE_STATUS: String(nodeStatus), PNPM_STATUS: String(pnpmStatus) },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return { status: result.status, calls: result.stdout.split("\0").slice(0, -1) };
}
const vitest = (file) => [
  "pnpm",
  "exec",
  "vitest",
  "run",
  file,
  "--pool=forks",
  "--poolOptions.forks.singleFork=false",
  "--poolOptions.forks.maxForks=1",
  "--no-file-parallelism",
];
assert.deepEqual(
  run(before.shell, append),
  { status: 0, calls: vitest(append) },
  "baseline sees the old direct caller",
);
const cases = [
  { file: append, nodeStatus: 0, pnpmStatus: 0, status: 0, calls: ["node", parent] },
  { file: append, nodeStatus: 17, pnpmStatus: 0, status: 17, calls: ["node", parent] },
  { file: "tests/issue-3471.test.ts", nodeStatus: 0, pnpmStatus: 0, status: 0 },
  { file: "tests/issue-3471.test.ts", nodeStatus: 0, pnpmStatus: 23, status: 23 },
  { file: append + ".bak", nodeStatus: 0, pnpmStatus: 0, status: 0 },
  { file: "./" + append, nodeStatus: 0, pnpmStatus: 0, status: 0 },
  { file: "", nodeStatus: 0, pnpmStatus: 0, status: 0 },
  { file: "tests/other file; echo unexpected.test.ts", nodeStatus: 0, pnpmStatus: 0, status: 0 },
];
for (const item of cases) {
  assert.deepEqual(
    run(after.shell, item.file, item.nodeStatus, item.pnpmStatus),
    {
      status: item.status,
      calls: item.calls ?? vitest(item.file),
    },
    `single dispatch and exact exit for ${JSON.stringify(item.file)}`,
  );
}
console.log(
  JSON.stringify(
    {
      baseline,
      workflowSha256: createHash("sha256").update(current).digest("hex"),
      outsideBodyUnchanged: true,
      originalElseCommandUnchanged: true,
      baselinePositiveControls: 1,
      candidateDispatchControls: cases.length,
      limitation:
        "Isolated shell dispatch only; no production qualification, all-event compatibility, CI graph equality or native completion.",
    },
    null,
    2,
  ),
);
