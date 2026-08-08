# Frontend Hook Reference

Frontend hooks are registered with `registerHook(name, fn)` (from `ymerflow-plugin-sdk` or
`window.__nagelfluh_registerHook`). Each registration adds a callback `fn` to the named hook;
when the host calls that hook it collects the concatenated return values of all registered
callbacks. Hooks come in three runner flavours:

- **`run`** — synchronous, returns plain values
- **`run_async`** — asynchronous, `fn` may return a Promise
- **`run_jsx`** — synchronous, React elements are wrapped in an error boundary

All callbacks must return an array (or `null`/`undefined` to contribute nothing).

> Source-path references below point at the **host application** repository (see the
> [overview](README.md) for context).

## Active hooks

### `dataset_types`

Register custom dataset classes that the frontend uses to load data by MIME type.

- **Runner:** `run`
- **Consumed by:** `datamodel/datasetRegistry.js` → `buildDatasetRegistry()` (called at startup after plugins load)
- **Callback returns:** `Array<{ mimeType: string, cls: DatasetClass }>`
  - `mimeType` — MIME type string (e.g. `"application/x-my-format"`)
  - `cls` — Dataset class implementing the gladly Data interface (`columns()`, `getData(col)`, etc.)

```js
registerHook('dataset_types', () => [
  { mimeType: 'application/x-my-format', cls: MyDataset },
])
```

### `widgets`

Register custom widget components that can be placed in the flexout layout.

- **Runner:** `run`
- **Consumed by:** `App.jsx` → `buildWidgets()` (called at startup after plugins load)
- **Callback returns:** `Array<{ name: string, component: ReactComponent }>`
  - `name` — unique widget type name used in the layout tree's `widget` field
  - `component` — React component; should export a static `.title` string for the pane dropdown

```js
registerHook('widgets', () => [
  { name: 'MyWidget', component: MyWidget },
])
```

### `layer_types`

Register custom gladly-plot layer types for use in PlotView.

- **Runner:** `run`
- **Consumed by:** `plugins/registries.js` → `buildLayerTypeRegistry()` → `registerLayerType(name, cls)`
- **Callback returns:** `Array<{ name: string, layerClass: Class }>`
  - `name` — layer type identifier used in PlotView layer configs
  - `layerClass` — class conforming to the gladly-plot layer interface

```js
registerHook('layer_types', () => [
  { name: 'MyLayerType', layerClass: MyLayerType },
])
```

### `quantity_kinds`

Register custom axis quantity kind descriptors used by gladly-plot for axis labelling and scale
selection.

- **Runner:** `run`
- **Consumed by:** `plugins/registries.js` → `buildQuantityKindRegistry()` → `registerAxisQuantityKind(name, descriptor)`
- **Callback returns:** `Array<{ name: string, descriptor: object }>`
  - `name` — quantity kind identifier (e.g. `"my_unit"`)
  - `descriptor` — gladly-plot quantity kind object (e.g. `{ label: 'My Unit', scale: 'linear' }`)

```js
registerHook('quantity_kinds', () => [
  { name: 'my_unit', descriptor: { label: 'My Unit', scale: 'linear' } },
])
```

### `pages`

Register custom full-page React components routed under `/app/plugin/{path}`.

- **Runner:** `run`
- **Consumed by:** `App.jsx` (renders each item as `<Route path="/app/plugin/{path}" element={<C />} />`)
- **Callback returns:** `Array<{ path: string, component: ReactComponent, title: string }>`
  - `path` — URL segment appended to `/app/plugin/` (no leading slash)
  - `component` — page component
  - `title` — human-readable page title

```js
registerHook('pages', () => [
  { path: 'my-page', title: 'My Page', component: MyPage },
])
```

### `app_routes`

Register additional React Router `<Route>` elements with full path control (not constrained to
the `/app/plugin/` prefix).

- **Runner:** `run_jsx`
- **Consumed by:** `App.jsx` (renders as `<Route path={path} element={element} />`)
- **Callback returns:** `Array<{ path: string, element: ReactElement }>`
  - `path` — full route path
  - `element` — React element to render

```js
registerHook('app_routes', () => [
  { path: '/my-standalone-page', element: <MyStandalonePage /> },
])
```

### `app_providers`

Wrap the entire authenticated application in additional React context providers.

- **Runner:** `run_jsx`
- **Consumed by:** `App.jsx` — providers are nested innermost-first (`reduceRight`) around the main app node, so the last registered provider is the outermost wrapper
- **Callback returns:** `Array<{ Component: ReactComponent }>`
  - `Component` — a component that accepts `children` and returns `<Component>{children}</Component>`

```js
registerHook('app_providers', () => [
  { Component: MyContextProvider },
])
```

### `account_tabs`

Add extra tabs to the Account page. Both `account_tabs` and `admin_tabs` (below) are consumed by
the same generic `TabbedPage.jsx` component, which binds the active tab to a URL path segment
(`{basePath}/:tab`).

- **Runner:** `run`
- **Consumed by:** `TabbedPage.jsx` (rendered by `AccountPage.jsx` with `basePath="/account"`)
- **Callback returns:** `Array<{ key: string, title: string, Component: ReactComponent }>`
  - `key` — unique tab identifier (used as the URL path segment and as the React key)
  - `title` — tab label shown in the tab bar
  - `Component` — component rendered as the tab body; receives whatever `tabProps` the host page passes (`AccountPage` passes `accountData`/`onTransactionClick`-style props)

```js
registerHook('account_tabs', () => [
  { key: 'my-tab', title: 'My Tab', Component: MyAccountSection },
])
```

### `admin_tabs`

Add extra tabs to the Admin page (visible only to admins — `AdminPage.jsx` gates access before
rendering). Same shape and same `TabbedPage.jsx` consumer as `account_tabs`.

- **Runner:** `run`
- **Consumed by:** `TabbedPage.jsx` (rendered by `AdminPage.jsx` with `basePath="/admin"`)
- **Callback returns:** `Array<{ key: string, title: string, Component: ReactComponent }>`
  - `key` — unique tab identifier (used as the URL path segment and as the React key)
  - `title` — tab label shown in the tab bar
  - `Component` — component rendered as the tab body (no extra props are passed by `AdminPage`)

```js
registerHook('admin_tabs', () => [
  { key: 'my-admin-tab', title: 'My Settings', Component: MyAdminPanel },
])
```

### `resource_cost_display`

Provide a cost estimate component shown in the ProcessEditor before a user runs a process. Only
the **first** registered contribution is used.

- **Runner:** `run`
- **Consumed by:** `widgets/ProcessEditor.jsx`
- **Callback returns:** `Array<{ Component: ReactComponent }>`
  - `Component` — receives the current process parameters and renders a cost estimate

```js
registerHook('resource_cost_display', () => [
  { Component: MyCostDisplay },
])
```

### `user_menu_extra_items`

Add items to the user dropdown menu in the menu bar.

- **Runner:** `run_jsx`
- **Consumed by:** `UserMenu.jsx`
- **Callback returns:** array of ReactElements (rendered directly inside the menu)

```js
registerHook('user_menu_extra_items', () => [
  <li key="my-item"><button onClick={...}>My Action</button></li>,
])
```

### `fullscreen_pages`

Register a full-screen page rendered with **no app chrome** (no menu bar, no layout) when the
current URL path starts with a given prefix — for landing pages reached via an emailed link (e.g.
accepting an invite) that shouldn't show the normal app shell. Checked before the authenticated
app renders; the path is also remembered across a login redirect (via `sessionStorage`) so a
fullscreen page survives an intervening login.

- **Runner:** `run`
- **Consumed by:** `App.jsx` — `hooks.run.fullscreen_pages()`, matched against `location.pathname` with `.startsWith(p.path)`
- **Callback returns:** `Array<{ path: string, Component: ReactComponent }>`
  - `path` — URL path prefix to match (e.g. `/billing/invite/`)
  - `Component` — page component rendered with no props, replacing the entire app shell

```js
registerHook('fullscreen_pages', () => [
  { path: '/my-plugin/invite/', Component: MyInviteLandingPage },
])
```

### `cluster_provider_forms`

Provide the connection-config form shown in the admin Clusters panel for a given
`Cluster.cluster_type`. Core registers its own built-in forms (`same-as-backend`, `kubeconfig`,
`minikube`) through this exact same hook — a plugin adding a new cluster type pairs a
`cluster_provider_forms` entry here with a backend `cluster_provider_handlers` registration (see
[backend hooks](backend-hooks.md#cluster_provider_handlers)) for the matching `type`.

- **Runner:** `run`
- **Consumed by:** `ClustersAdminPanel.jsx` — `hooks.run.cluster_provider_forms()`
- **Callback returns:** `Array<{ type: string, title: string, Component: ReactComponent }>`
  - `type` — must match the `cluster_type` string the backend `ClusterProvider` is registered under
  - `title` — human-readable label shown in the cluster-type dropdown
  - `Component` — form component for editing this cluster type's `provider_config`

```js
registerHook('cluster_provider_forms', () => [
  { type: 'gke', title: 'Google Kubernetes Engine', Component: GkeClusterForm },
])
```

### `storage_protocol_forms`

Provide the connection-config form shown in the admin Storage Backends panel for a given
`StorageBackend.protocol`. Core registers its own built-in forms (`minio`, `gcs`, `s3`) through
this exact same hook — a plugin adding a new protocol pairs a `storage_protocol_forms` entry here
with a backend `storage_protocol_handlers` registration (see
[backend hooks](backend-hooks.md#storage_protocol_handlers)) for the matching `type`.

- **Runner:** `run`
- **Consumed by:** `StorageBackendsAdminPanel.jsx` — `hooks.run.storage_protocol_forms()`
- **Callback returns:** `Array<{ type: string, title: string, Component: ReactComponent }>`
  - `type` — must match the `protocol` string the backend `StorageProtocolHandler` is registered under
  - `title` — human-readable label shown in the protocol dropdown
  - `Component` — form component for editing this protocol's connection config

```js
registerHook('storage_protocol_forms', () => [
  { type: 'azure', title: 'Azure Blob Storage', Component: AzureStorageForm },
])
```

## Reserved hooks

These hook names are accepted by `registerHook` but are not yet consumed by the host. Registering
them is harmless and forward-compatible, but they currently have no effect.

### `nav_items`

Intended for adding entries to navigation menus.

- **Callback returns:** `Array<{ menuPath: string, label: string, to?: string, onSelect?: Function }>`

### `process_actions`

Intended for adding action buttons to the ProcessEditor toolbar.

- **Callback returns:** array of ReactElements

### `plot_overlays`

Intended for adding overlay elements to the PlotView canvas.

- **Callback returns:** array of ReactElements
