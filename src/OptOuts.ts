/** Matrix people of one Harmony server who are opted out of the bridge: by themselves, by a manager or by an admin. */
export class OptOutList {
  private ids = new Set<string>()
  private loaded: string | null = null
  private seq = 0
  /** add and remove calls made while a read was in flight, by `seq`. */
  private edits: Array<{ seq: number; id: string; present: boolean }> = []
  private reads = 0

  /** `onChange` runs whenever the set changes, by any path. */
  constructor(private readonly onChange: () => void = () => {}) {}

  /** The version of the last read; null before one. */
  version(): string | null { return this.loaded }
  has(id: string): boolean { return this.ids.has(id) }

  add(id: string): void {
    this.note(id, true)
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.onChange()
  }

  remove(id: string): void {
    this.note(id, false)
    if (this.ids.delete(id)) this.onChange()
  }

  /**
   * Replaces the list with one read from Harmony. An add or remove made during the read answers a
   * later state and is applied over it. Rejects as `read` does, with the list as it was.
   */
  async load(read: () => Promise<{ version: string | null; ids: Iterable<string> }>): Promise<void> {
    const since = this.seq
    this.reads++
    try {
      const { version, ids } = await read()
      const next = new Set(ids)
      for (const edit of this.edits) {
        if (edit.seq <= since) continue
        if (edit.present) next.add(edit.id)
        else next.delete(edit.id)
      }
      const changed = next.size !== this.ids.size || [...next].some(id => !this.ids.has(id))
      this.ids = next
      this.loaded = version
      if (changed) this.onChange()
    } finally {
      if (--this.reads === 0) this.edits = []
    }
  }

  private note(id: string, present: boolean): void {
    this.seq++
    if (this.reads > 0) this.edits.push({ seq: this.seq, id, present })
  }
}
