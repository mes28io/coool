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

Not in the first version: push notifications (decided against), accounts and sign-in, a terminal, file browsing, the device panels, changing settings, "always allow" answers, Bypass / full-access modes.

## Decisions

1. **Pair by QR, no account.** The Mac shows a QR code; the phone scans it once. That pairing is the identity. Accounts can be layered on later (several Macs, a web client) without changing the message format.
2. **It works away from home through a relay.** The QR code is only the introduction. Afterwards both sides connect outwards to the relay; the Mac opens no ports and needs no router setup.
3. **The relay is Convex** (the owner's team `mes`, a project named `coool-remote`).
4. **End-to-end encrypted.** The relay stores and forwards ciphertext. It never sees session titles, prompts, commands, paths, answers or the phone's name. It knows: which Mac id talks to which device id, when, and message sizes.
5. **Off by default.** Nothing connects to the relay until the user turns Remote on in Settings and pairs a phone.

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

## No push notifications

The owner decided the iPhone app sends no push notifications. The relay holds no push token and never talks to Apple. The phone learns that an agent needs you only while the app is open (it shows needs live, with a badge and a sound in the app). The Mac's own notifications are unchanged.

## Build order

1. Relay and the Mac side, tested with a command-line stand-in for the phone (pair, snapshot, answer, send, stop, start, revoke, replay refused). Built. Tests: `cd remote/phone && npm test` (the relay's threat model against the dev deployment, and the shared vectors), `cargo test -p coool-remote` (the Mac's half and the rules), `remote/e2e/run.sh` (the real app and the stand-in phone, three Haiku turns). Before the iPhone app ships: deploy the relay to the production deployment and point the app's default relay at it (`DEFAULT_RELAY` in app/src-tauri/src/remote.rs; it is the dev deployment's URL today).
2. The iPhone app (SwiftUI): pairing scanner, session list, need detail with answer buttons, chat view with composer, settings. Built. Tests: `RemoteProtocol`'s unit tests (the vectors and the refusals), and `remote/ios/e2e/run.sh` (the real Mac app and this app in the Simulator, driven by XCUITest through the same self-test scenario as step 1).
3. TestFlight.
