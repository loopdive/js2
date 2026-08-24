import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { setupPinnedUpstreamSuite } from "./setup-pinned-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The source checkout intentionally contains Prettier's development-time
// imports, while this adapter does not install the upstream development tree.
// Install source-compatible host modules into the ignored checkout so the
// original utility tests can resolve the same imports without changing their
// bodies or adding package dependencies to the compiler repository.
function installSourceDependency(root, name, source) {
  const directory = `${root}/node_modules/${name}`;
  if (existsSync(`${directory}/package.json`)) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/package.json`, '{"type":"module","exports":"./index.js"}\n');
  writeFileSync(`${directory}/index.js`, `${source}\n`);
}

function installPrettierSourceDependencies(root) {
  installSourceDependency(
    root,
    "trim-newlines",
    `export function trimNewlinesEnd(value) { return String(value).replace(/(?:\\r\\n|\\n|\\r)+$/, ""); }`,
  );
  installSourceDependency(
    root,
    "escape-string-regexp",
    `export default function escapeStringRegexp(value) { return String(value).replace(/[|\\\\{}()[\\]^$+*?.-]/g, "\\\\$&"); }`,
  );
  installSourceDependency(
    root,
    "emoji-regex",
    `export default function emojiRegex() { return /[\\u{1f000}-\\u{1faff}]/gu; }`,
  );
  installSourceDependency(
    root,
    "get-east-asian-width",
    `const isWideCodePoint = (codePoint) => (codePoint >= 0x1100 && codePoint <= 0x115f) || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || (codePoint >= 0xac00 && codePoint <= 0xd7a3) || (codePoint >= 0xf900 && codePoint <= 0xfaff) || (codePoint >= 0xfe10 && codePoint <= 0xfe6f) || (codePoint >= 0xff00 && codePoint <= 0xff60) || (codePoint >= 0xffe0 && codePoint <= 0xffe6) || (codePoint >= 0x1f300 && codePoint <= 0x1faff); export function _isFullWidth(codePoint) { return isWideCodePoint(codePoint); } export function _isWide(codePoint) { return isWideCodePoint(codePoint); }`,
  );
  installSourceDependency(
    root,
    "url-or-path",
    `import { fileURLToPath } from "node:url"; export function toPath(value) { return value instanceof URL ? fileURLToPath(value) : String(value); } export function isUrl(value) { return value instanceof URL || (typeof value === "string" && /^[a-z][a-z\\d+.-]*:/i.test(value)); } export function isUrlString(value) { return typeof value === "string" && /^[a-z][a-z\\d+.-]*:/i.test(value); }`,
  );
  installSourceDependency(
    root,
    "n-readlines",
    `import { readFileSync } from "node:fs"; export default class Readlines { constructor(file) { this.lines = readFileSync(file, "utf8").split(/\\r?\\n/); this.index = 0; } next() { return this.index < this.lines.length ? Buffer.from(this.lines[this.index++]) : false; } close() {} }`,
  );
}

export function setupPrettierUpstreamSuite(options = {}) {
  const suite = setupPinnedUpstreamSuite({
    here: HERE,
    pinFile: "prettier-upstream-suite-pin.json",
    cacheDirectory: ".npm-upstream-suites/prettier",
    inventoryDirectory: "tests/unit",
    accept: (path) => /^tests\/unit\/[^/]+\.js$/.test(path),
    force: options.force,
  });
  installPrettierSourceDependencies(suite.root);
  return suite;
}
