# ACP v2 Test Client

Standalone test client for exercising opencode's ACP v2 draft implementation against a live opencode binary. Spawns an opencode `acp` process, negotiates v2, and exercises all implemented v2 features.

## Prerequisites

- Built opencode binary: `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- `OPENCODE_EXPERIMENTAL_ACP_V2` env var is set automatically by the test client
- A model configured (via `--model` flag, or existing opencode auth)

## Quick Start

```bash
# From packages/opencode
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  "say hello"
```

## Flags

| Flag                   | Description                              | Default                      |
| ---------------------- | ---------------------------------------- | ---------------------------- |
| `--binary <path>`      | Path to opencode binary                  | `opencode`                   |
| `--model <id>`         | Model ID (writes `opencode.json` in cwd) | None (uses opencode default) |
| `--cwd <path>`         | Working directory for the session        | Current directory            |
| `--scenario <name>`    | Run a predefined test scenario           | None                         |
| `--sequence <name>`    | Run a multi-step sequence                | None                         |
| `--steer <text>`       | Send a steering prompt mid-turn          | None                         |
| `--steer-delay <ms>`   | Delay before sending steer               | `3000`                       |
| `--resume <sessionId>` | Resume an existing session with replay   | None                         |
| `<prompt>`             | Positional — the prompt text             | `"say hello"`                |

## Scenarios

Each scenario creates a temp directory, runs against a live opencode instance, and prints PASS/FAIL results.

### `--scenario steering`

Tests mid-turn steering. Sends a long-running prompt, then 500ms later sends a second `session/prompt` while the turn is still running. Verifies:

- Second `session/prompt` is accepted (returns `{}`)
- `user_message` notification emitted for the steer with a new `messageId`
- `state_update: running` re-emitted after the steer
- Turn completes with `stopReason: end_turn`

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --scenario steering
```

### `--scenario cancel`

Tests mid-turn cancellation. Sends a long-running prompt, then sends `session/cancel` notification on the first `state_update: running`. Verifies:

- Turn completes with `stopReason: cancelled`

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --scenario cancel
```

### `--scenario config-options`

Tests v2 config option naming and mutation. Verifies:

- All config options use `configId` (not v1 `id`)
- Options have correct categories (`model`, `thought_level`, `mode`)
- `session/set_config_option` with `type: "id"` updates the value
- Response returns updated `configOptions`

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --scenario config-options
```

### `--scenario resume`

Tests session resume with replay. Creates a session, sends a prompt to build history, then calls `session/resume` with `replayFrom: { type: "start" }`. Verifies:

- Resume response contains `configOptions`
- All options have `configId`
- Session appears in `session/list` after resume

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --scenario resume
```

### `--scenario batch`

Tests JSON-RPC batch support. Sends a raw JSON-RPC batch array (two `session/list` requests) directly to the agent's stdin, bypassing the SDK. Verifies:

- Server returns a batch array with 2 results
- Each result contains the session list

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --scenario batch
```

## Sequences

### `--sequence file-then-list`

Tests tool calls, terminal updates, and session listing. Sends a prompt that should trigger file write and bash tool use, then lists all sessions. Verifies:

- Turn completes successfully
- `session/list` returns the active session
- File creation (if the model used tools)

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --sequence file-then-list
```

## Manual Usage

### Basic prompt

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  "explain what ACP v2 is"
```

### Mid-turn steering (inline)

```bash
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  --steer "STOP. Just say STEERED." --steer-delay 500 \
  "write a detailed Python script that prints 1-100 with comments"
```

### Resume an existing session

```bash
# First run creates a session — note the Session ID from output
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --model opencode/big-pickle \
  "remember the number 42"

# Resume with replay
bun run test/cli/acp/v2-client.ts \
  --binary ./dist/opencode-darwin-arm64/bin/opencode \
  --resume ses_xxxxxxxxxxxxxxxxxxxxx "what number did I tell you?"
```

## ACP v2 Features Exercised

| Feature                                | Scenario / Flag                                  | What it tests                                             |
| -------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `initialize` with `protocolVersion: 2` | All scenarios                                    | v2 negotiation, capabilities, auth methods                |
| `session/new`                          | All scenarios                                    | Session creation with `cwd`                               |
| `session/prompt` (async)               | All scenarios                                    | Prompt acceptance returns `{}`, not `userMessageId`       |
| `state_update` notifications           | All scenarios                                    | `running` on busy, `idle` with `stopReason` on completion |
| Mid-turn steering                      | `--scenario steering`, `--steer`                 | Second `session/prompt` admitted mid-turn                 |
| `session/cancel`                       | `--scenario cancel`                              | Cancel notification → `stopReason: cancelled`             |
| Config options with `configId`         | `--scenario config-options`                      | v2 naming (not v1 `id`)                                   |
| `session/set_config_option`            | `--scenario config-options`                      | `type: "id"` discriminator                                |
| `session/resume` with `replayFrom`     | `--scenario resume`, `--resume`                  | Replay from start                                         |
| `session/list`                         | `--scenario resume`, `--sequence file-then-list` | List sessions                                             |
| JSON-RPC batch                         | `--scenario batch`                               | Batch array on stdin                                      |
| `user_message` notification            | All scenarios                                    | `messageId` acknowledgment                                |
| `agent_message_chunk`                  | All scenarios                                    | Streaming text chunks                                     |
| `tool_call_update`                     | `--sequence file-then-list`                      | Tool call create+patch (not `tool_call`)                  |
| `terminal_update`                      | `--sequence file-then-list`                      | Bash tool terminal output                                 |
| `available_commands_update`            | All scenarios                                    | Slash command list                                        |
| `usage_update`                         | All scenarios                                    | Token usage                                               |
| `config_option_update`                 | All scenarios                                    | Config change notifications                               |

## Notification Log Format

The client logs each `session/update` notification as it arrives:

```
[user_message] messageId=msg_0371a4ef2001...
[state_update] state=running
[agent_message_chunk] Hello! ACP v2 is...
[tool_call_update] id=call_1 status=running title=Write file
[terminal_update] terminalId=term_1 command=cat test.txt
[plan_update] planId=plan_1 entries=3
[available_commands_update] 5 commands
[usage_update]
=== Turn complete: stopReason=end_turn ===
```
