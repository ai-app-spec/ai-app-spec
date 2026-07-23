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

An Agent can similarly reference a logical execution environment requirement. The package describes why the environment is needed without embedding a provider-native environment identifier or configuration. The installing operator binds that requirement to an environment governed by the target runtime.

```yaml
requirements:
  secrets:
    - id: linear-access-token
      description: Linear API key for the Linear MCP server.
  executionEnvironments:
    - id: product-manager-sandbox
      description: Isolated sandbox able to reach the agent's declared MCP servers.
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

Deploy the Claude Managed Agents example:

```sh
cd src/aiappctl
export ANTHROPIC_API_KEY="your-api-key"
bun run deploy --runtime claude --package=../../examples/hello-claude
```

Deploy the authenticated Product Manager example using a pre-provisioned Claude vault:

```sh
export ANTHROPIC_API_KEY="your-anthropic-api-key"
bun run deploy \
  --runtime claude \
  --package=../../examples/product-manager-claude \
  --environment-id env_... \
  --vault-id vlt_...
```

The vault must belong to the Anthropic workspace selected by `ANTHROPIC_API_KEY` and contain an active `static_bearer` or `mcp_oauth` credential for every authenticated MCP server URL referenced by an Agent. The CLI never accepts secret values and does not create, update, archive, or delete vaults or credentials.

The environment must belong to the same Anthropic workspace and must not be archived. The CLI verifies the binding but does not create, update, archive, or delete environments.

`deploy` selects a provider adapter from each Agent resource's implementation format. The only currently supported runtime is `claude`, which accepts `anthropic.com/managed-agent:v1` packages stored inside the app bundle. The adapter parses the package YAML and sends it to Anthropic's `POST /v1/agents` endpoint using the Managed Agents beta API. Every Agent resource must use that format when `--runtime claude` is selected; deployment fails during preflight if any resource declares a different format.

During Claude deployment, each Agent's referenced `MCPServer` resources are composed into the provider request as `mcp_servers` entries with matching `mcp_toolset` entries. MCP authentication is not included in the reusable Agent definition. If any referenced MCP server declares authentication, `--vault-id` is required. Before creating an Agent, the adapter retrieves that vault and verifies from credential metadata that every authenticated MCP server URL has an active compatible credential. A missing, archived, or non-conforming vault fails deployment before the first provider mutation.

Environment and vault bindings are consumed through `environment_id` and `vault_ids` on Claude sessions and scheduled deployments. The current CLI does not yet create either, so this implementation verifies the bindings but cannot attach them to an execution yet. Claude environments are mutable and can be archived after verification, so the binding must be checked again when an execution is created. The initial implementation also does not persist or reconcile Agent IDs or resolve external package locations. Each successful invocation therefore creates a new Managed Agent. Provider failures can leave an Agent created earlier in a multi-resource deployment; its ID is reported on stderr.
