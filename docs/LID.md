# Keep working with the lid closed

Settings > General > **Keep working with the lid closed** (off by default). Code: `app/src-tauri/src/lid/` (state
machine, socket client, installer, sensors), `app/src-tauri/native/coool-lid-helper.m` (the root helper),
`app/src/components/settings/LidAwake.tsx` + `app/src/lib/lid.ts` (UI). Behaviour in APP_SPEC "Settings > General".

**Status: the privileged path has never been run for real.** Everything below was checked by reading Apple's
headers and the xnu source, by unit tests with a fake helper, and by the real helper binary in its `--dry-run` mode
(every check runs; the commands are printed instead of run). Nobody has installed the helper, closed a lid, or let
`pmset disablesleep 1` run on a Mac yet. The owner's test plan is at the end.

## What macOS does (macOS 27.0.1, Darwin 27, checked 2026-11-19)

- **A closed lid ignores power assertions.** In xnu's `IOPMrootDomain::handlePowerNotification`, a closed lid calls
  `privateSleepSystem(kIOPMSleepReasonClamshell)` whenever `shouldSleepOnClamshellClosed()` is true. That sleep
  request only checks `checkSystemSleepEnabled()`, which looks at the `userDisabledAllSleep` flag (the SleepDisabled
  switch), boot/shutdown state and a few kernel conditions. It does not look at assertions. So
  `PreventUserIdleSystemSleep` (`caffeinate -i`, coool's "Prevent sleep while agents are working") does nothing
  against the lid. `PreventSystemSleep` (`caffeinate -s`) is documented in `IOPMLib.h` as "deprecated in 10.9. This
  assertion is not supported in any OS X releases."
- **Closed-display mode:** `shouldSleepOnClamshellClosed()` is
  `!clamshellDisabled && !(desktopMode && acAdaptorConnected) && !clamshellSleepDisableMask`. With an external display
  (`desktopMode`) on AC, the lid doesn't sleep the Mac, and no privileges are needed. The registry exports the result
  as `AppleClamshellCausesSleep` (No in that mode). Idle sleep still applies then, so an idle-sleep assertion is still
  needed. Modern macOS no longer requires an external keyboard for this mode.
- **SleepDisabled** (`pmset disablesleep 1`, undocumented in `man pmset` but present in the binary) sets the root
  domain property `SleepDisabled`, which sets `userDisabledAllSleep`. That stops lid sleep and idle sleep alike, on
  battery too. Display sleep is unaffected.
- **Who may set it:** `IOPMrootDomain::setProperties` accepts `SleepDisabled` only from a task holding the private
  entitlement `com.apple.private.iokit.rootdomain-set-property`. Unentitled callers, even root, can only set the
  scheduled-wake keys. `/usr/bin/pmset` carries that entitlement (`codesign -d --entitlements - /usr/bin/pmset`).
  So **a third-party helper cannot call `IOPMSetSystemPowerSetting` itself. It has to run Apple's `pmset` as root.**
  This is why tools like Amphetamine's "closed-display mode" use a privileged helper or an admin-authorised `pmset`.
- **Turning it off doesn't re-check the lid.** `kPowerEventUserDisabledSleep` only stores the flag; nothing
  re-evaluates the clamshell. If sleep is restored while the lid is closed, the Mac would stay awake until idle sleep
  (or forever, if another app holds an assertion). That's the in-a-bag case. So the helper runs `pmset sleepnow`
  right after restoring, when the lid is closed and `AppleClamshellCausesSleep` is Yes.
- **Persistence:** whether `disablesleep` survives a restart isn't documented. The helper is a RunAtLoad daemon and
  restores at every start if its marker says it set the switch, so a restart can't leave it on either way.
- **Readable by anyone:** `AppleClamshellState`, `AppleClamshellCausesSleep` and `SleepDisabled` on `IOPMrootDomain`
  (`ioreg -r -k AppleClamshellState -d 1`), the battery (`IOPSCopyPowerSourcesInfo`), and
  `NSProcessInfo.thermalState`.
- **Network:** with SleepDisabled the Mac never enters sleep or dark wake. It stays in full wake with the display
  off, so Wi-Fi and the CLIs' connections stay up. Power Nap, "Wake for network access" (`womp`) and `tcpkeepalive`
  only matter during sleep or dark wake, so they play no part here.

## What each privilege level allows

| Level | What works with the lid closed |
|---|---|
| None (any app, ad-hoc signed) | Only closed-display mode: external display + AC, plus an idle-sleep assertion. Not on battery, not without a display. |
| One administrator approval, then a root LaunchDaemon (chosen) | Everything: SleepDisabled through `/usr/bin/pmset`, with a watchdog that doesn't depend on coool being alive. |
| A sudoers.d rule for `pmset disablesleep 0/1` | SleepDisabled, but nothing restores it if coool dies. |
| Admin prompt each time | SleepDisabled, but useless unattended, and still no watchdog. |

### Alternatives compared

- **Root LaunchDaemon installed once with `osascript … with administrator privileges` (chosen for ad-hoc and local
  builds).**
  - Security surface: one small C/ObjC program in the repo, a strict line protocol (STATUS, HOLD, BEAT, RELEASE,
    UNINSTALL) and a fixed set of commands, with no shell.
  - Watchdog: it lets go when coool's socket closes (crash, force quit, kill -9), when heartbeats stop (a hung coool),
    at its own battery floor and on heat, on SIGTERM, and at every start (restart, its own crash).
  - Survives rebuilds: the binary is copied into `/Library/PrivilegedHelperTools`, and the only caller check is the
    connecting user's uid, so coool's ad-hoc signature changing on every build doesn't matter (the trap that broke
    other approvals). Only a protocol change asks for a reinstall ("Update…").
  - Uninstall: the helper removes itself on request with no password; otherwise a second approval runs a fixed
    removal script.
  - UX: one password prompt, ever.
- **SMAppService daemon (`SMAppService.daemon(plistName:)`), for a future Developer ID build.** The helper ships
  inside the app (`Contents/Library/LaunchDaemons`, `BundleProgram`). The person approves it in System Settings >
  General > Login Items, with no password dialog. The helper can then require the caller's code signature
  (`anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"`) on top of the uid check. Not used for ad-hoc
  builds: the approval and launchd's trust are tied to the code signature, which changes on every ad-hoc rebuild. The
  same protocol and binary carry over unchanged. Only the installer differs. SMJobBless is deprecated since macOS 13
  and needs Developer ID on both sides.
- **sudoers.d rule** (`you ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1`).
  - Smallest root surface of all.
  - No watchdog: a coool killed while holding leaves sleep disabled until its next launch notices. That's the worst
    failure this feature has.
  - No independent battery or heat check.
  - A malformed sudoers file can break `sudo` (mitigated by `visudo -c`).
  - Rejected for the missing watchdog.
- **Admin prompt each time it engages.** Rejected: an agent that starts working at 2 am can't wait for a password.
- **Do nothing privileged.** That's the fallback that still works: the setting holds in closed-display mode with no
  helper and says so.

## How it works

### Holding

- **The count.** On every refresh (~1 s), coool counts the agents working right now: chats mid-turn plus coool's busy
  terminal sessions. A chat waiting on the person (permission prompt, question) doesn't count: it is counted apart, and
  a prompt left waiting with the lid closed releases the hold after a short grace ("A chat that asks" below).
- **When to hold.** While the count is above zero and the limits allow:
  1. If the helper is ready, coool sends `HOLD 60` on a connection it keeps open, and a `BEAT` every 15 s. It writes
     its own marker (`~/Library/Application Support/coool/lid-hold.json`). The keep-awake assertion steps aside, since
     SleepDisabled covers idle sleep too, so the Mac is never held twice. The Settings row says "covered".
  2. Otherwise, in closed-display mode, coool holds the no-idle-sleep assertion (`power::Keeper::set_lid`), even with
     "Prevent sleep" off.
  3. Otherwise: "Needs one-time approval".
- **When to release.** As soon as the count is zero and nobody waits (the work finished), the setting goes off, or a
  limit hits: `RELEASE`, marker removed. The keep-awake assertion comes back if its own setting is on. When the count
  is zero but agents wait on the person, after the grace (next section).

### A chat that asks

A permission prompt or a question stops an agent until someone answers. With the lid closed nobody can, so holding
the Mac awake for it would only spend battery and heat. Instead coool makes the situation visible before, during and
after, and makes the unattended path one click away.

- **What counts as waiting.** On every refresh, next to the working count (`Core::collect` in `lib.rs`), coool counts
  the chats whose state is `WaitingPermission` (a pending permission or question) and coool's terminal sessions the
  CLI reports blocked on the person (`waiting_for`), and passes the first one: its title as the app shows it, what it
  asked in the needs-you notification's words (`notify::ask_of`, kept per chat by the output pump), its session key and
  request id (`Lid::tick_with(now, working, waiting, asker)`). A chat that finished is idle, not waiting.
- **Before.** While the setting is on, something would hold a closed Mac (the helper ready, or closed-display mode),
  and a chat runs a turn in a mode that asks (Claude Ask, Accept edits, Plan; Codex Untrusted, On request), one line
  sits above its message box (`components/LidAskBanner.tsx`): "Lid-closed is on, but this chat asks before it acts: it
  will pause, and the Mac will sleep, at its first prompt." Its button picks the first mode in the composer's list (least
  permissive first) that doesn't ask and isn't a bypass (`lidModeFix` in `lib/lid.ts`): for Codex **Switch to Never
  ask** (approvals off, the chat's sandbox unchanged). Claude's list has no such mode (Accept edits still asks before
  commands; only Bypass doesn't ask), so for Claude the button is **Choose a mode…** and opens the mode menu, whose
  warning names Bypass and says to use it only where the task is trusted. No mode ever changes without the click.
  **Dismiss for this chat** hides it for that chat (by chat id, and by session id across launches). The Settings row
  lists the working chats in a mode that asks ("2 working chats are in a mode that asks: …", each opens its chat).
- **During: the grace.** When the last working agent starts waiting, the hold carries on for "When every agent waits
  on you, keep holding for" (0, 1, 2, 5 or 10 min; default 2 min; `grace_mins`): long enough for a quick lid reopen, or
  for another agent to resume. Any agent working again cancels it, and the next wait starts a fresh one. All the safety
  limits below, and the helper's floor, still apply during the grace and win. Settings shows "Holding a little longer:
  “Fix the build” is waiting for your answer. If nobody answers, the Mac can sleep at 02:16."
- **After.** When the grace runs out with the lid closed, coool lets go and records a stop (`Code::Waiting`, with the
  chat, session and request): "Let the Mac sleep at 02:14: “Fix the build” was waiting for your answer (Bash: npm
  test)." It is listed under the row and notified when the lid opens; a click on the notification opens the Needs you
  page on that item (or its chat, once answered; `notify::Target::of_lid_stop`), and the item's header says "This paused
  a lid-closed run at 02:14". With the lid open the grace ends quietly (the person is there; the needs-you notification
  already went out).

### Safety limits (enforced)

- **Only while on power.** Default on. If the Mac goes onto battery, coool lets go, and holds again on AC.
- **On battery at or below a threshold.** Default 20%, configurable from 10 to 50. It lifts at threshold + 3 or on AC.
- **Thermal state serious or critical.** coool lets go and doesn't hold again until the agents stop (or the setting is
  switched off and on).
- **Maximum duration of one working stretch.** Default 8 h; 1, 2, 4, 8, 12 or 24 h, or no limit (shown with a
  warning). It latches like heat.
- **The helper's own floor,** whatever coool says: on battery at or below 10%, or thermal serious or critical, it
  lets go and refuses `HOLD`.

### Watchdog and recovery

- coool killed, crashed or force-quit: the kernel closes the socket, and the helper restores at once.
- coool hung: no `BEAT` for 60 s, and the helper restores.
- The helper killed: launchd restarts it (KeepAlive), and its start sees the marker and restores.
- The Mac restarted while holding: RunAtLoad, the marker, restore.
- When the helper lets go with the lid closed and closing the lid sleeps this Mac, it runs `pmset sleepnow`.
- **Next launch of coool.** Its own marker means it quit while holding. If the switch reads off, the event is recorded
  ("coool quit while holding the Mac awake (holding since 01:10); normal sleep was restored"). If the switch is still
  on and no helper answers, Settings shows a warning with **Restore normal sleep…** (an admin prompt running
  `/usr/bin/pmset -a disablesleep 0`).
- **Automatic releases** are recorded (the last 10, in `lid-stops.json` next to `settings.json`), shown in Settings
  ("Stopped holding the Mac awake at 02:14: battery 20%."), and posted as a notification ("coool let the Mac sleep"):
  at once with the lid open, or when it opens again. So is the end of a grace with every agent waiting (above).

### What gets installed, and how it goes away

| Path | Owner, mode | What |
|---|---|---|
| `/Library/PrivilegedHelperTools/sh.coool.lid-helper` | root:wheel 0755 | the helper (bytes embedded in coool, built from `native/coool-lid-helper.m`) |
| `/Library/LaunchDaemons/sh.coool.lid-helper.plist` | root:wheel 0644 | RunAtLoad, KeepAlive, `--uid <your uid>` |
| `/var/db/sh.coool.lid-helper/held` | root 0700 dir | the helper's marker (only while holding) |
| `/var/run/sh.coool.lid-helper/s` | dir root 0755, socket yours 0600 | the socket |

- **Logs:** the unified log (`log show --last 1h --predicate 'process == "sh.coool.lid-helper"'`), no log file.
- **Install script.** coool stages both files in `~/Library/Application Support/coool/lid-helper/` (0700), and the
  root script does the rest:
  1. `install -o root -g wheel` them as `*.new` beside the destination.
  2. Compare their SHA-256 with the hashes coool computed from the bytes in memory, and refuse if either differs.
  3. `mv` them into place.
  4. `launchctl bootout` any old one, then `launchctl bootstrap system <plist>`.
- **The script is an argument to `osascript`,** never spliced into AppleScript source. Paths are single-quoted, and
  control characters are refused.
- **Removal:**
  - **Remove helper,** or switching the setting off: the helper releases, deletes its two files, its marker and socket
    folders, and runs `launchctl bootout system/sh.coool.lid-helper`. No password.
  - If it doesn't answer, an admin prompt runs:
    1. `launchctl bootout system/sh.coool.lid-helper`.
    2. `pmset -a disablesleep 0`, only if the helper's marker exists.
    3. `rm -f` the plist, the binary and the `.new` files, `rm -rf` the two folders.
- **By hand:**
  ```sh
  sudo launchctl bootout system/sh.coool.lid-helper
  sudo rm -f /Library/LaunchDaemons/sh.coool.lid-helper.plist /Library/PrivilegedHelperTools/sh.coool.lid-helper
  sudo rm -rf /var/db/sh.coool.lid-helper /var/run/sh.coool.lid-helper
  sudo pmset -a disablesleep 0
  ```

## Threat note (the helper as if hostile-reachable)

- **What it can do:** run three fixed commands with fixed arguments, with no shell and an empty environment:
  - `/usr/bin/pmset -a disablesleep 1|0`
  - `/usr/bin/pmset sleepnow`
  - `/bin/launchctl bootout system/sh.coool.lid-helper`

  It can also delete its own fixed files. It takes no paths, file names or command text from anyone. The installed
  form refuses `--socket`, `--state`, `--sensors` and `--exit-with-stdin`.
- **Who can reach it.** The socket is mode 0600 and owned by the installing user, inside a root-owned 0755 folder.
  Every accepted connection is checked again with `getpeereid` (that uid, or root). At most 4 connections at a time.
  Only the holding connection can BEAT or RELEASE its hold.
- **Input:**
  - Printable ASCII lines of at most 63 bytes. Anything else (a non-printable byte, an overlong line, an unknown
    command, a malformed lease) gets `ERR` and the connection is closed.
  - The lease must be 1 to 3 digits, 10 to 300.
  - The uid must be all digits and not 0.
- **Its own files.** At start it checks:
  - it runs from `/Library/PrivilegedHelperTools/sh.coool.lid-helper`, owned by root and not group- or world-writable;
  - that folder is root's and not writable by others;
  - its state and run folders are root's, not symlinks, and not writable by others.

  The marker is opened with `O_NOFOLLOW`. A non-socket at the socket path is refused, not removed.
- **What a same-user attacker gains.** Any process running as you can ask it to keep the Mac awake, within the
  helper's own limits (battery floor, heat, heartbeat), and remove it. That's a nuisance (battery drain), not a
  privilege escalation. Anything running as you can already do worse. For an ad-hoc build there is no stronger caller
  identity to check: an ad-hoc signature can be forged by anyone. A Developer ID build should add a code-signing
  requirement.
- **Install-time race.** The staging folder is yours, so something running as you could swap a file between staging
  and copying. The root script compares hashes after copying into the root-owned destination and refuses a mismatch.
- **Already disabled by someone else.** If SleepDisabled is already on and the helper has no marker, it answers
  `ERR already-disabled` and never touches the switch, so it never turns off something the person set.
- **Remaining risks:**
  - The real install, `pmset`, `sleepnow` and bootout paths are untested on hardware.
  - `pmset disablesleep` is undocumented and could change in a future macOS.
  - The heat check is `NSProcessInfo.thermalState`, which reacts late compared with a bag's insulation; the UI says so
    plainly.
  - `CLOCK_MONOTONIC` leases assume the Mac didn't sleep while holding (if it did, the lease has run out by the next
    check, which is the safe side).

## Testing

- **With fakes** (`cargo test -p coool-app lid::`), using the state machine with a fake helper and fake sensors:
  - engage and release on the agent count;
  - the heartbeat cadence;
  - the helper letting go on its own;
  - only on power, the battery threshold and its hysteresis;
  - heat latching, the maximum duration, no limit;
  - notices waiting for the lid to open;
  - closed-display mode, and the hand-over to the helper;
  - helper refusals (already-disabled, the battery floor, unreachable);
  - no lid;
  - switching off removes the helper; Remove helper while holding;
  - crash recovery from the marker, the stale switch;
  - drop releases; the simulated kill; clamped limits;
  - the grace: it starts when the last agent waits and keeps beating, a working agent cancels it (a later wait starts
    a fresh one), it runs out into a `waiting` stop naming the chat, its session and request (kept on disk, noticed when
    the lid opens), nothing is recorded with the lid open or when the work finished, no grace when nothing was held,
    0 min lets go at once, and battery, heat, the maximum duration and switching off all win during it.
- **Notifier** (`notify::tests`): a `waiting` stop's notice targets the Needs you item (`Target::of_lid_stop`), any
  other only brings coool forward; `ask_of` gives the request id and the needs-you words.
- **Pure UI logic** (`lib/lid.test.ts`): the banner's button per CLI (`lidModeFix`), when the banner can show
  (`lidWouldHold`), the grace line, the stop text, the Needs you match (`pausedBy`).
- **The real helper in `--dry-run`** (`lid::helper::tests`):
  - hold, beat, release, busy;
  - connection close releases;
  - **a holder killed with SIGKILL releases** (`nc -U` holding, then `kill -9`);
  - no heartbeat releases;
  - `sleepnow` only with the lid closed and not in closed-display mode;
  - the battery floor and heat, refused and mid-hold;
  - a marker at start restores before listening;
  - bad requests (bad leases, unknown or lower-case commands, shell text, control bytes, an overlong line) are refused
    and the connection closed;
  - the 4-connection cap;
  - UNINSTALL; SIGTERM;
  - start-up refusals (not root, path flags in the installed form, uid 0 or garbage, folders writable by others or
    symlinked, a non-socket at the socket path, an overlong socket path);
  - coool's client against it: install (dry), hold, kill, uninstall;
  - the whole lid hold end to end;
  - the install script's quoting and hash checks; the plist passes `plutil -lint`.
- **In the app:** the `lid-awake` self-test scenario (`COOOL_LID_DRYRUN=1`; real client, real helper code dry-run,
  readings set by the test, one Haiku chat). It covers the Settings row's states, Install…, a working chat engaging
  the hold with the keep-awake assertion covered, a battery drop, the turn ending, a simulated kill, heat, and Remove
  helper. A second Haiku chat in Ask mode covers "A chat that asks": the line above its message box (for Claude its
  button opens the menu), its permission prompt with the lid closed starting the grace (shortened to 8 s with
  `lid_simulate { grace_ms }`) and the Settings line naming it, the grace running out into a `waiting` stop with the
  chat's title, session and request, a notification click with that target opening the Needs you item and its
  "paused" note, the mode menu's warning and a mode picked there hiding the line, and Dismiss for this chat sticking
  through the next prompt.
- **Browser mock:** `?lid=missing&lidon=1|ready|display|holding|grace|battery|hot|stale|chat` (`chat`: on and ready,
  Settings not opened; any knob names the first chat waiting on a permission in a `waiting` stop).

### Manual test plan for the owner (about 5 minutes plus the closed-lid time)

You'll need: a MacBook on its charger, no external display, coool built from this branch.

1. **Before.** In Terminal, run `pmset -g | grep -i sleep` and note `SleepDisabled` (absent or 0) and `sleep`. Run
   `ls /Library/LaunchDaemons/sh.coool.lid-helper.plist`, which should not exist.
2. **Install.** Open Settings > General and switch on **Keep working with the lid closed**. The line reads "Needs
   one-time approval". Click **Install…**, read the macOS prompt (it names coool's helper), and enter your password.
   The row turns to "Ready", with Helper "installed". Run `sudo launchctl print system/sh.coool.lid-helper | head`;
   it should show the job running.
3. **Start long work.** Start a chat with a task that takes 10+ minutes. A simple one: "Run `for i in $(seq 1 600);
   do date; sleep 1; done` in the foreground, then say done". The row should read "Holding the Mac awake: 1 agent
   working, on power, …". Check:
   - `pmset -g | grep -i sleepdisabled` shows `SleepDisabled 1`;
   - `pmset -g assertions` no longer lists "An agent is working in coool" (covered), if Prevent sleep is on.
4. **Close the lid** for 3 to 5 minutes, on a desk (not in a bag).
5. **Open it.** In the chat, the tool output's `date` lines (or the timeline timestamps of the steps) should run on
   through the closed-lid minutes without a gap. A gap means it slept.
6. **After the task finishes,** `pmset -g | grep -i sleepdisabled` shows 0 or nothing, within a second or two.
7. **Kill test.** Start another long task and wait for "Holding". Check `SleepDisabled 1`, then force-quit coool
   (`kill -9 <coool pid>`, or Force Quit). Within a second `pmset -g | grep -i sleepdisabled` shows 0, and
   `log show --last 2m --predicate 'process == "sh.coool.lid-helper"'` shows "normal sleep restored (coool went
   away)". Relaunch coool. Settings shows the recorded stop "coool quit while holding the Mac awake …".
8. **Battery limit (optional).** With a task running and "Only while on power" on, unplug the charger. Within about
   5 s the row reads "Not holding: on battery", `SleepDisabled` is 0, and a notification says "Stopped holding the Mac
   awake at …: on battery." Plug back in and it holds again.
9. **Uninstall.** Click **Remove helper**. No prompt should appear. Then check:
   - `ls /Library/LaunchDaemons/sh.coool.lid-helper.plist /Library/PrivilegedHelperTools/sh.coool.lid-helper` finds
     neither;
   - `sudo launchctl print system/sh.coool.lid-helper` says not found;
   - `pmset -g | grep -i sleep` is back to the values from step 1.

**A chat that asks (optional, 5 minutes).** With the helper installed, start a chat in Ask mode with "Run `sleep 20`
with Bash, then run `date` with Bash". The line above its message box says it will pause; leave the mode as it is.
Close the lid as soon as it starts. It asks for the first command, keeps holding for 2 minutes, then lets go (the Mac
sleeps). Open the lid after 4 minutes: a notification "coool let the Mac sleep … “…” was waiting for your answer
(Bash: sleep 20)"; clicking it opens Needs you on that request, whose header says "This paused a lid-closed run at …".

If anything leaves `SleepDisabled 1` behind, run `sudo pmset -a disablesleep 0` and send the
`log show --last 30m --predicate 'process == "sh.coool.lid-helper"'` output.
