import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { deployClaudeAgent } from "./claude/agent.js";
import { verifyClaudeEnvironment } from "./claude/environment.js";
import { verifyClaudeVault } from "./claude/vault.js";

const ANTHROPIC_MANAGED_AGENT_FORMAT = "anthropic.com/managed-agent:v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_MAX_MCP_SERVERS = 20;
const ANTHROPIC_AGENT_ID_PATTERN = /^agent_[A-Za-z0-9]+$/;

function validateClaudeAgentId(agentId) {
  if (!ANTHROPIC_AGENT_ID_PATTERN.test(agentId)) {
    return "--agent-id must be an Anthropic Agent ID beginning with 'agent_'";
  }
}

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

async function deployToClaude(validation, options) {
  const prepared = await prepareDeployments(validation);
  if (prepared.errors.length > 0) {
    return { manifestPath: validation.manifestPath, errors: prepared.errors };
  }

  if (options.agentId && prepared.deployments.length !== 1) {
    return {
      manifestPath: validation.manifestPath,
      errors: [
        "--agent-id can only be used when the app contains exactly one Agent resource",
      ],
    };
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
    environmentId: options.environmentId,
    vaultId: options.vaultId,
    agentId: options.agentId,
  };
  let environment;
  try {
    environment = await verifyClaudeEnvironment(validation, adapterOptions);
  } catch (error) {
    return {
      manifestPath: validation.manifestPath,
      deployed: [],
      errors: [error.message],
    };
  }

  let vault;
  try {
    vault = await verifyClaudeVault(validation, adapterOptions);
  } catch (error) {
    return {
      manifestPath: validation.manifestPath,
      environment,
      vault: error.vault,
      deployed: [],
      errors: [error.message],
    };
  }

  const deployed = [];
  for (const deployment of prepared.deployments) {
    try {
      const { providerResource, operation } = await deployClaudeAgent(
        deployment,
        adapterOptions,
      );
      deployed.push({
        id: deployment.resource.id,
        kind: deployment.resource.kind,
        format: deployment.resource.implementation.format,
        providerId: providerResource.id,
        providerVersion: providerResource.version,
        operation,
      });
    } catch (error) {
      return {
        manifestPath: validation.manifestPath,
        environment,
        vault,
        deployed,
        errors: [error.message],
      };
    }
  }

  return {
    manifestPath: validation.manifestPath,
    environment,
    vault,
    deployed,
    errors: [],
  };
}

export const claudeRuntime = {
  name: "claude",
  formats: new Set([ANTHROPIC_MANAGED_AGENT_FORMAT]),
  validateAgentId: validateClaudeAgentId,
  deploy: deployToClaude,
};
