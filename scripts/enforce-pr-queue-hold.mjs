export async function enforceQueueHold(graphql, id) {
  const fail = (message) => {
    throw new Error(message);
  };
  if (typeof id !== "string" || id.length === 0) fail("missing pull-request node ID");
  const readQuery = `query CurrentQueueHold($id: ID!) {
    node(id: $id) { ... on PullRequest {
      id state isDraft
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
      mergeQueueEntry { id }
      autoMergeRequest { enabledAt }
    } }
  }`;
  const read = async () => {
    const response = await graphql(readQuery, { id });
    if (
      !response ||
      typeof response !== "object" ||
      ("errors" in response && (!Array.isArray(response.errors) || response.errors.length > 0))
    )
      fail("unknown current pull-request response");
    const pr = response.node;
    if (!pr || pr.id !== id || !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.isDraft !== "boolean")
      fail("incomplete current pull-request identity");
    if (
      !pr.labels ||
      !Array.isArray(pr.labels.nodes) ||
      pr.labels.pageInfo?.hasNextPage !== false ||
      !pr.labels.nodes.every((label) => label && typeof label.name === "string")
    )
      fail("unknown or incomplete current labels");
    for (const field of ["mergeQueueEntry", "autoMergeRequest"]) {
      if (!Object.prototype.hasOwnProperty.call(pr, field)) fail("missing " + field);
      const value = pr[field];
      const key = field === "mergeQueueEntry" ? "id" : "enabledAt";
      if (value !== null && (!value || typeof value[key] !== "string" || value[key].length === 0))
        fail("unknown " + field);
    }
    return pr;
  };
  const mutate = async (query, payload) => {
    const response = await graphql(query, { id });
    if (
      !response ||
      typeof response !== "object" ||
      ("errors" in response && (!Array.isArray(response.errors) || response.errors.length > 0)) ||
      !response[payload] ||
      !Object.prototype.hasOwnProperty.call(response[payload], "clientMutationId")
    )
      fail("unproven " + payload);
  };
  const before = await read();
  if (before.state !== "OPEN") return "closed";
  const holdLabels = new Set(["hold", "do-not-merge", "do not merge", "wip", "blocked", "stack-retarget-pending"]);
  const blocked = before.isDraft || before.labels.nodes.some((label) => holdLabels.has(label.name.toLowerCase()));
  if (!blocked) return "ready";
  // Disarm first so the native readiness watcher cannot immediately re-enqueue.
  if (before.autoMergeRequest !== null) {
    await mutate(
      `mutation DisarmHeldPullRequest($id: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }
    }`,
      "disablePullRequestAutoMerge",
    );
  }
  // Dequeue takes the PULL REQUEST ID, not the merge-queue entry ID.
  if (before.mergeQueueEntry !== null) {
    await mutate(
      `mutation DequeueHeldPullRequest($id: ID!) {
      dequeuePullRequest(input: {id: $id}) { clientMutationId }
    }`,
      "dequeuePullRequest",
    );
  }
  const after = await read();
  if (after.state !== "OPEN" || after.autoMergeRequest !== null || after.mergeQueueEntry !== null)
    fail("hold/draft enforcement not confirmed by fresh readback");
  return "blocked";
}
