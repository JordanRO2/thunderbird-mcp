# infrastructure/ — adapters + cross-cutting infra (DDD layer)

Wraps Thunderbird/XPCOM APIs and the cross-cutting concerns that used to live
inline in `api.js`. Nothing above this layer (application / interface) touches
XPCOM directly — it goes through an adapter registered here.

## Loading mechanism (no ES modules, no DI container)

A WebExtension Experiment API loads exactly ONE parent script (`api.js`) and
supports neither a multi-script manifest list nor `import`. The only available
mechanism is `Services.scriptloader.loadSubScript(resource://… , scope)` plus a
single shared `ctx` object that acts as the "DI container".

Every module here is a CommonJS file that exports a `register(ctx)` factory:

```js
"use strict";
module.exports = function register(ctx) {
  const { Services, Cc, Ci } = ctx;          // consume deps from ctx
  function doThing() { /* … */ }
  Object.assign(ctx, { doThing });           // register back onto ctx
};
```

`api.js` (inside its `start()`) loads each module with the same
`{ module: { exports: {} } }` scope shim it uses for `security_helpers.js`,
then calls `scope.module.exports(ctx)`.

## Load order (dependency order)

Infrastructure is loaded FIRST, in this order, because later modules consume
bindings the earlier ones register:

1. `services.js`   — XPCOM / MailServices / cal / gloda imports + low-level
                      stream helpers (`readRequestBody`, `paginate`).
2. `connection.js` — connection-file read/write + `timingSafeEqual`.
3. `auth.js`       — auth token generation / stable-token pref + `authToken`.
4. `audit.js`      — audit log append/read/clear, idempotency, rate limiter,
                     pref cache.
5. `access.js`     — account / tool / folder access control, `listAccounts`,
                     `listFolders`, `getAccountAccess`, shared body helpers.
6. `dispatch.js`   — `validateToolArgs`, `coerceToolArgs`, the `tools` schema
                     lookup, and the `registerToolHandler` / `callTool`
                     mechanism that interface modules plug into.

The `tools` METADATA array itself stays in `api.js`: a structural test
(`test/tool-access.test.cjs`) parses api.js source and asserts the count and
names of the `{ name: "…" }` declarations, so the registry literal must remain
there as the single source of truth. `dispatch.js` consumes `ctx.tools`.

See `../domain/README.md` and the contacts reference split for the per-domain
pattern (domain → application → infrastructure → interface).
