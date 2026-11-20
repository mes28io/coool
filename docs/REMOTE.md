# coool Remote: design

Status: steps 1 and 2 built (the relay, the Mac side, a command-line stand-in phone, the iPhone app); TestFlight is next. This file is the contract between the three parts (relay, Mac app, iPhone app). Where building refined the first design, the change is marked **Changed in step 1** or **Changed in step 2**.

Where things live: the relay is `remote/relay/` (Convex), the Mac side `crates/remote/` (protocol, rules, engine) and `app/src-tauri/src/remote.rs` (the app's side and Settings > Remote's commands), the stand-in phone `remote/phone/` (`src/protocol.mjs` is the reference the iPhone app follows; `crates/remote/tests/vectors.json` holds fixed-input results both implementations must reproduce), the end-to-end run `remote/e2e/run.sh`; the iPhone app `remote/ios/` (its protocol module `remote/ios/RemoteProtocol/` reproduces the same vectors; its end-to-end run `remote/ios/e2e/run.sh`).

## What it is

An iPhone app that watches and steers the coool running on your Mac, from anywhere. First version:

- See every session and its state, live.
- See, live while the app is open, when an agent needs you.
- Allow or deny a permission request, answer a question, approve a plan.
- Send a message to a chat, stop a chat.
- Start a new chat in a project folder the Mac already knows.

Not in the first version: push notifications (decided against), accounts and sign-in, a terminal, file browsing, the device panels, changing settings, "always allow" answers, Bypass / full-access modes. Minor 1 (below) adds a live chat view, Mission control, usage, diffs and plans, images both ways, view-only device pictures, and starting with a model and an asking mode.

## Decisions

1. **Pair by QR, no account.** The Mac shows a QR code; the phone scans it once. That pairing is the identity. Accounts can be layered on later (several Macs, a web client) without changing the message format.
2. **It works away from home through a relay.** The QR code is only the introduction. Afterwards both sides connect outwards to the relay; the Mac opens no ports and needs no router setup.
3. **The relay is a Convex project you deploy yourself** (see "Your own relay"). The app has no built-in relay.
4. **End-to-end encrypted.** The relay stores and forwards ciphertext. It never sees session titles, prompts, commands, paths, answers or the phone's name. It knows: which Mac id talks to which device id, when, and message sizes.
5. **Off by default.** Nothing connects to the relay until the user turns Remote on in Settings and pairs a phone.

## Your own relay

coool ships with no relay. Remote is a self-hosted feature: it appears in Settings only on a Mac that names a relay,
and each person who wants it runs their own (a free Convex project is enough for one person).

1. In `remote/relay`: `npm ci`, then `npx convex deploy` into a Convex project of yours.
2. Make it private: `npx convex env set RELAY_ACCESS "$(openssl rand -hex 32)" --prod`. With that variable set, the
   relay refuses any Mac it hasn't seen unless the Mac presents the same value.
3. On the Mac, write `~/Library/Application Support/coool/remote/relay.json` (mode 600):
   `{"relay": "https://<your-deployment>.convex.cloud", "access": "<the same value>"}`.
4. Restart coool. Settings > Remote appears. The iPhone app (`remote/ios`) learns the relay from the pairing code.

The access key only gates who may use the relay. It is not part of the encryption: the relay can't read messages
with or without it.

## Threat model

Remote can run commands on the Mac (by approving them or starting chats), so it is treated as a remote-control channel, not a notification feature.

| Attacker | Must not be able to |
|---|---|
| The relay operator, or someone who breaches the relay | Read anything, forge a message either way, replay an old approval |
| Someone who photographs the QR code later | Pair (the code is single-use and expires in 2 minutes) |
| Someone on the network | Read, alter or replay traffic |
| A lost or stolen phone | Keep access after the Mac revokes that device |
| A second device that pairs silently | Exist: every pairing needs a confirm click on the Mac with a matching 6-digit code |

Out of scope: an attacker who already runs code as the user on the Mac or has the unlocked phone in hand.

## Pairing

All HKDF calls below are HKDF-SHA256 with salt `coool-remote/1` and info `coool-remote/1 <label>`; transcripts are their parts joined by newlines.

1. Mac creates a long-term identity on first enable: an X25519 key (encryption) and an Ed25519 key (signing), private halves in the macOS Keychain. Its `macId` is a random 128-bit id. It registers with the relay (`registerMac`); the first registration of a `macId` wins.
   As built: a generic password, service `coool-remote-identity`, account `coool`, value `v1.<x25519 private>.<ed25519 seed>` (base64url), written through `/usr/bin/security -i` on stdin as `crates/core/src/insights.rs` does, so the key never appears in a process's arguments and reading it never raises a prompt. The known weakness of that pattern applies: the item trusts `/usr/bin/security`, so any process running as the user can read it (the out-of-scope attacker). Self-tests keep the key in a file in their own folder and never touch the Keychain.
2. "Pair an iPhone" creates a pairing: random `pairingId`, random 32-byte `pairingSecret`, expiry now + 2 minutes (the relay caps it there). **Changed in step 1:** the relay gets `pairingId`, the expiry and `relayKey` = HKDF(secret, "relay-proof") rather than a plain hash of the secret, because a keyed proof can't be checked against a hash. One open pairing per Mac: a new one cancels the last.
3. QR payload: `coool://pair?v=1&r=<relay URL>&m=<macId>&p=<pairingId>&s=<secret>&ks=<Mac Ed25519 public>&kx=<Mac X25519 public>`, URL-encoded as `URLSearchParams` encodes it.
4. The phone generates its own two keys and a random 128-bit `deviceId` (private halves in the iOS Keychain, device-only, not synced), then claims the pairing at the relay (`claimPairing`, signed with its new key): `pairingId`, `deviceId`, its public keys, the sealed device name and two proofs. **Changed in step 1:**
   - The device name is sealed for the Mac: `nameBox` = nonce ‖ ChaCha20-Poly1305 under HKDF(secret, "claim-name"), associated data `coool-remote/1`, `name`, pairingId, deviceId. The relay never sees the name.
   - Two proofs over the claim transcript (`coool-remote/1`, `claim`, pairingId, deviceId, signPub, boxPub, nameBox): `proofRelay` = HMAC-SHA256(relayKey, ·), checked by the relay; `proofMac` = HMAC-SHA256(HKDF(secret, "mac-proof"), ·), checked by the Mac. The relay holds only `relayKey`, so it can neither forge `proofMac` nor swap the phone's keys.
   - A pairing takes one claim, only while open and before it expires, and five attempts at most.
5. Both sides compute the 6-digit code: HMAC-SHA256(HKDF(secret, "code"), transcript `coool-remote/1`, `code`, pairingId, macId, Mac signPub, Mac boxPub, deviceId, device signPub, device boxPub), the first 4 bytes big-endian mod 1 000 000, zero-padded. The phone shows it; the Mac shows "Pair *Name*?" with the code, Pair and Cancel. Only the Mac's click completes the pairing: `confirmPairing` (signed by the Mac, within 10 minutes of the pairing's creation) is what creates the device row at the relay, and the Mac adds the device to its own list only then. The phone polls `claimStatus` until `paired`, `refused` (Cancel) or `expired`.
6. The relay marks the pairing used. The device is now in the Mac's device list (name, added date, last seen) with a Remove button.

## Messages

- Session key: X25519(mac, device) through HKDF with info `coool-remote/1 session <dir> <macId> <deviceId> <Mac X25519 public> <device X25519 public>`. Separate keys per direction (`m2d`, `d2m`). A low-order peer key (an all-zero shared secret) is refused.
- Each message: ChaCha20-Poly1305, a 64-bit counter per direction as the nonce (4 zero bytes ‖ the counter big-endian), the routing fields as associated data (`coool-remote/1`, `msg`, dir, macId, deviceId, counter). A receiver rejects any counter it has already seen or that is lower than its high-water mark. **Changed in step 1:** the next counter is max(last + 1, now in microseconds), so a counter never repeats under a key even if the stored one is lost (a reinstall); it stays below 2^53, which JavaScript numbers and Convex's float64 carry exactly.
- Each request to the relay is signed with the sender's Ed25519 key; the relay checks the signature against the key registered at pairing and refuses revoked devices. This is what stops a stranger from filling a Mac's queue. The relay also keeps the highest counter it accepted per device and direction and refuses a `send` at or below it, so a replay is refused at the relay as well as by the receiver.
- Plaintext is JSON `{v, id, t, at, b}`: version, a random id (what a `result` names), type, the sender's clock in epoch ms, and the body. Unknown types are ignored, so either side can be newer.

Mac → phone: `snapshot` (all sessions: id, title, project name, CLI, state, model, last activity; sent on connect and when asked), `session` (one changed), `need` (a pending request with what the Needs-you page shows: kind, tool, command or question, the explanation, the risk tag), `need_gone`, `chat_tail` (the last N items of one chat, on request), `result` (ok or error for a command), `projects` (folders that can start a chat).

Phone → Mac: `hello`, `get_snapshot`, `get_chat`, `answer` (need id, allow once / deny / the chosen option / text), `send` (session id, text), `stop` (session id), `start` (project id, CLI, text), `ack`.

As built:

- Session ids are the app's session keys (`claude:<id>`, `codex:<id>`; `chat:<n>` for a chat started a moment ago). States are `working`, `waiting`, `idle`, `ended`.
- `answer` is `{need, choice}`, `choice` one of `allow_once`, `deny`, `option` (with `option`: a label of the first question) or `answers` (with `answers`: one list of picks per question).
- `result` is `{of, t, ok, error?}`, plus `session` and `mode` for a `start`.
- `stop` is the app's Stop button: the turn ends, the chat stays open.
- A `need` carries the agent's own description of a command as its explanation; the risk tag and the AI read are not sent yet (the page computes them).
- Live changes (`session`, `need`, `need_gone`) go to devices the relay saw in the last 10 minutes (a phone in use acknowledges what it gets, which counts); the rest get a fresh `snapshot` on their next `hello`.
- A project id is 128 bits of SHA-256 of the folder's path: opaque. No path ever goes to the phone.

## Rules on the Mac

All of these are enforced in Rust (`crates/remote/src/rules.rs` and `mac.rs`), before anything reaches the app; the UI only shows them.

- A remote `answer` can allow once or deny. It can never pick an "always allow" option or change a permission mode. (The app only ever receives allow once, deny, or a question's picks; anything else is refused before it reaches the app.)
- `start` only accepts a project id from the Mac's own `projects` list (folders coool already knows), never a path (a body naming `path`, `cwd`, `dir` or `folder` is refused outright). The new chat uses that CLI's default mode with Bypass and full-access excluded: if the default is one of those, the chat starts in the asking mode instead. As built this is a list of allowed modes rather than a list of excluded ones: Claude `default`, `acceptEdits`, `plan`; Codex `untrusted`, `on-request`. Anything else (Bypass, `danger-full-access`, `never`, an unknown or empty mode) becomes Claude `default` / Codex `untrusted`. Ladder stays off; the model is the app's default for new chats.
- `send`, `stop` and `get_chat` reach only chats coool runs, not terminal sessions or ones from other tools.
- Every remote action is recorded with the device name and shown where it happened: a line in the chat ("Allowed Bash from *iPhone name*", "Sent from …", "Stopped from …", "Started from …"), the recent ones in Settings > Remote, and all of them in `remote-actions.jsonl` beside the Mac's Remote state. Refused messages are recorded too.
- Rate limits: on the Mac, per device per minute: answers 30, sends 20, stops 20, starts 5. At the relay: messages from a phone 120 per minute; pairings per Mac 20 per hour; claims per Mac 30 per hour, five attempts per pairing; read sessions 60 per hour.
- Removing a device deletes its keys on the Mac and marks it revoked at the relay; anything it sends afterwards is refused at both. If the relay can't be reached, the Mac still forgets the device at once and retries the revocation on its next connect.
- If coool isn't running, or the Mac is asleep, the phone shows the Mac as offline with the time it was last seen. Nothing is queued for later execution on the Mac: a command older than 60 seconds when it arrives is dropped and reported as expired. "Older" by either clock: the phone's `at`, or when the relay took it (`createdAt`); one more than 60 seconds ahead of the Mac's clock is dropped too.

## Relay (Convex)

Tables: `macs` (macId, signing key, encryption key, created), `devices` (macId, deviceId, signing key, encryption key, revoked, lastSeen, the highest counter accepted each way), `pairings` (pairingId, macId, relayKey, expiry, state open / claimed / used / cancelled, attempts, the claim), `messages` (macId, deviceId, direction, counter, ciphertext, createdAt), `sessions` (token hash, role, macId, deviceId, expiry), `presence` (macId, lastSeen), `rateLimits`.

- Messages are deleted when acknowledged, and by a scheduled sweep after 24 hours. The sweep (every 30 minutes) also clears pairings an hour past expiry, expired read sessions and old rate-limit windows.
- Both clients subscribe to their own queue (Convex live queries). **Changed in step 1:** a live query can't carry a fresh signature on each update, so a client first opens a read session with a signed `openSession`, presenting the SHA-256 of a random 32-byte token only it knows (no randomness is needed on the relay); its subscription (`macInbox` / `deviceInbox`) then passes the token. Sessions last 12 hours; revoking a device deletes its sessions, which ends its subscription at once. `macInbox` holds the devices' messages and the claims waiting for the click; the devices' last-seen times are a separate query (`macDevices`), which the Mac reads at connect and every minute, so its own sends don't re-run its live query.
- No user table and no email addresses anywhere.

### Relay requests

Every mutation is signed: Ed25519 over the UTF-8 of `coool-remote/1`, the function name, its fields in this order, and `ts` (epoch ms), joined by newlines; `ts` must be within 120 seconds of the relay's clock. Every field is checked against a pattern without newlines first. Answers are `{ok: true, ...}` or `{ok: false, code}`, returned rather than thrown, so a refused request still counts against its rate limit.

| Function | Signed by | Fields |
|---|---|---|
| `registerMac` | the key in the request | macId, signPub, boxPub |
| `createPairing` | Mac | macId, pairingId, relayKey, expiresAt |
| `cancelPairing` | Mac | macId, pairingId |
| `confirmPairing` | Mac | macId, pairingId, deviceId |
| `revokeDevice` | Mac | macId, deviceId |
| `heartbeat` | Mac | macId |
| `claimPairing` | the device's new key | pairingId, deviceId, signPub, boxPub, nameBox, proofRelay, proofMac |
| `claimStatus` (query) | the claimant | pairingId, deviceId |
| `openSession` | Mac or device | role, macId, deviceId ("" for the Mac), tokenHash |
| `send` | Mac for `m2d`, device for `d2m` | macId, deviceId, dir, counter, SHA-256 hex of the ciphertext |
| `ack` | the receiver of `dir` | macId, deviceId, dir, upTo |

`debug:dump` is an internal query (no client can call it; the Convex CLI's admin access can). The tests use it to check that the stored rows hold no plaintext.

## The iPhone app (step 2)

- `remote/ios/`: a SwiftUI app (iOS 17 or later, bundle id `sh.coool.remote`, no development team set), its Xcode project generated from `project.yml` with XcodeGen and checked in. Screens: pairing (camera QR scanner, a pasted `coool://pair?...` link, or the link opened from the Camera app through the `coool` URL scheme; then the 6-digit code), sessions grouped by project with live states and the Mac's online / last-seen state, a need's detail (allow once / deny, or the question's options), a chat (its tail, a composer, Stop), starting a chat (a project from the Mac's `projects` list, the CLI, the prompt), settings (this Mac, the in-app haptic and sound, unpair, about).
- `remote/ios/RemoteProtocol/`: the protocol as a Swift package with no UI and no I/O, on CryptoKit (X25519, Ed25519, HKDF-SHA256, HMAC-SHA256, ChaCha20-Poly1305). Its tests read `crates/remote/tests/vectors.json` from the repository and check the refusals (replays and lower counters, tampered and misrouted messages, unknown types, a revoked device). `xcodebuild test -scheme RemoteProtocol` in that folder, or the app's scheme, runs them.
- **Changed in step 2:** CryptoKit's Ed25519 signatures are randomized (hedged), so the Swift side can't reproduce `requestSig` byte for byte. Its test verifies the vector's signature over the bytes it builds (which proves the signed bytes are identical) and checks that its own signatures verify. Every other vector is reproduced exactly. The relay only ever verifies, so nothing else changes.
- The relay client is Convex's official Swift client (`ConvexMobile`, get-convex/convex-swift, pinned to 0.8.2): signed mutations, the read-session token in the `deviceInbox` subscription, and `claimStatus` read through a short subscription (the client has no one-shot query). Numbers go to the relay as float64 (`Double`), as `v.number()` expects. The relay URL comes from the pairing link. No other SDK and no other network calls.
- Keys: one Keychain item (generic password, service `sh.coool.remote`, account `pairing`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, not synchronizable: never in iCloud Keychain, never restored to another device) holding the identity and the pairing; the counters, which are not secret, in the app's defaults.
- The link is open only while the app is in the foreground: a read session and the live query on `deviceInbox`, `hello` on connect (the Mac answers with `snapshot` and `projects`); everything taken is acknowledged. When the live query reports its session gone, the app opens a new one; if that is refused as `revoked` (or a `send` is), the app forgets the pairing and returns to the pairing screen saying the Mac removed it. Unpair on the phone forgets the Mac locally only (the relay has no device-side revoke); the Mac lists the phone until it is removed there.
- What the phone can say is typed: `answer` takes allow once, deny, a question's option or picks (no "always", no mode); `start` takes a `Project` from the Mac's list, never a path. A chat's tail is asked for with `get_chat` when the chat opens, when its state changes, and every few seconds while it works.

## Minor 1: richer watching and building

The envelope stays `v: 1`. A minor adds message types and optional fields only. The phone says `minor: 1` in `hello`;
the Mac answers `snapshot` with `minor: 1` and sends the new types only to a phone that said it.

**Mixed versions.** Unknown types are ignored both ways, and every new field is optional:
- A new phone with an older Mac: `watch` and the other new commands are ignored. The phone sees no `chat`, `overview`
  or `options` and falls back to polling `get_chat` and to the old start (the Mac's default model and mode). A send
  with `when` or `attachments` arrives as a plain send (the older Mac ignores both fields).
- An older phone with a new Mac: it never says `minor`, so it gets no `options`, `overview`, `chat`, `image` or
  `frame`. Its `start` has no `mode` or `model`, so the old rule applies (the default mode, or the asking mode if
  that is Bypass or full access).

Mac → phone (new): `options` (per CLI: the models Settings > General offers, the modes a phone may start in, the
defaults), `overview` (Mission control: per project the live sessions, sub-agents and their steps, the Changes
ledger, files two sessions edit within an hour, the last commits and branch; plan usage per provider), `chat` (a
chat's live view: items upserted by key, `cursor`, `reset`, and `live`: state, the text streaming in, thinking, the
step, sub-agents with their steps, the turn's tally, the device panels its agent uses), `image` (a chat's image in
chunks), `frame` (a device panel's picture). `session` gains `step`, `agents`, `steps`, `turn_started`; `need` gains
`what`, `risk` (the page's risk tag), `read` (the AI read, when the page has one), `diff` (an Edit / MultiEdit / Write
request's change) and `plan` (an ExitPlanMode request's Markdown); `result` gains `model` and `upload`.

Phone → Mac (new): `watch` / `unwatch` (a chat's live view, a 30 s lease renewed every 10 s while it is on screen),
`watch_device` / `unwatch_device` (`browser`, `simulator` or `mac`; same lease), `get_image` (session, key),
`upload` (one part of an image). `send` gains `when` (`send`, `next`: a note taken in at the next step, `interrupt`:
cut the step in progress, as the Mac's composer) and `attachments` (upload ids); `start` gains `model`, `mode` and
`attachments`; `answer` on a plan gains `keep_planning` with an optional `note` (the Mac's Keep planning; the note
goes in as a steering note).

Rules (crates/remote `rules.rs`, `live.rs`, `mac.rs`, all tested):
- `start`: a `mode` must be one of the asking modes (Claude `default`, `acceptEdits`, `plan`; Codex `untrusted`,
  `on-request`). Anything else, Bypass and full access included, is refused with "a chat started from the phone
  can't use that mode" (not swapped for another). A `model` must be one of the ids the Mac offers for that CLI.
- No message can change a running chat's mode: `send` carries no mode, and a mode field on it is ignored.
- `upload`: no name or path field exists; the upload id is 128 bits of hex; parts must add up to the declared size
  (at most 2 MB, 48 KiB per part), at most four open per device, two minutes to finish; the bytes must be PNG, JPEG,
  GIF or WebP by their first bytes (checked on the first part and again on the whole), then again by the app, which
  stores them with `attach::store_bytes` in coool's own attachment store, named by hash, as a pasted image. A finished
  upload is usable once, by the device that sent it, for ten minutes. Recorded as "sent an image (N KB)".
- `watch`, `watch_device`, `get_image` reach only chats coool runs. Images go only by a key that chat's own messages
  hold, from the attachment store; diffs and plans come only from that chat's requests and steps; never from a path
  the phone names. Frames are view only: there is no message that sends input to a device, and a new frame stream is
  recorded ("watched the Browser panel (view only)").
- Per device per minute on the Mac: image parts 90, images asked for 12, watch renewals 30. Uploads are commands:
  older than 60 seconds, dropped.

Sizes and rates (the relay takes a ciphertext of at most 131 072 base64url characters per message, about 98 KB):
- A chunk carries 48 KiB of image bytes (65 536 base64url characters in the JSON); sealed, about 87 600 characters.
- Phone → Mac images: scaled to at most 1600 px and JPEG 0.72 (typically 150-400 KB: 4-9 messages); at most 2 MB (42
  messages). At most four per message. The relay's own limit is 120 messages a minute from a phone.
- Mac → phone images: scaled to at most 1024 px JPEG, at most 600 KB (13 messages), only when a chat item showing it is
  on screen, each asked for once.
- Device frames: at most 420 px on the long side, JPEG 0.45 (typically 15-40 KB, at most 60 KB: one message), at most
  one every 2.5 s, only while the device view is open and only when the picture changed. Worst case 24 messages and
  about 1.4 MB of ciphertext a minute; a static page sends one. Plus 6 lease renewals a minute.
- A watched chat: at most one `chat` message a second while something changes (items packed under 60 KB of JSON per
  message), none when nothing does; 6 lease renewals a minute.
- `overview`: looked at every 3 s, sent only when it changed, only to phones in use.
- Every message is deleted at the relay as soon as the phone acknowledges it, so the stored total stays small; each
  document is far under Convex's 1 MiB limit.

No relay function or schema changed for minor 1.

## Minor 2: a message box with what the Mac's has

The phone says `minor: 2` in `hello`; the Mac answers `snapshot` with its own minor. Still envelope `v: 1`, new types
and optional fields only.

Phone → Mac (new): `note` (`{session, note, do: "cancel" | "now"}`: withdraw a queued steering note, or deliver it
now by interrupting the step, as the Mac's strip does; only a note that chat lists as queued), `set_model`
(`{session, model}`), `transcribe` (`{upload, session?}`: a recording sent first with `upload`). `upload` gains `kind`
(`image` when absent, `file`, `audio`) and, for a file, `ext` (a suggested ending, used only if it is on the Mac's
fixed list). Mac → phone (new fields): `chat` gains `meta` (`cli`, `model`, `models` the chat can switch to,
`model_locked` when it can't, `mode` and `mode_label` (read only on the phone), `context` and `window`, `commands`:
the CLI's slash commands with `kind` `command`, `skill`, `terminal` (works only in the CLI's own UI) or `app` (the
Mac's composer answers it itself; the phone opens its own equivalent)), sent only to a minor 2 phone and only when it
changed; `live` gains `notes` (the strip's queued and unused notes: id, text, state, attachments); `result` gains
`note` (a send that went in as a note), `text` and `heard` (a transcription).

Rules (crates/remote, tested):
- `note`: the id must be a note of that chat that is still queued (the app checks its events); `cancel` or `now`
  only. Recorded ("removed a queued note", "delivered a queued note now").
- `set_model`: only a model the Mac offers for that chat (the CLI's own list for it, else Settings > General's list
  for its CLI), through the Mac's own path (`chat_set_model`: Claude switches at once; Codex from its next turn). The
  body's other fields are never read: there is still no message that changes a running chat's permission mode, and
  the phone shows the mode read only, saying it can be changed on the Mac.
- Files: a PDF (by `%PDF-`) or UTF-8 text without control bytes, checked on the first part and again whole, at most
  2 MB, four attachments per message as before. The Mac stores it with `attach::store_bytes` in coool's own store as
  `iPhone file.<ending>` (the ending from a fixed list, `.pdf` for a PDF, else `.txt`); the agent gets its path, as
  the Mac's own attachments. Recorded ("sent a file (N KB)").
- Recordings: AAC in MPEG-4 or WAV by their bytes, at most 1 MB and 120 s (checked once decoded), kept in the engine's
  memory until their `transcribe` (two minutes at most), used once, never stored as an attachment. The Mac decodes
  AAC with macOS's `afconvert` in a private temporary folder (mode 700) deleted as soon as it is read, runs the
  samples through its own dictation (`voice::transcribe_samples`: the person's model, translate or transcribe,
  language and guards), and the page cleans the text and applies the person's word memory as a dictation on the Mac
  is. The samples are dropped when the job ends (or after two minutes without the page); nothing is written to the
  voice folder. The text goes back as the `transcribe`'s `result`, to the phone's field for review: never sent
  without the person. Recorded ("sent a recording to transcribe (N KB)", "asked for a transcription").
- Per device per minute: notes 30, model switches 10, transcriptions 6; their parts count as uploads (90). Like every
  command, older than 60 s: dropped.

Sizes: a recording is AAC at 16 kHz mono, about 24 kbit/s (3 KB a second: a 10 s request is about 30 KB, one
message; two minutes about 360 KB, eight messages). Files as images: 48 KiB per message, at most 42 messages.

Mixed versions: a minor 1 Mac ignores `note`, `set_model` and `transcribe` and sends no `meta` or `notes`: the phone
then shows no model, mode or command chips and no notes strip, and offers dictation only when the Mac's snapshot says
minor 2 or later (nothing is sent to a Mac that can't transcribe). A file sent to a minor 1 Mac is refused there as
"not an image". A minor 1 phone (or remote/phone, the stand-in) gets nothing new from a minor 2 Mac.

The phone (remote/ios): the chat's message box is a compact bar (add, the field with the microphone, one button that
morphs between send and stop), the notes strip above it, the chat's state as chips (model, mode, context, commands)
and a tray for pictures, files, the model, the mode and commands. Messages appear at once and settle into the Mac's
copy; replies stream a word at a time. Drafts are kept per chat. On-device speech recognition is not used: dictation
needs the Mac.

Not in minor 2: the Ladder chip (its per-chat state lives in the Mac's page, not in the backend; the phone shows a
`ladder` field if the Mac ever sends one), changing a running chat's mode (deliberately), on-device speech
recognition.

No relay function or limit changed for minor 2.

## No push notifications

The owner decided the iPhone app sends no push notifications. The relay holds no push token and never talks to Apple. The phone learns that an agent needs you only while the app is open (it shows needs live, with a badge and a sound in the app). The Mac's own notifications are unchanged.

## Build order

1. Relay and the Mac side, tested with a command-line stand-in for the phone (pair, snapshot, answer, send, stop, start, revoke, replay refused). Built. Tests: `cd remote/phone && npm test` (the relay's threat model against the dev deployment, and the shared vectors), `cargo test -p coool-remote` (the Mac's half and the rules), `remote/e2e/run.sh` (the real app and the stand-in phone, three Haiku turns). Before the iPhone app ships: deploy the relay to the production deployment and point the app's default relay at it (`DEFAULT_RELAY` in app/src-tauri/src/remote.rs; it is the dev deployment's URL today).
2. The iPhone app (SwiftUI): pairing scanner, session list, need detail with answer buttons, chat view with composer, settings. Built. Tests: `RemoteProtocol`'s unit tests (the vectors and the refusals), and `remote/ios/e2e/run.sh` (the real Mac app and this app in the Simulator, driven by XCUITest through the same self-test scenario as step 1).
3. TestFlight.
