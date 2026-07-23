import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const GOOGLE_MANAGED_AGENT_FORMAT = "google.com/managed-agent:v1";
const GOOGLE_AIPLATFORM_BASE_URL = "https://aiplatform.googleapis.com";
const GOOGLE_AIPLATFORM_API_VERSION = "v1beta1";
const GOOGLE_AIPLATFORM_LOCATION = "global";
const GOOGLE_CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_OPERATION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5 * 60 * 1_000;

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

async function prepareDeployments(validation) {
  const deployments = [];
  const errors = [];

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
      deployments.push({
        resource,
        payload: {
          ...packagePayload,
          id: resource.id,
        },
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
  { accessToken, baseUrl, body, method },
) {
  const response = await fetch(apiUrl(pathname, baseUrl), {
    method,
    headers: googleHeaders(accessToken),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const responseBody = await readResponseJson(response);

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

async function deployGoogleManagedAgent(deployment, options) {
  const parent = `projects/${encodeURIComponent(options.projectId)}/locations/${GOOGLE_AIPLATFORM_LOCATION}`;
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

  const agent = await googleRequest(
    `${parent}/agents/${encodeURIComponent(deployment.resource.id)}`,
    {
      ...options,
      method: "GET",
    },
  );
  if (
    !agent ||
    (typeof agent.name !== "string" && typeof agent.id !== "string")
  ) {
    throw new Error(
      `Google returned an invalid Agent response for resource '${deployment.resource.id}'`,
    );
  }

  return agent;
}

async function deployToGemini(validation, options) {
  const prepared = await prepareDeployments(validation);
  if (prepared.errors.length > 0) {
    return { manifestPath: validation.manifestPath, errors: prepared.errors };
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
    baseUrl: options.baseUrl || GOOGLE_AIPLATFORM_BASE_URL,
    operationPollIntervalMs:
      options.operationPollIntervalMs ?? DEFAULT_OPERATION_POLL_INTERVAL_MS,
    operationTimeoutMs:
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  };
  const deployed = [];

  for (const deployment of prepared.deployments) {
    try {
      const providerResource = await deployGoogleManagedAgent(
        deployment,
        adapterOptions,
      );
      deployed.push({
        id: deployment.resource.id,
        kind: deployment.resource.kind,
        format: deployment.resource.implementation.format,
        providerId: providerResource.name || providerResource.id,
      });
    } catch (error) {
      return {
        manifestPath: validation.manifestPath,
        deployed,
        errors: [
          `Google failed to create resource '${deployment.resource.id}' (${error.message})`,
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
  deploy: deployToGemini,
};
