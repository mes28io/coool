// coool-vm: coool's sandboxed Mac (APP_SPEC "Mac panel (sandbox VM)").
//
// One process per VM folder, started by the app (src/device/vm.rs). It runs a macOS guest on Apple's
// Virtualization.framework with no window and no Dock icon, so nothing outside coool appears or takes focus:
//
//   - install: asks Apple for the latest restore image this Mac supports, downloads only the parts a virtual Mac
//              needs (HTTP range requests into a pruned .ipsw), installs it onto a sparse disk image, and deletes
//              the download.
//   - frames:  the guest display's screenshot call (VZGraphicsDisplay), JPEG-encoded and streamed out.
//   - input:   the VM's own USB keyboard and screen-coordinate pointer (the events a VZVirtualMachineView would
//              send), so the guest sees real hardware input: no guest permission is needed to click or type.
//   - OCR:     Vision text recognition over a screenshot (the guest's first-run permission grant uses it).
//   - agent:   a JSON-lines bridge over virtio-vsock to coool's guest agent (native/coool-vm-agent.m), which
//              reads the accessibility tree and launches apps inside the guest.
//
// The binary is signed ad-hoc with the com.apple.security.virtualization entitlement by build.rs; the app itself
// needs no entitlement.
//
// Protocol: as coool-sim. Requests are JSON lines on stdin (`{"id":1,"cmd":"click","x":100,"y":200}`); everything
// out is framed on stdout as [u32 big-endian length][u8 kind][payload], kind 'J' = a JSON reply or event,
// 'F' = one JPEG frame. `coool-vm <dir> --once '<json>'` runs one request and prints events and the reply as plain
// JSON lines instead (for scripts). The helper exits when stdin closes, stopping the guest first.

#import <Foundation/Foundation.h>
#import <Virtualization/Virtualization.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>
#import <AppKit/AppKit.h>
#import <mach/mach_time.h>
#import <stdatomic.h>
#import <sys/file.h>
#import <sys/mount.h>
#import <sys/stat.h>
#import <zlib.h>
#import <objc/runtime.h>
#import <IOSurface/IOSurface.h>
#import <vmnet/vmnet.h>

// ---------------------------------------------------------------------------------------------------
// Private input / screenshot surface (selectors only; nothing links privately).

@interface NSObject (CooolVZPrivate)
- (NSArray *)_keyboards;
- (NSArray *)_pointingDevices;
- (void)sendKeyEvents:(NSArray *)events;
- (void)sendPointerEvents:(NSArray *)events;
- (void)sendScrollWheelEvents:(NSArray *)events;
- (id)initWithType:(NSInteger)type keyCode:(unsigned short)code;
- (id)initWithLocation:(CGPoint)p pressedButtons:(NSInteger)buttons;
- (id)initWithScrollingDeltaX:(double)dx scrollingDeltaY:(double)dy acceleratedScrollingDeltaX:(double)adx
    acceleratedScrollingDeltaY:(double)ady scrollPhase:(NSUInteger)phase momentumPhase:(NSUInteger)momentum;
- (void)_takeScreenshotWithCompletionHandler:(void (^)(id image, NSError *error))handler;
@end

// ---------------------------------------------------------------------------------------------------
// Output

static dispatch_queue_t gOut;
static BOOL gPlain = NO;  // --once: plain JSON lines

static void writeFrame(char kind, NSData *payload) {
  dispatch_sync(gOut, ^{
    if (gPlain) {
      if (kind != 'J') return;
      fwrite(payload.bytes, 1, payload.length, stdout);
      fputc('\n', stdout);
      fflush(stdout);
      return;
    }
    uint32_t len = htonl((uint32_t)payload.length + 1);
    fwrite(&len, 4, 1, stdout);
    fwrite(&kind, 1, 1, stdout);
    fwrite(payload.bytes, 1, payload.length, stdout);
    fflush(stdout);
  });
}

static void sendJSON(NSDictionary *obj) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (data) writeFrame('J', data);
}

static void (^gOnReply)(void);

static void reply(id rid, NSDictionary *result) {
  NSMutableDictionary *m = [NSMutableDictionary dictionaryWithDictionary:@{@"id": rid ?: [NSNull null], @"ok": @YES}];
  if (result) m[@"result"] = result;
  sendJSON(m);
  if (gOnReply) gOnReply();
}

static void fail(id rid, NSString *message) {
  sendJSON(@{@"id": rid ?: [NSNull null], @"ok": @NO, @"error": message ?: @"error"});
  if (gOnReply) gOnReply();
}

static void event(NSString *name, NSDictionary *fields) {
  NSMutableDictionary *m = [NSMutableDictionary dictionaryWithDictionary:fields ?: @{}];
  m[@"event"] = name;
  sendJSON(m);
}

static double nowMs(void) {
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  return (double)mach_absolute_time() * tb.numer / tb.denom / 1e6;
}

static double num(NSDictionary *m, NSString *k, double d) {
  id v = m[k];
  return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : d;
}

static NSString *str(NSDictionary *m, NSString *k) {
  id v = m[k];
  return [v isKindOfClass:NSString.class] ? v : nil;
}

// ---------------------------------------------------------------------------------------------------
// The VM folder

static NSString *gDir;           // <data>/vm
static int gLockFd = -1;

static NSString *P(NSString *name) { return [gDir stringByAppendingPathComponent:name]; }

static NSMutableDictionary *loadConfig(void) {
  NSData *d = [NSData dataWithContentsOfFile:P(@"config.json")];
  id j = d ? [NSJSONSerialization JSONObjectWithData:d options:NSJSONReadingMutableContainers error:nil] : nil;
  return [j isKindOfClass:NSDictionary.class] ? j : [NSMutableDictionary dictionary];
}

static void saveConfig(NSDictionary *c) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:c options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:nil];
  NSString *tmp = P(@".config.json.tmp");
  [d writeToFile:tmp atomically:NO];
  rename(tmp.fileSystemRepresentation, P(@"config.json").fileSystemRepresentation);
}

static uint64_t freeBytes(NSString *path) {
  struct statfs s;
  if (statfs(path.fileSystemRepresentation, &s) != 0) return 0;
  return (uint64_t)s.f_bavail * s.f_bsize;
}

/// One coool at a time drives a VM folder.
static BOOL takeLock(NSString **err) {
  if (gLockFd >= 0) return YES;
  int fd = open(P(@"lock").fileSystemRepresentation, O_CREAT | O_RDWR, 0600);
  if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) {
    if (fd >= 0) close(fd);
    *err = @"This Mac is in use by another coool.";
    return NO;
  }
  gLockFd = fd;
  return YES;
}

// ---------------------------------------------------------------------------------------------------
// HTTP (range requests)

@interface CVSink : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, strong) NSFileHandle *file;     // stream into this, or
@property(nonatomic, strong) NSMutableData *data;    // collect here
@property(nonatomic) uint64_t got;
@property(nonatomic) NSInteger status;
@property(nonatomic, strong) NSError *error;
@property(nonatomic, strong) dispatch_semaphore_t done;
@property(nonatomic, copy) void (^progress)(uint64_t n);
@property(nonatomic, strong) NSDictionary *headers;
@end

@implementation CVSink
- (void)URLSession:(NSURLSession *)s dataTask:(NSURLSessionDataTask *)t didReceiveResponse:(NSURLResponse *)r
    completionHandler:(void (^)(NSURLSessionResponseDisposition))h {
  NSHTTPURLResponse *hr = (NSHTTPURLResponse *)r;
  self.status = hr.statusCode;
  self.headers = hr.allHeaderFields;
  h(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)s dataTask:(NSURLSessionDataTask *)t didReceiveData:(NSData *)d {
  if (self.file) {
    @try { [self.file writeData:d]; } @catch (NSException *e) { self.error = [NSError errorWithDomain:@"coool" code:1 userInfo:@{NSLocalizedDescriptionKey: e.reason ?: @"write failed"}]; [t cancel]; return; }
  } else {
    [self.data appendData:d];
  }
  self.got += d.length;
  if (self.progress) self.progress(d.length);
}
- (void)URLSession:(NSURLSession *)s task:(NSURLSessionTask *)t didCompleteWithError:(NSError *)e {
  if (e && !self.error) self.error = e;
  dispatch_semaphore_signal(self.done);
}
@end

static NSURLSession *gHTTP;
static NSOperationQueue *gHTTPQ;

static CVSink *httpRun(NSURL *url, NSString *method, NSString *range, NSFileHandle *file, void (^progress)(uint64_t)) {
  CVSink *sink = [CVSink new];
  sink.file = file;
  sink.data = file ? nil : [NSMutableData data];
  sink.done = dispatch_semaphore_create(0);
  sink.progress = progress;
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url];
  req.HTTPMethod = method;
  req.timeoutInterval = 60;
  if (range) [req setValue:range forHTTPHeaderField:@"Range"];
  NSURLSessionDataTask *task = [gHTTP dataTaskWithRequest:req];
  task.delegate = sink;
  [task resume];
  dispatch_semaphore_wait(sink.done, DISPATCH_TIME_FOREVER);
  return sink;
}

static NSData *httpRange(NSURL *url, uint64_t a, uint64_t b, NSString **err) {
  for (int attempt = 0; attempt < 5; attempt++) {
    CVSink *s = httpRun(url, @"GET", [NSString stringWithFormat:@"bytes=%llu-%llu", a, b], nil, nil);
    if (!s.error && s.status == 206 && s.data.length == b - a + 1) return s.data;
    *err = s.error ? s.error.localizedDescription : [NSString stringWithFormat:@"HTTP %ld", (long)s.status];
    [NSThread sleepForTimeInterval:1 + attempt];
  }
  return nil;
}

/// Streams bytes [a, b] of `url` onto the end of `fh`, resuming after network errors.
static BOOL httpRangeToFile(NSURL *url, uint64_t a, uint64_t b, NSFileHandle *fh, void (^progress)(uint64_t), NSString **err) {
  uint64_t at = a;
  for (int attempt = 0; attempt < 12 && at <= b; attempt++) {
    CVSink *s = httpRun(url, @"GET", [NSString stringWithFormat:@"bytes=%llu-%llu", at, b], fh, progress);
    at += s.got;
    if (at > b) return YES;
    *err = s.error ? s.error.localizedDescription : [NSString stringWithFormat:@"HTTP %ld", (long)s.status];
    if (s.status != 206 && s.status != 0) return NO;
    [NSThread sleepForTimeInterval:MIN(30, 1 << attempt)];
  }
  return at > b;
}

// ---------------------------------------------------------------------------------------------------
// The restore image: a pruned copy of Apple's .ipsw with only what a virtual Mac's erase install reads.

typedef struct {
  uint64_t off, csize, usize, next;  // next: where the following entry (or the central directory) starts
  uint32_t crc, external;
  uint16_t method, flags, time, date, internal, madeBy;
} ZEntry;

static uint16_t rd16(const uint8_t *p) { return p[0] | (p[1] << 8); }
static uint32_t rd32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint64_t rd64(const uint8_t *p) { return rd32(p) | ((uint64_t)rd32(p + 4) << 32); }
static void w16(NSMutableData *d, uint16_t v) { [d appendBytes:&v length:2]; }
static void w32(NSMutableData *d, uint32_t v) { [d appendBytes:&v length:4]; }
static void w64(NSMutableData *d, uint64_t v) { [d appendBytes:&v length:8]; }

/// The zip's entries (central directory), by name, in archive order.
static NSArray<NSArray *> *zipEntries(NSURL *url, uint64_t total, NSString **err) {
  uint64_t tailLen = MIN(total, 1 << 16);
  NSData *tail = httpRange(url, total - tailLen, total - 1, err);
  if (!tail) return nil;
  const uint8_t *t = tail.bytes;
  long eocd = -1, loc = -1;
  for (long i = (long)tail.length - 22; i >= 0; i--) if (rd32(t + i) == 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { *err = @"not a zip (no end of central directory)"; return nil; }
  uint64_t cdSize = rd32(t + eocd + 12), cdOff = rd32(t + eocd + 16);
  for (long i = eocd - 20; i >= 0; i--) if (rd32(t + i) == 0x07064b50) { loc = i; break; }
  if (loc >= 0) {
    uint64_t z64 = rd64(t + loc + 8);
    long k = (long)(z64 - (total - tailLen));
    if (k < 0 || k + 56 > (long)tail.length) { *err = @"zip64 record out of range"; return nil; }
    cdSize = rd64(t + k + 40);
    cdOff = rd64(t + k + 48);
  }
  NSData *cd = httpRange(url, cdOff, cdOff + cdSize - 1, err);
  if (!cd) return nil;
  const uint8_t *c = cd.bytes;
  NSMutableArray *out = [NSMutableArray array];
  uint64_t p = 0;
  while (p + 46 <= cd.length && rd32(c + p) == 0x02014b50) {
    ZEntry e = {0};
    e.madeBy = rd16(c + p + 4);
    e.flags = rd16(c + p + 8);
    e.method = rd16(c + p + 10);
    e.time = rd16(c + p + 12);
    e.date = rd16(c + p + 14);
    e.crc = rd32(c + p + 16);
    e.csize = rd32(c + p + 20);
    e.usize = rd32(c + p + 24);
    uint16_t nl = rd16(c + p + 28), el = rd16(c + p + 30), cl = rd16(c + p + 32);
    e.internal = rd16(c + p + 36);
    e.external = rd32(c + p + 38);
    e.off = rd32(c + p + 42);
    NSString *name = [[NSString alloc] initWithBytes:c + p + 46 length:nl encoding:NSUTF8StringEncoding] ?: @"";
    const uint8_t *x = c + p + 46 + nl;
    for (uint16_t q = 0; q + 4 <= el;) {
      uint16_t hid = rd16(x + q), hl = rd16(x + q + 2);
      if (hid == 1) {
        const uint8_t *v = x + q + 4;
        int vi = 0;
        if (e.usize == 0xFFFFFFFF) { e.usize = rd64(v + vi); vi += 8; }
        if (e.csize == 0xFFFFFFFF) { e.csize = rd64(v + vi); vi += 8; }
        if (e.off == 0xFFFFFFFF) { e.off = rd64(v + vi); vi += 8; }
      }
      q += 4 + hl;
    }
    [out addObject:@[name, [NSValue valueWithBytes:&e objCType:@encode(ZEntry)]]];
    p += 46 + nl + el + cl;
  }
  // Each entry's span runs to the next entry's local header (data descriptors included).
  NSArray *byOff = [out sortedArrayUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) {
    ZEntry x, y;
    [a[1] getValue:&x];
    [b[1] getValue:&y];
    return x.off < y.off ? NSOrderedAscending : x.off > y.off ? NSOrderedDescending : NSOrderedSame;
  }];
  NSMutableArray *fixed = [NSMutableArray arrayWithCapacity:byOff.count];
  for (NSUInteger i = 0; i < byOff.count; i++) {
    ZEntry e;
    [byOff[i][1] getValue:&e];
    if (i + 1 < byOff.count) { ZEntry n; [byOff[i + 1][1] getValue:&n]; e.next = n.off; } else e.next = cdOff;
    [fixed addObject:@[byOff[i][0], [NSValue valueWithBytes:&e objCType:@encode(ZEntry)]]];
  }
  return fixed;
}

static NSData *zipMember(NSURL *url, ZEntry e, NSString **err) {
  NSData *head = httpRange(url, e.off, e.off + 29, err);
  if (!head) return nil;
  uint16_t nl = rd16((const uint8_t *)head.bytes + 26), el = rd16((const uint8_t *)head.bytes + 28);
  uint64_t start = e.off + 30 + nl + el;
  NSData *raw = httpRange(url, start, start + e.csize - 1, err);
  if (!raw || e.method == 0) return raw;
  if (e.method != 8) { *err = @"unsupported zip method"; return nil; }
  NSMutableData *out = [NSMutableData dataWithLength:e.usize];
  z_stream z = {0};
  inflateInit2(&z, -15);
  z.next_in = (Bytef *)raw.bytes;
  z.avail_in = (uInt)raw.length;
  z.next_out = out.mutableBytes;
  z.avail_out = (uInt)out.length;
  int r = inflate(&z, Z_FINISH);
  inflateEnd(&z);
  if (r != Z_STREAM_END) { *err = @"couldn't inflate"; return nil; }
  return out;
}

/// Keeps the virtual Mac's erase-install identities (the install itself, and "macOS Customer", which the restore
/// uses to personalize the recovery OS) and drops every other device's from the manifest; with `dropRosetta`, also
/// the Rosetta cryptex (5.6 GB that only Intel apps use). Returns the new manifest and fills `paths` with the
/// archive files it references.
static NSData *pruneManifest(NSData *manifest, BOOL dropRosetta, NSMutableSet *paths, NSString **err) {
  NSPropertyListFormat fmt;
  NSMutableDictionary *m = [NSPropertyListSerialization propertyListWithData:manifest options:NSPropertyListMutableContainersAndLeaves format:&fmt error:nil];
  if (![m isKindOfClass:NSDictionary.class]) { *err = @"unreadable BuildManifest.plist"; return nil; }
  NSMutableArray *keep = [NSMutableArray array];
  for (NSMutableDictionary *bi in m[@"BuildIdentities"]) {
    NSDictionary *info = bi[@"Info"];
    if ([info[@"DeviceClass"] isEqual:@"vma2macosap"] && [info[@"RestoreBehavior"] isEqual:@"Erase"]) [keep addObject:bi];
  }
  if (!keep.count) { *err = @"this restore image has no virtual Mac install"; return nil; }
  for (NSMutableDictionary *bi in keep) {
    if (dropRosetta) {
      NSMutableDictionary *man = bi[@"Manifest"];
      for (NSString *k in man.allKeys) if ([k hasPrefix:@"Cryptex1,Rosetta"]) [man removeObjectForKey:k];
      [bi[@"Info"][@"VariantContents"] removeObjectForKey:@"Cryptex1,RosettaOS"];
    }
    for (NSString *k in bi[@"Manifest"]) {
      NSString *p = bi[@"Manifest"][k][@"Info"][@"Path"];
      if ([p isKindOfClass:NSString.class]) [paths addObject:p];
    }
  }
  m[@"BuildIdentities"] = keep;
  return [NSPropertyListSerialization dataWithPropertyList:m format:NSPropertyListXMLFormat_v1_0 options:0 error:nil];
}

static NSDictionary *fetchLatest(NSString **err) {
  __block NSDictionary *out = nil;
  __block NSString *e2 = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [VZMacOSRestoreImage fetchLatestSupportedWithCompletionHandler:^(VZMacOSRestoreImage *img, NSError *e) {
    if (e || !img) e2 = e.localizedDescription ?: @"no restore image";
    else {
      NSOperatingSystemVersion v = img.operatingSystemVersion;
      out = @{@"url": img.URL.absoluteString, @"build": img.buildVersion ?: @"",
              @"version": [NSString stringWithFormat:@"%ld.%ld.%ld", (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion]};
    }
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  *err = e2;
  return out;
}

/// Downloads the pruned restore image to <dir>/restore.ipsw. `reserve`: bytes that must stay free afterwards.
static NSDictionary *downloadRestore(NSDictionary *m, NSString **err) {
  NSDictionary *latest = fetchLatest(err);
  if (!latest) return nil;
  NSURL *url = [NSURL URLWithString:latest[@"url"]];
  CVSink *head = httpRun(url, @"HEAD", nil, nil, nil);
  uint64_t total = [head.headers[@"Content-Length"] longLongValue];
  if (!total) { *err = @"couldn't reach Apple's restore image"; return nil; }
  NSArray *entries = zipEntries(url, total, err);
  if (!entries) return nil;
  ZEntry manifestEntry = {0};
  BOOL haveManifest = NO;
  for (NSArray *e in entries) if ([e[0] isEqual:@"BuildManifest.plist"]) { [e[1] getValue:&manifestEntry]; haveManifest = YES; }
  if (!haveManifest) { *err = @"no BuildManifest.plist"; return nil; }
  NSData *manifest = zipMember(url, manifestEntry, err);
  if (!manifest) return nil;
  NSMutableSet *paths = [NSMutableSet set];
  BOOL dropRosetta = m[@"rosetta"] ? ![m[@"rosetta"] boolValue] : YES;
  NSData *newManifest = pruneManifest(manifest, dropRosetta, paths, err);
  if (!newManifest) return nil;
  // Keep: what the identity references, and every small file (plists, trust caches, …); drop big files for other
  // Macs (their kernel caches, firmware) and the original manifest.
  NSMutableArray *keep = [NSMutableArray array];
  uint64_t need = 0;
  for (NSArray *e in entries) {
    ZEntry z;
    [e[1] getValue:&z];
    NSString *name = e[0];
    if ([name isEqual:@"BuildManifest.plist"]) continue;
    if ([paths containsObject:name] || z.csize < (16 << 20)) { [keep addObject:e]; need += z.next - z.off; }
  }
  // The Rosetta cryptex and its sidecar files are referenced only by the keys we removed: drop them by path.
  if (dropRosetta) {
    NSMutableSet *rosettaPaths = [NSMutableSet set];
    NSPropertyListFormat f;
    NSDictionary *orig = [NSPropertyListSerialization propertyListWithData:manifest options:0 format:&f error:nil];
    for (NSDictionary *bi in orig[@"BuildIdentities"])
      for (NSString *k in bi[@"Manifest"])
        if ([k hasPrefix:@"Cryptex1,Rosetta"]) { NSString *p = bi[@"Manifest"][k][@"Info"][@"Path"]; if (p) [rosettaPaths addObject:p]; }
    NSMutableArray *k2 = [NSMutableArray array];
    need = 0;
    for (NSArray *e in keep) {
      if ([rosettaPaths containsObject:e[0]] && ![paths containsObject:e[0]]) continue;
      ZEntry z;
      [e[1] getValue:&z];
      need += z.next - z.off;
      [k2 addObject:e];
    }
    keep = k2;
  }
  uint64_t reserve = (uint64_t)num(m, @"reserveBytes", 0);
  uint64_t free = freeBytes(gDir);
  if (free < need + reserve) {
    *err = [NSString stringWithFormat:@"Not enough disk space: the Mac's restore image needs %.1f GB and the install about %.1f GB more; %.1f GB is free.",
            need / 1e9, reserve / 1e9, free / 1e9];
    return nil;
  }
  NSString *partial = P(@"restore.ipsw.partial");
  [[NSFileManager defaultManager] removeItemAtPath:partial error:nil];
  [[NSFileManager defaultManager] createFileAtPath:partial contents:nil attributes:nil];
  NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:partial];
  if (!fh) { *err = @"couldn't create the download file"; return nil; }
  __block uint64_t done = 0;
  __block double lastEvent = 0;
  void (^progress)(uint64_t) = ^(uint64_t n) {
    done += n;
    double t = nowMs();
    if (t - lastEvent > 500) {
      lastEvent = t;
      event(@"progress", @{@"phase": @"download", @"done": @(done), @"total": @(need)});
    }
  };
  // Contiguous runs of kept entries become one request each.
  NSMutableArray *central = [NSMutableArray array];  // [name, ZEntry with new offset]
  NSUInteger i = 0;
  while (i < keep.count) {
    ZEntry first;
    [keep[i][1] getValue:&first];
    uint64_t runStart = first.off, runEnd = first.next;
    uint64_t outStart = fh.offsetInFile;
    NSUInteger j = i;
    while (j < keep.count) {
      ZEntry z;
      [keep[j][1] getValue:&z];
      if (z.off != runEnd && j != i) break;
      runEnd = z.next;
      ZEntry moved = z;
      moved.off = outStart + (z.off - runStart);
      [central addObject:@[keep[j][0], [NSValue valueWithBytes:&moved objCType:@encode(ZEntry)]]];
      j++;
    }
    if (!httpRangeToFile(url, runStart, runEnd - 1, fh, progress, err)) { [fh closeFile]; return nil; }
    if (fh.offsetInFile != outStart + (runEnd - runStart)) { *err = @"download size mismatch"; [fh closeFile]; return nil; }
    i = j;
  }
  // The new manifest, stored.
  NSMutableData *rec = [NSMutableData data];
  ZEntry me = manifestEntry;
  me.off = fh.offsetInFile;
  me.method = 0;
  me.flags = 0;
  me.csize = me.usize = newManifest.length;
  me.crc = (uint32_t)crc32(0, newManifest.bytes, (uInt)newManifest.length);
  NSData *mname = [@"BuildManifest.plist" dataUsingEncoding:NSUTF8StringEncoding];
  w32(rec, 0x04034b50); w16(rec, 20); w16(rec, 0); w16(rec, 0); w16(rec, me.time); w16(rec, me.date);
  w32(rec, me.crc); w32(rec, (uint32_t)me.csize); w32(rec, (uint32_t)me.usize); w16(rec, mname.length); w16(rec, 0);
  [rec appendData:mname];
  [rec appendData:newManifest];
  [fh writeData:rec];
  [central addObject:@[@"BuildManifest.plist", [NSValue valueWithBytes:&me objCType:@encode(ZEntry)]]];
  // Central directory: every record zip64, so offsets past 4 GB need no special cases.
  NSMutableData *cd = [NSMutableData data];
  for (NSArray *e in central) {
    ZEntry z;
    [e[1] getValue:&z];
    NSData *name = [e[0] dataUsingEncoding:NSUTF8StringEncoding];
    w32(cd, 0x02014b50); w16(cd, (z.madeBy & 0xFF00) | 45); w16(cd, 45); w16(cd, z.flags); w16(cd, z.method);
    w16(cd, z.time); w16(cd, z.date); w32(cd, z.crc); w32(cd, 0xFFFFFFFF); w32(cd, 0xFFFFFFFF);
    w16(cd, name.length); w16(cd, 28); w16(cd, 0); w16(cd, 0); w16(cd, z.internal); w32(cd, z.external); w32(cd, 0xFFFFFFFF);
    [cd appendData:name];
    w16(cd, 1); w16(cd, 24); w64(cd, z.usize); w64(cd, z.csize); w64(cd, z.off);
  }
  uint64_t cdOff = fh.offsetInFile;
  NSMutableData *end = [NSMutableData dataWithData:cd];
  uint64_t z64Off = cdOff + cd.length;
  w32(end, 0x06064b50); w64(end, 44); w16(end, 45); w16(end, 45); w32(end, 0); w32(end, 0);
  w64(end, central.count); w64(end, central.count); w64(end, cd.length); w64(end, cdOff);
  w32(end, 0x07064b50); w32(end, 0); w64(end, z64Off); w32(end, 1);
  w32(end, 0x06054b50); w16(end, 0); w16(end, 0); w16(end, 0xFFFF); w16(end, 0xFFFF); w32(end, 0xFFFFFFFF); w32(end, 0xFFFFFFFF); w16(end, 0);
  [fh writeData:end];
  [fh synchronizeFile];
  [fh closeFile];
  rename(partial.fileSystemRepresentation, P(@"restore.ipsw").fileSystemRepresentation);
  event(@"progress", @{@"phase": @"download", @"done": @(need), @"total": @(need)});
  return @{@"version": latest[@"version"], @"build": latest[@"build"], @"bytes": @(need), @"fullBytes": @(total), @"rosetta": @(!dropRosetta)};
}

// ---------------------------------------------------------------------------------------------------
// The virtual machine

static dispatch_queue_t gVMQ;
static VZVirtualMachine *gVM;
static CGSize gDisplay = {1280, 800};
// Frames: Virtualization.framework hands a guest display's frames only to a VZVirtualMachineView (its private
// screenshot call traps the VM service when there is none). So the helper keeps one, in a borderless window that is
// never put on screen, and takes each frame from it: the framebuffer view's layer holds the frame's IOSurface after
// `presenter:didUpdateFrame:`, which the helper hooks (calling through) to learn of every new frame.
static NSWindow *gWin;
static VZVirtualMachineView *gView;
static id gSurface;               // the latest frame's IOSurface (main queue)
static atomic_ullong gFrames;     // frames seen
static void onFrame(void);

static IMP gOrigFrame;
static void hookFrame(id self, SEL _cmd, id presenter, void *p0, void *p1) {
  ((void (*)(id, SEL, id, void *, void *))gOrigFrame)(self, _cmd, presenter, p0, p1);
  id c = [(NSView *)self layer].contents;
  if (c && CFGetTypeID((__bridge CFTypeRef)c) == IOSurfaceGetTypeID()) {
    gSurface = c;
    atomic_fetch_add(&gFrames, 1);
    onFrame();
  }
}

static void attachView(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Method m = class_getInstanceMethod(NSClassFromString(@"_VZFramebufferView"), NSSelectorFromString(@"presenter:didUpdateFrame:"));
    if (m) gOrigFrame = method_setImplementation(m, (IMP)hookFrame);
  });
  NSRect r = NSMakeRect(0, 0, gDisplay.width, gDisplay.height);
  if (!gWin) {
    gWin = [[NSWindow alloc] initWithContentRect:r styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    gWin.releasedWhenClosed = NO;
    gWin.ignoresMouseEvents = YES;
    gWin.excludedFromWindowsMenu = YES;
    gWin.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
  }
  gSurface = nil;
  gView = [[VZVirtualMachineView alloc] initWithFrame:r];
  gView.capturesSystemKeys = NO;
  if (@available(macOS 14.0, *)) gView.automaticallyReconfiguresDisplay = NO;
  gView.virtualMachine = gVM;
  gWin.contentView = gView;
}

static NSString *gState = @"stopped";  // stopped, installing, starting, running, stopping, error

static void setState(NSString *s) {
  gState = s;
  event(@"state", @{@"state": s});
}

@interface CVDelegate : NSObject <VZVirtualMachineDelegate>
@end
@implementation CVDelegate
- (void)guestDidStopVirtualMachine:(VZVirtualMachine *)vm { gVM = nil; setState(@"stopped"); }
- (void)virtualMachine:(VZVirtualMachine *)vm didStopWithError:(NSError *)error {
  gVM = nil;
  event(@"error", @{@"error": error.localizedDescription ?: @"stopped"});
  setState(@"stopped");
}
@end
static CVDelegate *gDelegate;

// ---------------------------------------------------------------------------------------------------
// The network (APP_SPEC "Mac panel (sandbox VM)" > Network): config.json `network` is "on" (NAT: the internet and
// this computer), "local" (a host-only vmnet network: this computer only, no DNS proxy, no NAT) or "off" (no
// network device at all). A VM booted with a device switches between them live (its attachment changes; "off"
// detaches it, like pulling the cable); one booted without a device needs a restart to get one.

static NSString *gNetBoot = nil;  // what the running VM booted with (nil: stopped)
static NSString *gNetNow = nil;   // what is attached now
static vmnet_network_ref gHostNet = NULL;

static NSString *netSetting(NSDictionary *cfg) {
  NSString *n = cfg[@"network"];
  return [@[@"on", @"local", @"off"] containsObject:n] ? n : @"on";
}

/// The attachment for a mode (nil for "off", or when host-only isn't available on this macOS).
static VZNetworkDeviceAttachment *netAttachment(NSString *mode, NSString **err) {
  if ([mode isEqualToString:@"on"]) return [[VZNATNetworkDeviceAttachment alloc] init];
  if ([mode isEqualToString:@"local"]) {
    if (@available(macOS 26.0, *)) {
      if (!gHostNet) {
        vmnet_return_t st = VMNET_SUCCESS;
        vmnet_network_configuration_ref c = vmnet_network_configuration_create(VMNET_HOST_MODE, &st);
        if (!c) { if (err) *err = [NSString stringWithFormat:@"host-only network: vmnet status %d", st]; return nil; }
        // Nothing but this computer: no DNS proxy (no lookups for the guest), no NAT (host mode has none).
        vmnet_network_configuration_disable_dns_proxy(c);
        vmnet_network_configuration_disable_nat44(c);
        vmnet_network_configuration_disable_nat66(c);
        gHostNet = vmnet_network_create(c, &st);
        CFRelease(c);
        if (!gHostNet) { if (err) *err = [NSString stringWithFormat:@"host-only network: vmnet status %d", st]; return nil; }
      }
      return [[VZVmnetNetworkDeviceAttachment alloc] initWithNetwork:gHostNet];
    }
    if (err) *err = @"a host-only network needs macOS 26 on this Mac";
    return nil;
  }
  return nil;
}

static NSString *macAddress(NSMutableDictionary *cfg) {
  NSString *mac = cfg[@"mac"];
  if (!mac) {
    mac = [VZMACAddress randomLocallyAdministeredAddress].string;
    cfg[@"mac"] = mac;
  }
  return mac;
}

static VZVirtualMachineConfiguration *makeConfig(NSMutableDictionary *cfg, VZMacHardwareModel *model, NSString *net, NSString **err) {
  NSError *e = nil;
  VZMacPlatformConfiguration *platform = [[VZMacPlatformConfiguration alloc] init];
  platform.hardwareModel = model;
  NSData *mid = [[NSData alloc] initWithBase64EncodedString:cfg[@"machineId"] ?: @"" options:0];
  VZMacMachineIdentifier *ident = mid.length ? [[VZMacMachineIdentifier alloc] initWithDataRepresentation:mid] : nil;
  if (!ident) { ident = [[VZMacMachineIdentifier alloc] init]; cfg[@"machineId"] = [ident.dataRepresentation base64EncodedStringWithOptions:0]; }
  platform.machineIdentifier = ident;
  platform.auxiliaryStorage = [[VZMacAuxiliaryStorage alloc] initWithURL:[NSURL fileURLWithPath:P(@"aux.img")]];

  VZVirtualMachineConfiguration *c = [[VZVirtualMachineConfiguration alloc] init];
  c.platform = platform;
  c.bootLoader = [[VZMacOSBootLoader alloc] init];
  NSUInteger cpus = (NSUInteger)[cfg[@"cpus"] ?: @4 integerValue];
  uint64_t mem = (uint64_t)[cfg[@"memoryMB"] ?: @6144 longLongValue] << 20;
  c.CPUCount = MAX(VZVirtualMachineConfiguration.minimumAllowedCPUCount, MIN(cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount));
  c.memorySize = MAX(VZVirtualMachineConfiguration.minimumAllowedMemorySize, MIN(mem, VZVirtualMachineConfiguration.maximumAllowedMemorySize));

  VZMacGraphicsDeviceConfiguration *g = [[VZMacGraphicsDeviceConfiguration alloc] init];
  gDisplay = CGSizeMake([cfg[@"displayW"] ?: @1280 doubleValue], [cfg[@"displayH"] ?: @800 doubleValue]);
  g.displays = @[[[VZMacGraphicsDisplayConfiguration alloc] initWithWidthInPixels:(NSInteger)gDisplay.width heightInPixels:(NSInteger)gDisplay.height pixelsPerInch:110]];
  c.graphicsDevices = @[g];

  VZDiskImageStorageDeviceAttachment *disk = [[VZDiskImageStorageDeviceAttachment alloc] initWithURL:[NSURL fileURLWithPath:P(@"disk.img")] readOnly:NO
      cachingMode:VZDiskImageCachingModeAutomatic synchronizationMode:VZDiskImageSynchronizationModeFsync error:&e];
  if (!disk) { *err = [NSString stringWithFormat:@"disk: %@", e.localizedDescription]; return nil; }
  c.storageDevices = @[[[VZVirtioBlockDeviceConfiguration alloc] initWithAttachment:disk]];

  if (![net isEqualToString:@"off"]) {
    NSString *ne = nil;
    VZNetworkDeviceAttachment *att = netAttachment(net, &ne);
    if (!att) { *err = ne ?: @"no network attachment"; return nil; }
    VZVirtioNetworkDeviceConfiguration *nd = [[VZVirtioNetworkDeviceConfiguration alloc] init];
    nd.attachment = att;
    nd.MACAddress = [[VZMACAddress alloc] initWithString:macAddress(cfg)];
    c.networkDevices = @[nd];
  } else {
    c.networkDevices = @[];
  }

  c.keyboards = @[[[VZUSBKeyboardConfiguration alloc] init]];
  c.pointingDevices = @[[[VZUSBScreenCoordinatePointingDeviceConfiguration alloc] init], [[VZMacTrackpadConfiguration alloc] init]];
  c.entropyDevices = @[[[VZVirtioEntropyDeviceConfiguration alloc] init]];
  c.memoryBalloonDevices = @[[[VZVirtioTraditionalMemoryBalloonDeviceConfiguration alloc] init]];
  c.socketDevices = @[[[VZVirtioSocketDeviceConfiguration alloc] init]];

  // The one folder the guest shares with the host: <dir>/Shared, seen in the guest as /Volumes/My Shared Files.
  NSString *shared = P(@"Shared");
  [[NSFileManager defaultManager] createDirectoryAtPath:shared withIntermediateDirectories:YES attributes:nil error:nil];
  VZVirtioFileSystemDeviceConfiguration *fs = [[VZVirtioFileSystemDeviceConfiguration alloc] initWithTag:VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag];
  fs.share = [[VZSingleDirectoryShare alloc] initWithDirectory:[[VZSharedDirectory alloc] initWithURL:[NSURL fileURLWithPath:shared] readOnly:NO]];
  c.directorySharingDevices = @[fs];

  if (![c validateWithError:&e]) { *err = [NSString stringWithFormat:@"configuration: %@", e.localizedDescription]; return nil; }
  return c;
}

static VZMacHardwareModel *savedModel(NSDictionary *cfg) {
  NSData *d = [[NSData alloc] initWithBase64EncodedString:cfg[@"hardwareModel"] ?: @"" options:0];
  return d.length ? [[VZMacHardwareModel alloc] initWithDataRepresentation:d] : nil;
}

static NSDictionary *install(NSDictionary *m, NSString **err) {
  NSMutableDictionary *cfg = loadConfig();
  if ([cfg[@"installed"] boolValue]) return @{@"installed": @YES, @"already": @YES};
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *ipsw = str(m, @"ipsw") ?: P(@"restore.ipsw");
  NSDictionary *dl = nil;
  if (![fm fileExistsAtPath:ipsw]) {
    setState(@"downloading");
    dl = downloadRestore(m, err);
    if (!dl) { setState(@"stopped"); return nil; }
    cfg[@"os"] = [NSString stringWithFormat:@"%@ (%@)", dl[@"version"], dl[@"build"]];
    cfg[@"rosetta"] = dl[@"rosetta"];
    saveConfig(cfg);
  }
  setState(@"installing");
  __block VZMacOSRestoreImage *image = nil;
  __block NSError *le = nil;
  dispatch_semaphore_t loaded = dispatch_semaphore_create(0);
  [VZMacOSRestoreImage loadFileURL:[NSURL fileURLWithPath:ipsw] completionHandler:^(VZMacOSRestoreImage *img, NSError *e) {
    image = img;
    le = e;
    dispatch_semaphore_signal(loaded);
  }];
  dispatch_semaphore_wait(loaded, DISPATCH_TIME_FOREVER);
  if (!image) { *err = [NSString stringWithFormat:@"restore image: %@", le.localizedDescription]; setState(@"stopped"); return nil; }
  VZMacOSConfigurationRequirements *req = image.mostFeaturefulSupportedConfiguration;
  if (!req || !req.hardwareModel.supported) { *err = @"This Mac can't run the restore image's macOS in a virtual machine."; setState(@"stopped"); return nil; }
  if (!cfg[@"os"]) {
    NSOperatingSystemVersion v = image.operatingSystemVersion;
    cfg[@"os"] = [NSString stringWithFormat:@"%ld.%ld.%ld (%@)", (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion, image.buildVersion];
  }
  cfg[@"hardwareModel"] = [req.hardwareModel.dataRepresentation base64EncodedStringWithOptions:0];
  [cfg removeObjectForKey:@"machineId"];
  cfg[@"cpus"] = m[@"cpus"] ?: cfg[@"cpus"] ?: @4;
  cfg[@"memoryMB"] = m[@"memoryMB"] ?: cfg[@"memoryMB"] ?: @6144;
  uint64_t diskGB = (uint64_t)num(m, @"diskGB", 40);
  cfg[@"diskGB"] = @(diskGB);
  NSError *e = nil;
  if (![[VZMacAuxiliaryStorage alloc] initCreatingStorageAtURL:[NSURL fileURLWithPath:P(@"aux.img")] hardwareModel:req.hardwareModel
                                                       options:VZMacAuxiliaryStorageInitializationOptionAllowOverwrite error:&e]) {
    *err = [NSString stringWithFormat:@"auxiliary storage: %@", e.localizedDescription];
    setState(@"stopped");
    return nil;
  }
  // A sparse raw image: only what the guest writes takes space.
  int fd = open(P(@"disk.img").fileSystemRepresentation, O_CREAT | O_TRUNC | O_RDWR, 0600);
  if (fd < 0 || ftruncate(fd, (off_t)(diskGB << 30)) != 0) { if (fd >= 0) close(fd); *err = @"couldn't create the disk image"; setState(@"stopped"); return nil; }
  close(fd);
  VZVirtualMachineConfiguration *c = makeConfig(cfg, req.hardwareModel, @"on", err);
  if (!c) { setState(@"stopped"); return nil; }
  saveConfig(cfg);
  __block NSError *ie = nil;
  dispatch_semaphore_t finished = dispatch_semaphore_create(0);
  __block VZMacOSInstaller *installer = nil;
  dispatch_sync(gVMQ, ^{
    gVM = [[VZVirtualMachine alloc] initWithConfiguration:c queue:gVMQ];
    installer = [[VZMacOSInstaller alloc] initWithVirtualMachine:gVM restoreImageURL:[NSURL fileURLWithPath:ipsw]];
    [installer installWithCompletionHandler:^(NSError *error) {
      ie = error;
      dispatch_semaphore_signal(finished);
    }];
  });
  double t0 = nowMs();
  while (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) {
    __block double f = 0;
    dispatch_sync(gVMQ, ^{ f = installer.progress.fractionCompleted; });
    event(@"progress", @{@"phase": @"install", @"fraction": @(f), @"free": @(freeBytes(gDir))});
  }
  dispatch_sync(gVMQ, ^{ gVM = nil; });
  if (ie) {
    *err = [NSString stringWithFormat:@"install failed: %@", ie.localizedDescription];
    setState(@"stopped");
    return nil;
  }
  cfg[@"installed"] = @YES;
  cfg[@"installSeconds"] = @(round((nowMs() - t0) / 1000));
  saveConfig(cfg);
  if (![m[@"keepIpsw"] boolValue]) [fm removeItemAtPath:ipsw error:nil];
  setState(@"stopped");
  return @{@"installed": @YES, @"os": cfg[@"os"] ?: @"", @"seconds": cfg[@"installSeconds"], @"download": dl ?: @{}};
}

static NSArray *ocr(CGImageRef img, NSString **err);

/// Vision loads its text models on first use (tens of seconds): do that while the guest boots.
static void warmOCR(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
      CGContextRef ctx = CGBitmapContextCreate(NULL, 64, 32, 8, 0, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
      CGColorSpaceRelease(cs);
      if (!ctx) return;
      CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
      CGContextFillRect(ctx, CGRectMake(0, 0, 64, 32));
      CGImageRef img = CGBitmapContextCreateImage(ctx);
      CGContextRelease(ctx);
      NSString *err = nil;
      ocr(img, &err);
      CGImageRelease(img);
    });
  });
}

static void startVM(NSDictionary *m, id rid) {
  NSString *err = nil;
  if (gVM) { reply(rid, @{@"state": gState}); return; }
  if (!takeLock(&err)) { fail(rid, err); return; }
  NSMutableDictionary *cfg = loadConfig();
  if (![cfg[@"installed"] boolValue]) { fail(rid, @"This Mac isn't installed yet."); return; }
  VZMacHardwareModel *model = savedModel(cfg);
  if (!model) { fail(rid, @"config.json has no hardware model"); return; }
  // `network` in the request: this boot only (coool's first-run setup needs SSH from this computer).
  NSString *net = [@[@"on", @"local", @"off"] containsObject:m[@"network"]] ? m[@"network"] : netSetting(cfg);
  VZVirtualMachineConfiguration *c = makeConfig(cfg, model, net, &err);
  if (!c) { fail(rid, err); return; }
  saveConfig(cfg);
  VZMacOSVirtualMachineStartOptions *opts = [[VZMacOSVirtualMachineStartOptions alloc] init];
  opts.startUpFromMacOSRecovery = [m[@"recovery"] boolValue];
  NSDictionary *prov = m[@"provision"];
  if ([prov isKindOfClass:NSDictionary.class]) {
    if (@available(macOS 27.0, *)) {
      VZMacGuestProvisioningOptions *p = [[VZMacGuestProvisioningOptions alloc] init];
      p.fullName = prov[@"fullName"] ?: @"coool";
      p.username = prov[@"username"] ?: @"coool";
      p.password = prov[@"password"] ?: @"";
      p.logsInAutomatically = [prov[@"autoLogin"] ?: @YES boolValue];
      p.enablesRemoteLogin = [prov[@"ssh"] ?: @YES boolValue];
      NSError *pe = nil;
      if (![opts setGuestProvisioningOptions:p error:&pe]) { fail(rid, [NSString stringWithFormat:@"provisioning: %@", pe.localizedDescription]); return; }
    } else {
      fail(rid, @"Setting up the guest automatically needs macOS 27 on this Mac.");
      return;
    }
  }
  setState(@"starting");
  double t0 = nowMs();
  dispatch_async(gVMQ, ^{
    gVM = [[VZVirtualMachine alloc] initWithConfiguration:c queue:gVMQ];
    if (!gDelegate) gDelegate = [CVDelegate new];
    gVM.delegate = gDelegate;
    [gVM startWithOptions:opts completionHandler:^(NSError *e) {
      if (e) {
        gVM = nil;
        setState(@"stopped");
        fail(rid, [NSString stringWithFormat:@"couldn't start the Mac: %@", e.localizedDescription]);
        return;
      }
      gNetBoot = net;
      gNetNow = net;
      attachView();
      warmOCR();
      setState(@"running");
      reply(rid, @{@"state": @"running", @"ms": @(round(nowMs() - t0))});
    }];
  });
}

static NSDictionary *agentCall(NSDictionary *req, double timeoutSec, NSString **err);

/// Shuts the guest down: through coool's agent when it runs (a clean `shutdown`; the power button alone only shows
/// macOS's "Are you sure?" dialog), else the power button; forced off after `timeout` seconds.
static void stopVM(NSDictionary *m, id rid) {
  if (!gVM) { reply(rid, @{@"state": @"stopped"}); return; }
  double timeout = num(m, @"timeout", 30);
  setState(@"stopping");
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *err = nil;
    BOOL viaAgent = !m[@"force"] && agentCall(@{@"cmd": @"run", @"sh": @"sudo -n /sbin/shutdown -h now", @"timeout": @5}, 4, &err) != nil;
    dispatch_async(gVMQ, ^{
    NSError *e = nil;
    BOOL asked = !m[@"force"] && (viaAgent || (gVM.canRequestStop && [gVM requestStopWithError:&e]));
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      double t0 = nowMs();
      while (asked && nowMs() - t0 < timeout * 1000) {
        __block BOOL gone = NO;
        dispatch_sync(gVMQ, ^{ gone = !gVM || gVM.state == VZVirtualMachineStateStopped; });
        if (gone) break;
        [NSThread sleepForTimeInterval:0.2];
      }
      dispatch_async(gVMQ, ^{
        if (gVM && gVM.state != VZVirtualMachineStateStopped) {
          [gVM stopWithCompletionHandler:^(NSError *se) {
            gVM = nil;
            setState(@"stopped");
            reply(rid, @{@"state": @"stopped", @"forced": @YES, @"ms": @(round(nowMs() - t0))});
          }];
        } else {
          gVM = nil;
          setState(@"stopped");
          reply(rid, @{@"state": @"stopped", @"ms": @(round(nowMs() - t0)), @"viaAgent": @(viaAgent)});
        }
      });
    });
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Frames

static CIContext *gCI;
static dispatch_queue_t gFrameQ;
static atomic_bool gStreaming;
static double gMaxDim = 1100, gQuality = 0.7, gFPS = 15;

/// The guest display's current picture.
static CGImageRef screenshot(NSString **err) CF_RETURNS_RETAINED {
  __block CIImage *ci = nil;
  __block BOOL running = NO;
  dispatch_sync(gVMQ, ^{
    running = gVM && gVM.state == VZVirtualMachineStateRunning;
    if (gSurface) ci = [CIImage imageWithIOSurface:(__bridge IOSurfaceRef)gSurface];
  });
  if (!running) { *err = @"the Mac isn't running"; return NULL; }
  if (!ci) { *err = @"the Mac's screen has no picture yet"; return NULL; }
  return [gCI createCGImage:ci fromRect:ci.extent];
}

static NSData *jpeg(CGImageRef img, double maxDim, double quality) {
  CIImage *ci = [CIImage imageWithCGImage:img];
  double longest = MAX(ci.extent.size.width, ci.extent.size.height);
  if (maxDim > 0 && longest > maxDim) {
    double s = maxDim / longest;
    ci = [ci imageByApplyingTransform:CGAffineTransformMakeScale(s, s) highQualityDownsample:YES];
  }
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  NSData *d = [gCI JPEGRepresentationOfImage:ci colorSpace:cs options:@{(id)kCGImageDestinationLossyCompressionQuality: @(quality)}];
  CGColorSpaceRelease(cs);
  return d;
}

/// RGBA pixels of a picture at display size (top-left origin).
static NSData *rgba(CGImageRef img, size_t *w, size_t *hgt) {
  *w = (size_t)gDisplay.width;
  *hgt = (size_t)gDisplay.height;
  NSMutableData *d = [NSMutableData dataWithLength:*w * *hgt * 4];
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(d.mutableBytes, *w, *hgt, 8, *w * 4, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(cs);
  if (!ctx) return nil;
  CGContextDrawImage(ctx, CGRectMake(0, 0, *w, *hgt), img);
  CGContextRelease(ctx);
  return d;
}

/// Streaming: each new frame is encoded and sent, at most `gFPS` a second (the latest one wins).
static void sendFrameNow(void) {
  @autoreleasepool {
    NSString *err = nil;
    CGImageRef img = screenshot(&err);
    if (!img) return;
    NSData *j = jpeg(img, gMaxDim, gQuality);
    CGImageRelease(img);
    if (j && atomic_load(&gStreaming)) writeFrame('F', j);
  }
}

static double gLastSent = 0;
static BOOL gPending = NO;  // on gFrameQ

static void onFrame(void) {
  if (!atomic_load(&gStreaming)) return;
  dispatch_async(gFrameQ, ^{
    if (gPending) return;
    double wait = 1000.0 / gFPS - (nowMs() - gLastSent);
    gPending = YES;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(0, wait) * NSEC_PER_MSEC)), gFrameQ, ^{
      gPending = NO;
      gLastSent = nowMs();
      sendFrameNow();
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Input: the VM's USB keyboard and screen-coordinate pointer.

static id device(NSString *kind) {
  NSArray *list = [kind isEqual:@"keyboard"] ? [(id)gVM _keyboards] : [(id)gVM _pointingDevices];
  return list.firstObject;
}

static CGPoint gMouse = {0, 0};
static NSInteger gButtons = 0;

/// Pointer location for the device: the screen-coordinate pointer takes the display's unit square (0-1 across and
/// down, origin top left), whatever its pixel size.
static CGPoint devicePoint(double x, double y) {
  return CGPointMake(MAX(0, MIN(1, x / gDisplay.width)), MAX(0, MIN(1, y / gDisplay.height)));
}

// Input goes to the devices on the VM's queue.
static void pointer(double x, double y, NSInteger buttons) {
  gMouse = CGPointMake(x, y);
  gButtons = buttons;
  dispatch_sync(gVMQ, ^{
    id dev = gVM ? device(@"pointer") : nil;
    Class ev = NSClassFromString(@"_VZScreenCoordinatePointerEvent");
    if (!dev || !ev) return;
    id e = [[ev alloc] initWithLocation:devicePoint(x, y) pressedButtons:buttons];
    [dev sendPointerEvents:@[e]];
  });
}

static void key(unsigned short code, BOOL down) {
  dispatch_sync(gVMQ, ^{
    id dev = gVM ? device(@"keyboard") : nil;
    Class ev = NSClassFromString(@"_VZKeyEvent");
    if (!dev || !ev) return;
    id e = [[ev alloc] initWithType:down ? 0 : 1 keyCode:code];
    [dev sendKeyEvents:@[e]];
  });
}

// macOS virtual key codes (US layout).
static const struct { const char *name; unsigned short code; } kNamedKeys[] = {
  {"return", 36}, {"enter", 76}, {"tab", 48}, {"space", 49}, {"delete", 51}, {"backspace", 51}, {"escape", 53}, {"esc", 53},
  {"command", 55}, {"cmd", 55}, {"shift", 56}, {"capslock", 57}, {"option", 58}, {"alt", 58}, {"control", 59}, {"ctrl", 59},
  {"rightshift", 60}, {"rightoption", 61}, {"rightcontrol", 62}, {"fn", 63}, {"forwarddelete", 117}, {"home", 115}, {"end", 119},
  {"pageup", 116}, {"pagedown", 121}, {"left", 123}, {"right", 124}, {"down", 125}, {"up", 126},
  {"f1", 122}, {"f2", 120}, {"f3", 99}, {"f4", 118}, {"f5", 96}, {"f6", 97}, {"f7", 98}, {"f8", 100}, {"f9", 101}, {"f10", 109},
  {"f11", 103}, {"f12", 111},
};
static const unsigned short kLetter[26] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
static const unsigned short kDigit[10] = {29, 18, 19, 20, 21, 23, 22, 26, 28, 25};

/// The key (and whether shift is needed) that types `c` on a US keyboard; NO for characters without one.
static BOOL charKey(unichar c, unsigned short *code, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') { *code = kLetter[c - 'a']; return YES; }
  if (c >= 'A' && c <= 'Z') { *code = kLetter[c - 'A']; *shift = YES; return YES; }
  if (c >= '0' && c <= '9') { *code = kDigit[c - '0']; return YES; }
  const char *plain = " -=[]\\;',./`\n\t";
  const unsigned short plainCodes[] = {49, 27, 24, 33, 30, 42, 41, 39, 43, 47, 44, 50, 36, 48};
  const char *shifted = ")!@#$%^&*(_+{}|:\"<>?~";
  const unsigned short shiftedCodes[] = {29, 18, 19, 20, 21, 23, 22, 26, 28, 25, 27, 24, 33, 30, 42, 41, 39, 43, 47, 44, 50};
  for (int i = 0; plain[i]; i++) if (plain[i] == c) { *code = plainCodes[i]; return YES; }
  for (int i = 0; shifted[i]; i++) if (shifted[i] == c) { *code = shiftedCodes[i]; *shift = YES; return YES; }
  return NO;
}

static BOOL namedKey(NSString *name, unsigned short *code) {
  NSString *n = name.lowercaseString;
  for (size_t i = 0; i < sizeof kNamedKeys / sizeof kNamedKeys[0]; i++)
    if ([n isEqualToString:@(kNamedKeys[i].name)]) { *code = kNamedKeys[i].code; return YES; }
  BOOL shift;
  if (n.length == 1 && charKey([n characterAtIndex:0], code, &shift)) return YES;
  return NO;
}

static unsigned short modifierCode(NSString *m) {
  unsigned short c = 0;
  namedKey(m, &c);
  return c;
}

static void usleepMs(double ms) { if (ms > 0) usleep((useconds_t)(ms * 1000)); }

static NSString *pressKey(NSString *name, NSArray *mods) {
  unsigned short code;
  if (!namedKey(name, &code)) return [NSString stringWithFormat:@"unknown key %@", name];
  for (NSString *m in mods) { key(modifierCode(m), YES); usleepMs(8); }
  key(code, YES);
  usleepMs(25);
  key(code, NO);
  for (NSString *m in mods.reverseObjectEnumerator) { usleepMs(8); key(modifierCode(m), NO); }
  return nil;
}

static NSString *typeString(NSString *text, double perKeyMs) {
  for (NSUInteger i = 0; i < text.length; i++) {
    unichar c = [text characterAtIndex:i];
    unsigned short code;
    BOOL shift;
    if (!charKey(c, &code, &shift)) return [NSString stringWithFormat:@"can't type %C on a US keyboard", c];
    if (shift) key(56, YES);
    key(code, YES);
    usleepMs(perKeyMs / 2);
    key(code, NO);
    if (shift) key(56, NO);
    usleepMs(perKeyMs / 2);
  }
  return nil;
}

static void click(double x, double y, NSInteger button, int count) {
  pointer(x, y, 0);
  usleepMs(30);
  for (int i = 0; i < count; i++) {
    pointer(x, y, button);
    usleepMs(40);
    pointer(x, y, 0);
    usleepMs(i + 1 < count ? 60 : 10);
  }
}

static void drag(double x, double y, double x2, double y2, double ms) {
  pointer(x, y, 0);
  usleepMs(30);
  pointer(x, y, 1);
  int steps = MAX(4, (int)(ms / 16));
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / steps;
    pointer(x + (x2 - x) * t, y + (y2 - y) * t, 1);
    usleepMs(ms / steps);
  }
  pointer(x2, y2, 0);
}

static void scroll(double x, double y, double dx, double dy) {
  pointer(x, y, 0);
  usleepMs(20);
  Class ev = NSClassFromString(@"_VZScrollWheelEvent");
  // In steps, like a wheel: a big single delta is clamped by the guest.
  int steps = MAX(1, (int)(MAX(fabs(dx), fabs(dy)) / 40));
  for (int i = 0; i < steps; i++) {
    dispatch_sync(gVMQ, ^{
      id dev = gVM ? device(@"pointer") : nil;
      if (!dev || !ev || ![dev respondsToSelector:@selector(sendScrollWheelEvents:)]) return;
      id e = [[ev alloc] initWithScrollingDeltaX:dx / steps scrollingDeltaY:dy / steps acceleratedScrollingDeltaX:dx / steps
                       acceleratedScrollingDeltaY:dy / steps scrollPhase:0 momentumPhase:0];
      [dev sendScrollWheelEvents:@[e]];
    });
    usleepMs(12);
  }
}

// ---------------------------------------------------------------------------------------------------
// OCR (Vision)

static NSArray *ocr(CGImageRef img, NSString **err) {
  VNRecognizeTextRequest *r = [VNRecognizeTextRequest new];
  r.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  r.usesLanguageCorrection = NO;
  VNImageRequestHandler *h = [[VNImageRequestHandler alloc] initWithCGImage:img options:@{}];
  NSError *e = nil;
  if (![h performRequests:@[r] error:&e]) { *err = e.localizedDescription; return nil; }
  double W = CGImageGetWidth(img), H = CGImageGetHeight(img);
  double sx = gDisplay.width / W, sy = gDisplay.height / H;
  NSMutableArray *out = [NSMutableArray array];
  for (VNRecognizedTextObservation *o in r.results) {
    VNRecognizedText *t = [o topCandidates:1].firstObject;
    if (!t) continue;
    CGRect b = o.boundingBox;  // normalized, origin bottom left
    double x = b.origin.x * W * sx, y = (1 - b.origin.y - b.size.height) * H * sy;
    [out addObject:@{@"text": t.string, @"confidence": @(round(t.confidence * 100) / 100),
                     @"frame": @[@(round(x)), @(round(y)), @(round(b.size.width * W * sx)), @(round(b.size.height * H * sy))]}];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The guest agent, over vsock

static const uint32_t kAgentPort = 7333;
static int gAgentFd = -1;
static VZVirtioSocketConnection *gAgentConn;
static NSLock *gAgentLock;
static NSMutableData *gAgentBuf;

static BOOL agentConnect(NSString **err) {
  if (gAgentFd >= 0) return YES;
  __block VZVirtioSocketConnection *conn = nil;
  __block NSString *e2 = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  dispatch_async(gVMQ, ^{
    VZVirtioSocketDevice *s = (VZVirtioSocketDevice *)gVM.socketDevices.firstObject;
    if (!s) { e2 = @"the Mac isn't running"; dispatch_semaphore_signal(done); return; }
    [s connectToPort:kAgentPort completionHandler:^(VZVirtioSocketConnection *c, NSError *e) {
      conn = c;
      if (!c) e2 = [NSString stringWithFormat:@"the guest agent isn't answering (%@)", e.localizedDescription];
      dispatch_semaphore_signal(done);
    }];
  });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) { *err = @"the guest agent didn't connect in time"; return NO; }
  if (!conn) { *err = e2; return NO; }
  gAgentConn = conn;
  gAgentFd = conn.fileDescriptor;
  gAgentBuf = [NSMutableData data];
  return YES;
}

static void agentDrop(void) {
  if (gAgentConn) [gAgentConn close];
  gAgentConn = nil;
  gAgentFd = -1;
}

/// One request to the guest agent; its reply.
static NSDictionary *agentCall(NSDictionary *req, double timeoutSec, NSString **err) {
  [gAgentLock lock];
  NSDictionary *out = nil;
  for (int attempt = 0; attempt < 2 && !out; attempt++) {
    if (!agentConnect(err)) break;
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:req options:0 error:nil] mutableCopy];
    [line appendBytes:"\n" length:1];
    if (write(gAgentFd, line.bytes, line.length) != (ssize_t)line.length) { agentDrop(); *err = @"the guest agent went away"; continue; }
    double t0 = nowMs();
    BOOL broken = NO;
    while (!out && !broken) {
      const uint8_t *b = gAgentBuf.bytes;
      void *nl = memchr(b, '\n', gAgentBuf.length);
      if (nl) {
        NSUInteger n = (const uint8_t *)nl - b;
        NSData *one = [gAgentBuf subdataWithRange:NSMakeRange(0, n)];
        [gAgentBuf replaceBytesInRange:NSMakeRange(0, n + 1) withBytes:NULL length:0];
        id j = [NSJSONSerialization JSONObjectWithData:one options:0 error:nil];
        if ([j isKindOfClass:NSDictionary.class]) out = j;
        continue;
      }
      double left = timeoutSec * 1000 - (nowMs() - t0);
      if (left <= 0) { *err = @"the guest agent didn't answer in time"; broken = YES; agentDrop(); attempt = 2; break; }
      fd_set rs;
      FD_ZERO(&rs);
      FD_SET(gAgentFd, &rs);
      struct timeval tv = {(long)(left / 1000), (int)fmod(left, 1000) * 1000};
      int r = select(gAgentFd + 1, &rs, NULL, NULL, &tv);
      if (r <= 0) continue;
      uint8_t buf[65536];
      ssize_t got = read(gAgentFd, buf, sizeof buf);
      if (got <= 0) { agentDrop(); *err = @"the guest agent closed the connection"; broken = YES; break; }
      [gAgentBuf appendBytes:buf length:got];
    }
  }
  [gAgentLock unlock];
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The guest's address (NAT DHCP lease), for SSH during setup.

static NSString *normMac(NSString *mac) {
  NSMutableArray *parts = [NSMutableArray array];
  for (NSString *p in [mac.lowercaseString componentsSeparatedByString:@":"]) {
    unsigned v = 0;
    [[NSScanner scannerWithString:p] scanHexInt:&v];
    [parts addObject:[NSString stringWithFormat:@"%x", v]];
  }
  return [parts componentsJoinedByString:@":"];
}

static NSString *guestIP(void) {
  NSString *mac = loadConfig()[@"mac"];
  if (!mac) return nil;
  NSString *want = normMac(mac);
  NSString *leases = [NSString stringWithContentsOfFile:@"/var/db/dhcpd_leases" encoding:NSUTF8StringEncoding error:nil];
  NSString *ip = nil, *found = nil;
  for (NSString *raw in [leases componentsSeparatedByString:@"\n"]) {
    NSString *l = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if ([l isEqualToString:@"{"]) ip = nil;
    else if ([l hasPrefix:@"ip_address="]) ip = [l substringFromIndex:11];
    else if ([l hasPrefix:@"hw_address="]) {
      NSString *hw = [l substringFromIndex:11];
      NSRange comma = [hw rangeOfString:@","];
      if (comma.location != NSNotFound) hw = [hw substringFromIndex:comma.location + 1];
      if ([normMac(hw) isEqualToString:want] && ip) found = ip;  // the file lists newest first
    } else if ([l isEqualToString:@"}"] && found) break;
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------
// Commands

static dispatch_queue_t gInputQ;

static void handle(NSDictionary *m) {
  id rid = m[@"id"];
  NSString *cmd = m[@"cmd"];
  if ([cmd isEqualToString:@"status"]) {
    NSMutableDictionary *cfg = loadConfig();
    NSMutableDictionary *r = [NSMutableDictionary dictionary];
    r[@"state"] = gState;
    r[@"installed"] = cfg[@"installed"] ?: @NO;
    r[@"provisioned"] = cfg[@"provisioned"] ?: @NO;
    r[@"os"] = cfg[@"os"] ?: @"";
    r[@"cpus"] = cfg[@"cpus"] ?: @4;
    r[@"memoryMB"] = cfg[@"memoryMB"] ?: @6144;
    r[@"w"] = @(gDisplay.width);
    r[@"h"] = @(gDisplay.height);
    r[@"network"] = netSetting(cfg);
    if (gVM && gNetNow) r[@"networkNow"] = gNetNow;
    if (gVM && gNetBoot) r[@"networkDevice"] = @(![gNetBoot isEqualToString:@"off"]);
    r[@"free"] = @(freeBytes(gDir));
    struct stat st;
    if (stat(P(@"disk.img").fileSystemRepresentation, &st) == 0) {
      r[@"diskBytes"] = @((uint64_t)st.st_blocks * 512);
      r[@"diskSize"] = @((uint64_t)st.st_size);
    }
    reply(rid, r);
  } else if ([cmd isEqualToString:@"latest"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      NSDictionary *r = fetchLatest(&err);
      r ? reply(rid, r) : fail(rid, err);
    });
  } else if ([cmd isEqualToString:@"install"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      if (!takeLock(&err)) { fail(rid, err); return; }
      NSDictionary *r = install(m, &err);
      r ? reply(rid, r) : fail(rid, err);
    });
  } else if ([cmd isEqualToString:@"markProvisioned"]) {
    NSMutableDictionary *cfg = loadConfig();
    cfg[@"provisioned"] = @YES;
    for (NSString *k in @[@"agentVersion", @"username"]) if (m[k]) cfg[k] = m[k];
    saveConfig(cfg);
    reply(rid, nil);
  } else if ([cmd isEqualToString:@"start"]) {
    startVM(m, rid);
  } else if ([cmd isEqualToString:@"stop"]) {
    stopVM(m, rid);
  } else if ([cmd isEqualToString:@"network"]) {
    // Saves the setting (unless `save: false`) and applies it now when the running VM has a network device.
    NSString *mode = m[@"mode"];
    if (![@[@"on", @"local", @"off"] containsObject:mode]) { fail(rid, @"network is on, local or off"); return; }
    if (![m[@"save"] isEqual:@NO]) {
      NSMutableDictionary *cfg = loadConfig();
      cfg[@"network"] = mode;
      saveConfig(cfg);
    }
    dispatch_async(gVMQ, ^{
      if (!gVM) { reply(rid, @{@"network": mode, @"applies": @"next boot"}); return; }
      if (gVM.networkDevices.count == 0) { reply(rid, @{@"network": mode, @"networkNow": gNetNow ?: @"off", @"applies": [mode isEqualToString:@"off"] ? @"now" : @"next boot"}); return; }
      NSString *err = nil;
      VZNetworkDeviceAttachment *att = netAttachment(mode, &err);
      if (!att && ![mode isEqualToString:@"off"]) { fail(rid, err ?: @"no attachment"); return; }
      gVM.networkDevices.firstObject.attachment = att;
      gNetNow = mode;
      event(@"network", @{@"networkNow": mode});
      reply(rid, @{@"network": mode, @"networkNow": mode, @"applies": @"now"});
    });
  } else if ([cmd isEqualToString:@"ip"]) {
    NSString *ip = guestIP();
    ip ? reply(rid, @{@"ip": ip}) : fail(rid, @"no address yet");
  } else if ([cmd isEqualToString:@"stream"]) {
    gMaxDim = num(m, @"maxDim", gMaxDim);
    gQuality = num(m, @"quality", gQuality);
    gFPS = MAX(1, MIN(30, num(m, @"fps", gFPS)));
    atomic_store(&gStreaming, [m[@"on"] boolValue]);
    // A new subscriber gets the current picture at once (a still screen sends no frames).
    if ([m[@"on"] boolValue]) dispatch_async(gFrameQ, ^{ sendFrameNow(); });
    reply(rid, nil);
  } else if ([cmd isEqualToString:@"idle"]) {
    // Until the screen stops changing: (after its first new frame, or `firstMs` without one) `quietMs` with no new
    // frame, or `timeoutMs`.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      double quiet = num(m, @"quietMs", 200), first = num(m, @"firstMs", 0), timeout = num(m, @"timeoutMs", 2500);
      double t0 = nowMs(), lastChange = t0;
      unsigned long long seen = atomic_load(&gFrames), start = seen;
      while (nowMs() - t0 < timeout) {
        unsigned long long n = atomic_load(&gFrames);
        double now = nowMs();
        if (n != seen) { seen = n; lastChange = now; }
        if ((seen != start || now - t0 >= first) && now - lastChange >= quiet) {
          reply(rid, @{@"idle": @YES, @"frames": @(seen - start), @"ms": @(round(now - t0))});
          return;
        }
        usleepMs(15);
      }
      reply(rid, @{@"idle": @NO, @"frames": @(atomic_load(&gFrames) - start), @"ms": @(round(nowMs() - t0))});
    });
  } else if ([cmd isEqualToString:@"switchIn"]) {
    // A switch (or other control) at the end of a settings row: scanning right from (x, y) along the row, until the
    // window ends (a run of saturated desktop pixels) or the screen does, the rightmost cluster of pixels that stand
    // out from the row's background and is control-sized (18-70 px wide). Replies its centre.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      CGImageRef img = screenshot(&err);
      if (!img) { fail(rid, err); return; }
      size_t W, H;
      NSData *d = rgba(img, &W, &H);
      CGImageRelease(img);
      long x0 = (long)num(m, @"x", 0), y = (long)num(m, @"y", 0);
      if (!d || y < 3 || y >= (long)H - 3 || x0 < 0 || x0 >= (long)W) { fail(rid, @"out of range"); return; }
      const uint8_t *px = d.bytes;
      // Per column: the band's mean luminance and max saturation.
      NSMutableData *lumD = [NSMutableData dataWithLength:W * sizeof(double)], *satD = [NSMutableData dataWithLength:W * sizeof(int)];
      double *lum = lumD.mutableBytes;
      int *sat = satD.mutableBytes;
      for (long x = 0; x < (long)W; x++) {
        double l = 0;
        int sm = 0;
        for (long yy = y - 3; yy <= y + 3; yy++) {
          const uint8_t *p = px + ((size_t)yy * W + (size_t)x) * 4;
          l += 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
          int mx = MAX(p[0], MAX(p[1], p[2])), mn = MIN(p[0], MIN(p[1], p[2]));
          sm = MAX(sm, mx - mn);
        }
        lum[x] = l / 7;
        sat[x] = sm;
      }
      // The desktop: a long run of colour (longer than any switch, which may be coloured when on).
      long end = (long)W;
      for (long x = x0; x < (long)W - 90; x++) {
        BOOL desk = YES;
        for (long k = 0; k < 90 && desk; k++) desk = sat[x + k] > 40;
        if (desk) { end = x; break; }
      }
      double bg = lum[MIN(end - 1, x0 + 24)];
      long best = -1, bestW = 0, start = -1;
      for (long x = x0; x <= end; x++) {
        BOOL odd = x < end && fabs(lum[x] - bg) > 5;
        if (odd && start < 0) start = x;
        if (!odd && start >= 0) {
          long w = x - start;
          // Gaps of a few pixels (the knob's edge) join a cluster: look ahead.
          BOOL more = NO;
          for (long k = 1; k <= 3 && x + k < end; k++) if (fabs(lum[x + k] - bg) > 5) more = YES;
          if (more) continue;
          // A run up to where the window ends is its margin, not a control.
          if (w >= 18 && w <= 70 && x < end - 2) { best = start; bestW = w; }
          start = -1;
        }
      }
      if (best < 0) { fail(rid, @"no control found in that row"); return; }
      // On: the switch's track is filled with the accent colour (saturated); off, it is grey.
      int satMax = 0;
      for (long x = best; x < best + bestW; x++) satMax = MAX(satMax, sat[x]);
      reply(rid, @{@"x": @(best + bestW / 2), @"w": @(bestW), @"end": @(end), @"on": @(satMax > 80)});
    });
  } else if ([cmd isEqualToString:@"screenshot"] || [cmd isEqualToString:@"ocr"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      double t0 = nowMs();
      CGImageRef img = screenshot(&err);
      if (!img) { fail(rid, err); return; }
      NSMutableDictionary *r = [NSMutableDictionary dictionaryWithDictionary:@{@"w": @(gDisplay.width), @"h": @(gDisplay.height)}];
      if ([cmd isEqualToString:@"ocr"]) {
        NSArray *words = ocr(img, &err);
        if (!words) { CGImageRelease(img); fail(rid, err); return; }
        r[@"items"] = words;
      } else {
        NSData *j = jpeg(img, num(m, @"maxDim", 0), num(m, @"quality", 0.8));
        NSString *path = str(m, @"path");
        if (path) { [j writeToFile:path atomically:YES]; r[@"path"] = path; }
        else r[@"jpeg"] = [j base64EncodedStringWithOptions:0];
        r[@"bytes"] = @(j.length);
      }
      r[@"ms"] = @(round(nowMs() - t0));
      CGImageRelease(img);
      reply(rid, r);
    });
  } else if ([cmd isEqualToString:@"pointer"] || [cmd isEqualToString:@"click"] || [cmd isEqualToString:@"drag"] ||
             [cmd isEqualToString:@"scroll"] || [cmd isEqualToString:@"key"] || [cmd isEqualToString:@"keyDown"] ||
             [cmd isEqualToString:@"keyUp"] || [cmd isEqualToString:@"text"]) {
    dispatch_async(gInputQ, ^{
      __block BOOL running = NO;
      dispatch_sync(gVMQ, ^{ running = gVM && gVM.state == VZVirtualMachineStateRunning; });
      if (!running) { fail(rid, @"the Mac isn't running"); return; }
      NSString *err = nil;
      double x = num(m, @"x", gMouse.x), y = num(m, @"y", gMouse.y);
      if ([cmd isEqualToString:@"pointer"]) {
        pointer(x, y, (NSInteger)num(m, @"buttons", 0));
      } else if ([cmd isEqualToString:@"click"]) {
        NSString *b = str(m, @"button") ?: @"left";
        click(x, y, [b isEqual:@"right"] ? 2 : 1, (int)num(m, @"count", 1));
      } else if ([cmd isEqualToString:@"drag"]) {
        drag(x, y, num(m, @"x2", x), num(m, @"y2", y), num(m, @"ms", 300));
      } else if ([cmd isEqualToString:@"scroll"]) {
        scroll(x, y, num(m, @"dx", 0), num(m, @"dy", 0));
      } else if ([cmd isEqualToString:@"key"]) {
        err = pressKey(str(m, @"name") ?: @"", [m[@"modifiers"] isKindOfClass:NSArray.class] ? m[@"modifiers"] : @[]);
      } else if ([cmd isEqualToString:@"keyDown"] || [cmd isEqualToString:@"keyUp"]) {
        unsigned short code = (unsigned short)num(m, @"code", 0xFFFF);
        if (code == 0xFFFF && !namedKey(str(m, @"name") ?: @"", &code)) err = @"unknown key";
        else key(code, [cmd isEqualToString:@"keyDown"]);
      } else {
        err = typeString(str(m, @"text") ?: @"", num(m, @"perKeyMs", 12));
      }
      err ? fail(rid, err) : reply(rid, nil);
    });
  } else if ([cmd isEqualToString:@"agent"]) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      NSDictionary *req = [m[@"request"] isKindOfClass:NSDictionary.class] ? m[@"request"] : @{};
      NSDictionary *r = agentCall(req, num(m, @"timeout", 15), &err);
      if (!r) { fail(rid, err); return; }
      if ([r[@"ok"] boolValue]) reply(rid, [r[@"result"] isKindOfClass:NSDictionary.class] ? r[@"result"] : @{});
      else fail(rid, r[@"error"] ?: @"guest agent error");
    });
  } else {
    fail(rid, [NSString stringWithFormat:@"unknown command %@", cmd]);
  }
}

static void quit(void) {
  atomic_store(&gStreaming, false);
  __block BOOL running = NO;
  dispatch_sync(gVMQ, ^{ running = gVM != nil; });
  if (!running) exit(0);
  // Ask the guest to shut down (it saves its state); force it off after 20 s.
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  gOnReply = ^{ dispatch_semaphore_signal(done); };
  stopVM(@{@"timeout": @20}, @"quit");
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
  exit(0);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: coool-vm <vm-dir> [--once '<json>']\n");
      return 2;
    }
    // No Dock icon, no menu bar, never active: the helper must not take focus from anything.
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    setvbuf(stdout, NULL, _IOFBF, 1 << 16);
    gDir = [NSString stringWithUTF8String:argv[1]];
    [[NSFileManager defaultManager] createDirectoryAtPath:gDir withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil];
    gOut = dispatch_queue_create("coool.vm.out", DISPATCH_QUEUE_SERIAL);
    // The VM lives on the main queue: VZVirtualMachineView requires it.
    gVMQ = dispatch_get_main_queue();
    gInputQ = dispatch_queue_create("coool.vm.input", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    gFrameQ = dispatch_queue_create("coool.vm.frames", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    gCI = [CIContext contextWithOptions:@{kCIContextCacheIntermediates: @NO}];
    gAgentLock = [NSLock new];
    gHTTPQ = [NSOperationQueue new];
    gHTTPQ.maxConcurrentOperationCount = 1;
    NSURLSessionConfiguration *hc = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    hc.timeoutIntervalForResource = 6 * 3600;
    gHTTP = [NSURLSession sessionWithConfiguration:hc delegate:nil delegateQueue:gHTTPQ];
    NSMutableDictionary *cfg = loadConfig();
    gDisplay = CGSizeMake([cfg[@"displayW"] ?: @1280 doubleValue], [cfg[@"displayH"] ?: @800 doubleValue]);
    if (argc >= 4 && strcmp(argv[2], "--once") == 0) {
      gPlain = YES;
      id m = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:argv[3] length:strlen(argv[3])] options:0 error:nil];
      if (![m isKindOfClass:NSDictionary.class]) { fprintf(stderr, "bad json\n"); return 2; }
      gOnReply = ^{ exit(0); };
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ handle(m); });
      [NSApp run];
      return 0;
    }
    sendJSON(@{@"event": @"ready", @"display": @YES, @"w": @(gDisplay.width), @"h": @(gDisplay.height), @"scale": @1});
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char *line = NULL;
      size_t cap = 0;
      ssize_t n;
      while ((n = getline(&line, &cap, stdin)) > 0) {
        @autoreleasepool {
          NSData *d = [NSData dataWithBytes:line length:(NSUInteger)n];
          id m = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
          if ([m isKindOfClass:NSDictionary.class]) handle(m);
        }
      }
      quit();
    });
    [NSApp run];
  }
}
