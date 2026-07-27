const GOOGLE_SECRET_MANAGER_BASE_URL =
  "https://secretmanager.googleapis.com";
const SECRET_VERSION_PATTERN =
  /^projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^/]+)$/;

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

export function parseSecretVersionResource(resourceName) {
  const match =
    typeof resourceName === "string" &&
    resourceName.match(SECRET_VERSION_PATTERN);
  if (!match) {
    throw new Error(
      "must use projects/{project}/secrets/{secret}/versions/{version}",
    );
  }

  return {
    resourceName,
    projectId: match[1],
  };
}

export async function accessSecretVersion(binding, options) {
  const baseUrl =
    options.secretManagerBaseUrl || GOOGLE_SECRET_MANAGER_BASE_URL;
  const url = new URL(`/v1/${binding.resourceName}:access`, baseUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
    },
  });
  const body = await readResponseJson(response);

  if (!response.ok) {
    throw new Error(googleErrorMessage(response, body));
  }

  const encodedValue = body?.payload?.data;
  if (typeof encodedValue !== "string" || !encodedValue) {
    throw new Error("Google returned an invalid Secret Manager response");
  }

  const value = Buffer.from(encodedValue, "base64").toString("utf8");
  if (!value) {
    throw new Error("secret value must not be empty");
  }
  if (/[\r\n]/.test(value)) {
    throw new Error("secret value must not contain a line break");
  }

  return value;
}
