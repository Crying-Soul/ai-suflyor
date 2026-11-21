import type { CallsTree } from "./protocol";

/** Folders with the most recent call first (call directory names start with the date); folders without calls last. */
export function recentFolders(tree: CallsTree, n: number): CallsTree["folders"] {
  const last = (f: CallsTree["folders"][number]) => f.calls[0]?.dir.split(/[\\/]/).pop() ?? "";
  return [...tree.folders].sort((a, b) => last(b).localeCompare(last(a))).slice(0, n);
}
