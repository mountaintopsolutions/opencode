#!/usr/bin/env bun
/**
 * ACP v2 test client — spawns an opencode acp instance, negotiates v2,
 * creates a session, sends a prompt, and streams all session/update
 * notifications until the turn completes.
 *
 * Usage:
 *   bun run test/cli/acp/v2-client.ts "say hello"
 *
 * Or with mid-turn steering:
 *   bun run test/cli/acp/v2-client.ts --steer "actually say goodbye instead" "say hello"
 *
 * Or with a specific cwd:
 *   bun run test/cli/acp/v2-client.ts --cwd /path/to/project "say hello"
 *
 * Or to test session/resume with replay:
 *   bun run test/cli/acp/v2-client.ts --resume <sessionId> "continue"
 *
 * Or with a custom opencode binary:
 *   bun run test/cli/acp/v2-client.ts --binary /path/to/opencode "say hello"
 */
import { client, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2"
import { spawn } from "node:child_process"

const args = process.argv.slice(2)
let cwd = process.cwd()
let resumeSessionId: string | undefined
let promptText = "say hello"
let steerText: string | undefined
let binary = "opencode"
let steerDelayMs = 3000

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd" && args[i + 1]) {
    cwd = args[i + 1]
    i++
  } else if (args[i] === "--resume" && args[i + 1]) {
    resumeSessionId = args[i + 1]
    i++
  } else if (args[i] === "--binary" && args[i + 1]) {
    binary = args[i + 1]
    i++
  } else if (args[i] === "--steer" && args[i + 1]) {
    steerText = args[i + 1]
    i++
  } else if (args[i] === "--steer-delay" && args[i + 1]) {
    steerDelayMs = Number(args[i + 1])
    i++
  } else {
    promptText = args[i]
  }
}

const child = spawn(binary, ["acp"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, OPENCODE_EXPERIMENTAL_ACP_V2: "1" },
  cwd,
})

const input = new ReadableStream<Uint8Array>({
  start(controller) {
    child.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
    child.stdout.on("end", () => controller.close())
    child.stdout.on("error", (err) => controller.error(err))
  },
})

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(chunk, (err) => (err ? reject(err) : resolve()))
    })
  },
})

const stream = ndJsonStream(output, input)
const app = client({ name: "acp-v2-test-client" })

await app.connectWith(stream, async (cx) => {
  console.error("=== ACP v2 Test Client ===")

  const init = await cx.request("initialize", {
    protocolVersion: 2,
    info: { name: "acp-v2-test-client", version: "0.1.0" },
    capabilities: {},
  })
  console.error("Initialized:", JSON.stringify(init, null, 2))

  if (init.protocolVersion !== 2) {
    console.error(`Agent negotiated protocolVersion ${init.protocolVersion}, not 2. Exiting.`)
    return
  }

  console.error("\n--- Creating new session ---")
  const session = cx.buildSession(cwd)
  const active = await session.start()
  console.error("Session ID:", active.sessionId)

  console.error(`\n--- Sending prompt: "${promptText}" ---`)
  await active.prompt(promptText)

  // If steering is requested, send a second prompt mid-turn after a delay
  let steerSent = false
  if (steerText) {
    setTimeout(async () => {
      console.error(`\n>>> STEERING: "${steerText}" <<<\n`)
      await cx.request("session/prompt", {
        sessionId: active.sessionId,
        messageId: "msg_steer_1",
        prompt: [{ type: "text", text: steerText }],
      })
      steerSent = true
      console.error(">>> Steer prompt accepted <<<\n")
    }, steerDelayMs)
  }

  console.error("\n--- Streaming updates ---")
  while (true) {
    const msg = await active.nextUpdate()
    if (msg.kind === "stop") {
      console.error(`\n=== Turn complete: stopReason=${msg.stopReason ?? "none"} ===`)
      if (steerText && !steerSent) {
        console.error("(steer was not sent before turn completed — increase --steer-delay)")
      }
      break
    }
    logUpdate(msg.update as Record<string, unknown>)
  }

  active.dispose()
  console.error("\n--- Done ---")
  child.kill()
  process.exit(0)
})

function logUpdate(update: Record<string, unknown>) {
  const sessionUpdate = update.sessionUpdate as string
  switch (sessionUpdate) {
    case "state_update":
      console.error(`[state_update] state=${update.state}`)
      break
    case "user_message":
      console.error(`[user_message] messageId=${update.messageId}`)
      break
    case "agent_message_chunk": {
      const content = update.content as { type?: string; text?: string } | undefined
      process.stderr.write(`[agent_message_chunk] ${content?.type === "text" ? content.text : ""}`)
      break
    }
    case "agent_message":
      console.error(`[agent_message] messageId=${update.messageId}`)
      break
    case "agent_thought_chunk": {
      const content = update.content as { type?: string; text?: string } | undefined
      process.stderr.write(`[agent_thought_chunk] ${content?.type === "text" ? content.text : ""}`)
      break
    }
    case "tool_call_update":
      console.error(
        `[tool_call_update] id=${update.toolCallId} status=${update.status ?? "?"} title=${update.title ?? ""}`,
      )
      break
    case "plan_update": {
      const plan = update.plan as { planId?: string; entries?: unknown[] } | undefined
      console.error(`[plan_update] planId=${plan?.planId} entries=${plan?.entries?.length ?? 0}`)
      break
    }
    case "terminal_update":
      console.error(`[terminal_update] terminalId=${update.terminalId} command=${update.command}`)
      break
    case "terminal_output_chunk":
      console.error(`[terminal_output_chunk] terminalId=${update.terminalId}`)
      break
    case "available_commands_update": {
      const commands = update.availableCommands as unknown[] | undefined
      console.error(`[available_commands_update] ${commands?.length ?? 0} commands`)
      break
    }
    case "config_option_update":
      console.error(`[config_option_update]`)
      break
    case "usage_update":
      console.error(`[usage_update]`)
      break
    default:
      console.error(`[${sessionUpdate}]`)
  }
}
