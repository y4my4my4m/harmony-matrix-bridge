import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { errorPlace } from './Boundary.js'

const boundary = new URL('./Boundary.ts', import.meta.url).href

/** A process of its own: what nothing catches would end the test run. */
function run(code: string): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { guardProcess, inside, watchEventLoop } from '${boundary}'\n${code}`],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { out += chunk })
    child.on('exit', (code, signal) => resolve({ code, signal, out }))
  })
}

describe('a bridge in the host\'s process', () => {
  it('that throws in a timer, a promise, a listener or a callback ends alone', async () => {
    const { code, out } = await run(`
      import { EventEmitter } from 'node:events'
      import { createServer, get } from 'node:http'
      const crashed = []
      guardProcess((id, error) => { crashed.push(id + ':' + error.message); return true }, line => console.log(line))
      inside('one', () => setTimeout(() => { throw new Error('timer') }, 5))
      inside('two', () => { void (async () => { await 1; throw new Error('promise') })() })
      inside('three', () => { const emitter = new EventEmitter(); emitter.on('x', () => { throw new Error('listener') }); setImmediate(() => emitter.emit('x')) })
      inside('four', () => setInterval(function () { clearInterval(this); throw new Error('interval') }, 5))
      const server = createServer((req, res) => res.end()).listen(0, () => inside('five', () => get({ port: server.address().port }, () => { throw new Error('response') })))
      let ticks = 0
      setInterval(() => { ticks++ }, 10)
      setTimeout(() => { console.log(JSON.stringify(crashed.sort()), ticks > 5); process.exit(0) }, 400)
    `)
    expect(out.trim()).toBe('["five:response","four:interval","one:timer","three:listener","two:promise"] true')
    expect(code).toBe(0)
  }, 20_000)
  it('ends the process for an error that is no bridge\'s, or that nobody takes, without its text', async () => {
    const { code, out } = await run('guardProcess(() => true, line => console.log(line))\nsetTimeout(() => { throw new TypeError("secret") }, 5)\nsetInterval(() => {}, 1000)')
    expect(code).toBe(1)
    expect(out).toContain('stops after an error: TypeError at ')
    expect(out).not.toContain('secret')
    expect((await run('guardProcess(() => false, () => {})\ninside("gone", () => setTimeout(() => { throw new Error("x") }, 5))\nsetInterval(() => {}, 1000)')).code).toBe(1)
  }, 20_000)
  it('is ended with the process when it never returns, and not for being slow', async () => {
    const stuck = await run('watchEventLoop(400)\nsetTimeout(() => { for (;;); }, 50)')
    expect(stuck.signal).toBe('SIGKILL')
    expect(stuck.out).toContain('no longer responds')
    const slow = await run('watchEventLoop(1500)\nlet n = 0\nsetInterval(() => { const until = Date.now() + 150; while (Date.now() < until); if (++n === 12) { console.log("done"); process.exit(0) } }, 10)')
    expect(slow).toMatchObject({ code: 0, out: 'done\n' })
    // Watching keeps no process alive.
    expect((await run('watchEventLoop(400)')).code).toBe(0)
  }, 30_000)
  it('is told of by where an error arose', () => {
    expect(errorPlace(new TypeError('token syt_secret'))).toMatch(/^TypeError at /)
    expect(errorPlace(new TypeError('token syt_secret'))).not.toContain('syt_secret')
    expect(errorPlace(new Error('line one\n    at syt_secret'))).not.toContain('line one')
    expect(errorPlace('text')).toBe('unknown error')
  })
})
