/* Identified allocation-test build only; never linked into shipped Wasm.
 * Inclusion exposes ONLY new producer internals to this isolated fixture.
 * Existing value-release, allocator and context/runtime teardown stay intact.
 */
#ifndef JS2WASM_SCRIPT_PLAN_TEST
#error "Script-plan test hooks require the dedicated test-build definition"
#endif
#include "../qjs_shim.c"

void QJS_EXPORT(qjs_script_plan_test_fail)(int32_t site) {
  JS_ScriptPlanTestSetFailure(site);
}
int32_t QJS_EXPORT(qjs_script_plan_test_nodes)(void) { return qjs_script_plan_live_nodes; }
int32_t QJS_EXPORT(qjs_script_plan_test_buffers)(void) { return qjs_script_plan_live_buffers; }
int32_t QJS_EXPORT(qjs_script_plan_test_plans)(void) { return JS_ScriptPlanTestLivePlans(); }
int32_t QJS_EXPORT(qjs_script_plan_test_atoms)(void) { return JS_ScriptPlanTestLiveAtoms(); }
int32_t QJS_EXPORT(qjs_script_plan_test_arrays)(void) { return JS_ScriptPlanTestLiveArrays(); }
int32_t QJS_EXPORT(qjs_script_plan_test_compiled)(void) { return JS_ScriptPlanTestLiveCompiled(); }
int32_t __attribute__((export_name("qjs_script_plan_test_cells"), used)) qjs_script_plan_test_cell_count(void) { return qjs_script_plan_live_cells; }
void QJS_EXPORT(qjs_script_plan_test_free_value)(JSContext *ctx, qjs_handle handle) {
  size_t index;
  for (index = 0; index < 1024; index++) {
    if (qjs_script_plan_test_cells[index] != (JSValue *)(uintptr_t)handle || !handle) continue;
    qjs_script_plan_test_cells[index] = NULL;
    qjs_script_plan_live_cells--;
    break;
  }
  qjs_free_value(ctx, handle);
}
int32_t QJS_EXPORT(qjs_script_plan_test_state)(JSContext *ctx, uint32_t id) {
  qjs_script_plan_node *node = qjs_script_plan_lookup(ctx, id);
  return node ? (int32_t)node->state : -1;
}
void QJS_EXPORT(qjs_script_plan_test_release_runtime)(JSRuntime *rt) {
  /* This is the nonempty backstop observation, separate from normal teardown.
   * Owning contexts remain live until AFTER all private resources are released. */
  qjs_script_plans_release_runtime(rt);
}
