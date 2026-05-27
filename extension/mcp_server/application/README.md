# application/ — per-domain services (DDD layer)

Orchestration. A service coordinates infrastructure adapters and domain
entities to fulfil a use-case. It contains the body logic that used to live
inside each tool handler, MINUS the direct XPCOM calls (those moved to an
`infrastructure/*_adapter.js`) and MINUS the pure shaping (that moved to
`domain/entities/*`).

Rules:
- No direct XPCOM. Call an `infrastructure/*_adapter.js` instead.
- No MCP/transport concerns (arg validation, dispatch) — that is the interface
  layer's job.
- Register as a `register(ctx)` module; pull the adapter + guards it needs from
  `ctx`; assign the service object back onto `ctx`.

Loaded AFTER infrastructure, BEFORE interface. See
`application/contacts_service.js` for the reference implementation.
