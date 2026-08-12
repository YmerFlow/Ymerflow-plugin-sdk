# Plugin Author Guide

The host application (Ymerflow / Nagelfluh) is pluggable at runtime. A plugin is a plain **npm
source package** — no Module Federation config, no pre-built `dist/`. The host *builds* it (running
the real `npm`/`vite` resolver) against its exact shared-dependency versions, then serves and loads
it. You write only your extension code and a small manifest.

There are two delivery mechanisms that converge on the **same frontend artifact**:

| | Frontend plugin | Backend plugin |
|---|---|---|
| Packaged as | npm source package | pip-installed Python package (also ships an npm frontend source) |
| Built | in a `build_frontend_plugin` Process (pod), output dataset in the project bucket | at `pip install` time, from the plugin's `setup.py` |
| Can provide | frontend extensions only | frontend extensions **and** backend models/hooks/routers |

Both register through the **same** `registerHook` API and serve content-addressed from
`/plugin-assets/{content_hash}/…`.

## Contents

- **[Authoring a plugin](authoring.md)** — file structure, `package.json`, and the
  `src/index.js` entry point.
- **[Frontend hooks](frontend-hooks.md)** — the complete reference of frontend hook points
  (`dataset_types`, `widgets`, `layer_types`, pages, providers, …) and what each callback returns.
- **[Backend hooks](backend-hooks.md)** — the complete reference of backend (Python entry-point)
  hooks (`register_routers`, `user_created`, `job_completed`, …) with parameters and return values.
- **[Distributing & building](distributing.md)** — publishing/serving a plugin as a standalone
  frontend plugin or as the frontend half of a backend plugin.

> **Note on source paths.** Code locations referenced in these documents (e.g. `backend/main.py`,
> `App.jsx`) live in the **host application** repository, not in this SDK repository. They are cited
> so plugin authors can see exactly where and how each hook is invoked.

> **Note on contract names.** The runtime bridge / marker names shared with the host
> (`window.__ymerflow_registerHook`, the `ymerflow.hooks` entry-point group, the
> `ymerflow.remoteName` `package.json` key) use the `ymerflow` spelling, renamed together with the
> host, SDK, and all plugins in one coordinated change. See the SDK [README](../README.md#host-contract-names).
