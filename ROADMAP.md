# Matrix bridge roadmap

The current milestone is an experimental, explicitly allowlisted **plaintext** application
service. See [supported behavior and limits](./README.md) and the
[Discord ecosystem parity table](./README.md#bridge-ecosystem-parity).
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
3. Clearer setup, diagnostics and configuration lifecycle; guided installation where possible.
4. Threads, richer formatting, emoji/stickers and channel references as separately tested features.

Presence, role/structure synchronization, account linking and shared hosting need explicit
product/security decisions; Matrix power levels must not grant native Harmony rights.

## Harmony integration

Native UI, profiles/mentions, registration, database migrations and scoped API contracts
remain in [Harmony](https://github.com/y4my4my4m/harmony). Initial support is tracked by
[Harmony PR #197](https://github.com/y4my4my4m/harmony/pull/197).
Validate compatible deployed Gateway/DB contracts before a community-facing release.
