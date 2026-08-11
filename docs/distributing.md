# Distributing & Building

A plugin's source package is built and served in one of two ways. Both converge on the **same**
content-addressed frontend artifact served from `/plugin-assets/{content_hash}/…`. See the
[overview](README.md) for how the two delivery mechanisms relate.

## As a frontend plugin (built in a Process)

1. Make your package resolvable to the build. The build resolves `name@version` from a
   **server-local directory and/or the public npm registry**, controlled by
   `PLUGIN_NPM_SOURCE_MODE` (`auto` = local-first then registry; `local`; `registry`):
   - **Published to npm** (`auto`/`registry`): just `npm publish` and reference it by `name@version`.
   - **Server-local** (`auto`/`local`, for testing or air-gapped): drop a tarball in
     `PLUGIN_NPM_SOURCE_DIR`:
     ```bash
     npm pack ./my-nagelfluh-plugin       # -> skytem-nagelfluh-plugin-1.2.3.tgz
     cp skytem-nagelfluh-plugin-1.2.3.tgz "$PLUGIN_NPM_SOURCE_DIR"/
     ```
   In `auto` mode a local file overrides the registry for that exact `name@version`.

2. A user starts a build by creating a `build_frontend_plugin` process via the generic
   `POST /projects/{project_id}/process` endpoint (the same mechanism used to create any other
   process, e.g. `create_environment`), specifying `npm_name`/`npm_version` as its parameters.
   There are no separate "build plugin" or "register plugin" endpoints. When the process
   completes, its output dataset (the built `dist/`) lands in the project bucket, and
   `ProcessVersion._create_outputs` looks for a `plugin.json` the build wrote there; if found, it
   calls `backend/services/plugin_registration.py`, which reads `plugin.json` for the remote name,
   npm name/version, and `built_against`, computes a `content_hash` from the output dataset, and
   creates the `Plugin` + `PluginVersion` rows — all as a side effect of the build completing,
   with no separate registration call.

3. A user enables it: `POST /plugins/{id}/enable` pins them to the current latest version. From then
   on `GET /plugins/me` lists it with `source: "remote"` and a `base_url` of
   `/plugin-assets/{content_hash}/`, and the frontend MF-loads it at startup.

You can also build locally without a cluster (for testing) — the build routine is standalone:
```bash
python -m ymerflow_plugin_build @skytem/nagelfluh-plugin 1.2.3 ./out --source "$PLUGIN_NPM_SOURCE_DIR"
```

## As the frontend half of a backend plugin (built at `pip install`)

A backend plugin consumes **exactly the same** npm source package. Its `setup.py` builds the source
at install time via a `build_py` command that calls the shared routine and ships the result as
package data:

```python
import os
from setuptools import setup
from setuptools.command.build_py import build_py

class BuildWithFrontend(build_py):
    def run(self):
        # Guard lets a metadata-only install skip the frontend build (see NAGELFLUH_SKIP_FRONTEND_BUILD below).
        if os.environ.get('NAGELFLUH_SKIP_FRONTEND_BUILD') != '1':
            from ymerflow_plugin_build import build_frontend  # build dep — see pyproject.toml
            build_frontend(npm_name='@skytem/nagelfluh-plugin', npm_version='1.2.3',
                           out_dir='my_backend_plugin/frontend_dist')
        super().run()

setup(
    name='my-backend-plugin',
    cmdclass={'build_py': BuildWithFrontend},
    package_data={'my_backend_plugin': ['frontend_dist/**/*']},
    entry_points={'nagelfluh.hooks': [
        'frontend_bundles = my_backend_plugin:frontend_bundles',
        'register_routers = my_backend_plugin:register_routers',
    ]},
)
```

The `nagelfluh.hooks` entry points are the [backend hooks](backend-hooks.md) the package provides;
`frontend_bundles` is what makes the bundled `frontend_dist/` discoverable at startup.

The running server never runs npm — the built output ships in the package and is content-addressed
and served from the identical `/plugin-assets/{content_hash}/…` path, so the frontend loads both
kinds indistinguishably.

### `ymerflow_plugin_build` is a *build* dependency — declare it in `pyproject.toml`

Because `setup.py` **imports and calls** `ymerflow_plugin_build` while building, it is a build-time
dependency, not a runtime one (the running server never imports it). Modern pip builds every package
in an isolated environment (PEP 517/518) containing **only** the packages listed under
`[build-system].requires`. If `ymerflow-plugin-build` is not listed there, the build environment has
just `setuptools`+`wheel`, the `from ymerflow_plugin_build import build_frontend` in `setup.py`
raises `ImportError`, and the build fails.

So ship a `pyproject.toml` alongside `setup.py`:

```toml
[build-system]
requires = [
    "setuptools>=61",
    "wheel",
    "ymerflow-plugin-build @ git+https://github.com/SagebrushGeoTools/Ymerflow-plugin-sdk.git",
]
build-backend = "setuptools.build_meta"
```

Put `ymerflow-plugin-build` here, **not** in `setup.py`'s `install_requires` — it is only needed to
build, and listing it as a runtime requirement would force every install target to pull the SDK for
no reason. With this in place, a plain `pip install` / `pip install -e` builds the frontend with no
extra flags. (The alternative — `pip install --no-build-isolation`, relying on the SDK already being
present in the ambient environment — is fragile and should not be required.)

For a metadata-only install that skips the frontend build entirely (e.g. on a machine without npm),
set `NAGELFLUH_SKIP_FRONTEND_BUILD=1`; the `build_py` override checks it before invoking the build,
so neither npm nor the build dependency is consulted.
