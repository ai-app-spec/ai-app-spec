# aiappctl

`aiappctl` is the reference command-line interface for validating, building, and deploying [AI App Spec](../../spec/README.md) packages. It demonstrates how runtime adapters can interpret provider-neutral app resources and bind them to provider-specific infrastructure.

The CLI is an early reference implementation. Its supported package formats, runtimes, and workflows may change while version 0.1 of the specification is a draft.

## Table of contents

- [Setup](#setup)
- [Commands](#commands)
  - [Validate](#validate)
  - [Digest](#digest)
  - [Build](#build)
  - [Deploy](#deploy)
- [Runtimes](#runtimes)
  - [Claude Managed Agents](#claude-managed-agents)
  - [Gemini Enterprise Agent Platform](#gemini-enterprise-agent-platform)
  - [Vercel Eve](#vercel-eve)
- [Development](#development)
- [Related documentation](#related-documentation)

## Setup

[Bun](https://bun.sh/) is required. Install the CLI dependencies from this directory:

```sh
cd src/aiappctl
bun install
```

The examples below assume the current directory is `src/aiappctl`.

## Commands

### Validate

Validate an unpacked app bundle or an individual `app.yaml` manifest:

```sh
bun run validate --package=../../examples/hello-oci
```

Validation parses YAML, applies the versioned app schema, and checks cross-resource invariants. For package-relative Agent implementations, it also ensures the package remains inside the app bundle, exists as a file, and matches its declared SHA-256 digest. External implementation locations are not fetched. Archive creation and validation are not yet supported.

### Digest

Compute the package digest over a file's raw bytes:

```sh
bun ./cli.js digest ../../examples/hello-claude/packages/greeter.agentpkg.yaml
```

The command prints a `sha256:<hex>` value suitable for an implementation package descriptor.

### Build

Compile an app package into a provider project:

```sh
bun ./cli.js build \
  --runtime eve \
  --package ../../examples/product-manager-eve \
  --out /tmp/product-manager-eve
```

`--runtime`, `--package`, and `--out` are required. Eve is currently the only build runtime. See [Vercel Eve](#vercel-eve) for its generated project and rebuild behavior.

### Deploy

Deploy an app package directly to a managed runtime:

```sh
bun run deploy \
  --runtime <claude|gemini> \
  --package <bundle-directory|app.yaml>
```

`--runtime` and `--package` are required. Runtime adapters reject unsupported implementation formats before provider mutation. Provider-specific bindings are supplied as CLI options and are never written into the app package.

The optional `--agent-id` selects an existing provider Agent for update. It currently applies only to apps with exactly one Agent, is not persisted by the CLI, and must be supplied on every update.

Provider failures can leave an Agent created or updated earlier in a multi-resource deployment. The CLI reports the affected provider Agent ID on stderr so the operator can reconcile it.

## Runtimes

| Runtime | Operation | Implementation format |
| --- | --- | --- |
| Claude Managed Agents | Deploy | `anthropic.com/managed-agent:v1` |
| Gemini Enterprise Agent Platform | Deploy | `google.com/managed-agent:v1` |
| Vercel Eve | Build | `vercel.com/eve:v1` |

### Claude Managed Agents

Set an Anthropic API key and deploy the Hello Claude example:

```sh
export ANTHROPIC_API_KEY="your-api-key"
bun run deploy \
  --runtime claude \
  --package=../../examples/hello-claude
```

The Claude adapter accepts `anthropic.com/managed-agent:v1` packages stored inside the app bundle. It parses the implementation YAML and sends Agent definitions through the Managed Agents beta API. Every Agent must use the Claude format when this runtime is selected.

Referenced `MCPServer` resources become `mcp_servers` entries with matching `mcp_toolset` entries. MCP authentication is not embedded in the reusable Agent definition. Deploy the authenticated Product Manager example with pre-provisioned environment and vault bindings:

```sh
export ANTHROPIC_API_KEY="your-anthropic-api-key"
bun run deploy \
  --runtime claude \
  --package=../../examples/product-manager-claude \
  --agent-id agent_... \
  --environment-id env_... \
  --vault-id vlt_...
```

If any referenced MCP server declares authentication, `--vault-id` is required. The vault must belong to the Anthropic workspace selected by `ANTHROPIC_API_KEY` and contain an active `static_bearer` or `mcp_oauth` credential for every authenticated MCP server URL. Before mutating an Agent, the CLI retrieves the vault and verifies the available credential metadata. It never accepts credential values or creates, updates, archives, or deletes vaults and credentials. A missing, archived, or non-conforming vault fails deployment before the first provider mutation.

`--environment-id` binds an execution-environment requirement. The environment must belong to the same Anthropic workspace and must not be archived. When the app requires `networking.mcpServers`, a Claude cloud environment must use unrestricted networking or limited networking with `allow_mcp_servers` enabled. The CLI cannot verify self-hosted egress policy and rejects a self-hosted environment for this requirement. It verifies environments but does not create, update, archive, or delete them.

Environment and vault bindings are consumed through `environment_id` and `vault_ids` when Claude sessions and scheduled deployments are created. The CLI does not yet create either execution, so deployment verifies the bindings but cannot guarantee that a later execution attaches them. Mutable bindings must be checked again when an execution is created.

Without `--agent-id`, deployment creates a new Agent. With it, the adapter retrieves the selected Agent, verifies that it exists and is active, and updates it using its current version for optimistic concurrency control. The CLI does not list or discover existing Agent IDs. External implementation locations remain unsupported.

### Gemini Enterprise Agent Platform

Authenticate with Google Application Default Credentials and deploy the Hello Gemini example:

```sh
gcloud auth application-default login
bun run deploy \
  --runtime gemini \
  --package=../../examples/hello-gemini \
  --project your-google-cloud-project
```

The experimental Gemini adapter accepts `google.com/managed-agent:v1` packages and sends them to the Gemini Enterprise Agent Platform Managed Agents API in the `global` location. The service is currently Pre-GA and intended for testing and evaluation.

Without `--agent-id`, the adapter creates an Agent using the app resource ID as its Google Agent ID. With `--agent-id`, it retrieves and updates that exact Agent. The CLI waits for create operations to complete before retrieving the result and does not list or discover existing Agents.

Referenced `MCPServer` resources become `mcp_server` tools. An execution environment requirement becomes a remote `base_environment`; when `networking.mcpServers` is enabled, its network allowlist contains only the hostnames of the Agent's referenced MCP servers.

Authenticated MCP servers require a binding from the logical secret requirement to a Secret Manager version:

```sh
bun run deploy \
  --runtime gemini \
  --package=../../examples/product-manager-gemini \
  --project your-google-cloud-project \
  --secret-binding \
  linear-access-token=projects/your-google-cloud-project/secrets/linear-access-token/versions/latest
```

`--secret-binding` may be repeated for distinct requirement IDs. The deploying identity needs `secretmanager.versions.access` on each bound secret. Google also requires `roles/mcp.toolUser` for the deploying identity and associated service account. The CLI resolves every required secret before the first Agent mutation and supplies its value as an MCP authorization header without printing it.

To rotate a credential, add a Secret Manager version and deploy again with the same `--agent-id` and an updated binding. The adapter patches the existing Agent's complete tool configuration.

### Vercel Eve

Build the Product Manager example as an [Eve](https://eve.dev/) project:

```sh
bun ./cli.js build \
  --runtime eve \
  --package ../../examples/product-manager-eve \
  --out /tmp/product-manager-eve
```

The experimental `vercel.com/eve:v1` package is a YAML mapping with exactly two fields: a Vercel AI Gateway `model` identifier and Agent `instructions`. The adapter combines them with the app identity, referenced MCP servers, execution requirement, and logical secret requirements. It emits pinned dependencies, one `agent/connections/*.ts` module per MCP server, and an `aiappctl.build.json` provenance record.

Schema v2 of `aiappctl.build.json` records the SHA-256 digest of each generated file. Rebuilding into the same `--out` directory verifies those digests before applying changes. The build stops on local drift, updates changed files, removes obsolete generated files, and preserves unmanaged state such as `.vercel/`, `.env.local`, and lockfiles. Older build-manifest schemas must be rebuilt into a new output directory.

Bearer requirements become environment-variable bindings in generated connection modules. For example, `linear-access-token` becomes `LINEAR_ACCESS_TOKEN`; the generated project never contains its value. Configure the variable in the linked Vercel project before deployment.

Deploy the generated project manually:

```sh
cd /tmp/product-manager-eve
bun install
bunx eve link
bun run build
bun run deploy
```

The generated project does not configure inbound authentication. Eve fails closed in production, so its Agent API rejects unauthenticated requests after deployment; configure an Eve route authenticator before clients can invoke it. The public landing page and health endpoint remain reachable.

The adapter supports exactly one Agent, which must be the app entrypoint. It rejects external implementation locations, unsupported package fields, unreferenced MCP servers, and unused secret requirements rather than silently dropping declarations.

## Development

Run the CLI test suite:

```sh
cd src/aiappctl
bun install
bun test
```

The CLI depends on the local package in [`../../spec`](../../spec/README.md). Changes to schema behavior should include the corresponding specification tests and generated-schema check.

## Related documentation

- [Specification and schema](../../spec/README.md)
- [Concepts](../../docs/concepts.md)
- [Packaging agent implementations](../../docs/packaging.md)
- [Examples](../../examples)
