import { writeFileSync } from 'node:fs'
import { guardProcess, watchEventLoop } from './Boundary.js'
import { BridgeHost } from './BridgeHost.js'
import { loadConfig, loadSecrets, registration } from './config.js'
import { runConfigured } from './configured.js'
import { CredentialsError, serviceTokens, writeRegistration } from './credentials.js'
import { findConfigPath, planLaunch, type LaunchPlan } from './env.js'
import { askOnTerminal, login, LoginError } from './login.js'
import { FatalConfigError, ManagedBridge } from './managed.js'
import { packageVersion } from './version.js'

// A JSON document is also valid YAML. Never print application-service secrets to stdout.
function writeRegistrationFile(plan: Exclude<LaunchPlan, { kind: 'error' }>): void {
  if (plan.kind === 'config') {
    writeFileSync('./registration.json', JSON.stringify(registration(loadConfig(plan.path), loadSecrets()), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.info('Wrote registration.json; register it with your Matrix homeserver and keep it private')
    return
  }
  if (plan.kind === 'host') throw new FatalConfigError('The registration of an instance\'s bridge is made in Harmony\'s admin panel.')
  if (plan.matrix.kind === 'account') throw new FatalConfigError('An ordinary account (MATRIX_ACCESS_TOKEN) needs no registration.')
  writeRegistration(plan.matrix, serviceTokens(plan.matrix, plan.dataDir), plan.dataDir)
  console.info(`${plan.dataDir}/registration.json is ready; register it with your Matrix homeserver and keep it private`)
}

async function main(): Promise<void> {
  process.umask(0o077)
  const args = process.argv.slice(2)
  if (args.length > 1 || args.some(arg => arg !== '--registration' && arg !== '--login')) throw new FatalConfigError('Usage: node dist/index.js [--registration | --login]')
  if (args.includes('--login')) {
    const token = await login({ address: process.env.MATRIX_HOMESERVER_URL?.trim() || null,
      ask: () => askOnTerminal({ input: process.stdin, output: process.stderr }), say: line => console.error(line) })
    // stdout holds the token and nothing else.
    process.stdout.write(`${token}\n`)
    return
  }
  const plan = planLaunch(process.env, findConfigPath())
  if (plan.kind === 'error') throw new FatalConfigError(plan.message)
  if (args.includes('--registration')) { writeRegistrationFile(plan); return }

  let launched: { stop(): Promise<void> } | undefined
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (stopping) return
      stopping = true
      if (!launched) process.exit(0)
      setTimeout(() => process.exit(1), 20_000).unref()
      // Requests in flight are not waited out.
      void launched.stop().then(() => process.exit(0), () => process.exit(1))
    })
  }
  if (plan.kind === 'config') launched = await runConfigured(plan.path)
  else if (plan.kind === 'host') {
    const host = new BridgeHost(plan, { version: packageVersion() })
    launched = host
    console.info(`Harmony Matrix bridge host ${packageVersion()}`)
    guardProcess((id, error) => host.crashed(id, error), line => console.error(line))
    watchEventLoop()
    await host.start()
  } else {
    const bridge = new ManagedBridge(plan, { version: packageVersion() })
    launched = bridge
    console.info(`Harmony Matrix bridge ${packageVersion()}`)
    await bridge.start()
  }
}

void main().catch(error => {
  if (error instanceof FatalConfigError || error instanceof CredentialsError || error instanceof LoginError) console.error(error.message)
  else console.error('Bridge startup failed; verify private configuration, permissions, homeserver registration and encryption policy')
  process.exitCode = 1
})
