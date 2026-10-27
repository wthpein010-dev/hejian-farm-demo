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
  const clipboardWrites = [];
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
  let appHTML='';
  Object.defineProperty(app,'innerHTML',{
    get(){return appHTML;},
    set(value){
      appHTML=value;
      const former=nodes.get('#shop-query');if(former){former.isConnected=false;if(document?.activeElement===former)document.activeElement=node();}
      const match=value.match(/<input\b([^>]*id="shop-query"[^>]*)>/);
      if(match){
        const attrs=attributes(match[1]);
        const field=Object.assign(node(),attrs,{tagName:'INPUT',value:attrs.value||'',selectionStart:0,selectionEnd:0,selectionDirection:'none'});
        field.dataset={focusKey:attrs['data-focus-key']};
        field.setSelectionRange=(start,end,direction)=>Object.assign(field,{selectionStart:start,selectionEnd:end,selectionDirection:direction});
        nodes.set('#shop-query',field);
      }
    },
  });
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
    querySelectorAll(selector) { return selector.includes('input')?[...nodes.values()].filter(field=>field.tagName==='INPUT'&&field.isConnected):[]; },
    addEventListener(type, fn) { listen(documentEvents, type, fn); },
  };
  const location = { reload() { reloads++; } };
  function setURL(value) {
    const url = new URL(value, location.href || 'https://farm.invalid/index.html');
    Object.assign(location, { href: url.href, search: url.search, hash: url.hash });
  }
  setURL('https://farm.invalid/index.html' + hash);
  const copyHistoryState = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const historyEntries = [{ url: location.href, state: null }];
  let historyIndex = 0;
  const history = {
    get state() { return copyHistoryState(historyEntries[historyIndex].state); },
    pushState(state, _title, url) {
      if (url != null) setURL(url);
      historyEntries.splice(historyIndex + 1);
      historyEntries.push({ url: location.href, state: copyHistoryState(state) });
      historyIndex++;
    },
    replaceState(state, _title, url) {
      if (url != null) setURL(url);
      historyEntries[historyIndex] = { url: location.href, state: copyHistoryState(state) };
    },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = {
    document, location, URL, URLSearchParams, Intl, Date: ClockDate,
    FormData: class { constructor() { this.values = [...formFields].map(([key, field]) => [key, field.value]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
    matchMedia(query) { return { media: query, matches: false, addEventListener() {}, removeEventListener() {} }; },
    navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } },
    history,
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
      source = source.slice(0, end) + 'globalThis.__farmProbe = { get state() { return state; }, get modal() { return modal; }, render, completeOrder: typeof completeOrder === "function" ? completeOrder : null };\n' + source.slice(end);
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
    get clipboardWrites() { return [...clipboardWrites]; }, get url() { return location.href; },
    get scrollTop() { return document.querySelector('.app-scroll').scrollTop; },
    setScrollTop(top) { document.querySelector('.app-scroll').scrollTop = top; },
    completeWork(nextOrder) { assert.ok(context.__farmProbe.completeOrder, 'the actual app completion boundary exists'); return context.__farmProbe.completeOrder(nextOrder); },
    get historyState() { return history.state; },
    controls,
    async click(name) {
      const el = controls().find(el => typeof name === 'function' ? name(el) : name instanceof RegExp ? name.test(el.name) : el.name === name);
      assert.ok(el, `visible control exists: ${name}`);
      assert.equal(el.disabled, false, `control enabled: ${name}`);
      document.activeElement = el;
      await fire(documentEvents, 'click', { target: el, preventDefault() {} });
    },
    fill(name, value) { const field = formFields.get(name); assert.ok(field, `visible form field ${name}`); field.value = value; return field; },
    async input(name, value) {
      const field = formFields.get(name); assert.ok(field, `visible form field ${name}`);
      field.value = value; await fire(documentEvents, 'input', { target: field });
    },
    async composeField(name, value) {
      const field = formFields.get(name); assert.ok(field, `visible form field ${name}`);
      field.focus(); await fire(documentEvents, 'compositionstart', { target: field });
      field.value = value; await fire(documentEvents, 'input', { target: field, isComposing: true });
    },
    async endFieldComposition(name) {
      const field = formFields.get(name); assert.ok(field, `visible form field ${name}`);
      await fire(documentEvents, 'compositionend', { target: field });
    },
    async enterField(name, formId) {
      const field = formFields.get(name); assert.ok(field, `visible form field ${name}`);
      let prevented = false;
      await fire(documentEvents, 'keydown', { target: field, key: 'Enter', keyCode: 13, isComposing: false, preventDefault() { prevented = true; } });
      if (!prevented) await fire(documentEvents, 'submit', { target: { id: formId }, preventDefault() {} });
    },
    async search(query, { composing = false } = {}) {
      const field = document.querySelector('#shop-query');
      field.id = 'shop-query'; field.value = query;
      if (composing) await fire(documentEvents, 'compositionstart', { target: field });
      await fire(documentEvents, 'input', { target: field });
      const searchForm = Object.assign(node(), { id: 'shop-search', querySelector: () => field });
      await fire(documentEvents, 'submit', { target: searchForm, preventDefault() {}, isComposing: composing });
      if (composing) await fire(documentEvents, 'compositionend', { target: field });
    },
    async draftSearch(query,start=0,end=start){
      const field=document.querySelector('#shop-query');field.value=query;field.focus();field.setSelectionRange(start,end,'forward');
      await fire(documentEvents,'input',{target:field});
    },
    get focusedInput(){const el=document.activeElement;return {id:el.id,value:el.value,start:el.selectionStart,end:el.selectionEnd};},
    async composeSearch(query){const field=document.querySelector('#shop-query');field.focus();await fire(documentEvents,'compositionstart',{target:field});field.value=query;await fire(documentEvents,'input',{target:field,isComposing:true});},
    async endSearchComposition(){await fire(documentEvents,'compositionend',{target:document.querySelector('#shop-query')});},
    async enterSearch(){
      const field=document.querySelector('#shop-query');let prevented=false;
      await fire(documentEvents,'keydown',{target:field,key:'Enter',keyCode:13,isComposing:false,preventDefault(){prevented=true;}});
      if(!prevented)await fire(documentEvents,'submit',{target:{id:'shop-search',querySelector:()=>field},preventDefault(){}});
    },
    async submit(formId = 'shipping-form', extra = {}) {
      assert.ok(dialogHTML.includes(`id="${formId}"`), `visible form ${formId}`);
      await fire(documentEvents, 'submit', { target: formId === 'shipping-form' ? form : { id: formId }, preventDefault() {}, ...extra });
    },
    async popstate(route, state = null) {
      setURL('#' + route);
      historyEntries[historyIndex] = { url: location.href, state: copyHistoryState(state) };
      await fire(windowEvents, 'popstate', { state: history.state });
    },
    async back() {
      if (!historyIndex) return;
      historyIndex--;
      setURL(historyEntries[historyIndex].url);
      await fire(windowEvents, 'popstate', { state: history.state });
    },
    async forward() {
      if (historyIndex === historyEntries.length - 1) return;
      historyIndex++;
      setURL(historyEntries[historyIndex].url);
      await fire(windowEvents, 'popstate', { state: history.state });
    },
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
