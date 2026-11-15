// The system's own Liquid Glass (NSGlassEffectView, macOS 26) behind the page: the page leaves an opening where a pane is, and the glass under it is
// what shows — the material itself, with the system's rim, lensing and light, and the desktop behind the window coming through.
//   prepare(handle) -> boolean     the window lets through what is behind it where nothing is drawn; false where there is no Liquid Glass
//   pane(handle, id, left, top, width, bottom, radius)   places a pane of glass (kept to the window's height); a width of 0 takes it away
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static char kPanes;

static NSView *ViewOf(napi_env env, napi_value value) {
  void *data = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || data == nullptr || length < sizeof(void *)) return nil;
  return (__bridge NSView *)(*(void **)data);
}
static double NumberOf(napi_env env, napi_value value) { double number = 0; napi_get_value_double(env, value, &number); return number; }

static napi_value Prepare(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool ready = false;
  if (@available(macOS 26.0, *)) {
    NSWindow *window = argc < 1 ? nil : ViewOf(env, args[0]).window;
    if (window != nil) { window.opaque = NO; window.backgroundColor = NSColor.clearColor; [window invalidateShadow]; ready = true; }
  }
  napi_value result; napi_get_boolean(env, ready, &result); return result;
}

static napi_value Pane(napi_env env, napi_callback_info info) {
  size_t argc = 7; napi_value args[7]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_value nothing; napi_get_undefined(env, &nothing);
  if (argc < 7) return nothing;
  if (@available(macOS 26.0, *)) {
    NSView *content = ViewOf(env, args[0]).window.contentView;
    if (content == nil) return nothing;
    char name[64] = {0}; size_t copied = 0; napi_get_value_string_utf8(env, args[1], name, sizeof(name), &copied);
    NSString *identifier = [NSString stringWithUTF8String:name];
    double left = NumberOf(env, args[2]), top = NumberOf(env, args[3]), width = NumberOf(env, args[4]), bottom = NumberOf(env, args[5]), radius = NumberOf(env, args[6]);
    NSMutableDictionary<NSString *, NSGlassEffectView *> *panes = objc_getAssociatedObject(content, &kPanes);
    if (panes == nil) { panes = [NSMutableDictionary dictionary]; objc_setAssociatedObject(content, &kPanes, panes, OBJC_ASSOCIATION_RETAIN_NONATOMIC); }
    NSGlassEffectView *glass = panes[identifier];
    if (width <= 0) { [glass removeFromSuperview]; [panes removeObjectForKey:identifier]; return nothing; }
    CGFloat height = MAX(content.bounds.size.height - top - bottom, 0);
    NSRect frame = NSMakeRect(left, content.isFlipped ? top : bottom, width, height);
    if (glass == nil) {
      glass = [[NSGlassEffectView alloc] initWithFrame:frame];
      glass.style = NSGlassEffectViewStyleRegular;
      glass.autoresizingMask = NSViewHeightSizable;
      [content addSubview:glass positioned:NSWindowBelow relativeTo:nil];
      panes[identifier] = glass;
    } else glass.frame = frame;
    glass.cornerRadius = radius;
  }
  return nothing;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value prepare, pane;
  napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, Prepare, nullptr, &prepare); napi_set_named_property(env, exports, "prepare", prepare);
  napi_create_function(env, "pane", NAPI_AUTO_LENGTH, Pane, nullptr, &pane); napi_set_named_property(env, exports, "pane", pane);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
