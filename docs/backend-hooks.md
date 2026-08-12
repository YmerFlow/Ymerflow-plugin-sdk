# Backend Hook Reference

Backend hooks are implemented as Python functions or coroutines registered as **setuptools entry
points** in the `ymerflow.hooks` group. The entry point **name** selects the hook; the value
points to the callable. Only [backend plugins](README.md) (pip-installed Python packages) can
provide these.

```python
# setup.py / pyproject.toml
entry_points={
    'ymerflow.hooks': [
        'register_routers = my_plugin:register_routers',
        'frontend_bundles  = my_plugin:frontend_bundles',
    ],
}
```

The hook dispatcher (`backend/hooks.py`) collects all callables registered under a given name
(sorted by distribution name, so fan-out order is deterministic) and dispatches via one of three
runner flavours:

- **`hooks.run.*`** — calls each hook in turn, concatenates non-`None`/non-empty return values
  into a single list. Raises the last exception if any hook raised (chained via `__context__`
  onto earlier ones).
- **`hooks.run_async.*`** — same as `run`, but awaits coroutines returned by async hook functions.
- **`hooks.run_first.*`** — calls `hooks.run_first.<name>(default, *args, **kwargs)`. Calls each
  hook in turn and returns the first **non-`None`** result; if none answer, returns `default`.
  Unlike `run`/`run_async`, disagreement between plugins is *not* an error — first-registered
  (by dist-name sort order) silently wins. Intended for cases where exactly one answer is needed
  (as opposed to `select_clusters`/`select_storage_backends`'s "union of allowed ids" shape). As
  of this writing, no hook in the host application actually uses this runner — there is currently
  no live example to point to.

There's also `hooks.any_registered(name)`, a plain function (not a namespace) that returns whether
*any* plugin registers a given hook name at all — used to distinguish "no plugins registered" from
"plugins registered but all returned nothing" for callers that only want a fallback in the former
case (e.g. `select_clusters`/`select_storage_backends`, below).

> Source-path references below point at the **host application** repository (see the
> [overview](README.md) for context).

## Lifecycle / registration hooks

### `register_routers`

Called once at application startup. Allows a plugin to mount additional FastAPI routers (API
endpoints, static file mounts, etc.) on the application.

- **Caller:** `backend/main.py` startup event — `hooks.run.register_routers(app)`
- **Runner:** `run` (synchronous)
- **Parameters:**
  - `app` (`fastapi.FastAPI`) — the running FastAPI application instance
- **Returns:** `None` (return value is ignored)

```python
from fastapi import APIRouter

router = APIRouter(prefix="/my-plugin")

@router.get("/status")
async def status():
    return {"ok": True}

def register_routers(app):
    app.include_router(router)
```

### `register_models`

Called once when `backend/models/__init__.py` is first imported (before any database operation).
Allows a plugin to declare additional SQLAlchemy ORM models that should be part of the shared
metadata and picked up by Alembic.

- **Caller:** `backend/models/__init__.py` — `hooks.run.register_models()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `None` (return value is ignored)

```python
from backend.database import Base
from sqlalchemy import Column, Integer, String, ForeignKey

class MyPluginModel(Base):
    __tablename__ = "my_plugin_records"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    value = Column(String(255))

def register_models():
    pass  # importing this module registers MyPluginModel via Base metadata
```

### `frontend_bundles`

Called once at startup. Returns descriptors for pre-built frontend plugin bundles that ship
inside the Python package (built at `pip install` time, not in a Kubernetes pod).

- **Caller:** `backend/plugin_assets.py` — `hooks.run.frontend_bundles()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `list[dict]` — each dict may contain:
  - `dist_dir` (str, **required**) — absolute path to the compiled `dist/` directory on disk
  - `name` (str, optional) — Module Federation remote name; falls back to `package.json`'s `ymerflow.remoteName`
  - `display_name` (str, optional) — human-readable label shown in the Plugin Manager; falls back to `name`

```python
import os

def frontend_bundles():
    dist = os.path.join(os.path.dirname(__file__), 'frontend_dist')
    return [{'dist_dir': dist, 'name': 'my_plugin', 'display_name': 'My Plugin'}]
```

## User hooks

### `user_created`

Called after a new user successfully signs up, while the database transaction is still open.
Intended for post-registration side effects such as creating billing accounts or sending welcome
emails.

- **Caller:** `backend/routers/auth.py` signup handler — `await hooks.run_async.user_created(db, user)`
- **Runner:** `run_async` (coroutines are awaited)
- **Parameters:**
  - `db` (`sqlalchemy.ext.asyncio.AsyncSession`) — the active database session (transaction not yet committed)
  - `user` (`backend.models.User`) — the newly created user (already flushed, has an `id`)
- **Returns:** `None` (return value is ignored)

```python
async def user_created(db, user):
    billing_account = BillingAccount(user_id=user.id, credits=0)
    db.add(billing_account)
    # no need to commit — the caller commits after this hook returns
```

### `user_query_options`

Called whenever a `User` row is loaded from the database. Allows plugins to inject SQLAlchemy
eager-load options so that plugin-owned relationships are available on the `user` object without
additional queries.

- **Caller:** `backend/routers/auth.py` (login, signup, get-account, update-preferences) — `hooks.run.user_query_options()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `list[sqlalchemy.orm.interfaces.LoaderOption]` — options passed to `.options(*opts)` when selecting `User`

```python
from sqlalchemy.orm import selectinload
from .models import BillingAccount  # relationship on User

def user_query_options():
    return [selectinload(User.billing_account)]
```

### `user_to_dict`

Called inside `User.to_dict()` to let plugins inject extra fields into the serialised user
object returned by the API.

- **Caller:** `backend/models/user.py` `User.to_dict()` — `hooks.run.user_to_dict(self)`
- **Runner:** `run` (synchronous)
- **Parameters:**
  - `user` (`backend.models.User`) — the user instance being serialised
- **Returns:** `list[dict]` — each dict is merged (via `dict.update()`) into the base user dict

```python
def user_to_dict(user):
    account = user.billing_account  # eager-loaded via user_query_options
    if account is None:
        return []
    return [{'credits': account.credits, 'plan': account.plan}]
```

## Job lifecycle hooks

### `job_pre_run`

Called just before a process job is dispatched to Kubernetes. Raise
`backend.exceptions.UserError` to abort the job with a user-visible error message; any other
exception is logged and also aborts the job.

- **Caller:** `backend/models/process.py` `ProcessVersion.run_task()` — `await hooks.run_async.job_pre_run(db, user, process, process_version)`
- **Runner:** `run_async` (coroutines are awaited)
- **Parameters:**
  - `db` (`sqlalchemy.ext.asyncio.AsyncSession`) — active database session
  - `user` (`backend.models.User`) — user who owns the process
  - `process` (`backend.models.Process`) — the process being run
  - `process_version` (`backend.models.ProcessVersion`) — the specific version about to run
- **Returns:** `None` (return value is ignored)
- **Side effects:** Raising `UserError` marks the process version as `FAILED` with the error message in the log

```python
from backend.exceptions import UserError

async def job_pre_run(db, user, process, process_version):
    account = user.billing_account
    if account is None or account.credits <= 0:
        raise UserError("Insufficient credits to run this process.")
    # Optionally place a hold here and release in job_completed
```

### `job_completed`

Called after a job finishes (whether it succeeded or failed), while the database transaction is
still open. Intended for billing, usage tracking, or notification side effects.

- **Caller:** `backend/models/process.py` `ProcessVersion._handle_job_completion()` (a `@staticmethod`) — `await hooks.run_async.job_completed(db, process, process_version, runtime_seconds, status)`
- **Runner:** `run_async` (coroutines are awaited)
- **Parameters:**
  - `db` (`sqlalchemy.ext.asyncio.AsyncSession`) — active database session (transaction not yet committed)
  - `process` (`backend.models.Process`) — the completed process
  - `process_version` (`backend.models.ProcessVersion`) — the specific version that ran; `process_version.started_at` and `process_version.completed_at` are set
  - `runtime_seconds` (`float`) — wall-clock duration from job start to completion
  - `status` (`str`) — `"succeeded"` or `"failed"`
- **Returns:** `None` (return value is ignored)

```python
async def job_completed(db, process, process_version, runtime_seconds, status):
    account = process_version.process.owner.billing_account
    if account and status == "succeeded":
        cost = compute_cost(runtime_seconds)
        account.credits -= cost
        # transaction is committed by the caller
```

## Cluster hooks

### `select_clusters`

Restricts which Kubernetes clusters a user may run jobs on. If **no** plugin registers this hook,
every active cluster is allowed (checked via `hooks.any_registered`, not by an empty result — a
registered hook that legitimately returns an empty set means "no clusters allowed", not "fall back
to all").

- **Caller:** `backend/models/cluster.py` `get_allowed_clusters()` — `await hooks.run_async.select_clusters(db, user, project_id, resource_requests)`
- **Runner:** `run_async` (coroutines are awaited) — plugin implementations must define this hook
  as `async def`
- **Parameters:**
  - `db` (`sqlalchemy.ext.asyncio.AsyncSession`) — active database session
  - `user` (`backend.models.User`) — the requesting user
  - `project_id` (`str | None`) — project context, if any
  - `resource_requests` (`dict | None`) — `{"cpu": ..., "memory": ...}` if the caller specified resource hints, else `None`
- **Returns:** `list[str]` — cluster ids this plugin allows; the union across all registered plugins is the final allowed set

```python
async def select_clusters(db, user, project_id, resource_requests):
    if user.billing_account and user.billing_account.plan == "premium":
        return ["gpu-cluster-1", "gpu-cluster-2"]
    return ["shared-cluster"]
```

### `cluster_provider_handlers`

Registers `ClusterProvider` implementations for `Cluster.cluster_type` values. Core registers only
its two built-in providers, `same-as-backend` and `kubeconfig`, through this exact same hook (see
the host's root `setup.py`) — a plugin adding a new cluster type (e.g. GKE, or `minikube`, which
now ships from `plugins/ymerflow-minikube` rather than core — see
`docs/plans/minikube-provisioning-plugin.md`) uses the identical channel core does, with no "core
is special" path. A stock install without the minikube plugin has no self-hosted cluster option
left, only `same-as-backend`/`kubeconfig`.

- **Caller:** `backend/services/cluster_providers/__init__.py` `get_cluster_provider()` — `hooks.run.cluster_provider_handlers()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `list[tuple[str, type]]` — `(cluster_type, ClusterProviderSubclass)` pairs. A duplicate `cluster_type` across plugins raises `ValueError`.

#### The `Cluster` row

Each admin-configured cluster is a `Cluster` row (`backend/models/cluster.py`). The fields a
`ClusterProvider` cares about:
- `cluster_type` (`str`) — the discriminator dispatched to `get_cluster_provider()`; this is the key you register under
- `provider_config` (`dict`, JSON column) — opaque, provider-specific config (e.g. a parsed kubeconfig dict for `KubeconfigClusterProvider`); the admin UI's matching [`cluster_provider_forms`](frontend-hooks.md#cluster_provider_forms) entry is what edits this
- `namespace` (`str`) — the Kubernetes namespace jobs for this cluster should run in

#### `ClusterProvider` base class

`backend.services.cluster_providers.ClusterProvider` — subclass this and register an instance's
class via `cluster_provider_handlers`.

- `self_service_registration` (class attribute, default `False`) — set `True` for providers that
  can't complete registration synchronously in the admin "Add Cluster" dialog (the config is
  filled in later by something running on the target host, e.g. a setup script the admin
  copy-pastes). See `docs/plans/minikube-cluster-registration-ux.md` in the host repo for the
  out-of-band registration flow this enables (`minikube`, the cluster type shipped by
  `plugins/ymerflow-minikube`, is the only provider that sets this).
- `connect(provider_config: dict, namespace: str) -> K8sClient` — **required**, no default.
  Synchronous — just constructs and returns a `K8sClient`, it does not itself open a connection
  (`K8sClient` lazily initializes on first API call). This is the one method every provider must
  implement; everything else is generic dispatch built on top of the client it returns.
- `materialize_kubeconfig(provider_config: dict) -> dict` — no default implementation. Returns a
  kubeconfig-shaped dict — the exact shape `connect()`'s own `kubeconfig` argument already accepts
  (`K8sClient` loads it via `config.load_kube_config_from_dict`) — for use by kubectl-based scripts
  (`prod/runall-production.sh`, `docker/build.sh`, `backup.sh`, `restore.sh`,
  `debug-harness/run_debug.sh`). Must not shell out to a vendor CLI (`gcloud`, `minikube`) to build
  this — construct the credential directly via the provider's own Python SDK/HTTP calls. A provider
  that doesn't implement it (raises `NotImplementedError`) just means those kubectl-based scripts
  can't target that cluster type yet — a loud, correct failure rather than a silent wrong-cluster
  one.
- `test_connection(provider_config: dict) -> None` (async) — optional; default implementation
  calls `connect()` then does a timeout-bounded `list_namespace` call to verify reachability. Raise
  a clear exception on failure. Override when a cheaper or more specific check makes sense (e.g.
  validating a token before even attempting a network call).
- `bootstrap(provider_config: dict) -> dict` (sync) — **required**, no default. See [The
  `bootstrap()` provisioning flow](#the-bootstrap-provisioning-flow) below.
- `teardown(provider_config: dict) -> None` (sync) — the mirror of `bootstrap()`: removes the
  k8s-level resources `bootstrap()` created (the jobs namespace, Kueue config, etc.). Default is a
  no-op passthrough, exactly like `bootstrap()`'s default for core-provided providers. A provider
  that manages a local VM (e.g. minikube) must **not** stop/delete the VM itself here — only the
  k8s-level resources it applied — leaving VM destruction a manual, explicit operation. Must be
  idempotent (safe to call when nothing is provisioned).
- `resolve_app_hostname(provider_config: dict, app_config: dict) -> str | None` (async) — optional,
  cheap, idempotent. Called *before* the app's Secret is built, so its result can be baked into
  `app_config["SERVER_URL"]` first. Needed for a provider (e.g. GKE) whose externally-reachable
  hostname isn't known until a resource (a static IP) is reserved — that reservation normally only
  happens inside `expose_app()`, which runs after the Secret containing `BACKEND_BASE_URL` was
  already built and applied. Default: returns `app_config.get("SERVER_URL")` unchanged — every
  provider whose hostname doesn't need a reservation step (`same-as-backend`/`minikube`) never
  needs to override this.
- `supports_app_deployment` (class attribute, default `False`), `deploy_app(...)` /
  `expose_app(...)` (async, optional) — the hook for a provider that can also **host the Ymerflow
  application itself** (backend + frontend pods, their config/secrets, their exposure) on its
  cluster, not just run process/analysis Jobs on it. See [Hosting the app: `deploy_app()` /
  `expose_app()`](#hosting-the-app-deploy_app--expose_app) below.

```python
from backend.services.cluster_providers import ClusterProvider
from backend.services.k8s_client import K8sClient

class GkeClusterProvider(ClusterProvider):
    def connect(self, provider_config, namespace):
        # provider_config is whatever your cluster_provider_forms component wrote to
        # Cluster.provider_config — e.g. {"kubeconfig": {...}} built from a GCP service account
        return K8sClient(namespace=namespace, kubeconfig=provider_config["kubeconfig"])

    def bootstrap(self, provider_config: dict) -> dict:
        # Most providers never need this — return provider_config unchanged, exactly like every
        # core-provided provider does. Only implement live provisioning here if config.env-driven
        # setup (via yf-bootstrap-provision) should do more than just persist the given
        # config as-is — e.g. actually creating a GKE cluster here and folding its resulting
        # kubeconfig into the returned provider_config.
        return provider_config

def cluster_provider_handlers():
    return [("gke", GkeClusterProvider)]
```

This mirrors the built-in `KubeconfigClusterProvider`
(`backend/services/cluster_providers/kubeconfig.py`) almost exactly — most new cluster types are
really just "resolve a kubeconfig dict some other way," so `connect()` can often just delegate to
`K8sClient(namespace=namespace, kubeconfig=<resolved dict>)`.

#### `K8sClient`

`backend.services.k8s_client.K8sClient` is what every `ClusterProvider.connect()` returns — it's
the only class a plugin needs to *return*, never subclass. Construct it as
`K8sClient(namespace=namespace, kubeconfig=kubeconfig_dict_or_None)`:
- `kubeconfig=None` — auto-detect (in-cluster config when running inside K8s, else the local
  kubeconfig); this is what `SameAsBackendClusterProvider` uses
- `kubeconfig={...}` — an already-parsed kubeconfig dict, loaded via
  `kubernetes_asyncio.config.load_kube_config_from_dict`

It lazily initializes (`_ensure_initialized()`) on first API call, exposing `core_api`
(`CoreV1Api`) and `batch_api` (`BatchV1Api`) plus higher-level async methods used by the job
orchestrator: `create_job`, `create_secret`, `delete_job`, `get_job_status`, `get_pod_for_job`,
`stream_pod_logs`/`get_pod_logs`, `get_pod_events`/`get_job_events`, `get_job_error_status`/
`get_pod_error_status`, `get_cluster_queue_limits` (reads a Kueue `ClusterQueue`'s CPU/memory
quota), `is_pod_container_running(pod_name)`, and `watch_job` (an async generator yielding job
status updates until a terminal state). A plugin's `ClusterProvider` never needs to call these
itself — it only needs to construct and return the client; the host calls these methods on it.

#### Job-readiness provisioning is automatic

Once a `Cluster` becomes active (self-service registration callback, direct admin creation, or a
config.env-driven `bootstrap()`-seeded default cluster), the host calls
`backend.services.cluster_job_provisioning.ensure_cluster_job_ready(k8s_client, namespace,
quota_config=None)` against it — installing Kueue (if not already present), sizing and applying a
`ResourceFlavor`/`ClusterQueue`/`LocalQueue` from the cluster's real node capacity (or from the
optional `quota_config` override, if given), and applying the backend's job-running RBAC. This is
generic, pure-`kubernetes_asyncio` logic that works against **any**
`K8sClient`, regardless of `cluster_type` — a plugin's `ClusterProvider` gets this for free just by
returning a working `K8sClient` from `connect()`; it never needs to install Kueue or apply RBAC
itself. See the host repo's `docs/architecture/registry.md` and
`docs/plans/done/registry-backend-hooks.md` for the full design.

#### Hosting the app: `deploy_app()` / `expose_app()`

Everything above is about running **process/analysis Jobs** on a cluster. A `ClusterProvider` can
*optionally* also host the **Ymerflow application itself** — the backend + frontend pods, their
workload-level config/secrets, the DB migration, and how external traffic reaches them — on the
very same `Cluster` row job execution already resolves. There is no separate "which cluster hosts
the app" model: app hosting always targets the same `Cluster` that `connect()` resolves (host
repo's `docs/plans/app-deployment-hooks.md`, Design decision 1). This capability is gated behind a
class flag and exposed through two optional async methods:

- `supports_app_deployment` (class attribute, default `False`) — set `True` to declare this
  cluster type can host the app. This gates whether the host ever calls `deploy_app()`/
  `expose_app()` for the type, mirroring how `self_service_registration` gates the out-of-band
  registration flow — a per-type capability flag that changes control flow with no router changes.
  A provider that leaves it `False` (e.g. the generic `kubeconfig` bring-your-own type, which
  can't auto-know its own Ingress class or intended exposure) is completely unaffected: the
  operator deploys/exposes the app by hand via the host's `k8s/*.yaml`, exactly as before this hook
  existed.
- `deploy_app(k8s_client, provider_config, namespace, images, app_config, secrets) -> None`
  (async) — apply the app's workload-level resources: the backend + frontend `Deployment`/
  `Service`, the `ymerflow-backend-config`/`ymerflow-backend-secret` `ConfigMap`/`Secret`, and
  the DB migration `Job`. This work is **identical for every provider**, so an implementation
  delegates it to the shared host helper
  `backend.services.app_deployment.apply_app_workloads(k8s_client, namespace, images, app_config,
  secrets, image_pull_credentials=..., replicas=...)` — the same "shared utility, not part of the
  ABC" shape as `ensure_cluster_job_ready()`. Your `deploy_app()`'s own job is only to resolve the
  provider-specific inputs (e.g. how images are made pullable on this cluster) and call the helper.
  `namespace` here is the **app** namespace (e.g. `ymerflow`), distinct from `Cluster.namespace`
  (the *jobs* namespace). `images` is `{"backend": ..., "frontend": ...}` of already-resolved
  `RegistryProtocolHandler.image_url()` strings — app images go through the [registry
  axis](#registry-hooks), never `imagePullPolicy: Never`. `secrets` must include a fully-resolved
  `DATABASE_URL`; `JWT_SECRET_KEY` is handled inside the helper (check-before-generate against the
  K8s API — reuse an existing Secret's value across redeploys so tokens stay valid, generate one
  only on a first-ever deploy).
- `expose_app(k8s_client, provider_config, namespace, app_config) -> dict` (async) — the
  **genuinely provider-specific part**: how external traffic reaches the app and whether/how TLS is
  terminated. Returns `{"url": str, ...}`. `same-as-backend` (core) and `minikube` (the cluster
  type shipped by `plugins/ymerflow-minikube`) both implement it as a NodePort `Service`
  (parameterized from `app_config`, e.g. `FRONTEND_NODE_PORT`/`SERVER_URL`); a
  cloud cluster type implements it against whatever managed load balancer / certificate / Ingress
  that cloud offers, reading `app_config["APP_DOMAIN"]` if it wants a hostname to request a
  certificate for. The host threads `APP_DOMAIN` through unchanged and does not interpret it.

Core ships one reference implementation of this, `same-as-backend`, via a shared
`NodePortAppDeploymentMixin` (`backend/services/cluster_providers/nodeport_app_deployment.py`).
`plugins/ymerflow-minikube`'s `minikube` cluster type reuses the identical mixin unchanged (it
only differs in `connect()`/`bootstrap()`), which is itself a good example for a plugin adding a
cloud cluster type: implement `deploy_app()`/`expose_app()` for your own provider — the same
relationship a plugin's `bootstrap()` has to the registry/storage/cluster axes: core defines the
hook and a reference implementation, the plugin implements it for its cluster.

```python
from backend.services.cluster_providers import ClusterProvider
from backend.services import app_deployment

class GkeClusterProvider(ClusterProvider):
    supports_app_deployment = True

    def connect(self, provider_config, namespace):
        ...

    async def deploy_app(self, k8s_client, provider_config, namespace, images, app_config, secrets):
        # Resolve the provider-specific bits (here: a pull credential for GAR-hosted app images),
        # then delegate the identical workload-apply to the shared helper.
        pull = await resolve_gar_pull_credentials(provider_config)
        await app_deployment.apply_app_workloads(
            k8s_client, namespace, images, app_config, secrets,
            image_pull_credentials=pull,
        )

    async def expose_app(self, k8s_client, provider_config, namespace, app_config):
        # The genuinely GKE-specific part: a managed LB + ManagedCertificate for APP_DOMAIN,
        # rather than a NodePort. Returns the externally-reachable URL.
        domain = app_config.get("APP_DOMAIN")
        url = await ensure_gke_ingress_and_cert(k8s_client, namespace, domain)
        return {"url": url}
```

The host resolves the default `Cluster`'s provider and calls these two methods from its
`backend/bin/yf-deploy-app` orchestration entry point (run as an in-cluster Job in the
prod-minikube flow). A plugin never invokes them itself — it only implements them; the host's
entry point is the single call site. See the host repo's `docs/plans/app-deployment-hooks.md` for
the full design.

## Storage hooks

### `select_storage_backends`

Restricts which `StorageBackend`s a user may provision a new project's bucket on. This mirrors
`select_clusters` exactly, down to the `any_registered` fallback semantics: if **no** plugin
registers this hook, every active storage backend is allowed. If plugins are registered, the
union of what they return is the allowed set — a registered hook that legitimately returns an
empty set means "no backends allowed," not "fall back to all."

- **Caller:** `backend/models/storage_backend.py` `get_allowed_storage_backends()` — `await hooks.run_async.select_storage_backends(db, user)`. Called from both `GET
  /projects/{project_id}/utilities/available-storage-backends` (`backend/routers/utilities.py`,
  populates the picker the frontend calls before project creation) and the project-creation
  handler itself (`backend/routers/projects.py`, re-checks the chosen id is actually in the
  allowed set before provisioning)
- **Runner:** `run_async` (coroutines are awaited) — plugin implementations must define this hook
  as `async def`
- **Parameters:**
  - `db` (`sqlalchemy.ext.asyncio.AsyncSession`) — active database session
  - `user` (`backend.models.User`) — the requesting user
- **Returns:** `list[str]` — storage backend ids this plugin allows; the union across all
  registered plugins is the final allowed set

```python
async def select_storage_backends(db, user):
    if user.billing_account and user.billing_account.plan == "enterprise":
        return ["dedicated-backend-id"]
    return ["shared-backend-id"]
```

This is one of two matching "restrict to an allow-list" hooks — `select_clusters` (above) is the
other, for `Cluster` rather than `StorageBackend`. Both share the same shape: `run_async`, union of
plugin results, `any_registered`-gated fallback to "everything active" when no plugin answers at
all.

### `storage_protocol_handlers`

Registers `StorageProtocolHandler` implementations for `StorageBackend.protocol` values. Core
registers only one built-in handler, `s3`, through this exact same hook (see the host's root
`setup.py`) — a plugin adding a new protocol uses the identical channel core does, with no "core
is special" path. `minio` (`plugins/ymerflow-minikube`), `gcs` (`plugins/ymerflow-gcp`), and `az`
(`plugins/ymerflow-azure`) are examples of plugins doing exactly that, not anything core provides
— a stock install without those plugins has only `s3` available.

- **Caller:** `backend/services/storage_protocols/__init__.py` `get_protocol_handler()` — `hooks.run.storage_protocol_handlers()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `list[tuple[str, type]]` — `(protocol, StorageProtocolHandlerSubclass)` pairs. A duplicate `protocol` across plugins raises `ValueError`.

#### The `StorageBackend` row

Each admin-configured storage backend is a `StorageBackend` row (`backend/models/storage_backend.py`).
The fields a `StorageProtocolHandler` cares about:
- `protocol` (`str`) — the discriminator dispatched to `get_protocol_handler()`; this is the key you register under
- `endpoint` (`str | None`) — service URL (e.g. a MinIO endpoint); typically empty for real cloud protocols that resolve endpoints implicitly (GCS/S3 SDKs)
- `bucket_prefix` (`str`) — prefix used to derive a per-project bucket/container name
- `credential_strategy` (`str`, default `static-key`) — which `CredentialStrategy` (`backend/services/storage_credentials.py`) mints project credentials; `static-key` persists what `provision()` returns, other strategies call `mint()` per use
- `config` (`dict`, JSON column) — opaque, protocol-specific connection config (e.g. MinIO admin access/secret key); the admin UI's matching [`storage_protocol_forms`](frontend-hooks.md#storage_protocol_forms) entry is what edits this

#### `StorageProtocolHandler` base class

`backend.services.storage_protocols.StorageProtocolHandler` — subclass this and register an
instance's class via `storage_protocol_handlers`. The core operational methods (`provision`,
`mint`, `test_connection`, `storage_base_url`, `fsspec_kwargs`, `admin_credentials`) are
**required** (no defaults — protocols are too different from each other for a shared
implementation, unlike `ClusterProvider.test_connection`); `bootstrap`/`teardown` follow the same
optional, passthrough-by-default pattern as the other two axes.

- `provision(project, backend) -> dict` (sync) — one-time setup at project creation: bucket /
  service-account / policy creation. Returns credentials to persist for `static-key` use, or `{}`
  if this protocol never persists a long-lived credential.
- `mint(project, backend) -> dict` (sync) — mint a fresh credential on demand:
  `{"credentials": {...}, "expires_at": datetime | None}`. Only called for backends using a
  non-`static-key` credential strategy.
- `test_connection(backend) -> None` (async) — validate connectivity/credentials only, no side
  effects; safe to call repeatedly from the admin UI before any project exists to provision for.
- `storage_base_url(project, backend) -> str` (sync) — the `<scheme>://…` root a project's data
  lives under on this backend. One bucket per project, on every protocol, no exceptions — this
  *is* the access-control boundary: `<scheme>://<bucket_prefix><project_id>`. The bucket name
  embeds `project_id` so a bucket can be reverse-resolved back to its owning project.
- `fsspec_kwargs(backend, credentials, for_pod: bool = False) -> dict` (sync) — the fsspec kwargs
  to pass to `fsspec.open(url, **kwargs)`/`fsspec.filesystem(proto, **kwargs)` for the given
  credential set. Called with admin credentials (`admin_credentials(backend)`) for trusted
  backend-side I/O, and with project-scoped credentials for the untrusted pod/runner — the same
  code path serves both, with the caller choosing which creds to pass. `for_pod=True` signals the
  kwargs are for a job pod (in-cluster), so a handler whose pod-facing endpoint differs from its
  backend-facing one (e.g. MinIO's dev localhost vs. the in-cluster service DNS) can translate;
  handlers where the endpoint is the same everywhere (GCS/S3) ignore it.
- `admin_credentials(backend) -> dict` (sync) — the backend's own admin credential set, in the
  same shape `provision()`/`mint()` return (i.e. what `fsspec_kwargs(backend, credentials)`
  expects) — used for backend-side/trusted I/O, which is allowed to read/write any project's
  bucket on this backend because the backend enforces its own access control.
- `bootstrap(config: dict) -> dict` (sync) — see [The `bootstrap()` provisioning
  flow](#the-bootstrap-provisioning-flow) below.
- `teardown(config: dict) -> None` (sync) — the mirror of `bootstrap()`: removes the k8s-level
  resources `bootstrap()` created (namespaces, Deployments, Services, PV/PVC, etc.). Default is a
  no-op passthrough, exactly like `bootstrap()`'s default for core-provided handlers — a protocol
  that provisions nothing local (a managed object store) tears nothing down. Must be idempotent
  (safe to call when nothing is provisioned).
- `SECRET_CONFIG_KEYS` (class attribute, default `None`) — names of `config` keys that hold
  credential/secret material and must be masked as `"****"` in admin API responses. `None` (the
  default) means "mask every key" — the conservative default for any handler, including
  third-party plugins, that hasn't explicitly opted a key out.

```python
from backend.services.storage_protocols import StorageProtocolHandler

class AzureProtocolHandler(StorageProtocolHandler):
    def provision(self, project, backend) -> dict:
        # backend.endpoint / backend.bucket_prefix / backend.config are this row's fields —
        # read connection config from backend.config, never from global settings, so every
        # admin-added backend of this protocol is provisioned identically
        return create_container_and_credentials(
            project.id, backend.bucket_prefix, backend.config["account_key"],
        )

    def mint(self, project, backend) -> dict:
        raise NotImplementedError("short-lived Azure SAS token minting not implemented yet")

    async def test_connection(self, backend) -> None:
        client = get_azure_client(backend.endpoint, backend.config["account_key"])
        await asyncio.to_thread(lambda: client.list_containers())

    def bootstrap(self, config: dict) -> dict:
        # Most protocols never need this — return config unchanged, exactly like every
        # core-provided handler does. Only implement live provisioning here if config.env-driven
        # setup (via yf-bootstrap-provision) should do more than just persist the given
        # config as-is — e.g. creating a storage account here and folding its keys into the
        # returned config.
        return config

def storage_protocol_handlers():
    return [("azure", AzureProtocolHandler)]
```

This mirrors `plugins/ymerflow-minikube`'s `MinioProtocolHandler`
(`plugins/ymerflow-minikube/minikube_plugin/storage_protocol.py`) almost exactly — reading
connection config from `backend.config` (never from global settings) is
the load-bearing convention: it's what lets an admin register multiple backends of the same
protocol (e.g. two separate MinIO clusters) and have each provision independently.

There is no shared "storage client" class analogous to `K8sClient` — each protocol handler talks
to its own SDK directly (e.g. `minio.Minio`, `google.cloud.storage`) inside `provision()`/`mint()`/
`test_connection()`; only the `StorageProtocolHandler` method shape is standardized.

## Registry hooks

### `registry_protocol_handlers`

Registers `RegistryProtocolHandler` implementations for `RegistryBackend.protocol` values. This is
the third pluggable-backend axis, mirroring `storage_protocol_handlers` and
`cluster_provider_handlers` exactly — one active `RegistryBackend` row is used app-wide (there is
only ever one registry, not one per project or per cluster). Core registers **no** registry
protocol of its own — `registry_protocol_handlers()` returns `[]` in core (see the host's root
`setup.py`); a stock install needs a plugin for any registry option at all. `docker-v2` (wrapping a
self-hosted Docker Registry v2 instance, shipped by `plugins/ymerflow-minikube`) and `gar` (Google
Artifact Registry, shipped by `plugins/ymerflow-gcp`) are examples of plugins using this exact same
hook channel core would use if it registered anything itself, with no "core is special" path.

- **Caller:** `backend/services/registry_protocols/__init__.py` `get_registry_protocol_handler()` — `hooks.run.registry_protocol_handlers()`
- **Runner:** `run` (synchronous)
- **Parameters:** none
- **Returns:** `list[tuple[str, type]]` — `(protocol, RegistryProtocolHandlerSubclass)` pairs. A duplicate `protocol` across plugins raises `ValueError`.

#### The `RegistryBackend` row

The single, app-wide registry configuration is a `RegistryBackend` row
(`backend/models/registry_backend.py`). The fields a `RegistryProtocolHandler` cares about:
- `protocol` (`str`) — the discriminator dispatched to `get_registry_protocol_handler()`; this is the key you register under
- `config` (`dict`, JSON column) — opaque, protocol-specific connection config (e.g. `docker-v2`'s `user`/`password`/`host`/`port`); there is no admin-UI form hook for this yet (unlike `storage_protocol_forms`/`cluster_provider_forms`) — a plugin protocol's config is currently set via `config.env`'s `REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON` (see [The `bootstrap()` provisioning flow](#the-bootstrap-provisioning-flow) below) rather than through the admin UI

#### `RegistryProtocolHandler` base class

`backend.services.registry_protocols.RegistryProtocolHandler` — subclass this and register an
instance's class via `registry_protocol_handlers`. The core operational methods (`image_url`,
`image_prefix`, `pull_credentials`, `configure_push_auth`, `push_image`, `test_connection`) are
**required** (no defaults — same rationale as `StorageProtocolHandler`: protocols are too
different from each other for a shared implementation); `bootstrap`/`teardown` follow the same
optional, passthrough-by-default pattern as the other two axes.

- `image_url(config: dict, repository: str, tag: str) -> str` (sync) — the single place address
  *shape* is decided (mirrors `StorageProtocolHandler.storage_base_url`). `docker-v2` returns
  `host:port/repository:tag`. Every implementation is expected to return exactly
  `f"{self.image_prefix(config)}/{repository}:{tag}"`.
- `image_prefix(config: dict) -> str` (sync) — the part of `image_url()`'s address that comes
  before `/{repository}:{tag}`. `docker-v2` returns `host:port`; `gar` returns
  `location-docker.pkg.dev/project_id/repository` (GAR addresses under one fixed, bootstrapped
  repository — there is no bare host you can push arbitrary repository names under, unlike
  docker-v2's self-hosted registry). Callers that need to build a new image reference under a
  caller-chosen name (rather than calling `image_url()` with an already-known
  repository/tag) use this instead of assuming `image_url()`'s shape is just a host.
- `pull_credentials(config: dict) -> dict` (async) — resolve a pod image-pull credential. Returns
  `{"username": str, "password": str, "expires_at": datetime | None}`. Called by the host **per
  Job**, at Job-creation time, not once and cached — the host mints an ephemeral, Job-scoped
  `kubernetes.io/dockerconfigjson` Secret from this result and attaches it as that Job's
  `imagePullSecrets`, owned by the Job so it's garbage-collected alongside it. `expires_at=None`
  means "static credential, never refresh" (what `docker-v2` returns); a protocol with genuinely
  short-lived pull tokens (e.g. a GCP access token for GAR) returns its real expiry here — the host
  doesn't currently re-mint mid-Job on expiry, since `pull_credentials()` is only ever called once,
  at Job-creation time, so an `expires_at` shorter than a Job's expected runtime isn't useful yet.
- `configure_push_auth(config: dict) -> None` (sync) — perform whatever local `docker login` /
  credential-helper setup push-side tooling needs before a `docker push`. This is **not** called by
  the host directly — it's a helper a protocol's own `push_image()` implementation may call into
  internally if it needs it (e.g. the GCP plugin's `GarProtocolHandler.push_image()` calls its own
  `configure_push_auth()` to mint the OAuth2 token it then uses); `docker-v2` does today's `docker
  login host:port -u ... -p ...` inside its own `push_image()`.
- `push_image(local_image_ref: str, config: dict, repository: str, tag: str) -> str` (sync) — push
  a locally-built image (already present in the host's own Docker daemon, tagged
  `local_image_ref`) to this backend, resolving it under `repository:tag`. Returns the full pushed
  ref, mirroring `image_url()`'s return shape (every implementation is expected to return exactly
  `self.image_url(config, repository, tag)`). This is the real push entry point and is
  self-contained — it owns whatever authentication and TLS handling the push needs. The generic
  build-and-push entry point (`backend/bin/yf-build-and-push`) calls only this, never a
  separate `configure_push_auth()` step. `docker-v2` shells out to `docker save` + `crane push
  --insecure` with its own throwaway auth config, precisely so it does not depend on the host
  Docker daemon trusting its self-signed cert; a protocol backed by a real CA-issued cert (`gar`,
  `acr`) instead implements this as a plain `docker login`/`docker tag`/`docker push`.
- `test_connection(config: dict) -> None` (async) — raise a clear exception if this config can't
  actually reach/authenticate against a registry. No default implementation, same rationale as
  `StorageProtocolHandler.test_connection`.
- `bootstrap(config: dict) -> dict` (sync) — see [The `bootstrap()` provisioning
  flow](#the-bootstrap-provisioning-flow) below.
- `teardown(config: dict) -> None` (sync) — the mirror of `bootstrap()`: removes the k8s-level
  resources `bootstrap()` created (namespaces, Deployments, Services, etc.). Default is a no-op
  passthrough, exactly like `bootstrap()`'s default for core-provided handlers — a protocol that
  provisions nothing local (a managed registry) tears nothing down. Must be idempotent (safe to
  call when nothing is provisioned).

```python
from backend.services.registry_protocols import RegistryProtocolHandler

class GarProtocolHandler(RegistryProtocolHandler):
    def image_prefix(self, config: dict) -> str:
        # config is this RegistryBackend row's own config dict — e.g. {"location": "us",
        # "project": "my-gcp-project", "repository": "ymerflow"}
        return f"{config['location']}-docker.pkg.dev/{config['project']}/{config['repository']}"

    def image_url(self, config: dict, repository: str, tag: str) -> str:
        return f"{self.image_prefix(config)}/{repository}:{tag}"

    async def pull_credentials(self, config: dict) -> dict:
        token, expires_at = await mint_gcp_access_token(config)
        return {"username": "oauth2accesstoken", "password": token, "expires_at": expires_at}

    def configure_push_auth(self, config: dict) -> None:
        run_gcloud_auth_configure_docker(config)

    def push_image(self, local_image_ref: str, config: dict, repository: str, tag: str) -> str:
        # GAR presents a publicly-trusted cert, so a plain docker-side push works directly.
        self.configure_push_auth(config)
        ref = self.image_url(config, repository, tag)
        run(["docker", "tag", local_image_ref, ref])
        run(["docker", "push", ref])
        return ref

    async def test_connection(self, config: dict) -> None:
        await asyncio.to_thread(lambda: verify_gar_repository_reachable(config))

    def bootstrap(self, config: dict) -> dict:
        # Live-provisioning example (unlike the passthrough examples elsewhere in this doc):
        # config.env supplied just enough to know WHICH GAR repository to use; this creates it
        # if it doesn't exist yet and returns the enriched config yf-bootstrap-provision
        # persists onto the RegistryBackend row.
        ensure_gar_repository_exists(config)
        return config

def registry_protocol_handlers():
    return [("gar", GarProtocolHandler)]
```

There is no shared "registry client" class analogous to `K8sClient` — each protocol handler talks
to its own SDK/CLI directly inside its own methods; only the `RegistryProtocolHandler` method
shape is standardized. Unlike `docker-v2` (which keeps CA-pinning logic for its self-signed
certificate internal to its own handler), the ABC itself has **no concept of CA pinning or any
other TLS-trust mechanism** — a protocol with a normally CA-issued cert (like a real managed
registry) simply never implements anything resembling it.

## The `bootstrap()` provisioning flow

All three pluggable-backend axes — `RegistryProtocolHandler`, `StorageProtocolHandler`, and
`ClusterProvider` — share one more method beyond their protocol-specific operations:
`bootstrap(config: dict) -> dict` (storage/registry call the parameter `config`; `ClusterProvider`
calls it `provider_config` — same shape, different name to match each axis's existing
terminology). Every **core-provided** protocol/provider — `s3` (storage), `same-as-backend` and
`kubeconfig` (cluster); core registers no registry protocol at all — implements this as a pure
passthrough (`return config`) — there is nothing for core to provision, since core's cluster/
storage are stood up by separate setup scripts, not by this hook. A plugin protocol is free to do
real work here instead: provision a fresh cloud resource, mint a first credential, or anything else
config.env-driven setup should trigger automatically. `plugins/ymerflow-minikube`'s `minio`,
`docker-v2`, and `minikube` handlers are a live example of exactly that — their `bootstrap()`
brings up the host's own Minikube VM plus a MinIO/registry Deployment and returns real, freshly
minted credentials, not a passthrough.

**How it gets invoked.** The host application's `backend/bin/yf-bootstrap-provision` (a
standalone script, not a FastAPI route) is the one and only caller. For each axis, if the operator
set a matching pair of environment variables in `config.env` —
`REGISTRY_PROTOCOL`/`REGISTRY_CONFIG_JSON`, `STORAGE_PROTOCOL`/`STORAGE_CONFIG_JSON`, or
`CLUSTER_TYPE`/`CLUSTER_CONFIG_JSON` — the script parses `<AXIS>_CONFIG_JSON`, resolves your
handler/provider via the same `get_registry_protocol_handler()`/`get_protocol_handler()`/
`get_cluster_provider()` lookups described above, and calls `.bootstrap(parsed_config)`. The
enriched `{protocol, config}` result it returns is what ends up seeded onto the corresponding
default `RegistryBackend`/`StorageBackend`/`Cluster` row — in development this happens host-side,
right before migrations run; in a Kubernetes deployment the enriched result is folded into the
backend's config Secret/ConfigMap and consumed by the same generic Alembic seed migrations that run
inside the cluster. Your plugin's `bootstrap()` is never called from anywhere else, and is never
required to exist beyond the default `NotImplementedError` if you have nothing to provision — an
axis whose environment variable pair isn't set is skipped entirely, which is what keeps every
existing deployment (that never touches these variables) unaffected.

**What NOT to do in `bootstrap()`.** For the `ClusterProvider` axis specifically: your
`bootstrap()` should only ever produce/enrich the credential (e.g. `provider_config`) — it must
**not** itself call `ensure_cluster_job_ready()` (see [Job-readiness provisioning is
automatic](#job-readiness-provisioning-is-automatic) above). The host is responsible for calling
that, once, at the one place a `bootstrap()`-seeded default `Cluster` row's config actually becomes
active — duplicating that call inside your own `bootstrap()` would just make it run twice for no
benefit.

See the host repo's `docs/plans/done/registry-backend-hooks.md` for the full design rationale
behind this mechanism.
