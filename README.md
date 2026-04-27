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
