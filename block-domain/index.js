/**
 * Block Domain for Bulwark Webmail
 *
 * Adds "Block domain" and "Unblock domain" to every message row (hover and
 * right-click menu), and to the open-message toolbar in the Spam folder.
 * The actual rules live in Stalwart's blocked-domains spam-filter lookup.
 *
 * This file is deliberately a single CommonJS file with no build step. It is
 * loaded directly by Bulwark's plugin sandbox, where `require` knows React and
 * the plugin host modules. Keeping the source and the bundle identical makes
 * the shipped code the reviewed code.
 *
 * The host API is only used through the documented surface:
 *   api.config.get()
 *   api.proxy.fetch('stalwart', ...)
 *   api.email.get(id, opts)
 *   api.ui.setActions / openDialog / confirm / refreshRowBadges
 *   api.toast.* / api.log.* / api.plugin.settings
 *
 * Everything a user could be surprised by (server-wide changes, SMTP-time
 * rejection) is named in the confirmation dialog before a request is sent.
 */

'use strict';

var React = require('react');
var hostUi = require('@plugin-host/ui');

var h = React.createElement;
var Button = hostUi.Button;
var DialogButtons = hostUi.DialogButtons;

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

var NAMESPACE = 'blocked-domains';
var JMAP_CORE = 'urn:ietf:params:jmap:core';
var JMAP_STALWART = 'urn:stalwart:jmap';
var PAGE_SIZE = 500;
var MAX_PAGES = 100; // 100 * 500 = the documented 50,000-entry safety limit.
var MAX_SENDER_CACHE = 1000;
var SETTINGS_PAGE_SIZE = 200;
var CACHE_TTL_MS = 30000;

var ACTION_BLOCK = 'block-domain';
var ACTION_UNBLOCK = 'unblock-domain';
var BADGE_KEY = 'block-domain-blocked';

var TARGET_ASK = 'target.ask';
var TARGET_EXACT = 'target.exact';
var TARGET_BASE = 'target.base';

/* -------------------------------------------------------------------------- */
/* Host API access                                                             */
/* -------------------------------------------------------------------------- */

// activate() receives the api in the hidden background frame. Slot frames do
// not run activate, so they ask the host for the same object instead. Keeping
// one reference per frame is important: each frame has its own module state.
var backgroundApi = null;

function setApi(api) {
  backgroundApi = api;
}

function getApi() {
  if (backgroundApi) return backgroundApi;
  try {
    backgroundApi = require('@plugin-host');
  } catch (err) {
    backgroundApi = null;
  }
  if (!backgroundApi) {
    throw new Error('The Bulwark plugin host API is not available in this frame.');
  }
  return backgroundApi;
}

function errorText(err) {
  if (!err) return 'Unknown error.';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  return String(err);
}

function clip(text, max) {
  var value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

function logAt(level, message, detail) {
  try {
    var logger = getApi().log;
    var fn = logger && logger[level];
    if (typeof fn === 'function') fn.call(logger, message, detail);
  } catch (err) {
    // Logging must never be the reason a hook fails.
  }
}

// api.toast caps messages at 300 characters. Trimming here keeps the important
// part visible instead of letting the host reject a long server response.
function toast(kind, message) {
  try {
    var toaster = getApi().toast;
    var fn = toaster && toaster[kind];
    if (typeof fn === 'function') fn.call(toaster, clip(message, 300));
  } catch (err) {
    logAt('warn', 'Could not show a toast', err);
  }
}

function reportError(prefix, err) {
  logAt('error', prefix, err);
  var detail = errorText(err);
  toast('error', prefix ? prefix + ': ' + detail : detail);
}

function pluginError(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

// The credential's origin is the configured Stalwart URL. The JMAP endpoint is
// that origin plus /jmap/. Accept a URL that already names /jmap so admins can
// paste either form and get the same result.
function buildJmapUrl(rawUrl) {
  var url = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!/\/jmap$/i.test(url)) url += '/jmap';
  return url + '/';
}

async function readConfig() {
  var config;
  try {
    config = await getApi().config.get();
  } catch (err) {
    logAt('error', 'Could not read the plugin configuration', err);
    throw new Error('Could not read the Block Domain configuration: ' + errorText(err));
  }

  var rawUrl = config && config.stalwartUrl ? String(config.stalwartUrl).trim() : '';
  if (!rawUrl) {
    throw pluginError(
      'not-configured',
      'Block Domain is not configured. Ask an administrator to set the Stalwart URL and API key on the plugin page.'
    );
  }

  return {
    stalwartUrl: rawUrl,
    jmapUrl: buildJmapUrl(rawUrl)
  };
}

/* -------------------------------------------------------------------------- */
/* Domain helpers                                                              */
/* -------------------------------------------------------------------------- */

// A deliberately small, built-in subset of common two-label public suffixes.
// This avoids a network dependency and covers the usual multi-label ccTLD
// registries, so news.bbc.co.uk becomes bbc.co.uk rather than co.uk.
var TWO_LABEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'mod.uk', 'net.uk', 'nhs.uk',
  'nic.uk', 'org.uk', 'plc.uk', 'police.uk', 'sch.uk',
  'asn.au', 'com.au', 'edu.au', 'gov.au', 'id.au', 'net.au', 'org.au',
  'ac.jp', 'ad.jp', 'co.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp', 'ne.jp',
  'or.jp',
  'com.br', 'edu.br', 'gov.br', 'mil.br', 'net.br', 'org.br',
  'ac.nz', 'co.nz', 'geek.nz', 'govt.nz', 'net.nz', 'org.nz', 'school.nz',
  'ac.za', 'co.za', 'gov.za', 'net.za', 'org.za', 'web.za',
  'ac.in', 'co.in', 'edu.in', 'firm.in', 'gen.in', 'gov.in', 'ind.in',
  'mil.in', 'net.in', 'org.in', 'res.in',
  'com.mx', 'edu.mx', 'gob.mx', 'net.mx', 'org.mx',
  'com.ar', 'edu.ar', 'gov.ar', 'net.ar', 'org.ar',
  'av.tr', 'bel.tr', 'biz.tr', 'com.tr', 'dr.tr', 'edu.tr', 'gen.tr',
  'gov.tr', 'info.tr', 'k12.tr', 'kep.tr', 'mil.tr', 'name.tr', 'net.tr',
  'org.tr', 'tel.tr', 'tsk.tr', 'tv.tr', 'web.tr',
  'ac.kr', 'co.kr', 'edu.kr', 'go.kr', 'hs.kr', 'kg.kr', 'mil.kr', 'ms.kr',
  'ne.kr', 'or.kr', 'pe.kr', 're.kr', 'sc.kr',
  'ac.th', 'co.th', 'go.th', 'in.th', 'mi.th', 'net.th', 'or.th',
  'com.sg', 'edu.sg', 'gov.sg', 'net.sg', 'org.sg', 'per.sg',
  'com.my', 'edu.my', 'gov.my', 'mil.my', 'name.my', 'net.my', 'org.my',
  'com.ph', 'edu.ph', 'gov.ph', 'i.ph', 'mil.ph', 'net.ph', 'ngo.ph', 'org.ph',
  'ac.vn', 'biz.vn', 'com.vn', 'edu.vn', 'gov.vn', 'health.vn', 'info.vn',
  'int.vn', 'name.vn', 'net.vn', 'org.vn', 'pro.vn',
  'ac.id', 'biz.id', 'co.id', 'go.id', 'mil.id', 'my.id', 'net.id', 'or.id',
  'org.id', 'sch.id', 'web.id',
  'club.tw', 'com.tw', 'ebiz.tw', 'edu.tw', 'game.tw', 'gov.tw', 'idv.tw',
  'mil.tw', 'net.tw', 'org.tw',
  'com.hk', 'edu.hk', 'gov.hk', 'idv.hk', 'net.hk', 'org.hk',
  'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'ac.il', 'co.il', 'gov.il', 'idf.il', 'k12.il', 'muni.il', 'net.il',
  'org.il',
  'com.sa', 'edu.sa', 'gov.sa', 'med.sa', 'net.sa', 'org.sa', 'pub.sa',
  'sch.sa',
  'com.eg', 'edu.eg', 'gov.eg', 'net.eg', 'org.eg', 'sci.eg',
  'ac.ae', 'co.ae', 'gov.ae', 'net.ae', 'org.ae', 'sch.ae',
  'com.qa', 'edu.qa', 'gov.qa', 'net.qa', 'org.qa',
  'com.ua', 'edu.ua', 'gov.ua', 'in.ua', 'net.ua', 'org.ua',
  'biz.pl', 'com.pl', 'gov.pl', 'info.pl', 'net.pl', 'org.pl', 'waw.pl',
  'ac.at', 'co.at', 'gv.at', 'or.at',
  'co.hu', 'info.hu', 'org.hu', 'priv.hu',
  'ac.rs', 'co.rs', 'edu.rs', 'gov.rs', 'in.rs', 'org.rs',
  'arts.ro', 'com.ro', 'edu.ro', 'firm.ro', 'gov.ro', 'info.ro', 'mil.ro',
  'net.ro', 'nom.ro', 'org.ro', 'rec.ro', 'shop.ro', 'store.ro',
  'com.gr', 'edu.gr', 'gov.gr', 'mil.gr', 'net.gr', 'org.gr',
  'ac.cy', 'com.cy', 'gov.cy', 'net.cy', 'org.cy',
  'com.mt', 'edu.mt', 'gov.mt', 'net.mt', 'org.mt',
  'ac.ke', 'co.ke', 'go.ke', 'info.ke', 'me.ke', 'ne.ke', 'or.ke', 'sc.ke',
  'com.ng', 'edu.ng', 'gov.ng', 'mobi.ng', 'name.ng', 'net.ng', 'org.ng',
  'sch.ng',
  'ac.zw', 'co.zw', 'gov.zw', 'mil.zw', 'org.zw',
  'ac.tz', 'co.tz', 'go.tz', 'hotel.tz', 'info.tz', 'me.tz', 'mobi.tz',
  'ne.tz', 'or.tz', 'sc.tz', 'tv.tz',
  'ac.ug', 'co.ug', 'com.ug', 'go.ug', 'med.ug', 'ne.ug', 'or.ug', 'org.ug',
  'sc.ug',
  'com.pk', 'edu.pk', 'gob.pk', 'gok.pk', 'gon.pk', 'gop.pk', 'gos.pk',
  'gov.pk', 'net.pk', 'org.pk',
  'ac.bd', 'com.bd', 'edu.bd', 'gov.bd', 'mil.bd', 'net.bd', 'org.bd',
  'com.np', 'edu.np', 'gov.np', 'mil.np', 'net.np', 'org.np',
  'assn.lk', 'com.lk', 'edu.lk', 'gov.lk', 'grp.lk', 'hotel.lk', 'ltd.lk',
  'net.lk', 'ngo.lk', 'org.lk', 'soc.lk', 'web.lk',
  'com.ec', 'edu.ec', 'fin.ec', 'gov.ec', 'info.ec', 'k12.ec', 'med.ec',
  'mil.ec', 'net.ec', 'org.ec', 'pro.ec',
  'com.pe', 'edu.pe', 'gob.pe', 'mil.pe', 'net.pe', 'nom.pe', 'org.pe',
  'com.co', 'edu.co', 'gov.co', 'mil.co', 'net.co', 'nom.co', 'org.co',
  'co.ve', 'com.ve', 'edu.ve', 'gov.ve', 'mil.ve', 'net.ve', 'org.ve',
  'com.uy', 'edu.uy', 'gov.uy', 'mil.uy', 'net.uy', 'org.uy',
  'com.py', 'edu.py', 'gov.py', 'mil.py', 'net.py', 'org.py',
  'com.bo', 'edu.bo', 'gov.bo', 'int.bo', 'mil.bo', 'net.bo', 'org.bo',
  'art.do', 'com.do', 'edu.do', 'gov.do', 'mil.do', 'net.do', 'org.do',
  'com.gt', 'edu.gt', 'gob.gt', 'ind.gt', 'mil.gt', 'net.gt', 'org.gt',
  'com.sv', 'edu.sv', 'gob.sv', 'mil.sv', 'net.sv', 'org.sv',
  'com.hn', 'edu.hn', 'gob.hn', 'mil.hn', 'net.hn', 'org.hn',
  'com.ni', 'edu.ni', 'gob.ni', 'mil.ni', 'net.ni', 'org.ni',
  'ac.cr', 'co.cr', 'ed.cr', 'fi.cr', 'go.cr', 'or.cr', 'sa.cr',
  'com.pa', 'edu.pa', 'gob.pa', 'mil.pa', 'net.pa', 'org.pa',
  'biz.az', 'com.az', 'edu.az', 'gov.az', 'info.az', 'mil.az', 'net.az',
  'org.az', 'pp.az',
  'com.ge', 'edu.ge', 'gov.ge', 'mil.ge', 'net.ge', 'org.ge',
  'com.am', 'edu.am', 'gov.am', 'mil.am', 'net.am', 'org.am',
  'com.by', 'edu.by', 'gov.by', 'mil.by', 'net.by', 'org.by',
  'com.kz', 'edu.kz', 'gov.kz', 'mil.kz', 'net.kz', 'org.kz',
  'co.uz', 'com.uz', 'net.uz', 'org.uz',
  'com.md', 'edu.md', 'gov.md', 'net.md', 'org.md',
  'com.mk', 'edu.mk', 'gov.mk', 'net.mk', 'org.mk',
  'com.al', 'edu.al', 'gov.al', 'net.al', 'org.al',
  'com.hr', 'edu.hr', 'gov.hr', 'net.hr', 'org.hr',
  'com.ba', 'edu.ba', 'gov.ba', 'net.ba', 'org.ba',
  'ac.me', 'co.me', 'edu.me', 'gov.me', 'net.me', 'org.me',
  'com.mm', 'edu.mm', 'gov.mm', 'net.mm', 'org.mm',
  'com.kh', 'edu.kh', 'gov.kh', 'net.kh', 'org.kh',
  'com.la', 'edu.la', 'gov.la', 'net.la', 'org.la',
  'com.mo', 'edu.mo', 'gov.mo', 'net.mo', 'org.mo',
  'com.bn', 'edu.bn', 'gov.bn', 'net.bn', 'org.bn',
  'com.mv', 'edu.mv', 'gov.mv', 'net.mv', 'org.mv',
  'com.af', 'edu.af', 'gov.af', 'net.af', 'org.af',
  'com.iq', 'edu.iq', 'gov.iq', 'mil.iq', 'net.iq', 'org.iq',
  'com.jo', 'edu.jo', 'gov.jo', 'mil.jo', 'net.jo', 'org.jo',
  'com.lb', 'edu.lb', 'gov.lb', 'net.lb', 'org.lb',
  'com.sy', 'edu.sy', 'gov.sy', 'net.sy', 'org.sy',
  'com.ye', 'edu.ye', 'gov.ye', 'net.ye', 'org.ye',
  'com.om', 'edu.om', 'gov.om', 'mil.om', 'net.om', 'org.om',
  'com.bh', 'edu.bh', 'gov.bh', 'net.bh', 'org.bh',
  'com.kw', 'edu.kw', 'gov.kw', 'net.kw', 'org.kw',
  'com.ps', 'edu.ps', 'gov.ps', 'net.ps', 'org.ps',
  'ac.mz', 'co.mz', 'edu.mz', 'gov.mz', 'org.mz',
  'co.ao', 'edu.ao', 'gov.ao', 'net.ao', 'org.ao',
  'co.bw', 'org.bw',
  'ac.zm', 'co.zm', 'gov.zm', 'org.zm',
  'ac.mw', 'co.mw', 'edu.mw', 'gov.mw', 'org.mw',
  'ac.mu', 'co.mu', 'com.mu', 'edu.mu', 'gov.mu', 'net.mu', 'org.mu',
  'co.sc', 'com.sc', 'edu.sc', 'gov.sc', 'net.sc', 'org.sc',
  'ac.fj', 'com.fj', 'edu.fj', 'gov.fj', 'net.fj', 'org.fj',
  'com.pg', 'edu.pg', 'gov.pg', 'net.pg', 'org.pg',
  'com.sb', 'edu.sb', 'gov.sb', 'net.sb', 'org.sb',
  'com.vu', 'edu.vu', 'gov.vu', 'net.vu', 'org.vu',
  'com.ws', 'edu.ws', 'gov.ws', 'net.ws', 'org.ws',
  'com.to', 'edu.to', 'gov.to', 'net.to', 'org.to',
  'biz.ck', 'co.ck', 'edu.ck', 'gen.ck', 'gov.ck', 'info.ck', 'net.ck',
  'org.ck',
  'com.nf', 'edu.nf', 'gov.nf', 'net.nf', 'org.nf',
  'com.ai', 'edu.ai', 'gov.ai', 'net.ai', 'off.ai', 'org.ai',
  'com.ag', 'edu.ag', 'gov.ag', 'net.ag', 'org.ag',
  'com.bb', 'edu.bb', 'gov.bb', 'net.bb', 'org.bb',
  'com.bs', 'edu.bs', 'gov.bs', 'net.bs', 'org.bs',
  'com.bz', 'edu.bz', 'gov.bz', 'net.bz', 'org.bz',
  'com.cu', 'edu.cu', 'gov.cu', 'net.cu', 'org.cu',
  'com.dm', 'edu.dm', 'gov.dm', 'net.dm', 'org.dm',
  'com.gd', 'edu.gd', 'gov.gd', 'net.gd', 'org.gd',
  'com.gy', 'edu.gy', 'gov.gy', 'net.gy', 'org.gy',
  'com.jm', 'edu.jm', 'gov.jm', 'net.jm', 'org.jm',
  'com.kn', 'edu.kn', 'gov.kn', 'net.kn', 'org.kn',
  'com.lc', 'edu.lc', 'gov.lc', 'net.lc', 'org.lc',
  'com.vc', 'edu.vc', 'gov.vc', 'net.vc', 'org.vc',
  'com.tt', 'edu.tt', 'gov.tt', 'net.tt', 'org.tt',
  'com.tc', 'edu.tc', 'gov.tc', 'net.tc', 'org.tc',
  'com.ky', 'edu.ky', 'gov.ky', 'net.ky', 'org.ky',
  'com.bm', 'edu.bm', 'gov.bm', 'net.bm', 'org.bm',
  'com.pr', 'edu.pr', 'gov.pr', 'net.pr', 'org.pr',
  'com.vi', 'edu.vi', 'gov.vi', 'net.vi', 'org.vi',
  'ac.im', 'co.im', 'gov.im', 'net.im', 'org.im',
  'co.je', 'net.je', 'org.je',
  'co.gg', 'net.gg', 'org.gg',
  'com.gi', 'edu.gi', 'gov.gi', 'net.gi', 'org.gi',
  'ac.ir', 'co.ir', 'gov.ir', 'id.ir', 'net.ir', 'org.ir', 'sch.ir',
  'com.tm', 'co.tm', 'edu.tm', 'gov.tm', 'net.tm', 'org.tm',
  'com.kg', 'edu.kg', 'gov.kg', 'net.kg', 'org.kg',
  'com.tj', 'edu.tj', 'gov.tj', 'net.tj', 'org.tj',
  'com.mn', 'edu.mn', 'gov.mn', 'net.mn', 'org.mn',
  'com.sd', 'edu.sd', 'gov.sd', 'med.sd', 'net.sd', 'org.sd',
  'com.et', 'edu.et', 'gov.et', 'net.et', 'org.et',
  'com.so', 'edu.so', 'gov.so', 'net.so', 'org.so',
  'ac.rw', 'co.rw', 'com.rw', 'edu.rw', 'gov.rw', 'net.rw', 'org.rw',
  'co.bi', 'com.bi', 'edu.bi', 'or.bi', 'org.bi',
  'com.mg', 'edu.mg', 'gov.mg', 'net.mg', 'org.mg',
  'asso.km', 'com.km', 'co.km', 'edu.km', 'gov.km', 'mil.km', 'nom.km',
  'org.km', 'prd.km', 'tm.km',
  'com.cv', 'edu.cv', 'gov.cv', 'net.cv', 'org.cv',
  'co.st', 'com.st', 'edu.st', 'gov.st', 'mil.st', 'net.st', 'org.st',
  'com.gw', 'edu.gw', 'gov.gw', 'net.gw', 'org.gw',
  'com.gm', 'edu.gm', 'gov.gm', 'net.gm', 'org.gm',
  'com.sl', 'edu.sl', 'gov.sl', 'net.sl', 'org.sl',
  'com.lr', 'edu.lr', 'gov.lr', 'net.lr', 'org.lr',
  'com.ne', 'edu.ne', 'gov.ne', 'net.ne', 'org.ne',
  'com.ci', 'edu.ci', 'gov.ci', 'net.ci', 'org.ci',
  'com.sn', 'edu.sn', 'gov.sn', 'net.sn', 'org.sn',
  'com.gh', 'edu.gh', 'gov.gh', 'mil.gh', 'net.gh', 'org.gh',
  'com.ly', 'edu.ly', 'gov.ly', 'id.ly', 'med.ly', 'net.ly', 'org.ly',
  'plc.ly', 'sch.ly',
  'ac.ma', 'com.ma', 'gov.ma', 'net.ma', 'org.ma', 'press.ma',
  'com.tn', 'edu.tn', 'gov.tn', 'mil.tn', 'net.tn', 'org.tn',
  'com.dz', 'edu.dz', 'gov.dz', 'net.dz', 'org.dz'
]);

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.+$/, '');
}

// Returns the registrable base domain. A one- or two-label domain is its own
// base; multi-label ccTLDs use the built-in suffix list above.
function registrableBase(domain) {
  var value = normalizeDomain(domain);
  if (!value || value.indexOf('.') === -1) return value;
  if (/^\[.*\]$/.test(value)) return value;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value;

  var labels = value.split('.').filter(function (label) { return label.length > 0; });
  if (labels.length <= 2) return labels.join('.');

  var lastTwo = labels.slice(-2).join('.');
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) {
    // bbc.co.uk has three labels beyond a two-label suffix; news.bbc.co.uk
    // must therefore keep the last three labels, not the last two.
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function domainFromAddress(address) {
  if (!address) return '';
  var text = String(address).trim();

  // Accept both a bare address and a display-name form such as
  // "News <news@example.com>". The last @ is the split point either way.
  var open = text.lastIndexOf('<');
  if (open !== -1) {
    var close = text.indexOf('>', open);
    text = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close);
  }

  var at = text.lastIndexOf('@');
  if (at === -1) return '';
  var domain = normalizeDomain(text.slice(at + 1));
  if (!domain || /[\s@]/.test(domain)) return '';
  return domain;
}

function senderDomainOf(email) {
  if (!email) return '';
  var from = email.from;
  var first = Array.isArray(from) ? from[0] : from;
  if (!first) return '';
  if (typeof first === 'string') return domainFromAddress(first);
  return domainFromAddress(first.email || first.address || first.value);
}

function escapeRegexChar(character) {
  return '\\^$.*+?()[]{}|'.indexOf(character) === -1 ? character : '\\' + character;
}

// Stalwart stores glob entries such as "*.example.com". Compile them once so
// the per-row badge hook never has to build a regular expression while the
// user scrolls. '*' and '?' are the only wildcards Stalwart documents.
function globToRegex(glob) {
  var pattern = '^';
  var value = String(glob || '');
  for (var i = 0; i < value.length; i++) {
    var character = value.charAt(i);
    if (character === '*') pattern += '.*';
    else if (character === '?') pattern += '.';
    else pattern += escapeRegexChar(character);
  }
  return new RegExp(pattern + '$', 'i');
}

/* -------------------------------------------------------------------------- */
/* Sender memory, for unified mailboxes                                        */
/* -------------------------------------------------------------------------- */

// In a unified mailbox api.email.get can return null for a message belonging to
// another connected login. Remembering every sender we have already seen lets
// the action still work for those rows. Map keeps insertion order, so deleting
// the first key evicts the oldest entry.
var senderCache = new Map();

// The last message explicitly opened. Its sender resolves an id shared by two
// accounts, where the row cache alone would be ambiguous.
var lastOpened = null;

function senderCacheKey(emailId, accountId) {
  return (accountId ? String(accountId) + ':' : '') + String(emailId);
}

function rememberSender(email, opened) {
  if (!email) return '';
  var emailId = email.id || email.emailId;
  var domain = senderDomainOf(email);
  if (!emailId || !domain) return '';

  var key = senderCacheKey(emailId, email.accountId);
  if (senderCache.has(key)) senderCache.delete(key);
  senderCache.set(key, {
    emailId: String(emailId),
    accountId: email.accountId ? String(email.accountId) : '',
    domain: domain,
    from: email.from
  });
  while (senderCache.size > MAX_SENDER_CACHE) {
    var oldest = senderCache.keys().next();
    if (oldest.done) break;
    senderCache.delete(oldest.value);
  }
  if (opened) {
    lastOpened = {
      emailId: String(emailId),
      accountId: email.accountId ? String(email.accountId) : '',
      domain: domain,
      from: email.from
    };
  }
  return domain;
}

// The click context leaves accountId out for a message in the connected
// login's own account, even in the unified inbox. The row hook still cached
// that message under its source account, so fall back to matching on the id
// alone. If two logins use the same id for different senders, refuse rather
// than block the wrong domain.
function cachedSender(emailId, accountId) {
  var id = String(emailId);

  if (accountId) {
    var scoped = senderCache.get(senderCacheKey(id, accountId));
    if (scoped) return scoped;
    // An account id in the context means the message is not the signed-in
    // account's own. A bare cache entry is then a different view's message
    // with the same id, not a safe substitute.
    if (lastOpened && lastOpened.emailId === id && lastOpened.accountId === String(accountId)) {
      return lastOpened;
    }
    return null;
  }

  var matches = [];
  senderCache.forEach(function (entry) {
    if (entry && entry.emailId === id) matches.push(entry);
  });
  if (matches.length === 0) return null;

  var domains = new Set(matches.map(function (entry) { return entry.domain; }));
  if (domains.size === 1) return matches[matches.length - 1];

  // The user opened a specific message; that one is the answer for the reader
  // actions even when a row of another account shares its id.
  if (lastOpened && lastOpened.emailId === id) return lastOpened;
  return { ambiguous: true };
}

/* -------------------------------------------------------------------------- */
/* Blocked-domain cache                                                        */
/* -------------------------------------------------------------------------- */

var blockedCache = {
  exact: new Set(),
  patterns: [],
  loaded: false,
  loadedAt: 0
};
var cacheLoadPromise = null;
var lastCacheAttemptAt = 0;

function buildBlockedCache(entries) {
  var exact = new Set();
  var patterns = [];

  entries.forEach(function (entry) {
    var key = normalizeDomain(entry && entry.key);
    if (!key) return;
    if (entry.isGlobPattern === true) {
      patterns.push({ key: key, regex: globToRegex(key) });
    } else {
      exact.add(key);
    }
  });

  blockedCache = {
    exact: exact,
    patterns: patterns,
    loaded: true,
    loadedAt: Date.now()
  };
}

function findBlockedMatch(domain) {
  var value = normalizeDomain(domain);
  if (!value) return null;
  if (blockedCache.exact.has(value)) return { blocked: true, key: value };
  for (var i = 0; i < blockedCache.patterns.length; i++) {
    if (blockedCache.patterns[i].regex.test(value)) {
      return { blocked: true, key: blockedCache.patterns[i].key };
    }
  }
  return null;
}

function refreshRowBadges() {
  try {
    var ui = getApi().ui;
    if (ui && typeof ui.refreshRowBadges === 'function') {
      var result = ui.refreshRowBadges();
      if (result && typeof result.catch === 'function') {
        result.catch(function (err) {
          logAt('warn', 'Could not refresh message-row badges', err);
        });
      }
    }
  } catch (err) {
    logAt('warn', 'Could not refresh message-row badges', err);
  }
}

async function refreshBlockedCache(force) {
  if (cacheLoadPromise) {
    // A normal caller shares an in-flight refresh. A caller that just changed
    // the server must not settle for a fetch that started before the change,
    // so it waits for that one and then starts a fresh one.
    if (!force) return cacheLoadPromise;
    try {
      await cacheLoadPromise;
    } catch (err) {
      // The stale request failed; the forced request below gets its own try.
    }
  }

  lastCacheAttemptAt = Date.now();
  var load = (async function () {
    var entries = await fetchBlockedDomains();
    buildBlockedCache(entries);
    return entries;
  })();
  cacheLoadPromise = load;

  try {
    return await load;
  } finally {
    if (cacheLoadPromise === load) cacheLoadPromise = null;
  }
}

// Slot frames and the background frame do not share memory. After the settings
// page changes a rule, the background frame's badge cache cannot be updated
// directly, so a stale cache is refreshed lazily on the next row render.
function maybeRefreshStaleCache() {
  if (cacheLoadPromise) return;
  var last = Math.max(blockedCache.loadedAt || 0, lastCacheAttemptAt || 0);
  if (Date.now() - last < CACHE_TTL_MS) return;
  refreshBlockedCache()
    .then(function () { refreshRowBadges(); })
    .catch(function (err) {
      logAt('warn', 'Could not refresh the blocked-domains badge cache', err);
    });
}

/* -------------------------------------------------------------------------- */
/* JMAP transport                                                              */
/* -------------------------------------------------------------------------- */

function parseJmapBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('Stalwart returned an empty response.');
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error('Stalwart returned a response that was not valid JSON.');
  }
}

async function jmapCall(methodCalls) {
  var api = getApi();
  var config = await readConfig();
  var payload = {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: methodCalls
  };

  var response;
  try {
    response = await api.proxy.fetch('stalwart', config.jmapUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload),
      responseType: 'text'
    });
  } catch (err) {
    logAt('error', 'The Stalwart request failed', err);
    throw new Error('Could not reach Stalwart through Bulwark: ' + errorText(err));
  }

  if (response && response.proxyError) {
    logAt('error', 'The Bulwark proxy refused the Stalwart request', response.proxyError);
    throw new Error('Bulwark refused the request to Stalwart: ' + errorText(response.proxyError));
  }

  var status = response && typeof response.status === 'number' ? response.status : 0;
  if (status === 401) {
    logAt('error', 'Stalwart rejected the configured API key', { status: status });
    throw pluginError('unauthorized', 'Stalwart rejected the API key.');
  }
  if (status === 403) {
    logAt('error', 'The Stalwart API key lacks permission', { status: status });
    throw pluginError(
      'forbidden',
      'The API key lacks permission to manage blocked domains. Grant the lookup and reload permissions in Stalwart.'
    );
  }
  if (status < 200 || status >= 300) {
    var bodyPreview = response && response.body ? clip(String(response.body).replace(/\s+/g, ' ').trim(), 240) : '';
    logAt('error', 'Stalwart returned an HTTP error', { status: status, body: bodyPreview });
    throw new Error('Stalwart returned HTTP ' + status + (bodyPreview ? ': ' + bodyPreview : '.'));
  }

  var data = parseJmapBody(response && response.body);
  if (!data || !Array.isArray(data.methodResponses)) {
    throw new Error('Stalwart returned a response without JMAP method responses.');
  }
  return data.methodResponses;
}

// Read responses by method name. RFC 8620 permits servers to reorder them, so
// array position is never a safe way to find a particular answer.
function findResponse(responses, methodName) {
  for (var i = 0; i < responses.length; i++) {
    var response = responses[i];
    if (Array.isArray(response) && response[0] === methodName) return response;
  }
  return null;
}

function requireResponse(responses, methodName) {
  var response = findResponse(responses, methodName);
  if (!response) {
    throw new Error('Stalwart did not return a response for ' + methodName + '.');
  }
  return response;
}

function methodArgs(response, label) {
  var args = (response && response[1]) || {};
  if (args.type) {
    var description = args.description ? String(args.description) : '';
    throw new Error(
      'Stalwart JMAP error for ' + label + ': ' + args.type + (description ? ' — ' + description : '')
    );
  }
  return args;
}

function refusalText(refusal) {
  if (!refusal) return 'no reason given';
  var description = refusal.description || refusal.detail || '';
  var type = refusal.type || '';
  if (type && description) return type + ': ' + description;
  return description || type || 'no reason given';
}

function reloadConfirmed(responses) {
  var response = findResponse(responses, 'x:Action/set');
  if (!response) return false;
  var args = response[1] || {};
  if (args.type) {
    logAt('warn', 'The ReloadLookupStores action failed', args);
    return false;
  }
  var created = args.created || {};
  var notCreated = args.notCreated || {};
  return !!created.r1 && !notCreated.r1;
}

/* -------------------------------------------------------------------------- */
/* Reading the blocked-domains lookup                                          */
/* -------------------------------------------------------------------------- */

async function fetchBlockedDomains() {
  var all = [];
  var position = 0;

  for (var page = 0; page < MAX_PAGES; page++) {
    // Query and get travel in the same request. The get uses a result
    // reference, so it fetches exactly the ids the query returned instead of
    // guessing at an id list between requests.
    var responses = await jmapCall([
      [
        'x:MemoryLookupKey/query',
        { filter: { namespace: NAMESPACE }, limit: PAGE_SIZE, position: position },
        'q1'
      ],
      [
        'x:MemoryLookupKey/get',
        {
          '#ids': {
            resultOf: 'q1',
            name: 'x:MemoryLookupKey/query',
            path: '/ids'
          },
          properties: ['id', 'namespace', 'key', 'isGlobPattern']
        },
        'g1'
      ]
    ]);

    var queryArgs = methodArgs(requireResponse(responses, 'x:MemoryLookupKey/query'), 'blocked-domains query');
    var getArgs = methodArgs(requireResponse(responses, 'x:MemoryLookupKey/get'), 'blocked-domains fetch');

    if (!Array.isArray(queryArgs.ids)) {
      throw new Error('Stalwart returned no id list for the blocked domains.');
    }
    if (!Array.isArray(getArgs.list)) {
      throw new Error('Stalwart returned no details for the blocked domains.');
    }

    var ids = queryArgs.ids;
    var list = getArgs.list;

    // A query that failed must never look like an empty list. If ids came back
    // but no details did, the request is broken rather than the list empty.
    if (ids.length > 0 && list.length === 0) {
      throw new Error('Stalwart listed blocked domains but returned no details for them.');
    }
    if (ids.length !== list.length) {
      logAt('warn', 'Blocked-domains page returned a different number of ids and details', {
        ids: ids.length,
        details: list.length,
        notFound: getArgs.notFound || null
      });
    }

    list.forEach(function (entry) {
      if (!entry || !entry.id || !entry.key) return;
      if (entry.namespace && entry.namespace !== NAMESPACE) return;
      all.push({
        id: String(entry.id),
        namespace: entry.namespace || NAMESPACE,
        key: String(entry.key),
        isGlobPattern: entry.isGlobPattern === true
      });
    });

    if (ids.length === 0) return all;
    if (ids.length < PAGE_SIZE) return all;
    if (typeof queryArgs.total === 'number' && position + ids.length >= queryArgs.total) {
      return all;
    }

    position += ids.length;
    if (page === MAX_PAGES - 1) {
      throw new Error(
        'The blocked-domains list has more than 50,000 entries. Refusing to work from a partial list.'
      );
    }
  }

  return all;
}

/* -------------------------------------------------------------------------- */
/* Changing the blocked-domains lookup                                        */
/* -------------------------------------------------------------------------- */

// The ReloadLookupStores action belongs in the same JMAP request as the set,
// so Stalwart cannot leave a successful change sitting in storage until the
// next restart. The action response is inspected separately below.
async function mutateKeys(mutation) {
  var setArgs = {};
  if (mutation.create && Object.keys(mutation.create).length > 0) {
    setArgs.create = mutation.create;
  }
  if (mutation.destroy && mutation.destroy.length > 0) {
    setArgs.destroy = mutation.destroy.slice();
  }
  if (!setArgs.create && !setArgs.destroy) {
    return { created: {}, destroyed: [] };
  }

  var responses = await jmapCall([
    ['x:MemoryLookupKey/set', setArgs, 's1'],
    ['x:Action/set', { create: { r1: { '@type': 'ReloadLookupStores' } } }, 'a1']
  ]);

  var setResponse = requireResponse(responses, 'x:MemoryLookupKey/set');
  var args = methodArgs(setResponse, 'blocked-domains change');

  var notCreated = args.notCreated || {};
  var notDestroyed = args.notDestroyed || {};
  var refusedCreates = Object.keys(notCreated);
  var refusedDestroys = Object.keys(notDestroyed);

  if (refusedCreates.length > 0) {
    var createDetails = refusedCreates.map(function (id) {
      var key = setArgs.create && setArgs.create[id] ? setArgs.create[id].key : id;
      return key + ' — ' + refusalText(notCreated[id]);
    });
    throw new Error('Stalwart refused to create ' + createDetails.join('; '));
  }
  if (refusedDestroys.length > 0) {
    var destroyDetails = refusedDestroys.map(function (id) {
      return id + ' — ' + refusalText(notDestroyed[id]);
    });
    throw new Error('Stalwart refused to remove ' + destroyDetails.join('; '));
  }

  if (!reloadConfirmed(responses)) {
    logAt('warn', 'Stalwart did not confirm the ReloadLookupStores action');
    toast(
      'warning',
      'The change was saved, but Stalwart did not confirm the lookup reload. It may take effect only after a restart.'
    );
  }

  return {
    created: args.created || {},
    destroyed: args.destroyed || []
  };
}

// Even a refused set can be partly applied: JMAP reports refusals per object.
// Refresh the cache on both paths so badges cannot stay wrong after a partial
// change. A cache failure after a successful change is a warning, not a reason
// to tell the user the change failed.
async function applyChange(mutation) {
  try {
    var result = await mutateKeys(mutation);
    try {
      await refreshBlockedCache(true);
    } catch (err) {
      logAt('warn', 'The change was saved but the badge cache could not be refreshed', err);
      toast('warning', 'The change was saved, but the badge cache could not be refreshed.');
    }
    refreshRowBadges();
    return result;
  } catch (err) {
    try {
      await refreshBlockedCache(true);
    } catch (cacheErr) {
      logAt('warn', 'Could not refresh the badge cache after a failed change', cacheErr);
    }
    refreshRowBadges();
    throw err;
  }
}

function findCoveringEntry(entries, domain) {
  var value = normalizeDomain(domain);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || !entry.key) continue;
    if (entry.isGlobPattern) {
      if (globToRegex(entry.key).test(value)) return entry;
    } else if (normalizeDomain(entry.key) === value) {
      return entry;
    }
  }
  return null;
}

function dedupeEntries(entries) {
  var seen = new Set();
  var result = [];
  entries.forEach(function (entry) {
    if (!entry || !entry.id || seen.has(entry.id)) return;
    seen.add(entry.id);
    result.push(entry);
  });
  return result;
}

function chosenTargetSetting() {
  try {
    var settings = getApi().plugin && getApi().plugin.settings;
    var value = settings && settings.blockTarget;
    if (value === TARGET_EXACT || value === TARGET_BASE || value === TARGET_ASK) return value;
  } catch (err) {
    logAt('warn', 'Could not read the blockTarget setting; using the default', err);
  }
  return TARGET_ASK;
}

/* -------------------------------------------------------------------------- */
/* Block and unblock flows                                                    */
/* -------------------------------------------------------------------------- */

async function blockDomain(sender) {
  var exact = sender.domain;
  var base = registrableBase(exact);
  var target = exact;

  if (base !== exact) {
    var setting = chosenTargetSetting();
    if (setting === TARGET_BASE) {
      target = base;
    } else if (setting === TARGET_ASK) {
      var choice = await chooseBlockTarget(exact, base);
      if (!choice) {
        toast('info', 'Nothing was blocked.');
        return;
      }
      target = choice;
    }
  }

  var via = target === base && base !== exact ? exact : null;
  var confirmed = await confirmBlock(target, via);
  if (!confirmed) {
    toast('info', 'Nothing was blocked.');
    return;
  }

  var entries = await fetchBlockedDomains();
  var covering = findCoveringEntry(entries, target);
  if (covering) {
    var coveredBy = normalizeDomain(covering.key) === target ? '' : ' by ' + covering.key;
    toast('info', target + ' is already blocked' + coveredBy + '.');
    return;
  }

  var create = {};
  create.c1 = { namespace: NAMESPACE, key: target, isGlobPattern: false };

  if (via) {
    // A bare base-domain entry covers mail whose sender is exactly the base
    // domain. The glob entry covers every subdomain, which is what the user
    // chose by picking the base domain.
    var globKey = '*.' + base;
    var globExists = entries.some(function (entry) {
      return entry.isGlobPattern === true && normalizeDomain(entry.key) === globKey;
    });
    if (!globExists) {
      create.c2 = { namespace: NAMESPACE, key: globKey, isGlobPattern: true };
    }
  }

  await applyChange({ create: create });
  var scope = via ? target + ' and its subdomains' : target;
  toast('success', 'Blocked ' + scope + '. Mail from it is now rejected at SMTP time.');
}

async function unblockDomain(sender) {
  var exact = sender.domain;
  var base = registrableBase(exact);
  var entries = await fetchBlockedDomains();

  if (entries.length === 0) {
    toast('info', 'The blocked-domains list is empty.');
    return;
  }

  var exactMatches = [];
  var baseMatches = [];

  entries.forEach(function (entry) {
    var key = normalizeDomain(entry.key);
    if (!entry.isGlobPattern && key === exact) exactMatches.push(entry);
    if (!entry.isGlobPattern && key === base) baseMatches.push(entry);
    if (entry.isGlobPattern && key === '*.' + base) baseMatches.push(entry);
  });

  exactMatches = dedupeEntries(exactMatches);
  baseMatches = dedupeEntries(baseMatches);
  var family = dedupeEntries(exactMatches.concat(baseMatches));

  if (family.length === 0) {
    toast('info', exact + ' is not blocked.');
    return;
  }

  var targets = family;
  if (base !== exact && exactMatches.length > 0 && baseMatches.length > 0) {
    var choice = await chooseUnblockFamily(exact, base, exactMatches.length > 0, baseMatches.length > 0);
    if (!choice) {
      toast('info', 'Nothing was unblocked.');
      return;
    }
    if (choice === 'exact') targets = exactMatches;
    else if (choice === 'base') targets = baseMatches;
    else targets = family;
  } else {
    var confirmed = await confirmUnblock(family);
    if (!confirmed) {
      toast('info', 'Nothing was unblocked.');
      return;
    }
  }

  var ids = targets.map(function (entry) { return entry.id; }).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('No blocked-domain entries were selected to remove.');
  }

  await applyChange({ destroy: ids });
  var names = targets.map(function (entry) { return entry.key; });
  var plural = names.length > 1;
  toast(
    'success',
    'Unblocked ' + names.join(', ') + '. Mail from ' + (plural ? 'them' : 'it') + ' is no longer rejected at SMTP time.'
  );
}

/* -------------------------------------------------------------------------- */
/* Confirmation and choice dialogs                                            */
/* -------------------------------------------------------------------------- */

function blockMessage(target, via) {
  var lines = [];
  if (via && via !== target) lines.push('Sender: ' + via);
  lines.push('Block ' + target + '?');
  lines.push('Mail from ' + target + ' will be rejected at SMTP time, whatever its spam score.');
  lines.push('This list is server-wide: the rule applies to every account on this Stalwart server.');
  return lines.join('\n\n');
}

function unblockMessage(keys) {
  var lines = [];
  if (keys.length === 1) {
    lines.push('Unblock ' + keys[0] + '?');
  } else {
    lines.push('Unblock these entries?');
    keys.forEach(function (key) { lines.push('• ' + key); });
  }
  lines.push(
    'Mail from ' + (keys.length === 1 ? 'it' : 'them') + ' will no longer be rejected at SMTP time.'
  );
  lines.push('This change is server-wide and applies to every account on this Stalwart server.');
  return lines.join('\n\n');
}

async function chooseBlockTarget(senderDomain, baseDomain) {
  var api = getApi();
  try {
    var result = await api.ui.openDialog({
      title: 'Block domain',
      slot: 'plugin-dialog',
      extraProps: {
        kind: 'choose',
        mode: 'block',
        senderDomain: senderDomain,
        baseDomainChoice: baseDomain
      }
    });
    if (result === senderDomain || result === baseDomain) return result;
    return null;
  } catch (err) {
    logAt('warn', 'The themed chooser could not open; using a plain confirmation', err);
    var useBase = await api.ui.confirm({
      title: 'Block domain',
      message:
        'Block the base domain ' + baseDomain + ' so all of its subdomains are covered?\n\n' +
        'Choose Cancel to block only ' + senderDomain + ' instead.',
      confirmLabel: 'Block ' + baseDomain,
      cancelLabel: 'Block only ' + senderDomain,
      danger: true
    });
    // Cancel and the close button both return false. The always-shown
    // confirmation that follows still names the exact domain and consequence,
    // so the user gets a second chance to stop.
    return useBase ? baseDomain : senderDomain;
  }
}

async function chooseUnblockFamily(senderDomain, baseDomain, hasExact, hasBase) {
  var api = getApi();
  try {
    var result = await api.ui.openDialog({
      title: 'Unblock domain',
      slot: 'plugin-dialog',
      extraProps: {
        kind: 'choose',
        mode: 'unblock',
        senderDomain: senderDomain,
        baseDomainChoice: baseDomain,
        hasExact: hasExact,
        hasBase: hasBase
      }
    });
    if (result === 'exact' || result === 'base' || result === 'both') return result;
    return null;
  } catch (err) {
    logAt('warn', 'The themed chooser could not open; using a plain confirmation', err);
    var both = await api.ui.confirm({
      title: 'Unblock domain',
      message:
        'Remove every blocked-domains entry for ' + senderDomain + ' and its base domain ' + baseDomain + '?\n\n' +
        'This change is server-wide and applies to every account on the mail server.',
      confirmLabel: 'Unblock both',
      danger: true
    });
    return both ? 'both' : null;
  }
}

async function confirmBlock(target, via) {
  var api = getApi();
  try {
    var result = await api.ui.openDialog({
      title: 'Block domain',
      slot: 'plugin-dialog',
      extraProps: {
        kind: 'confirm',
        action: 'block',
        target: target,
        via: via || null
      }
    });
    return result === true;
  } catch (err) {
    logAt('warn', 'The themed confirmation could not open; using a plain confirmation', err);
    return api.ui.confirm({
      title: 'Block domain',
      message: blockMessage(target, via),
      confirmLabel: 'Block',
      danger: true
    });
  }
}

async function confirmUnblock(family) {
  var api = getApi();
  var keys = family.map(function (entry) { return entry.key; });
  try {
    var result = await api.ui.openDialog({
      title: 'Unblock domain',
      slot: 'plugin-dialog',
      extraProps: {
        kind: 'confirm',
        action: 'unblock',
        family: keys
      }
    });
    return result === true;
  } catch (err) {
    logAt('warn', 'The themed confirmation could not open; using a plain confirmation', err);
    return api.ui.confirm({
      title: 'Unblock domain',
      message: unblockMessage(keys),
      confirmLabel: 'Unblock',
      danger: true
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Resolving the sender and handling actions                                  */
/* -------------------------------------------------------------------------- */

async function getFromAddress(emailId, accountId) {
  var api = getApi();
  var email = null;

  try {
    // The second argument is the account id itself, not an options object.
    email = await api.email.get(emailId, accountId ? String(accountId) : undefined);
  } catch (err) {
    // A unified mailbox may legitimately refuse messages from another login.
    // Fall through to what the list/open hooks remembered.
    logAt('warn', 'Could not read the message; trying the remembered sender', {
      emailId: emailId,
      error: errorText(err)
    });
  }

  if (email) {
    var domain = rememberSender(email);
    if (domain) return { domain: domain, from: email.from };
  }

  var cached = cachedSender(emailId, accountId);
  if (cached && !cached.ambiguous) return { domain: cached.domain, from: cached.from };
  if (cached && cached.ambiguous) {
    throw new Error(
      'This message id is used by more than one connected account, so its sender is ambiguous. ' +
        'Open the message first, then run the action from the open message.'
    );
  }

  throw new Error(
    'The message could not be read. It may belong to another connected login; open it once in its own mailbox and try again.'
  );
}

var mutationInFlight = false;

async function runExclusive(work) {
  if (mutationInFlight) {
    toast('info', 'A block or unblock is already running. Please wait.');
    return;
  }
  mutationInFlight = true;
  try {
    await work();
  } finally {
    mutationInFlight = false;
  }
}

async function handleAction(payload) {
  var actionId = payload && payload.actionId;
  if (actionId !== ACTION_BLOCK && actionId !== ACTION_UNBLOCK) return;

  var context = (payload && payload.context) || {};
  if (!context.emailId) {
    toast('error', 'No message was selected.');
    return;
  }

  await runExclusive(async function () {
    var sender = await getFromAddress(context.emailId, context.accountId);
    if (actionId === ACTION_BLOCK) await blockDomain(sender);
    else await unblockDomain(sender);
  });
}

/* -------------------------------------------------------------------------- */
/* Message-row badge                                                          */
/* -------------------------------------------------------------------------- */

function addBlockedBadge(badges, context) {
  var email = context && context.email;
  if (!email) return undefined;

  rememberSender(email);
  maybeRefreshStaleCache();

  var domain = senderDomainOf(email);
  if (!domain || !blockedCache.loaded) return undefined;

  var match = findBlockedMatch(domain);
  if (!match) return undefined;

  var list = Array.isArray(badges) ? badges.slice() : [];
  var alreadyThere = list.some(function (badge) {
    return badge && badge.key === BADGE_KEY;
  });
  if (alreadyThere) return list;

  list.push({
    key: BADGE_KEY,
    label: 'Blocked',
    color: 'var(--color-destructive)',
    icon: 'ban',
    title: 'Blocked by the server: ' + match.key
  });
  return list;
}

/* -------------------------------------------------------------------------- */
/* Dialog UI                                                                  */
/* -------------------------------------------------------------------------- */

var dialogStyles = {
  lead: { margin: '0 0 8px', fontWeight: 600 },
  text: { margin: '0 0 12px', lineHeight: 1.5 },
  list: { margin: '0 0 12px', paddingLeft: '20px', lineHeight: 1.6 }
};

function useEnterKey(handler) {
  React.useEffect(function () {
    function onKeyDown(event) {
      if (event.key !== 'Enter' || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKeyDown);
    return function () {
      window.removeEventListener('keydown', onKeyDown);
    };
  });
}

function ConfirmBody(props) {
  var onResult = typeof props.onResult === 'function' ? props.onResult : function () {};
  var isBlock = props.action !== 'unblock';
  var family = Array.isArray(props.family) ? props.family : [];
  var target = props.target || (family.length === 1 ? family[0] : '');

  useEnterKey(function () { onResult(true); });

  var lead;
  if (isBlock) lead = 'Block ' + target + '?';
  else if (family.length > 1) lead = 'Unblock these entries?';
  else lead = 'Unblock ' + target + '?';

  return h(
    'div',
    null,
    h('p', { style: dialogStyles.lead }, lead),
    props.via ? h('p', { style: dialogStyles.text }, 'Chosen for the sender ' + props.via + '.') : null,
    family.length > 1
      ? h('ul', { style: dialogStyles.list }, family.map(function (key, index) {
          return h('li', { key: String(index) }, key);
        }))
      : null,
    h(
      'p',
      { style: dialogStyles.text },
      isBlock
        ? 'Mail from ' + target + ' will be rejected at SMTP time, whatever its spam score. ' +
          'This rule is server-wide: it applies to every account on this Stalwart server.'
        : 'Mail from the selected ' + (family.length > 1 ? 'entries' : 'entry') +
          ' will no longer be rejected at SMTP time. This change is server-wide and applies to ' +
          'every account on this Stalwart server.'
    ),
    h(DialogButtons, {
      buttons: [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'confirm', label: isBlock ? 'Block' : 'Unblock', variant: isBlock ? 'destructive' : 'primary' }
      ],
      onClick: function (id) {
        onResult(id === 'confirm');
      }
    })
  );
}

function ChooseBody(props) {
  var onResult = typeof props.onResult === 'function' ? props.onResult : function () {};
  var isUnblock = props.mode === 'unblock';
  var senderDomain = props.senderDomain || '';
  var baseDomain = props.baseDomainChoice || '';
  var hasExact = props.hasExact !== false;
  var hasBase = props.hasBase !== false;

  function chooseDefault() {
    onResult(isUnblock ? 'exact' : senderDomain);
  }
  useEnterKey(chooseDefault);

  var buttons = [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }];
  if (!isUnblock) {
    buttons.push({
      id: 'exact',
      label: 'Block ' + senderDomain,
      variant: 'destructive'
    });
    buttons.push({
      id: 'base',
      label: 'Block ' + baseDomain + ' (all subdomains)',
      variant: 'destructive'
    });
  } else {
    if (hasExact) {
      buttons.push({ id: 'exact', label: 'Unblock ' + senderDomain, variant: 'secondary' });
    }
    if (hasBase) {
      buttons.push({
        id: 'base',
        label: 'Unblock ' + baseDomain + ' (incl. glob)',
        variant: 'secondary'
      });
    }
    if (hasExact && hasBase) {
      buttons.push({ id: 'both', label: 'Unblock both', variant: 'primary' });
    }
  }

  return h(
    'div',
    null,
    h(
      'p',
      { style: dialogStyles.lead },
      isUnblock
        ? 'What should be unblocked for ' + senderDomain + '?'
        : 'Block ' + senderDomain + ' or its base domain?'
    ),
    h(
      'p',
      { style: dialogStyles.text },
      isUnblock
        ? 'The blocked list has entries for the exact subdomain and for ' + baseDomain +
          '. You can remove either family or both.'
        : 'The sender is on a subdomain. Blocking ' + senderDomain + ' affects that host only. ' +
          'Blocking ' + baseDomain + ' also adds a glob rule so every subdomain of ' + baseDomain +
          ' is covered.'
    ),
    h(DialogButtons, {
      buttons: buttons,
      onClick: function (id) {
        if (id === 'cancel') {
          onResult(null);
        } else if (!isUnblock) {
          onResult(id === 'base' ? baseDomain : senderDomain);
        } else {
          onResult(id);
        }
      }
    })
  );
}

function PluginDialog(props) {
  if (props && props.kind === 'choose') return h(ChooseBody, props);
  return h(ConfirmBody, props);
}

/* -------------------------------------------------------------------------- */
/* Settings page section                                                      */
/* -------------------------------------------------------------------------- */

var settingsStyles = {
  header: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  heading: { margin: 0, fontSize: '1.05rem', fontWeight: 600 },
  count: { color: 'var(--color-muted-foreground)', fontSize: '0.9rem' },
  notice: {
    border: '1px solid var(--color-border)',
    background: 'var(--color-muted)',
    borderRadius: '8px',
    padding: '10px 12px',
    margin: '12px 0',
    color: 'var(--color-foreground)',
    fontSize: '0.9rem',
    lineHeight: 1.45
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 0',
    borderBottom: '1px solid var(--color-border)'
  },
  domain: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.9rem',
    wordBreak: 'break-all'
  },
  muted: { color: 'var(--color-muted-foreground)' },
  error: { color: 'var(--color-destructive)', margin: '12px 0' },
  footer: { marginTop: '12px', display: 'flex', justifyContent: 'flex-start' }
};

var settingsMutationInFlight = false;

function compareEntries(a, b) {
  var left = normalizeDomain(a.key);
  var right = normalizeDomain(b.key);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function BlockedDomainsSection() {
  var entriesState = React.useState([]);
  var entries = entriesState[0];
  var setEntries = entriesState[1];

  var loadingState = React.useState(true);
  var loading = loadingState[0];
  var setLoading = loadingState[1];

  var errorState = React.useState('');
  var error = errorState[0];
  var setError = errorState[1];

  var visibleState = React.useState(SETTINGS_PAGE_SIZE);
  var visible = visibleState[0];
  var setVisible = visibleState[1];

  var busyState = React.useState(null);
  var busyId = busyState[0];
  var setBusyId = busyState[1];

  // Rapid Refresh clicks can produce overlapping requests. Only the newest one
  // is allowed to write state, so an older response cannot resurrect a row that
  // was just removed.
  var loadToken = React.useRef(0);

  function load(resetVisible) {
    loadToken.current += 1;
    var token = loadToken.current;
    setLoading(true);
    setError('');
    fetchBlockedDomains()
      .then(function (list) {
        if (token !== loadToken.current) return;
        list.sort(compareEntries);
        setEntries(list);
        if (resetVisible) {
          setVisible(SETTINGS_PAGE_SIZE);
        } else {
          setVisible(function (current) {
            var keep = Math.min(current, Math.max(list.length, SETTINGS_PAGE_SIZE));
            return Math.max(SETTINGS_PAGE_SIZE, keep);
          });
        }
      })
      .catch(function (err) {
        if (token !== loadToken.current) return;
        logAt('error', 'Could not load the blocked-domains list', err);
        setError(errorText(err));
      })
      .finally(function () {
        if (token === loadToken.current) setLoading(false);
      });
  }

  React.useEffect(function () {
    load(true);
  }, []);

  async function unblock(entry) {
    if (settingsMutationInFlight || !entry || !entry.id) return;
    var api = getApi();
    var confirmed = false;
    try {
      confirmed = await api.ui.confirm({
        title: 'Unblock domain',
        message:
          'Remove ' + entry.key + ' from the server-wide blocked-domains list?\n\n' +
          'Mail matching this entry will no longer be rejected at SMTP time. ' +
          'This change applies to every account on the mail server.',
        confirmLabel: 'Unblock',
        danger: true
      });
    } catch (err) {
      reportError('Could not open the confirmation dialog', err);
      return;
    }
    if (!confirmed) return;

    settingsMutationInFlight = true;
    setBusyId(entry.id);
    try {
      await applyChange({ destroy: [entry.id] });
      toast('success', 'Unblocked ' + entry.key + '.');
      load(false);
    } catch (err) {
      reportError('Could not unblock ' + entry.key, err);
    } finally {
      settingsMutationInFlight = false;
      setBusyId(null);
    }
  }

  var shown = entries.slice(0, visible);
  var countLabel = entries.length === 1 ? '1 entry' : entries.length + ' entries';

  return h(
    'div',
    null,
    h(
      'div',
      { style: settingsStyles.header },
      h('h2', { style: settingsStyles.heading }, 'Blocked domains'),
      h('span', { style: settingsStyles.count }, countLabel),
      h(
        Button,
        {
          variant: 'secondary',
          size: 'sm',
          busy: loading,
          disabled: loading || busyId !== null,
          onClick: function () { load(false); }
        },
        'Refresh'
      )
    ),
    h(
      'div',
      { style: settingsStyles.notice },
      'Every entry and every change applies to all accounts on the mail server. ' +
        'Blocking a domain rejects its mail at SMTP time, whatever its spam score.'
    ),
    loading
      ? h('p', { style: settingsStyles.muted }, 'Loading blocked domains…')
      : error
        ? h(
            'div',
            null,
            h('p', { style: settingsStyles.error }, error),
            h(
              Button,
              { variant: 'secondary', onClick: function () { load(true); } },
              'Retry'
            )
          )
        : entries.length === 0
          ? h('p', { style: settingsStyles.muted }, 'No domains are blocked.')
          : h(
              'div',
              null,
              shown.map(function (entry) {
                return h(
                  'div',
                  { key: entry.id, style: settingsStyles.row },
                  h(
                    'span',
                    { style: settingsStyles.domain },
                    entry.key + (entry.isGlobPattern ? '  (glob)' : '')
                  ),
                  h(
                    Button,
                    {
                      variant: 'secondary',
                      size: 'sm',
                      busy: busyId === entry.id,
                      disabled: busyId !== null && busyId !== entry.id,
                      onClick: function () { unblock(entry); }
                    },
                    'Unblock'
                  )
                );
              }),
              visible < entries.length
                ? h(
                    'div',
                    { style: settingsStyles.footer },
                    h(
                      Button,
                      {
                        variant: 'secondary',
                        onClick: function () {
                          setVisible(function (current) { return current + SETTINGS_PAGE_SIZE; });
                        }
                      },
                      'Show more'
                    )
                  )
                : null
            )
  );
}

/* -------------------------------------------------------------------------- */
/* Activation, hooks and slots                                                */
/* -------------------------------------------------------------------------- */

async function registerActions() {
  var api = getApi();

  // reader-actions is the open message's toolbar. mailboxRoles confines the
  // buttons to the Spam folder.
  try {
    await api.ui.setActions('reader-actions', [
      { id: ACTION_BLOCK, label: 'Block domain', icon: 'ban', mailboxRoles: ['junk'] },
      { id: ACTION_UNBLOCK, label: 'Unblock domain', icon: 'circle-check', mailboxRoles: ['junk'] }
    ]);
  } catch (err) {
    logAt('error', 'Could not register the reader actions', err);
  }

  // message-row-actions supplies both the hover icons and the right-click
  // menu entry for a row. Both are shown in every folder so Block is
  // reachable from the inbox's right-click menu too; neither icon is drawn
  // red so it doesn't clutter the row. Block shows for senders that aren't
  // blocked yet; Unblock only appears when the row's Blocked badge is
  // present, so exactly one of the two icons shows at a time.
  try {
    await api.ui.setActions('message-row-actions', [
      { id: ACTION_BLOCK, label: 'Block domain', icon: 'ban', notBadge: BADGE_KEY },
      { id: ACTION_UNBLOCK, label: 'Unblock domain', icon: 'circle-check', hasBadge: BADGE_KEY }
    ]);
  } catch (err) {
    logAt('error', 'Could not register the message-row actions', err);
  }
}

async function activate(api) {
  setApi(api);
  await registerActions();

  // Fire and forget: activation must not wait for the network, and row badges
  // refresh themselves once the cache is ready.
  refreshBlockedCache()
    .then(function () { refreshRowBadges(); })
    .catch(function (err) {
      logAt('error', 'Could not load blocked domains on activation', err);
      if (err && err.code === 'not-configured') {
        toast('error', errorText(err));
      }
    });
}

var hooks = {
  onEmailOpen: function (email) {
    try {
      rememberSender(email, true);
    } catch (err) {
      logAt('warn', 'Could not remember the sender of an opened message', err);
    }
  },

  onMailboxChange: function (change) {
    try {
      if (change && change.role === 'junk') {
        refreshBlockedCache()
          .then(function () { refreshRowBadges(); })
          .catch(function (err) {
            logAt('warn', 'Could not refresh blocked domains when entering Spam', err);
          });
      }
    } catch (err) {
      logAt('warn', 'Could not react to the mailbox change', err);
    }
  },

  onAction: function (payload) {
    return handleAction(payload).catch(function (err) {
      reportError('Block Domain action failed', err);
    });
  },

  onEmailListItemRender: function (badges, context) {
    try {
      return addBlockedBadge(badges, context);
    } catch (err) {
      logAt('warn', 'Could not add the Blocked badge to a message row', err);
      return undefined;
    }
  }
};

var slots = {
  'plugin-dialog': { component: PluginDialog },
  'settings-section': { component: BlockedDomainsSection }
};

exports.activate = activate;
exports.hooks = hooks;
exports.slots = slots;
