import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "./toolOutput.ts";

export const DEFERRED_WORK_ITEM_LIMIT = 75;

const DEFERRED_WORK_ITEM_TYPES = [
  "command_execution",
  "reasoning",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
] as const;

export function isDeferrableWorkItem(
  item: Pick<OrchestrationV2TurnItem, "type" | "status"> & {
    readonly persistentOutput?: boolean;
    readonly toolName?: string | null;
    readonly output?: unknown;
    readonly viewedImagePath?: string;
  },
): boolean {
  if (item.status !== "completed" || item.persistentOutput === true) return false;
  if (item.type === "dynamic_tool") {
    const tool = { toolName: item.toolName, output: item.output };
    if (
      item.viewedImagePath !== undefined ||
      htmlRenderFromToolItem(tool) !== undefined ||
      mcpAppFromToolItem(tool) !== undefined
    )
      return false;
  }
  return DEFERRED_WORK_ITEM_TYPES.some((type) => type === item.type);
}
