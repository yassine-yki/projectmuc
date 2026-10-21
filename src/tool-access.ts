export type ToolId = "rooms" | "equipment";
export type ToolAccess = { role: "admin" | "worker" | "viewer"; allowedTools?: string[] };

// Missing permissions in an older offline snapshot must never reveal a new tool.
export function canOpenTool(access: ToolAccess | null | undefined, tool: ToolId): boolean {
  if (!access) return false;
  if (access.role === "admin") return true;
  return tool === "rooms" || Boolean(access.allowedTools?.includes(tool));
}

export function availableTools(access: ToolAccess | null | undefined): ToolId[] {
  return (["rooms", "equipment"] as ToolId[]).filter(tool => canOpenTool(access, tool));
}
