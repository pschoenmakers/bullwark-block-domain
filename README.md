# Block Domain

A [Bulwark Webmail](https://bulwarkmail.org) plugin that adds **Block domain** and
**Unblock domain** actions to message rows and to the open-message toolbar in the
Spam folder. Rules are written to Stalwart's server-wide `blocked-domains`
spam-filter lookup, so blocked mail is rejected at SMTP time instead of merely
being moved to Spam.

Everything ships as one readable CommonJS file. There is no build step and no
third-party runtime dependency: the source in `block-domain/src/index.js` is the
exact file installed as `index.js`.

## Features

- **Block a sender's domain** from any message row (hover icon and right-click
  menu) or from the open-message toolbar in the Spam folder.
- **Unblock a domain** from a row when the sender is blocked, or from Settings
  > Plugins > Block Domain.
- **Subdomain-aware blocking.** A built-in subset of the Public Suffix List means
  `news.bbc.co.uk` resolves to `bbc.co.uk`, not `co.uk`. When a sender is on a
  subdomain you can block just that host or its registrable base domain.
- **A remembered per-user choice.** The `blockTarget` setting can ask every time,
  always block only the exact host, or always block the base domain and all of
  its subdomains.
- **Glob coverage.** Blocking a base domain creates both the bare base entry and
  a `*.<base>` glob entry, so the domain and all subdomains are covered.
- **Blocked badges in the message list.** Rows whose sender matches an exact
  entry or a glob entry show a red **Blocked** badge. The badge cache refreshes
  on activation, when entering the Spam folder, after every change, and lazily
  every 30 seconds so changes made in another frame appear.
- **Server-wide warnings.** Every confirmation names the exact domain and says
  that the rule applies to every account and rejects mail at SMTP time.
- **Unified-mailbox support.** If `api.email.get` cannot read a message from
  another connected login, the plugin falls back to senders remembered from
  rows and opened messages. If two logins use the same message id for different
  senders, the plugin refuses to guess and asks you to open the message first.
- **Settings section.** Lists the full blocked-domains list, sorted, 200 rows at
  a time, with a per-row Unblock action, a count, Refresh, and explicit
  loading/error/retry states.
- **Honest errors.** HTTP status, truncated server body, JMAP error type and
  description, and per-object set refusals are surfaced instead of being
  swallowed. A missing ReloadLookupStores confirmation produces a warning.

## Requirements

- Bulwark Webmail **1.15.0** or later.
- A Stalwart server reachable by the Bulwark server over HTTPS, with JMAP
  enabled.
- The blocked-domains lookup used by Stalwart's spam filter. This is the
  `blocked-domains` namespace in `x:MemoryLookupKey`.
- Administrator access to Bulwark's plugin page to install the plugin and save
  the Stalwart URL and API key.

## Setup

1. **Install the plugin.** Upload the ZIP produced by `scripts/package.sh`, or
   install the `block-domain` folder through your usual Bulwark plugin workflow.
   The ZIP contains `manifest.json`, `index.js` and `icon.png` at its root.
2. **Create a Stalwart API key** with only the permissions listed below. Do not
   reuse an administrator key.
3. **Configure the plugin** on its page in the Bulwark admin dashboard:
   - **Stalwart URL**: the full base URL of the Stalwart server, including the
     scheme, for example the address you open the Stalwart admin page on. The
     plugin calls `<url>/jmap/`; a URL that already ends in `/jmap` is also
     accepted.
   - **API key**: the key from step 2. It is stored as a secret and never reaches
     the browser. Bulwark's credential proxy adds `Authorization: Bearer …` and
     only sends it to the configured origin.
4. **Choose the default behaviour** in Settings > Plugins > Block Domain:
   - *Ask me each time* (default)
   - *Block only the exact domain*
   - *Block the base domain and all subdomains*

If the plugin is installed but the URL is missing, actions show a clear "not
configured" message instead of failing silently.

## Least-privilege Stalwart API key

Grant only what the plugin uses. In Stalwart a credential can inherit the
account's permissions or carry an explicit allow-list; the latter is preferred
for this plugin.

| Stalwart permission | Why it is needed |
|---|---|
| `sysMemoryLookupKeyGet` | Read the blocked-domain entries found by a query. |
| `sysMemoryLookupKeyQuery` | Page through the `blocked-domains` namespace. |
| `sysMemoryLookupKeyCreate` | Add a blocked domain. |
| `sysMemoryLookupKeyDestroy` | Remove a blocked domain. |
| `sysActionCreate` | Submit the ReloadLookupStores action. |
| `actionReloadLookupStores` | Apply the change without waiting for a server restart. |

`sysMemoryLookupKeyUpdate` is **not** needed: the plugin only creates and
destroys entries. Do not grant `sysMemoryLookupKeyValue*` or any other registry
permission unless you have another reason to.

In Stalwart's admin UI this is usually done by creating an API key in `Replace`
mode with the six permissions above, or by adding those permissions to a
dedicated role and using an API key that inherits it. Exact menu labels differ
between Stalwart versions; the permission identifiers are the stable part.

## Usage

### Block a domain

Hover a message row and click **Block domain**, or right-click the row and
choose it — in any folder. The icon shows for senders that aren't blocked yet;
once a domain is blocked the row icon switches to **Unblock domain**.

If the sender is on a subdomain and the setting is *Ask me each time*, choose
the exact host or its base domain. Confirm the dialog — it names the domain,
says the rule is server-wide, and says mail will be rejected at SMTP time.

If the domain or a glob that covers it is already blocked, the plugin says so
and makes no change. Blocking a base domain adds `<base>` and `*.<base>`, then
asks Stalwart to reload its lookup stores.

### Unblock a domain

Hover a message row and click **Unblock domain**, or right-click the row and
choose it — the icon shows only when that sender is blocked. Or use **Unblock**
next to an entry in Settings > Plugins > Block Domain.

If both the exact host and its base/glob family are blocked, the chooser lets
you remove the exact host, the base family, or both. Otherwise a single
confirmation names every entry that will be removed. If nothing matches, the
plugin says the domain is not blocked and changes nothing.

The settings list always shows the whole server-wide list, not just the domains
you blocked. It shows 200 entries at a time and has a **Show more** button.

## Permissions

The manifest requests exactly these Bulwark permissions:

| Permission | Why the plugin needs it |
|---|---|
| `email:read` | Read the sender address of the message the action was invoked on, and remember senders for unified mailboxes. |
| `ui:toolbar` | Register **Block domain** / **Unblock domain** on the open-message toolbar in the Spam folder. |
| `ui:message-list` | Register the block/unblock icons and right-click entries on message rows in any folder, and add the **Blocked** badge to any row. |
| `ui:settings-section` | Draw the Blocked domains section in Settings > Plugins. |
| `http:proxy` | Send JMAP requests through Bulwark's credential proxy, which injects the Stalwart API key server-side. |

The `plugin-dialog` slot needs only `ui:observe`, which is always granted.

## How it works

All server work is JMAP over the configured Stalwart URL:

- `x:MemoryLookupKey/query` with `filter: { namespace: "blocked-domains" }`,
  `limit: 500` and a moving `position`, followed in the same request by
  `x:MemoryLookupKey/get` using a `#ids` result reference.
- Pagination stops at 500 entries per page and refuses lists beyond 100 pages
  (50,000 entries) rather than working from a partial list.
- `x:MemoryLookupKey/set` creates or destroys entries. A create is
  `{ namespace: "blocked-domains", key, isGlobPattern }`; a base-domain block
  uses a bare entry plus `{ key: "*.<base>", isGlobPattern: true }`.
- `x:Action/set` with `ReloadLookupStores` travels in the **same** JMAP request
  as the set. If Stalwart does not confirm it, the change is still reported as
  saved but the user is warned that it may need a restart.
- Responses are read by method name, never by array position, because RFC 8620
  allows a server to reorder them.
- The badge cache keeps an exact `Set` and precompiled case-insensitive regular
  expressions for globs (`*` becomes `.*`, `?` becomes `.`), so row rendering
  does not compile expressions while the user scrolls.

## Privacy

- The plugin has no analytics, telemetry, crash reporting or update check.
- It contacts only the Stalwart URL configured by the administrator, and only
  through `api.proxy.fetch('stalwart', …)`. The API key stays on the Bulwark
  server.
- The only mail data it reads is the sender address needed to resolve a domain.
  It does not store message bodies or subjects outside the page.
- Sender memory is kept in memory per frame, capped at roughly 1,000 entries,
  oldest-evicted, and disappears when the page is reloaded.
- No data is written to `document.cookie`, `localStorage` or any third party.
- The blocked-domains list is server-wide, so every change is visible to other
  accounts on the same Stalwart server. This is stated in every confirmation.

## Development

```text
block-domain/
  manifest.json      plugin metadata, config, settings, credential, locales
  icon.png           512 × 512 plugin icon
  src/index.js       the entire plugin (also shipped as index.js)
test/
  smoke.cjs          stubbed-host smoke test, no network
scripts/
  package.sh         builds dist/block-domain.zip
```

There is deliberately **no build step and no npm dependency** in the plugin
folder. Edit `src/index.js`, run the checks, then package.

```sh
# Syntax check
node --check block-domain/src/index.js
node -e 'JSON.parse(require("fs").readFileSync("block-domain/manifest.json", "utf8"))'

# Smoke test with a fake Bulwark host and a fake Stalwart JMAP server
node test/smoke.cjs

# Build the installable ZIP
./scripts/package.sh
```

The smoke test loads the plugin in a stubbed host that provides `react`,
`@plugin-host` and `@plugin-host/ui`, then exercises activation, badge matching,
blocking an exact host, blocking a base plus glob, unblocking, and the error
paths. It does not contact a real server. `TESTING.md` describes both the
automated test and a manual pass against a real Stalwart instance.

## Releasing

1. Update `version` in `block-domain/manifest.json` (semantic versioning).
2. If the host surface or credential schema changed, update this README and
   `TESTING.md` in the same commit.
3. Run the syntax check, the smoke test, and `./scripts/package.sh`.
4. Confirm the ZIP contains `manifest.json`, `icon.png` and `index.js` at the
   root, and that `icon.png` is at most 256 KB.
5. Record the ZIP's SHA-256 in the release notes so admins can verify what they
   install. Bulwark pins approvals to a hash of the manifest and the package.
6. Tag the release with the same version.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Block Domain is not configured" | The admin has not saved a Stalwart URL for the plugin. |
| "Stalwart rejected the API key." | The key is wrong, expired, or belongs to another server. |
| "The API key lacks permission…" | The key is missing one of the six permissions above. |
| "Could not read the message" | A unified-mailbox message from another login was never opened or rendered in this session. Open it once in its own mailbox and retry. |
| "This message id is used by more than one connected account" | Two logins use the same message id for different senders and no message is open. Open the message (or use the reader toolbar) so the plugin can tell which sender you mean. |
| Change saved but "did not confirm the lookup reload" | The key lacks `sysActionCreate` or `actionReloadLookupStores`, or the action failed. The rule will appear after Stalwart reloads its lookup stores. |
| Badge is stale | Badges refresh every 30 seconds and immediately after the plugin changes something. Reload the page to force a fresh cache. |