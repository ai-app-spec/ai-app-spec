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

function readAgentResponse(sessionId, events) {
  const idleEvent = events.findLast(
    (event) => event?.type === "session.status_idle",
  );
  const stopReason = idleEvent?.stop_reason?.type;

  if (stopReason === "requires_action") {
    throw new Error(
      `Claude Managed Agent session '${sessionId}' requires tool approval; this MVP only supports sessions that complete without client-side action`,
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

  await waitForSession(session, adapterOptions);
  const events = await listSessionEvents(session.id, adapterOptions);

  return {
    sessionId: session.id,
    text: readAgentResponse(session.id, events),
  };
}

export function createClaudeManagedAgentExecutor(options = {}) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required to call a Claude Managed Agent",
    );
  }

  return (prompt) =>
    executeClaudeManagedAgent(prompt, {
      ...options,
      apiKey,
    });
}

export const claudeMcpRuntime = {
  name: "claude",
  createExecutor: createClaudeManagedAgentExecutor,
};
