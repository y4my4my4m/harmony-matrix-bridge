import { readFileSync } from 'node:fs'

/** package.json stands beside src/ and dist/. */
export function packageVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof version === 'string' ? version : '0.0.0'
  } catch { return '0.0.0' }
}
