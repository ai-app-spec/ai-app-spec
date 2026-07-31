import { createHash } from "node:crypto";

const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ANTHROPIC_MAX_METADATA_ENTRIES = 16;
const INSTALLATION_METADATA_KEY = "ai_app_spec_installation";
const RESOURCE_METADATA_KEY = "ai_app_spec_resource";
const FINGERPRINT_METADATA_KEY = "ai_app_spec_fingerprint";
const RESERVED_METADATA_KEYS = new Set([
  INSTALLATION_METADATA_KEY,
  RESOURCE_METADATA_KEY,
  FINGERPRINT_METADATA_KEY,
]);

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

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function configurationFingerprint(payload) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex");
}

function installationMetadata(payload, installationId, resourceId) {
  const metadata = payload.metadata ?? {};
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      `resource '${resourceId}': implementation package field 'metadata' must be a mapping`,
    );
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new Error(
        `resource '${resourceId}': implementation package metadata key '${key}' is reserved by aiappctl`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `resource '${resourceId}': implementation package metadata value for '${key}' must be a string`,
      );
    }
  }

  if (
    Object.keys(metadata).length + RESERVED_METADATA_KEYS.size >
    ANTHROPIC_MAX_METADATA_ENTRIES
  ) {
    throw new Error(
      `resource '${resourceId}': implementation package metadata leaves no room for aiappctl installation metadata`,
    );
  }

  return {
    ...metadata,
    [INSTALLATION_METADATA_KEY]: installationId,
    [RESOURCE_METADATA_KEY]: resourceId,
    [FINGERPRINT_METADATA_KEY]: configurationFingerprint(payload),
  };
}

export function prepareClaudeAgentInstallations(deployments, installationId) {
  return deployments.map((deployment) => ({
    ...deployment,
    payload: {
      ...deployment.payload,
      metadata: installationMetadata(
        deployment.payload,
        installationId,
        deployment.resource.id,
      ),
    },
  }));
}

async function listClaudeAgents(options) {
  const agents = [];
  let page;

  do {
    const endpoint = new URL("/v1/agents", options.baseUrl);
    endpoint.searchParams.set("limit", "100");
    if (page) {
      endpoint.searchParams.set("page", page);
    }

    const response = await fetch(endpoint, {
      method: "GET",
      headers: anthropicHeaders(options.apiKey),
    });
    const body = await readResponseJson(response);
    if (!response.ok) {
      throw new Error(
        `Anthropic failed to list Agents (${anthropicErrorMessage(response, body)})`,
      );
    }
    if (!body || !Array.isArray(body.data)) {
      throw new Error("Anthropic returned an invalid Agent list response");
    }

    agents.push(...body.data);
    page = body.next_page || undefined;
  } while (page);

  return agents;
}

function validateClaudeAgent(agent, resourceId, expectedAgentId) {
  if (
    !agent ||
    typeof agent.id !== "string" ||
    agent.id.length === 0 ||
    (expectedAgentId && agent.id !== expectedAgentId) ||
    !Number.isInteger(agent.version) ||
    agent.version < 1
  ) {
    throw new Error(
      `Anthropic returned an invalid Agent for resource '${resourceId}'`,
    );
  }
  if (agent.archived_at) {
    throw new Error(`Anthropic Agent '${agent.id}' is archived`);
  }
  return agent;
}

async function retrieveClaudeAgent(
  agentId,
  deployment,
  installationId,
  options,
) {
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

  const agent = validateClaudeAgent(body, deployment.resource.id, agentId);
  const ownerInstallation = agent.metadata?.[INSTALLATION_METADATA_KEY];
  const ownerResource = agent.metadata?.[RESOURCE_METADATA_KEY];
  if (ownerInstallation && ownerInstallation !== installationId) {
    throw new Error(
      `Anthropic Agent '${agentId}' belongs to aiappctl installation '${ownerInstallation}', not '${installationId}'`,
    );
  }
  if (ownerResource && ownerResource !== deployment.resource.id) {
    throw new Error(
      `Anthropic Agent '${agentId}' belongs to resource '${ownerResource}', not '${deployment.resource.id}'`,
    );
  }

  return agent;
}

export async function discoverClaudeAgentInstallations(
  deployments,
  installationId,
  options,
) {
  if (options.agentId) {
    if (deployments.length !== 1) {
      throw new Error(
        "--agent-id can only be used when the app contains exactly one Agent resource",
      );
    }
    const [deployment] = deployments;
    return new Map([
      [
        deployment.resource.id,
        await retrieveClaudeAgent(
          options.agentId,
          deployment,
          installationId,
          options,
        ),
      ],
    ]);
  }

  const agents = await listClaudeAgents(options);
  const discovered = new Map();

  for (const deployment of deployments) {
    const matches = agents.filter(
      (agent) =>
        agent.archived_at == null &&
        agent.metadata?.[INSTALLATION_METADATA_KEY] === installationId &&
        agent.metadata?.[RESOURCE_METADATA_KEY] === deployment.resource.id,
    );

    if (matches.length > 1) {
      throw new Error(
        `resource '${deployment.resource.id}': found multiple active Anthropic Agents for installation '${installationId}'`,
      );
    }
    if (matches.length === 1) {
      const agent = validateClaudeAgent(matches[0], deployment.resource.id);
      discovered.set(deployment.resource.id, agent);
    }
  }

  return discovered;
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

async function updateClaudeAgent(deployment, existingAgent, options) {
  const endpoint = new URL(
    `/v1/agents/${encodeURIComponent(existingAgent.id)}`,
    options.baseUrl,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: anthropicHeaders(options.apiKey),
    body: JSON.stringify({
      ...deployment.payload,
      version: existingAgent.version,
    }),
  });
  const body = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(
      `Anthropic failed to update resource '${deployment.resource.id}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || body.id !== existingAgent.id) {
    throw new Error(
      `Anthropic returned an invalid update response for resource '${deployment.resource.id}'`,
    );
  }

  return { providerResource: body, operation: "updated" };
}

export async function reconcileClaudeAgent(
  deployment,
  existingAgent,
  options,
) {
  if (!existingAgent) {
    return createClaudeAgent(deployment, options);
  }

  if (
    existingAgent.metadata?.[FINGERPRINT_METADATA_KEY] ===
      deployment.payload.metadata[FINGERPRINT_METADATA_KEY] &&
    existingAgent.metadata?.[INSTALLATION_METADATA_KEY] ===
      deployment.payload.metadata[INSTALLATION_METADATA_KEY] &&
    existingAgent.metadata?.[RESOURCE_METADATA_KEY] ===
      deployment.payload.metadata[RESOURCE_METADATA_KEY]
  ) {
    return { providerResource: existingAgent, operation: "unchanged" };
  }

  return updateClaudeAgent(deployment, existingAgent, options);
}
