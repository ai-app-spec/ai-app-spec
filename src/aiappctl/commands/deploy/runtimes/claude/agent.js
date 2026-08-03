const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

function anthropicHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_API_VERSION,
    "anthropic-beta": ANTHROPIC_MANAGED_AGENTS_BETA,
  };
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

async function retrieveClaudeAgent(agentId, resourceId, options) {
  const response = await fetch(
    new URL(`/v1/agents/${encodeURIComponent(agentId)}`, options.baseUrl),
    {
      method: "GET",
      headers: anthropicHeaders(options.apiKey),
    },
  );
  const body = await readResponseJson(response);

  if (response.status === 404) {
    throw new Error(`Anthropic Agent '${agentId}' does not exist`);
  }
  if (!response.ok) {
    throw new Error(
      `Anthropic failed to retrieve Agent '${agentId}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (
    !body ||
    body.id !== agentId ||
    !Number.isInteger(body.version) ||
    body.version < 1
  ) {
    throw new Error(
      `Anthropic returned an invalid Agent for resource '${resourceId}'`,
    );
  }
  if (body.archived_at) {
    throw new Error(`Anthropic Agent '${agentId}' is archived`);
  }

  return body;
}

async function createClaudeAgent(deployment, options) {
  const response = await fetch(new URL("/v1/agents", options.baseUrl), {
    method: "POST",
    headers: anthropicHeaders(options.apiKey),
    body: JSON.stringify(deployment.payload),
  });
  const body = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(
      `Anthropic failed to create resource '${deployment.resource.id}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || typeof body.id !== "string" || body.id.length === 0) {
    throw new Error(
      `Anthropic returned an invalid create response for resource '${deployment.resource.id}'`,
    );
  }

  return { providerResource: body, operation: "created" };
}

async function updateClaudeAgent(deployment, agent, options) {
  const response = await fetch(
    new URL(`/v1/agents/${encodeURIComponent(agent.id)}`, options.baseUrl),
    {
      method: "POST",
      headers: anthropicHeaders(options.apiKey),
      body: JSON.stringify({
        ...deployment.payload,
        version: agent.version,
      }),
    },
  );
  const body = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(
      `Anthropic failed to update resource '${deployment.resource.id}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || body.id !== agent.id) {
    throw new Error(
      `Anthropic returned an invalid update response for resource '${deployment.resource.id}'`,
    );
  }

  return { providerResource: body, operation: "updated" };
}

export async function deployClaudeAgent(deployment, options) {
  if (!options.agentId) {
    return createClaudeAgent(deployment, options);
  }

  const agent = await retrieveClaudeAgent(
    options.agentId,
    deployment.resource.id,
    options,
  );
  return updateClaudeAgent(deployment, agent, options);
}
