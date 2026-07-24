# V0 plan — human approval for Claude Managed Agent MCP tools

- **Status:** implemented
- **Date:** 2026-07-24
- **Area:** `commands/mcp/`

## Goal

When the Product Manager Agent calls a Linear MCP tool configured as `always_ask`, pause `product-manager`, ask the human in Claude Code to allow or deny that call, send the decision to the Managed Agent session, and return the Agent's final text.

That is the entire v0.

## V0 constraints

- Claude Code is the only supported MCP client.
- Only `agent.mcp_tool_use` requires approval.
- One or more blocking tool calls may be pending in a pause.
- Each pending call receives an independent, numbered approval dialog.
- All decisions from a pause are submitted together before the Agent resumes.
- A session may pause for approval more than once.
- Approval uses MCP form-mode elicitation.
- The dialog shows the MCP server name, tool name, and argument **keys**. It does not show argument values.
- The form returns one explicit decision: `allow` or `deny`.
- Elicitation `decline`, `cancel`, or failure maps to `deny`.
- After either decision, the Agent resumes and `product-manager` returns its final text.
- Existing five-minute Agent execution timeout remains. Time spent in the human approval dialog does not consume that execution budget.
- No permission concepts are added to the AI App schema.

If a pause contains no blocking calls or references malformed calls, v0 denies every valid referenced call and returns a clear unsupported-state error. It never silently approves.

## Confirmed provider behavior

- MCP toolsets default to `always_ask`.
- A gated call emits `agent.mcp_tool_use`.
- The session becomes idle with `stop_reason.type: "requires_action"` and the blocking event ID in `stop_reason.event_ids`.
- Send a `user.tool_confirmation` event to `POST /v1/sessions/{session_id}/events`.
- The confirmation uses the blocking event ID as `tool_use_id` and `result: "allow"` or `"deny"`.
- Once the blocking call is resolved, the session returns to `running`.
- Claude Code supports MCP form-mode elicitation.

## Minimal boundary

Extend the executor with one runtime-neutral callback:

```js
options.execute(prompt, {
  requestApproval,
})
```

`server.js` owns MCP elicitation:

```js
requestApproval({
  serverName,
  toolName,
  argumentKeys,
}) -> "allow" | "deny"
```

`runtimes/claude.js` owns the provider state machine:

```text
create session
  → poll until idle
  → end_turn: return Agent text
  → requires_action:
      load every referenced agent.mcp_tool_use event
      request approval for each
      post all user.tool_confirmation events together
      repeat
```

No MCP request types belong in the Claude adapter. No Anthropic event types belong in the MCP server.

## Verification inputs

### 1. Real `agent.mcp_tool_use` shape

Trigger the Product Manager's Linear tool and capture the referenced event. Confirm the exact fields for:

- MCP server name,
- tool name,
- arguments,
- event ID.

Record a sanitized fixture for tests.

### 2. Claude Code approval dialog

Expose a temporary tool that calls `elicitInput()` with:

```json
{
  "decision": "allow | deny"
}
```

Verify `accept`, `decline`, and `cancel` against the installed Claude Code client. Lock the smallest form that makes the decision unambiguous.

## Implementation slices

1. Change the executor boundary to accept `requestApproval`.
2. Add a parser for referenced `agent.mcp_tool_use` events.
3. Replace the current `requires_action` error with the approval loop.
4. Implement Claude Code form elicitation in `server.js`.
5. Add tests for allow, deny, decline/cancel mapping, repeated sequential pauses, approval batches, and fail-closed behavior.
6. Run one live Product Manager → Linear approval round trip.

## V0 failure behavior

| Condition | Behavior |
| --- | --- |
| Human allows | Confirm `allow`, resume Agent |
| Human denies | Confirm `deny`, resume Agent |
| Human declines or cancels | Confirm `deny`, resume Agent |
| Elicitation fails | Best-effort confirm `deny`, return MCP error |
| No pending event | Return unsupported-state error |
| Several pending events | Ask for each decision, confirm as one batch |
| Unsupported event type | Deny the referenced event, return unsupported-state error |
| Agent execution times out | Return the existing timeout error |

## Definition of done

- A `product-manager` call can request one or more Linear operations.
- Claude Code shows the human an approval dialog for each operation.
- Allow executes the Linear tool and returns the Agent's final response.
- Deny does not execute the tool and returns the Agent's final response.
- No failure path auto-approves.
- The normal no-tool entrypoint path remains unchanged.

## Nice to have later

- Built-in `agent.tool_use` approvals.
- Displaying selected argument values with a real redaction policy.
- Optional denial explanations.
- MCP clients other than Claude Code.
- Cancellation propagation and Managed Agent session cleanup.
- Approval-specific timeouts.
- Progress notifications and explicit Claude Code timeout configuration.
- Asynchronous MCP Tasks for long-running calls.
- Persistent or resumable sessions across entrypoint calls.
- Approval audit metadata in MCP results.
- Permission policy declarations in the AI App schema.
- Approach C: expose the Managed Agent's tools directly through the local MCP server.

## Sources

- Anthropic permission policies: <https://platform.claude.com/docs/en/managed-agents/permission-policies>
- Anthropic session events: <https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
- Claude Code MCP elicitation: <https://code.claude.com/docs/en/mcp>
- MCP elicitation specification: <https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation>
