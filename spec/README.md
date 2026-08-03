# Specification

The authoritative version 0.1 specification is composed from Zod schemas in [`v0.1/app.ts`](v0.1/app.ts). [`v0.1/app.schema.json`](v0.1/app.schema.json) is a generated structural JSON Schema artifact for tools that cannot consume the code package directly. Cross-resource invariants such as unique resource IDs and entrypoint resolution are expressed as Zod refinements.

Version 0.1 is a draft and may change incompatibly until it is explicitly frozen.

An unpacked app bundle is a directory with an `app.yaml` manifest at its root:

```text
my-app/
├── app.yaml
└── packages/
    └── agent.pkg
```

The canonical archive encoding will be ZIP, whose archive root has the same layout. Version 0.1 of the CLI validates unpacked directories and individual `app.yaml` files; archive creation and validation are intentionally deferred. For package-relative implementation locations, validation also checks containment, file existence, and SHA-256 integrity. External package locations are not fetched during local validation.

The current schema supports `Agent` and `MCPServer` resources. An agent identifies its implementation with a namespaced format and an immutable package descriptor. A package location may be relative to the app bundle or an absolute URI; `file:` URIs are not portable and are rejected. The format's runtime adapter owns interpretation of the package contents.

An agent can reference URL-backed MCP servers through its `tools` field. MCP server URLs must use HTTPS and must not contain embedded credentials or fragments. Tool references are validated within the app manifest, while live server capability discovery is deferred to the runtime.

An MCP server that requires a bearer token references a logical secret requirement. The package declares the requirement and authentication mechanism, but never contains the customer credential, an environment-variable name, or a provider-native secret identifier. Those values belong to the installation binding.

An Agent can similarly reference a logical execution environment requirement. The package describes why the environment is needed without embedding a provider-native environment identifier or configuration. The installing operator binds that requirement to an environment governed by the target runtime. The optional `networking.mcpServers` field defaults to `false`; setting it to `true` requires the bound environment to permit outbound access to the Agent's declared MCP servers.

```yaml
requirements:
  secrets:
    - id: linear-access-token
      description: Linear API key for the Linear MCP server.
  executionEnvironments:
    - id: product-manager-sandbox
      description: Isolated sandbox able to reach the agent's declared MCP servers.
      networking:
        mcpServers: true
resources:
  - id: product-manager
    kind: Agent
    executionEnvironment:
      ref: product-manager-sandbox
    tools:
      - ref: linear
    implementation:
      format: anthropic.com/managed-agent:v1
      package:
        location: ./packages/product-manager.agentpkg.yaml
        digest: sha256:...
  - id: linear
    kind: MCPServer
    connection:
      type: url
      url: https://mcp.linear.app/mcp
    authentication:
      type: bearer
      secret:
        ref: linear-access-token
```

The specification does not define build inputs, container implementation details, deployment topology, scaling, or resource-allocation policy. These remain responsibilities of tooling and the target runtime.

Generate and test the specification:

```sh
cd spec
bun install
bun run generate
bun test
```

CI runs `bun run generate:check` to ensure the checked-in JSON Schema matches the Zod source.

Run the reference validator from the repository root:

```sh
cd src/aiappctl
bun install
bun run validate --package=../../examples/hello-oci
bun ./cli.js digest ../../examples/hello-claude/packages/greeter.agentpkg.yaml
```

Build the Product Manager example as a deployable
[eve](https://eve.dev/) project:

```sh
cd src/aiappctl
bun ./cli.js build \
  --runtime eve \
  --package ../../examples/product-manager-eve \
  --out /tmp/product-manager-eve

cd /tmp/product-manager-eve
bun install
bunx eve link
bun run build
bun run deploy
```

The experimental `vercel.com/eve:v1` format is a YAML mapping with exactly two
fields: a Vercel AI Gateway `model` identifier and the Agent's
`instructions`. The Eve build adapter compiles these fields together with the
app manifest's Agent identity, referenced MCP servers, execution requirement,
and logical secret requirements. It emits an Eve project with pinned
dependencies, one `agent/connections/*.ts` module per MCP server, and an
`aiappctl.build.json` provenance record.

Rebuilding into the same `--out` directory verifies the SHA-256 digest of every
previously generated file before applying the new build. It stops on local
changes, removes obsolete generated files, and preserves unmanaged state such
as `.vercel/`, `.env.local`, and lockfiles. Older build-manifest schemas must be
rebuilt into a new output directory.

Bearer secret requirements become environment-variable bindings in generated
connection modules. For example, `linear-access-token` becomes
`LINEAR_ACCESS_TOKEN`; the generated project never contains its value. Configure
the variable in the linked Vercel project before deployment.

The generated project does not configure inbound authentication. Eve fails
closed in production, so its Agent API rejects unauthenticated requests after
deployment; configure an Eve route authenticator before clients can invoke it.
The public landing page and health endpoint remain reachable.

The prototype supports exactly one Agent, which must be the app entrypoint. It
rejects external implementation locations, unsupported package fields,
unreferenced MCP servers, and unused secret requirements rather than silently
dropping declarations.

Deploy the Claude Managed Agents example:

```sh
cd src/aiappctl
export ANTHROPIC_API_KEY="your-api-key"
bun run deploy --runtime claude --package=../../examples/hello-claude
```

Deploy the Gemini Enterprise Agent Platform Managed Agents example using
Google Application Default Credentials:

```sh
gcloud auth application-default login
bun run deploy \
  --runtime gemini \
  --package=../../examples/hello-gemini \
  --project your-google-cloud-project
```

Deploy the Product Manager example with a pre-provisioned Secret Manager
version:

```sh
bun run deploy \
  --runtime gemini \
  --package=../../examples/product-manager-gemini \
  --project your-google-cloud-project \
  --secret-binding \
  linear-access-token=projects/your-google-cloud-project/secrets/linear-access-token/versions/latest
```

The deploying identity needs `secretmanager.versions.access` on the bound
secret. Google also requires `roles/mcp.toolUser` for the deploying identity
and associated service account. The CLI resolves the secret before the first
Agent mutation and configures it as the Linear MCP server's bearer header
without printing the value. Adding a new Secret Manager version and deploying
again with the same `--agent-id` patches the existing Agent's complete tool
configuration with the rotated credential.

Deploy the authenticated Product Manager example using a pre-provisioned Claude vault:

```sh
export ANTHROPIC_API_KEY="your-anthropic-api-key"
bun run deploy \
  --runtime claude \
  --package=../../examples/product-manager-claude \
  --agent-id agent_... \
  --environment-id env_... \
  --vault-id vlt_...
```

`--agent-id` retrieves and updates an existing Anthropic Agent instead of creating a new one. It currently applies to apps containing exactly one Agent resource and must be supplied on every update.

The vault must belong to the Anthropic workspace selected by `ANTHROPIC_API_KEY` and contain an active `static_bearer` or `mcp_oauth` credential for every authenticated MCP server URL referenced by an Agent. The CLI never accepts secret values and does not create, update, archive, or delete vaults or credentials.

The environment must belong to the same Anthropic workspace and must not be archived. When `networking.mcpServers` is required, an Anthropic cloud environment must use unrestricted networking or limited networking with `allow_mcp_servers` enabled. The CLI cannot verify self-hosted egress policy and therefore rejects self-hosted environments for this requirement. It verifies the binding but does not create, update, archive, or delete environments.

`deploy` selects a provider adapter from each Agent resource's implementation format. The `claude` runtime accepts `anthropic.com/managed-agent:v1` packages stored inside the app bundle. The adapter parses the package YAML and sends it to Anthropic's `POST /v1/agents` endpoint using the Managed Agents beta API. Every Agent resource must use that format when `--runtime claude` is selected; deployment fails during preflight if any resource declares a different format.

The experimental `gemini` runtime accepts `google.com/managed-agent:v1`
packages and sends them to the Gemini Enterprise Agent Platform Managed Agents
API in the `global` location. Without `--agent-id`, the adapter creates an
Agent using the app resource ID as its Google Agent ID. With `--agent-id`, it
retrieves and updates that exact Agent instead; the option currently applies
to apps containing exactly one Agent resource and must be supplied on every
update. The adapter authenticates with Google Application Default Credentials
and waits for create operations to complete before retrieving the Agent. It
does not list or discover existing Agents. The Google Managed Agents API is
currently a Pre-GA service intended for testing and evaluation.

During Gemini deployment, referenced `MCPServer` resources become
`mcp_server` tools. An Agent's execution environment requirement becomes a
remote `base_environment`; when `networking.mcpServers` is enabled, its network
allowlist contains only the hostnames of that Agent's referenced MCP servers.
Authenticated servers require a `--secret-binding` from the logical secret ID
to a Secret Manager version in the deployment project. The adapter resolves
all required secret values before mutating an Agent and supplies them as MCP
authorization headers. Existing Agents are updated in place only when their
ID is explicitly supplied with `--agent-id`.

During Claude deployment, each Agent's referenced `MCPServer` resources are composed into the provider request as `mcp_servers` entries with matching `mcp_toolset` entries. MCP authentication is not included in the reusable Agent definition. If any referenced MCP server declares authentication, `--vault-id` is required. Before creating an Agent, the adapter retrieves that vault and verifies from credential metadata that every authenticated MCP server URL has an active compatible credential. A missing, archived, or non-conforming vault fails deployment before the first provider mutation.

Environment and vault bindings are consumed through `environment_id` and `vault_ids` on Claude sessions and scheduled deployments. The current CLI does not yet create either, so this implementation verifies the bindings but cannot attach them to an execution yet. Claude environments are mutable and can be archived after verification, so the binding must be checked again when an execution is created.

When `--agent-id` is omitted, Claude deployment creates a new Agent. When it is supplied, the adapter retrieves that Agent, verifies that it exists and is active, and updates it using its current version for optimistic concurrency control. The CLI does not persist or discover Agent IDs, so callers must retain and resupply the ID. External package locations remain unsupported. Provider failures can leave an Agent created or updated earlier in a multi-resource deployment; its ID is reported on stderr.
