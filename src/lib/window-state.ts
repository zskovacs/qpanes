import type { Window } from '@tauri-apps/api/window';

export type WindowState = { maximized: boolean; scaleFactor: number };
type WindowSource = Pick<Window, 'isMaximized' | 'scaleFactor' | 'onResized' | 'onScaleChanged'>;

// Chrome only observes native state. The OS/WebView own content scaling and size.
export function observeWindow(
  source: WindowSource,
  update: (state: WindowState) => void,
  onerror: (error: unknown) => void,
) {
  let disposed = false;
  let revision = 0;
  const listeners: (() => void)[] = [];
  const fail = (error: unknown) => { if (!disposed) onerror(error); };
  async function refresh() {
    if (disposed) return;
    const request = ++revision;
    try {
      const [maximized, scaleFactor] = await Promise.all([source.isMaximized(), source.scaleFactor()]);
      if (!disposed && request === revision) update({ maximized, scaleFactor });
    } catch (error) { if (request === revision) fail(error); }
  }
  function release(unlisten: () => void) {
    try { void Promise.resolve(unlisten()).catch(fail); }
    catch (error) { fail(error); }
  }
  function register(pending: Promise<() => void>) {
    void pending.then((unlisten) => {
      if (disposed) release(unlisten);
      else listeners.push(unlisten);
    }).catch(fail);
  }
  register(source.onResized(refresh));
  register(source.onScaleChanged(refresh));
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const unlisten of listeners.splice(0)) release(unlisten);
    },
  };
}
