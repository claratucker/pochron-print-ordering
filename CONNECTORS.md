# Cloud photo connectors

**Enabled: Dropbox and Adobe Lightroom.** Flickr and Google Photos are
implemented and tested but deliberately switched off — see the decision below.

All four work the same way:
the customer picks a file in the provider's own picker, the browser receives a
temporary URL, and the server fetches it into storage and validates it exactly
like a direct upload. One import path, four front ends.

## Read this first: not all sources are print quality

This is a fine-art print studio, and several of these services hand back a
re-encoded derivative rather than the file the photographer created. A
compressed 2 MP JPEG printed at 30×40 looks bad, and the customer blames the
studio, not Google. So every import records where it came from and how good it
is, and that follows the file into the studio queue.

| Source | Quality | Reality |
|---|---|---|
| **Dropbox** | ✅ original | A file sync service — bytes come back unmodified. Best fit. |
| **Lightroom** | ✅ original | Full-resolution export from the photographer's own catalogue. The natural fit for professional clients. |
| **Flickr** | ⚠️ conditional | Has an "Original" size, but only serves it if the account owner allows original access. Otherwise you get a resized copy. |
| **Google Photos** | ❌ compressed | See below. Weakest fit for print. |

### Why Google Photos is the problem case

Two independent issues:

1. **Google removed library access on 31 March 2025.** The `photoslibrary.readonly`
   scope is gone; calls using it return 403. Apps can no longer browse a
   library at all — only receive photos the user explicitly picks through the
   **Picker API**. Any tutorial older than 2025 describes an API that no longer
   exists.
2. **The file may already be compressed.** Google's "Storage saver" tier
   re-encodes on upload, so the "original" in the account may not be the
   photographer's original. Whether the download parameter returns true original
   bytes has been disputed on Google's own issue tracker for years.

### The decision: only original-quality sources

Pochron offers **Dropbox and Lightroom only**. Both return the photographer's
actual file, so the studio can stand behind every print.

Flickr and Google Photos stay in the registry — implemented, tested, one config
value away — but off. The reasoning is that a customer whose 30×40 comes back
soft blames the studio, not Google, and a fine-art studio's whole proposition is
that it does not let that happen. Offering fewer sources you can vouch for is
better than offering more you cannot.

A note on comparisons: consumer printers like Printique do list Google Photos.
Their volume is largely phone photos at 4×6, where compression is invisible.
That tolerance does not transfer to drum scans printed at 30×40. (Their public
pages listing Google Photos also predate the March 2025 API removal, so it is
not clear the integration still works as described.)

If a customer's files really only exist in Google Photos, the honest answer is
to have them download the original and upload it directly — which is also the
path that preserves the most quality.

To enable one anyway:

```
ENABLED_CONNECTORS=dropbox,lightroom,flickr
```

A test asserts that only original-quality sources are offered, so switching one
on will fail the suite until someone consciously updates it.

## Security: why the import endpoint is written defensively

"Fetch this URL for me" is one of the most abused endpoints on the web. An
attacker who controls the URL can try to reach `169.254.169.254` — the cloud
instance metadata service — and read this server's IAM credentials, or probe
the private network behind the firewall. That class of bug (SSRF) has caused
some of the largest cloud breaches on record.

So every import is checked twice:

1. **Host allowlist** — https only, no credentials in the URL, no odd ports,
   and the hostname must be an allowlisted provider host or a subdomain of one.
   Note that `dl.dropboxusercontent.com.evil.com` is rejected: a naive
   "contains" check would allow it.
2. **Address check** — the hostname is resolved and rejected if it maps to a
   private, loopback or link-local address, in case an allowlisted name is
   pointed somewhere internal.

Both checks have tests. If you add a provider, add its hosts to the registry —
never widen the check itself.

## Implementation status

**Built:** the connector registry, the SSRF-safe `POST /api/uploads/import`
endpoint, `GET /api/uploads/sources`, provenance recorded on every file, and
28 tests.

**Still required per provider** — each needs an account and app registration,
which is why they are configuration rather than code:

- **Dropbox** — register at dropbox.com/developers, add the domain to the app's
  Chooser allowlist, drop in the Chooser script and pass `linkType: 'direct'`.
  Easiest by far and the best quality; do this one first.
- **Lightroom** — DONE. Adobe Developer Console project with an **OAuth Web App**
  credential; entitlement for `lr_partner_apis` was granted. Set
  `LIGHTROOM_CLIENT_ID` and `LIGHTROOM_CLIENT_SECRET`, and register the redirect
  URI `https://order.pochronstudios.com/api/connectors/lightroom/callback`.

  Two Adobe quirks the code handles: every JSON response is prefixed with
  `while (1) {}` as anti-hijacking padding and must be stripped before parsing,
  and requests need both the bearer token and the client id as `X-API-Key`.

  Imports pull the asset's **master** — the file the photographer originally
  imported to Lightroom — not a rendition. Renditions are derived and would
  defeat the point of calling Lightroom an original-quality source. Assets
  synced as smart previews only have no master; those return a clear message
  telling the customer to export and upload directly.

  Access tokens are short-lived and refreshed automatically. They are stored
  against the visitor's own draft cookie, so one customer's connection is never
  visible to another.
- **Flickr** — API key and OAuth 1.0a. Request the `Original` size and fall back
  to the largest available, warning when the original is unavailable.
- **Google Photos** — Google Cloud project, OAuth consent screen, and the
  **Picker** API (not the Library API).

Enable them as they're ready:

```
ENABLED_CONNECTORS=dropbox,flickr
IMPORT_MAX_BYTES=1073741824      # 1 GB — larger files should upload directly
IMPORT_TIMEOUT_MS=120000
```

## The size limit

Imports are buffered in memory, so they are capped at 1 GB by default — well
below the 20 GB direct-upload limit. Above the cap the customer is told to
download the file and upload it directly, which uses the resumable multipart
path and can survive an interrupted connection. Streaming imports straight to
object storage would lift this, and is the obvious follow-up if customers
routinely import multi-GB files from Dropbox.
