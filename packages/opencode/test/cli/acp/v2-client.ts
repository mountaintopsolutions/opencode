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
 * Or run a predefined scenario:
 *   bun run test/cli/acp/v2-client.ts --scenario steering
 *   bun run test/cli/acp/v2-client.ts --scenario resume
 *   bun run test/cli/acp/v2-client.ts --scenario config-options
 *   bun run test/cli/acp/v2-client.ts --scenario cancel
 *   bun run test/cli/acp/v2-client.ts --sequence file-then-list
 *
 * Or with a specific cwd:
 *   bun run test/cli/acp/v2-client.ts --cwd /path/to/project "say hello"
 *
 * Or to test session/resume with replay:
 *   bun run test/cli/acp/v2-client.ts --resume <sessionId> "continue"
 *
 * Or with a custom opencode binary:
 *   bun run test/cli/acp/v2-client.ts --binary /path/to/opencode "say hello"
 *
 * Or with a specific model (writes opencode.json in cwd):
 *   bun run test/cli/acp/v2-client.ts --model opencode/big-pickle "say hello"
 */
import { client, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
let cwd = process.cwd()
let resumeSessionId: string | undefined
let promptText = "say hello"
let steerText: string | undefined
let binary = "opencode"
let steerDelayMs = 3000
let scenario: string | undefined
let sequence: string | undefined
let model: string | undefined

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
  } else if (args[i] === "--scenario" && args[i + 1]) {
    scenario = args[i + 1]
    i++
  } else if (args[i] === "--sequence" && args[i + 1]) {
    sequence = args[i + 1]
    i++
  } else if (args[i] === "--model" && args[i + 1]) {
    model = args[i + 1]
    i++
  } else {
    promptText = args[i]
  }
}

function createChild(workCwd: string) {
  if (model) {
    const config = { model }
    writeFileSync(path.join(workCwd, "opencode.json"), JSON.stringify(config, null, 2))
  }
  return spawn(binary, ["acp"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, OPENCODE_EXPERIMENTAL_ACP_V2: "1" },
    cwd: workCwd,
  })
}

function createStream(child: ReturnType<typeof spawn>) {
  const stdout = child.stdout
  const stdin = child.stdin
  if (!stdout || !stdin) throw new Error("child stdio not available")
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      stdout.on("end", () => controller.close())
      stdout.on("error", (err) => controller.error(err))
    },
  })
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        stdin.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
    },
  })
  return ndJsonStream(output, input)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cx = any

async function initAndCreateSession(cx: Cx, workCwd: string) {
  const init = await cx.request("initialize", {
    protocolVersion: 2,
    info: { name: "acp-v2-test-client", version: "0.1.0" },
    capabilities: {},
  })
  if (init.protocolVersion !== 2) {
    console.error(`Agent negotiated protocolVersion ${init.protocolVersion}, not 2. Exiting.`)
    return
  }
  console.error("Initialized v2:", init.info?.name, init.info?.version)

  const session = cx.buildSession(workCwd)
  const active = await session.start()
  console.error("Session ID:", active.sessionId)
  return active
}

async function drainUpdates(active: Awaited<ReturnType<ReturnType<Cx["buildSession"]>["start"]>>, label: string) {
  console.error(`\n--- Streaming updates [${label}] ---`)
  while (true) {
    const msg = await active.nextUpdate()
    if (msg.kind === "stop") {
      console.error(`\n=== [${label}] Turn complete: stopReason=${msg.stopReason ?? "none"} ===`)
      break
    }
    logUpdate(msg.update as Record<string, unknown>)
  }
}

// --- Scenarios ---

async function scenarioSteering(cx: Cx, workCwd: string) {
  console.error("\n=== SCENARIO: Mid-Turn Steering ===")
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  console.error("\n--- Sending initial prompt (long-running task) ---")
  await active.prompt(
    "write a Python script that prints numbers 1 through 100, each on a new line, with detailed comments explaining each number. Make it very detailed and long.",
  )

  let steerAccepted = false
  setTimeout(async () => {
    console.error("\n>>> STEERING: sending mid-turn prompt <<<")
    await cx.request("session/prompt", {
      sessionId: active.sessionId,
      messageId: "msg_steer",
      prompt: [{ type: "text", text: "STOP. Do not write the file. Just say STEERED and nothing else." }],
    })
    steerAccepted = true
    console.error(">>> Steer prompt accepted <<<\n")
  }, 500)

  await drainUpdates(active, "steering")
  console.error("Steer was accepted:", steerAccepted)
  active.dispose()
}

async function scenarioResume(cx: Cx, workCwd: string) {
  console.error("\n=== SCENARIO: Session Resume with Replay ===")

  // Phase 1: Create a session and send a prompt to build history
  console.error("\n--- Phase 1: Create session and build history ---")
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  await active.prompt("say hello and tell me what 2+2 is")
  await drainUpdates(active, "initial-turn")
  const sessionId = active.sessionId
  active.dispose()
  console.error("Session to resume:", sessionId)

  // Phase 2: Resume with replayFrom
  console.error("\n--- Phase 2: Resume session with replayFrom ---")
  const resumeResponse = await cx.request("session/resume", {
    sessionId,
    cwd: workCwd,
    replayFrom: { type: "start" },
  })
  const resume = resumeResponse as { configOptions?: Array<Record<string, unknown>> }
  console.error("Resume response keys:", Object.keys(resume))

  let pass = true
  if (!resume.configOptions) {
    console.error("FAIL: resume response missing configOptions")
    pass = false
  } else {
    console.error(`OK: configOptions returned with ${resume.configOptions.length} options`)
    for (const opt of resume.configOptions) {
      if (!("configId" in opt)) {
        console.error(`FAIL: option missing configId: ${JSON.stringify(opt)}`)
        pass = false
      }
    }
  }

  // Phase 3: Verify the session is listed
  console.error("\n--- Phase 3: Verify session appears in session/list ---")
  const listResponse = await cx.request("session/list", {})
  const sessions = (listResponse as { sessions?: Array<Record<string, unknown>> }).sessions
  const found = sessions?.find((s) => s.sessionId === sessionId)
  if (found) {
    console.error(`OK: session ${sessionId} found in list`)
  } else {
    console.error(`FAIL: session ${sessionId} not found in list`)
    pass = false
  }

  console.error(pass ? "\nPASS: Resume scenario" : "\nFAIL: Resume scenario")
}

async function scenarioConfigOptions(cx: Cx, workCwd: string) {
  console.error("\n=== SCENARIO: Config Options (v2 configId naming) ===")
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  const options = active.configOptions
  if (!options) {
    console.error("FAIL: No config options returned")
    return
  }

  let pass = true
  for (const option of options) {
    const opt = option as Record<string, unknown>
    if (!("configId" in opt)) {
      console.error(`FAIL: option missing configId: ${JSON.stringify(opt)}`)
      pass = false
    } else {
      console.error(`OK: configId="${opt.configId}" category=${opt.category ?? "?"} type=${opt.type}`)
    }
    if ("id" in opt) {
      console.error(`FAIL: option has v1 "id" field instead of configId: ${opt.id}`)
      pass = false
    }
  }

  // Test set_config_option
  const modeOption = options.find((o: Record<string, unknown>) => o.configId === "mode") as
    { configId: string; currentValue: string; options: Array<{ value: string }> } | undefined
  if (modeOption) {
    const altValue = modeOption.options.find((o) => o.value !== modeOption.currentValue)?.value
    if (altValue) {
      console.error(`\n--- Setting mode from "${modeOption.currentValue}" to "${altValue}" ---`)
      const result = await cx.request("session/set_config_option", {
        sessionId: active.sessionId,
        configId: "mode",
        type: "id",
        value: altValue,
      })
      const newOptions = (result as { configOptions?: Array<Record<string, unknown>> }).configOptions
      const newMode = newOptions?.find((o) => o.configId === "mode")
      console.error("New mode value:", newMode?.currentValue)
      if (newMode?.currentValue === altValue) {
        console.error("OK: config option updated")
      } else {
        console.error("FAIL: config option not updated")
        pass = false
      }
    }
  }

  console.error(pass ? "\nPASS: Config options scenario" : "\nFAIL: Config options scenario")
  active.dispose()
}

async function scenarioCancel(cx: Cx, workCwd: string) {
  console.error("\n=== SCENARIO: Cancel Mid-Turn ===")
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  console.error("\n--- Sending long-running prompt ---")
  await active.prompt(
    "create a Python file called essay.py that prints a very long essay about the history of computing, at least 5000 words, with detailed sections. Then run it to verify the output.",
  )

  // Cancel as soon as we see state_update: running
  console.error("\n--- Streaming updates (will cancel on first running) ---")
  let gotCancelled = false
  let cancelSent = false
  while (true) {
    const msg = await active.nextUpdate()
    if (msg.kind === "stop") {
      const stopReason = (msg.update as Record<string, unknown>).stopReason as string | undefined
      console.error(`\n=== Turn complete: stopReason=${stopReason ?? "none"} ===`)
      if (stopReason === "cancelled") {
        gotCancelled = true
        console.error("OK: received stopReason=cancelled")
      } else if (!cancelSent) {
        console.error(`NOTE: model finished before cancel was sent (stopReason=${stopReason})`)
      } else {
        console.error(`FAIL: expected stopReason=cancelled, got ${stopReason}`)
      }
      break
    }
    const update = msg.update as Record<string, unknown>
    logUpdate(update)
    if (!cancelSent && update.sessionUpdate === "state_update" && update.state === "running") {
      console.error("\n>>> CANCELLING (on first running) <<<")
      await cx.notify("session/cancel", { sessionId: active.sessionId })
      cancelSent = true
      console.error(">>> Cancel notification sent <<<\n")
    }
  }

  console.error(
    gotCancelled ? "\nPASS: Cancel scenario" : "\nFAIL: Cancel scenario (model may have finished too quickly)",
  )
  active.dispose()
}

async function sequenceFileThenList(cx: Cx, workCwd: string) {
  console.error("\n=== SEQUENCE: File Write + Tool Calls + Terminal Update ===")
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  // Prompt that triggers file write (edit tool) and bash (terminal_update)
  await active.prompt(
    "create a file called test.txt with the content 'hello from v2', then run 'cat test.txt' to verify it was created",
  )
  await drainUpdates(active, "file+terminal")

  // Verify the file was created
  const filePath = path.join(workCwd, "test.txt")
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8")
    console.error(`\nFile exists: test.txt content="${content.trim()}"`)
    if (content.includes("hello from v2")) {
      console.error("OK: file content matches")
    } else {
      console.error("FAIL: file content mismatch")
    }
  } else {
    console.error("NOTE: file not found (model may not have used tools)")
  }

  // List sessions
  console.error("\n--- Listing sessions ---")
  const sessions = await cx.request("session/list", {})
  const sessionList = (sessions as { sessions?: Array<Record<string, unknown>> }).sessions
  console.error(`Found ${sessionList?.length ?? 0} session(s)`)
  for (const s of sessionList ?? []) {
    console.error(`  ${s.sessionId} (cwd: ${s.cwd ?? "?"})`)
  }

  active.dispose()
}

async function scenarioBatchInit(cx: Cx, workCwd: string, child: ReturnType<typeof spawn>) {
  console.error("\n=== SCENARIO: JSON-RPC Batch Support ===")
  // The SDK's client batch() only allows custom _-prefixed methods.
  // Test batch at the raw wire level by writing a JSON-RPC batch array to stdin
  // and reading the batch response from stdout.
  const active = await initAndCreateSession(cx, workCwd)
  if (!active) return

  console.error("\n--- Sending raw batch: two session/list requests ---")
  // Write a JSON-RPC batch array directly to the child process stdin
  const batchPayload =
    JSON.stringify([
      { jsonrpc: "2.0", id: "batch-1", method: "session/list", params: {} },
      { jsonrpc: "2.0", id: "batch-2", method: "session/list", params: {} },
    ]) + "\n"

  const stdin = child.stdin
  if (!stdin) throw new Error("stdin not available")

  // Write raw batch to stdin
  await new Promise<void>((resolve, reject) => {
    stdin.write(batchPayload, (err) => (err ? reject(err) : resolve()))
  })

  // Read raw lines from stdout until we get both batch responses
  const stdout = child.stdout
  if (!stdout) throw new Error("stdout not available")

  let batchResults = 0
  const collected: unknown[] = []
  const lineBuffer: Buffer[] = []
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      lineBuffer.push(chunk)
      const text = Buffer.concat(lineBuffer).toString("utf8")
      const lines = text.split("\n")
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const parsed = JSON.parse(line)
          if (Array.isArray(parsed)) {
            batchResults = parsed.length
            collected.push(...parsed)
            stdout.off("data", onData)
            resolve()
            return
          }
        } catch {
          // Not JSON or partial line
        }
      }
      // Keep the last partial line
      lineBuffer.length = 0
      lineBuffer.push(Buffer.from(lines[lines.length - 1]))
    }
    stdout.on("data", onData)
    setTimeout(() => {
      stdout.off("data", onData)
      resolve()
    }, 10000)
  })

  console.error(`Batch returned ${batchResults} results`)
  for (const result of collected) {
    const r = result as { id?: string; result?: { sessions?: unknown[] } }
    console.error(`  ${r.id}: sessions=${r.result?.sessions?.length ?? 0}`)
  }
  if (batchResults === 2) {
    console.error("OK: batch processed both requests")
  } else {
    console.error(`FAIL: expected 2 results, got ${batchResults}`)
  }

  active.dispose()
}

// --- Main ---

const child = createChild(cwd)
const stream = createStream(child)
const app = client({ name: "acp-v2-test-client" })

await app.connectWith(stream, async (cx) => {
  console.error("=== ACP v2 Test Client ===")

  if (scenario) {
    const tmp = mkdtempSync(path.join(tmpdir(), "acp-v2-test-"))
    console.error("Using temp dir:", tmp)
    try {
      switch (scenario) {
        case "steering":
          await scenarioSteering(cx, tmp)
          break
        case "resume":
          await scenarioResume(cx, tmp)
          break
        case "config-options":
          await scenarioConfigOptions(cx, tmp)
          break
        case "cancel":
          await scenarioCancel(cx, tmp)
          break
        case "batch":
          await scenarioBatchInit(cx, tmp, child)
          break
        default:
          console.error(`Unknown scenario: ${scenario}`)
          console.error("Available: steering, resume, config-options, cancel, batch")
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else if (sequence) {
    const tmp = mkdtempSync(path.join(tmpdir(), "acp-v2-test-"))
    console.error("Using temp dir:", tmp)
    try {
      switch (sequence) {
        case "file-then-list":
          await sequenceFileThenList(cx, tmp)
          break
        default:
          console.error(`Unknown sequence: ${sequence}`)
          console.error("Available: file-then-list")
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } else if (resumeSessionId) {
    console.error(`\n--- Resuming session ${resumeSessionId} with replay ---`)
    const response = await cx.request("session/resume", {
      sessionId: resumeSessionId,
      cwd,
      replayFrom: { type: "start" },
    })
    console.error("Resume response:", JSON.stringify(response, null, 2))

    console.error(`\n--- Sending prompt: "${promptText}" ---`)
    await cx.request("session/prompt", {
      sessionId: resumeSessionId,
      messageId: "msg_resume_1",
      prompt: [{ type: "text", text: promptText }],
    })

    console.error("\n--- Streaming updates ---")
    const session = cx.buildSession(cwd)
    const active = await session.start()
    while (true) {
      const msg = await active.nextUpdate()
      if (msg.kind === "stop") {
        console.error(`\n=== Turn complete: stopReason=${msg.stopReason ?? "none"} ===`)
        break
      }
      logUpdate(msg.update as Record<string, unknown>)
    }
    active.dispose()
  } else {
    console.error("\n--- Creating new session ---")
    const session = cx.buildSession(cwd)
    const active = await session.start()
    console.error("Session ID:", active.sessionId)

    console.error(`\n--- Sending prompt: "${promptText}" ---`)
    await active.prompt(promptText)

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
  }

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
