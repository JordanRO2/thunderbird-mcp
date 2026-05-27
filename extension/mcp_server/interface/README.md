# interface/ — MCP tool handlers (DDD layer)

The thin edge that the dispatch switch calls. A handler:
1. takes the raw tool arguments,
2. does any handler-level argument shaping (none beyond what the central
   `validateToolArgs` / `coerceToolArgs` already did),
3. calls an `application/*_service.js` method,
4. returns the result object verbatim.

No orchestration, no XPCOM. Handlers are registered onto `ctx` via
`register(ctx)` and wired into dispatch through `ctx.registerToolHandler(name,
fn)` (see `infrastructure/dispatch.js`).

## tools metadata

Each interface module also documents its tool metadata as a `*_TOOL_DEFS`
constant (name/group/crud/title/description/inputSchema) so a reader can see
the whole domain in one file. The LIVE `tools` array, however, stays in
`api.js`: a structural test parses api.js source for the `{ name: "…" }`
declarations, so that array is the guarded single source of truth. When you
migrate a domain, keep its metadata literal in api.js's `tools` array and mirror
it here for documentation; do not delete it from api.js.

Loaded LAST (after infrastructure + application). See
`interface/contacts_tools.js` for the reference implementation.
