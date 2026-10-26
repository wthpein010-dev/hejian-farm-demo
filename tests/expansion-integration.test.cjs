const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only DOM/event plumbing and the clock are doubled. Every farm rule and page
// renderer below is loaded from the actual browser sources, in script order.
function createApp(hash = '') {
  let clock = Date.parse('2026-10-27T04:00:00Z');
  const documentEvents = new Map(), windowEvents = new Map(), nodes = new Map();
  const listen = (map, type, fn) => map.set(type, [...(map.get(type) || []), fn]);
  let document;
  const node = () => ({
    innerHTML: '', textContent: '', scrollTop: 0, dataset: {}, isConnected: true,
    classList: { add() {}, remove() {} },
    focus() { document.activeElement = this; }, scrollTo() {}, scrollIntoView() {}, select() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {},
  });
  const app = node(), dialog = node();
  dialog.open = false;
  dialog.showModal = function () { this.open = true; };
  dialog.close = function () { this.open = false; };
  nodes.set('#app', app); nodes.set('#app-dialog', dialog);
  document = {
    activeElement: node(), hidden: false, title: '',
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { listen(documentEvents, type, fn); },
  };
  const location = {};
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
    matchMedia(query) { return { media: query, matches: false, addEventListener() {}, removeEventListener() {} }; },
    navigator: { clipboard: { async writeText() {} } },
    history: { pushState(_state, _title, url) { setURL(url); }, replaceState(_state, _title, url) { setURL(url); } },
    window: { addEventListener(type, fn) { listen(windowEvents, type, fn); } },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
  };
  vm.createContext(context);
  for (const name of ['domain.js', 'systems.js', 'ui.js', 'expansion.js', 'app.js']) {
    let source = fs.readFileSync(path.join(__dirname, '../prototype', name), 'utf8');
    if (name === 'app.js') {
      // A read-only closure probe exists only in this VM, never in production.
      const end = source.lastIndexOf('})();');
      assert.notEqual(end, -1, 'test harness expects the app closure');
      source = source.slice(0, end) + 'globalThis.__farmProbe = { get state() { return state; } };\n' + source.slice(end);
    }
    vm.runInContext(source, context, { filename: name });
  }
  const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  function controls() {
    const html = app.innerHTML + (dialog.open ? dialog.innerHTML : '');
    return [...html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(match => {
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]));
      const el = node();
      el.dataset = Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()), value]));
      el.name = attrs['aria-label'] || decode(match[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      el.disabled = /(?:^|\s)disabled(?:\s|=|$)/.test(match[2]);
      el.closest = selector => selector === '[data-action]' ? (el.dataset.action ? el : null) : selector === '[data-route]' ? (el.dataset.route ? el : null) : null;
      return el;
    });
  }
  return {
    get state() { return context.__farmProbe.state; },
    get html() { return app.innerHTML; },
    controls,
    async click(name) {
      const el = controls().find(el => name instanceof RegExp ? name.test(el.name) : el.name === name);
      assert.ok(el, `visible control exists: ${name}`);
      assert.equal(el.disabled, false, `control enabled: ${name}`);
      document.activeElement = el;
      for (const handler of documentEvents.get('click') || []) await handler({ target: el, preventDefault() {} });
    },
    async popstate(route) {
      setURL('#' + route);
      for (const handler of windowEvents.get('popstate') || []) await handler({});
    },
    nextDay() { clock += 86400000; },
  };
}

test('adoption entry points override a previous supplies tab while ordinary shop navigation remembers it', async () => {
  for (const intent of ['empty-plot', 'recommendations', 'empty-orders']) {
    const app = createApp();
    await app.click('商城');
    await app.click('农场物资');
    await app.click('我的农场');
    await app.click('商城');
    assert.equal(app.state.storefront, 'supplies', 'ordinary bottom navigation keeps the last shop section');
    await app.click('我的农场');
    if (intent === 'empty-plot') {
      await app.click('A04');
      await app.click('为这块地选种');
    } else if (intent === 'recommendations') {
      await app.click('查看推荐');
    } else {
      await app.click('我的');
      await app.click(/^我的认养订单/);
      await app.click('去认养优选');
    }
    assert.equal(app.state.storefront, 'adopt', `${intent} must lead to adoption`);
    assert.ok(app.controls().some(control => control.name.includes('选择樱桃萝卜')), `${intent} renders the actual seed choices`);
  }
});

test('initial shop URLs, normal navigation and history restoration each count one daily shop visit', async () => {
  const observations = [];
  for (const entry of ['initial-url', 'navigation', 'popstate']) {
    const app = createApp(entry === 'initial-url' ? '#shop' : '');
    if (entry === 'navigation') await app.click('商城');
    if (entry === 'popstate') await app.popstate('shop');
    const onEntry = app.state.system.daily.browse;
    await app.click('我的农场');
    await app.click('商城');
    await app.click('农场物资');
    await app.click('积分好礼');
    await app.click('当季认养');
    await app.popstate('shop');
    observations.push({ entry, onEntry, afterRepeats: app.state.system.daily.browse, xp: app.state.system.xp });
  }
  assert.deepEqual(observations, [
    { entry: 'initial-url', onEntry: 1, afterRepeats: 1, xp: 128 },
    { entry: 'navigation', onEntry: 1, afterRepeats: 1, xp: 128 },
    { entry: 'popstate', onEntry: 1, afterRepeats: 1, xp: 128 },
  ]);
});

test('after eight real sign-ins the ninth-day activity grid shows one claimed cell and the second reward active', async () => {
  const app = createApp();
  for (let day = 0; day < 8; day++) {
    if (day) app.nextDay();
    await app.click('活动');
    await app.click(/^签到领取 /);
    assert.equal(app.state.system.signedDays.length, day + 1, 'the real sign-in transaction succeeds once each day');
  }
  app.nextDay();
  await app.click('活动');
  const cells = [...app.html.matchAll(/<div\b[^>]*\bclass="([^"]*\bcheckin-day\b[^"]*)"[^>]*>\s*<span>(\d+日)<\/span>/g)].map(match => ({ classes: match[1].split(/\s+/), label: match[2] }));
  assert.equal(cells.length, 7, 'the rendered activity page contains seven reward cells');
  assert.deepEqual(cells.filter(cell => cell.classes.includes('claimed')).map(cell => cell.label), ['1日']);
  assert.deepEqual(cells.filter(cell => cell.classes.includes('active')).map(cell => cell.label), ['2日']);
});
