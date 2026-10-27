const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers/farm-app.cjs');
const assets = app => JSON.stringify({wallet: app.state.wallet, system: app.state.system, care: app.state.care, device: app.state.device});
const action = (name, props = {}) => control => control.dataset.action === name && Object.entries(props).every(([key, value]) => control.dataset[key] === value);

async function publish(app, title = '我家的第一篮番茄', body = '今天收获了一小篮番茄，想和大家一起分享种植的乐趣。') {
  await app.click(action('s-compose'));
  await app.input('title', title); await app.input('body', body);
  await app.click(action('s-compose-photo', {art: 'tomato'}));
  await app.submit('s-compose-form');
  return app.state.socialUI.postId;
}

test('home uses the same sign-in transaction and reaches the full activity calendar', async () => {
  const app = createApp();
  assert.equal(app.state.view, 'home');
  assert.match(app.html, /田园动态/);
  assert.match(app.html, /示例社区/);
  const before = app.state.wallet.points;
  await app.click(action('x-signin'));
  assert.equal(app.state.wallet.points, before + 20);
  assert.equal(app.state.rewardHistory.length, 1);
  assert.ok(app.controls().find(action('x-signin')).disabled);
  await app.click(action('x-signin-calendar'));
  assert.equal(app.state.view, 'activities');
  assert.equal(app.controls().filter(action('x-signin-preview')).length, 7);
  assert.equal(app.state.wallet.points, before + 20);
});

test('joining a circle exposes a visible leave action and leaving restores its join action', async () => {
  const app = createApp('#community'), before = assets(app);
  const visibleCircleAction = circle => {
    const match = app.html.match(new RegExp(`<button(?=[^>]*data-action="s-join")(?=[^>]*data-circle="${circle}")[^>]*>([\\s\\S]*?)<\\/button>`));
    assert.ok(match, `circle ${circle} has an action`);
    return match[1].replace(/<[^>]*>/g, '').trim();
  };
  assert.equal(visibleCircleAction('questions'), '加入圈子');
  await app.click(action('s-join', {circle: 'questions'}));
  assert.ok(app.state.social.joined.includes('questions'));
  assert.equal(visibleCircleAction('questions'), '退出圈子', 'the visible text names the available action');
  await app.click(action('s-join', {circle: 'questions'}));
  assert.ok(!app.state.social.joined.includes('questions'));
  assert.equal(visibleCircleAction('questions'), '加入圈子');
  assert.equal(assets(app), before);
});

test('community creates, likes, comments and deletes a local post without changing farm assets', async () => {
  const app = createApp('#community'), before = assets(app);
  const id = await publish(app);
  assert.equal(app.state.view, 'post');
  assert.equal(app.dialogOpen, false);
  assert.match(app.html, /我家的第一篮番茄/);
  await app.click(action('s-like', {post: id}));
  assert.ok(app.state.social.likes.includes(id));
  await app.click(action('s-comment', {post: id}));
  await app.input('body', '这一篮看着就很香，期待下一次收获！');
  await app.submit('s-comment-form');
  assert.equal(app.state.social.posts.find(post => post.id === id).comments.length, 1);
  assert.match(app.html, /这一篮看着就很香/);
  await app.click(action('s-delete-post', {post: id}));
  assert.equal(app.modal.type, 's-remove');
  assert.ok(app.state.social.posts.some(post => post.id === id));
  await app.click(action('s-confirm-remove'));
  assert.equal(app.state.view, 'community');
  assert.ok(!app.state.social.posts.some(post => post.id === id));
  assert.equal(assets(app), before);
});

test('validation preserves the draft, associates errors, escapes text and rejects IME submit', async () => {
  const app = createApp('#community');
  await app.click(action('s-compose'));
  await app.input('title', '短'); await app.input('body', '不够');
  await app.submit('s-compose-form');
  assert.equal(app.modal.type, 's-compose');
  assert.match(app.modalHTML, /aria-invalid="true"/);
  assert.match(app.modalHTML, /aria-describedby="s-title-help s-title-error"/);
  assert.equal(app.state.socialUI.composeDraft.title, '短');
  const count = app.state.social.posts.length;
  await app.input('title', '<img src=x onerror=alert(1)>');
  await app.composeField('body', '这是中文输入法尚未确认的一段田园记录。');
  await app.submit('s-compose-form', {isComposing: true});
  assert.equal(app.state.social.posts.length, count);
  await app.endFieldComposition('body');
  await app.enterField('title', 's-compose-form');
  assert.equal(app.state.social.posts.length, count, 'candidate confirmation Enter must not publish');
  app.advance(60);
  await app.submit('s-compose-form');
  assert.equal(app.state.social.posts.length, count + 1);
  assert.doesNotMatch(app.html, /<img src=x/);
  assert.match(app.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(app.modalHTML, '', 'closed shared modal erases hidden form DOM');
});

test('lifecycle repaint preserves ongoing social composition and closing clears the cancelled draft', async () => {
  const app = createApp('#community');
  await app.click(action('s-compose'));
  await app.input('title', '一份还在输入的田园记录');
  const field = app.fill('body', '');
  await app.composeField('body', '正在用中文输入法写下今天的田园小事。');
  await app.hide(); await app.resume();
  assert.equal(field.isConnected, true, 'resume must not replace a field while its IME composition is active');
  assert.equal(app.state.socialUI.composeDraft.body, '正在用中文输入法写下今天的田园小事。');
  await app.endFieldComposition('body');
  assert.match(app.modalHTML, /正在用中文输入法写下今天的田园小事/);
  await app.click('关闭弹窗');
  assert.equal(app.state.socialUI.composeDraft.title, '');
  assert.equal(app.state.socialUI.composeDraft.body, '');
  assert.equal(app.modalHTML, '');
  await app.click(action('s-compose'));
  assert.doesNotMatch(app.modalHTML, /一份还在输入/);
});

test('circle/feed choices and post navigation restore safe context without saving user content', async () => {
  const app = createApp('#community');
  await app.click(action('s-circle', {circle: 'questions'}));
  await app.click(action('s-feed', {feed: 'friends'}));
  const selected = app.controls().find(action('s-post'));
  assert.ok(selected);
  await app.click(action('s-post', {post: selected.dataset.post}));
  assert.equal(app.state.view, 'post');
  await app.back();
  assert.equal(app.state.view, 'community');
  assert.equal(app.state.socialUI.circle, 'questions');
  assert.equal(app.state.socialUI.feed, 'friends');
  assert.equal(JSON.stringify(app.historyState).includes('body'), false);
  await app.popstate('post', {socialNavigation: {postId: '<script>', personId: 'bogus', circle: 'bogus', feed: 'bogus', body: 'private text'}});
  assert.match(app.html, /动态已失效|暂时找不到/);
  assert.doesNotMatch(app.html, /<script>|private text/);
});

test('friend requests, acceptance, removal and blocking remain local demonstration actions', async () => {
  const app = createApp('#friends'), before = assets(app);
  await app.click(action('s-friend-tab', {tab: 'requests'}));
  await app.click(action('s-accept-friend', {person: 'qiu'}));
  assert.ok(app.state.social.friends.includes('qiu'));
  await app.click(action('s-friend-tab', {tab: 'discover'}));
  await app.click(action('s-request-friend', {person: 'wu'}));
  assert.ok(app.state.social.outgoing.includes('wu'));
  await app.click(action('s-cancel-request', {person: 'wu'}));
  assert.ok(!app.state.social.outgoing.includes('wu'));
  await app.click(action('s-person', {person: 'wu'}));
  assert.match(app.html, /个人田园/);
  assert.match(app.html, /只读示意/);
  await app.click(action('s-block', {person: 'wu'}));
  await app.click(action('s-confirm-block'));
  assert.ok(app.state.social.blocked.includes('wu'));
  await app.click(action('s-friends'));
  await app.click(action('s-friend-tab', {tab: 'discover'}));
  assert.ok(app.controls().find(action('s-unblock', {person: 'wu'})), 'discovery keeps a recovery route for blocked authors');
  await app.click(action('s-person', {person: 'wu'}));
  await app.click(action('s-unblock', {person: 'wu'}));
  assert.ok(!app.state.social.blocked.includes('wu'));
  await app.click(action('s-friends'));
  await app.click(action('s-friend-tab', {tab: 'friends'}));
  await app.click(action('s-remove-friend', {person: 'qiu'}));
  await app.click(action('s-confirm-remove'));
  assert.ok(!app.state.social.friends.includes('qiu'));
  assert.equal(assets(app), before);
  assert.ok(!createApp('#friends').state.social.friends.includes('qiu'), 'refresh resets the local social network');
});

test('reporting clearly stays simulated and sharing a local post excludes its title and body', async () => {
  const app = createApp('#community');
  const seed = app.controls().find(action('s-post'));
  await app.click(action('s-post', {post: seed.dataset.post}));
  await app.click(action('s-report', {post: seed.dataset.post}));
  assert.match(app.modalHTML, /不会发送给真实客服|未发送给真实客服/);
  await app.click(action('s-confirm-report'));
  assert.equal(app.state.social.reports.filter(id => id === seed.dataset.post).length, 1);
  await app.click(action('s-community'));
  const id = await publish(app, '只在本页的私有标题', '这段仅限当前页面的本地正文不能出现在任何分享链接中。');
  await app.click(action('s-share', {post: id}));
  assert.equal(app.modal.type, 'share');
  assert.match(app.modalHTML, /本地|当前页|本页/);
  await app.click(action('copy-link'));
  const copied = app.clipboardWrites.at(-1);
  assert.ok(copied);
  assert.equal(copied.includes(id), false);
  assert.equal(copied.includes('私有标题'), false);
  assert.equal(copied.includes('本地正文'), false);
  assert.equal(decodeURIComponent(copied).includes('本地正文'), false);
});
