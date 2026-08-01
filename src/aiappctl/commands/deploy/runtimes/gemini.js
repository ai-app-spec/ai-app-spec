import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  accessSecretVersion,
  parseSecretVersionResource,
} from "./gemini/secret-manager.js";

const GOOGLE_MANAGED_AGENT_FORMAT = "google.com/managed-agent:v1";
const GOOGLE_AIPLATFORM_BASE_URL = "https://aiplatform.googleapis.com";
const GOOGLE_AIPLATFORM_API_VERSION = "v1beta1";
const GOOGLE_AIPLATFORM_LOCATION = "global";
const GOOGLE_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_OPERATION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60 * 1_000;
const GOOGLE_AGENT_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GOOGLE_PATCHABLE_AGENT_FIELDS = [
  "description",
  "system_instruction",
  "tools",
  "base_environment",
];

function validateGoogleAgentId(agentId) {
  if (!GOOGLE_AGENT_ID_PATTERN.test(agentId)) {
    return "--agent-id must be a Google Agent ID containing 1-63 lowercase letters, numbers, or hyphens, beginning with a letter and ending with a letter or number";
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

  for (const field of ["id", "name"]) {
    if (Object.hasOwn(payload, field)) {
      throw new Error(
        `resource '${resourceId}': implementation package must not define '${field}'; the app manifest owns the Agent identity`,
      );
    }
  }

  return payload;
}

function packageTools(packagePayload, resourceId) {
  if (packagePayload.tools === undefined) {
    return [];
  }
  if (!Array.isArray(packagePayload.tools)) {
    throw new Error(
      `resource '${resourceId}': implementation package field 'tools' must be an array`,
    );
  }
  if (
    packagePayload.tools.some(
      (tool) =>
        tool !== null &&
        typeof tool === "object" &&
        tool.type === "mcp_server",
    )
  ) {
    throw new Error(
      `resource '${resourceId}': implementation package must not define MCP server tools; reference MCPServer resources in app.yaml`,
    );
  }

  return packagePayload.tools;
}

function referencedMcpServers(resource, resourcesById) {
  return (resource.tools || []).map((toolReference) => {
    const server = resourcesById.get(toolReference.ref);
    if (!server || server.kind !== "MCPServer") {
      throw new Error(
        `resource '${resource.id}': referenced tool resource '${toolReference.ref}' is not an MCPServer`,
      );
    }
    return server;
  });
}

function composeBaseEnvironment(
  resource,
  packagePayload,
  mcpServers,
  executionEnvironmentsById,
) {
  if (!resource.executionEnvironment) {
    if (mcpServers.length > 0) {
      throw new Error(
        `resource '${resource.id}': Gemini MCP tools require an execution environment with networking.mcpServers enabled`,
      );
    }
    return packagePayload.base_environment;
  }

  if (Object.hasOwn(packagePayload, "base_environment")) {
    throw new Error(
      `resource '${resource.id}': implementation package must not define 'base_environment' when app.yaml declares an execution environment`,
    );
  }

  const requirement = executionEnvironmentsById.get(
    resource.executionEnvironment.ref,
  );
  if (!requirement) {
    throw new Error(
      `resource '${resource.id}': execution environment requirement '${resource.executionEnvironment.ref}' does not exist`,
    );
  }
  if (mcpServers.length > 0 && !requirement.networking?.mcpServers) {
    throw new Error(
      `resource '${resource.id}': Gemini MCP tools require execution environment '${requirement.id}' to enable networking.mcpServers`,
    );
  }

  const domains = [
    ...new Set(
      mcpServers.map(
        (server) => new URL(server.connection.url).hostname,
      ),
    ),
  ];
  const baseEnvironment = { type: "remote" };
  if (domains.length > 0) {
    baseEnvironment.network = {
      allowlist: domains.map((domain) => ({ domain })),
    };
  }
  return baseEnvironment;
}

function validateSecretBindings(manifest, requiredSecretIds, options) {
  const declaredSecretIds = new Set(
    (manifest.spec.requirements?.secrets || []).map(
      (requirement) => requirement.id,
    ),
  );
  const providedBindings = options.secretBindings || new Map();
  const bindings = new Map();
  const errors = [];

  for (const secretId of requiredSecretIds) {
    const resourceName = providedBindings.get(secretId);
    if (!resourceName) {
      errors.push(
        `--secret-binding is required for secret requirement '${secretId}'`,
      );
      continue;
    }

    try {
      bindings.set(secretId, parseSecretVersionResource(resourceName));
    } catch (error) {
      errors.push(`secret binding '${secretId}' ${error.message}`);
    }
  }

  for (const secretId of providedBindings.keys()) {
    if (!declaredSecretIds.has(secretId)) {
      errors.push(
        `secret binding '${secretId}' does not match a declared secret requirement`,
      );
    }
  }

  return { bindings, errors };
}

async function prepareDeployments(validation, options) {
  const deployments = [];
  const errors = [];
  const requiredSecretIds = new Set();
  const resourcesById = new Map(
    validation.manifest.spec.resources.map((resource) => [
      resource.id,
      resource,
    ]),
  );
  const executionEnvironmentsById = new Map(
    (
      validation.manifest.spec.requirements?.executionEnvironments || []
    ).map((requirement) => [requirement.id, requirement]),
  );

  for (const resource of validation.manifest.spec.resources) {
    // TODO(resource-dispatch): Have the deploy layer pass only Agent resources
    // into Gemini Agent preparation.
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
      const nativeTools = packageTools(packagePayload, resource.id);
      const mcpServers = referencedMcpServers(resource, resourcesById);
      for (const server of mcpServers) {
        if (server.authentication) {
          requiredSecretIds.add(server.authentication.secret.ref);
        }
      }
      const baseEnvironment = composeBaseEnvironment(
        resource,
        packagePayload,
        mcpServers,
        executionEnvironmentsById,
      );
      deployments.push({
        resource,
        packagePayload,
        nativeTools,
        mcpServers,
        baseEnvironment,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  const secretBindingValidation = validateSecretBindings(
    validation.manifest,
    requiredSecretIds,
    options,
  );
  errors.push(...secretBindingValidation.errors);

  return {
    deployments,
    secretBindings: secretBindingValidation.bindings,
    errors,
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

function googleErrorMessage(response, body) {
  const message =
    body?.error?.message ||
    body?.message ||
    response.statusText ||
    "request failed";
  const status = body?.error?.status;
  const statusSuffix = status ? ` ${status}` : "";
  return `${response.status}${statusSuffix}: ${message}`;
}

async function resolveGoogleTarget(options) {
  let projectId =
    options.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  let accessToken = options.accessToken;

  if (!projectId || !accessToken) {
    let GoogleAuth;
    try {
      ({ GoogleAuth } = await import("google-auth-library"));
    } catch {
      throw new Error(
        "google-auth-library is required to use Google Application Default Credentials",
      );
    }

    const auth = new GoogleAuth({
      scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
    });
    if (!projectId) {
      try {
        projectId = await auth.getProjectId();
      } catch {
        throw new Error(
          "--project or GOOGLE_CLOUD_PROJECT is required to deploy Google resources",
        );
      }
    }
    if (!accessToken) {
      try {
        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        accessToken =
          typeof tokenResponse === "string"
            ? tokenResponse
            : tokenResponse?.token;
      } catch {
        throw new Error(
          "Google Application Default Credentials are required to deploy Google resources; run 'gcloud auth application-default login'",
        );
      }
    }
  }

  if (!projectId) {
    throw new Error(
      "--project or GOOGLE_CLOUD_PROJECT is required to deploy Google resources",
    );
  }
  if (!accessToken) {
    throw new Error(
      "Google Application Default Credentials are required to deploy Google resources",
    );
  }

  return { projectId, accessToken };
}

function googleHeaders(accessToken) {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

function apiUrl(pathname, baseUrl) {
  return new URL(`/${GOOGLE_AIPLATFORM_API_VERSION}/${pathname}`, baseUrl);
}

async function googleRequest(
  pathname,
  { accessToken, allowNotFound, baseUrl, body, method },
) {
  const response = await fetch(apiUrl(pathname, baseUrl), {
    method,
    headers: googleHeaders(accessToken),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await readResponseJson(response);

  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(googleErrorMessage(response, responseBody));
  }

  return responseBody;
}

function operationErrorMessage(error) {
  const code = error?.status || error?.code || "UNKNOWN";
  const message = error?.message || "operation failed";
  return `${code}: ${message}`;
}

async function waitForOperation(operationName, options) {
  const startedAt = Date.now();

  while (true) {
    const operation = await googleRequest(operationName, {
      ...options,
      method: "GET",
    });
    if (!operation || typeof operation !== "object") {
      throw new Error(
        `Google returned an invalid operation response for '${operationName}'`,
      );
    }
    if (operation.done) {
      if (operation.error) {
        throw new Error(operationErrorMessage(operation.error));
      }
      return operation;
    }
    if (Date.now() - startedAt >= options.operationTimeoutMs) {
      throw new Error(
        `Google operation '${operationName}' did not complete within ${options.operationTimeoutMs}ms`,
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, options.operationPollIntervalMs),
    );
  }
}

async function resolveSecretValues(bindings, options) {
  const values = new Map();

  for (const [secretId, binding] of bindings) {
    if (binding.projectId !== options.projectId) {
      throw new Error(
        `secret binding '${secretId}' must belong to Google Cloud project '${options.projectId}'`,
      );
    }

    try {
      values.set(secretId, await accessSecretVersion(binding, options));
    } catch (error) {
      throw new Error(
        `failed to access secret requirement '${secretId}' (${error.message})`,
      );
    }
  }

  return values;
}

function deploymentPayload(deployment, secretValues) {
  const mcpTools = deployment.mcpServers.map((server) => {
    const tool = {
      type: "mcp_server",
      name: server.id,
      url: server.connection.url,
    };
    if (server.authentication) {
      const secretId = server.authentication.secret.ref;
      tool.headers = {
        Authorization: `Bearer ${secretValues.get(secretId)}`,
      };
    }
    return tool;
  });
  const tools = [...deployment.nativeTools, ...mcpTools];
  const payload = {
    ...deployment.packagePayload,
    id: deployment.resource.id,
  };
  if (tools.length > 0) {
    payload.tools = tools;
  }
  if (deployment.baseEnvironment !== undefined) {
    payload.base_environment = deployment.baseEnvironment;
  }
  return payload;
}

function validateAgentResponse(agent, resourceId, expectedAgentPath) {
  if (
    !agent ||
    typeof agent.name !== "string" ||
    agent.name !== expectedAgentPath
  ) {
    throw new Error(
      `Google returned an invalid Agent response for resource '${resourceId}'`,
    );
  }
  return agent;
}

function googleAgentParent(projectId) {
  return `projects/${encodeURIComponent(projectId)}/locations/${GOOGLE_AIPLATFORM_LOCATION}`;
}

function googleAgentPath(projectId, agentId) {
  return `${googleAgentParent(projectId)}/agents/${encodeURIComponent(agentId)}`;
}

async function retrieveGoogleManagedAgent(agentId, resourceId, options) {
  const agentPath = googleAgentPath(options.projectId, agentId);
  const agent = await googleRequest(agentPath, {
    ...options,
    method: "GET",
    allowNotFound: true,
  });
  if (!agent) {
    throw new Error(`Google Agent '${agentId}' does not exist`);
  }
  return validateAgentResponse(agent, resourceId, agentPath);
}

async function createGoogleManagedAgent(deployment, options) {
  const parent = googleAgentParent(options.projectId);
  const agentPath = googleAgentPath(options.projectId, deployment.resource.id);

  const operation = await googleRequest(`${parent}/agents`, {
    ...options,
    method: "POST",
    body: deployment.payload,
  });
  if (!operation || typeof operation.name !== "string" || !operation.name) {
    throw new Error(
      `Google returned an invalid create response for resource '${deployment.resource.id}'`,
    );
  }

  await waitForOperation(operation.name, options);

  const agent = await googleRequest(agentPath, {
    ...options,
    method: "GET",
  });
  return {
    providerResource: validateAgentResponse(
      agent,
      deployment.resource.id,
      agentPath,
    ),
    operation: "created",
  };
}

async function updateGoogleManagedAgent(deployment, existingAgent, options) {
  const fields = GOOGLE_PATCHABLE_AGENT_FIELDS.filter((field) =>
    Object.hasOwn(deployment.payload, field),
  );
  if (fields.length === 0) {
    return { providerResource: existingAgent, operation: "unchanged" };
  }

  const body = { name: existingAgent.name };
  for (const field of fields) {
    body[field] = deployment.payload[field];
  }
  const agent = await googleRequest(
    `${existingAgent.name}?updateMask=${encodeURIComponent(fields.join(","))}`,
    {
      ...options,
      method: "PATCH",
      body,
    },
  );
  return {
    providerResource: validateAgentResponse(
      agent,
      deployment.resource.id,
      existingAgent.name,
    ),
    operation: "updated",
  };
}

async function deployGoogleManagedAgent(deployment, options) {
  if (!options.agentId) {
    return createGoogleManagedAgent(deployment, options);
  }

  const existingAgent = await retrieveGoogleManagedAgent(
    options.agentId,
    deployment.resource.id,
    options,
  );
  return updateGoogleManagedAgent(deployment, existingAgent, options);
}

async function deployToGemini(validation, options) {
  const prepared = await prepareDeployments(validation, options);
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

  let target;
  try {
    target = await resolveGoogleTarget(options);
  } catch (error) {
    return {
      manifestPath: validation.manifestPath,
      deployed: [],
      errors: [error.message],
    };
  }

  const adapterOptions = {
    ...target,
    agentId: options.agentId,
    baseUrl: options.baseUrl || GOOGLE_AIPLATFORM_BASE_URL,
    secretManagerBaseUrl: options.secretManagerBaseUrl,
    operationPollIntervalMs:
      options.operationPollIntervalMs ?? DEFAULT_OPERATION_POLL_INTERVAL_MS,
    operationTimeoutMs:
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  };
  const deployed = [];
  let secretValues;

  try {
    secretValues = await resolveSecretValues(
      prepared.secretBindings,
      adapterOptions,
    );
  } catch (error) {
    return {
      manifestPath: validation.manifestPath,
      deployed,
      errors: [error.message],
    };
  }

  for (const deployment of prepared.deployments) {
    try {
      deployment.payload = deploymentPayload(deployment, secretValues);
      const { providerResource, operation } = await deployGoogleManagedAgent(
        deployment,
        adapterOptions,
      );
      deployed.push({
        id: deployment.resource.id,
        kind: deployment.resource.kind,
        format: deployment.resource.implementation.format,
        providerId: providerResource.name || providerResource.id,
        operation,
      });
    } catch (error) {
      return {
        manifestPath: validation.manifestPath,
        deployed,
        errors: [
          `Google failed to deploy resource '${deployment.resource.id}' (${error.message})`,
        ],
      };
    }
  }

  return {
    manifestPath: validation.manifestPath,
    deployed,
    errors: [],
  };
}

export const geminiRuntime = {
  name: "gemini",
  formats: new Set([GOOGLE_MANAGED_AGENT_FORMAT]),
  validateAgentId: validateGoogleAgentId,
  deploy: deployToGemini,
};
