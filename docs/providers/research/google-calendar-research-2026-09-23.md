# Google Calendar + Google Meet booking integration — documentation research

Research date: **2026-09-23**. Target: server-side Node.js integration using the `googleapis` npm package.

## 0. How this was verified (read this first)

Every `developers.google.com` page in the brief is **blocked by this session's egress proxy** (HTTP 403 on CONNECT, organization policy). Also blocked: `developers.google.cn` (Google's own mirror), `support.google.com`, `groups.google.com`, `discuss.google.dev`, `web.archive.org`, `googleapis.github.io`, `googleapis.dev`, `cdn.jsdelivr.net`, `cli.nylas.com`, `www.codewords.ai`. I did not retry blocked hosts beyond one attempt each.

What **was** reachable, and is used as the evidence base:

| Source | What it is | Label used below |
|---|---|---|
| `https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest` — **revision `20260826`** (fetched 2026-09-23, 169,810 bytes) | Google's machine-readable Calendar v3 API description. The reference pages (`/reference/events`, `/reference/freebusy/query`, …) are generated from this document, so field/parameter descriptions, enums and per-method scopes below are the **same text** the reference pages show. | **Verified 2026-09-23 (discovery)** |
| `https://accounts.google.com/.well-known/openid-configuration` | Google's OAuth 2.0 / OIDC discovery document (endpoints, PKCE methods). | **Verified 2026-09-23 (OIDC)** |
| npm registry (direct, not proxied): `googleapis@181.0.0` (published 2026-09-14), `@googleapis/calendar@20.0.0`, `google-auth-library@11.1.0`, `googleapis-common@9.1.0` — README + compiled source + `.d.ts` | Official Google Node.js libraries. JSDoc in `google-auth-library` mirrors the OAuth docs' parameter text. | **Verified 2026-09-23 (lib)** |
| `github.com/googleapis/google-api-nodejs-client` README, `github.com/googleapis/google-auth-library-nodejs` README, `raw.githubusercontent.com/googleworkspace/node-samples/main/calendar/quickstart/index.js`, `raw.githubusercontent.com/googleapis/google-auth-library-nodejs/main/samples/oauth2-codeVerifier.js`, `raw.githubusercontent.com/googleapis/google-api-nodejs-client/main/samples/oauth2.js` | Official Google READMEs and samples. | **Verified 2026-09-23 (lib)** |
| WebSearch result snippets attributed to the official pages | Partial, model-summarised text. Treat as *likely correct but unconfirmed against the live page*. | **Search snippet only — NOT VERIFIED** |
| Nothing fetched; from the brief or general knowledge | Explicitly flagged. | **NOT VERIFIED** |

Bottom line: **everything about request/response shapes, enums, field semantics and scopes is verified from Google's own discovery document; the guide-only prose (push-notification operational rules, OAuth page wording, scope sensitivity labels) is only partially verified and is flagged item by item.**

---

## 1. OAuth 2.0 for Web Server Applications

Page: `https://developers.google.com/identity/protocols/oauth2/web-server` — **FETCH BLOCKED (egress policy)**. Items below are verified from the OIDC discovery document and the official library source/READMEs, which reproduce the page's parameter text.

### 1.1 Endpoints — Verified 2026-09-23 (OIDC + lib)

Verbatim from `https://accounts.google.com/.well-known/openid-configuration`:

```json
{
  "issuer": "https://accounts.google.com",
  "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
  "token_endpoint": "https://oauth2.googleapis.com/token",
  "revocation_endpoint": "https://oauth2.googleapis.com/revoke",
  "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
  "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
  "response_types_supported": ["code", "token", "id_token", "code token", "code id_token", "token id_token", "code token id_token", "none"],
  "grant_types_supported": ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
  "code_challenge_methods_supported": ["plain", "S256"],
  "scopes_supported": ["openid", "email", "profile"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]
}
```

`google-auth-library@11.1.0` `build/src/auth/oauth2client.js` (verbatim defaults):

```js
tokenInfoUrl: 'https://oauth2.googleapis.com/tokeninfo',
oauth2AuthBaseUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
oauth2TokenUrl: 'https://oauth2.googleapis.com/token',
oauth2RevokeUrl: 'https://oauth2.googleapis.com/revoke',
```

### 1.2 Authorization request parameters — Verified 2026-09-23 (lib JSDoc, `GenerateAuthUrlOpts` in `oauth2client.d.ts`)

The library's JSDoc is the doc page's text. Quoted verbatim (abridged where marked `…`):

- `client_id` — "The client ID for your application. The value passed into the constructor will be used if not provided."
- `redirect_uri` — "Determines where the API server redirects the user after the user completes the authorization flow. The value must exactly match one of the 'redirect_uri' values listed for your project in the API Console. Note that the http or https scheme, case, and trailing slash ('/') must all match."
- `response_type` — "The 'response_type' will always be set to 'CODE'." (i.e. `response_type=code`).
- `scope` — "Required. A space-delimited list of scopes that identify the resources that your application could access on the user's behalf. … We recommend that your application request access to authorization scopes in context whenever possible. By requesting access to user data in context, via incremental authorization, you help users to more easily understand why your application needs the access it is requesting." (Library accepts `string[] | string`.)
- `access_type` — "Recommended. Indicates whether your application can refresh access tokens when the user is not present at the browser. Valid parameter values are 'online', which is the default value, and 'offline'. Set the value to 'offline' if your application needs to refresh access tokens when the user is not present at the browser. This value instructs the Google authorization server to return a refresh token and an access token the first time that your application exchanges an authorization code for tokens."
- `state` — "Recommended. Specifies any string value that your application uses to maintain state between your authorization request and the authorization server's response. The server returns the exact value that you send as a name=value pair … after the user consents to or denies your application's access request. You can use this parameter for several purposes, such as directing the user to the correct resource in your application, sending nonces, and mitigating cross-site request forgery. Since your redirect_uri can be guessed, using a state value can increase your assurance that an incoming connection is the result of an authentication request. If you generate a random string or encode the hash of a cookie or another value that captures the client's state, you can validate the response to additionally ensure that the request and response originated in the same browser, providing protection against attacks such as cross-site request forgery."
- `include_granted_scopes` — "Optional. Enables applications to use incremental authorization to request access to additional scopes in context. If you set this parameter's value to true and the authorization request is granted, then the new access token will also cover any scopes to which the user previously granted the application access."
- `login_hint` — "Optional. If your application knows which user is trying to authenticate, it can use this parameter to provide a hint to the Google Authentication Server. … Set the parameter value to an email address or sub identifier".
- `prompt` — "Optional. A space-delimited, case-sensitive list of prompts to present the user. If you don't specify this parameter, the user will be prompted only the first time your app requests access. Possible values are: 'none' … 'consent' - Prompt the user for consent. 'select_account' - Prompt the user to select an account."
- `hd` — hosted-domain UI hint; "Don't rely on this UI optimization to control who can access your app".
- `code_challenge_method` — "Recommended. Specifies what method was used to encode a 'code_verifier' that will be used during authorization code exchange. This parameter must be used with the 'code_challenge' parameter. The value of the 'code_challenge_method' defaults to "plain" if not present in the request that includes a 'code_challenge'. The only supported values for this parameter are "S256" or "plain"."
- `code_challenge` — "Recommended. Specifies an encoded 'code_verifier' that will be used as a server-side challenge during authorization code exchange."
- `enable_granular_consent` — **Search snippet only — NOT VERIFIED**: snippets (from `…/oauth2/resources/granular-permissions`) say set `enable_granular_consent=true` to opt into granular consent; "When Google enables granular permissions for an application, the enable_granular_consent parameter will no longer have any effect"; apps requesting several scopes "must verify which scopes were actually granted" (check the `scope` field of the token response). The library's `GenerateAuthUrlOpts` accepts arbitrary extra keys, so `enable_granular_consent: true` can be passed.

### 1.3 Token endpoint — exchange and refresh — Verified 2026-09-23 (lib source)

Code exchange (`getTokenAsync`, verbatim body construction):

```js
const values = {
  client_id: options.client_id || this._clientId,
  code_verifier: options.codeVerifier,
  code: options.code,
  grant_type: 'authorization_code',
  redirect_uri: options.redirect_uri || this.redirectUri,
};
// client_secret is sent in the POST body by default (ClientSecretPost); 'basic' sends an Authorization: Basic header
```

i.e. `POST https://oauth2.googleapis.com/token` with `application/x-www-form-urlencoded` body `code, client_id, client_secret, redirect_uri, grant_type=authorization_code[, code_verifier]`.

Refresh (`refreshTokenNoCache`, verbatim):

```js
const data = {
  refresh_token: refreshToken,
  client_id: this._clientId,
  client_secret: this._clientSecret,
  grant_type: 'refresh_token',
};
```

Token response fields as typed by the library (`credentials.d.ts`, `Credentials`): `access_token`, `refresh_token`, `expiry_date` (the library converts `expires_in` seconds to an absolute ms timestamp: `tokens.expiry_date = Date.now() + res.data.expires_in * 1000; delete tokens.expires_in;`), `token_type`, `id_token`, `scope`. The raw HTTP response carries `expires_in` (seconds). **NOT VERIFIED**: the commonly cited lifetime (~3600 s); do not hard-code it — use `expires_in`/`expiry_date`.

### 1.4 Refresh-token behaviour — Verified 2026-09-23 (lib READMEs)

`googleapis` README (verbatim):

> **IMPORTANT NOTE** - The `refresh_token` is only returned on the first authorization.

> This tokens event only occurs in the first authorization, and you need to have set your `access_type` to `offline` when calling the `generateAuthUrl` method to receive the refresh token. If you have already given your app the requisite permissions without setting the appropriate constraints for receiving a refresh token, you will need to re-authorize the application to receive a fresh refresh token. You can revoke your app's access to your account [here](https://myaccount.google.com/permissions).

> Refresh tokens may stop working after they are granted, either because:
> - The user has revoked your app's access
> - The refresh token has not been used for 6 months
> - The user changed passwords and the refresh token contains Gmail scopes
> - The user account has exceeded a max number of live refresh tokens
> - The application has a status of 'Testing' and the consent screen is configured for an external user type, causing the token to expire in 7 days
>
> As a developer, you should write your code to handle the case where a refresh token is no longer working.

`google-auth-library` README (verbatim): "If you need to obtain a new `refresh_token`, ensure the call to `generateAuthUrl` sets the `access_type` to `offline`. The refresh token will only be returned for the first authorization by the user. To force consent, set the `prompt` property to `consent`".

**Search snippet only — NOT VERIFIED**: the per-client cap is reported as "a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new refresh token automatically invalidates the oldest refresh token without warning" (older docs said 50 — the brief's number). Design for it either way: always persist the newest refresh token from the `tokens` event.

### 1.5 `invalid_grant`

- Verified 2026-09-23 (lib README): the five "refresh tokens may stop working" causes above (revoked, 6 months unused, password change + Gmail scopes, token cap, Testing-status 7-day expiry) are what surface as `invalid_grant` on refresh. The library special-cases `invalid_grant` whose `error_description` matches `/ReAuth/i` (re-authentication required) by putting the full error JSON in `e.message` (`oauth2client.js` lines ~262-266).
- **NOT VERIFIED** (page blocked; commonly cited): an authorization `code` that was already used or expired, a `redirect_uri` that does not match the one used in the auth request, and server clock skew also produce `invalid_grant`. Handle `invalid_grant` on refresh by marking the connection as needing re-authorization and sending the user through the consent flow again with `prompt=consent`.

### 1.6 Revocation — Verified 2026-09-23 (OIDC + lib)

Endpoint `https://oauth2.googleapis.com/revoke`. Library implementation (verbatim): `url.searchParams.append('token', token)` then `method: 'POST'` → `POST https://oauth2.googleapis.com/revoke?token=<access_or_refresh_token>`. `oauth2Client.revokeToken(token)` and `oauth2Client.revokeCredentials()` (revokes `credentials.access_token` and clears the credentials object; throws `'No access token to revoke.'` if none).
**Search snippet only — NOT VERIFIED**: "If the token is an access token and it has a corresponding refresh token, the refresh token will also be revoked"; success is HTTP 200, errors HTTP 400.

### 1.7 Incremental authorization — Verified 2026-09-23 (lib JSDoc)
`include_granted_scopes: true` on `generateAuthUrl` (see 1.2). Verify what was actually granted via the `scope` field of the token response or `oauth2Client.getTokenInfo(accessToken).scopes` (README: "take a look at the scopes originally provisioned for the access token").

### 1.8 PKCE for web-server apps — Verified 2026-09-23 (OIDC + lib + official sample)
Google's token endpoint advertises `code_challenge_methods_supported: ["plain","S256"]`, and the official web-server library flow supports it end to end. Official sample `samples/oauth2-codeVerifier.js` (verbatim):

```js
const codes = await oAuth2Client.generateCodeVerifierAsync();
const authorizeUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: 'https://www.googleapis.com/auth/userinfo.profile',
  code_challenge_method: 'S256',
  code_challenge: codes.codeChallenge,
});
// ...
const r = await oAuth2Client.getToken({
  code,
  codeVerifier: codes.codeVerifier,
});
```

**NOT VERIFIED**: whether the web-server doc page itself *recommends* PKCE for confidential clients (the page is blocked; the search snippet that describes PKCE is from the native-app page). It works for web-server clients (`GetTokenOptions.codeVerifier` is in the public API) and is harmless to add alongside `client_secret`.

### 1.9 Security guidance — Verified 2026-09-23 (lib JSDoc)
`state` for CSRF (quoted in 1.2). Also from `GetTokenOptions`: `client_id`/`redirect_uri` passed to `getToken` "Must match any … option passed to a corresponding call to generateAuthUrl."

### 1.10 Token expiry and auto-refresh — Verified 2026-09-23 (lib source)
`AuthClient` defaults: `DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = 5 * 60 * 1000` and `forceRefreshOnFailure = false`. `isTokenExpiring()` returns true when `expiry_date <= Date.now() + eagerRefreshThresholdMillis`. Before each request, if there is no `access_token` or it is expiring, the client refreshes using `credentials.refresh_token` (throws `'No refresh token is set.'` if absent) and emits `'tokens'`. `refreshAccessToken()` still exists in 11.1.0 and is **not** marked `@deprecated` in the `.d.ts`; it refreshes explicitly and re-attaches the stored `refresh_token` to the new credentials.

### 1.11 Node.js samples — Verified 2026-09-23 (googleapis README, verbatim)

```js
const {google} = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  YOUR_CLIENT_ID,
  YOUR_CLIENT_SECRET,
  YOUR_REDIRECT_URL
);

// generate a url that asks permissions for Blogger and Google Calendar scopes
const scopes = [
  'https://www.googleapis.com/auth/blogger',
  'https://www.googleapis.com/auth/calendar'
];

const url = oauth2Client.generateAuthUrl({
  // 'online' (default) or 'offline' (gets refresh_token)
  access_type: 'offline',

  // If you only need one scope, you can pass it as a string
  scope: scopes
});
```

```
    GET /oauthcallback?code={authorizationCode}
```

```js
// This will provide an object with the access_token and refresh_token.
// Save these somewhere safe so they can be used at a later time.
const {tokens} = await oauth2Client.getToken(code)
oauth2Client.setCredentials(tokens);
```

```js
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    // store the refresh_token in my database!
    console.log(tokens.refresh_token);
  }
  console.log(tokens.access_token);
});
```

```js
oauth2Client.setCredentials({
  refresh_token: `STORED_REFRESH_TOKEN`
});
```

> Once the client has a refresh token, access tokens will be acquired and refreshed automatically in the next call to the API.

---

## 2. Calendar API scopes

Page: `https://developers.google.com/workspace/calendar/api/auth` — **FETCH BLOCKED**. Scope list and per-method scope requirements are **Verified 2026-09-23 (discovery, rev 20260826)** — the discovery document's `auth.oauth2.scopes` and each method's `scopes` array. Sensitivity labels are **NOT VERIFIED** (see 2.5).

### 2.1 All 17 scopes (verbatim descriptions)

| Scope | Description |
|---|---|
| `https://www.googleapis.com/auth/calendar` | See, edit, share, and permanently delete all the calendars you can access using Google Calendar |
| `https://www.googleapis.com/auth/calendar.readonly` | See and download any calendar you can access using your Google Calendar |
| `https://www.googleapis.com/auth/calendar.events` | View and edit events on all your calendars |
| `https://www.googleapis.com/auth/calendar.events.readonly` | View events on all your calendars |
| `https://www.googleapis.com/auth/calendar.events.owned` | See, create, change, and delete events on Google calendars you own |
| `https://www.googleapis.com/auth/calendar.events.owned.readonly` | See the events on Google calendars you own |
| `https://www.googleapis.com/auth/calendar.events.freebusy` | See the availability on Google calendars you have access to |
| `https://www.googleapis.com/auth/calendar.freebusy` | View your availability in your calendars |
| `https://www.googleapis.com/auth/calendar.events.public.readonly` | See the events on public calendars |
| `https://www.googleapis.com/auth/calendar.calendarlist` | See, add, and remove Google calendars you're subscribed to |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | See the list of Google calendars you're subscribed to |
| `https://www.googleapis.com/auth/calendar.calendars` | See and change the properties of Google calendars you have access to, and create secondary calendars |
| `https://www.googleapis.com/auth/calendar.calendars.readonly` | See the title, description, default time zone, and other properties of Google calendars you have access to |
| `https://www.googleapis.com/auth/calendar.acls` | See and change the sharing permissions of Google calendars you own |
| `https://www.googleapis.com/auth/calendar.acls.readonly` | See the sharing permissions of Google calendars you own |
| `https://www.googleapis.com/auth/calendar.settings.readonly` | View your Calendar settings |
| `https://www.googleapis.com/auth/calendar.app.created` | Make secondary Google calendars, and see, create, change, and delete events on them |

### 2.2 (a) Reading free/busy only — Verified 2026-09-23 (discovery)
`freebusy.query` accepts exactly: `calendar`, `calendar.events.freebusy`, `calendar.freebusy`, `calendar.readonly`.
Minimal choice: **`https://www.googleapis.com/auth/calendar.freebusy`** (the user's own calendars) or `calendar.events.freebusy` (calendars the user has access to; this one is *also* accepted by `events.list`/`events.get`/`events.watch`, whereas `calendar.freebusy` is not).

### 2.3 (b) Creating/updating/deleting events — Verified 2026-09-23 (discovery)
`events.insert`, `events.patch`, `events.update`, `events.delete` all accept exactly: `calendar`, `calendar.app.created`, `calendar.events`, `calendar.events.owned`.
- **`calendar.events.owned`** — narrowest for writing to calendars the user owns (e.g. `primary`).
- `calendar.events` — needed if the target calendar is one the user can write to but does not own (shared/team calendar).
- `calendar.app.created` — only events on secondary calendars the app itself created.
- `calendar` — full access; avoid.

### 2.4 (c) Listing calendars — Verified 2026-09-23 (discovery)
`calendarList.list` accepts exactly: `calendar`, `calendar.calendarlist`, `calendar.calendarlist.readonly`, `calendar.readonly`.
Minimal: **`https://www.googleapis.com/auth/calendar.calendarlist.readonly`**. (`calendars.get` — properties/time zone of one calendar — accepts `calendar`, `calendar.app.created`, `calendar.calendars`, `calendar.calendars.readonly`, `calendar.readonly`.)

A booking app therefore needs at minimum: `calendar.calendarlist.readonly` + `calendar.freebusy` (or `calendar.events.freebusy`) + `calendar.events.owned` (or `calendar.events`), plus `openid email` if you identify the user via ID token.

### 2.5 Sensitive / restricted classification — **NOT VERIFIED**
The scopes page (blocked) carries per-scope sensitivity labels. Search snippets attributed to the official pages say only: "Sensitive scopes require review by Google and have a sensitive indicator on the Google Cloud Console's OAuth consent screen configuration page", an example of a sensitive scope is "reading events stored in Google Calendar", and "choose the most narrowly focused scope possible and avoid requesting scopes that your app doesn't require". One snippet claimed `calendar.calendarlist.readonly` is non-sensitive, but its provenance was a third-party GitHub issue, so I do not rely on it. **Action for the implementer:** add the chosen scopes in Cloud Console → *Google Auth Platform / OAuth consent screen → Data access*; the console flags each scope as Non-sensitive / Sensitive / Restricted and tells you whether verification is required. Expect the event-read/write scopes to be Sensitive (verification + privacy policy, 100-user cap while unverified — **NOT VERIFIED**). No Calendar scope appeared on any "restricted" list in the snippets (**NOT VERIFIED**).

---

## 3. `freebusy.query`

Page: `https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query` — **FETCH BLOCKED**. Everything below is **Verified 2026-09-23 (discovery)**.

- `POST https://www.googleapis.com/calendar/v3/freeBusy` — request body `FreeBusyRequest`, response `FreeBusyResponse`.
- Scopes: `calendar`, `calendar.events.freebusy`, `calendar.freebusy`, `calendar.readonly`.

`FreeBusyRequest` (verbatim descriptions):
- `timeMin` (string, date-time): "The start of the interval for the query formatted as per RFC3339."
- `timeMax` (string, date-time): "The end of the interval for the query formatted as per RFC3339."
- `timeZone` (string, default `UTC`): "Time zone used in the response. Optional. The default is UTC."
- `items[]` (`FreeBusyRequestItem`): "List of calendars and/or groups to query." — `items[].id`: "The identifier of a calendar or a group."
- `calendarExpansionMax` (int32): "Maximal number of calendars for which FreeBusy information is to be provided. Optional. Maximum value is 50."
- `groupExpansionMax` (int32): "Maximal number of calendar identifiers to be provided for a single group. Optional. An error is returned for a group with more members than this value. Maximum value is 100."

`FreeBusyResponse` (verbatim descriptions):
- `kind`: `"calendar#freeBusy"`; `timeMin`/`timeMax`: "The start/end of the interval."
- `calendars` (object keyed by calendar id → `FreeBusyCalendar`): "List of free/busy information for calendars."
  - `busy[]` (`TimePeriod`): "List of time ranges during which this calendar should be regarded as busy." — `start`: "The (inclusive) start of the time period." `end`: "The (exclusive) end of the time period."
  - `errors[]` (`Error`): "Optional error(s) (if computation for the calendar failed)." — `domain`: "Domain, or broad category, of the error." `reason`: "Specific reason for the error. Some of the possible values are: - "groupTooBig" - The group of users requested is too large for a single query. - "tooManyCalendarsRequested" - The number of calendars requested is too large for a single query. - "notFound" - The requested resource was not found. - "internalError" - The API service has encountered an internal error. Additional error types may be added in the future, so clients should gracefully handle additional error statuses not included in this list."
- `groups` (object → `FreeBusyGroup { calendars: string[], errors: Error[] }`): "Expansion of groups."

Example (constructed from the verified schema — not copied from the page):

```json
// POST https://www.googleapis.com/calendar/v3/freeBusy
{
  "timeMin": "2026-10-01T00:00:00-04:00",
  "timeMax": "2026-10-02T00:00:00-04:00",
  "timeZone": "America/Toronto",
  "items": [{ "id": "primary" }, { "id": "advisor@example.com" }]
}
```

```json
{
  "kind": "calendar#freeBusy",
  "timeMin": "2026-10-01T04:00:00.000Z",
  "timeMax": "2026-10-02T04:00:00.000Z",
  "calendars": {
    "primary": {
      "busy": [
        { "start": "2026-10-01T13:00:00Z", "end": "2026-10-01T13:30:00Z" }
      ]
    },
    "advisor@example.com": {
      "errors": [{ "domain": "global", "reason": "notFound" }],
      "busy": []
    }
  }
}
```

Node (typed as `calendar_v3.Params$Resource$Freebusy$Query` with `requestBody: Schema$FreeBusyRequest`):

```js
const { data } = await calendar.freebusy.query({ requestBody: { timeMin, timeMax, timeZone, items: [{ id: 'primary' }] } });
const busy = data.calendars?.primary?.busy ?? [];
```

Note (Verified, discovery): a calendar that fails still appears under `calendars` with an `errors[]` array — check it per calendar; the HTTP call itself succeeds.

---

## 4. `events.insert` and the Event resource (+ patch / update / delete, ETags)

Pages: `…/reference/events/insert`, `…/reference/events` — **FETCH BLOCKED**. Everything in 4.1–4.4 is **Verified 2026-09-23 (discovery)**; 4.5 (ETag/If-Match) is a mix, labelled.

### 4.1 `events.insert`
`POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events` — body `Event`, response `Event`. Scopes: `calendar`, `calendar.app.created`, `calendar.events`, `calendar.events.owned`.

Path param `calendarId`: "Calendar identifier. To retrieve calendar IDs call the calendarList.list method. If you want to access the primary calendar of the currently logged in user, use the "primary" keyword."

Query params (verbatim):
- `conferenceDataVersion` (integer, 0–1): "Version number of conference data supported by the API client. Version 0 assumes no conference data support and ignores conference data in the event's body. Version 1 enables support for copying of ConferenceData as well as for creating new conferences using the createRequest field of conferenceData. The default is 0."
- `sendUpdates` (enum `all` | `externalOnly` | `none`): "Whether to send notifications about the creation of the new event. Note that some emails might still be sent. The default is false."
  - `all`: "Notifications are sent to all guests."
  - `externalOnly`: "Notifications are sent to non-Google Calendar guests only."
  - `none`: "No notifications are sent. Warning: Using the value none can have significant adverse effects, including events not syncing to external calendars or events being lost altogether for some users. For calendar migration tasks, consider using the events.import method instead."
- `sendNotifications` (boolean): "Deprecated. Please use sendUpdates instead."
- `maxAttendees` (integer ≥1): "The maximum number of attendees to include in the response. If there are more than the specified number of attendees, only the participant is returned. Optional."
- `supportsAttachments` (boolean): "Whether API client performing operation supports event attachments. Optional. The default is False."
- `eventLabelVersion` (integer 0–1): event-label feature flag (1 → `eventLabelId` used, `colorId` ignored).

Required body fields (discovery `annotations.required`): **`start` and `end` are required for `calendar.events.insert` and `calendar.events.update`** (and `import`); `iCalUID` is required only for `import`. Everything else is optional.

### 4.2 `events.patch` / `events.update` / `events.delete`
- `PATCH` / `PUT https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}` — same scopes as insert. Query params: `conferenceDataVersion` (same text as insert), `sendUpdates` — "Guests who should receive notifications about the event update (for example, title changes, etc.)." with `all` / `externalOnly` / `none` ("No notifications are sent. For calendar migration tasks, consider using the Events.import method instead."), `maxAttendees`, `supportsAttachments`, `eventLabelVersion`, `alwaysIncludeEmail` ("Deprecated and ignored."), `sendNotifications` (deprecated).
- `DELETE https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}` — same scopes; params `sendUpdates` — "Guests who should receive notifications about the deletion of the event." (`all` / `externalOnly` / `none`), `sendNotifications` (deprecated). No body; empty response.
- `update` (PUT) replaces the whole resource — send the full event; `patch` merges only supplied fields (Verified: `update` is PUT with body `Event`; PATCH semantics are standard — **the "merge" wording itself is NOT VERIFIED** since the page is blocked).

### 4.3 Event resource — field descriptions (verbatim)
- `kind`: `"calendar#event"`. `etag`: "ETag of the resource." `id`: "Opaque identifier of the event. When creating new single or recurring events, you can specify their IDs. Provided IDs must follow these rules: - characters allowed in the ID are those used in base32hex encoding, i.e. lowercase letters a-v and digits 0-9 … - the length of the ID must be between 5 and 1024 characters - the ID must be unique per calendar … we recommend using an established UUID algorithm such as one described in RFC4122. If you do not specify an ID, it will be automatically generated by the server. Note that the icalUID and the id are not identical and only one of them should be supplied at event creation time."
- `status`: "Status of the event. Optional. Possible values are: - "confirmed" - The event is confirmed. This is the default status. - "tentative" - The event is tentatively confirmed. - "cancelled" - The event is cancelled (deleted). The list method returns cancelled events only on incremental sync (when syncToken or updatedMin are specified) or if the showDeleted flag is set to true. The get method always returns them. … All other cancelled events represent deleted events. Clients should remove their locally synced copies. Such cancelled events will eventually disappear, so do not rely on them being available indefinitely. Deleted events are only guaranteed to have the id field populated."
- `summary`: "Title of the event." `description`: "Description of the event. Can contain HTML. Optional." `location`: "Geographic location of the event as free-form text. Optional." `colorId`: "The color of the event. This is an ID referring to an entry in the event section of the colors definition (see the colors endpoint). Optional."
- `start` / `end` (`EventDateTime`): "The (inclusive) start time of the event." / "The (exclusive) end time of the event." — `EventDateTime.date`: "The date, in the format "yyyy-mm-dd", if this is an all-day event." `dateTime`: "The time, as a combined date-time value (formatted according to RFC3339). A time zone offset is required unless a time zone is explicitly specified in timeZone." `timeZone`: "The time zone in which the time is specified. (Formatted as an IANA Time Zone Database name, e.g. "Europe/Zurich".) For recurring events this field is required and specifies the time zone in which the recurrence is expanded. For single events this field is optional and indicates a custom time zone for the event start/end."
- `attendees[]` (`EventAttendee`): "The attendees of the event. See the Events with attendees guide for more information on scheduling events with other calendar users. Service accounts need to use domain-wide delegation of authority to populate the attendee list."
  - `email`: "The attendee's email address, if available. This field must be present when adding an attendee. It must be a valid email address as per RFC5322. Required when adding an attendee."
  - `displayName`: "The attendee's name, if available. Optional." `optional` (default false), `resource` (default false; "Can only be set when the attendee is added to the event for the first time."), `comment`, `additionalGuests` (default 0), `organizer` (read-only), `self` (read-only), `id` (Profile ID).
  - `responseStatus`: "The attendee's response status. Possible values are: - "needsAction" - The attendee has not responded to the invitation (recommended for new events). - "declined" … - "tentative" … - "accepted" … Warning: If you add an event using the values declined, tentative, or accepted, attendees with the "Add invitations to my calendar" setting set to "When I respond to invitation in email" or "Only if the sender is known" might have their response reset to needsAction and won't see an event in their calendar unless they change their response in the event invitation email. Furthermore, if more than 200 guests are invited to the event, response status is not propagated to the guests."
- `organizer` `{email, displayName, id, self}`: "The organizer of the event. If the organizer is also an attendee, this is indicated with a separate entry in attendees with the organizer field set to True. To change the organizer, use the move operation. Read-only, except when importing an event." `creator` `{email, displayName, id, self}`: "The creator of the event. Read-only."
- `hangoutLink`: "An absolute link to the Google Hangout associated with this event. Read-only." (Populated with the Meet URL for `hangoutsMeet` conferences in practice — **that observation is NOT VERIFIED here**; rely on `conferenceData.entryPoints[]` with `entryPointType: "video"`.)
- `htmlLink`: "An absolute link to this event in the Google Calendar Web UI. Read-only." `created` / `updated`: RFC3339, read-only ("Updating event reminders will not cause this to change.").
- `conferenceData` (`ConferenceData`): "The conference-related information, such as details of a Google Meet conference. To create new conference details use the createRequest field. To persist your changes, remember to set the conferenceDataVersion request parameter to 1 for all event modification requests. Warning: Reusing Google Meet conference data across different events can cause access issues and expose meeting details to unintended users. To help ensure meeting privacy, always generate a unique conference for each event by using the createRequest field."
  - `createRequest` (`CreateConferenceRequest`): "A request to generate a new conference and attach it to the event. The data is generated asynchronously. To see whether the data is present check the status field. Either conferenceSolution and at least one entryPoint, or createRequest is required."
    - `requestId`: "The client-generated unique ID for this request. Clients should regenerate this ID for every new request. If an ID provided is the same as for the previous request, the request is ignored."
    - `conferenceSolutionKey.type`: "The conference solution type. … The possible values are: - "eventHangout" for Hangouts for consumers (deprecated; existing events may show this conference solution type but new conferences cannot be created) - "eventNamedHangout" for classic Hangouts for Google Workspace users (deprecated; …) - "hangoutsMeet" for Google Meet (http://meet.google.com) - "addOn" for 3P conference providers"
    - `status.statusCode`: "The current status of the conference create request. Read-only. The possible values are: - "pending": the conference create request is still being processed. - "success": the conference create request succeeded, the entry points are populated. - "failure": the conference create request failed, there are no entry points."
  - `entryPoints[]` (`EntryPoint`): "Information about individual conference entry points, such as URLs or phone numbers. All of them must belong to the same conference."
    - `entryPointType`: "- "video" - joining a conference over HTTP. A conference can have zero or one video entry point. - "phone" - joining a conference by dialing a phone number. A conference can have zero or more phone entry points. - "sip" … - "more" - further conference joining instructions … A conference with only a more entry point is not a valid conference."
    - `uri`: "The URI of the entry point. The maximum length is 1300 characters. Format: - for video, http: or https: schema is required. - for phone, tel: schema is required. …" `label`: "The label for the URI. Visible to end users. … Examples: - for video: meet.google.com/aaa-bbbb-ccc - for phone: +1 123 268 2601 …" plus `pin`, `passcode`, `password`, `meetingCode`, `accessCode` (max 128 chars each), `regionCode`, `entryPointFeatures`.
  - `conferenceId`: "… hangoutsMeet: ID is the 10-letter meeting code, for example aaa-bbbb-ccc. …" `conferenceSolution` `{key: {type}, name, iconUri}`: "Unset for a conference with a failed create request." `signature`: "Generated on server side. Unset for a conference with a failed create request. Optional for a conference with a pending create request." `notes`: "… Can contain HTML. The maximum length is 2048 characters. Optional."
- `sequence` (int32): "Sequence number as per iCalendar."
- `reminders` `{useDefault, overrides[]}`: "Information about the event's reminders for the authenticated user. Note that changing reminders does not also change the updated property of the enclosing event." — `useDefault`: "Whether the default reminders of the calendar apply to the event." `overrides`: "… The maximum number of override reminders is 5." — `EventReminder.method`: `"email"` | `"popup"` ("Required when adding a reminder."); `minutes`: "Valid values are between 0 and 40320 (4 weeks in minutes). Required when adding a reminder."
- `iCalUID`: "Event unique identifier as defined in RFC5545. … To retrieve an event using its iCalUID, call the events.list method using the iCalUID parameter."
- `recurrence[]`: "List of RRULE, EXRULE, RDATE and EXDATE lines for a recurring event, as specified in RFC5545. Note that DTSTART and DTEND lines are not allowed in this field …" `recurringEventId`, `originalStartTime` (instances of recurring events; immutable).
- `transparency`: `"opaque"` (default; blocks time = Busy) | `"transparent"` (Available). `visibility`: `"default"` | `"public"` | `"private"` | `"confidential"`.
- `guestsCanInviteOthers` (default true), `guestsCanModify` (default false), `guestsCanSeeOtherGuests` (default true), `anyoneCanAddSelf` (deprecated), `attendeesOmitted`, `privateCopy`, `locked`, `endTimeUnspecified`.
- `extendedProperties` `{private: {…}, shared: {…}}`: "Properties that are private to the copy of the event that appears on this calendar." / "Properties that are shared between copies of the event on other attendees' calendars." (Useful for storing your booking id; `events.list` can filter with `privateExtendedProperty=name=value`.)
- `source` `{title, url}`: "Source from which the event was created. … Can only be seen or modified by the creator of the event."
- `attachments[]`: "In order to modify attachments the supportsAttachments request parameter should be set to true. There can be at most 25 attachments per event".
- `eventType` (default `"default"`): `"birthday"` | `"default"` | `"focusTime"` | `"fromGmail"` (cannot be created) | `"outOfOffice"` | `"workingLocation"` — "This cannot be modified after the event is created."

### 4.4 Example insert with a Meet link (constructed from the verified schema; not copied from a page)

```json
// POST /calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all
{
  "summary": "Mortgage consultation — Jane Doe",
  "description": "Booked via Lendmax. <b>Bring</b> your ID.",
  "start": { "dateTime": "2026-10-01T10:00:00", "timeZone": "America/Toronto" },
  "end":   { "dateTime": "2026-10-01T10:30:00", "timeZone": "America/Toronto" },
  "attendees": [
    { "email": "jane@example.com", "displayName": "Jane Doe", "responseStatus": "needsAction" }
  ],
  "conferenceData": {
    "createRequest": {
      "requestId": "3f0c1d2e-8b7a-4c6d-9e5f-1a2b3c4d5e6f",
      "conferenceSolutionKey": { "type": "hangoutsMeet" }
    }
  },
  "reminders": { "useDefault": false, "overrides": [ { "method": "email", "minutes": 1440 }, { "method": "popup", "minutes": 10 } ] },
  "extendedProperties": { "private": { "lendmaxBookingId": "bk_123" } },
  "guestsCanInviteOthers": false
}
```

Response shape to expect (fields per verified schema; values illustrative):

```json
{
  "kind": "calendar#event",
  "id": "abc123def456",
  "etag": "\"3456789012345000\"",
  "status": "confirmed",
  "htmlLink": "https://www.google.com/calendar/event?eid=...",
  "sequence": 0,
  "hangoutLink": "https://meet.google.com/aaa-bbbb-ccc",
  "conferenceData": {
    "createRequest": {
      "requestId": "3f0c1d2e-8b7a-4c6d-9e5f-1a2b3c4d5e6f",
      "conferenceSolutionKey": { "type": "hangoutsMeet" },
      "status": { "statusCode": "success" }
    },
    "entryPoints": [
      { "entryPointType": "video", "uri": "https://meet.google.com/aaa-bbbb-ccc", "label": "meet.google.com/aaa-bbbb-ccc" }
    ],
    "conferenceSolution": { "key": { "type": "hangoutsMeet" }, "name": "Google Meet", "iconUri": "https://..." },
    "conferenceId": "aaa-bbbb-ccc"
  },
  "attendees": [ { "email": "jane@example.com", "displayName": "Jane Doe", "responseStatus": "needsAction" } ]
}
```

If `createRequest.status.statusCode` comes back `"pending"`, re-fetch with `events.get` until it is `"success"` (or `"failure"` → no entry points; retry with a **new** `requestId`). (Asynchrony is Verified from the schema text; the polling advice is Search snippet only.)

Node (types verified from `@googleapis/calendar@20.0.0` / `googleapis@181.0.0` `calendar_v3`):

```js
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const { data: ev } = await calendar.events.insert({
  calendarId: 'primary',
  conferenceDataVersion: 1,
  sendUpdates: 'all',
  requestBody: { /* as above */ },
});
const meetUrl = ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri ?? ev.hangoutLink;
```

### 4.5 ETag / `If-Match` optimistic concurrency
- Verified 2026-09-23 (discovery): every `Event` carries `etag` ("ETag of the resource."); `events.list` responses carry a collection `etag`.
- **Search snippet only — NOT VERIFIED** (from `…/calendar/api/guides/version-resources`, blocked): "Etags are supported in the calendar API for two cases: on resource modifications to ensure that there has been no other write to this resource in the meantime (conditional modification) and on resource retrieval to only retrieve resource data if the resource has changed (conditional retrieval)." "If you want to update or delete a resource only if it has not changed since you last retrieved it, you can specify an If-Match header that contains the value of the etag from the previous retrieval." Mismatch → **412 Precondition Failed**; `If-None-Match` on `get` → **304 Not Modified** when unchanged. Recovery: `events.get` the latest, re-apply, retry with the fresh etag.
- Verified 2026-09-23 (lib): the Node client lets you send the header. `googleapis-common@9.1.0` `createAPIRequest` merges `params.headers` (line 98: `headersToClassicHeaders(params.headers || {})`) and the per-call `options.headers` (`MethodOptions extends GaxiosOptions`, merged at line 235). Typed form:

```js
await calendar.events.patch(
  { calendarId: 'primary', eventId, conferenceDataVersion: 1, sendUpdates: 'all', requestBody: { start, end } },
  { headers: { 'If-Match': storedEtag } }   // 412 → reload & retry
);
await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' }, { headers: { 'If-Match': storedEtag } });
```

---

## 5. Push notifications (watch channels)

Page: `https://developers.google.com/workspace/calendar/api/guides/push` — **FETCH BLOCKED**. Schema/method facts are **Verified 2026-09-23 (discovery)**; operational rules are **Search snippet only** unless stated.

### 5.1 `events.watch` — Verified 2026-09-23 (discovery)
`POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/watch` — body `Channel`, response `Channel`. Scopes: `calendar`, `calendar.app.created`, `calendar.events`, `calendar.events.freebusy`, `calendar.events.owned`, `calendar.events.owned.readonly`, `calendar.events.public.readonly`, `calendar.events.readonly`, `calendar.readonly`. It accepts the same filtering query params as `events.list` (`timeMin`, `timeMax`, `singleEvents`, `eventTypes`, `privateExtendedProperty`, `syncToken`, …).

`Channel` (verbatim descriptions):
- `id`: "A UUID or similar unique string that identifies this channel."
- `type`: "The type of delivery mechanism used for this channel. Valid values are "web_hook" (or "webhook"). Both values refer to a channel where Http requests are used to deliver messages."
- `address`: "The address where notifications are delivered for this channel."
- `token`: "An arbitrary string delivered to the target address with each notification delivered over this channel. Optional."
- `expiration` (int64 as string): "Date and time of notification channel expiration, expressed as a Unix timestamp, in milliseconds. Optional."
- `params` (map string→string): "Additional parameters controlling delivery channel behavior. Optional." (`params.ttl` = seconds — **Search snippet only**, from the events.watch reference: default `604800` s = 1 week.)
- `payload` (boolean): "A Boolean value to indicate whether payload is wanted. Optional."
- `resourceId`: "An opaque ID that identifies the resource being watched on this channel. Stable across different API versions."
- `resourceUri`: "A version-specific identifier for the watched resource."
- `kind`: `"api#channel"`.

Request/response example (constructed from schema):

```json
// POST /calendar/v3/calendars/primary/events/watch
{
  "id": "0b8e2c1a-5d7f-4c3b-9a6e-2f1d0c9b8a7e",
  "type": "web_hook",
  "address": "https://app.example.com/webhooks/google-calendar",
  "token": "user=42&secret=<random>",
  "expiration": "1760000000000"
}
```

```json
{
  "kind": "api#channel",
  "id": "0b8e2c1a-5d7f-4c3b-9a6e-2f1d0c9b8a7e",
  "resourceId": "o3hgv1538sdjfh",
  "resourceUri": "https://www.googleapis.com/calendar/v3/calendars/primary/events?alt=json",
  "token": "user=42&secret=<random>",
  "expiration": "1760000000000"
}
```

Store `id`, `resourceId`, `token`, `expiration` per user/calendar.

### 5.2 Notification messages — Search snippet only — NOT VERIFIED (attributed to the official push page)
- Headers: `X-Goog-Channel-ID` ("the id that uniquely identifies the notification channel"), `X-Goog-Channel-Token` (your `token`, echoed — compare it before trusting the message), `X-Goog-Channel-Expiration` (human-readable expiry, present if the channel has one), `X-Goog-Resource-ID`, `X-Goog-Resource-URI` ("an API-version-specific identifier for the watched resource"), `X-Goog-Resource-State`, `X-Goog-Message-Number`.
- `X-Goog-Resource-State` values: `sync`, `exists`, `not_exists`.
- "After creating a notification channel to watch a resource, the Google Calendar API sends a sync message to indicate that notifications are starting" with `X-Goog-Resource-State: sync`; "Sync messages always have an X-Goog-Message-Number HTTP header value of 1."
- "The watch event notification does not include a message body, rather it only includes some headers" → on a notification you must call `events.list` with your stored `syncToken` (Section 6) to learn what changed.
- Responding: "If your service … returns 500, 502, 503, or 504, the Google Calendar API retries with exponential backoff. Every other return status code is considered to be a message failure." Success codes reported as 200, 201, 202, 204 or 102. Respond fast (2xx) and do the sync asynchronously.

### 5.3 Receiver requirements — Search snippet only — NOT VERIFIED
- HTTPS only: "the Google Calendar API is able to send notifications to this HTTPS address only if there's a valid SSL certificate installed on your web server. Invalid certificates include: Self-signed certificates, certificates signed by an untrusted source, certificates that have been revoked, and certificates that have a subject that doesn't match the target hostname."
- Domain ownership must be verified / registered for the Cloud project (Search Console verification and adding the domain under the project's domain verification list) before `watch` will accept the `address`. (**NOT VERIFIED** wording.)

### 5.4 Expiration and renewal
- **Search snippet only**: "A notification channel can have an expiration time, with a value determined either by your request or by any Google Calendar API internal limits or defaults (the more restrictive value is used)." Default TTL `604800` seconds (one week). "Currently, there's no automatic way to renew a notification channel. When a channel is close to its expiration, you must replace it with a new one by calling the watch method."
- **Maximum lifetime: NOT VERIFIED.** No official text found stating a hard cap for Calendar (third-party blogs claim ~30 days; the brief guessed ~1 week). Do not assume: read `expiration` from the watch response, schedule renewal before it (e.g. daily job that re-`watch`es anything expiring within 24 h), and then `channels.stop` the old channel.

### 5.5 `channels.stop` — Verified 2026-09-23 (discovery)
`POST https://www.googleapis.com/calendar/v3/channels/stop` — body `Channel` (use `id` + `resourceId`), empty response. Accepts any Calendar scope (all 14 read/write scopes are listed).

```json
{ "id": "0b8e2c1a-5d7f-4c3b-9a6e-2f1d0c9b8a7e", "resourceId": "o3hgv1538sdjfh" }
```

Node: `await calendar.channels.stop({ requestBody: { id, resourceId } });`

### 5.6 Resources that support watch — Verified 2026-09-23 (discovery; method existence)
`events.watch`, `calendarList.watch`, `acl.watch`, `settings.watch` exist in the discovery document.

---

## 6. Synchronisation (`syncToken`)

Page: `https://developers.google.com/workspace/calendar/api/guides/sync` — **FETCH BLOCKED**. The normative rules are embedded verbatim in the discovery document's `events.list` `syncToken` parameter and the `Events` collection schema — **Verified 2026-09-23 (discovery)**. Guide prose is Search snippet only.

### 6.1 Verbatim rules (discovery)
`events.list` → `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`, response `Events`.

- `syncToken`: "Token obtained from the nextSyncToken field returned on the last page of results from the previous list request. It makes the result of this list request contain only entries that have changed since then. All events deleted since the previous list request will always be in the result set and it is not allowed to set showDeleted to False. There are several query parameters that cannot be specified together with nextSyncToken to ensure consistency of the client state. These are: - iCalUID - orderBy - privateExtendedProperty - q - sharedExtendedProperty - timeMin - timeMax - updatedMin All other query parameters should be the same as for the initial synchronization to avoid undefined behavior. If the syncToken expires, the server will respond with a 410 GONE response code and the client should clear its storage and perform a full synchronization without any syncToken. Learn more about incremental synchronization. Optional. The default is to return all entries."
- `Events.nextPageToken`: "Token used to access the next page of this result. Omitted if no further results are available, in which case nextSyncToken is provided."
- `Events.nextSyncToken`: "Token used at a later point in time to retrieve only the entries that have changed since this result was returned. Omitted if further results are available, in which case nextPageToken is provided."
- `showDeleted`: "Whether to include deleted events (with status equals "cancelled") in the result. Cancelled instances of recurring events (but not the underlying recurring event) will still be included if showDeleted and singleEvents are both False. If showDeleted and singleEvents are both True, only single instances of deleted events (but not the underlying recurring events) are returned. Optional. The default is False."
- `singleEvents`: "Whether to expand recurring events into instances and only return single one-off events and instances of recurring events, but not the underlying recurring events themselves. Optional. The default is False."
- `orderBy=startTime` "is only available when querying single events (i.e. the parameter singleEvents is True)" — and `orderBy` is **disallowed** with `syncToken`.
- `maxResults`: default 250, "The page size can never be larger than 2500 events."
- `Event.status` (see 4.3): cancelled events on incremental sync "are only guaranteed to have the id field populated."

### 6.2 Guide prose — Search snippet only — NOT VERIFIED
- "When no sync token is stored from the previous execution, the system performs a full sync." "Sync tokens aren't compatible with most filters, but you may want to limit your full sync to only a certain date range, such as syncing events up to a year old." (i.e. `timeMin`/`timeMax` may be used on the *initial* full-sync request; the resulting token then carries that constraint and you must not pass them again — consistent with the verified rule.)
- "If the result set is too large and the response gets paginated, then the nextSyncToken field is present only on the very last page." Store it only after draining all `nextPageToken` pages.
- "If a sync token expires, Google returns 410 GONE and you must perform a fresh full sync." "The result will always contain deleted entries, so that the clients get the chance to remove them from storage."

### 6.3 Algorithm (derived from the verified rules)
1. Full sync: `events.list({calendarId, singleEvents: true, showDeleted: true, timeMin?, pageToken})` loop until no `nextPageToken`; persist `nextSyncToken`.
2. On each push notification (or on a timer): `events.list({calendarId, syncToken, singleEvents: true, showDeleted: true, pageToken})` — same non-forbidden params as step 1; apply upserts; `status === 'cancelled'` → delete locally; store the new `nextSyncToken` from the last page.
3. On HTTP **410** (`GaxiosError` with `response.status === 410`): drop the stored token and local copy, redo step 1.

---

## 7. Create events guide (Meet-specific notes)

Page: `https://developers.google.com/workspace/calendar/api/guides/create-events` — **FETCH BLOCKED**.

- **Verified 2026-09-23 (discovery)** — all of the following are verbatim schema text, quoted in 4.3: `conferenceDataVersion` must be `1` for the conference data in the body to be honoured ("Version 0 … ignores conference data in the event's body"); "To persist your changes, remember to set the conferenceDataVersion request parameter to 1 for all event modification requests."; `requestId` is "The client-generated unique ID for this request. Clients should regenerate this ID for every new request. If an ID provided is the same as for the previous request, the request is ignored."; `conferenceSolutionKey.type = "hangoutsMeet"`; "The data is generated asynchronously. To see whether the data is present check the status field" → `statusCode` `pending` / `success` / `failure`; "always generate a unique conference for each event by using the createRequest field" (never copy `conferenceData` between events).
- **Search snippet only**: "you can create a new conference for an event by providing a createRequest with a newly generated requestId which can be a random string"; "The immediate response to this call might not yet contain the fully-populated conferenceData which is indicated by status pending. Once the statusCode changes to success, the conference information is populated."
- Attendees / notifications — Verified (discovery): `attendees[].email` required; use `responseStatus: "needsAction"` for new events; `sendUpdates=all|externalOnly|none` controls invitation emails; `none` carries the sync-loss warning quoted in 4.1. Service accounts "need to use domain-wide delegation of authority to populate the attendee list" (so use the user's OAuth grant, as planned).
- Event metadata — Verified (discovery): you may supply your own `id` (base32hex, 5–1024 chars, unique per calendar; UUID recommended) — handy for idempotent creation; `iCalUID` is separate and should not be supplied alongside `id` at creation.
- Reminders / recurrence / colorId / attachments / eventType — Verified (discovery) field rules quoted in 4.3 (max 5 overrides, 0–40320 minutes; RRULE lines without DTSTART/DTEND; `supportsAttachments=true` and ≤25 attachments; `eventType` immutable).
- Code samples from the page: **not obtained** (blocked). The Node snippet in 4.4 is constructed from the verified types.

---

## 8. `googleapis` npm package — Verified 2026-09-23 (npm registry + GitHub README + official samples)

- Package name **`googleapis`**; `npm install googleapis`. Latest **181.0.0** (published 2026-09-14), `engines.node >= 22.0.0`, deps `google-auth-library ^11.0.0`, `googleapis-common ^9.0.0`, unpacked size ≈ 214 MB. README: "These client libraries are officially supported by Google. However, these libraries are considered complete and are in maintenance mode. This means that we will address critical bugs and security issues but will not add any new features." "This library supports the maintenance LTS, active LTS, and current release of node.js."
- Lighter alternative: **`@googleapis/calendar`** 20.0.0 (same generated `calendar_v3` code; README: `npm install @googleapis/calendar`; usage per the main README's submodule example: `const calendar = require('@googleapis/calendar'); const auth = new calendar.auth.GoogleAuth(...)` / `calendar.calendar({version:'v3', auth})`).
- `google.auth.OAuth2` exists: `new google.auth.OAuth2(YOUR_CLIENT_ID, YOUR_CLIENT_SECRET, YOUR_REDIRECT_URL)` (README, verbatim in 1.11). It is `google-auth-library`'s `OAuth2Client`; also constructible as `new OAuth2Client({clientId, clientSecret, redirectUri})`.
- Methods confirmed in `oauth2client.d.ts` 11.1.0: `generateAuthUrl(opts?: GenerateAuthUrlOpts): string`; `generateCodeVerifierAsync(): Promise<CodeVerifierResults>`; `getToken(code: string | GetTokenOptions): Promise<GetTokenResponse>` (→ `{tokens, res}`); `setCredentials(credentials)`; `refreshAccessToken(): Promise<RefreshAccessTokenResponse>` (present, no `@deprecated` tag; automatic refresh makes it rarely necessary); `revokeToken(token)`; `revokeCredentials()`; `getTokenInfo(accessToken)`; `verifyIdToken({idToken, audience})`; EventEmitter `'tokens'` event fired on every token acquisition/refresh (`this.emit('tokens', tokens)`).
- Auto-refresh semantics (verified in source): refresh happens lazily before a request when `access_token` is missing or within `eagerRefreshThresholdMillis` (default 300 000 ms) of `expiry_date`; `forceRefreshOnFailure` (default false) additionally retries once after a 401/403 by refreshing.
- Calendar client: `google.calendar({version: 'v3', auth})` — verified in `googleapis@181.0.0` `build/src/apis/calendar/index.d.ts` (`export declare function calendar(options: calendar_v3.Options): calendar_v3.Calendar;`) and in Google's official quickstart `googleworkspace/node-samples/calendar/quickstart/index.js` (verbatim):

```js
import {google} from 'googleapis';
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
// ...
const calendar = google.calendar({version: 'v3', auth});
const result = await calendar.events.list({
  calendarId: 'primary',
  timeMin: new Date().toISOString(),
  maxResults: 10,
  singleEvents: true,
  orderBy: 'startTime',
});
```

- `calendar_v3.Calendar` exposes `acl, calendarList, calendars, channels, colors, events, freebusy, settings`. Method signature pattern: `events.insert(params: Params$Resource$Events$Insert, options?: MethodOptions): Promise<GaxiosResponse<Schema$Event>>` — response body is on `.data`. `MethodOptions extends GaxiosOptions` (so `headers`, `timeout`, `retry`, `responseType` can be set per call).
- Global vs service-level auth (README, verbatim): `google.options({ auth: oauth2Client });` or `google.calendar({ version: 'v3', auth: oauth2Client })`; per-request `auth` is also accepted in the params object.
- TypeScript (README, verbatim): "All classes and interfaces generated for each API are exported under the `${apiName}_${version}` namespace" → `import { google, calendar_v3 } from 'googleapis'`; request types `calendar_v3.Params$Resource$Events$Insert`, schema types `calendar_v3.Schema$Event`, `Schema$Channel`, `Schema$FreeBusyRequest`, etc.
- Multi-user server pattern (derived from verified semantics): create **one `OAuth2Client` per user request** (`new google.auth.OAuth2(id, secret, redirect)` → `setCredentials({refresh_token, access_token, expiry_date})` → attach `on('tokens')` to persist rotated tokens) rather than sharing a client across users, because credentials are instance state.

---

## 9. Quick verification ledger

| # | Item | Status |
|---|---|---|
| 1 | OAuth endpoints, params (`client_id, redirect_uri, response_type=code, scope, access_type=offline, prompt=consent, state, include_granted_scopes, login_hint, code_challenge[_method]`), token exchange/refresh bodies, revoke URL, refresh-token-only-on-first-consent, Testing-status 7-day expiry, auto-refresh threshold | Verified 2026-09-23 (OIDC / lib) |
| 1 | `enable_granular_consent`, 100-token cap, revoke 200/400 semantics, full `invalid_grant` cause list, ~3600 s access-token lifetime, whether the web-server page recommends PKCE | Search snippet only / NOT VERIFIED |
| 2 | Scope URLs, descriptions, per-method accepted scopes (free/busy, event CRUD, calendar list) | Verified 2026-09-23 (discovery) |
| 2 | Sensitive/Restricted labels per scope, verification thresholds | NOT VERIFIED |
| 3 | `freebusy.query` URL, request/response schema, error reasons, limits (50 calendars / 100 group members) | Verified 2026-09-23 (discovery) |
| 4 | `events.insert/patch/update/delete` URLs, params (`conferenceDataVersion` 0/1, `sendUpdates` all/externalOnly/none, `sendNotifications` deprecated), scopes, required `start`/`end`, full Event schema incl. `conferenceData.createRequest{requestId, conferenceSolutionKey.type=hangoutsMeet, status.statusCode pending/success/failure}`, `entryPoints[].entryPointType=video/uri`, `hangoutLink`, `etag`, `sequence`, `status`, `reminders`, `attendees[].responseStatus` | Verified 2026-09-23 (discovery) |
| 4 | `If-Match` → 412, `If-None-Match` → 304 guide wording | Search snippet only; header pass-through in Node client Verified (lib) |
| 5 | `events.watch` / `channels.stop` URLs, scopes, `Channel` schema (`id, type=web_hook, address, token, expiration, resourceId, resourceUri`) | Verified 2026-09-23 (discovery) |
| 5 | Notification headers & states, no-payload rule, HTTPS/valid-cert/domain-verification, 2xx + backoff on 5xx, default ttl 604800 s, no auto-renew | Search snippet only — NOT VERIFIED |
| 5 | Hard maximum channel lifetime | NOT VERIFIED (no official number found) |
| 6 | `syncToken` rules, forbidden params, `showDeleted` must not be false, 410 GONE → full resync, `nextSyncToken` only on last page | Verified 2026-09-23 (discovery) |
| 7 | Meet creation requirements (`conferenceDataVersion=1`, unique `requestId`, async status) | Verified 2026-09-23 (discovery); polling guidance Search snippet only |
| 8 | `googleapis` 181.0.0, `google.auth.OAuth2` API surface, `'tokens'` event, `google.calendar({version:'v3', auth})`, TypeScript namespaces, `@googleapis/calendar` | Verified 2026-09-23 (lib + official samples) |

Local evidence kept in `/tmp/claude-0/-home-user-sxd/3e8c99c9-a1b0-5c1a-b288-9d80f6eebedf/scratchpad/research/`: `calendar-v3-discovery.json` (rev 20260826), `googleapis-readme.md` (npm README of 181.0.0), and `pkgs/` (extracted `google-auth-library-11.1.0`, `googleapis-calendar-20.0.0`, `googleapis-common-9.1.0`, plus `googleapis-181.tgz`).
