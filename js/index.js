// ymerflow-plugin-sdk — the single registration API for Nagelfluh frontend plugins.
//
// A plugin's `src/index.js` imports `registerHook` (and optionally `hooks`/`useHook`) from here
// and registers all its extensions as side effects of being imported. The host bridges its hook
// runner onto `window.__ymerflow_*` before any plugin loads, so the SDK is a thin, dependency-free
// shim — there is exactly ONE hook registry (the host's) shared across host and all plugins.
//
//   import { registerHook } from 'ymerflow-plugin-sdk'
//   registerHook('widgets', () => [{ name: 'MyWidget', component: MyWidget }])

function host() {
  if (typeof window === 'undefined') {
    throw new Error('ymerflow-plugin-sdk can only be used in the browser (host window bridge missing).')
  }
  return window
}

export function registerHook(name, fn) {
  const reg = host().__ymerflow_registerHook
  if (typeof reg !== 'function') {
    throw new Error('ymerflow host bridge not initialised: window.__ymerflow_registerHook missing.')
  }
  return reg(name, fn)
}

// The host's hook runner ({ run, run_async, run_jsx }). Available after the host has loaded.
export const hooks = new Proxy({}, {
  get(_t, prop) {
    const h = host().__ymerflow_hooks
    if (!h) throw new Error('ymerflow host bridge not initialised: window.__ymerflow_hooks missing.')
    return h[prop]
  },
})

// Memoized JSX hook helper, mirroring the host's useHook. React is a shared singleton, so importing
// it here resolves to the host's instance.
import { useMemo } from 'react'

export function useHook(name, ...args) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => hooks.run_jsx[name](...args), [name, ...args])
}
