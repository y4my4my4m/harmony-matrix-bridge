# Changelog

## 1.0.0 — unreleased

- **Bridges a Harmony instance runs.** `BRIDGE_MODE=host` runs communities' own accounts, each in a thread of
  its own, and the instance's one connection (an application service or an account) for every server that chose
  it. Bridges start, stop and take new credentials without a restart. One that throws, loops or fills its queue
  stops neither another nor the host.
- **A room is linked by a code.** `!harmony link ML-…` from someone who may change the room's settings. The
  account leaves rooms nobody linked within ten minutes, encrypted ones at once, and those whose pair is gone.
- **Homeservers that communities name are not trusted**: https, public addresses at every connection, no
  redirects, bounded answers and times.
- **Two requests to Harmony for a message instead of twenty.** One `bridge-check` before anything and one right
  before the send, on Harmony 1.9.9; ghosts already in a room only speak. Members are refreshed when something
  changed and every ten minutes, not every 30 seconds. Messages go out without waiting for a tick, in order
  within a channel and for up to four channels at once.
- **Lost data.** A managed bridge takes its ghosts over when the homeserver confirms that they are its own.
- **Set up from Harmony.** `HARMONY_URL` and a setup code from Server settings → Bridges → Matrix start the
  bridge; credentials are stored once and pairs come from there. Tokens and `registration.json` are made on
  the first start. Requires Harmony 1.9.9.
- **Pairs come and go while it runs.** Each is resolved, joined, checked and bound by itself, by room ID or
  alias. One that fails is reported and the others run; no pair at all is a running state. A removed pair's
  ghosts leave. Rooms with an invite appear in Harmony's list; none is joined unasked.
- **An ordinary Matrix account.** With `MATRIX_ACCESS_TOKEN` the bridge follows `/sync` and relays through the
  account, without a homeserver of one's own. The sync token is stored with the messages it produced, history
  is not copied, and messages missed while stopped are read back. `--login` signs in for a token that lasts.
- **Everyone unless they opt out.** The lists in `config.json` are optional. Matrix people send
  `!bridge-privacy opt-out`, `opt-in`, `status` or `erase`; Harmony's list and its refusals are obeyed.
- **Ghosts on first speech.** They are prepared ahead only in channels of at most 100 eligible members, and
  only when something changed. A public room takes them without an invite; elsewhere the bridge invites them.
- Formatted messages are read in time proportional to their length.
- Large channels and rooms: member lists of up to 10,000 are read, the first 1000 of a room are listed, and a
  message with a mention no longer needs the whole room.
- Copied avatars are remembered per Harmony server, and a failed copy is not tried again for ten minutes.
- A rate limit from Matrix, or a refused token, holds Harmony to Matrix in order instead of failing messages.
- Transactions of up to 8 MiB are taken, 100 events of 64 KiB. One event that cannot be read is left out, and a
  transaction that can never be read is let go at the third try instead of stopping every room.
- A repeated registration on one homeserver has its own id when its sender is not `harmony_relay`.
- The image keeps its data in `/data`, has a health check, prints instructions when it is not configured and is
  published to `ghcr.io/y4my4my4m/harmony-matrix-bridge`.

A 0.1.0 database and `config.json` are taken as they are.

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
