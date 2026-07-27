import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const ANTHROPIC_MANAGED_AGENT_FORMAT = "anthropic.com/managed-agent:v1";
const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_MAX_MCP_SERVERS = 20;

function parseImplementationPackage(source, packagePath, resourceId) {
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    throw new Error(
      `resource '${resourceId}' package ${packagePath} is invalid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  const payload = document.toJS();
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error(
      `resource '${resourceId}' package ${packagePath} must contain a YAML mapping`,
    );
  }

  return payload;
}

function composeMcpConfiguration(payload, resource, resourcesById) {
  const toolReferences = resource.tools || [];

  if (toolReferences.length > ANTHROPIC_MAX_MCP_SERVERS) {
    throw new Error(
      `resource '${resource.id}': Claude Managed Agents supports at most ${ANTHROPIC_MAX_MCP_SERVERS} MCP servers, found ${toolReferences.length}`,
    );
  }

  if (Object.hasOwn(payload, "mcp_servers")) {
    throw new Error(
      `resource '${resource.id}': implementation package must not define 'mcp_servers'; declare MCPServer resources in app.yaml`,
    );
  }

  const packageTools = payload.tools;
  if (packageTools !== undefined && !Array.isArray(packageTools)) {
    throw new Error(
      `resource '${resource.id}': implementation package field 'tools' must be an array`,
    );
  }

  if (
    packageTools?.some(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        tool.type === "mcp_toolset",
    )
  ) {
    throw new Error(
      `resource '${resource.id}': implementation package must not define MCP toolsets; reference MCPServer resources in app.yaml`,
    );
  }

  if (toolReferences.length === 0) {
    return payload;
  }

  const mcpServers = [];
  const mcpToolsets = [];
  for (const toolReference of toolReferences) {
    const server = resourcesById.get(toolReference.ref);
    if (!server) {
      throw new Error(
        `resource '${resource.id}': referenced tool resource '${toolReference.ref}' does not exist`,
      );
    }
    if (server.kind !== "MCPServer") {
      throw new Error(
        `resource '${resource.id}': referenced tool resource '${toolReference.ref}' is not an MCPServer`,
      );
    }

    mcpServers.push({
      type: server.connection.type,
      name: server.id,
      url: server.connection.url,
    });
    mcpToolsets.push({
      type: "mcp_toolset",
      mcp_server_name: server.id,
    });
  }

  return {
    ...payload,
    mcp_servers: mcpServers,
    tools: [...(packageTools || []), ...mcpToolsets],
  };
}

async function prepareDeployments(validation) {
  const deployments = [];
  const errors = [];
  const resourcesById = new Map(
    validation.manifest.spec.resources.map((resource) => [
      resource.id,
      resource,
    ]),
  );

  for (const resource of validation.manifest.spec.resources) {
    // TODO(resource-dispatch): Have the deploy layer pass only Agent resources
    // into Claude Agent preparation.
    if (resource.kind !== "Agent") {
      continue;
    }

    const { package: implementationPackage } = resource.implementation;

    if (!implementationPackage.location.startsWith("./")) {
      errors.push(
        `resource '${resource.id}': deploy only supports package-relative implementation locations`,
      );
      continue;
    }

    const packagePath = validation.resolvedPackages.get(resource.id);
    if (!packagePath) {
      errors.push(
        `resource '${resource.id}': implementation package is unavailable`,
      );
      continue;
    }

    try {
      const source = await readFile(packagePath, "utf8");
      const packagePayload = parseImplementationPackage(
        source,
        packagePath,
        resource.id,
      );
      deployments.push({
        resource,
        payload: composeMcpConfiguration(
          packagePayload,
          resource,
          resourcesById,
        ),
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { deployments, errors };
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

async function deployAnthropicManagedAgent(
  deployment,
  { apiKey, baseUrl },
) {
  const endpoint = new URL("/v1/agents", baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_MANAGED_AGENTS_BETA,
    },
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

  return body;
}

async function deployToClaude(validation, options) {
  const prepared = await prepareDeployments(validation);
  if (prepared.errors.length > 0) {
    return { manifestPath: validation.manifestPath, errors: prepared.errors };
  }

  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      manifestPath: validation.manifestPath,
      errors: ["ANTHROPIC_API_KEY is required to deploy Anthropic resources"],
    };
  }

  const adapterOptions = {
    apiKey,
    baseUrl: options.baseUrl || ANTHROPIC_BASE_URL,
  };
  const deployed = [];
  for (const deployment of prepared.deployments) {
    try {
      const providerResource = await deployAnthropicManagedAgent(
        deployment,
        adapterOptions,
      );
      deployed.push({
        id: deployment.resource.id,
        kind: deployment.resource.kind,
        format: deployment.resource.implementation.format,
        providerId: providerResource.id,
        providerVersion: providerResource.version,
      });
    } catch (error) {
      return {
        manifestPath: validation.manifestPath,
        deployed,
        errors: [error.message],
      };
    }
  }

  return { manifestPath: validation.manifestPath, deployed, errors: [] };
}

export const claudeRuntime = {
  name: "claude",
  formats: new Set([ANTHROPIC_MANAGED_AGENT_FORMAT]),
  deploy: deployToClaude,
};
