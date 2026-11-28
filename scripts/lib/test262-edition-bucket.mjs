// The one definition of how a test262 result row counts in a per-edition row
// (pass / fail / ce / skip): scripts/generate-editions.ts builds every edition
// row with it, and the site's edition-only IR rows (#7616) are counted with it
// so they read the same as the full run's.

/**
 * (#2914) A row's edition bucket, honouring the host-free (standalone)
 * definition of "pass".
 *
 * In host-free mode a raw `status === "pass"` that still leaked a JS host
 * runtime import (`host_import_leak_class` set) is NOT a standalone pass — it
 * only "passed" by pulling an `env::__*` import. This mirrors
 * `build-test262-report.mjs` (`hostFreePass = status === "pass" &&
 * !record.host_import_leak_class`) and `check-standalone-highwater.mjs`
 * (`full_summary.host_free_pass`), so the per-edition slider, the donut
 * headline (#2879) and the absolute floor (#2097) all share ONE definition of a
 * standalone pass. A leaky pass is demoted to `fail` (kept in `total`, dropped
 * from `pass`) — exactly how the donut counts it: in the denominator, out of
 * `host_free_pass`. The default (host / `gc`) mode counts a raw `pass`: host
 * imports are expected there.
 *
 * @param {{ status: string, host_import_leak_class?: string }} record
 * @param {boolean} hostFree
 * @returns {"pass" | "fail" | "ce" | "skip"}
 */
export function editionBucket(record, hostFree) {
  const status = record.status;
  if (status === "pass") return hostFree && record.host_import_leak_class ? "fail" : "pass";
  if (status === "skip") return "skip";
  if (status === "compile_error" || status === "compile_timeout" || status === "ce") return "ce";
  return "fail";
}
