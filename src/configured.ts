import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createAppService } from './AppService.js'
import { BridgeApi } from './BridgeApi.js'
import { botUserId, loadConfig, loadSecrets } from './config.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MatrixClient } from './MatrixClient.js'
import { PrivacyDesk } from './Privacy.js'
import { Relay } from './Relay.js'
import { Store } from './Store.js'

// Each channel's opt-out list is read again this often, and never faster than one a second.
const OPT_OUTS_MS = 60_000
// Each member frame costs bot-gateway a lookup per channel.
const MEMBER_FRAME_MS = 15_000

/** A bot of one's own, with its pairs in config.json. One pair that cannot be verified stops the start. */
export async function runConfigured(path: string): Promise<{ stop(): Promise<void> }> {
  const config = loadConfig(path)
  const secrets = loadSecrets()
  mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 })
  const store = new Store(config.database)
  const harmony = new HarmonyClient({ ...config.harmony, token: secrets.harmonyToken, memberFrameMs: MEMBER_FRAME_MS })
  const matrix = new MatrixClient({ ...config.matrix, asToken: secrets.asToken, botUserId: botUserId(config) })
  // The bot may serve several Harmony servers: each channel's list is its own server's.
  const privacy: PrivacyDesk = new PrivacyDesk(new BridgeApi(config.harmony.apiUrl, secrets.harmonyToken),
    { oneServer: false, supported: false, onChange: () => relay.requestMemberSync() })
  const relay = new Relay(config, store, harmony, matrix, message => console.warn(message), { privacy })
  let gatewayConnected = false
  let matrixStarted = false
  let closing = false
  let cursor = 0
  // An unread list does not open the gate: Harmony refuses an opted-out author's message.
  const readOptOut = async (channelId: string) => {
    if (gatewayConnected && privacy.supported && !closing) await privacy.load(channelId).catch(() => {})
  }
  const readOptOuts = async () => { for (const pair of config.pairs) await readOptOut(pair.harmonyChannelId) }
  const optOuts = setInterval(() => { void readOptOut(config.pairs[cursor++ % config.pairs.length].harmonyChannelId) },
    Math.max(1000, OPT_OUTS_MS / config.pairs.length))
  const server = createAppService({
    hsToken: secrets.hsToken, botUserId: botUserId(config), ownsGhost: id => store.ownsGhost(id),
    acceptTransaction: (id, events) => relay.acceptTransaction(id, events),
    report: message => console.warn(message),
    status: () => ({ ready: gatewayConnected && matrixStarted && relay.isHealthy, ...store.counts() }),
  })
  harmony.on('ready', data => {
    gatewayConnected = true
    privacy.supported = Array.isArray(data?.capabilities) && data.capabilities.includes('matrix_bridge_v2')
    relay.requestMemberSync()
    void readOptOuts()
    console.info('Harmony gateway connected')
  })
  harmony.on('disconnected', () => { gatewayConnected = false })
  harmony.on('error', () => { gatewayConnected = false; console.warn('Harmony connection error; check connectivity and bot credentials') })
  harmony.on('member', userId => { relay.noteServerMember(userId) })
  harmony.on('message', message => {
    try { relay.acceptHarmonyMessage(message) }
    catch { console.warn('Could not enqueue Harmony message; check local storage and queue capacity') }
  })
  const stop = async () => {
    if (closing) return
    closing = true
    clearInterval(optOuts)
    harmony.stop()
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeIdleConnections()
    await Promise.all([closed, relay.stop()])
    store.close()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.listen.port, config.listen.host, () => { server.off('error', reject); resolve() })
    })
    // Start accepting durable transactions before joining; homeserver callbacks may arrive during startup.
    for (const pair of config.pairs) {
      try { await harmony.requireMatrixBridge(pair.harmonyChannelId) }
      catch {
        console.error('Harmony does not list this bot as the Matrix bridge of every paired channel. In Harmony: Server settings, Bridges, Matrix; choose the bot and tick the channels. The bot needs to read and send in them.')
        throw new Error('Matrix bridge registration required')
      }
    }
    await matrix.ensureRegistered()
    await relay.cleanupUnpairedGhosts()
    for (const pair of config.pairs) {
      const binding = await harmony.bridgeRoom(pair.harmonyChannelId, { room_id: pair.matrixRoomId, initial_sender_mode: pair.senderMode })
      if (binding.room_id !== pair.matrixRoomId) throw new Error('Matrix binding differs from configuration')
      await matrix.joinRoom(pair.matrixRoomId)
      if (!await matrix.roomIsPlaintext(pair.matrixRoomId) || !await harmony.channelIsPlaintext(pair.harmonyChannelId)) {
        throw new Error('A paired room/channel is encrypted or its policy cannot be verified')
      }
    }
    matrixStarted = true
    harmony.start()
    relay.start()
    console.info('Experimental plaintext relay started; encrypted rooms and people who opted out are not relayed')
    return { stop }
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}
