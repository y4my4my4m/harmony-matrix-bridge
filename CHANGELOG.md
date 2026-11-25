# Changelog

## 0.1.0 — 2026-11-25

- Extract the standalone service from `y4my4my4m/harmony` at `c76f4c50`, preserving
  the service's commit history. Runtime and protocol-test code is unchanged by the move.
- Experimental plaintext Matrix application service with consented ghosts/shared relay,
  native authors and explicit mentions, inbound reply context and bidirectional images/files.
- Durable SQLite acceptance/mappings, bounded retries, frozen Matrix senders and encryption fences.
- Root-level npm/Docker setup, CI, license notices and a service-owned roadmap.
- Requires Harmony 1.9.8 or later, which holds the Harmony side of the bridge.

Encrypted rooms/media, outbound reply context and message lifecycle synchronization remain
follow-ups, not features of this release. See [README](./README.md) and [roadmap](./ROADMAP.md).
