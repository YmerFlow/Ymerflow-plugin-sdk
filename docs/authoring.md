# Authoring a Plugin

This page covers the structure of a plugin source package and how it registers its extensions.
For the hook reference, see [frontend hooks](frontend-hooks.md) and [backend hooks](backend-hooks.md).
For publishing/serving, see [distributing & building](distributing.md).

## File structure

```
my-nagelfluh-plugin/
  package.json        ← npm manifest: peerDependencies + ymerflow.remoteName/entry
  src/
    index.js          ← entry point; registers everything as side effects
    MyDataset.js
    MyLayerType.js
    MyWidget.js
```

## `package.json`

Shared deps go in `peerDependencies` (the host provides them as MF singletons — the build pins them
to the host's exact versions); any other dependency is a normal `dependency` and gets bundled. The
`ymerflow` block names the MF remote and points at the **source** entry module.

```jsonc
{
  "name": "@skytem/nagelfluh-plugin",
  "version": "1.2.3",
  "peerDependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "dependencies": { "some-lib": "^2.0.0" },
  "devDependencies": { "ymerflow-plugin-sdk": "^1.0.0" },
  "ymerflow": {
    "remoteName": "skytem_plugin",   // MF remote name == Plugin.name
    "entry": "src/index.js"          // source entry the build harness exposes
  }
}
```

You never write a Vite or Module-Federation config: the build harness
(`ymerflow_plugin_build`) owns it. It scaffolds a `vite.config.js` whose `shared` block is pinned
to the host's exact singleton versions injected at build time.

The SDK also ships that same Module-Federation config as a reusable preset,
`ymerflow-plugin-sdk/vite-preset` (`ymerflowFederation({ name, entry })` plus the pure
`sharedConfig` / `hostSharedVersions` helpers). The preset is the documented, single source of truth
for the federation `shared` shape; `tests/test_vite_preset_consistency.py` asserts it and the
harness emit an identical `shared` block (and that the SDK's `DEFAULT_SHARED` equals the harness's
`HOST_SHARED_VERSIONS`), so the two can never silently drift. Use the preset directly only if you
build your plugin yourself outside the harness — for the normal flow (a `build_frontend_plugin`
Process, or a backend plugin's `setup.py`) the harness generates the config for you.

## `src/index.js`

Everything is registered as a **side effect of importing `index.js`** through a single API,
`registerHook`. The host's collectors translate each hook's results into whatever internal
structure they need (Maps, gladly-plot calls, router entries).

```js
import { registerHook } from 'ymerflow-plugin-sdk'

import { MyDataset }   from './MyDataset'
import { MyLayerType } from './MyLayerType'
import { MyWidget }    from './MyWidget'
import { MyPage }      from './MyPage'

registerHook('dataset_types',  () => [{ mimeType: 'application/x-my-format', cls: MyDataset }])
registerHook('layer_types',    () => [{ name: 'MyLayerType', layerClass: MyLayerType }])
registerHook('widgets',        () => [{ name: 'MyWidget', component: MyWidget }])
registerHook('quantity_kinds', () => [{ name: 'my_unit', descriptor: { label: 'My Unit', scale: 'linear' } }])
registerHook('pages',          () => [{ path: 'my-page', title: 'My Page', component: MyPage }])
registerHook('nav_items',      () => [{ menuPath: 'tools', label: 'My Page', to: '/app/plugin/my-page' }])
```

Each `registerHook(name, fn)` call appends a callback to the named hook. See
[frontend hooks](frontend-hooks.md) for the full list of hook points and the exact shape each
callback must return.

A backend plugin additionally registers Python callables as setuptools entry points in the
`ymerflow.hooks` group — see [backend hooks](backend-hooks.md).
