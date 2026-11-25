# Matrix bridge roadmap

The bridge is experimental and relays **plaintext** only: as an application service or as an ordinary
account, managed from Harmony, run by a Harmony instance or by `config.json`. See [behaviour and limits](./README.md) and the
[comparison with the Discord bridge](./README.md#compared-with-the-discord-bridge).
These are follow-ups, not supported features.

## Encrypted participation and media

Treat the bridge as a revocable participant on each platform, not a ciphertext tunnel:

- Use each platform's supported device identity, membership and key-sharing rules.
- Persist independent device/session keys safely; support recovery and revocation.
- Decrypt and re-encrypt as an authorized participant, including media integrity verification.
- Reauthorize queued work after membership, permission and consent changes.
- Make the cross-platform plaintext trust boundary explicit to participants.

Sharing Megolm does not make Harmony and Matrix key distribution interoperable. Until
participant crypto is implemented and tested, encrypted/unknown rooms stay blocked.
Never disable encryption or forward keys as a workaround. Removing access cannot erase
plaintext or keys the bridge previously received.

## Discord ecosystem parity

1. Harmony → Matrix reply context.
2. Permission-aware edits, deletes/redactions and reactions, with durable mappings and consent.
3. Threads, richer formatting, emoji/stickers and channel references as separately tested features.

Presence, role/structure synchronization and account linking need explicit product/security
decisions; Matrix power levels must not grant native Harmony rights.

## Harmony integration

Native UI, profiles/mentions, registration, database migrations and scoped API contracts remain in
[Harmony](https://github.com/y4my4my4m/harmony): application services with a bot of one's own since 1.9.8,
managed and hosted bridges and opt-outs of Matrix people since 1.9.9.
