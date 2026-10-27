const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');

test('the default landing is the social home and its centre tab retains five clear destinations', () => {
  const app = createApp();
  assert.equal(app.state.view, 'home');
  const nav = app.html.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/data-route=/g) || []).length, 5);
  assert.match(nav, /href="#home"[^>]*aria-current="page"/);
  assert.match(nav, /主页/); assert.doesNotMatch(nav, /href="#activities"/);
  assert.match(app.html, /田园会客厅/);
});

test('old activity links still expose all original rewards while selecting Home in the bottom navigation', () => {
  const app = createApp('#activities');
  assert.equal(app.state.view, 'activities'); assert.match(app.html, /七日田园签到/);
  assert.match(app.html, /href="#home"[^>]*aria-current="page"/);
});

test('social subpages belong to Home and do not change farm resources merely by opening them', async () => {
  for (const view of ['community', 'friends', 'friend', 'post']) {
    const app = createApp('#' + view);
    assert.equal(app.state.view, view); assert.equal(app.state.wallet.points, 80); assert.equal(app.state.wallet.feed, 6);
    assert.match(app.html, /href="#home"[^>]*aria-current="page"/);
  }
});

test('home sign-in and the existing activity page use the same once-daily reward', async () => {
  const app = createApp('#home');
  await app.click(el => el.dataset.action === 'x-signin');
  assert.equal(app.state.wallet.points, 100);
  await app.click(el => el.dataset.action === 'activities');
  assert.equal(app.state.view, 'activities'); assert.equal(app.state.wallet.points, 100);
  assert.ok(app.controls().filter(el => el.dataset.action === 'x-signin').every(el => el.disabled));
});

test('shared seed posts and sample people open their exact content in a fresh page', () => {
  const post = createApp('?post=seed-harvest-tomato#post');
  assert.equal(post.state.socialUI.postId, 'seed-harvest-tomato');
  assert.match(post.html, /清晨的小番茄/); assert.doesNotMatch(post.html, /这条动态已失效/);
  const person = createApp('?person=lin#friend');
  assert.equal(person.state.socialUI.personId, 'lin'); assert.match(person.html, /林间有风/);
});

test('unknown, local and ambiguous shared ids cannot resurrect local content or a made-up person', () => {
  for (const query of ['?post=local-post-1#post', '?post=seed-harvest-tomato&post=seed-chat-morning#post', '?post=%3Cscript%3E#post']) {
    const app = createApp(query); assert.equal(app.state.socialUI.postId, ''); assert.match(app.html, /这条动态已失效/);
  }
  for (const query of ['?person=me#friend', '?person=missing#friend', '?person=lin&person=wu#friend']) {
    const app = createApp(query); assert.equal(app.state.socialUI.personId, ''); assert.match(app.html, /暂时找不到这位朋友/);
  }
});

test('copied public demonstration links round-trip into the seed post and sample personal garden', async () => {
  const post = createApp('#community');
  await post.click(control => control.dataset.action === 's-post' && control.dataset.post === 'seed-harvest-tomato');
  await post.click(control => control.dataset.action === 's-share'); await post.click('复制链接');
  const postURL = new URL(post.clipboardWrites.at(-1)), openedPost = createApp(postURL.search + postURL.hash);
  assert.equal(openedPost.state.socialUI.postId, 'seed-harvest-tomato'); assert.doesNotMatch(openedPost.html, /这条动态已失效/);
  assert.deepEqual([...postURL.searchParams.keys()], ['post']);
  const person = createApp('#friends'); await person.click(control => control.dataset.action === 's-person' && control.dataset.person === 'lin');
  await person.click(control => control.dataset.action === 's-share-person'); await person.click('复制链接');
  const personURL = new URL(person.clipboardWrites.at(-1)), openedPerson = createApp(personURL.search + personURL.hash);
  assert.equal(openedPerson.state.socialUI.personId, 'lin'); assert.deepEqual([...personURL.searchParams.keys()], ['person']);
});

test('the shared header follows the current public post instead of losing it at the home entrance', async () => {
  const app = createApp('?post=seed-harvest-tomato#post');
  await app.click(control => control.dataset.action === 'share'); await app.click('复制链接');
  const copied = new URL(app.clipboardWrites.at(-1));
  assert.equal(copied.hash, '#post'); assert.equal(copied.searchParams.get('post'), 'seed-harvest-tomato');
});

test('community sharing has a visual invitation preview with the same clean demonstration destination', async () => {
  const app = createApp('#home'); await app.click(control => control.dataset.action === 'share');
  assert.match(app.modalHTML, /social-share-preview/); assert.match(app.modalHTML, /田园会客厅/);
  await app.click('复制链接'); const link = new URL(app.clipboardWrites.at(-1));
  assert.equal(link.hash, '#home'); assert.equal(link.search, ''); assert.equal(app.state.wallet.points, 80);
});

test('moving from a shared post updates its public destination and never leaves an old post query on a local post', async () => {
  const app = createApp('?post=seed-harvest-tomato#post');
  await app.click(control => control.dataset.action === 's-community');
  assert.equal(new URL(app.url).searchParams.has('post'), false);
  await app.click(control => control.dataset.action === 's-post' && control.dataset.post === 'seed-question-water');
  const destination = new URL(app.url); assert.equal(destination.searchParams.get('post'), 'seed-question-water');
  assert.equal(createApp(destination.search + destination.hash).state.socialUI.postId, 'seed-question-water');
  await app.click(control => control.dataset.action === 's-community'); await app.click(control => control.dataset.action === 's-compose');
  await app.input('title', '新的本地田园日常'); await app.input('body', '这是合成的本地动态，不应继承先前链接中的示例帖子标识。'); await app.submit('s-compose-form');
  assert.equal(new URL(app.url).search, '');
  assert.match(createApp('#post').html, /这条动态已失效/);
});
