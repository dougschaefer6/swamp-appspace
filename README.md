# @dougschaefer/appspace

Swamp extension for Appspace Cloud v3 — administration toolkit covering
digital-signage devices, room reservations and events, the user directory,
visitor management with native walk-in routing, and the full custom card
development lifecycle (including pulling existing cards from a tenant for
customization).

## Models

| Model | Purpose | Methods |
|---|---|---|
| `@dougschaefer/appspace-device` | Manage Appspace-managed display devices | list, get, getStatuses, getProperties, setProperties, deleteProperties, sendCommand, getConfiguration, screenCapture, listGroups, sync, listIntegrations, listTaskDeployments, createTaskDeployment, getTaskResponses |
| `@dougschaefer/appspace-reservation` | Room reservations, events, resources | listEvents, getEvent, cancelEvent, endEvent, extendEvent, releaseEvent, checkinEvent, listReservations, getReservation, createReservation, updateReservation, deleteReservation, listReservableResources, getMyEvents, checkUserAvailability, getSchedule |
| `@dougschaefer/appspace-user` | User directory + groups | list, get, findByEmail, me, listGroups, getGroupMembers |
| `@dougschaefer/appspace-visitor` | Visitor Management + walk-in DropIn workflow | list, get, create, delete, getConfiguration, createDropInInvitation, listEvents, checkin, checkout |
| `@dougschaefer/appspace-card` | Custom card development + REST instance management | scaffold, pullCard, validate, build, package, listTemplateTypes, listTemplates, getTemplate, createTemplate, updateTemplate |

### Walk-in workflow (one method call)

```bash
swamp model method run my-visitor createDropInInvitation --input '{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "company": "ACME Corp",
  "notes": "Vendor demo for AV upgrade",
  "hostUserId": "<appspace-user-uuid>",
  "hostEmail": "FrontDesk@customer.com",
  "durationMinutes": 15,
  "timezone": "America/New_York"
}'
```

This creates the visitor record + a DropIn invitation in one shot. Appspace's
configured Notifications (Teams Passport bot, Appspace app push, Concierge
fan-out, email) handle routing automatically — **no card-side webhook
required**. Configure your notification routing in `Admin > Notifications` and
your concierge assignments in `Admin > Reservations > Concierge`.

### Card customization workflow (replaces the manual curl-loop staging)

```bash
# 1. Find the card you want to customize
swamp model method run my-card listTemplates --input '{"maxItems":50}'

# 2. Pull all source files from the tenant (includes platform bundles for offline editing)
swamp model method run my-card pullCard --input '{
  "templateId": "<card-template-uuid>",
  "destDir": "cards/my-customization",
  "includeAssets": true
}'

# 3. Edit the customer files (manifest.json, schema.json, model.json, your *-patch.js)
# 4. Validate the Big Three for consistency
swamp model method run my-card validate --input '{"path":"cards/my-customization"}'

# 5. Package as a .zip ready for upload
swamp model method run my-card package --input '{
  "sourceDir": "cards/my-customization",
  "outputZip": "dist/my-customization.zip"
}'

# 6. Upload via Appspace console: Library > Cards > Upload (the v3 API does
#    NOT expose a card-template-type upload endpoint — POST cardtemplatetypes
#    returns 405 Method Not Allowed.)
```

## Card customization pitfalls (read before re-basing on a customer's card)

These are lessons from real customization work that would otherwise cost hours
of debugging.

### 1. Customer-modified cards may have stripped bundles

Appspace's official Visitor Kiosk Card ships ~340 files (~50MB unpacked) —
icon fonts, 25 language translation dictionaries, ~150 React components,
help text, configcat, smcta SVGs. When customers customize and re-upload a
card, their build process often strips dynamically-loaded files (anything not
referenced statically from `index.html`). The card *runs*, but with broken
icons (missing fonts), untranslated keys (missing `console/lang/*.json`), and
missing UI components.

**`pullCard` follows what's referenced from index.html — it can't see
dynamically-loaded files.** If you `pullCard` a customer's customized card to
re-base on, you inherit their stripped bundle. To avoid:

- For an established Appspace card type (Visitor Kiosk, Banner, Counter, Alert,
  etc.), **download the official template type's full bundle as a fresh
  upload** from the Appspace console instead of pulling from a customer
  variant. Apply the customer's customization JS patch on top.
- A bundle with fewer than ~100 files is suspiciously thin for a major card
  type. If `pullCard` returns 22 files, you almost certainly have a stripped
  bundle.

### 2. AngularJS template overrides — `$templateCache` races

The customer-bundled `templates-*.js` registers all card templates against a
specific module (often `as.console`). If your patch puts a template into
`$templateCache` from a different module's `.run()` block, AngularJS
load-order doesn't guarantee yours wins. Symptom: your customizations don't
appear at runtime, even though the patch script clearly loads.

**Robust pattern**: use `$provide.decorator()` to override the *directive
definition object* directly:

```js
angular.module("as.guests").config(["$provide", function ($provide) {
  $provide.decorator("yourDirectiveDirective", ["$delegate", function ($delegate) {
    var ddo = $delegate[0];
    ddo.template = "<div>...</div>";  // inline template — bypasses $templateCache
    delete ddo.templateUrl;
    ddo.controller = ["yourDeps", function (yourDeps) { /* ... */ }];
    return $delegate;
  }]);
}]);
```

This sets the template on the directive itself; nothing else can override it.

### 3. New screens — use UI Router states, not in-place ng-show toggles

If your customization adds a new "screen" (form, confirmation, etc.), register
it as a new state via `$stateProvider.state(...)` in a config block on
`as.guests`:

```js
angular.module("as.guests").config(["$stateProvider", function ($stateProvider) {
  $stateProvider.state("guests.visitors.kiosk.walkin", { component: "visitorsKioskWalkin" });
}]);
```

Navigate with `visitorKioskHelper.goNext("walkin")`. This makes your screen
behave like a real kiosk state — the Cancel/Back buttons in the kiosk shell
auto-render, the state machine handles transitions, and your component lifecycle
runs (`$onInit`, `$onDestroy`).

### 4. CSS injection timing

If you need to inject CSS to hide platform UI elements, the `<style>` tag
needs to land in `document.head` AFTER all platform stylesheets, with
sufficient selector specificity to win. Some kiosk runtimes don't have
`document.head` ready when the patch script first runs — inject from BOTH a
synchronous IIFE (works for normal browsers) AND a `.run()` block fired
through `$timeout(0)` after Angular bootstrap (catches the late-DOM cases).

### 5. Hidden v3 endpoints

The public OpenAPI at `/api/v3/<service>/openapi` significantly
underrepresents the API surface. Notable hidden endpoints we discovered by
reading the bundled JS:

- `POST /api/v3/visitormanagement/visitors` — create a visitor (OpenAPI only
  shows DELETE/PATCH on `/visitors/{id}`)
- `POST /api/v3/visitormanagement/invitations` — create an invitation
  (`type: "DropIn"` for walk-ins). This is what fires the host-notification
  chain (Teams Passport bot, Concierge fan-out, Appspace app push, email).

When the public OpenAPI says something is impossible, grep the card bundle's
`app-*-min.js` for the function name; the real endpoint is usually there.

## Authentication

Appspace API v3 uses a Subject ID + Refresh Token pair. Both are issued at
token creation time and **the refresh token is shown only once** — capture both
values immediately.

1. In the Appspace console: **Admin → Integrations → API Tokens → +ADD**
2. Name the token, attach it to a Service Account user with appropriate
   permissions (User Reader, Device Reader, Reservation Reader/Writer, etc.)
3. On the confirmation screen, copy **both** the Subject ID and the Refresh
   Token. Save the Refresh Token immediately — it cannot be retrieved later.

Store credentials in a swamp vault:

```bash
swamp vault create local_encryption appspace
echo -n "<subject-id-uuid>"       | swamp vault put appspace subject-id
echo -n "<refresh-token-uuid>"    | swamp vault put appspace refresh-token
echo -n "https://<tenant>.cloud.appspace.com" | swamp vault put appspace base-url
```

The `base-url` differs by tenant — public cloud is
`https://api.cloud.appspace.com`, dedicated tenants use the form
`https://appNN.cloud.appspace.com` (your specific cluster — replace `NN` with
the number assigned to your tenant).

## Configuration in models

All three models share global arguments resolved from the vault:

```yaml
attributes:
  subjectId:    "${{ vault.get(appspace, subject-id) }}"
  refreshToken: "${{ vault.get(appspace, refresh-token) }}"
  baseUrl:      "${{ vault.get(appspace, base-url) }}"
```

Access tokens are exchanged automatically and cached in-process for ~1 hour
(the lifetime returned by Appspace, minus a 60-second safety buffer).

## Token permissions

The Service Account user the token impersonates inherits its scopes from the
account user object. For full coverage:

- Device management — User Manager + Device Reader/Writer
- Reservation management — Reservation Reader/Writer
- Card management — Library Reader/Writer

Operational methods (sendCommand, createTaskDeployment, deleteReservation)
require write scopes; queries are read-only.

## Custom card development

Custom card development on Appspace has one important hard limit:

**`POST /api/v3/libraries/cardtemplatetypes` is not exposed in the public v3
API (HTTP 405).** A new card template type can only be registered by uploading
the .zip via the Appspace console (`Library > Cards > Upload`). After that
one-time step, all instance management is REST-driven.

The `appspace-card` model bridges this gap:

1. **Build locally**: `scaffold` → edit → `validate` → (optional `build`) →
   `package`. The `package` method emits a .zip with the contents-not-folder
   gotcha handled, plus the `Big Three` JSON files lined up correctly.
2. **Register via console**: upload the .zip in `Library > Cards > Upload`.
3. **Manage via REST**: `listTemplateTypes` to find the new
   `cardTemplateTypeId`, then `createTemplate` / `updateTemplate` to spin up
   configured instances and push them to channels and devices.

### The "Big Three" files

Every card requires three JSON files plus an `index.html` entry point:

- `manifest.json` — card identity (Id, Name, Version, Startup, Schema, Model,
  Thumbnail, DisplayFormats, Network.RequiresConnection, BaseCardTemplate, and
  optional CloudScopes/ConstellationScopes/TopicSubscriptions/Passports).
- `schema.json` — defines the admin-facing configuration form. Supports 19+
  input types (textbox, richtext, fileupload, fontupload, colorpicker, radio,
  dropdown, multiselect, celldata, datepicker, duration, toggle, checkbox,
  textstyle, background, label, text, tagsinput, textarea), input grouping,
  conditional visibility (`conditions` DSL), validation, and separate
  `editor`/`themeeditor` views.
- `model.json` — default values matching schema input names. The Golden Rule:
  every named schema input must have a matching `model.inputs.<name>.value`.

The scaffold method emits a minimal vanilla-HTML/JS card that needs no build
step. Add a React or Angular layer if your card grows beyond a couple of
inputs.

### Player Properties (per-device overrides)

Cards can read per-device key/value overrides at runtime via `model.playerProperties`.
The `appspace-device` model's `setProperties` method sets these — useful for
storing API credentials or content URLs that vary by location:

```bash
swamp model method run my-device setProperties --input '{
  "deviceId": "<uuid>",
  "properties": {
    "datasourceurl": "https://signage.example.com/lobby-feed.json",
    "appspace.api.baseurl": "https://appNN.cloud.appspace.com"
  }
}'
```

Property names are **case-sensitive and always lowercase** even when the schema
uses camelCase.

## Service availability

The following v3 services are modeled by this extension and have been verified
functional: `authorization`, `users`, `reservation`, `channeldirectory`,
`channelplaylist`, `livechannel`, `contentfeed`, `libraries`, `devices`,
`visitormanagement`. The `signschannel` (Advanced Channel) service returned
500 InternalServerError on the tenant used for development and is not modeled
here. Service availability may vary by tenant version — if a method
unexpectedly errors, check `/api/v3/<service>/openapi` on your tenant.

The deprecated `app9.cloud.appspace.com/docs` API is not used and should not
be referenced — it lists services (networks, spaces, accounts, applications,
campaigns, notifications, webhooks, system actions) that are not present in
v3.
