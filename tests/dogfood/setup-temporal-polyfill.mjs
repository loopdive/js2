// Deterministic @js-temporal/polyfill acquisition for the #4628 spike harness.
//
// Mirrors setup-clsx.mjs (#3748) / setup-acorn.mjs (#1710): verify the
// committed tarballs against their canonical npm sha1, extract once into a
// gitignored directory next to this file, and hand back absolute paths.
//
// Two tarballs, not one: the polyfill's published ESM bundle
// (dist/index.esm.js) is NOT self-contained — it carries exactly one import,
// `import e from"jsbi";`, against its single runtime dependency. See
// temporal-polyfill-pin.json's `_note` for why concatenating jsbi ahead of it
// is collision-free (jsbi.mjs declares one top-level binding, `JSBI`; the
// polyfill's 340 top-level bindings do not include it).

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @returns {any} */
export function loadPin() {
  return JSON.parse(readFileSync(join(HERE, "temporal-polyfill-pin.json"), "utf-8"));
}

function sha1(buf) {
  return createHash("sha1").update(buf).digest("hex");
}

function verifyTarball(spec) {
  const tarballPath = resolve(HERE, spec.tarball);
  if (!existsSync(tarballPath)) {
    throw new Error(
      `[dogfood] pinned ${spec.name} tarball missing at ${tarballPath} — it must be committed ` +
        `(see temporal-polyfill-pin.json).`,
    );
  }

  // Integrity gate: refuse to run against an unverified source.
  const got = sha1(readFileSync(tarballPath));
  if (got !== spec.shasum) {
    throw new Error(
      `[dogfood] ${spec.name} tarball integrity mismatch.\n` +
        `  expected sha1 ${spec.shasum} (canonical npm dist.shasum for ${spec.name}@${spec.version})\n` +
        `  got      sha1 ${got}\n` +
        `Refuse to run with an unverified source.`,
    );
  }

  return tarballPath;
}

/**
 * Publish both verified packages as one complete, immutable generation.
 * Existing legacy .temporal-polyfill contents are neither read nor removed.
 * force creates a fresh generation; it never invalidates paths held by readers.
 *
 * @param {{force?: boolean}} [opts]
 */
export function setupTemporalPolyfill(opts = {}) {
  const pin = loadPin();
  // Recheck integrity even on a generation hit, before trusting either pin.
  const polyfillTarball = verifyTarball(pin);
  const jsbiTarball = verifyTarball(pin.dependency);
  const key = createHash("sha256")
    .update(JSON.stringify({ schema: "temporal-extraction-link-v1", pin }))
    .digest("hex");
  const generations = join(HERE, ".temporal-polyfill", "generations");
  mkdirSync(generations, { recursive: true });
  const root = join(generations, opts.force ? `${key}-fresh-${randomUUID()}` : key);
  if (existsSync(root)) return validateGeneration(root, pin);

  const staging = mkdtempSync(join(generations, ".staging-"));
  try {
    execFileSync("tar", ["-xzf", polyfillTarball, "-C", staging], { stdio: "pipe" });
    const jsbiRoot = join(staging, "jsbi");
    mkdirSync(jsbiRoot);
    execFileSync("tar", ["-xzf", jsbiTarball, "-C", jsbiRoot], { stdio: "pipe" });
    validateGeneration(staging, pin);
    try {
      renameSync(staging, root);
    } catch (error) {
      // A complete non-empty winner cannot be replaced by rename. Accept
      // only that race, never permission errors or an incomplete destination.
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      return validateGeneration(root, pin);
    }
    return validateGeneration(root, pin);
  } finally {
    // This invocation owns this unique staging path, not any published root.
    rmSync(staging, { recursive: true, force: true });
  }
}

function validateGeneration(root, pin) {
  const paths = {
    root,
    entryModulePath: join(root, pin.entryModule),
    umdModulePath: join(root, pin.umdModule),
    jsbiEntryPath: join(root, "jsbi", pin.dependency.entryModule),
    version: pin.version,
    pin,
  };
  if (readFileSync(paths.umdModulePath).length === 0) throw new Error("[dogfood] empty Temporal UMD bundle");
  linkPolyfillSource(paths);
  return paths;
}

const SOURCE_MAP_COMMENT = /^\/\/# sourceMappingURL=.*$/gm;
const JSBI_DEFAULT_EXPORT = "export default JSBI;";
const POLYFILL_IMPORT = 'import e from"jsbi";';

/**
 * Link jsbi + the polyfill's published ESM bundle into ONE module source.
 *
 * The only edits to published bytes: drop jsbi's `export default JSBI;`,
 * rewrite the polyfill's single import to a local binding, strip the
 * sourceMappingURL trailers. Both edits are asserted, so an upstream version
 * bump that changes the bundle shape fails loudly instead of silently
 * measuring something else.
 *
 * @returns {{source: string, jsbiBytes: number, polyfillBytes: number}}
 */
export function linkPolyfillSource({ entryModulePath, jsbiEntryPath }) {
  const jsbiRaw = readFileSync(jsbiEntryPath, "utf-8");
  const polyRaw = readFileSync(entryModulePath, "utf-8");

  if (!jsbiRaw.includes(JSBI_DEFAULT_EXPORT)) {
    throw new Error(`[dogfood] jsbi bundle no longer ends with \`${JSBI_DEFAULT_EXPORT}\` — refresh the link step.`);
  }
  if (!polyRaw.includes(POLYFILL_IMPORT)) {
    throw new Error(`[dogfood] polyfill bundle no longer starts with \`${POLYFILL_IMPORT}\` — refresh the link step.`);
  }

  const jsbi = jsbiRaw.replace(JSBI_DEFAULT_EXPORT, "").replace(SOURCE_MAP_COMMENT, "");
  const poly = polyRaw.replace(POLYFILL_IMPORT, "const e=JSBI;").replace(SOURCE_MAP_COMMENT, "");

  return {
    source: `${jsbi}\n${poly}\n`,
    jsbiBytes: jsbiRaw.length,
    polyfillBytes: polyRaw.length,
  };
}

/** The UMD bundle needs no link step — jsbi is bundled in. */
export function readUmdSource({ umdModulePath }) {
  return readFileSync(umdModulePath, "utf-8").replace(SOURCE_MAP_COMMENT, "");
}
