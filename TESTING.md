# Testing Block Domain

Two layers: a fast stubbed-host smoke test that needs no server, and a manual
pass against a real Stalwart instance. Both are expected before a release.

## Automated smoke test

```sh
node --check block-domain/index.js
node -e 'JSON.parse(require("fs").readFileSync("block-domain/manifest.json", "utf8"))'
node test/smoke.cjs
```

`test/smoke.cjs` loads the real `block-domain/index.js` in a `vm` context
that provides `react`, `@plugin-host` and `@plugin-host/ui`, just like the
Bulwark sandbox. It replaces Stalwart with an in-memory JMAP fake and checks:

- the manifest's id, type, entrypoint, minimum version, icon, exact permission
  set, config fields, `blockTarget` setting, locale strings, and the admin
  credential wiring;
- the forbidden code patterns (`eval(`, `new Function(`, `innerHTML =`,
  `document.write(`, `document.cookie`, hard-coded `https://` URLs);
- the icon is present and at most 256 KB;
- exactly `activate`, `hooks` and `slots` are exported;
- both action surfaces are registered, with reader actions limited to Spam;
- an exact block creates one bare entry, sends ReloadLookupStores in the same
  request as the set, and shows the SMTP-rejection success toast;
- the Blocked badge appears for the exact host, not for a sibling subdomain;
- blocking an already-blocked domain changes nothing and says so;
- a base-domain block creates both the bare base entry and `*.<base>`;
- the glob badge covers deep subdomains without matching a different domain;
- unblocking both families removes every matching id and clears the badge;
- an unrelated unblock is informational and changes nothing;
- `api.email.get` receives the account id as a string;
- a remembered sender still works when `api.email.get` returns `null`;
- a cross-login row blocks with no `accountId` in the click context;
- colliding message ids in two logins are refused until the message is opened;
- an unreadable message produces a clear error instead of silence;
- HTTP 401 produces the exact message "Stalwart rejected the API key.";
- activation with no configured URL reports "not configured".

The fake server reverses JMAP method responses to prove the plugin reads them by
method name, not by array position.

The smoke test does not exercise React rendering. The settings section and
dialogs are checked in the manual pass below.

## Manual test on a real Stalwart server

Use a disposable Stalwart test server and a test account. Every change is
server-wide: it is visible to all accounts and rejects matching mail at SMTP
time. Do not test on a production server without permission.

### Setup

1. Install Bulwark 1.15.0 or later.
2. Create an API key with only `sysMemoryLookupKeyGet`,
   `sysMemoryLookupKeyQuery`, `sysMemoryLookupKeyCreate`,
   `sysMemoryLookupKeyDestroy`, `sysActionCreate` and
   `actionReloadLookupStores`.
3. Install the plugin and configure the Stalwart URL and API key.
4. Send test mail from a domain you control, including a subdomain such as
   `news.example.test` where the base is `example.test`.

### Cases

| Case | Steps | Expected |
|---|---|---|
| Unconfigured | Clear the Stalwart URL and reload | An error toast says Block Domain is not configured; no crash |
| Bad key | Replace the key with a wrong one, block a domain | "Stalwart rejected the API key." |
| Missing permission | Use a key without `sysMemoryLookupKeyCreate` | A permission message, not a silent failure |
| Exact block | In the inbox, hover a row, choose **Block domain**, confirm | Success toast; domain appears in Settings > Plugins; the Stalwart list shows one bare entry |
| Already blocked | Run the same block again | Informational "already blocked" toast; no duplicate |
| Subdomain, ask | Send from `news.example.test`, default setting | Chooser offers the exact host and the base; confirm names the chosen domain, server-wide scope and SMTP rejection |
| Subdomain, exact | Set *Block only the exact domain*, block a subdomain | Only the subdomain entry is created |
| Subdomain, base | Set *Block the base domain and all subdomains*, block a subdomain | Bare base and `*.base` entries are created |
| SMTP rejection | After a block, send mail from the domain | Stalwart rejects it at SMTP time, not just at delivery |
| Reload warning | Use a key without the action permission, make a change | Change is saved; a warning says the reload was not confirmed |
| Badge | Return to the message list after a block | Matching rows show a red **Blocked** badge with the domain in the title |
| Glob badge | Block a base, then view a message from another subdomain | Badge appears; an unrelated domain does not get one |
| Right-click | Right-click a row | Both actions appear in the menu |
| Spam toolbar | Open a message in Spam | Both actions appear in the reader toolbar; they do not appear in Inbox |
| Unblock exact | Only the exact host is blocked, choose **Unblock domain** | One confirmation; the exact entry is removed |
| Unblock both | Exact and base/glob entries exist | Chooser offers exact, base, or both; the chosen entries are removed |
| Not blocked | Unblock a domain with no entries | Informational toast; nothing changes |
| Settings list | Open Settings > Plugins > Block Domain | Sorted list, correct count, server-wide notice, loading and error/retry states |
| Show more | Block more than 200 domains (or seed the list) | First 200 shown; **Show more** reveals the next page |
| Settings unblock | Click **Unblock** on a row, confirm | Row's button shows busy; other Unblock buttons and Refresh are disabled; list refreshes |
| Rapid clicks | Double-click Block or Unblock | Only one mutation runs; the second is refused or ignored |
| Unified mailbox | Open a message from another connected login, then act on it | Action works from the row or reader; if never seen, the error explains how to retry |
| Unified inbox row | In the unified inbox, block and unblock a row from another connected login without opening it | Both actions work without asking for an account id |
| Colliding ids | Set up two logins whose first message has the same id and different senders, then act on an unopened row | The plugin refuses with the ambiguity message; acting on the opened message works |
| Enter key | Open a confirmation or chooser, press Enter | The destructive/default action runs once; Escape closes without changing anything |
| Pagination | Seed more than 500 entries | All pages are read; the settings list is complete. More than 50,000 entries must refuse rather than show a partial list |
| Empty list | Remove all entries, open the settings section | "No domains are blocked." |
| Cross-frame refresh | Change a domain in the settings frame, return to the message list | Badge updates within 30 seconds without a page reload |

### After testing

Remove the test entries from Stalwart, revoke the test API key, and uninstall
the plugin if it was installed only for testing. Check the Bulwark browser
console and the Stalwart server log for unexpected errors.
