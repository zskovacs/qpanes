// Test-only X11/XTest driver for the real Qpanes GTK window. No application IPC.
// cc tests/native/x11-window.c -o /tmp/qpanes-x11 $(pkg-config --cflags --libs x11 xtst)
// Selects only a top-level window with the exact supplied title.
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static Display *display;
static Window root;
static Window find(Window parent, const char *title) {
  char *name = NULL;
  if (XFetchName(display, parent, &name) && name) {
    int match = !strcmp(name, title);
    XFree(name);
    if (match) return parent;
  }
  Window ignored, *children = NULL;
  unsigned count = 0;
  if (!XQueryTree(display, parent, &ignored, &ignored, &children, &count)) return 0;
  Window found = 0;
  for (unsigned i = 0; i < count && !found; i++) found = find(children[i], title);
  if (children) XFree(children);
  return found;
}
static void motion(int x, int y) {
  XTestFakeMotionEvent(display, -1, x, y, CurrentTime); XFlush(display); usleep(80000);
}
static void button(int down) {
  XTestFakeButtonEvent(display, 1, down, CurrentTime); XFlush(display); usleep(80000);
}
int main(int argc, char **argv) {
  if (argc < 3 || !(display = XOpenDisplay(NULL))) return 2;
  root = DefaultRootWindow(display);
  Window window = find(root, argv[1]);
  if (!window) { fprintf(stderr, "Window not found: %s\n", argv[1]); return 3; }
  const char *mode = argv[2];
  if (!strcmp(mode, "move") && argc == 5) XMoveWindow(display, window, atoi(argv[3]), atoi(argv[4]));
  else if (!strcmp(mode, "resize") && argc == 5) XResizeWindow(display, window, atoi(argv[3]), atoi(argv[4]));
  else if (!strcmp(mode, "focus")) { XMapRaised(display, window); XSetInputFocus(display, window, RevertToParent, CurrentTime); }
  else if (!strcmp(mode, "click") && argc == 6) {
    motion(atoi(argv[3]), atoi(argv[4]));
    for (int i = 0; i < atoi(argv[5]); i++) { button(True); button(False); }
  } else if (!strcmp(mode, "drag") && argc == 7) {
    int x = atoi(argv[3]), y = atoi(argv[4]), dx = atoi(argv[5]), dy = atoi(argv[6]);
    motion(x, y); button(True);
    for (int i = 1; i <= 10; i++) motion(x + dx * i / 10, y + dy * i / 10);
    button(False);
  } else if (!strcmp(mode, "key") && argc >= 4) {
    for (int i = 3; i < argc; i++) XTestFakeKeyEvent(display, XKeysymToKeycode(display, XStringToKeysym(argv[i])), True, CurrentTime);
    for (int i = argc - 1; i >= 3; i--) XTestFakeKeyEvent(display, XKeysymToKeycode(display, XStringToKeysym(argv[i])), False, CurrentTime);
  } else if (strcmp(mode, "info")) return 4;
  XSync(display, False);
  usleep(200000);
  XWindowAttributes a; XGetWindowAttributes(display, window, &a);
  int x, y; Window child;
  XTranslateCoordinates(display, window, root, 0, 0, &x, &y, &child);
  printf("{\"id\":%lu,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"mapState\":%d}\n", window, x, y, a.width, a.height, a.map_state);
  XCloseDisplay(display);
  return 0;
}
