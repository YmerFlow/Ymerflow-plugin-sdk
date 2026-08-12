// ymerflow-plugin-sdk/vite-preset — the Module-Federation Vite preset used by the build harness.
//
// It reads the host's shared-singleton versions (injected at build time via the
// YMERFLOW_SHARED_VERSIONS env var as JSON) and emits the MF `shared` config pinned to them, so a
// plugin author writes NO Module-Federation / Vite config. The same preset is used whether the
// plugin is built in a `build_frontend_plugin` Process or by a backend plugin's `setup.py`.
//
//   // vite.config.js (generated; authors don't write this)
//   import { defineConfig } from 'vite'
//   import { ymerflowFederation } from 'ymerflow-plugin-sdk/vite-preset'
//   export default defineConfig({ plugins: [ ...ymerflowFederation({ name, entry }) ] })
//
// The `shared` block this preset emits is the SINGLE SOURCE OF TRUTH for the MF shared config. The
// Python build harness (`ymerflow_plugin_build.build._shared_block`) produces an identical shape;
// `tests/test_vite_preset_consistency.py` asserts they stay in lock-step so the documented preset
// never drifts from the config the harness actually emits. The heavy Vite plugin imports are loaded
// lazily inside `ymerflowFederation` so the pure `sharedConfig`/`hostSharedVersions` helpers can be
// imported (e.g. by that test) without `@vitejs/plugin-react` / `@module-federation/vite` installed.

// Fallback versions if the host did not inject any (kept in sync with frontend/vite.config.js).
export const DEFAULT_SHARED = {
  react: '18.2.0',
  'react-dom': '18.2.0',
  '@tanstack/react-query': '5.90.19',
}

export function hostSharedVersions() {
  const raw = (typeof process !== 'undefined' && process.env && process.env.YMERFLOW_SHARED_VERSIONS) || ''
  if (!raw) return { ...DEFAULT_SHARED }
  try {
    return JSON.parse(raw)
  } catch (e) {
    console.warn('[ymerflow-plugin-sdk] could not parse YMERFLOW_SHARED_VERSIONS; using defaults')
    return { ...DEFAULT_SHARED }
  }
}

export function sharedConfig(versions) {
  const shared = {}
  for (const [name, version] of Object.entries(versions)) {
    shared[name] = { singleton: true, requiredVersion: version }
  }
  return shared
}

// Returns the array of Vite plugins to spread into `plugins: [...]`.
// Heavy Vite imports are loaded lazily here so the pure helpers above stay import-light.
export async function ymerflowFederation({ name, entry = 'src/index.js', sharedVersions } = {}) {
  if (!name) throw new Error('ymerflowFederation: `name` (the MF remote name) is required')
  const versions = sharedVersions || hostSharedVersions()
  const { default: react } = await import('@vitejs/plugin-react')
  const { federation } = await import('@module-federation/vite')
  return [
    react(),
    federation({
      name,
      filename: 'remoteEntry.js',
      dts: false,
      exposes: { './index': './' + entry.replace(/^\.\//, '') },
      shared: sharedConfig(versions),
    }),
  ]
}

export default ymerflowFederation
