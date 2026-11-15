// The system's Liquid Glass (NSGlassEffectView, macOS 26) under the page's openings. The window is made non-opaque and the glass lies under its
// content, so each sheet shows what is behind the window there: the desktop, or — where the page's own copy is kept in a window fastened right
// behind this one (web/src/ui/mirror.ts) — the copy of what the page's surface floats over.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <node_api.h>

static char kPanes;
static char kHost;
static char kBackdrop;

// The content layer's color while there is no page to paint it (the app starting, the page loading again), with the sidebar's pane left open.
@interface HHBackdropView : NSView
@property(nonatomic) CGFloat openLeft, openInset, openWidth, openRadius;
@end
@implementation HHBackdropView
- (void)shape {
  CAShapeLayer *mask = (CAShapeLayer *)self.layer.mask;
  if (mask == nil) {
    mask = [CAShapeLayer layer];
    mask.fillRule = kCAFillRuleEvenOdd;
    self.layer.mask = mask;
  }
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathAddRect(path, NULL, self.bounds);
  CGFloat height = self.bounds.size.height - self.openInset * 2;
  if (self.openWidth > 0 && height > 0) {
    CGFloat radius = MIN(self.openRadius, MIN(self.openWidth, height) / 2);
    CGPathAddRoundedRect(path, NULL, CGRectMake(self.openLeft, self.openInset, self.openWidth, height), radius, radius);
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  mask.frame = self.bounds;
  mask.path = path;
  [CATransaction commit];
  CGPathRelease(path);
}
- (void)setFrameSize:(NSSize)size {
  [super setFrameSize:size];
  [self shape];
}
@end

static NSView *ViewOf(napi_env env, napi_value value) {
  void *data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || data == nullptr || length < sizeof(void *)) return nil;
  return (__bridge NSView *)(*(void **)data);
}

static double NumberOf(napi_env env, napi_value value) {
  double number = 0;
  napi_get_value_double(env, value, &number);
  return number;
}

static napi_value Truth(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

// Where the glass is laid: one view under the window's content, in the window's frame. (All web content of a window is drawn by one layer at
// the bottom of the content view, and the content view sorts its own subviews: glass among them would end up over the page.)
static NSView *HostOf(NSView *content) {
  NSView *host = objc_getAssociatedObject(content, &kHost);
  if (host != nil && host.superview != nil) return host;
  NSView *frame = content.superview;
  if (frame == nil) return content;
  host = [[NSView alloc] initWithFrame:content.frame];
  host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [frame addSubview:host positioned:NSWindowBelow relativeTo:content];
  objc_setAssociatedObject(content, &kHost, host, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return host;
}

// prepare(window): lets the desktop through the window. False where the system has no Liquid Glass.
static napi_value Prepare(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool ready = false;
  if (@available(macOS 26.0, *)) {
    NSWindow *window = argc < 1 ? nil : ViewOf(env, args[0]).window;
    if (window != nil) {
      window.opaque = NO;
      window.backgroundColor = NSColor.clearColor;
      [window invalidateShadow];
      ready = true;
    }
  }
  return Truth(env, ready);
}

// behind(window, other): fastens the other window right behind this one, where it moves, hides and closes with it and is nobody's to press,
// focus or list. It is what the glass of this window then shows.
static napi_value Behind(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool fastened = false;
  if (@available(macOS 26.0, *)) {
    NSWindow *window = argc < 2 ? nil : ViewOf(env, args[0]).window, *other = argc < 2 ? nil : ViewOf(env, args[1]).window;
    if (window != nil && other != nil && window != other) {
      other.ignoresMouseEvents = YES;
      other.hasShadow = NO;
      other.excludedFromWindowsMenu = YES;
      other.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle | NSWindowCollectionBehaviorFullScreenAuxiliary;
      [other setAccessibilityElement:NO];
      [other setAccessibilityHidden:YES];
      other.contentView.accessibilityHidden = YES;
      // Said again after the window changes space. Full screen puts a window's children in front of it: there the other window stands on its
      // own, one level under, where nothing else of that space can come between.
      if (other.parentWindow != nil) [other.parentWindow removeChildWindow:other];
      if ((window.styleMask & NSWindowStyleMaskFullScreen) != 0) {
        other.level = NSNormalWindowLevel - 1;
        [other setFrame:window.frame display:YES];
        [other orderWindow:NSWindowBelow relativeTo:window.windowNumber];
      } else {
        other.level = NSNormalWindowLevel;
        [window addChildWindow:other ordered:NSWindowBelow];
      }
      fastened = true;
    }
  }
  return Truth(env, fastened);
}

// pane(window, id, left, top, width, height, radius, clear, alpha, anchor, order): a sheet of glass, in points from the content's top left. A width
// of 0 takes it away. anchor is the autoresizing mask that holds it to its nearer edges while the window is resized, until the page says where
// it is; order is its place among the sheets, lowest first.
static napi_value Pane(napi_env env, napi_callback_info info) {
  size_t argc = 11;
  napi_value args[11];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_value nothing;
  napi_get_undefined(env, &nothing);
  if (argc < 11) return nothing;
  if (@available(macOS 26.0, *)) {
    NSView *content = ViewOf(env, args[0]).window.contentView;
    if (content == nil) return nothing;
    char name[64] = {0};
    size_t copied = 0;
    napi_get_value_string_utf8(env, args[1], name, sizeof(name), &copied);
    NSString *identifier = [NSString stringWithUTF8String:name];
    double left = NumberOf(env, args[2]), top = NumberOf(env, args[3]), width = NumberOf(env, args[4]), height = NumberOf(env, args[5]);
    double radius = NumberOf(env, args[6]), clear = NumberOf(env, args[7]), alpha = NumberOf(env, args[8]), anchor = NumberOf(env, args[9]), order = NumberOf(env, args[10]);
    NSMutableDictionary<NSString *, NSGlassEffectView *> *panes = objc_getAssociatedObject(content, &kPanes);
    if (panes == nil) {
      panes = [NSMutableDictionary dictionary];
      objc_setAssociatedObject(content, &kPanes, panes, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    NSGlassEffectView *glass = panes[identifier];
    if (width <= 0 || height <= 0) {
      [glass removeFromSuperview];
      [panes removeObjectForKey:identifier];
      return nothing;
    }
    NSView *host = HostOf(content);
    NSRect frame = NSMakeRect(left, host.isFlipped ? top : host.bounds.size.height - top - height, width, height);
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    if (glass == nil) {
      glass = [[NSGlassEffectView alloc] initWithFrame:frame];
      panes[identifier] = glass;
    } else if (!NSEqualRects(glass.frame, frame)) glass.frame = frame;
    if (glass.superview != host) {
      [glass removeFromSuperview];
      [host addSubview:glass positioned:(host == content ? NSWindowBelow : NSWindowAbove) relativeTo:nil];
    }
    NSGlassEffectViewStyle style = clear > 0 ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
    if (glass.style != style) glass.style = style;
    if (glass.cornerRadius != radius) glass.cornerRadius = radius;
    if (glass.alphaValue != alpha) glass.alphaValue = alpha;
    NSAutoresizingMaskOptions mask = (NSAutoresizingMaskOptions)(NSUInteger)anchor;
    if (!host.isFlipped) mask = (mask & ~(NSViewMinYMargin | NSViewMaxYMargin)) | ((mask & NSViewMinYMargin) ? NSViewMaxYMargin : 0) | ((mask & NSViewMaxYMargin) ? NSViewMinYMargin : 0);
    if (glass.autoresizingMask != mask) glass.autoresizingMask = mask;
    if (glass.layer != nil && glass.layer.zPosition != order) glass.layer.zPosition = order;
    [CATransaction commit];
  }
  return nothing;
}

// backdrop(window, red, green, blue, left, inset, width, radius): the content layer's color under the page, open where the sidebar's pane is
// (held to the window's left, `inset` from its top and bottom). backdrop(window) lets it fade away: the page paints its own.
static napi_value Backdrop(napi_env env, napi_callback_info info) {
  size_t argc = 8;
  napi_value args[8];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_value nothing;
  napi_get_undefined(env, &nothing);
  if (argc < 1) return nothing;
  if (@available(macOS 26.0, *)) {
    NSView *content = ViewOf(env, args[0]).window.contentView;
    if (content == nil) return nothing;
    HHBackdropView *backdrop = objc_getAssociatedObject(content, &kBackdrop);
    if (argc < 8) {
      if (backdrop == nil) return nothing;
      objc_setAssociatedObject(content, &kBackdrop, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) { context.duration = 0.22; backdrop.animator.alphaValue = 0; } completionHandler:^{ [backdrop removeFromSuperview]; }];
      return nothing;
    }
    NSView *host = HostOf(content);
    if (host == content) return nothing;
    if (backdrop == nil) {
      backdrop = [[HHBackdropView alloc] initWithFrame:host.bounds];
      backdrop.wantsLayer = YES;
      backdrop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      [host addSubview:backdrop positioned:NSWindowBelow relativeTo:nil];
      objc_setAssociatedObject(content, &kBackdrop, backdrop, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    backdrop.layer.backgroundColor = [NSColor colorWithSRGBRed:NumberOf(env, args[1]) green:NumberOf(env, args[2]) blue:NumberOf(env, args[3]) alpha:1].CGColor;
    backdrop.openLeft = NumberOf(env, args[4]);
    backdrop.openInset = NumberOf(env, args[5]);
    backdrop.openWidth = NumberOf(env, args[6]);
    backdrop.openRadius = NumberOf(env, args[7]);
    backdrop.alphaValue = 1;
    [backdrop shape];
  }
  return nothing;
}

static void Describe(NSView *view, int depth, NSMutableString *out) {
  [out appendFormat:@"%*s%@ %@%@%@\n", depth * 2, "", NSStringFromClass(view.class), NSStringFromRect(view.frame), view.isFlipped ? @" flipped" : @"", view.isHidden ? @" hidden" : @""];
  if (depth < 4) for (NSView *child in view.subviews) Describe(child, depth + 1, out);
}

// describe(window): the window's views, lowest first, for looking at how they are stacked.
static napi_value DescribeWindow(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSMutableString *out = [NSMutableString string];
  NSView *content = argc < 1 ? nil : ViewOf(env, args[0]).window.contentView;
  if (content != nil) Describe(content.superview ?: content, 0, out);
  napi_value result;
  napi_create_string_utf8(env, out.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  const struct { const char *name; napi_callback call; } entries[] = { {"prepare", Prepare}, {"behind", Behind}, {"pane", Pane}, {"backdrop", Backdrop}, {"describe", DescribeWindow} };
  for (const auto &entry : entries) {
    napi_value function;
    napi_create_function(env, entry.name, NAPI_AUTO_LENGTH, entry.call, nullptr, &function);
    napi_set_named_property(env, exports, entry.name, function);
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
