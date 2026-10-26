const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attributes = source => Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]));

// Only browser DOM, timers and clock are doubled. Rules, pages and handlers are
// loaded from the actual scripts declared by index.html, in their real order.
function createApp(hash = '', options = {}) {
  let clock = Date.parse('2026-10-27T04:00:00Z'), serial = 0, reloads = 0;
  const documentEvents = new Map(), windowEvents = new Map(), nodes = new Map();
  const timers = new Map(), intervals = new Map(), formFields = new Map();
  const listen = (map, type, fn) => map.set(type, [...(map.get(type) || []), fn]);
  const html = fs.readFileSync(path.join(root, 'prototype/index.html'), 'utf8');
  let document, dialog;
  const node = () => ({
    innerHTML: '', textContent: '', scrollTop: 0, dataset: {}, isConnected: true,
    classList: { add() {}, remove() {}, contains() { return false; } },
    focus() { document.activeElement = this; }, scrollTo() {}, scrollIntoView() {}, select() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  });
  const app = node();
  app.innerHTML = html.match(/<main\b[^>]*id="app"[^>]*>([\s\S]*?)<\/main>/)?.[1] || '';
  dialog = node();
  let dialogHTML = '';
  Object.defineProperty(dialog, 'innerHTML', {
    get() { return dialogHTML; },
    set(value) {
      dialogHTML = value;
      for (const field of formFields.values()) field.isConnected = false;
      formFields.clear();
      for (const match of value.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>|<input\b([^>]*)>/g)) {
        const attrs = attributes(match[3] || match[1] || '');
        if (!attrs.name) continue;
        const field = Object.assign(node(), attrs, { value: attrs.value ?? decode(match[2] || '') });
        formFields.set(attrs.name, field);
      }
    },
  });
  dialog.querySelectorAll = selector => /input|textarea/.test(selector) ? [...formFields.values()] : [];
  dialog.querySelector = selector => selector.includes('aria-invalid') ? [...formFields.values()].find(f => f['aria-invalid'] === 'true') || null : null;
  dialog.open = false;
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };
  nodes.set('#app', app); nodes.set('#app-dialog', dialog);
  const form = Object.assign(node(), { id: 'shipping-form' });
  const status = node();
  status.textContent = html.match(/id="boot-status"[^>]*>([^<]*)</)?.[1] || '';
  if (html.includes('id="boot-status"')) nodes.set('#boot-status', status);
  document = {
    activeElement: node(), hidden: false, title: '', readyState: 'loading',
    querySelector(selector) {
      if (selector === '#shipping-form') return dialogHTML.includes('id="shipping-form"') ? form : null;
      if (selector.startsWith('#ship-')) return formFields.get(selector.slice(6)) || null;
      if (selector === '#boot-status') return nodes.get(selector) || null;
      if (selector === '#countdown' && !dialogHTML.includes('id="countdown"')) return null;
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { listen(documentEvents, type, fn); },
  };
  const location = { reload() { reloads++; } };
  function setURL(value) {
    const url = new URL(value, location.href || 'https://farm.invalid/index.html');
    Object.assign(location, { href: url.href, search: url.search, hash: url.hash });
  }
  setURL('https://farm.invalid/index.html' + hash);
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = {
    document, location, URL, URLSearchParams, Intl, Date: ClockDate,
    FormData: class { constructor() { this.values = [...formFields].map(([key, field]) => [key, field.value]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
    matchMedia(query) { return { media: query, matches: false, addEventListener() {}, removeEventListener() {} }; },
    navigator: { clipboard: { async writeText() {} } },
    history: { pushState(_state, _title, url) { setURL(url); }, replaceState(_state, _title, url) { setURL(url); } },
    window: { location, addEventListener(type, fn) { listen(windowEvents, type, fn); } },
    setTimeout(fn, delay = 0) { const id = ++serial; timers.set(id, { fn, delay, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay = 0) { const id = ++serial; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  vm.createContext(context);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)(?:\?[^"]*)?"[^>]*>/g)].map(match => match[1]);
  for (const name of scripts) {
    if ((options.omitScripts || []).includes(name)) {
      for (const handler of windowEvents.get('error') || []) handler({ target: { tagName: 'SCRIPT', src: name }, preventDefault() {} });
      continue;
    }
    let source = fs.readFileSync(path.join(root, 'prototype', name), 'utf8');
    if (name === 'app.js') {
      const end = source.lastIndexOf('})();');
      assert.notEqual(end, -1, 'test harness expects the app closure');
      source = source.slice(0, end) + 'globalThis.__farmProbe = { get state() { return state; }, get modal() { return modal; }, render };\n' + source.slice(end);
    }
    try { vm.runInContext(source, context, { filename: name }); }
    catch (error) {
      if (!options.allowBootFailure) throw error;
      for (const handler of windowEvents.get('error') || []) handler({ error, preventDefault() {} });
    }
  }
  document.readyState = 'complete';
  for (const handler of documentEvents.get('DOMContentLoaded') || []) handler({});
  function controls() {
    const content = dialog.open ? dialogHTML : app.innerHTML;
    return [...content.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(match => {
      const attrs = attributes(match[2]), el = node();
      el.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()), value]));
      el.name = attrs['aria-label'] || decode(match[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      el.disabled = /(?:^|\s)disabled(?:\s|=|$)/.test(match[2]);
      el.closest = selector => selector === '[data-action]' ? (el.dataset.action ? el : null) : selector === '[data-route]' ? (el.dataset.route ? el : null) : null;
      return el;
    });
  }
  async function fire(map, type, event = {}) { for (const handler of map.get(type) || []) await handler(event); }
  return {
    get state() { return context.__farmProbe?.state; }, get modal() { return context.__farmProbe?.modal; },
    get html() { return app.innerHTML; }, get modalHTML() { return dialogHTML; }, get dialogOpen() { return dialog.open; },
    get clock() { return clock; }, get bootStatus() { return status.textContent; }, get reloads() { return reloads; },
    controls,
    async click(name) {
      const el = controls().find(el => typeof name === 'function' ? name(el) : name instanceof RegExp ? name.test(el.name) : el.name === name);
      assert.ok(el, `visible control exists: ${name}`);
      assert.equal(el.disabled, false, `control enabled: ${name}`);
      document.activeElement = el;
      await fire(documentEvents, 'click', { target: el, preventDefault() {} });
    },
    fill(name, value) { const field = formFields.get(name); assert.ok(field, `visible form field ${name}`); field.value = value; return field; },
    async submit() { assert.ok(dialogHTML.includes('id="shipping-form"')); await fire(documentEvents, 'submit', { target: form, preventDefault() {} }); },
    async popstate(route) { setURL('#' + route); await fire(windowEvents, 'popstate'); },
    nextDay() { clock += 86400000; }, advance(ms) { clock += ms; },
    render() { context.__farmProbe.render(); },
    flushTimeout(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `scheduled timeout ${delay}`); timers.delete(entry[0]); entry[1].fn(); },
    tickIntervals() { for (const [id, timer] of [...intervals]) if (intervals.has(id)) timer.fn(); },
    async hide() { document.hidden = true; await fire(documentEvents, 'visibilitychange'); },
    async resume() { document.hidden = false; await fire(documentEvents, 'visibilitychange'); },
    async pageShow(persisted = true) { await fire(windowEvents, 'pageshow', { persisted }); },
  };
}

module.exports = { createApp };
