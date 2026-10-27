const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

test('reselecting the current bottom destination keeps the reading position', async () => {
  const app = createApp('#farm');
  app.setScrollTop(480);
  await app.click('我的农场');
  assert.equal(app.scrollTop, 480);
});

test('returning to a bottom destination restores its own reading position', async () => {
  const app = createApp('#farm');
  app.setScrollTop(480);
  await app.click('商城');
  assert.equal(app.scrollTop, 0);
  app.setScrollTop(620);
  await app.click('我的农场');
  assert.equal(app.scrollTop, 480);
  await app.click('商城');
  assert.equal(app.scrollTop, 620);
});

test('opening a different post starts at its beginning while the community keeps its position', async () => {
  const app = createApp('#community');
  app.setScrollTop(250);
  await app.click(/^阅读动态：清晨的小番茄/);
  assert.equal(app.scrollTop, 0);
  app.setScrollTop(480);
  await app.click('返回社区');
  assert.equal(app.scrollTop, 250);
  await app.click(/^阅读动态：天气转凉/);
  assert.equal(app.scrollTop, 0);
});
