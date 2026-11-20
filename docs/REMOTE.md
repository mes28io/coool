# coool Remote: design

Status: design, not built. This file is the contract between the three parts (relay, Mac app, iPhone app).

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
4. **End-to-end encrypted.** The relay stores and forwards ciphertext. It never sees session titles, prompts, commands, paths or answers. It knows: which Mac id talks to which device id, when, and message sizes.
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

1. Mac creates a long-term identity on first enable: an X25519 key (encryption) and an Ed25519 key (signing), private halves in the macOS Keychain. Its `macId` is a random 128-bit id.
2. "Pair an iPhone" creates a pairing: random `pairingId`, random 32-byte `pairingSecret`, expiry now + 2 minutes. The relay gets `pairingId`, a hash of the secret and the expiry.
3. QR payload (a `coool://pair?...` URL): relay URL, `macId`, `pairingId`, `pairingSecret`, the Mac's two public keys, protocol version.
4. The phone generates its own two keys (private halves in the iOS Keychain, device-only, not synced), then sends to the relay: `pairingId`, proof of the secret (HMAC over its public keys), its public keys, a device name.
5. Both sides compute a 6-digit code from a hash of both sides' public keys and the pairing secret. The phone shows it; the Mac shows "Pair *Name*? Code 123 456" with Pair and Cancel. Only the Mac's click completes the pairing.
6. The relay marks the pairing used. The device is now in the Mac's device list (name, added date, last seen) with a Remove button.

## Messages

- Session key: X25519(mac, device) through HKDF-SHA256 with `macId`, `deviceId` and the protocol version as context. Separate keys per direction.
- Each message: ChaCha20-Poly1305, a 64-bit counter per direction as the nonce, the routing fields as associated data. A receiver rejects any counter it has already seen or that is lower than its high-water mark.
- Each request to the relay is signed with the sender's Ed25519 key; the relay checks the signature against the key registered at pairing and refuses revoked devices. This is what stops a stranger from filling a Mac's queue.
- Plaintext is JSON with `v`, `id`, `t` (type) and a body. Unknown types are ignored, so either side can be newer.

Mac → phone: `snapshot` (all sessions: id, title, project name, CLI, state, model, last activity; sent on connect and when asked), `session` (one changed), `need` (a pending request with what the Needs-you page shows: kind, tool, command or question, the explanation, the risk tag), `need_gone`, `chat_tail` (the last N items of one chat, on request), `result` (ok or error for a command), `projects` (folders that can start a chat).

Phone → Mac: `hello`, `get_snapshot`, `get_chat`, `answer` (need id, allow once / deny / the chosen option / text), `send` (session id, text), `stop` (session id), `start` (project id, CLI, text), `ack`.

## Rules on the Mac

- A remote `answer` can allow once or deny. It can never pick an "always allow" option or change a permission mode.
- `start` only accepts a project id from the Mac's own `projects` list (folders coool already knows), never a path. The new chat uses that CLI's default mode with Bypass and full-access excluded: if the default is one of those, the chat starts in the asking mode instead.
- Every remote action is recorded with the device name and shown where it happened ("Allowed from *iPhone name*").
- Rate limits: answers and sends per device per minute; pairing attempts per hour.
- Removing a device deletes its keys on the Mac and marks it revoked at the relay; anything it sends afterwards is refused at both.
- If coool isn't running, or the Mac is asleep, the phone shows the Mac as offline with the time it was last seen. Nothing is queued for later execution on the Mac: a command older than 60 seconds when it arrives is dropped and reported as expired.

## Relay (Convex)

Tables: `macs` (macId, signing key, created), `devices` (macId, deviceId, signing key, revoked, lastSeen), `pairings` (pairingId, secret hash, expiry, used), `messages` (macId, deviceId, direction, counter, ciphertext, createdAt), `presence` (macId, lastSeen).

- Messages are deleted when acknowledged, and by a scheduled sweep after 24 hours.
- Both clients subscribe to their own queue (Convex live queries), authenticated by signature.
- No user table and no email addresses anywhere.

## No push notifications

The owner decided the iPhone app sends no push notifications. The relay holds no push token and never talks to Apple. The phone learns that an agent needs you only while the app is open (it shows needs live, with a badge and a sound in the app). The Mac's own notifications are unchanged.

## Build order

1. Relay and the Mac side, tested with a command-line stand-in for the phone (pair, snapshot, answer, send, stop, start, revoke, replay refused).
2. The iPhone app (SwiftUI): pairing scanner, session list, need detail with answer buttons, chat view with composer, settings.
3. TestFlight.
