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

function collectExecutionEnvironmentBindings(manifest) {
  const bindings = new Map();

  for (const resource of manifest.spec.resources) {
    // TODO(resource-dispatch): Have the deploy layer pass only Agent resources
    // into Claude execution environment requirement collection.
    if (resource.kind !== "Agent" || !resource.executionEnvironment) {
      continue;
    }

    const requirementId = resource.executionEnvironment.ref;
    const resourceIds = bindings.get(requirementId) || [];
    resourceIds.push(resource.id);
    bindings.set(requirementId, resourceIds);
  }

  return [...bindings].map(([requirementId, resourceIds]) => ({
    requirementId,
    resourceIds,
  }));
}

async function retrieveEnvironment(environmentId, options) {
  const response = await fetch(
    new URL(
      `/v1/environments/${encodeURIComponent(environmentId)}`,
      options.baseUrl,
    ),
    {
      method: "GET",
      headers: anthropicHeaders(options.apiKey),
    },
  );
  const body = await readResponseJson(response);

  if (response.status === 404) {
    throw new Error(
      `Anthropic environment '${environmentId}' does not exist`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Anthropic failed to retrieve environment '${environmentId}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || body.id !== environmentId) {
    throw new Error(
      `Anthropic returned an invalid retrieve response for environment '${environmentId}'`,
    );
  }
  if (body.archived_at) {
    throw new Error(`Anthropic environment '${environmentId}' is archived`);
  }

  return body;
}

export async function verifyClaudeEnvironment(validation, options) {
  const bindings = collectExecutionEnvironmentBindings(validation.manifest);
  if (bindings.length === 0) {
    return undefined;
  }
  if (!options.environmentId) {
    throw new Error(
      "--environment-id is required when Agent resources reference an execution environment",
    );
  }

  const environment = await retrieveEnvironment(
    options.environmentId,
    options,
  );

  return {
    id: environment.id,
    environmentType: environment.config?.type,
    bindings,
  };
}
