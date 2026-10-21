import assert from "node:assert/strict";
import test from "node:test";
import { availableTools, canOpenTool } from "../src/tool-access.js";

test("a member with only room access cannot open equipment or an unknown future tool", () => {
  const limited = {role: "worker" as const, allowedTools: ["rooms"]};
  assert.deepEqual(availableTools(limited), ["rooms"]);
  assert.equal(canOpenTool(limited, "equipment"), false);
  assert.equal(canOpenTool({role: "worker"}, "equipment"), false);
  assert.deepEqual(availableTools({role: "admin"}), ["rooms", "equipment"]);
});
