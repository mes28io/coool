// coool-lid-helper: the root side of Settings > General > "Keep working with the lid closed" (src/lid/, docs/LID.md).
//
// Its one job: turn macOS's SleepDisabled switch on while coool asks for it, and back off the moment coool stops
// asking, goes away (crash, force quit, kill -9: the connection closes), stops sending a heartbeat, the battery
// reaches the floor or the Mac runs hot; and at every start (after a crash of its own or a restart) if its marker
// says it left the switch on. It never runs anything but these fixed commands, with fixed arguments, no shell and an
// empty environment:
//   /usr/bin/pmset -a disablesleep 1|0     (Apple's pmset carries the entitlement the kernel requires for this key)
//   /usr/bin/pmset sleepnow                (after letting go with the lid closed, so the Mac sleeps as it would have)
//   /bin/launchctl bootout system/sh.coool.lid-helper    (UNINSTALL, after removing its own two files)
//
// Installed by coool with one administrator approval (src/lid/helper.rs) as a LaunchDaemon:
//   /Library/PrivilegedHelperTools/sh.coool.lid-helper  root:wheel 0755 (this binary)
//   /Library/LaunchDaemons/sh.coool.lid-helper.plist     root:wheel 0644 (RunAtLoad, KeepAlive, `--uid <installer>`)
// and at run time creates /var/db/sh.coool.lid-helper/ (root 0700; the marker `held`) and /var/run/sh.coool.lid-helper/
// (root 0755) with the socket `s`, owned by the installing user, mode 0600. Only that user (and root) may connect;
// the peer's uid is checked again with getpeereid.
//
// Protocol: one ASCII line per request (printable characters only, at most 63 bytes), one line back, "OK ..." or
// "ERR <code>". Anything else closes the connection.
//   STATUS          -> OK v=1 held=0|1 sleepdisabled=0|1 lid=open|closed|none battery=<0..100|-1> ac=0|1 thermal=0..3
//   HOLD <lease>    -> OK            lease: seconds (10..300) the hold lasts without a BEAT; only one connection holds
//   BEAT            -> OK            renews the holder's lease
//   RELEASE         -> OK
//   UNINSTALL       -> OK, then the helper lets go, removes its files and boots itself out of launchd
//
// `--dry-run` (for tests, never installed): runs as the calling user with `--socket` and `--state` in a folder the
// user owns, performs every check, and prints "would run: ..." instead of running a command; SleepDisabled is then a
// variable, and `--sensors <file>` stands in for the lid, battery and thermal readings ("battery=15 ac=0 thermal=2
// lid=closed causes=1", re-read at every check). Lease minimum 1 s there. `--exit-with-stdin`: also let go and exit when
// stdin closes (the app that started it is gone), so a test's helper never outlives it.

#import <Foundation/Foundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/ps/IOPowerSources.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <os/log.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define VERSION 1
#define LABEL "sh.coool.lid-helper"
static const char *BIN_PATH = "/Library/PrivilegedHelperTools/" LABEL;
static const char *PLIST_PATH = "/Library/LaunchDaemons/" LABEL ".plist";
static const char *REAL_STATE_DIR = "/var/db/" LABEL;
static const char *REAL_RUN_DIR = "/var/run/" LABEL;
static const char *PMSET = "/usr/bin/pmset";
static const char *LAUNCHCTL = "/bin/launchctl";

#define MAX_LINE 64
#define MAX_CLIENTS 4
#define CHECK_EVERY_MS 5000
// On battery at or below this, the helper lets go whatever coool asks (coool's own limit is 10..50%, default 20%).
#define BATTERY_FLOOR 10
#define LEASE_MAX 300

static bool dry = false;
static uid_t allowed_uid = (uid_t)-1;
static char state_dir[PATH_MAX];
static char sock_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
static char run_dir[PATH_MAX];
static char marker_path[PATH_MAX];
static char sensors_path[PATH_MAX];
static bool dry_sleep_disabled = false;
static volatile sig_atomic_t stop_signal = 0;
static bool exit_with_stdin = false;

static bool held = false;
static int holder = -1; // index into clients
static long long lease_deadline = 0;
static int lease_secs = 0;

struct client {
    int fd;
    char buf[MAX_LINE];
    size_t len;
};
static struct client clients[MAX_CLIENTS];

static void say(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void say(const char *fmt, ...) {
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (dry) {
        printf("%s\n", line);
        fflush(stdout);
    } else {
        os_log(OS_LOG_DEFAULT, "%{public}s", line);
    }
}

static long long now_ms(void) {
    // CLOCK_MONOTONIC counts time asleep too, so a lease never outlives a sleep.
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// ---------- readings ----------

struct reading {
    int battery; // -1: no battery
    bool ac;
    int thermal; // 0 nominal .. 3 critical
    int lid;     // -1 no lid, 0 open, 1 closed
    bool causes; // closing the lid sleeps the Mac (false in closed-display mode)
};

static int rootdomain_bool(const char *key) {
    io_service_t root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"));
    if (!root) return -1;
    CFStringRef k = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
    CFTypeRef v = IORegistryEntryCreateCFProperty(root, k, kCFAllocatorDefault, 0);
    CFRelease(k);
    IOObjectRelease(root);
    int out = -1;
    if (v) {
        if (CFGetTypeID(v) == CFBooleanGetTypeID()) out = CFBooleanGetValue((CFBooleanRef)v) ? 1 : 0;
        CFRelease(v);
    }
    return out;
}

static void read_battery(struct reading *r) {
    r->battery = -1;
    r->ac = true;
    CFTypeRef blob = IOPSCopyPowerSourcesInfo();
    if (!blob) return;
    CFStringRef src = IOPSGetProvidingPowerSourceType(blob);
    if (src && CFEqual(src, CFSTR(kIOPMBatteryPowerKey))) r->ac = false;
    CFArrayRef list = IOPSCopyPowerSourcesList(blob);
    if (list) {
        for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
            CFDictionaryRef d = IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, i));
            if (!d) continue;
            CFStringRef type = CFDictionaryGetValue(d, CFSTR(kIOPSTypeKey));
            if (!type || !CFEqual(type, CFSTR(kIOPSInternalBatteryType))) continue;
            CFNumberRef cur = CFDictionaryGetValue(d, CFSTR(kIOPSCurrentCapacityKey));
            CFNumberRef max = CFDictionaryGetValue(d, CFSTR(kIOPSMaxCapacityKey));
            int c = 0, m = 0;
            if (cur && max && CFNumberGetValue(cur, kCFNumberIntType, &c) && CFNumberGetValue(max, kCFNumberIntType, &m) && m > 0) {
                r->battery = c * 100 / m;
                if (r->battery > 100) r->battery = 100;
                if (r->battery < 0) r->battery = 0;
            }
            break;
        }
        CFRelease(list);
    }
    CFRelease(blob);
}

// dry run: "battery=15 ac=0 thermal=2 lid=closed causes=1" (any subset, any order).
static void read_sensors_file(struct reading *r) {
    if (!sensors_path[0]) return;
    int fd = open(sensors_path, O_RDONLY | O_NOFOLLOW);
    if (fd < 0) return;
    char buf[256];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n <= 0) return;
    buf[n] = 0;
    char *save = NULL;
    for (char *t = strtok_r(buf, " \t\r\n", &save); t; t = strtok_r(NULL, " \t\r\n", &save)) {
        int v;
        if (sscanf(t, "battery=%d", &v) == 1) r->battery = v;
        else if (sscanf(t, "ac=%d", &v) == 1) r->ac = v != 0;
        else if (sscanf(t, "thermal=%d", &v) == 1) r->thermal = v;
        else if (sscanf(t, "causes=%d", &v) == 1) r->causes = v != 0;
        else if (!strcmp(t, "lid=closed")) r->lid = 1;
        else if (!strcmp(t, "lid=open")) r->lid = 0;
        else if (!strcmp(t, "lid=none")) r->lid = -1;
    }
}

static struct reading sense(void) {
    struct reading r = {.battery = -1, .ac = true, .thermal = 0, .lid = -1, .causes = true};
    if (dry) {
        r.battery = 100;
        r.lid = 0;
        read_sensors_file(&r);
        return r;
    }
    read_battery(&r);
    @autoreleasepool {
        NSProcessInfoThermalState t = [[NSProcessInfo processInfo] thermalState];
        r.thermal = t == NSProcessInfoThermalStateCritical ? 3 : t == NSProcessInfoThermalStateSerious ? 2 : t == NSProcessInfoThermalStateFair ? 1 : 0;
    }
    r.lid = rootdomain_bool("AppleClamshellState");
    int causes = rootdomain_bool("AppleClamshellCausesSleep");
    r.causes = causes != 0;
    return r;
}

static bool sleep_disabled(void) {
    if (dry) return dry_sleep_disabled;
    return rootdomain_bool("SleepDisabled") == 1;
}

// ---------- the fixed commands ----------

static bool run(const char *const argv[]) {
    char line[256] = "";
    for (int i = 0; argv[i]; i++) {
        if (i) strlcat(line, " ", sizeof line);
        strlcat(line, argv[i], sizeof line);
    }
    if (dry) {
        say("would run: %s", line);
        if (!strcmp(argv[0], PMSET) && argv[1] && !strcmp(argv[1], "-a") && argv[2] && !strcmp(argv[2], "disablesleep")) dry_sleep_disabled = !strcmp(argv[3], "1");
        return true;
    }
    pid_t pid;
    char *const envp[] = {NULL};
    int rc = posix_spawn(&pid, argv[0], NULL, NULL, (char *const *)argv, envp);
    if (rc != 0) {
        say("couldn't start %s: %s", line, strerror(rc));
        return false;
    }
    int st = 0;
    while (waitpid(pid, &st, 0) < 0) {
        if (errno != EINTR) return false;
    }
    bool ok = WIFEXITED(st) && WEXITSTATUS(st) == 0;
    say("ran: %s (%s)", line, ok ? "ok" : "failed");
    return ok;
}

static bool set_disablesleep(bool on) {
    const char *argv[] = {PMSET, "-a", "disablesleep", on ? "1" : "0", NULL};
    run(argv);
    return sleep_disabled() == on;
}

static bool marker_exists(void) {
    struct stat st;
    return lstat(marker_path, &st) == 0;
}

static bool marker_write(void) {
    int fd = open(marker_path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    if (fd < 0) return false;
    close(fd);
    return true;
}

/// Lets go if this helper holds (its marker says so): SleepDisabled off, then sleep now when the lid is closed and
/// closing it would sleep the Mac (the kernel doesn't look at the lid again when the switch goes off).
static void restore(const char *why) {
    bool was = held;
    held = false;
    holder = -1;
    if (!marker_exists()) {
        if (was) say("released (%s); the switch was already off", why);
        return;
    }
    if (set_disablesleep(false)) {
        unlink(marker_path);
        say("normal sleep restored (%s)", why);
        struct reading r = sense();
        if (r.lid == 1 && r.causes) {
            const char *argv[] = {PMSET, "sleepnow", NULL};
            say("lid is closed: sleeping now");
            run(argv);
        }
    } else {
        // Keep the marker: the next check (and the next start) tries again.
        say("couldn't turn SleepDisabled off (%s); will retry", why);
    }
}

static const char *engage(int idx, int lease) {
    struct reading r = sense();
    if (!r.ac && r.battery >= 0 && r.battery <= BATTERY_FLOOR) return "battery";
    if (r.thermal >= 2) return "thermal";
    if (held) {
        if (holder != idx) return "busy";
    } else {
        if (sleep_disabled() && !marker_exists()) return "already-disabled";
        if (!marker_write()) return "state";
        if (!set_disablesleep(true)) {
            unlink(marker_path);
            set_disablesleep(false);
            return "pmset";
        }
        held = true;
        holder = idx;
        say("holding: SleepDisabled on (lease %d s)", lease);
    }
    lease_secs = lease;
    lease_deadline = now_ms() + (long long)lease * 1000;
    return NULL;
}

static void check(void) {
    if (marker_exists() && !held) {
        restore("marker without a holder");
        return;
    }
    if (!held) return;
    if (now_ms() > lease_deadline) {
        restore("no heartbeat from coool");
        return;
    }
    struct reading r = sense();
    if (!r.ac && r.battery >= 0 && r.battery <= BATTERY_FLOOR) {
        restore("battery at the floor");
        return;
    }
    if (r.thermal >= 2) {
        restore("thermal pressure");
        return;
    }
    if (!sleep_disabled()) {
        // Someone turned it off (pmset by hand): not ours to hold any more.
        unlink(marker_path);
        held = false;
        holder = -1;
        say("SleepDisabled went off from outside; not holding");
    }
}

// ---------- uninstall ----------

static void uninstall(void) {
    restore("uninstall");
    if (dry) {
        say("would remove: %s %s %s %s", PLIST_PATH, BIN_PATH, REAL_STATE_DIR, REAL_RUN_DIR);
        unlink(sock_path);
        const char *argv[] = {LAUNCHCTL, "bootout", "system/" LABEL, NULL};
        run(argv);
        exit(0);
    }
    unlink(PLIST_PATH);
    unlink(BIN_PATH);
    unlink(marker_path);
    rmdir(state_dir);
    unlink(sock_path);
    rmdir(run_dir);
    say("removed its files; booting out");
    // launchctl stops this job with SIGTERM; don't wait on it (it waits on us).
    pid_t pid;
    const char *argv[] = {LAUNCHCTL, "bootout", "system/" LABEL, NULL};
    char *const envp[] = {NULL};
    posix_spawn(&pid, LAUNCHCTL, NULL, NULL, (char *const *)argv, envp);
    for (int i = 0; i < 100 && !stop_signal; i++) usleep(100 * 1000);
    exit(0);
}

// ---------- requests ----------

static void reply(int fd, const char *s) {
    size_t n = strlen(s), off = 0;
    while (off < n) {
        ssize_t w = write(fd, s + off, n - off);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return;
        off += (size_t)w;
    }
}

static void drop(int idx) {
    if (clients[idx].fd < 0) return;
    close(clients[idx].fd);
    clients[idx].fd = -1;
    clients[idx].len = 0;
    if (held && holder == idx) restore("coool went away");
}

/// Parses a whole number of 1..3 digits. Anything else (signs, spaces, more digits) is refused.
static int parse_lease(const char *s) {
    size_t n = strlen(s);
    if (n == 0 || n > 3) return -1;
    int v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return -1;
        v = v * 10 + (s[i] - '0');
    }
    int min = dry ? 1 : 10;
    return (v >= min && v <= LEASE_MAX) ? v : -1;
}

/// Returns false to close the connection.
static bool handle(int idx, const char *line) {
    int fd = clients[idx].fd;
    char out[160];
    if (!strcmp(line, "STATUS")) {
        struct reading r = sense();
        snprintf(out, sizeof out, "OK v=%d held=%d sleepdisabled=%d lid=%s battery=%d ac=%d thermal=%d\n", VERSION, held, sleep_disabled(), r.lid == 1 ? "closed" : r.lid == 0 ? "open" : "none", r.battery, r.ac, r.thermal);
        reply(fd, out);
    } else if (!strncmp(line, "HOLD ", 5)) {
        int lease = parse_lease(line + 5);
        if (lease < 0) {
            reply(fd, "ERR lease\n");
            return false;
        }
        const char *e = engage(idx, lease);
        snprintf(out, sizeof out, e ? "ERR %s\n" : "OK\n", e);
        reply(fd, out);
    } else if (!strcmp(line, "BEAT")) {
        if (held && holder == idx) {
            lease_deadline = now_ms() + (long long)lease_secs * 1000;
            reply(fd, "OK\n");
        } else {
            reply(fd, "ERR not-holding\n");
        }
    } else if (!strcmp(line, "RELEASE")) {
        if (held && holder == idx) restore("coool let go");
        reply(fd, "OK\n");
    } else if (!strcmp(line, "UNINSTALL")) {
        reply(fd, "OK\n");
        uninstall();
    } else {
        reply(fd, "ERR unknown\n");
        return false;
    }
    return true;
}

static void on_readable(int idx) {
    struct client *c = &clients[idx];
    char tmp[MAX_LINE];
    ssize_t n = read(c->fd, tmp, sizeof tmp);
    if (n < 0 && errno == EINTR) return;
    if (n <= 0) {
        drop(idx);
        return;
    }
    for (ssize_t i = 0; i < n; i++) {
        char ch = tmp[i];
        if (ch == '\n') {
            c->buf[c->len] = 0;
            c->len = 0;
            if (!handle(idx, c->buf)) {
                drop(idx);
                return;
            }
            continue;
        }
        if (ch < 0x20 || ch > 0x7e) {
            reply(c->fd, "ERR input\n");
            drop(idx);
            return;
        }
        if (c->len >= MAX_LINE - 1) {
            reply(c->fd, "ERR too-long\n");
            drop(idx);
            return;
        }
        c->buf[c->len++] = ch;
    }
}

static void on_accept(int lfd) {
    int fd = accept(lfd, NULL, NULL);
    if (fd < 0) return;
    uid_t euid;
    gid_t egid;
    if (getpeereid(fd, &euid, &egid) != 0 || (euid != allowed_uid && euid != 0)) {
        say("refused a connection from uid %d", (int)euid);
        close(fd);
        return;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    for (int i = 0; i < MAX_CLIENTS; i++) {
        if (clients[i].fd < 0) {
            clients[i].fd = fd;
            clients[i].len = 0;
            return;
        }
    }
    reply(fd, "ERR busy\n");
    close(fd);
}

// ---------- start-up checks ----------

static void die(const char *fmt, ...) __attribute__((format(printf, 1, 2), noreturn));
static void die(const char *fmt, ...) {
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (dry) {
        printf("refused: %s\n", line);
        fflush(stdout);
    } else {
        os_log_error(OS_LOG_DEFAULT, "refused: %{public}s", line);
        fprintf(stderr, "refused: %s\n", line);
    }
    exit(2);
}

/// A directory or file this helper trusts: not a symlink, owned by `owner`, writable by nobody else.
static void check_owned(const char *path, uid_t owner, bool want_dir) {
    struct stat st;
    if (lstat(path, &st) != 0) die("%s: %s", path, strerror(errno));
    if (S_ISLNK(st.st_mode)) die("%s is a symlink", path);
    if (want_dir ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) die("%s is not a %s", path, want_dir ? "folder" : "file");
    if (st.st_uid != owner) die("%s is owned by uid %d, not %d", path, (int)st.st_uid, (int)owner);
    if (st.st_mode & (S_IWGRP | S_IWOTH)) die("%s is writable by others", path);
}

/// Makes `path` (one level) owned by `owner` with `mode`, or checks the one there.
static void ensure_dir(const char *path, uid_t owner, mode_t mode) {
    if (mkdir(path, mode) != 0 && errno != EEXIST) die("%s: %s", path, strerror(errno));
    check_owned(path, owner, true);
    if (chmod(path, mode) != 0) die("%s: %s", path, strerror(errno));
}

static void check_self(void) {
    char exe[PATH_MAX], real[PATH_MAX];
    uint32_t size = sizeof exe;
    if (_NSGetExecutablePath(exe, &size) != 0 || !realpath(exe, real)) die("can't find its own path");
    if (strcmp(real, BIN_PATH) != 0) die("runs from %s, not %s", real, BIN_PATH);
    check_owned(BIN_PATH, 0, false);
    check_owned("/Library/PrivilegedHelperTools", 0, true);
}

static void on_signal(int sig) { stop_signal = sig; }

static void usage(void) {
    die("usage: " LABEL " --uid <uid>  |  --dry-run --uid <uid> --socket <path> --state <folder> [--sensors <file>] [--exit-with-stdin]");
}

static uid_t parse_uid(const char *s) {
    size_t n = strlen(s);
    if (n == 0 || n > 9) usage();
    long v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') usage();
        v = v * 10 + (s[i] - '0');
    }
    if (v <= 0) die("uid must be a person's, not root");
    return (uid_t)v;
}

int main(int argc, char **argv) {
    const char *sock_arg = NULL, *state_arg = NULL, *sensors_arg = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--dry-run")) dry = true;
        else if (!strcmp(argv[i], "--uid") && i + 1 < argc) allowed_uid = parse_uid(argv[++i]);
        else if (!strcmp(argv[i], "--socket") && i + 1 < argc) sock_arg = argv[++i];
        else if (!strcmp(argv[i], "--state") && i + 1 < argc) state_arg = argv[++i];
        else if (!strcmp(argv[i], "--sensors") && i + 1 < argc) sensors_arg = argv[++i];
        else if (!strcmp(argv[i], "--exit-with-stdin")) exit_with_stdin = true;
        else usage();
    }
    if (allowed_uid == (uid_t)-1) usage();
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa = {0};
    sa.sa_handler = on_signal; // no SA_RESTART: poll returns EINTR and the loop sees the signal
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    if (dry) {
        if (geteuid() == 0) die("--dry-run never runs as root");
        if (!sock_arg || !state_arg) usage();
        if (strlen(sock_arg) >= sizeof sock_path) die("socket path too long");
        strlcpy(sock_path, sock_arg, sizeof sock_path);
        strlcpy(state_dir, state_arg, sizeof state_dir);
        if (sensors_arg) strlcpy(sensors_path, sensors_arg, sizeof sensors_path);
        char tmp[PATH_MAX];
        strlcpy(tmp, sock_path, sizeof tmp);
        strlcpy(run_dir, dirname(tmp), sizeof run_dir);
        check_owned(state_dir, geteuid(), true);
        check_owned(run_dir, geteuid(), true);
    } else {
        // The installed helper takes no paths from anyone: they are fixed.
        if (sock_arg || state_arg || sensors_arg || exit_with_stdin) die("--socket, --state, --sensors and --exit-with-stdin are for --dry-run only");
        if (geteuid() != 0) die("must run as root (it is a LaunchDaemon)");
        check_self();
        umask(022);
        strlcpy(state_dir, REAL_STATE_DIR, sizeof state_dir);
        strlcpy(run_dir, REAL_RUN_DIR, sizeof run_dir);
        ensure_dir(state_dir, 0, 0700);
        ensure_dir(run_dir, 0, 0755);
        snprintf(sock_path, sizeof sock_path, "%s/s", run_dir);
    }
    snprintf(marker_path, sizeof marker_path, "%s/held", state_dir);
    say("coool-lid-helper %d starting%s for uid %d", VERSION, dry ? " (dry run)" : "", (int)allowed_uid);

    // A marker at start means the last run (or the Mac, before a restart) left the switch on: undo that first.
    if (marker_exists()) {
        held = true;
        restore("found its marker at start");
    }

    struct stat st;
    if (lstat(sock_path, &st) == 0) {
        if (!S_ISSOCK(st.st_mode)) die("%s exists and isn't a socket", sock_path);
        unlink(sock_path);
    }
    int lfd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (lfd < 0) die("socket: %s", strerror(errno));
    struct sockaddr_un addr = {0};
    addr.sun_family = AF_UNIX;
    strlcpy(addr.sun_path, sock_path, sizeof addr.sun_path);
    mode_t old = umask(077);
    if (bind(lfd, (struct sockaddr *)&addr, sizeof addr) != 0) die("bind %s: %s", sock_path, strerror(errno));
    umask(old);
    if (!dry && chown(sock_path, allowed_uid, 0) != 0) die("chown %s: %s", sock_path, strerror(errno));
    if (chmod(sock_path, 0600) != 0) die("chmod %s: %s", sock_path, strerror(errno));
    if (listen(lfd, 4) != 0) die("listen: %s", strerror(errno));
    for (int i = 0; i < MAX_CLIENTS; i++) clients[i].fd = -1;
    say("listening on %s", sock_path);

    long long next_check = now_ms() + CHECK_EVERY_MS;
    for (;;) {
        if (stop_signal) {
            restore("helper stopping");
            unlink(sock_path);
            say("stopped by signal %d", (int)stop_signal);
            return 0;
        }
        struct pollfd fds[2 + MAX_CLIENTS];
        int map[2 + MAX_CLIENTS];
        int n = 0;
        fds[n] = (struct pollfd){.fd = lfd, .events = POLLIN};
        map[n++] = -1;
        if (exit_with_stdin) {
            fds[n] = (struct pollfd){.fd = 0, .events = POLLIN};
            map[n++] = -2;
        }
        for (int i = 0; i < MAX_CLIENTS; i++) {
            if (clients[i].fd >= 0) {
                fds[n] = (struct pollfd){.fd = clients[i].fd, .events = POLLIN};
                map[n++] = i;
            }
        }
        // Idle (nothing held, no marker): sleep in poll until someone connects. Holding: wake for the checks.
        bool busy = held || marker_exists();
        int timeout = -1;
        if (busy) {
            long long left = next_check - now_ms();
            if (held && lease_deadline - now_ms() < left) left = lease_deadline - now_ms();
            timeout = left < 0 ? 0 : (int)(left > INT_MAX ? INT_MAX : left);
        }
        int r = poll(fds, (nfds_t)n, timeout);
        if (r < 0 && errno != EINTR) die("poll: %s", strerror(errno));
        if (r > 0) {
            for (int k = 0; k < n; k++) {
                if (!(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
                if (map[k] == -2) {
                    char b[64];
                    if (read(0, b, sizeof b) <= 0) stop_signal = SIGHUP;
                } else if (map[k] < 0) {
                    on_accept(lfd);
                } else {
                    on_readable(map[k]);
                }
            }
        }
        if (busy && now_ms() >= next_check) next_check = now_ms() + CHECK_EVERY_MS;
        if (held || marker_exists()) check();
    }
}
