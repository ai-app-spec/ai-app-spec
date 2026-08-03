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

The canonical archive encoding will be ZIP, whose archive root has the same layout.

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

For reference CLI usage, local package validation, supported runtime adapters, and build and deployment behavior, see [`aiappctl`](../src/aiappctl/README.md).
