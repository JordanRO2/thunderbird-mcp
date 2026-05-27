# domain/ — entities, value objects, pure helpers (DDD layer)

Pure data shapes and pure functions. NO XPCOM, NO MailServices, NO services.
A domain module takes plain inputs and returns plain objects/strings.

- `entities/` — record builders / formatters per domain
  (e.g. `entities/contact.js` builds the plain `{ id, displayName, email, … }`
  contact record from a raw `nsIAbCard`-shaped input).

## Migration state

This directory currently holds BOTH the new pure entities AND the not-yet-
migrated legacy domain modules:

- `entities/contact.js` — migrated (reference domain).
- `contacts.js` — now a thin shim that loads the contacts service + interface
  layers and re-exports the 4 tool functions onto `ctx` (back-compat for the
  api.js load loop).
- `mail.js`, `compose.js`, `calendar.js`, `filters.js` — LEGACY. Each still
  mixes handler + orchestration + XPCOM and exports `register(ctx)`. Later
  agents migrate these into the 4 layers following the contacts pattern:
    domain/entities/<x>.js  +  application/<x>_service.js
    + infrastructure/<x>_adapter.js  +  interface/<x>_tools.js

## Loading

All domain modules are `register(ctx)` CommonJS factories loaded by api.js via
`Services.scriptloader.loadSubScript` + a `{ module: { exports: {} } }` scope.
Pure entity modules (`entities/*`) are loaded by whichever layer needs them
(the contacts adapter/service load `entities/contact.js`).
