import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchDshBridge } from '../server/bridge-client.js'
import { DSH_BRIDGE_SOURCE } from '../server/generated-bridge.js'
import type { DshSessionEvent, DshStreamFrame } from '../shared/bridge-protocol.js'

const PROMPT = 'Reply with exactly PASEO_DSH_ALPHA_OK. Do not use tools.'
const WAIT_MS = 120_000
const promptMode = process.argv.slice(2)
if (promptMode.length > 1 || (promptMode.length === 1 && promptMode[0] !== '--prompt')) {
  console.error('Usage: npm run smoke:bridge [-- --prompt]')
  process.exitCode = 2
} else {
  await run(promptMode[0] === '--prompt')
}

async function run(withPrompt: boolean): Promise<void> {
  const bridge = await launchDshBridge({
    bridgeSource: DSH_BRIDGE_SOURCE,
    executable: process.env.PASEO_DSH_EXECUTABLE,
    profile: process.env.PASEO_DSH_PROFILE,
  })
  try {
    const initialized = bridge.initialized
    const sessions = await bridge.request('session.list', {})
    console.log(JSON.stringify({
      profile: initialized.profile,
      modelCount: initialized.catalog.models.length,
      preset: initialized.catalog.defaultPreset,
      historyCount: sessions.sessions.length,
    }))
    if (withPrompt) await runPrompt(bridge)
  } finally {
    await bridge.close()
  }
}

async function runPrompt(bridge: Awaited<ReturnType<typeof launchDshBridge>>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'paseo-dsh-alpha-'))
  const frames: DshStreamFrame[] = []
  const events: DshSessionEvent[] = []
  let sessionId: string | undefined
  let sawIdle = false
  let sawEnd = false
  const offStream = bridge.on('session.stream', value => {
    if (value.sessionId !== sessionId) return
    frames.push(value.frame)
    if (value.frame.type === 'end') sawEnd = true
  })
  const offEvent = bridge.on('session.event', value => {
    if (value.sessionId !== sessionId) return
    events.push(value.event)
  })
  const offStatus = bridge.on('session.status', value => {
    if (value.sessionId === sessionId && value.status === 'idle') sawIdle = true
  })
  try {
    const opened = await bridge.request('session.open', { cwd })
    sessionId = opened.sessionId
    await bridge.request('session.prompt', { sessionId, content: [{ type: 'text', text: PROMPT }] })
    await waitFor(() => sawIdle && sawEnd && containsAlphaOk(events))
    const first = await bridge.request('session.read', { sessionId })
    await bridge.request('session.close', { sessionId })
    const resumed = await bridge.request('session.open', { sessionId, resume: true, cwd })
    const second = await bridge.request('session.read', { sessionId: resumed.sessionId })
    if (second.events.length < first.events.length || !second.events.some(event => event.type === 'assistant/message')) {
      throw new Error('resumed session history validation failed')
    }
    await bridge.request('session.close', { sessionId })
    console.log(JSON.stringify({
      prompt: true,
      sessionId,
      streamFrames: frames.length,
      turnEvents: events.filter(event => event.type === 'turn/start' || event.type === 'turn/end').length,
      historyCount: second.events.length,
      cwdRetained: true,
    }))
  } finally {
    offStream()
    offEvent()
    offStatus()
    if (sessionId) await bridge.request('session.close', { sessionId }).catch(() => undefined)
  }
}

function containsAlphaOk(events: DshSessionEvent[]): boolean {
  // The input itself contains the marker: only assistant text proves a response.
  return events.some(event => {
    if (event.type !== 'assistant/message') return false
    const message = event.data.message
    if (!message || typeof message !== 'object' || !('content' in message)) return false
    if (!Array.isArray(message.content)) return false
    return message.content.some(block =>
      block?.type === 'text' && typeof block.text === 'string'
      && block.text.includes('PASEO_DSH_ALPHA_OK'))
  })
}

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!done()) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`bridge smoke timed out after ${WAIT_MS}ms`)
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 250)))
  }
}
