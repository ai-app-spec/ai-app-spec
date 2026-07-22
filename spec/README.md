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

`deploy` selects a provider adapter from each Agent resource's implementation format. The only currently supported runtime is `claude`, which accepts `anthropic.com/managed-agent:v1` packages stored inside the app bundle. The adapter parses the package YAML and sends it to Anthropic's `POST /v1/agents` endpoint using the Managed Agents beta API. Every Agent resource must use that format when `--runtime claude` is selected; deployment fails during preflight if any resource declares a different format.

This initial implementation creates Agent resources only and does not yet compose validated `MCPServer` resources into provider requests. It also does not create environments or sessions, persist deployment state, reconcile an existing Agent, or resolve external package locations. Each successful command invocation therefore creates a new Managed Agent. All deployable resources are validated and locally prepared before the first API request, but provider failures can still leave resources created earlier in a multi-resource app; their IDs are reported on stderr.
