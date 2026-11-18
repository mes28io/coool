// coool-vm-agent: coool's agent inside the sandboxed Mac (APP_SPEC "Mac panel (sandbox VM)").
//
// Installed by coool into the guest during its first-run setup (src/device/vm.rs) as an app bundle
// (~/Library/Application Support/coool/coool agent.app) started by a LaunchAgent in the guest's logged-in session.
// It listens on virtio-vsock port 7333 (only the host can reach it; nothing listens on the network) and answers
// JSON lines: the frontmost app's accessibility tree, launching apps, the pasteboard, running a command.
// Clicks and keys don't come through here: the host sends them as the VM's own USB hardware, so they need no
// permission. Reading other apps' accessibility trees needs the guest's Accessibility permission, which coool's
// setup grants once by driving System Settings in the guest.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <sys/socket.h>
#import <sys/vsock.h>
#import <mach/mach_time.h>

#define AGENT_VERSION @"4"
static const unsigned kPort = 7333;

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
// Accessibility tree

static id attr(AXUIElementRef el, CFStringRef name) {
  CFTypeRef v = NULL;
  if (AXUIElementCopyAttributeValue(el, name, &v) != kAXErrorSuccess || !v) return nil;
  return CFBridgingRelease(v);
}

static NSString *textOf(id v) {
  if ([v isKindOfClass:NSString.class]) {
    NSString *s = [v stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (s.length > 2000) s = [s substringToIndex:2000];
    return s.length ? s : nil;
  }
  if ([v isKindOfClass:NSNumber.class]) return [v stringValue];
  if ([v isKindOfClass:NSAttributedString.class]) return textOf([v string]);
  return nil;
}

static NSString *roleName(NSString *role, NSString *subrole) {
  static NSDictionary *map;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    map = @{@"AXButton": @"button", @"AXTextField": @"textfield", @"AXTextArea": @"textarea", @"AXStaticText": @"text",
            @"AXCheckBox": @"checkbox", @"AXRadioButton": @"radio", @"AXPopUpButton": @"popup", @"AXMenuButton": @"menubutton",
            @"AXComboBox": @"combobox", @"AXSlider": @"slider", @"AXImage": @"image", @"AXLink": @"link", @"AXRow": @"row",
            @"AXCell": @"cell", @"AXTable": @"table", @"AXOutline": @"outline", @"AXList": @"list", @"AXTabGroup": @"tabs",
            @"AXWindow": @"window", @"AXSheet": @"sheet", @"AXMenuBar": @"menubar", @"AXMenuBarItem": @"menu",
            @"AXMenu": @"menulist", @"AXMenuItem": @"menuitem", @"AXToolbar": @"toolbar", @"AXGroup": @"group",
            @"AXScrollArea": @"scroll", @"AXWebArea": @"webarea", @"AXHeading": @"heading", @"AXSearchField": @"searchfield",
            @"AXIncrementor": @"stepper", @"AXDisclosureTriangle": @"disclosure", @"AXSplitGroup": @"split",
            @"AXApplication": @"application", @"AXSwitch": @"switch", @"AXToggle": @"toggle", @"AXColorWell": @"colorwell",
            @"AXDateField": @"datefield", @"AXProgressIndicator": @"progress", @"AXValueIndicator": @"indicator",
            @"AXScrollBar": @"scrollbar", @"AXBrowser": @"browser", @"AXColumn": @"column", @"AXDialog": @"dialog"};
  });
  if ([subrole isEqual:@"AXSearchField"]) return @"searchfield";
  if ([subrole isEqual:@"AXSwitch"]) return @"switch";
  if ([subrole isEqual:@"AXSecureTextField"]) return @"securefield";
  if ([subrole isEqual:@"AXCloseButton"]) return @"closebutton";
  NSString *r = map[role];
  if (r) return r;
  if ([role hasPrefix:@"AX"]) role = [role substringFromIndex:2];
  return role.lowercaseString ?: @"element";
}

// Containers worth a line only when they say something (otherwise their children are listed under their parent).
static NSSet *quietRoles(void) {
  static NSSet *s;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [NSSet setWithArray:@[@"AXGroup", @"AXScrollArea", @"AXSplitGroup", @"AXLayoutArea", @"AXLayoutItem",
                                                     @"AXUnknown", @"AXSplitter", @"AXScrollBar", @"AXValueIndicator", @"AXMatte",
                                                     @"AXRuler", @"AXGrowArea", @"AXColumn"]]; });
  return s;
}

static NSArray *kAttrs;

/// Breadth-first, like coool-sim: nodes[i].parent < i. Capped at `maxNodes`.
static NSDictionary *tree(NSDictionary *m) {
  double t0 = nowMs();
  if (!AXIsProcessTrusted()) return @{@"error": @"no accessibility permission"};
  int maxNodes = (int)num(m, @"maxNodes", 700);
  int maxDepth = (int)num(m, @"maxDepth", 40);
  BOOL menus = m[@"menus"] ? [m[@"menus"] boolValue] : YES;
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSString *bundle = str(m, @"bundleId");
  if (bundle) front = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle].firstObject ?: front;
  NSRect screen = NSScreen.mainScreen.frame;
  NSMutableArray *out = [NSMutableArray array];
  if (!front) return @{@"nodes": out, @"screen": @{@"w": @(screen.size.width), @"h": @(screen.size.height)}};
  AXUIElementRef app = AXUIElementCreateApplication(front.processIdentifier);
  AXUIElementSetMessagingTimeout(app, 1.5);
  [out addObject:@{@"role": @"application", @"label": front.localizedName ?: @"", @"identifier": front.bundleIdentifier ?: @"",
                   @"frame": @[@0, @0, @(screen.size.width), @(screen.size.height)], @"depth": @0, @"parent": @(-1)}];
  // Roots: the app's windows (focused first), then its menu bar.
  NSMutableArray *roots = [NSMutableArray array];
  id focusedWin = attr(app, kAXFocusedWindowAttribute);
  if (focusedWin) [roots addObject:focusedWin];
  for (id w in attr(app, kAXWindowsAttribute) ?: @[]) if (![w isEqual:focusedWin]) [roots addObject:w];
  if (menus) { id mb = attr(app, kAXMenuBarAttribute); if (mb) [roots addObject:mb]; }
  NSMutableArray *level = [NSMutableArray array];
  for (id r in roots) [level addObject:@[r, @0, @1]];
  NSSet *quiet = quietRoles();
  int visited = 0;
  while (level.count && (int)out.count < maxNodes) {
    NSMutableArray *next = [NSMutableArray array];
    for (NSArray *item in level) {
      if ((int)out.count >= maxNodes || visited > maxNodes * 6) break;
      visited++;
      AXUIElementRef el = (__bridge AXUIElementRef)item[0];
      int parent = [item[1] intValue], depth = [item[2] intValue];
      CFArrayRef vals = NULL;
      if (AXUIElementCopyMultipleAttributeValues(el, (__bridge CFArrayRef)kAttrs, 0, &vals) != kAXErrorSuccess || !vals) continue;
      NSArray *a = CFBridgingRelease(vals);
      id (^get)(NSUInteger) = ^id(NSUInteger i) {
        id v = i < a.count ? a[i] : nil;
        if (!v || [v isKindOfClass:NSNull.class]) return nil;
        if (CFGetTypeID((__bridge CFTypeRef)v) == AXValueGetTypeID() && AXValueGetType((__bridge AXValueRef)v) == kAXValueTypeAXError) return nil;
        return v;
      };
      NSString *role = get(0), *subrole = get(1);
      if (![role isKindOfClass:NSString.class]) continue;
      // Noise for an agent: a ruler's markers, scroll bars (scroll with the wheel instead).
      if ([role isEqual:@"AXRulerMarker"] || [role isEqual:@"AXScrollBar"] || [role isEqual:@"AXRuler"]) continue;
      NSString *title = textOf(get(2)), *desc = textOf(get(3)), *value = textOf(get(4)), *ident = textOf(get(5));
      NSString *help = textOf(get(6)), *placeholder = textOf(get(11));
      CGPoint pos = CGPointZero;
      CGSize size = CGSizeZero;
      id pv = get(7), sv = get(8);
      if (pv) AXValueGetValue((__bridge AXValueRef)pv, kAXValueTypeCGPoint, &pos);
      if (sv) AXValueGetValue((__bridge AXValueRef)sv, kAXValueTypeCGSize, &size);
      id enabled = get(9), focused = get(10), selected = get(12);
      NSArray *kids = [get(13) isKindOfClass:NSArray.class] ? get(13) : @[];
      NSString *label = title ?: desc ?: help;
      if ([role isEqual:@"AXStaticText"] && !label) { label = value; value = nil; }
      if ([role isEqual:@"AXCheckBox"] || [role isEqual:@"AXRadioButton"]) {
        if ([get(4) isKindOfClass:NSNumber.class]) value = [get(4) intValue] ? @"on" : @"off";
      }
      BOOL isMenuBarItem = [role isEqual:@"AXMenuBarItem"];
      BOOL emit = !([quiet containsObject:role] && !label && !ident) && !([role isEqual:@"AXMenuBar"]);
      int me = parent;
      if (emit) {
        NSMutableDictionary *node = [NSMutableDictionary dictionary];
        node[@"role"] = roleName(role, subrole);
        if (label) node[@"label"] = label;
        if (value && ![value isEqual:label]) node[@"value"] = value;
        if (ident && ![ident hasPrefix:@"_NS:"]) node[@"identifier"] = ident;
        if (placeholder) node[@"placeholder"] = placeholder;
        node[@"frame"] = @[@(round(pos.x)), @(round(pos.y)), @(round(size.width)), @(round(size.height))];
        node[@"depth"] = @(depth);
        node[@"parent"] = @(parent);
        if ([enabled isKindOfClass:NSNumber.class] && ![enabled boolValue]) node[@"disabled"] = @YES;
        if ([focused isKindOfClass:NSNumber.class] && [focused boolValue]) node[@"focused"] = @YES;
        if ([selected isKindOfClass:NSNumber.class] && [selected boolValue]) node[@"selected"] = @YES;
        me = (int)out.count;
        [out addObject:node];
      }
      if (depth >= maxDepth) continue;
      // A closed menu's items aren't on screen: list the menu bar's titles, not every menu item.
      if (isMenuBarItem && !([selected isKindOfClass:NSNumber.class] && [selected boolValue])) continue;
      int kd = emit ? depth + 1 : depth;
      for (id k in kids) [next addObject:@[k, @(me), @(kd)]];
    }
    level = next;
  }
  CFRelease(app);
  return @{@"nodes": out, @"ms": @(round(nowMs() - t0)), @"truncated": @((int)out.count >= maxNodes),
           @"screen": @{@"w": @(screen.size.width), @"h": @(screen.size.height), @"scale": @(NSScreen.mainScreen.backingScaleFactor)}};
}

/// The focused element's text (or the element at a point).
static NSDictionary *element(NSDictionary *m) {
  if (!AXIsProcessTrusted()) return @{@"error": @"no accessibility permission"};
  AXUIElementRef sys = AXUIElementCreateSystemWide();
  AXUIElementRef el = NULL;
  if (m[@"x"]) {
    AXUIElementCopyElementAtPosition(sys, (float)num(m, @"x", 0), (float)num(m, @"y", 0), &el);
  } else {
    CFTypeRef v = NULL;
    AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute, &v);
    el = (AXUIElementRef)v;
  }
  CFRelease(sys);
  if (!el) return @{@"error": @"no element"};
  NSMutableDictionary *r = [NSMutableDictionary dictionary];
  r[@"role"] = attr(el, kAXRoleAttribute) ?: @"";
  NSString *v = textOf(attr(el, kAXValueAttribute));
  if (v) r[@"value"] = v;
  NSString *t = textOf(attr(el, kAXTitleAttribute)) ?: textOf(attr(el, kAXDescriptionAttribute));
  if (t) r[@"label"] = t;
  if (m[@"setValue"]) {
    AXError e = AXUIElementSetAttributeValue(el, kAXValueAttribute, (__bridge CFTypeRef)m[@"setValue"]);
    r[@"set"] = @(e == kAXErrorSuccess);
  }
  CFRelease(el);
  return r;
}

// ---------------------------------------------------------------------------------------------------
// Apps

static NSURL *appURL(NSString *name) {
  NSWorkspace *ws = NSWorkspace.sharedWorkspace;
  NSURL *u = [ws URLForApplicationWithBundleIdentifier:name];
  if (u) return u;
  if ([name hasPrefix:@"/"]) return [NSURL fileURLWithPath:name];
  NSString *file = [name hasSuffix:@".app"] ? name : [name stringByAppendingString:@".app"];
  for (NSString *dir in @[@"/Applications", @"/System/Applications", @"/System/Applications/Utilities", @"/Applications/Utilities",
                          [NSHomeDirectory() stringByAppendingPathComponent:@"Applications"], @"/System/Library/CoreServices",
                          @"/Volumes/My Shared Files"]) {
    NSString *p = [dir stringByAppendingPathComponent:file];
    if ([NSFileManager.defaultManager fileExistsAtPath:p]) return [NSURL fileURLWithPath:p];
    // Case-insensitive match.
    for (NSString *f in [NSFileManager.defaultManager contentsOfDirectoryAtPath:dir error:nil] ?: @[])
      if ([f caseInsensitiveCompare:file] == NSOrderedSame) return [NSURL fileURLWithPath:[dir stringByAppendingPathComponent:f]];
  }
  return nil;
}

static NSDictionary *launch(NSDictionary *m, NSString **err) {
  NSString *name = str(m, @"app") ?: @"";
  NSURL *u = appURL(name);
  if (!u) { *err = [NSString stringWithFormat:@"no app called %@ in the Mac", name]; return nil; }
  __block NSRunningApplication *app = nil;
  __block NSError *e = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  NSWorkspaceOpenConfiguration *cfg = [NSWorkspaceOpenConfiguration configuration];
  cfg.activates = YES;
  if ([m[@"new"] boolValue]) cfg.createsNewApplicationInstance = YES;
  [NSWorkspace.sharedWorkspace openApplicationAtURL:u configuration:cfg completionHandler:^(NSRunningApplication *a, NSError *er) {
    app = a;
    e = er;
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));
  if (!app) { *err = e.localizedDescription ?: @"couldn't open the app"; return nil; }
  // Until it's frontmost with a window (or 8 s).
  double t0 = nowMs();
  while (nowMs() - t0 < 8000) {
    if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == app.processIdentifier) {
      if (!AXIsProcessTrusted()) break;
      AXUIElementRef ax = AXUIElementCreateApplication(app.processIdentifier);
      NSArray *wins = attr(ax, kAXWindowsAttribute);
      CFRelease(ax);
      if (wins.count) break;
    }
    if (nowMs() - t0 > 1500) [app activateWithOptions:NSApplicationActivateAllWindows];
    // Spin the run loop (this runs on the main thread): NSWorkspace learns the frontmost app from it.
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  return @{@"app": app.localizedName ?: name, @"bundleId": app.bundleIdentifier ?: @"", @"pid": @(app.processIdentifier),
           @"ms": @(round(nowMs() - t0))};
}

static NSDictionary *run(NSDictionary *m, NSString **err) {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
  t.arguments = @[@"-c", str(m, @"sh") ?: @"true"];
  NSPipe *outp = [NSPipe pipe];
  t.standardOutput = outp;
  t.standardError = outp;
  t.standardInput = [NSFileHandle fileHandleWithNullDevice];
  NSError *e = nil;
  if (![t launchAndReturnError:&e]) { *err = e.localizedDescription; return nil; }
  NSMutableData *data = [NSMutableData data];
  double timeout = num(m, @"timeout", 60);
  double t0 = nowMs();
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSData *d;
    while ((d = [outp.fileHandleForReading availableData]).length) {
      @synchronized(data) { if (data.length < (4 << 20)) [data appendData:d]; }
    }
    dispatch_semaphore_signal(done);
  });
  BOOL timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC))) != 0;
  if (timedOut) [t terminate];
  [t waitUntilExit];
  NSString *s;
  @synchronized(data) { s = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @""; }
  return @{@"status": @(t.terminationStatus), @"output": s, @"timedOut": @(timedOut), @"ms": @(round(nowMs() - t0))};
}

// ---------------------------------------------------------------------------------------------------

static NSDictionary *handle(NSDictionary *m, NSString **err) {
  NSString *cmd = str(m, @"cmd") ?: @"";
  if ([cmd isEqual:@"ping"]) {
    NSOperatingSystemVersion v = NSProcessInfo.processInfo.operatingSystemVersion;
    NSRunningApplication *f = NSWorkspace.sharedWorkspace.frontmostApplication;
    return @{@"version": AGENT_VERSION, @"trusted": [NSNumber numberWithBool:AXIsProcessTrusted() != 0], @"user": NSUserName(),
             @"os": [NSString stringWithFormat:@"%ld.%ld.%ld", (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion],
             @"frontmost": f.localizedName ?: @"", @"frontmostBundle": f.bundleIdentifier ?: @""};
  }
  if ([cmd isEqual:@"prompt"]) {
    NSDictionary *o = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
    return @{@"trusted": [NSNumber numberWithBool:AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)o) != 0]};
  }
  if ([cmd isEqual:@"tree"]) {
    NSDictionary *t = tree(m);
    if (t[@"error"]) { *err = t[@"error"]; return nil; }
    return t;
  }
  if ([cmd isEqual:@"element"]) {
    NSDictionary *r = element(m);
    if (r[@"error"]) { *err = r[@"error"]; return nil; }
    return r;
  }
  if ([cmd isEqual:@"launch"]) return launch(m, err);
  if ([cmd isEqual:@"open"]) {
    NSString *target = str(m, @"url") ?: @"";
    NSURL *u = [target hasPrefix:@"/"] ? [NSURL fileURLWithPath:target] : [NSURL URLWithString:target];
    if (!u || ![NSWorkspace.sharedWorkspace openURL:u]) { *err = @"couldn't open it"; return nil; }
    return @{};
  }
  if ([cmd isEqual:@"apps"]) {
    NSMutableArray *a = [NSMutableArray array];
    for (NSRunningApplication *r in NSWorkspace.sharedWorkspace.runningApplications)
      if (r.activationPolicy == NSApplicationActivationPolicyRegular)
        [a addObject:@{@"name": r.localizedName ?: @"", @"bundleId": r.bundleIdentifier ?: @"", @"active": @(r.active)}];
    return @{@"apps": a};
  }
  if ([cmd isEqual:@"quitApp"]) {
    for (NSRunningApplication *r in NSWorkspace.sharedWorkspace.runningApplications)
      if ([r.localizedName isEqual:m[@"app"]] || [r.bundleIdentifier isEqual:m[@"app"]]) [r terminate];
    return @{};
  }
  if ([cmd isEqual:@"setPasteboard"]) {
    NSPasteboard *pb = NSPasteboard.generalPasteboard;
    [pb clearContents];
    [pb setString:str(m, @"text") ?: @"" forType:NSPasteboardTypeString];
    return @{};
  }
  if ([cmd isEqual:@"getPasteboard"]) return @{@"text": [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @""};
  if ([cmd isEqual:@"run"]) return run(m, err);
  *err = [NSString stringWithFormat:@"unknown command %@", cmd];
  return nil;
}

static void serve(int fd) {
  FILE *in = fdopen(fd, "r");
  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&line, &cap, in)) > 0) {
    @autoreleasepool {
      id m = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:n] options:0 error:nil];
      NSMutableDictionary *r = [NSMutableDictionary dictionary];
      if (![m isKindOfClass:NSDictionary.class]) {
        r[@"ok"] = @NO;
        r[@"error"] = @"bad request";
      } else {
        __block NSString *err = nil;
        __block NSDictionary *res = nil;
        // AppKit calls (NSWorkspace, NSPasteboard) are happiest on the main thread.
        dispatch_sync(dispatch_get_main_queue(), ^{ @autoreleasepool { res = handle(m, &err); } });
        if ([m[@"cmd"] isEqual:@"run"] || [m[@"cmd"] isEqual:@"launch"]) {}
        r[@"ok"] = @(res != nil);
        if (res) r[@"result"] = res;
        else r[@"error"] = err ?: @"error";
      }
      NSMutableData *d = [[NSJSONSerialization dataWithJSONObject:r options:0 error:nil] mutableCopy];
      [d appendBytes:"\n" length:1];
      const uint8_t *p = d.bytes;
      size_t left = d.length;
      while (left > 0) {
        ssize_t w = write(fd, p, left);
        if (w <= 0) break;
        p += w;
        left -= w;
      }
    }
  }
  free(line);
  fclose(in);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    kAttrs = @[(id)kAXRoleAttribute, (id)kAXSubroleAttribute, (id)kAXTitleAttribute, (id)kAXDescriptionAttribute,
               (id)kAXValueAttribute, (id)kAXIdentifierAttribute, (id)kAXHelpAttribute, (id)kAXPositionAttribute,
               (id)kAXSizeAttribute, (id)kAXEnabledAttribute, (id)kAXFocusedAttribute, (id)kAXPlaceholderValueAttribute,
               (id)kAXSelectedAttribute, (id)kAXChildrenAttribute];
    if (argc > 1 && strcmp(argv[1], "--prompt") == 0) {
      NSDictionary *o = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
      printf("%d\n", AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)o));
      return 0;
    }
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s < 0) { perror("socket"); return 1; }
    struct sockaddr_vm addr = {0};
    addr.svm_len = sizeof addr;
    addr.svm_family = AF_VSOCK;
    addr.svm_cid = VMADDR_CID_ANY;
    addr.svm_port = kPort;
    if (bind(s, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(s, 8) != 0) { perror("bind"); return 1; }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      for (;;) {
        int c = accept(s, NULL, NULL);
        if (c < 0) continue;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ serve(c); });
      }
    });
    [NSApp run];
  }
  return 0;
}
