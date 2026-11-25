# Harmony Matrix bridge

Connects Matrix rooms with channels of a [Harmony](https://github.com/y4my4my4m/harmony) server,
in plaintext. It is a service of its own, like the
[Discord bridge](https://github.com/y4my4my4m/harmony-discord-bridge); nothing of Matrix is built
into the Harmony client. It is experimental.

Everyone in a paired channel or room is relayed, except people who opted out: Harmony members in
Bridge privacy, Matrix people with `!bridge-privacy`. Encrypted rooms, encrypted channels and
rooms whose encryption cannot be read are never relayed.

## Ways to run it

| | Matrix side | Pairs | Requires |
|---|---|---|---|
| Managed, application service | your own homeserver; a ghost per Harmony member, or one sender | Harmony: Server settings → Bridges → Matrix | Harmony 1.9.9 |
| Managed, ordinary account | any homeserver, with an account's access token; one sender | the same | Harmony 1.9.9 |
| Host | every bridge a Harmony instance runs: communities' own accounts, and the instance's connection | the same, and codes posted in rooms | Harmony 1.9.9, its operator |
| `config.json` | your own homeserver, application service | the file, with a bot of your own | Harmony 1.9.8; opt-outs of Matrix people 1.9.9 |

`BRIDGE_MODE=host` selects the host and `HARMONY_URL` the managed start. Without either the bridge reads
`config.json`, and without that it prints instructions and exits with status 1.

## Managed: application service

1. In Harmony open Server settings → Bridges → Matrix, choose to run the bridge yourself and copy
   the setup code. A code works once, for 30 minutes.
2. Start the bridge:

   ```sh
   docker run -d --name harmony-matrix-bridge --restart unless-stopped -p 9009:9009 \
     -v harmony-matrix-bridge-data:/data \
     -e HARMONY_URL=https://harmony.example.org -e HARMONY_SETUP_CODE=MX-XXXX-XXXX-XXXX \
     -e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_SERVER_NAME=example.org \
     -e MATRIX_APPSERVICE_URL=http://bridge-host:9009 \
     ghcr.io/y4my4my4m/harmony-matrix-bridge:latest
   ```

   From source: `npm ci && npm run build`, then `node dist/index.js` with the same environment.
3. The first start writes `registration.json` into the data directory. Give it to the homeserver and
   restart that: `docker cp harmony-matrix-bridge:/data/registration.json .`, and for Synapse add its
   path to `app_service_config_files`. The file holds secrets. Until the homeserver knows it the
   bridge keeps running, reports `matrix_registration_missing` and tries again.
4. Invite `@harmony_relay:example.org` to the rooms, then pair them with channels in Harmony. Rooms
   with an invite appear in the list; a public room can be paired by its ID or alias. The bridge
   joins a room when a pair names it, and no other.

`MATRIX_APPSERVICE_URL` is the bridge as the homeserver reaches it, not as your browser does. Keep the
port away from the internet when the homeserver does not need it there: calls carry the registration's
token and are refused without it, `/health` is open.

## Managed: ordinary account

For communities without a homeserver of their own. The account's name is on every message, with the
Harmony author in front of the text; there are no ghosts.

```sh
docker run -d --name harmony-matrix-bridge --restart unless-stopped \
  -v harmony-matrix-bridge-data:/data \
  -e HARMONY_URL=https://harmony.example.org -e HARMONY_SETUP_CODE=MX-XXXX-XXXX-XXXX \
  -e MATRIX_HOMESERVER_URL=https://matrix.org -e MATRIX_ACCESS_TOKEN=... \
  ghcr.io/y4my4my4m/harmony-matrix-bridge:latest
```

The client API is found through `<MATRIX_HOMESERVER_URL>/.well-known/matrix/client`; without one the address
itself is used.

Use an account made for the bridge. Messages the account itself sends are never relayed, and the names
of the rooms it is in are shown to the managers of the Harmony server. Direct chats (`m.direct`) and
spaces are left out.

The bridge follows `/sync` for the paired rooms alone and stores the sync token together with the
messages it produced. A room's first response is history and is not copied; what is said while the
bridge is stopped is copied when it starts again, up to 1000 events a room. Beyond that it reports
`messages_skipped`. The homeserver's rate limit applies: messages wait for it in order.

### Getting an access token

```sh
docker run --rm -it -e MATRIX_HOMESERVER_URL=https://matrix.example.org \
  ghcr.io/y4my4my4m/harmony-matrix-bridge:latest node dist/index.js --login
# from source, with MATRIX_HOMESERVER_URL in .env:
node --env-file=.env dist/index.js --login
```

It asks for the user name and the password, which is not shown, signs in without a refresh token as the
session "Harmony bridge" and prints the access token alone on the last line of stdout; everything else goes
to stderr. Nothing is written to disk. The address must be https, or http on a loopback or private address.

A token copied from a Matrix app's settings works only where tokens do not expire; on matrix.org they do,
within minutes. A homeserver whose tokens expire for this sign-in too, or that offers none by password,
is refused in words. Signing the "Harmony bridge" session out ends the token, and the bridge reports
`matrix_token_invalid`.

## Host: the bridges of a Harmony instance

For operators of an instance. [Hosting Matrix bridges](https://github.com/y4my4my4m/harmony/blob/master/docs/self-host/matrix-bridges.md)
in Harmony's documentation covers the setup: `harmony bridges add matrix` runs this image as a service next
to the instance, and the admin panel says what it offers.

| Variable | |
|---|---|
| `BRIDGE_MODE` | `host` |
| `HARMONY_URL` | the bot gateway, e.g. `http://bot-gateway:3002` |
| `HARMONY_PUBLIC_URL` | optional: the instance's public address, for what people are told |
| `BRIDGE_HOST_SECRET` | equal to `MATRIX_BRIDGE_HOST_SECRET` of the bot gateway, at least 32 characters |
| `DATA_DIR` | `./data`, in the image `/data` |
| `LISTEN_HOST`, `LISTEN_PORT` | `0.0.0.0` and `9009`: `/health`, and the instance's application service |
| `MATRIX_ALLOW_PRIVATE_HOMESERVERS` | `false`; `true` lets communities name homeservers on private addresses |

The host reads its list from Harmony every minute. Bridges start, stop and take new credentials without a
restart. A list that cannot be read changes nothing. `GET /health` answers 200 while the last reading that
worked is less than five minutes old.

- **Communities' own accounts.** Each bridge is a managed bridge with an ordinary account, in a worker thread
  of its own with its own database below `DATA_DIR/hosted/<bridge>`, about 25 MB of memory each. One that
  throws, loops for two minutes or exceeds its heap (192 MB) ends alone and starts again, after 5 seconds and
  up to 5 minutes. One account serves one bridge: a second reports `account_in_use` and relays nothing.
- **Their homeservers** are strangers' input. https only; the address connected to is public, judged at each
  connection, by name, literal or whatever DNS answers then; no redirects; bounded answers and times; the same
  for `.well-known`, media and avatars. Names are resolved by DNS, not by the system. With
  `MATRIX_ALLOW_PRIVATE_HOMESERVERS` the address rule alone is off, and anyone who can set up a hosted bridge
  can have the service ask addresses on your network. The instance's own homeserver is not restricted.
- **The instance's connection** is one application service or one account for every server that chose it. A
  room's events go to the bridge that pairs it. A transaction is acknowledged, and a sync token stored, when
  every bridge it concerns has stored its part; one that cannot holds the others for a minute at most, or fails
  three times on the same events, and then misses them (`messages_skipped`). A full queue takes the encryption
  fences and lets the messages go.
- **Isolation there** is inside one process: every bridge has its own database, gateway connection and queue,
  an error nothing caught restarts the bridge it arose in, and one that belongs to no bridge ends the process.
  Text from strangers is read in time proportional to its length. A process whose event loop stands still for
  two minutes is ended, for its supervisor to start again.
- **Ghosts** belong to a Harmony user, not to a server: two servers' rooms share one. They leave a room for the
  reasons of its own pair, and an opt-out counts in its own server.
- **Linking.** The account accepts invitations, up to 50 rooms without a code at a time. `!harmony link ML-…`
  from someone whose power reaches what the room asks for changing its state, and its power levels
  (`state_default`, `events["m.room.power_levels"]`; the creators in room version 12), links the room: five
  tries a person in ten minutes, one answer each. The code is neither logged nor relayed, by any way to run the
  bridge. A code moves a room that another server had; the account stays.
- **Leaving.** A room without a code after ten minutes, at once an encrypted one with the reason, a room whose
  pair is removed once every bridge has been asked whether it moved there, and after ten minutes the rooms of a
  bridge that is no longer listed. Rooms the account was in by itself are left alone, and so are all of them
  when the connection is turned off.
- **Data** of a bridge that is no longer listed stays in its folder: the list cannot say whether it is gone or
  its switch is off for an hour. Remove `DATA_DIR/hosted/<bridge>` or `DATA_DIR/instance/<bridge>` by hand,
  with the service stopped.

| Log line | Meaning |
|---|---|
| `Bridge list read: 2 hosted, 5 on the instance's connection` | at the start, and after a failure |
| `Harmony refuses BRIDGE_HOST_SECRET: …` | the two secrets differ |
| `Harmony hosts no Matrix bridges: …` | the bot gateway has no secret, or is older than 1.9.9 |
| `Cannot read the bridge list from Harmony; retrying` | the bot gateway does not answer; what runs goes on |
| `[1a2b3c4d] …` | one bridge, by the first characters of its ID |
| `[instance] …` | the instance's connection |
| `… Bridge starting`, `… Credentials changed; restarting`, `… Bridge no longer listed; stopping` | as Harmony lists them |
| `… Bridge stopped by an error; restarting in 5 s. …` | with the place in the program, not the error's text |
| `… Matrix homeserver connected`, `… Harmony gateway connected`, `… Pair ready` | in working order |
| `… Cannot reach the Matrix homeserver; retrying` | or its address is not allowed (`MATRIX_ALLOW_PRIVATE_HOMESERVERS`) |
| `… The homeserver refuses the access token. …` | a new token is needed |
| `[instance] The homeserver does not accept the bridge yet: …` | the registration file is not on the homeserver, or an older one is |
| `… Another bridge uses this Matrix account; nothing is relayed` | one account, two bridges |
| `… Room linked`, `[instance] Left a room …`, `[instance] Declined …` | linking and leaving |
| `… Messages from Matrix were not copied: …` | the bridge was down or full too long |
| `[instance] Local storage failed; …`, `… could not start: DATA_DIR cannot be written` | check the disk |
| `The bridge host stops after an error: …`, `The bridge host no longer responds; ending it` | the process ends; its supervisor starts it again |

Logs hold no tokens, codes, messages or Matrix IDs of people.

## Environment of a managed bridge

| Variable | |
|---|---|
| `HARMONY_URL` | address of your Harmony, or of its bot gateway |
| `HARMONY_SETUP_CODE` | first start, and to replace credentials; redeemed once |
| `MATRIX_HOMESERVER_URL` | client API, as the bridge reaches it; with an account also the homeserver's plain address |
| `MATRIX_SERVER_NAME` | name in user IDs (application service) |
| `MATRIX_APPSERVICE_URL` | the bridge, as the homeserver reaches it (application service) |
| `MATRIX_SENDER_LOCALPART` | `harmony_relay`; each bridge on one homeserver needs its own |
| `MATRIX_AS_TOKEN`, `MATRIX_HS_TOKEN` | both or neither; generated into the data directory without them |
| `MATRIX_ACCESS_TOKEN` | ordinary account, in place of the four above |
| `DATA_DIR` | `./data`, in the image `/data` |
| `LISTEN_HOST`, `LISTEN_PORT` | `0.0.0.0` and `9009`; with an account, from source, `127.0.0.1` |

The data directory holds `credentials.json`, `appservice.json`, `registration.json` and
`bridge.sqlite`, each mode 0600. `credentials.json` keeps a hash of the code, not the code. Stop the
bridge before copying the directory; keep it with the registration, whose ghosts it owns.

`GET /health` answers `{ready, pending, failed, problems}`, 200 when ready and 503 otherwise. Ready
means: credentials accepted, gateway connected, homeserver answering, local storage writable. A pair in
error does not change it, and no pair at all is ready too.

## What works

- Room and channel pairs, one to one, in either or both directions. Managed pairs come and go while
  the bridge runs; one that cannot be joined, read or bound is reported to Harmony and the others run.
- Matrix authors in Harmony by name and avatar, with unprefixed text.
- Harmony authors in Matrix as ghosts (application service) or through one sender, chosen per pair.
- Ghosts appear when their member first speaks. In channels of at most 100 eligible members they are
  prepared ahead, for mention completion.
- User mentions in both directions.
- Matrix rich replies, attached to the Harmony message they answer when the bridge knows it and it can
  still be read; otherwise the new text alone.
- Images and files in both directions, copied into the destination's own storage. Audio and video
  travel as files.
- `!bridge-privacy` for Matrix people, and the opt-outs of both sides.
- A durable SQLite queue with deduplication, message mappings and bounded retries.

Not implemented: Harmony to Matrix reply context, edits, deletions, reactions, threads, presence,
account linking, history import, encrypted rooms and media.
Edits and threaded messages from Matrix are ignored.

## Privacy

- Harmony asks nobody to opt in: members are relayed unless they opted out in Bridge privacy. Their
  consent is read before every send, retries included, and never cached. Anything but a clear yes sends
  nothing.
- Matrix people send `!bridge-privacy` in a paired room: `opt-out`, `opt-in`, `status`, `erase`. It
  covers every room bridged to that Harmony server. `erase` deletes their messages on Harmony after
  `erase confirm`. The command is never relayed.
- Matrix has no reply that only one person sees. The answer is a notice in the room, as a reply to the
  command, mentioning the person who sent it. A person gets five answers a minute and a room twenty;
  a choice made beyond the room's limit still counts.
- The bridge keeps the server's opt-out list and drops those people's messages on arrival and again at
  delivery. Harmony refuses them as well (403 `BRIDGE_AUTHOR_OPTED_OUT`), which the bridge takes as an
  opt-out. They are left out of member lists and mentions.
- An opt-out does not call back a request already sent, and does not erase what was copied; `erase` does
  that on Harmony.
- Explicit lists remain possible in `config.json`. They narrow who is relayed and replace no opt-out.

## Encryption

The bridge reads plaintext and sends plaintext. Consent, binding, room, sender mode and both sides' encryption
are read twice for every attempt, at its start and right before the send, the destination's last. What the
bridge knows by itself (fences, pairs, lists, opt-outs) is looked at once more in the same turn as the send. Only `404 M_NOT_FOUND` for `m.room.encryption` counts as an unencrypted room, and
only a boolean from Harmony as an answer about a channel. An `m.room.encryption` event of a paired room
is a durable fence: queued and running deliveries of that room stop, and pairing it again does not lift
it. A pair whose room or channel is encrypted is reported and its ghosts leave.

Checks and sends are separate requests. A room that turns on encryption after the last check, while a
send is under way, cannot be fenced by this client. Do not use the bridge for rooms that may become
encrypted and must not leak.

Encrypted rooms and media are follow-up work in [`ROADMAP.md`](./ROADMAP.md). Do not turn encryption off
to bridge a room.

## config.json

For a bot of your own, with everything in one file. A pair that cannot be verified stops the start.

```sh
git clone https://github.com/y4my4my4m/harmony-matrix-bridge.git
cd harmony-matrix-bridge
npm ci
cp config.example.json config.json
cp .env.example .env
chmod 600 config.json .env
```

- `harmony.apiUrl`: the gateway, e.g. `https://chat.example.org/bot-gateway`.
- `harmony.gatewayUrl`: e.g. `wss://chat.example.org/bot-gateway/gateway`.
- `harmony.allowedUserIds`, `matrix.allowedUserIds`: optional. Absent, everyone who has not opted out;
  present, these Harmony profile UUIDs or full Matrix IDs only, 1 to 1000.
- `matrix.homeserverUrl`: client API; may differ from the domain of user IDs.
- `matrix.serverName`: the server name in user IDs.
- `matrix.senderLocalpart`: default `harmony_relay`.
- `matrix.applicationServiceUrl`: the bridge, as the homeserver reaches it.
- `listen.host`, `listen.port`: default `127.0.0.1` and `9009`.
- `database`: default `./data/bridge.sqlite`, relative to the working directory.
- `pairs`: 1 to 100 of `harmonyChannelId` and `matrixRoomId`, each used once. Room IDs, not aliases;
  newer ones have no server suffix. `direction` is `both`, `to_harmony` or `to_matrix`.
- `pairs[].senderMode`: `relay` (default) or `ghost`, for the first binding. After that the mode set in
  Harmony counts.

In `.env`:

```dotenv
HARMONY_TOKEN=harmony_bot_<64 hex characters>
MATRIX_AS_TOKEN=<openssl rand -hex 32>
MATRIX_HS_TOKEN=<openssl rand -hex 32, another one>
```

The bot needs **Read messages** and **Send messages** in the paired channels and nothing more. Its owner,
who also manages the server, connects it in Server settings → Bridges → Matrix, which records
`bots.bridge_platform = 'matrix'` and the channels. `configure_matrix_bridge` is the function behind that
page (migrations `20261117900001` to `20261117900003`).

```sh
npm run registration      # registration.json, never overwritten
npm run build
node --env-file=.env dist/index.js
```

Register `registration.json` with the homeserver and invite `@harmony_relay:<serverName>` to the rooms.

On Harmony 1.9.9 the bot's Matrix people can opt out as well: lists are read per paired channel, since a
bot may serve several servers. An older Harmony answers the command with a notice that it cannot.

## Sender modes, members and mentions

Ghost IDs are `@<senderLocalpart>_h_<32 hex digits of the profile UUID>:<serverName>`, in an exclusive
namespace of the registration. A managed bridge or a host takes over a ghost it does not know, after its data
was lost, when the homeserver confirms that the application service acts as that user. With `config.json` it
is refused. A ghost that cannot be had fails the message and is reported (`ghosts_unavailable`), without
falling back to the single sender.

A ghost is joined and named when its profile in the room is not the one last put there, and otherwise only
speaks; one that was removed from the room is prepared again, once, when its message is refused. A public room
is joined as it is; the bridge invites a ghost where the join is refused, and needs the right to there.

A pair is refreshed when it becomes ready, on every READY, and when something changed: the configuration or an
opt-out, the members or profiles of the room, the members of the Harmony server, gathered for 30 seconds each.
Without any sign of a change it is refreshed every ten minutes; a room of more than 1000 people is listed no
more often than that. A refresh verifies that both sides are plaintext, lets ghosts of members who left or
opted out leave, prepares ghosts where channels are small, and publishes the room's members to Harmony (op 6):
at most 1000 of them, with avatars copied ahead in rooms of at most 100. Every frame holds every channel, since
the gateway replaces the whole registration; lists that did not change are not sent again, and frames are 15
seconds apart.

Ghosts leave on member removal, opt-out, the change from ghost to relay, and when their pair is removed
or stops in error. History stays. A message's Matrix sender is stored before its first attempt, because
Matrix deduplicates per sender; a mode change before a retry fails the message rather than sending it
from someone else.

- Matrix to Harmony: `m.text`, with `m.mentions.user_ids` and `https://matrix.to/#/<MXID>` links of
  ghosts the bridge owns becoming mentions of their members. HTML is neither forwarded nor fetched; when
  it disagrees with the plain text, the plain text counts.
- `!mention <exact_username> <message>` mentions one Harmony member in rooms without ghosts. It is text,
  not a slash command.
- Harmony to Matrix: structured mention parts (`userId`, `bridgeSource: "matrix"`, `isBridged: true`)
  become links and `m.mentions.user_ids` of people joined to the room, at most 50 a message. Members'
  mentions become their ghosts'. No room mentions.

## Attachments

- `m.image`, `m.file`, `m.audio` and `m.video` become Harmony file parts, with a caption when Matrix
  supplies a `filename` beside the body.
- Harmony text goes first, then one Matrix event per file. In relay mode a file-only message gets the
  author's line.
- 50 MiB per file, or the destination's lower limit; 20 files per Harmony message, then one visible
  notice. 60 seconds per transfer, one at a time, in memory.
- Matrix files come through the homeserver's authenticated media endpoint. Harmony files are read by
  message and part index from the channel's own private media; URL-only, external and Drive attachments
  are not (the gateway answers 422 for Drive files).
- Harmony checks type, signature and size and strips metadata before storing. This is no malware
  scanner. SVG, HTML, scripts, executables and mismatched images are refused.
- A file that is unsupported, too large, missing or cannot be copied becomes
  `[Attachment unavailable: name]` beside the text. Consent, binding, sender mode and both encryption
  states are checked before each step; a refusal there stops the message instead.
- Encrypted file descriptors in a plaintext room get the notice; nothing is downloaded.
- Queued messages hold references, not bytes or signed URLs. Interrupted transfers can leave uploads
  that nothing refers to.

## Delivery

- One process per database. A channel's messages go in order, one at a time in each direction, retries
  included; up to four channels are worked on at once, without waiting for a tick.
- A Matrix transaction is acknowledged, and a sync token stored, only with its events in SQLite. Events
  are deduplicated by ID. A queue of 10,000 refuses more until it drains.
- A transaction may hold 8 MiB. An event that cannot be read is left out, an encryption event still fences
  its room. A transaction that cannot be read at all is refused twice and then let go, since the homeserver
  would repeat it for ever and send nothing after it.
- Events sent before a managed pair existed are not copied, whenever the homeserver delivers them; five
  minutes of clock difference are allowed.
- Harmony's WebSocket has no replay: what Harmony members say while the bridge is disconnected is not
  copied.
- A Harmony POST has no idempotency key. An unclear failure after it started is marked failed, not
  retried; a crash between acceptance and completion can duplicate one message.
- Matrix sends keep their transaction ID across retries and restarts. For an account they deduplicate per
  device: a new access token is a new device.
- Transient failures are retried seven times, up to a minute apart. A rate limit or a refused token from
  Matrix pauses Harmony to Matrix and costs no attempt. Messages dropped for an opt-out count as `failed`.
- A failed write to local storage stops the worker until restart.
- Finished jobs keep IDs and no content. The database, its sidecars and backups hold queued plaintext;
  keep them private.

## Gateway contracts

`Authorization: Bot <token>`. Below `/bridge/v2/matrix` (Harmony 1.9.9):

- `POST /redeem` `{code}` → `{bridge_id, server_id, harmony_token, base_url, api_url, gateway_url}`.
- `GET /config` → `{bridge_id, server_id, mode, updated_at, privacy_version, pairs: [{channel_id,
  channel_name, room_id, room_alias, direction, sender_mode, encrypted}]}`, read every minute, on READY and
  on `BRIDGE_CONFIG_UPDATE`.
- `POST /status` `{version, connection, ready, user_id, homeserver, server_name, pending, failed, rooms,
  pairs, problems}`, every 30 seconds and after changes. Rooms are sent when ready: joined ones first,
  then invites (`invited: true`), 500 in all.
- `GET /privacy/optouts` → `{version, remote_user_ids}`; `GET`, `PUT`, `DELETE /privacy/optouts/:mxid`;
  `POST /privacy/erase` `{user_id}`. A bot that no managed bridge owns names the channel with
  `?channel_id=`.

With `X-Bridge-Host-Secret`, for the host:

- `GET /host` → `{hosted: [{bridge_id, harmony_token, homeserver_url, access_token}], instance}`, where
  `instance` is null or `{connection, homeserver_url, server_name, sender_localpart, as_token, hs_token,
  access_token, bridges: [{bridge_id, harmony_token}]}`.
- `POST /host/status` `{version, instance: {ready, user_id, server_name, problems} | null, hosted}`.
- `POST /host/link` `{code, room_id, sender}` → `{bridge_id, server_name, channel_id, channel_name}`, 400
  `invalid_code`, 409 `channel_encrypted`.

Below `/api/v1`:

- `GET /channels/:id/bridge-check?user_id=` → `{platform, room_id, sender_mode, messages_encrypted,
  relay_allowed, member}`: everything a send depends on, at one moment (Harmony 1.9.9, READY capability
  `matrix_bridge_check`). A text message costs two of these and a known ghost nothing more. Without it the
  bridge asks the five routes below instead.
- `GET /channels/:id/bridge-platform` → `{platform}`; 503 when unknown.
- `GET /channels/:id/bridge-consent/:userId` → `{relay_allowed}`: true unless the member opted out. The
  route checks read access to the channel, not its pairing.
- `GET`, `PUT /channels/:id/bridge-room` → `{room_id, sender_mode}`. `PUT` takes `room_id`,
  `initial_sender_mode` and, for a pair named by alias, `room_alias`. 409 `room_in_use` and `room_changed`.
- `GET /channels/:id/bridge-members` → accepted members who see the channel and did not opt out, at most
  10,000; `?user_id=` for one of them (Harmony 1.9.9).
- `GET /channels/:id/bridge-members/:userId/avatar` → `{data, content_type}`, at most 1 MiB, from the
  instance's own storage. The bridge never fetches a member's `avatar_url`.
- `GET /channels/:id/encryption` → `{messages_encrypted}`.
- `POST /channels/:id/bridge-avatar` `{data, content_type}` → `{avatar_url}`, at most 1 MiB of PNG, JPEG,
  WebP or GIF, stored under `avatars/bridges/<bot>/<server>/<sha256>`: 1000 per bot and server, purged an
  hour after the binding ends.
- `POST /channels/:id/messages` with `metadata.bridge_author = {platform: "matrix", id, username,
  display_name?, avatar_url?}`. Names up to 100 characters, IDs 255, avatar URLs 2048; the gateway drops
  avatar URLs that are not https.

Matrix avatars are fetched as 128×128 thumbnails through the configured homeserver only, at most 1 MiB, and
copied into Harmony's storage once per server. A failed copy is tried again after ten minutes and never
holds up a message. Copied avatars are not removed by an opt-out.

## Docker

`ghcr.io/y4my4my4m/harmony-matrix-bridge`, or `docker build -t harmony-matrix-bridge .`. The image runs as
`node`, keeps its data in the volume `/data`, listens on `0.0.0.0:9009` and has a health check.

With `config.json`, set `listen.host` to `0.0.0.0` and mount the file and a directory for the database:

```sh
mkdir -p data && chmod 700 data
docker run --rm --name harmony-matrix-bridge --network matrix-net --user "$(id -u):$(id -g)" \
  --env-file .env -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/data:/app/data" \
  ghcr.io/y4my4my4m/harmony-matrix-bridge:latest
```

## Moving a deployment

Stop the bridge first; two workers must not share a database. Keep `config.json`, `.env`,
`registration.json` and the database with its `-wal` and `-shm` files. A relative `database` resolves from
the new working directory. Keep tokens, bot, room bindings and ghost namespace. A 0.1.0 database is
extended in place.

Changing from an application service to an account leaves its ghosts in their rooms: remove the pairs
first, so that they leave.

## Compared with the Discord bridge

The [Discord bridge](https://github.com/y4my4my4m/harmony-discord-bridge) (2.8.0) is the reference for
behaviour and settings.

| Area | Matrix |
|---|---|
| Setup | Setup code, hosted account, the instance's connection, pairs, status and problems in Server settings, as there. |
| Authors, members, mentions | Authors with name and avatar, ghosts or one sender, profiles and user mentions. No roles, no account linking. |
| Privacy | The same opt-outs and erase; a text command instead of a slash command. |
| Attachments | Copies on both sides with captions, several files and visible failures. Fixed limits, no link fallback. |
| Replies | Matrix to Harmony, every sent piece included. Harmony to Matrix is open. |
| Edits, deletions, reactions | Open. |
| Threads, emoji, formatting | Open. |
| Presence, permissions | Open. Matrix power levels give no rights on Harmony. |
| Encryption | Plaintext only on both. |

## Tests

```sh
npm run type-check
npm test
npm run build
npm run test:synapse
```

`npm run test:synapse` needs Linux and Docker. It pulls Synapse, runs it with random tokens on loopback
ports in a container of its own and removes that container and its files at the end; bot-gateway is a
contract fake. It drives the application service (registration, transactions, ghosts, media, mentions,
replies, fences), the managed start (refused registration, invites, pairs that come and go, privacy
command, restart, removal, encryption), account mode (`--login`, first sync, limited timelines, removal and
return, fences) and the host as a process of its own (a hosted account behind `.well-known` and https, two
servers on one application service, links by code, a room that moves, encrypted rooms, lost data, the
instance's account). It tests neither Harmony's database nor its storage.

## License

AGPL-3.0, consistent with Harmony. Protocol and transport patterns follow
[harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge) by Harmony's contributors.
[Powered by Harmony](https://github.com/y4my4my4m/harmony). See [LICENSE](./LICENSE),
[COPYRIGHT](./COPYRIGHT), [additional terms](./LICENSE-ADDITIONAL-TERMS.md) and
[trademark policy](./TRADEMARK.md). The original Harmony notices are kept unchanged; the UI and assets
they describe are not bundled with this headless service.
