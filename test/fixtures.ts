import type { NodeOutput } from "../src/index.js";

export function nodeOutput(summary = "Completed task"): NodeOutput {
  return {
    schemaVersion: 1,
    summary,
    changedFiles: [],
    interfaces: [],
    decisions: [],
    validation: [],
    blockers: [],
  };
}
