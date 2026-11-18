// coool-sim: coool's own iOS Simulator device helper (APP_SPEC "iOS Simulator panel").
//
// One process per booted simulator, started by the app (src/sim.rs). It talks to the simulator through
// the same private Apple frameworks Simulator.app uses, without opening Simulator.app or any window:
//
//   - frames:  CoreSimulator's display IO port (SimScreen callbacks) hands us the screen's IOSurface;
//              each presented frame is scaled and JPEG-encoded with CoreImage and streamed out.
//   - input:   the guest's `dtuhidd` HID service (Xcode 27+ drops the legacy Indigo path), reached over
//              XPC through the simulator's bootstrap namespace: touches, hardware buttons, keyboard.
//   - UI tree: AccessibilityPlatformTranslation requests sent through CoreSimulator to the guest's
//              accessibility bridge (the assistive-technology view of the frontmost app).
//
// Technique learned from facebook/idb (MIT; FBSimulatorControl / FBSimulatorAX), reimplemented here.
//
// Protocol: requests are JSON lines on stdin (`{"id":1,"cmd":"tap","x":100,"y":200}`); everything out
// is framed on stdout as [u32 big-endian length][u8 kind][payload], kind 'J' = a JSON reply or event,
// 'F' = one JPEG frame. stderr is for diagnostics only. The helper exits when stdin closes.

#import <Foundation/Foundation.h>
#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <xpc/xpc.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <stdatomic.h>

// ---------------------------------------------------------------------------------------------------
// Private API surface (selectors only; classes are looked up at runtime so nothing links privately).

@protocol CSServiceContext
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end
@protocol CSDeviceSet <NSObject>
- (NSDictionary *)devicesByUDID;
@end
@protocol CSDeviceType <NSObject>
- (CGSize)mainScreenSize;
- (float)mainScreenScale;
@end
@protocol CSDevice <NSObject>
- (id)io;
- (id)deviceType;
- (unsigned int)lookup:(NSString *)name error:(NSError **)error;
- (void)sendAccessibilityRequestAsync:(id)request completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(id))handler;
@end
@protocol CSIO <NSObject>
- (NSArray *)ioPorts;
@end
@protocol CSPort <NSObject>
- (id)descriptor;
@end
@protocol CSDisplayState <NSObject>
- (unsigned short)displayClass;
@end
@protocol CSDisplay <NSObject>
- (id)framebufferSurface;
- (id)ioSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid callbackQueue:(dispatch_queue_t)queue frameCallback:(void (^)(void))frame surfacesChangedCallback:(void (^)(id, id))surfaces propertiesChangedCallback:(void (^)(id))props;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)uuid;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(id))cb;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfaceChangeCallback:(void (^)(id))cb;
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *))cb;
@end
@protocol AXPRequest
+ (id)requestWithTranslation:(id)translation;
- (void)setRequestType:(unsigned long long)t;
- (void)setClientType:(unsigned long long)t;
- (void)setParameters:(NSDictionary *)p;
@end
@protocol AXPResponse <NSObject>
- (id)resultData;
- (unsigned long long)error;
@end
@protocol AXPObject <NSObject>
- (int)pid;
- (unsigned long long)objectID;
@end

// ---------------------------------------------------------------------------------------------------
// Output

static dispatch_queue_t gOut;

static void writeFrame(char kind, NSData *payload) {
  dispatch_sync(gOut, ^{
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

static void reply(id rid, NSDictionary *result) {
  NSMutableDictionary *m = [NSMutableDictionary dictionaryWithDictionary:@{@"id": rid ?: [NSNull null], @"ok": @YES}];
  if (result) m[@"result"] = result;
  sendJSON(m);
}

static void fail(id rid, NSString *message) {
  sendJSON(@{@"id": rid ?: [NSNull null], @"ok": @NO, @"error": message ?: @"error"});
}

static double nowMs(void) {
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  return (double)mach_absolute_time() * tb.numer / tb.denom / 1e6;
}

// ---------------------------------------------------------------------------------------------------
// Device

static id<CSDevice> gDevice;
static CGSize gPoints;  // screen size in points
static float gScale;

static BOOL loadFrameworks(NSString **err) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW | RTLD_GLOBAL)) {
    *err = @"CoreSimulator.framework not found (is Xcode installed?)";
    return NO;
  }
  // SimulatorKit vends the display descriptor's classes. Xcode 27 moved it to SharedFrameworks.
  NSString *dev = NSProcessInfo.processInfo.environment[@"COOOL_DEVELOPER_DIR"] ?: @"/Applications/Xcode.app/Contents/Developer";
  NSArray *kits = @[
    [dev stringByAppendingPathComponent:@"../SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
    [dev stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
  ];
  for (NSString *k in kits) {
    if (dlopen(k.stringByStandardizingPath.fileSystemRepresentation, RTLD_NOW | RTLD_GLOBAL)) break;
  }
  dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW | RTLD_GLOBAL);
  return YES;
}

static BOOL attach(NSString *udid, NSString **err) {
  Class ctxClass = NSClassFromString(@"SimServiceContext");
  if (!ctxClass) { *err = @"SimServiceContext unavailable"; return NO; }
  NSString *dev = NSProcessInfo.processInfo.environment[@"COOOL_DEVELOPER_DIR"] ?: @"/Applications/Xcode.app/Contents/Developer";
  NSError *e = nil;
  id ctx = [(Class<CSServiceContext>)ctxClass sharedServiceContextForDeveloperDir:dev error:&e];
  if (!ctx) { *err = [NSString stringWithFormat:@"service context: %@", e]; return NO; }
  id set = [ctx defaultDeviceSetWithError:&e];
  if (!set) { *err = [NSString stringWithFormat:@"device set: %@", e]; return NO; }
  NSUUID *u = [[NSUUID alloc] initWithUUIDString:udid];
  id device = u ? [set devicesByUDID][u] : nil;
  if (!device) { *err = @"no such simulator"; return NO; }
  gDevice = device;
  id type = [gDevice deviceType];
  CGSize px = [type mainScreenSize];
  gScale = [type mainScreenScale];
  if (gScale <= 0) gScale = 1;
  gPoints = CGSizeMake(px.width / gScale, px.height / gScale);
  return YES;
}

// ---------------------------------------------------------------------------------------------------
// Frames

static dispatch_queue_t gFrameQ;   // callbacks + encode
static id gSurface;                // IOSurfaceRef (bridged)
static CIContext *gCI;
static atomic_bool gStreaming;
static double gMaxDim = 900;       // longest side of streamed frames, in pixels
static double gQuality = 0.7;
static double gMinInterval = 1000.0 / 30;
static double gLastSent = 0, gLastFrameAt = 0;
static uint64_t gFrameCount = 0;   // presented frames seen (streaming or not)
#define RECENT 64
static double gRecent[RECENT];     // when the last RECENT frames came (a ring, on gFrameQ)
static BOOL gPending = NO;

static NSData *encodeJPEG(IOSurfaceRef surface, double maxDim, double quality) {
  if (!surface) return nil;
  CIImage *img = [CIImage imageWithIOSurface:surface];
  if (!img) return nil;
  CGRect r = img.extent;
  double longest = MAX(r.size.width, r.size.height);
  if (maxDim > 0 && longest > maxDim) {
    double s = maxDim / longest;
    img = [img imageByApplyingTransform:CGAffineTransformMakeScale(s, s) highQualityDownsample:YES];
  }
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  NSData *jpeg = [gCI JPEGRepresentationOfImage:img colorSpace:cs options:@{(id)kCGImageDestinationLossyCompressionQuality: @(quality)}];
  CGColorSpaceRelease(cs);
  return jpeg;
}

static void sendFrameNow(void) {
  gPending = NO;
  if (!atomic_load(&gStreaming) || !gSurface) return;
  NSData *jpeg = encodeJPEG((__bridge IOSurfaceRef)gSurface, gMaxDim, gQuality);
  gLastSent = nowMs();
  if (jpeg) writeFrame('F', jpeg);
}

// Coalesce presented frames to at most one encode per interval (runs on gFrameQ).
static void frameArrived(void) {
  gFrameCount++;
  gLastFrameAt = nowMs();
  gRecent[gFrameCount % RECENT] = gLastFrameAt;
  if (!atomic_load(&gStreaming) || gPending) return;
  double wait = gLastSent + gMinInterval - nowMs();
  gPending = YES;
  if (wait <= 0) {
    dispatch_async(gFrameQ, ^{ sendFrameNow(); });
  } else {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_MSEC)), gFrameQ, ^{ sendFrameNow(); });
  }
}

static BOOL attachDisplay(NSString **err) {
  // Never call the descriptor's synchronous getters (framebufferSurface, state): on Xcode 27 they are remote
  // proxies that can block indefinitely. Register frame callbacks on every screen port instead; the surface
  // whose size is the device's main screen is the one we stream (others are e.g. external displays).
  id io = [gDevice io];
  NSArray *ports = io ? [io ioPorts] : nil;
  size_t wantW = (size_t)llround(gPoints.width * gScale), wantH = (size_t)llround(gPoints.height * gScale);
  NSMutableSet *seen = [NSMutableSet set];
  int registered = 0;
  for (id port in ports) {
    id d = nil;
    @try { d = [port descriptor]; } @catch (__unused id e) { continue; }
    if (![d respondsToSelector:@selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)]) continue;
    NSValue *key = [NSValue valueWithNonretainedObject:d];
    if ([seen containsObject:key]) continue;
    [seen addObject:key];
    __block BOOL mine = NO;
    @try {
      [(id<CSDisplay>)d registerScreenCallbacksWithUUID:[NSUUID UUID] callbackQueue:gFrameQ
        frameCallback:^{ if (mine) frameArrived(); }
        surfacesChangedCallback:^(id a, __unused id b) {
          if (!a) return;
          IOSurfaceRef s = (__bridge IOSurfaceRef)a;
          size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s);
          if (getenv("COOOL_SIM_DEBUG")) fprintf(stderr, "surface %zux%zu (want %zux%zu)\n", w, h, wantW, wantH);
          if ((w == wantW && h == wantH) || (w == wantH && h == wantW) || (!gSurface && !mine)) {
            mine = YES;
            gSurface = a;
            frameArrived();
          }
        }
        propertiesChangedCallback:^(__unused id p) {}];
      registered++;
    } @catch (__unused id e) {}
  }
  if (!registered) { *err = @"no display port (is the simulator booted?)"; return NO; }
  return YES;
}

// ---------------------------------------------------------------------------------------------------
// HID over dtuhidd

static xpc_connection_t gHID;
static NSString *const kHIDService = @"com.apple.coredevice.feature.remote.hid.digitizer";
static dispatch_queue_t gHIDQ;  // serializes input commands
static dispatch_queue_t gXPCQ;  // the HID connection's own queue (replies land here, never on gHIDQ)
static int gTouchPhase = -1;  // -1 none, else contact active

typedef void *(*EndpointFromPort)(mach_port_t, uint64_t, uint64_t);
typedef void *(*ConnFromEndpoint)(xpc_object_t);
typedef void (*EnableSim2Host)(xpc_connection_t);

static xpc_object_t hidMessage(const char *type, xpc_object_t payload, BOOL barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", kHIDService.UTF8String);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
}

static xpc_object_t keyPayload(uint64_t usage, uint64_t state) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usageCode", usage);
  xpc_dictionary_set_uint64(p, "state", state);  // 1 down, 2 up
  return p;
}

static BOOL connectHIDOnce(NSString **err) {
  void *h = dlopen(NULL, RTLD_NOW);
  EndpointFromPort mkEndpoint = (EndpointFromPort)dlsym(h, "xpc_endpoint_create_mach_port_4sim");
  ConnFromEndpoint mkConn = (ConnFromEndpoint)dlsym(h, "xpc_connection_create_from_endpoint");
  EnableSim2Host sim2host = (EnableSim2Host)dlsym(h, "xpc_connection_enable_sim2host_4sim");
  if (!mkEndpoint || !mkConn || !sim2host) { *err = @"XPC simulator symbols unavailable"; return NO; }
  NSError *e = nil;
  mach_port_t port = [gDevice lookup:kHIDService error:&e];
  if (port == MACH_PORT_NULL) { *err = [NSString stringWithFormat:@"HID service lookup: %@", e.localizedDescription]; return NO; }
  xpc_object_t endpoint = (__bridge_transfer xpc_object_t)mkEndpoint(port, 0, 0);
  if (!endpoint) { *err = @"HID endpoint"; return NO; }
  xpc_connection_t c = (__bridge_transfer xpc_connection_t)mkConn(endpoint);
  if (!c) { *err = @"HID connection"; return NO; }
  sim2host(c);
  xpc_connection_set_target_queue(c, gXPCQ);
  xpc_connection_set_event_handler(c, ^(xpc_object_t ev) {
    // A dead connection is dropped so the next input reconnects (dtuhidd restarts on demand).
    if (ev == XPC_ERROR_CONNECTION_INVALID) dispatch_async(gHIDQ, ^{ if (gHID == c) gHID = nil; });
  });
  xpc_connection_resume(c);
  // Liveness: a barrier with usage 0 ("no event") is answered by a live dtuhidd and seen by nobody.
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block BOOL alive = NO;
  xpc_connection_send_message_with_reply(c, hidMessage("IndigoKeyboardButtonEvent", keyPayload(0, 2), YES), gXPCQ, ^(xpc_object_t r) {
    alive = xpc_get_type(r) != XPC_TYPE_ERROR;
    dispatch_semaphore_signal(sem);
  });
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 4 * NSEC_PER_SEC)) != 0 || !alive) {
    xpc_connection_cancel(c);
    *err = @"dtuhidd did not answer";
    return NO;
  }
  gHID = c;
  return YES;
}

static BOOL connectHID(NSString **err) {
  if (gHID) return YES;
  // dtuhidd is demand-launched and can be throttled right after boot: retry with a backoff.
  for (int i = 0; i < 5; i++) {
    if (connectHIDOnce(err)) return YES;
    if (getenv("COOOL_SIM_DEBUG")) fprintf(stderr, "hid attempt %d: %s\n", i, [*err UTF8String]);
    [NSThread sleepForTimeInterval:i == 0 ? 0.5 : 3];
  }
  return NO;
}

static void hidSend(const char *type, xpc_object_t payload) {
  xpc_connection_send_message(gHID, hidMessage(type, payload, NO));
}

// Waits until XPC has handed off everything sent so far.
static void hidBarrier(void) {
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  xpc_connection_send_barrier(gHID, ^{ dispatch_semaphore_signal(sem); });
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
}

// phase: 0 start, 1 move, 2 end. x, y in points.
static void touch(int phase, double x, double y) {
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", MAX(0, MIN(1, x / gPoints.width)));
  xpc_dictionary_set_double(pt, "y", MAX(0, MIN(1, y / gPoints.height)));
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", pt);
  xpc_dictionary_set_uint64(p, "eventType", (uint64_t)phase);
  xpc_dictionary_set_uint64(p, "edge", 0);
  xpc_dictionary_set_uint64(p, "target", 0);
  hidSend("IndigoDigitizerEvent", p);
  gTouchPhase = phase == 2 ? -1 : phase;
}

static void button(uint64_t page, uint64_t code, uint64_t state) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usagePage", page);
  xpc_dictionary_set_uint64(p, "usageCode", code);
  xpc_dictionary_set_uint64(p, "state", state);
  hidSend("IndigoButtonEvent", p);
}

static void key(uint64_t usage, uint64_t state) { hidSend("IndigoKeyboardButtonEvent", keyPayload(usage, state)); }

static void sleepMs(double ms) { if (ms > 0) usleep((useconds_t)(ms * 1000)); }

// US keyboard: character -> (HID usage, shift).
static BOOL usageFor(unichar c, uint64_t *usage, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') { *usage = 0x04 + (c - 'a'); return YES; }
  if (c >= 'A' && c <= 'Z') { *usage = 0x04 + (c - 'A'); *shift = YES; return YES; }
  if (c >= '1' && c <= '9') { *usage = 0x1E + (c - '1'); return YES; }
  if (c == '0') { *usage = 0x27; return YES; }
  const char *plain = "\n\t -=[]\\;'`,./";
  const uint64_t plainU[] = {0x28, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
  for (int i = 0; plain[i]; i++) if (c == (unichar)plain[i]) { *usage = plainU[i]; return YES; }
  const char *shifted = "!@#$%^&*()_+{}|:\"~<>?";
  const uint64_t shiftedU[] = {0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38};
  for (int i = 0; shifted[i]; i++) if (c == (unichar)shifted[i]) { *usage = shiftedU[i]; *shift = YES; return YES; }
  if (c == '\r') { *usage = 0x28; return YES; }
  return NO;
}

static NSDictionary *buttonUsage(NSString *name) {
  NSDictionary *map = @{
    @"home": @[@0x0C, @0x40], @"lock": @[@0x0C, @0x30], @"side": @[@0x0C, @0x30], @"siri": @[@0x0C, @0xCF],
    @"volumeUp": @[@0x0C, @0xE9], @"volumeDown": @[@0x0C, @0xEA],
  };
  NSArray *u = map[name];
  return u ? @{@"page": u[0], @"code": u[1]} : nil;
}

static NSDictionary *keyUsage(NSString *name) {
  NSDictionary *map = @{
    @"return": @0x28, @"enter": @0x28, @"escape": @0x29, @"backspace": @0x2A, @"delete": @0x2A, @"tab": @0x2B, @"space": @0x2C,
    @"right": @0x4F, @"left": @0x50, @"down": @0x51, @"up": @0x52, @"forwardDelete": @0x4C, @"home": @0x4A, @"end": @0x4D,
    @"pageUp": @0x4B, @"pageDown": @0x4E,
  };
  NSNumber *u = map[name];
  if (u) return @{@"usage": u};
  // A single character names its key ("a" with command = select all).
  uint64_t usage; BOOL shift;
  if (name.length == 1 && usageFor([name.lowercaseString characterAtIndex:0], &usage, &shift)) return @{@"usage": @(usage)};
  return nil;
}

// ---------------------------------------------------------------------------------------------------
// Accessibility

static dispatch_queue_t gAXQ;
static dispatch_queue_t gAXReplyQ;

static id axSend(unsigned long long type, id translation, NSDictionary *params, double timeoutS) {
  Class reqClass = NSClassFromString(@"AXPTranslatorRequest");
  if (!reqClass) return nil;
  id req = [(Class<AXPRequest>)reqClass requestWithTranslation:translation];
  [req setRequestType:type];
  [req setClientType:0];
  [req setParameters:params];
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block id response = nil;
  [gDevice sendAccessibilityRequestAsync:req completionQueue:gAXReplyQ completionHandler:^(id r) {
    response = r;
    dispatch_semaphore_signal(sem);
  }];
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeoutS * NSEC_PER_SEC))) != 0) return nil;
  return response;
}

static NSString *roleName(NSNumber *n, BOOL remote) {
  if (remote) return @"group";
  static NSArray *names;
  if (!names) names = @[@"unknown", @"application", @"button", @"checkbox", @"element", @"group", @"heading", @"image", @"link",
                        @"radio", @"scroll", @"scrollbar", @"tabs", @"slider", @"text", @"textfield", @"web", @"textarea",
                        @"splitter", @"popup", @"sheet", @"grid"];
  NSInteger i = n.integerValue;
  return (i >= 0 && i < (NSInteger)names.count) ? names[i] : [NSString stringWithFormat:@"role%ld", (long)i];
}

static id jsonSafe(id v) {
  if (!v || v == [NSNull null]) return nil;
  if ([v isKindOfClass:NSString.class]) return [(NSString *)v length] ? v : nil;
  if ([v isKindOfClass:NSNumber.class]) return v;
  if ([v isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)v string];
  return [v description];
}

// Sends one request without waiting; `done` runs on gAXReplyQ with the reply (nil if none).
static void axSendAsync(unsigned long long type, id translation, NSDictionary *params, void (^done)(id reply)) {
  Class reqClass = NSClassFromString(@"AXPTranslatorRequest");
  if (!reqClass) { done(nil); return; }
  id req = [(Class<AXPRequest>)reqClass requestWithTranslation:translation];
  [req setRequestType:type];
  [req setClientType:0];
  [req setParameters:params];
  [gDevice sendAccessibilityRequestAsync:req completionQueue:gAXReplyQ completionHandler:^(id r) { done(r); }];
}

// Walks the frontmost app's tree breadth-first, one multiple-attribute request per element. The requests of a
// level are all in flight at once (`serial`: one at a time, as before), so a read costs about one round trip per
// level instead of one per element. `visibleOnly`: an element wholly off screen is listed, its subtree isn't
// walked. `maxDepth` (>= 0) stops the walk at that depth.
static NSDictionary *describe(NSUInteger maxNodes, double timeoutS, BOOL visibleOnly, NSInteger maxDepth, BOOL serial, NSString **err) {
  double t0 = nowMs();
  Class objClass = NSClassFromString(@"AXPTranslationObject");
  if (!objClass) { *err = @"AccessibilityPlatformTranslation unavailable"; return nil; }
  id resp = axSend(4 /* frontmostApplication */, [objClass new], @{@"displayId": @0}, 3);
  id root = [resp resultData];
  if (!root || ![root respondsToSelector:@selector(objectID)]) { *err = @"no frontmost application (accessibility not ready yet?)"; return nil; }
  NSArray *attrs = @[@21 /*frame*/, @45 /*role*/, @66 /*isRemote*/, @33 /*label*/, @53 /*value*/, @25 /*identifier*/,
                     @27 /*isEnabled*/, @30 /*isSelected*/, @28 /*isFocused*/, @42 /*placeholder*/, @8 /*children*/];
  CGRect screen = CGRectMake(0, 0, gPoints.width, gPoints.height);
  NSMutableArray *out = [NSMutableArray array];
  NSArray *level = @[@[root, @(-1), @0]];
  int requests = 1, levels = 0;
  BOOL late = NO;
  while (level.count && out.count < maxNodes && !late) {
    levels++;
    NSUInteger n = MIN(level.count, maxNodes - out.count);
    NSMutableArray *answers = [NSMutableArray arrayWithCapacity:n];
    for (NSUInteger i = 0; i < n; i++) [answers addObject:[NSNull null]];
    NSUInteger width = serial ? 1 : n;
    for (NSUInteger from = 0; from < n && !late; from += width) {
      double left = timeoutS - (nowMs() - t0) / 1000;
      if (left <= 0) { late = YES; break; }
      dispatch_group_t group = dispatch_group_create();
      for (NSUInteger i = from; i < MIN(n, from + width); i++) {
        dispatch_group_enter(group);
        axSendAsync(5 /* multipleAttribute */, level[i][0], @{@"attributes": attrs}, ^(id r) {
          id d = [r resultData];  // gAXReplyQ is serial: `answers` needs no lock
          if ([d isKindOfClass:NSDictionary.class]) answers[i] = d;
          dispatch_group_leave(group);
        });
        requests++;
      }
      if (dispatch_group_wait(group, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MIN(left, 2.5) * NSEC_PER_SEC))) != 0) late = YES;
    }
    // Answers arriving after a timeout are ignored: copy what came, on the reply queue.
    __block NSArray *got;
    dispatch_sync(gAXReplyQ, ^{ got = [answers copy]; });
    NSMutableArray *next = [NSMutableArray array];
    for (NSUInteger i = 0; i < n; i++) {
      NSDictionary *a = [got[i] isKindOfClass:NSDictionary.class] ? got[i] : nil;
      if (!a) continue;
      NSArray *item = level[i];
      NSMutableDictionary *node = [NSMutableDictionary dictionary];
      NSInteger index = (NSInteger)out.count;
      NSInteger depth = [item[2] integerValue];
      node[@"parent"] = item[1];
      node[@"depth"] = item[2];
      NSValue *fv = a[@21];
      CGRect f = [fv isKindOfClass:NSValue.class] ? fv.rectValue : CGRectZero;
      node[@"frame"] = @[@(round(f.origin.x * 10) / 10), @(round(f.origin.y * 10) / 10), @(round(f.size.width * 10) / 10), @(round(f.size.height * 10) / 10)];
      node[@"role"] = roleName(a[@45], [a[@66] boolValue]);
      id v;
      if ((v = jsonSafe(a[@33]))) node[@"label"] = v;
      if ((v = jsonSafe(a[@53]))) node[@"value"] = v;
      if ((v = jsonSafe(a[@25]))) node[@"identifier"] = v;
      if ((v = jsonSafe(a[@42]))) node[@"placeholder"] = v;
      if (a[@27] && ![a[@27] boolValue]) node[@"disabled"] = @YES;
      if ([a[@30] boolValue]) node[@"selected"] = @YES;
      if ([a[@28] boolValue]) node[@"focused"] = @YES;
      [out addObject:node];
      if (maxDepth >= 0 && depth >= maxDepth) continue;
      if (visibleOnly && depth > 0 && f.size.width > 0 && f.size.height > 0 && !CGRectIntersectsRect(f, screen)) continue;
      NSArray *kids = [a[@8] isKindOfClass:NSArray.class] ? a[@8] : @[];
      for (id k in kids) [next addObject:@[k, @(index), @(depth + 1)]];
    }
    level = next;
  }
  return @{@"nodes": out, @"requests": @(requests), @"levels": @(levels), @"ms": @(round(nowMs() - t0)),
           @"screen": @{@"w": @(gPoints.width), @"h": @(gPoints.height), @"scale": @(gScale)}};
}

// ---------------------------------------------------------------------------------------------------
// Commands

static double num(NSDictionary *m, NSString *k, double d) {
  id v = m[k];
  return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : d;
}

static void handle(NSDictionary *m) {
  id rid = m[@"id"];
  NSString *cmd = m[@"cmd"];
  if ([cmd isEqualToString:@"info"]) {
    reply(rid, @{@"w": @(gPoints.width), @"h": @(gPoints.height), @"scale": @(gScale), @"frames": @(gFrameCount)});
  } else if ([cmd isEqualToString:@"stream"]) {
    dispatch_async(gFrameQ, ^{
      gMaxDim = num(m, @"maxDim", gMaxDim);
      gQuality = num(m, @"quality", gQuality);
      double fps = num(m, @"fps", 30);
      gMinInterval = 1000.0 / MAX(1, MIN(60, fps));
      atomic_store(&gStreaming, [m[@"on"] boolValue]);
      if (atomic_load(&gStreaming)) { gPending = NO; frameArrived(); gFrameCount--; }
      reply(rid, nil);
    });
  } else if ([cmd isEqualToString:@"snapshot"]) {
    dispatch_async(gFrameQ, ^{
      double t0 = nowMs();
      NSData *jpeg = encodeJPEG((__bridge IOSurfaceRef)gSurface, num(m, @"maxDim", 600), num(m, @"quality", 0.6));
      if (!jpeg) return fail(rid, @"no frame yet");
      reply(rid, @{@"jpeg": [jpeg base64EncodedStringWithOptions:0], @"ms": @(round(nowMs() - t0))});
    });
  } else if ([cmd isEqualToString:@"idle"]) {
    // Resolves once no frame has been presented for `quietMs` (or after `timeoutMs`). `firstMs`: first wait up to
    // that long for the screen to start changing (an app may take a few hundred ms to react to a tap, and quiet
    // before then means nothing yet). `changed`: whether any frame came. `quietFrames`: up to that many frames in the
    // last `quietMs` still count as quiet (a caret blinking, a spinner, a cell updating: not an animation running).
    double quiet = num(m, @"quietMs", 300), timeout = num(m, @"timeoutMs", 5000), first = num(m, @"firstMs", 0);
    int allowed = (int)num(m, @"quietFrames", 0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      double t0 = nowMs();
      for (;;) {
        __block double last;
        __block int recent = 0;
        __block double since = t0;  // the first frame after t0 (the change started)
        double t = nowMs();
        dispatch_sync(gFrameQ, ^{
          last = gLastFrameAt;
          double earliest = 0;
          for (int i = 0; i < RECENT; i++) {
            if (gRecent[i] > MAX(t - quiet, t0)) recent++;
            if (gRecent[i] > t0 && (earliest == 0 || gRecent[i] < earliest)) earliest = gRecent[i];
          }
          if (earliest > 0) since = earliest;
        });
        BOOL changed = last > t0;
        if (!changed && t - t0 < first && t - t0 < timeout) { sleepMs(10); continue; }
        if (t - MAX(last, t0) >= quiet || (allowed > 0 && t - since >= quiet && recent <= allowed))
          return reply(rid, @{@"idle": @YES, @"changed": @(changed), @"ms": @(round(t - t0))});
        if (t - t0 >= timeout) return reply(rid, @{@"idle": @NO, @"ms": @(round(t - t0))});
        sleepMs(MIN(25, quiet / 4));
      }
    });
  } else if ([cmd isEqualToString:@"describe"]) {
    dispatch_async(gAXQ, ^{
      NSString *err = nil;
      NSDictionary *d = describe((NSUInteger)num(m, @"max", 400), num(m, @"timeoutS", 6), [m[@"visibleOnly"] boolValue],
                                 (NSInteger)num(m, @"maxDepth", -1), [m[@"serial"] boolValue], &err);
      d ? reply(rid, d) : fail(rid, err);
    });
  } else if ([cmd isEqualToString:@"tap"] || [cmd isEqualToString:@"touch"] || [cmd isEqualToString:@"swipe"] ||
             [cmd isEqualToString:@"button"] || [cmd isEqualToString:@"key"] || [cmd isEqualToString:@"text"]) {
    dispatch_async(gHIDQ, ^{
      NSString *err = nil;
      if (!connectHID(&err)) return fail(rid, err);
      double t0 = nowMs();
      if ([cmd isEqualToString:@"tap"]) {
        double x = num(m, @"x", 0), y = num(m, @"y", 0);
        touch(0, x, y);
        hidBarrier();
        sleepMs(num(m, @"holdMs", 40));
        touch(2, x, y);
      } else if ([cmd isEqualToString:@"touch"]) {
        NSString *ph = m[@"phase"];
        int p = [ph isEqualToString:@"down"] ? 0 : [ph isEqualToString:@"move"] ? 1 : 2;
        if (p == 1 && gTouchPhase < 0) p = 0;
        if (p == 2 && gTouchPhase < 0) return reply(rid, nil);
        touch(p, num(m, @"x", 0), num(m, @"y", 0));
      } else if ([cmd isEqualToString:@"swipe"]) {
        double x1 = num(m, @"x1", 0), y1 = num(m, @"y1", 0), x2 = num(m, @"x2", 0), y2 = num(m, @"y2", 0);
        double ms = num(m, @"ms", 250);
        int steps = MAX(2, (int)(ms / 16));
        touch(0, x1, y1);
        hidBarrier();
        for (int i = 1; i <= steps; i++) {
          double t = (double)i / steps;
          sleepMs(ms / steps);
          touch(1, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
        }
        sleepMs(num(m, @"holdEndMs", 0));
        touch(2, x2, y2);
      } else if ([cmd isEqualToString:@"button"]) {
        NSDictionary *u = buttonUsage(m[@"name"]);
        if (!u) return fail(rid, @"unknown button");
        button([u[@"page"] unsignedLongLongValue], [u[@"code"] unsignedLongLongValue], 1);
        hidBarrier();
        sleepMs(num(m, @"holdMs", 80));
        button([u[@"page"] unsignedLongLongValue], [u[@"code"] unsignedLongLongValue], 2);
      } else if ([cmd isEqualToString:@"key"]) {
        NSDictionary *u = m[@"name"] ? keyUsage(m[@"name"]) : @{@"usage": m[@"usage"] ?: @0};
        if (!u || ![u[@"usage"] unsignedLongLongValue]) return fail(rid, @"unknown key");
        NSArray *mods = [m[@"modifiers"] isKindOfClass:NSArray.class] ? m[@"modifiers"] : @[];
        NSDictionary *modU = @{@"shift": @0xE1, @"control": @0xE0, @"option": @0xE2, @"command": @0xE3};
        for (NSString *mod in mods) if (modU[mod]) key([modU[mod] unsignedLongLongValue], 1);
        key([u[@"usage"] unsignedLongLongValue], 1);
        key([u[@"usage"] unsignedLongLongValue], 2);
        for (NSString *mod in mods.reverseObjectEnumerator) if (modU[mod]) key([modU[mod] unsignedLongLongValue], 2);
      } else {
        NSString *text = m[@"text"] ?: @"";
        NSMutableString *skipped = [NSMutableString string];
        for (NSUInteger i = 0; i < text.length; i++) {
          uint64_t u; BOOL shift;
          unichar c = [text characterAtIndex:i];
          if (!usageFor(c, &u, &shift)) { [skipped appendFormat:@"%C", c]; continue; }
          if (shift) key(0xE1, 1);
          key(u, 1);
          key(u, 2);
          if (shift) key(0xE1, 2);
          // dtuhidd delivers in order, but iOS's key repeat/coalescing drops back-to-back repeats of one key.
          if (i + 1 < text.length && [text characterAtIndex:i + 1] == c) { hidBarrier(); sleepMs(30); }
        }
        if (skipped.length) {
          hidBarrier();
          return reply(rid, @{@"skipped": skipped, @"ms": @(round(nowMs() - t0))});
        }
      }
      hidBarrier();
      reply(rid, @{@"ms": @(round(nowMs() - t0))});
    });
  } else {
    fail(rid, [NSString stringWithFormat:@"unknown command %@", cmd]);
  }
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: coool-sim <udid>\n");
      return 2;
    }
    setvbuf(stdout, NULL, _IOFBF, 1 << 16);
    gOut = dispatch_queue_create("coool.sim.out", DISPATCH_QUEUE_SERIAL);
    gFrameQ = dispatch_queue_create("coool.sim.frames", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    gHIDQ = dispatch_queue_create("coool.sim.hid", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    gXPCQ = dispatch_queue_create("coool.sim.xpc", DISPATCH_QUEUE_SERIAL);
    gAXQ = dispatch_queue_create("coool.sim.ax", DISPATCH_QUEUE_SERIAL);
    gAXReplyQ = dispatch_queue_create("coool.sim.ax.reply", DISPATCH_QUEUE_SERIAL);
    gCI = [CIContext contextWithOptions:@{kCIContextCacheIntermediates: @NO}];
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    // Setup runs off the main thread: CoreSimulator remote proxies deliver some replies on the main queue.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *err = nil;
      if (!loadFrameworks(&err) || !attach(udid, &err)) {
        sendJSON(@{@"event": @"fatal", @"error": err ?: @"?"});
        exit(1);
      }
      BOOL display = attachDisplay(&err);
      sendJSON(@{@"event": @"ready", @"w": @(gPoints.width), @"h": @(gPoints.height), @"scale": @(gScale),
                 @"display": @(display), @"displayError": display ? @"" : (err ?: @"")});
      // Connect HID in the background so the first tap is warm.
      dispatch_async(gHIDQ, ^{ NSString *e = nil; if (!connectHID(&e)) sendJSON(@{@"event": @"hid", @"error": e ?: @"?"}); });
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
        exit(0);
      });
    });
    dispatch_main();
  }
}
