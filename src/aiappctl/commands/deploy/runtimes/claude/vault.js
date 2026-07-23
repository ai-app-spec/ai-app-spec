const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const COMPATIBLE_MCP_CREDENTIAL_TYPES = new Set([
  "mcp_oauth",
  "static_bearer",
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

async function anthropicGet(pathname, { apiKey, baseUrl }) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "GET",
    headers: anthropicHeaders(apiKey),
  });
  return { response, body: await readResponseJson(response) };
}

function collectAuthenticatedMcpServers(manifest) {
  const resourcesById = new Map(
    manifest.spec.resources.map((resource) => [resource.id, resource]),
  );
  const servers = new Map();

  for (const resource of manifest.spec.resources) {
    // TODO(resource-dispatch): Have the deploy layer pass only Agent resources
    // into Claude vault requirement collection.
    if (resource.kind !== "Agent") {
      continue;
    }
    for (const tool of resource.tools || []) {
      const server = resourcesById.get(tool.ref);
      if (server?.kind === "MCPServer" && server.authentication) {
        servers.set(server.id, server);
      }
    }
  }

  return [...servers.values()];
}

function normalizeMcpServerUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/$/, "");
  }
  return url.toString();
}

async function retrieveVault(vaultId, options) {
  const { response, body } = await anthropicGet(
    `/v1/vaults/${encodeURIComponent(vaultId)}`,
    options,
  );
  if (response.status === 404) {
    throw new Error(`Anthropic vault '${vaultId}' does not exist`);
  }
  if (!response.ok) {
    throw new Error(
      `Anthropic failed to retrieve vault '${vaultId}' (${anthropicErrorMessage(response, body)})`,
    );
  }
  if (!body || body.id !== vaultId) {
    throw new Error(
      `Anthropic returned an invalid retrieve response for vault '${vaultId}'`,
    );
  }
  if (body.archived_at) {
    throw new Error(`Anthropic vault '${vaultId}' is archived`);
  }
  return body;
}

async function listCredentials(vaultId, options) {
  const credentials = [];
  let page;

  do {
    const pathname = new URL(
      `/v1/vaults/${encodeURIComponent(vaultId)}/credentials`,
      options.baseUrl,
    );
    if (page) {
      pathname.searchParams.set("page", page);
    }
    const { response, body } = await anthropicGet(pathname, options);
    if (!response.ok) {
      throw new Error(
        `Anthropic failed to list credentials for vault '${vaultId}' (${anthropicErrorMessage(response, body)})`,
      );
    }
    if (!body || !Array.isArray(body.data)) {
      throw new Error("Anthropic returned an invalid credential list response");
    }
    credentials.push(...body.data);
    page = body.next_page || undefined;
  } while (page);

  return credentials;
}

function credentialForServer(credentials, server) {
  const serverUrl = normalizeMcpServerUrl(server.connection.url);
  return credentials.find(
    (credential) =>
      credential.archived_at == null &&
      COMPATIBLE_MCP_CREDENTIAL_TYPES.has(credential.auth?.type) &&
      credential.auth?.mcp_server_url &&
      normalizeMcpServerUrl(credential.auth.mcp_server_url) === serverUrl,
  );
}

export async function verifyClaudeVault(validation, options) {
  const servers = collectAuthenticatedMcpServers(validation.manifest);
  if (servers.length === 0) {
    return undefined;
  }
  if (!options.vaultId) {
    throw new Error(
      "--vault-id is required when authenticated MCPServer resources are referenced",
    );
  }

  const vault = await retrieveVault(options.vaultId, options);
  const credentials = await listCredentials(vault.id, options);
  const verifiedCredentials = [];
  const errors = [];

  for (const server of servers) {
    const credential = credentialForServer(credentials, server);
    if (!credential) {
      errors.push(
        `vault '${vault.id}' does not contain an active MCP credential for resource '${server.id}' at ${server.connection.url}`,
      );
      continue;
    }
    verifiedCredentials.push({
      id: credential.id,
      resourceId: server.id,
      credentialType: credential.auth.type,
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return { id: vault.id, credentials: verifiedCredentials };
}
