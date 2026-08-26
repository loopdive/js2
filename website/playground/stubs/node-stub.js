// Empty stub for Node builtins that are not available in the browser.
// Used by Vite to suppress "externalized for browser compatibility" warnings.
export function execFileSync() {
  throw new Error("execFileSync() is not available in browser builds");
}
export function tmpdir() {
  return "/tmp";
}
export default { execFileSync, tmpdir };
