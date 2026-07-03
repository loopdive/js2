import os from "node:os";
import path from "node:path";

export function get(obj, key, fallback = undefined) {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur;
}

export function asArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === "") return fallback;
  return [String(value)];
}

export function normalizeState(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

export function resolveEnvValue(value, fallback = "") {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return process.env[value.slice(1)] ?? fallback;
  }
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? "");
}

/**
 * Resolves a config path against `base` (the consuming project's root, not
 * this package's own install location) — callers must pass `base` explicitly.
 */
export function expandPath(value, base) {
  let v = String(resolveEnvValue(value, "") || "");
  if (!v) return "";
  if (v.startsWith("~/")) v = path.join(os.homedir(), v.slice(2));
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(base, v);
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function sanitizeKey(s) {
  return String(s || "issue")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
