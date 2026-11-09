#!/usr/bin/env node
'use strict';

/**
 * Stubbed-host smoke test for the Block Domain plugin.
 *
 * It loads the real index.js inside a vm context, provides the modules the
 * Bulwark sandbox provides, and answers JMAP requests with an in-memory fake of
 * Stalwart's blocked-domains lookup. No network, no real mail server.
 *
 * Run with: node test/smoke.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'block-domain');
const SOURCE_PATH = path.join(PLUGIN_DIR, 'index.js');
const MANIFEST_PATH = path.join(PLUGIN_DIR, 'manifest.json');
const ICON_PATH = path.join(PLUGIN_DIR, 'icon.png');

const source = fs.readFileSync(SOURCE_PATH, 'utf8');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

let checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 10));
}

/* -------------------------------------------------------------------------- */
/* Static checks                                                              */
/* -------------------------------------------------------------------------- */

equal(manifest.id, 'block-domain', 'manifest id');
equal(manifest.type, 'ui-extension', 'manifest type');
equal(manifest.entrypoint, 'index.js', 'manifest entrypoint');
equal(manifest.minAppVersion, '1.15.0', 'manifest minAppVersion');
equal(manifest.icon, 'icon.png', 'manifest icon');
equal(
  manifest.permissions.slice().sort(),
  ['email:read', 'http:proxy', 'ui:message-list', 'ui:settings-section', 'ui:toolbar'].sort(),
  'manifest permissions are exactly the documented set'
);
ok(manifest.configSchema.stalwartUrl.required === true, 'stalwartUrl is required');
equal(manifest.configSchema.stalwartUrl.type, 'string', 'stalwartUrl type');
equal(manifest.configSchema.apiKey.type, 'secret', 'apiKey is a secret');
ok(manifest.configSchema.apiKey.required === true, 'apiKey is required');
equal(manifest.settingsSchema.blockTarget.type, 'select', 'blockTarget is a select');
equal(manifest.settingsSchema.blockTarget.default, 'target.ask', 'blockTarget default');
equal(
  manifest.settingsSchema.blockTarget.options,
  ['target.ask', 'target.exact', 'target.base'],
  'blockTarget options'
);
equal(manifest.credentials.stalwart.scope, 'admin', 'credential scope');
equal(manifest.credentials.stalwart.secretKey, 'apiKey', 'credential secretKey');
equal(manifest.credentials.stalwart.originKey, 'stalwartUrl', 'credential originKey');
equal(manifest.credentials.stalwart.inject.type, 'bearer', 'credential inject');

for (const [key, value] of Object.entries(manifest.locales.en)) {
  ok(typeof value === 'string' && value.length > 0, 'locale string ' + key);
}

const iconSize = fs.statSync(ICON_PATH).size;
ok(iconSize > 0 && iconSize <= 256 * 1024, 'icon.png is at most 256 KB');

const forbidden = [
  ['eval(', /eval\s*\(/],
  ['new Function(', /new\s+Function\s*\(/],
  ['innerHTML =', /innerHTML\s*=/],
  ['document.write(', /document\.write\s*\(/],
  ['document.cookie', /document\.cookie/],
  ['a hard-coded https URL', /https:\/\//]
];
for (const [label, pattern] of forbidden) {
  ok(!pattern.test(source), 'plugin source does not contain ' + label);
}

/* -------------------------------------------------------------------------- */
/* Fake Bulwark host                                                          */
/* -------------------------------------------------------------------------- */

function createFakeUi() {
  const ui = {
    actions: {},
    dialogs: [],
    confirmations: [],
    badgeRefreshes: 0,
    async setActions(surface, actions) {
      ui.actions[surface] = actions;
    },
    async openDialog(options) {
      ui.dialogs.push(options);
      const props = options.extraProps || {};
      if (props.kind === 'choose') {
        // The test drives target.base / target.exact through settings, but if a
        // chooser appears, deliberately pick the broadest option.
        return props.mode === 'unblock' ? 'both' : props.baseDomainChoice;
      }
      return true;
    },
    async confirm(options) {
      ui.confirmations.push(options);
      return true;
    },
    refreshRowBadges() {
      ui.badgeRefreshes += 1;
    }
  };
  return ui;
}

function createFakeStalwart() {
  const server = {
    entries: [],
    nextId: 1,
    calls: [],
    failStatus: 0,
    failBody: '',
    responseOrderReversed: true
  };

  async function proxyFetch(credentialId, url, options) {
    equal(credentialId, 'stalwart', 'proxy credential id');
    ok(/\/jmap\/$/.test(url), 'proxy URL ends in /jmap/: ' + url);
    const payload = JSON.parse(options.body);
    server.calls.push({ url, payload });

    if (server.failStatus) {
      return {
        status: server.failStatus,
        ok: false,
        headers: {},
        body: server.failBody || 'denied by test'
      };
    }

    const responses = [];
    const queryResults = {};

    for (const call of payload.methodCalls) {
      const name = call[0];
      const args = call[1] || {};
      const callId = call[2];

      if (name === 'x:MemoryLookupKey/query') {
        const namespace = args.filter && args.filter.namespace;
        const matching = server.entries.filter((entry) => entry.namespace === namespace);
        const position = typeof args.position === 'number' ? args.position : 0;
        const limit = typeof args.limit === 'number' ? args.limit : 500;
        const ids = matching.slice(position, position + limit).map((entry) => entry.id);
        queryResults[callId] = ids;
        responses.push([
          name,
          {
            accountId: 'account-1',
            queryState: 'q1',
            canCalculateChanges: false,
            position,
            ids,
            total: matching.length
          },
          callId
        ]);
      } else if (name === 'x:MemoryLookupKey/get') {
        let ids = args.ids;
        if (!ids && args['#ids']) {
          ids = queryResults[args['#ids'].resultOf] || [];
        }
        ids = ids || [];
        const list = ids
          .map((id) => server.entries.find((entry) => entry.id === id))
          .filter(Boolean)
          .map((entry) => Object.assign({}, entry));
        responses.push([
          name,
          { accountId: 'account-1', state: 's1', list, notFound: [] },
          callId
        ]);
      } else if (name === 'x:MemoryLookupKey/set') {
        const created = {};
        const notCreated = {};
        const destroyed = [];
        const notDestroyed = {};

        Object.keys(args.create || {}).forEach((clientId) => {
          const object = args.create[clientId];
          if (!object || !object.key) {
            notCreated[clientId] = { type: 'invalidArguments', description: 'missing key' };
            return;
          }
          const entry = {
            id: 'k' + server.nextId++,
            namespace: object.namespace,
            key: object.key,
            isGlobPattern: object.isGlobPattern === true
          };
          server.entries.push(entry);
          created[clientId] = { id: entry.id };
        });

        (args.destroy || []).forEach((id) => {
          const index = server.entries.findIndex((entry) => entry.id === id);
          if (index === -1) {
            notDestroyed[id] = { type: 'notFound', description: 'no such id' };
            return;
          }
          server.entries.splice(index, 1);
          destroyed.push(id);
        });

        responses.push([
          name,
          {
            accountId: 'account-1',
            oldState: 's1',
            newState: 's2',
            created,
            destroyed,
            notCreated,
            notDestroyed
          },
          callId
        ]);
      } else if (name === 'x:Action/set') {
        responses.push([
          name,
          { accountId: 'account-1', created: { r1: { id: 'action-1' } } },
          callId
        ]);
      } else {
        responses.push(['error', { type: 'unknownMethod', description: name }, callId]);
      }
    }

    // RFC 8620 lets a server reply in any order. Reversing proves the plugin
    // reads responses by method name.
    if (server.responseOrderReversed) responses.reverse();

    return {
      status: 200,
      ok: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ methodResponses: responses })
    };
  }

  return { server, proxyFetch };
}

function createHost(options) {
  const settings = Object.assign(
    { blockTarget: 'target.ask' },
    (options && options.settings) || {}
  );
  const config = Object.assign(
    { stalwartUrl: 'https://mail.test' },
    (options && options.config) || {}
  );
  const emails = Object.assign({}, (options && options.emails) || {});
  const ui = createFakeUi();
  const stalwart = createFakeStalwart();
  const toasts = [];
  const logs = [];
  const emailCalls = [];

  const api = {
    config: {
      async get() {
        return Object.assign({}, config);
      }
    },
    proxy: {
      fetch: stalwart.proxyFetch
    },
    email: {
      async get(id, accountId) {
        emailCalls.push({ id, accountId });
        if (accountId !== undefined && typeof accountId !== 'string') {
          throw new Error('accountId must be a string');
        }
        return emails[id] || null;
      }
    },
    ui,
    plugin: { settings },
    toast: {
      info(message) { toasts.push({ kind: 'info', message }); },
      success(message) { toasts.push({ kind: 'success', message }); },
      warning(message) { toasts.push({ kind: 'warning', message }); },
      error(message) { toasts.push({ kind: 'error', message }); }
    },
    log: {
      info(message, detail) { logs.push({ level: 'info', message, detail }); },
      warn(message, detail) { logs.push({ level: 'warn', message, detail }); },
      error(message, detail) { logs.push({ level: 'error', message, detail }); }
    }
  };

  return { api, ui, server: stalwart.server, toasts, logs, emailCalls, config, settings };
}

function loadPlugin(host) {
  const react = {
    createElement(type, props) {
      return { type, props };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, function () {}];
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial };
    }
  };
  const hostUi = {
    Button: function Button() {},
    DialogButtons: function DialogButtons() {}
  };

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require(id) {
      if (id === 'react') return react;
      if (id === '@plugin-host/ui') return hostUi;
      if (id === '@plugin-host') return host.api;
      throw new Error('Unexpected require: ' + id);
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Set,
    Map,
    Date,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    Error
  };

  vm.runInNewContext(source, sandbox, { filename: SOURCE_PATH });
  return module.exports;
}

function badgeLabels(plugin, badges, email) {
  const result = plugin.hooks.onEmailListItemRender(badges || [], { email });
  return Array.from(result || [], (badge) => badge.label);
}

function lastToast(host) {
  return host.toasts[host.toasts.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Scenario: block, badge, glob, unblock                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const host = createHost({
    settings: { blockTarget: 'target.exact' },
    emails: {
      e1: { id: 'e1', accountId: 'account-1', from: [{ email: 'evil@spam.example.com' }] },
      e2: { id: 'e2', accountId: 'account-1', from: [{ email: 'a@foo.example.com' }] },
      e3: { id: 'e3', accountId: 'account-1', from: [{ email: 'nobody@other.example' }] }
    }
  });

  const plugin = loadPlugin(host);
  equal(Object.keys(plugin).sort(), ['activate', 'hooks', 'slots'], 'exact plugin exports');
  ok(plugin.slots['plugin-dialog'].component, 'dialog slot is registered');
  ok(plugin.slots['settings-section'].component, 'settings slot is registered');

  await plugin.activate(host.api);
  await tick();

  ok(host.ui.actions['reader-actions'], 'reader actions registered');
  ok(host.ui.actions['message-row-actions'], 'message row actions registered');
  equal(
    Array.from(host.ui.actions['reader-actions'], (action) => action.id),
    ['block-domain', 'unblock-domain'],
    'reader action ids'
  );
  equal(
    Array.from(host.ui.actions['reader-actions'][0].mailboxRoles),
    ['junk'],
    'reader actions are limited to the Spam folder'
  );
  equal(
    Array.from(host.ui.actions['message-row-actions'], (action) => action.id),
    ['block-domain', 'unblock-domain'],
    'row action ids'
  );
  equal(
    host.ui.actions['message-row-actions'][0].notBadge,
    'block-domain-blocked',
    'row block action is gated on the row not being blocked'
  );
  equal(
    host.ui.actions['message-row-actions'][1].hasBadge,
    'block-domain-blocked',
    'row unblock action is gated on the row being blocked'
  );
  ok(!host.ui.actions['message-row-actions'][0].danger, 'row block action is not always red');
  ok(!host.ui.actions['message-row-actions'][1].danger, 'row unblock action is not always red');

  // Block an exact host.
  await plugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'e1' } });
  equal(
    host.server.entries.map((entry) => entry.key + (entry.isGlobPattern ? ' (glob)' : '')),
    ['spam.example.com'],
    'exact block created one bare entry'
  );
  equal(lastToast(host).kind, 'success', 'block success toast');
  ok(/rejected at SMTP time/.test(lastToast(host).message), 'success names SMTP rejection');
  ok(host.ui.badgeRefreshes > 0, 'row badges refreshed after the change');

  const setCall = host.server.calls
    .map((call) => call.payload)
    .find((payload) => payload.methodCalls.some((call) => call[0] === 'x:MemoryLookupKey/set'));
  ok(setCall, 'a set request was sent');
  ok(
    setCall.methodCalls.some((call) => call[0] === 'x:Action/set'),
    'ReloadLookupStores travels in the same request as the set'
  );

  // Badge appears for the blocked host, not for its parent without a glob.
  equal(
    badgeLabels(plugin, [], { id: 'e1', from: [{ email: 'evil@spam.example.com' }] }),
    ['Blocked'],
    'blocked row has a Blocked badge'
  );
  equal(
    badgeLabels(plugin, [], { id: 'x1', from: [{ email: 'other@sub.spam.example.com' }] }),
    [],
    'sibling host is not covered by an exact entry'
  );

  // Blocking again is a no-op with an honest message.
  const countBefore = host.server.entries.length;
  await plugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'e1' } });
  equal(host.server.entries.length, countBefore, 'already-blocked block makes no change');
  ok(/already blocked/.test(lastToast(host).message), 'already-blocked message');

  // Block a base domain and its subdomains.
  host.settings.blockTarget = 'target.base';
  await plugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'e2' } });
  equal(
    host.server.entries.map((entry) => entry.key + (entry.isGlobPattern ? ' (glob)' : '')).sort(),
    ['*.example.com (glob)', 'example.com', 'spam.example.com'],
    'base block adds the bare base entry and a glob'
  );
  equal(
    badgeLabels(plugin, [], { id: 'x2', from: [{ email: 'a@deep.sub.example.com' }] }),
    ['Blocked'],
    'glob entry covers a deep subdomain'
  );
  equal(
    badgeLabels(plugin, [], { id: 'x3', from: [{ email: 'a@notexample.com' }] }),
    [],
    'glob does not over-match a different domain'
  );

  // Unblock both families for e1. fake openDialog returns "both".
  await plugin.hooks.onAction({ actionId: 'unblock-domain', context: { emailId: 'e1' } });
  equal(host.server.entries.length, 0, 'unblock both removed every matching entry');
  ok(/Unblocked/.test(lastToast(host).message), 'unblock success toast');
  equal(
    badgeLabels(plugin, [], { id: 'e1', from: [{ email: 'evil@spam.example.com' }] }),
    [],
    'badge disappears after unblock'
  );

  // Unblock a completely unrelated domain while the list is non-empty: info only.
  await plugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'e1' } });
  await plugin.hooks.onAction({ actionId: 'unblock-domain', context: { emailId: 'e3' } });
  ok(/not blocked/.test(lastToast(host).message), 'not-blocked unblock message');
  equal(lastToast(host).kind, 'info', 'not-blocked message is informational');

  /* ---------------------------------------------------------------------- */
  /* Scenario: unified mailbox fallback and error messages                  */
  /* ---------------------------------------------------------------------- */

  const fallbackHost = createHost({
    settings: { blockTarget: 'target.exact' },
    emails: {
      e4: { id: 'e4', accountId: 'other-login', from: [{ email: 'boss@blocked.example' }] }
    }
  });
  const fallbackPlugin = loadPlugin(fallbackHost);
  await fallbackPlugin.activate(fallbackHost.api);
  await tick();

  // Remember the sender first, then let email.get return null as it does for a
  // message from another connected login.
  fallbackPlugin.hooks.onEmailOpen({ id: 'e5', accountId: 'other-login', from: [{ email: 'x@remembered.example' }] });
  await fallbackPlugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'e5', accountId: 'other-login' } });
  ok(
    fallbackHost.server.entries.some((entry) => entry.key === 'remembered.example'),
    'remembered sender works when email.get returns null'
  );
  const scopedGet = fallbackHost.emailCalls[fallbackHost.emailCalls.length - 1];
  ok(typeof scopedGet.accountId === 'string', 'email.get receives the account id as a string');

  // Missing sender: clear error, not silence.
  await fallbackPlugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'missing' } });
  equal(lastToast(fallbackHost).kind, 'error', 'unreadable message produces an error toast');
  ok(/could not be read/i.test(lastToast(fallbackHost).message), 'unreadable message explains itself');

  // HTTP 401 has the exact documented message.
  fallbackHost.server.failStatus = 401;
  await fallbackPlugin.hooks.onAction({
    actionId: 'block-domain',
    context: { emailId: 'e5', accountId: 'other-login' }
  });
  ok(
    fallbackHost.toasts.some(
      (toast) => toast.kind === 'error' && /Stalwart rejected the API key\./.test(toast.message)
    ),
    '401 gives the exact API-key message'
  );
  fallbackHost.server.failStatus = 0;

  /* ---------------------------------------------------------------------- */
  /* Scenario: unified inbox without an accountId in the click context      */
  /* ---------------------------------------------------------------------- */

  const unifiedHost = createHost({ settings: { blockTarget: 'target.exact' } });
  const unifiedPlugin = loadPlugin(unifiedHost);
  await unifiedPlugin.activate(unifiedHost.api);
  await tick();

  // Bulwark's unified rows from another login are stamped with the source
  // account, but the click context leaves accountId out when that login's own
  // account is the owner. The row hook is the only source of the sender.
  unifiedPlugin.hooks.onEmailListItemRender([], {
    email: {
      id: 'u1',
      accountId: 'login-b',
      from: [{ email: 'sender@unified.example' }]
    }
  });
  await unifiedPlugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'u1' } });
  ok(
    unifiedHost.server.entries.some((entry) => entry.key === 'unified.example'),
    'cross-login row blocks without an accountId in the context'
  );

  // The same message id can exist in two logins. Without an opened message the
  // plugin must refuse instead of guessing which sender to block.
  unifiedPlugin.hooks.onEmailListItemRender([], {
    email: { id: 'u2', accountId: 'login-b', from: [{ email: 'a@one.example' }] }
  });
  unifiedPlugin.hooks.onEmailListItemRender([], {
    email: { id: 'u2', accountId: 'login-c', from: [{ email: 'b@two.example' }] }
  });
  await unifiedPlugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'u2' } });
  ok(/ambiguous/i.test(lastToast(unifiedHost).message), 'colliding ids without an open message are refused');
  equal(
    unifiedHost.server.entries.filter(
      (entry) => entry.key === 'one.example' || entry.key === 'two.example'
    ).length,
    0,
    'ambiguous id blocks nothing'
  );

  // Opening the message resolves the ambiguity for the reader actions.
  unifiedPlugin.hooks.onEmailOpen({
    id: 'u2',
    accountId: 'login-c',
    from: [{ email: 'b@two.example' }]
  });
  await unifiedPlugin.hooks.onAction({ actionId: 'block-domain', context: { emailId: 'u2' } });
  ok(
    unifiedHost.server.entries.some((entry) => entry.key === 'two.example'),
    'the opened message resolves a colliding id'
  );

  /* ---------------------------------------------------------------------- */
  /* Scenario: missing configuration                                       */
  /* ---------------------------------------------------------------------- */

  const unconfiguredHost = createHost({ config: { stalwartUrl: '' } });
  const unconfiguredPlugin = loadPlugin(unconfiguredHost);
  await unconfiguredPlugin.activate(unconfiguredHost.api);
  await tick(30);
  ok(
    unconfiguredHost.toasts.some(
      (toast) => toast.kind === 'error' && /not configured/i.test(toast.message)
    ),
    'activation reports missing configuration'
  );

  console.log('Block Domain smoke test passed: ' + checks + ' checks.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
