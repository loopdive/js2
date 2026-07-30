import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

export function loadPinnedPackagePin(here, pinFile) {
  return JSON.parse(readFileSync(join(here, pinFile), "utf-8"));
}

export function setupPinnedPackage({ here, name, pinFile, extractionDirectory, force = false }) {
  const pin = loadPinnedPackagePin(here, pinFile);
  const tarballPath = resolve(here, pin.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(`[dogfood] pinned ${name} tarball missing at ${tarballPath}`);
  }

  const actualSha1 = sha1(readFileSync(tarballPath));
  if (actualSha1 !== pin.shasum) {
    throw new Error(
      `[dogfood] ${name} tarball integrity mismatch.\n` +
        `  expected sha1 ${pin.shasum}\n` +
        `  got      sha1 ${actualSha1}`,
    );
  }

  const root = join(here, extractionDirectory);
  const entryModulePath = join(root, pin.entryModule);
  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (!existsSync(entryModulePath)) {
    mkdirSync(root, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", root], { stdio: "pipe" });
  }
  if (!existsSync(entryModulePath)) {
    throw new Error(`[dogfood] extraction did not produce ${pin.entryModule} under ${root}`);
  }

  return { root, entryModulePath, version: pin.version, pin };
}
