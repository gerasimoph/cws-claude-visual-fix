// Runs in the page's main world (manifest "world": "MAIN"): only there are
// React's internal fiber properties visible. For the element a `bf:probe`
// event is dispatched on (by the isolated content script), it reports the nearest React components and, in
// dev builds that record it, the source file where the element is written.
// Read-only; talks to the content script through DOM events with string data.
(() => {
  'use strict';
  if (window.__bfProbeInstalled) return;
  window.__bfProbeInstalled = true;

  // Framework primitives that say nothing about where the code lives.
  const SKIP = new Set([
    'View', 'Text', 'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'ScrollView',
    'ScrollViewBase', 'Image', 'ImageBackground', 'TextInput', 'FlatList', 'SectionList', 'VirtualizedList', 'CellRenderer',
    'SafeAreaView', 'KeyboardAvoidingView', 'Modal', 'Portal', 'Fragment', 'Suspense', 'StrictMode', 'Link', 'Slot',
    'ThemedText', 'ThemedView', 'Router', 'Route', 'Routes', 'Outlet', 'ErrorBoundary', 'InnerLayoutRouter', 'OuterLayoutRouter',
  ]);
  const NOISE = /^(Animated|With|Connect|Memo|ForwardRef)\(|Provider$|Context$|Consumer$|^Styled|^_|^Anonymous$/;

  function fiberOf(el) {
    for (const key in el) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return el[key];
    }
    return null;
  }

  function nameOf(type) {
    if (!type || typeof type === 'string') return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'object') return type.displayName || nameOf(type.render) || nameOf(type.type) || null;
    return null;
  }

  // React ≤18 dev: _debugSource. React 19 dev: _debugStack (an Error).
  function sourceOf(fiber) {
    const s = fiber._debugSource;
    if (s?.fileName && !/node_modules/.test(s.fileName)) return { file: s.fileName, line: s.lineNumber || null };
    const stack = typeof fiber._debugStack === 'string' ? fiber._debugStack : fiber._debugStack?.stack;
    if (typeof stack === 'string') {
      for (const line of stack.split('\n').slice(1)) {
        const m = /\(?((?:https?|file|webpack|webpack-internal):\/\/[^\s)]+?):(\d+):\d+\)?\s*$/.exec(line);
        if (m && !/node_modules|react-dom|react-native-web|\/chunks?\/|\.bundle\b|jsx-dev-runtime/.test(m[1])) {
          return { file: m[1].replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), line: Number(m[2]) };
        }
      }
    }
    return null;
  }

  document.addEventListener('bf:probe', (event) => {
    const out = { components: [], source: null };
    try {
      const el = event.target instanceof Element ? event.target : null;
      let fiber = el && fiberOf(el);
      for (let hops = 0; fiber && hops < 80 && out.components.length < 6; hops++) {
        if (!out.source) out.source = sourceOf(fiber);
        const name = nameOf(fiber.type);
        if (name && !SKIP.has(name) && !NOISE.test(name) && !out.components.includes(name)) out.components.push(name);
        fiber = fiber.return;
      }
    } catch {}
    document.dispatchEvent(new CustomEvent('bf:probe-result', { detail: JSON.stringify(out) }));
    event.stopImmediatePropagation();
  });
})();
