const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readResponseJson(response) {
  const source = await response.text();
  if (!source) {
    return undefined;
  }

  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function anthropicErrorMessage(response, body) {
  const message =
    body?.error?.message ||
    body?.message ||
    response.statusText ||
    "request failed";
  const requestId = body?.request_id || response.headers.get("request-id");
  const requestSuffix = requestId ? ` (request ${requestId})` : "";
  return `${response.status}: ${message}${requestSuffix}`;
}

async function anthropicRequest(pathname, options, request = {}) {
  const endpoint = new URL(pathname, options.baseUrl);
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) {
        endpoint.searchParams.set(key, value);
      }
    }
  }

  const response = await fetch(endpoint, {
    method: request.method || "GET",
    headers: {
      ...(request.body ? { "content-type": "application/json" } : {}),
      "x-api-key": options.apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_MANAGED_AGENTS_BETA,
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const body = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(
      `Anthropic Managed Agents request failed (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Anthropic Managed Agents returned an invalid response");
  }

  return body;
}

async function waitForSession(session, options) {
  const startedAt = Date.now();
  let current = session;

  while (
    current.status === "running" ||
    current.status === "rescheduling"
  ) {
    if (Date.now() - startedAt >= options.timeoutMs) {
      throw new Error(
        `Claude Managed Agent session '${session.id}' did not finish within ${options.timeoutMs}ms`,
      );
    }

    await sleep(options.pollIntervalMs);
    current = await anthropicRequest(
      `/v1/sessions/${encodeURIComponent(session.id)}`,
      options,
    );
  }

  if (current.status === "terminated") {
    throw new Error(
      `Claude Managed Agent session '${session.id}' terminated`,
    );
  }
  if (current.status !== "idle") {
    throw new Error(
      `Claude Managed Agent session '${session.id}' returned unknown status '${current.status}'`,
    );
  }

  return current;
}

async function listSessionEvents(sessionId, options) {
  const events = [];
  const seenPages = new Set();
  let page;

  do {
    const body = await anthropicRequest(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      options,
      {
        query: {
          limit: "100",
          order: "asc",
          page,
        },
      },
    );

    if (!Array.isArray(body.data)) {
      throw new Error(
        `Anthropic returned invalid events for Claude Managed Agent session '${sessionId}'`,
      );
    }
    events.push(...body.data);

    page = body.next_page;
    if (page !== null && page !== undefined && typeof page !== "string") {
      throw new Error(
        `Anthropic returned an invalid events cursor for Claude Managed Agent session '${sessionId}'`,
      );
    }
    if (page && seenPages.has(page)) {
      throw new Error(
        `Anthropic repeated an events cursor for Claude Managed Agent session '${sessionId}'`,
      );
    }
    if (page) {
      seenPages.add(page);
    }
  } while (page);

  return events;
}

function readIdleStopReason(events) {
  return events.findLast(
    (event) => event?.type === "session.status_idle",
  )?.stop_reason;
}

function readAgentResponse(sessionId, events) {
  const stopReason = readIdleStopReason(events)?.type;

  if (stopReason === "requires_action") {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' still requires tool approval`,
    );
  }
  if (stopReason === "retries_exhausted") {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' exhausted its retries`,
    );
  }
  if (stopReason && stopReason !== "end_turn") {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' stopped for unsupported reason '${stopReason}'`,
    );
  }

  const sessionError = events.findLast(
    (event) => event?.type === "session.error",
  );
  if (sessionError) {
    const message =
      sessionError.error?.message ||
      sessionError.message ||
      "unknown session error";
    throw new Error(
      `Claude Managed Agent session '${sessionId}' failed: ${message}`,
    );
  }

  const messages = events
    .filter((event) => event?.type === "agent.message")
    .map((event) =>
      Array.isArray(event.content)
        ? event.content
            .filter((content) => content?.type === "text")
            .map((content) => content.text)
            .join("")
        : "",
    )
    .filter(Boolean);

  if (messages.length === 0) {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' completed without a text response`,
    );
  }

  return messages.join("\n\n");
}

function toolConfirmation(toolUseId, result) {
  const confirmation = {
    type: "user.tool_confirmation",
    tool_use_id: toolUseId,
    result,
  };
  if (result === "deny") {
    confirmation.deny_message = "The user denied this tool call.";
  }
  return confirmation;
}

async function postToolConfirmations(
  sessionId,
  confirmations,
  options,
) {
  await anthropicRequest(
    `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    options,
    {
      method: "POST",
      body: { events: confirmations },
    },
  );
}

async function denyToolCalls(sessionId, eventIds, options) {
  await postToolConfirmations(
    sessionId,
    eventIds.map((eventId) => toolConfirmation(eventId, "deny")),
    options,
  );
}

async function denyThenThrow(
  sessionId,
  eventIds,
  options,
  message,
  cause,
) {
  try {
    if (eventIds.length > 0) {
      await denyToolCalls(sessionId, eventIds, options);
    }
  } catch (denialError) {
    throw new Error(
      `${message}; additionally failed to deny the pending tool call: ${denialError instanceof Error ? denialError.message : String(denialError)}`,
      cause ? { cause } : undefined,
    );
  }

  throw new Error(message, cause ? { cause } : undefined);
}

async function resolveRequiredAction(
  sessionId,
  events,
  stopReason,
  options,
) {
  const referencedEventIds = Array.isArray(stopReason.event_ids)
    ? stopReason.event_ids
    : [];
  const eventIds = [
    ...new Set(
      referencedEventIds.filter(
        (eventId) => typeof eventId === "string" && eventId.length > 0,
      ),
    ),
  ];

  if (referencedEventIds.length === 0) {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' requires action but did not reference a pending tool call`,
    );
  }
  if (eventIds.length !== referencedEventIds.length) {
    await denyThenThrow(
      sessionId,
      eventIds,
      options,
      `Claude Managed Agent session '${sessionId}' referenced invalid or duplicate pending tool calls`,
    );
  }

  const toolUses = eventIds.map((eventId) =>
    events.find((event) => event?.id === eventId),
  );
  const malformedToolUse = toolUses.some((toolUse) => {
    const validInput =
      toolUse?.input !== null &&
      typeof toolUse?.input === "object" &&
      !Array.isArray(toolUse.input);
    return (
      toolUse?.type !== "agent.mcp_tool_use" ||
      typeof toolUse.mcp_server_name !== "string" ||
      toolUse.mcp_server_name.length === 0 ||
      typeof toolUse.name !== "string" ||
      toolUse.name.length === 0 ||
      !validInput
    );
  });
  if (malformedToolUse) {
    await denyThenThrow(
      sessionId,
      eventIds,
      options,
      `Claude Managed Agent session '${sessionId}' requested an unsupported or malformed tool approval`,
    );
  }

  if (typeof options.requestApproval !== "function") {
    await denyThenThrow(
      sessionId,
      eventIds,
      options,
      `Claude Managed Agent session '${sessionId}' requires tool approval, but no approval UI is available`,
    );
  }

  const decisions = [];
  for (const [index, toolUse] of toolUses.entries()) {
    let decision;
    try {
      decision = await options.requestApproval({
        serverName: toolUse.mcp_server_name,
        toolName: toolUse.name,
        argumentKeys: Object.keys(toolUse.input),
        approvalIndex: index + 1,
        approvalCount: toolUses.length,
      });
    } catch (error) {
      await denyThenThrow(
        sessionId,
        eventIds,
        options,
        `Could not request approval for Claude Managed Agent tool '${toolUse.mcp_server_name}/${toolUse.name}'`,
        error,
      );
    }

    if (decision !== "allow" && decision !== "deny") {
      await denyThenThrow(
        sessionId,
        eventIds,
        options,
        `Approval UI returned invalid decision '${String(decision)}' for Claude Managed Agent tool '${toolUse.mcp_server_name}/${toolUse.name}'`,
      );
    }
    decisions.push(decision);
  }

  await postToolConfirmations(
    sessionId,
    eventIds.map((eventId, index) =>
      toolConfirmation(eventId, decisions[index]),
    ),
    options,
  );
}

export async function executeClaudeManagedAgent(prompt, options = {}) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required to call a Claude Managed Agent",
    );
  }

  const adapterOptions = {
    apiKey,
    baseUrl: options.baseUrl || ANTHROPIC_BASE_URL,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const requestBody = {
    agent: options.agentId,
    environment_id: options.environmentId,
    initial_events: [
      {
        type: "user.message",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
  if (options.vaultId) {
    requestBody.vault_ids = [options.vaultId];
  }

  const session = await anthropicRequest("/v1/sessions", adapterOptions, {
    method: "POST",
    body: requestBody,
  });
  if (
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    typeof session.status !== "string"
  ) {
    throw new Error(
      "Anthropic returned an invalid Claude Managed Agent session",
    );
  }

  let current = session;
  while (true) {
    current = await waitForSession(current, adapterOptions);
    const events = await listSessionEvents(session.id, adapterOptions);
    const stopReason = readIdleStopReason(events);

    if (stopReason?.type !== "requires_action") {
      return {
        sessionId: session.id,
        text: readAgentResponse(session.id, events),
      };
    }

    await resolveRequiredAction(
      session.id,
      events,
      stopReason,
      {
        ...adapterOptions,
        requestApproval: options.requestApproval,
      },
    );

    // The confirmation resumes the provider-side session. Force another poll
    // instead of treating the stale idle session response as final.
    current = { id: session.id, status: "running" };
  }
}

export function createClaudeManagedAgentExecutor(options = {}) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required to call a Claude Managed Agent",
    );
  }

  return (prompt, executionContext = {}) =>
    executeClaudeManagedAgent(prompt, {
      ...options,
      apiKey,
      ...executionContext,
    });
}

export const claudeMcpRuntime = {
  name: "claude",
  createExecutor: createClaudeManagedAgentExecutor,
};
