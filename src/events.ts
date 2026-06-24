export type CompactJobEvent =
  | { type: "app_server.error"; at: string; requestId: string | number | null; code: number | null; message: string | null; data: unknown; params: unknown; threadId: string | null; turnId: string | null }
  | { type: "approval.requested"; at: string; approvalId: string; method: string; threadId: string | null; turnId: string | null }
  | { type: "agent_message.completed"; at: string; itemId: string | null; phase: string | null; text: string; threadId: string | null; turnId: string | null }
  | { type: "command.completed"; at: string; itemId: string | null; command: string | null; status: string | null; exitCode: number | null; durationMs: number | null; threadId: string | null; turnId: string | null }
  | { type: "command.started"; at: string; itemId: string | null; command: string | null; cwd: string | null; status: string | null; threadId: string | null; turnId: string | null }
  | { type: "control.queued"; at: string; commandId: string | null; commandType: string | null }
  | { type: "mcp.failed"; at: string; name: string | null; error: string | null; threadId: string | null; turnId: string | null }
  | { type: "thread.started"; at: string; threadId: string | null }
  | { type: "turn.completed"; at: string; threadId: string | null; turnId: string | null; status: string | null; error: string | null }
  | { type: "turn.started"; at: string; threadId: string | null; turnId: string | null }
  | { type: "warning"; at: string; message: string | null; threadId: string | null; turnId: string | null }
  | { type: "worker.event"; at: string; eventType: string | null; event: Record<string, unknown> };

export function compactJobEvent(raw: unknown): CompactJobEvent[] {
  if (!isObject(raw)) return [];
  const at = stringField(raw, "at") ?? new Date(0).toISOString();
  const direction = stringField(raw, "direction");

  if (direction === "worker" && isObject(raw.event)) {
    return [{
      type: "worker.event",
      at,
      eventType: stringField(raw.event, "type"),
      event: raw.event,
    }];
  }

  if (direction === "control" && isObject(raw.command)) {
    return [{
      type: "control.queued",
      at,
      commandId: stringField(raw.command, "id"),
      commandType: stringField(raw.command, "type"),
    }];
  }

  if (direction !== "server" || !isObject(raw.message)) return [];
  if (isObject(raw.message.error)) {
    return [{
      type: "app_server.error",
      at,
      requestId: typeof raw.message.id === "string" || typeof raw.message.id === "number" ? raw.message.id : null,
      code: numberField(raw.message.error, "code"),
      message: stringField(raw.message.error, "message"),
      data: raw.message.error.data ?? null,
      params: null,
      threadId: null,
      turnId: null,
    }];
  }
  const method = stringField(raw.message, "method");
  if (!method) return [];
  const params = raw.message.params;

  if (method === "error") {
    return [{
      type: "app_server.error",
      at,
      requestId: typeof raw.message.id === "string" || typeof raw.message.id === "number" ? raw.message.id : null,
      code: null,
      message: getNestedString(params, ["message"]) ?? getNestedString(params, ["error", "message"]),
      data: null,
      params: params ?? null,
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if ("id" in raw.message && isApprovalRequest(method)) {
    return [{
      type: "approval.requested",
      at,
      approvalId: String(raw.message.id),
      method,
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if (method === "thread/started") {
    return [{
      type: "thread.started",
      at,
      threadId: getNestedString(params, ["thread", "id"]),
    }];
  }

  if (method === "turn/started") {
    return [{
      type: "turn.started",
      at,
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if (method === "turn/completed") {
    return [{
      type: "turn.completed",
      at,
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
      status: getNestedString(params, ["turn", "status"]),
      error: getNestedString(params, ["turn", "error", "message"]),
    }];
  }

  if (method === "warning") {
    return [{
      type: "warning",
      at,
      message: getNestedString(params, ["message"]),
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if (method === "mcpServer/startupStatus/updated" && getNestedString(params, ["status"]) === "failed") {
    return [{
      type: "mcp.failed",
      at,
      name: getNestedString(params, ["name"]),
      error: getNestedString(params, ["error"]),
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if (method === "item/started") {
    const item = getNestedObject(params, ["item"]);
    if (stringField(item, "type") !== "commandExecution") return [];
    return [{
      type: "command.started",
      at,
      itemId: stringField(item, "id"),
      command: stringField(item, "command"),
      cwd: stringField(item, "cwd"),
      status: stringField(item, "status"),
      threadId: threadIdFromParams(params),
      turnId: turnIdFromParams(params),
    }];
  }

  if (method === "item/completed") {
    const item = getNestedObject(params, ["item"]);
    const itemType = stringField(item, "type");
    if (itemType === "agentMessage") {
      return [{
        type: "agent_message.completed",
        at,
        itemId: stringField(item, "id"),
        phase: stringField(item, "phase"),
        text: stringField(item, "text") ?? "",
        threadId: threadIdFromParams(params),
        turnId: turnIdFromParams(params),
      }];
    }
    if (itemType === "commandExecution") {
      return [{
        type: "command.completed",
        at,
        itemId: stringField(item, "id"),
        command: stringField(item, "command"),
        status: stringField(item, "status"),
        exitCode: numberField(item, "exitCode"),
        durationMs: numberField(item, "durationMs"),
        threadId: threadIdFromParams(params),
        turnId: turnIdFromParams(params),
      }];
    }
  }

  return [];
}

function threadIdFromParams(params: unknown): string | null {
  return getNestedString(params, ["threadId"]) ?? getNestedString(params, ["thread", "id"]);
}

function turnIdFromParams(params: unknown): string | null {
  return getNestedString(params, ["turnId"]) ?? getNestedString(params, ["turn", "id"]);
}

function getNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function getNestedObject(value: unknown, path: string[]): Record<string, unknown> | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function stringField(value: unknown, key: string): string | null {
  return isObject(value) && typeof value[key] === "string" ? value[key] : null;
}

function numberField(value: unknown, key: string): number | null {
  return isObject(value) && typeof value[key] === "number" ? value[key] : null;
}

function isApprovalRequest(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
    || method === "execCommandApproval"
    || method === "applyPatchApproval";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
