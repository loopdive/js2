// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface DirectedGraphCondensation<T> {
  /** Strongly-connected components in Tarjan completion order. */
  components: T[][];
  /** Component index for every root and transitively reachable node. */
  componentByNode: Map<T, number>;
  /** Deduplicated edges between distinct components. */
  successorsByComponent: Set<number>[];
  /** Reverse of `successorsByComponent`. */
  predecessorsByComponent: Set<number>[];
}

interface SearchFrame<T> {
  node: T;
  successors: readonly T[];
  nextSuccessor: number;
}

/**
 * Collapse a directed graph into strongly-connected components without using
 * the JavaScript call stack. Adjacency is snapshotted once per reached node so
 * both the SCC walk and the condensed edges observe the same immutable graph.
 */
export function condenseDirectedGraph<T>(
  roots: Iterable<T>,
  successorsOf: (node: T) => Iterable<T>,
): DirectedGraphCondensation<T> {
  const indexByNode = new Map<T, number>();
  const lowLinkByNode = new Map<T, number>();
  const adjacencyByNode = new Map<T, readonly T[]>();
  const componentStack: T[] = [];
  const onComponentStack = new Set<T>();
  const components: T[][] = [];
  let nextIndex = 0;

  const searchStack: SearchFrame<T>[] = [];
  const discover = (node: T): void => {
    const index = nextIndex++;
    indexByNode.set(node, index);
    lowLinkByNode.set(node, index);
    componentStack.push(node);
    onComponentStack.add(node);
    const successors = [...successorsOf(node)];
    adjacencyByNode.set(node, successors);
    searchStack.push({ node, successors, nextSuccessor: 0 });
  };

  for (const root of roots) {
    if (indexByNode.has(root)) continue;
    discover(root);

    while (searchStack.length > 0) {
      const frame = searchStack[searchStack.length - 1]!;
      if (frame.nextSuccessor < frame.successors.length) {
        const successor = frame.successors[frame.nextSuccessor++]!;
        if (!indexByNode.has(successor)) {
          discover(successor);
        } else if (onComponentStack.has(successor)) {
          lowLinkByNode.set(frame.node, Math.min(lowLinkByNode.get(frame.node)!, indexByNode.get(successor)!));
        }
        continue;
      }

      searchStack.pop();
      if (lowLinkByNode.get(frame.node) === indexByNode.get(frame.node)) {
        const component: T[] = [];
        while (componentStack.length > 0) {
          const member = componentStack.pop()!;
          onComponentStack.delete(member);
          component.push(member);
          if (indexByNode.get(member) === indexByNode.get(frame.node)) break;
        }
        components.push(component);
      }

      const parent = searchStack[searchStack.length - 1];
      if (parent) {
        lowLinkByNode.set(parent.node, Math.min(lowLinkByNode.get(parent.node)!, lowLinkByNode.get(frame.node)!));
      }
    }
  }

  const componentByNode = new Map<T, number>();
  for (let componentIdx = 0; componentIdx < components.length; componentIdx++) {
    for (const node of components[componentIdx]!) componentByNode.set(node, componentIdx);
  }

  const successorsByComponent = components.map(() => new Set<number>());
  const predecessorsByComponent = components.map(() => new Set<number>());
  for (const [node, successors] of adjacencyByNode) {
    const from = componentByNode.get(node)!;
    for (const successor of successors) {
      const to = componentByNode.get(successor)!;
      if (from === to || successorsByComponent[from]!.has(to)) continue;
      successorsByComponent[from]!.add(to);
      predecessorsByComponent[to]!.add(from);
    }
  }

  return { components, componentByNode, successorsByComponent, predecessorsByComponent };
}
