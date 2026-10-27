const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '../prototype/social.js');
let Social = {};
try { Social = require(file); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const now = Date.parse('2026-10-27T04:00:00Z');
const ids = items => items.map(item => item.id);
function call(method, ...args) {
  assert.equal(typeof Social[method], 'function', `${method} must exist`);
  return Social[method](...args);
}
const state = () => call('createState', now);
const postInput = () => ({ circleId: 'harvest', title: '今天收获番茄', body: '院里的番茄红了，记录一份好心情。', art: 'tomato' });
function denied(result, original) {
  assert.equal(result.ok, false);
  assert.equal(result.state, original, 'a failed operation returns the identical untouched state');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

test('fresh states expose isolated sample identities and six readable, sorted posts', () => {
  const first = state(), second = state();
  assert.equal(first.viewer.id, 'me');
  assert.deepEqual(ids(call('getPeople', first)), ['lin', 'chen', 'wu', 'qiu']);
  assert.deepEqual(first.friends, ['lin', 'chen']);
  assert.deepEqual(first.incoming, ['qiu']);
  const posts = call('getPosts', first);
  assert.equal(posts.length, 6);
  assert.ok(posts.every(post => post.seeded && post.author.name && !post.isMine));
  assert.ok(posts.every((post, index) => !index || posts[index - 1].createdAt >= post.createdAt));
  first.people[0].name = 'changed'; first.posts[0].comments.push({}); first.friends.pop();
  assert.notEqual(second.people[0].name, 'changed');
  assert.deepEqual(second.friends, ['lin', 'chen']);
  assert.ok(second.posts.every(post => post.comments.every(comment => comment.id)));
});

test('circles and all read projections are defensive copies rather than write handles', () => {
  const original = freezeDeep(state()), before = JSON.stringify(original);
  const circles = call('getCircles');
  assert.deepEqual(ids(circles), ['harvest', 'questions', 'chat']);
  circles[0].name = 'overwrite';
  assert.notEqual(call('getCircles')[0].name, 'overwrite');
  const people = call('getPeople', original), friends = call('getFriends', original), requests = call('getRequests', original);
  people[0].name = 'people'; friends[0].name = 'friends'; requests.incoming[0].name = 'request';
  const post = call('getPosts', original)[0];
  call('getPost', original, post.id).author.name = 'post';
  call('getPerson', original, 'lin').name = 'person';
  assert.equal(JSON.stringify(original), before);
  assert.equal(call('getPerson', original, 'me').id, 'me');
  assert.equal(call('getPost', original, '__proto__'), null);
  assert.equal(call('getPerson', original, 'stranger'), null);
});

test('circle and friends feeds only expose eligible authored posts and reject unknown filters', () => {
  const original = state();
  assert.ok(call('getPosts', original, { circle: 'harvest' }).every(post => post.circleId === 'harvest'));
  const friends = call('getPosts', original, { feed: 'friends' });
  assert.ok(friends.length > 0);
  assert.ok(friends.every(post => ['lin', 'chen'].includes(post.authorId)));
  assert.deepEqual(call('getPosts', original, { circle: '__proto__' }), []);
  assert.deepEqual(call('getPosts', original, { feed: 'popular' }), []);
});

test('joining only a real circle toggles membership without duplicates or mutating its input', () => {
  const original = freezeDeep(state()), before = JSON.stringify(original);
  const joined = call('toggleJoin', original, 'questions');
  assert.equal(joined.ok, true);
  assert.deepEqual(joined.state.joined, ['harvest', 'questions']);
  const left = call('toggleJoin', joined.state, 'questions');
  assert.deepEqual(left.state.joined, ['harvest']);
  assert.equal(JSON.stringify(original), before);
  for (const id of ['all', '__proto__', '', null]) denied(call('toggleJoin', original, id), original);
});

test('liking a post adds one viewer like and a second toggle removes precisely that like', () => {
  const original = freezeDeep(state()), post = call('getPosts', original)[0];
  const liked = call('toggleLike', original, post.id);
  assert.equal(liked.ok, true);
  assert.equal(liked.state.posts.find(item => item.id === post.id).likes, post.likes);
  assert.equal(call('getPost', liked.state, post.id).likes, post.likes + 1);
  assert.equal(call('getPost', liked.state, post.id).liked, true);
  const unliked = call('toggleLike', liked.state, post.id);
  assert.equal(call('getPost', unliked.state, post.id).likes, post.likes);
  assert.deepEqual(unliked.state.likes, []);
  denied(call('toggleLike', original, 'missing-post'), original);
});

test('friend requests are pending demonstration relationships and repeat without duplicate entries', () => {
  const original = freezeDeep(state()), requested = call('requestFriend', original, 'wu');
  assert.equal(requested.ok, true);
  assert.deepEqual(requested.state.outgoing, ['wu']);
  assert.deepEqual(requested.state.friends, ['lin', 'chen']);
  const replay = call('requestFriend', requested.state, 'wu');
  assert.equal(replay.ok, true); assert.equal(replay.state, requested.state);
  assert.deepEqual(ids(call('getRequests', requested.state).outgoing), ['wu']);
  assert.equal(call('getPerson', requested.state, 'wu').outgoing, true);
  const cancelled = call('cancelRequest', requested.state, 'wu');
  assert.deepEqual(cancelled.state.outgoing, []);
  assert.equal(call('cancelRequest', cancelled.state, 'wu').state, cancelled.state);
});

test('accepting requires an incoming request and repeating it never duplicates a friend', () => {
  const original = state();
  denied(call('acceptFriend', original, 'wu'), original);
  denied(call('requestFriend', original, 'qiu'), original);
  const accepted = call('acceptFriend', original, 'qiu');
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.state.friends, ['lin', 'chen', 'qiu']);
  assert.deepEqual(accepted.state.incoming, []);
  assert.equal(call('acceptFriend', accepted.state, 'qiu').state, accepted.state);
  assert.equal(call('getPerson', accepted.state, 'qiu').isFriend, true);
  assert.equal(call('getRequests', accepted.state).incoming.length, 0);
});

test('self, unknown and existing friend requests cannot create a relationship', () => {
  const original = freezeDeep(state());
  for (const method of ['requestFriend', 'cancelRequest', 'acceptFriend', 'removeFriend', 'toggleBlock']) {
    for (const id of ['me', 'missing', '__proto__', null]) denied(call(method, original, id), original);
  }
  const repeat = call('requestFriend', original, 'lin');
  assert.equal(repeat.ok, true); assert.equal(repeat.state, original);
});

test('removing a friend changes eligibility for the friends feed and can safely repeat', () => {
  const original = freezeDeep(state()), removed = call('removeFriend', original, 'lin');
  assert.equal(removed.ok, true);
  assert.deepEqual(ids(call('getFriends', removed.state)), ['chen']);
  assert.ok(call('getPosts', removed.state, { feed: 'friends' }).every(post => post.authorId === 'chen'));
  assert.equal(call('removeFriend', removed.state, 'lin').state, removed.state);
  assert.deepEqual(original.friends, ['lin', 'chen']);
});

test('blocking hides the author and their comments and clears all relationship entry points', () => {
  const original = state(), target = original.posts.find(post => post.authorId === 'lin');
  original.posts.find(post => post.authorId !== 'lin').comments.push({ id: 'sample-lin-comment', authorId: 'lin', body: '示例留言', createdAt: now });
  const before = JSON.stringify(original), blocked = call('toggleBlock', freezeDeep(original), 'lin');
  assert.equal(blocked.ok, true);
  assert.ok(!blocked.state.friends.includes('lin'));
  assert.ok(!call('getPeople', blocked.state).some(person => person.id === 'lin'));
  assert.ok(call('getPosts', blocked.state).every(post => post.authorId !== 'lin' && post.comments.every(comment => comment.authorId !== 'lin')));
  assert.equal(call('getPost', blocked.state, target.id), null);
  assert.equal(call('getPerson', blocked.state, 'lin').blocked, true);
  for (const method of ['requestFriend', 'cancelRequest', 'acceptFriend', 'removeFriend']) denied(call(method, blocked.state, 'lin'), blocked.state);
  for (const method of ['toggleLike', 'reportPost']) denied(call(method, blocked.state, target.id), blocked.state);
  denied(call('addComment', blocked.state, { postId: target.id, body: '不能留言' }, now), blocked.state);
  const unblocked = call('toggleBlock', blocked.state, 'lin');
  assert.equal(call('getPerson', unblocked.state, 'lin').blocked, false);
  assert.ok(call('getPost', unblocked.state, target.id));
  assert.ok(!unblocked.state.friends.includes('lin'), 'unblocking must not silently re-add a friend');
  assert.equal(JSON.stringify(original), before);
  const requested = call('requestFriend', state(), 'wu').state;
  assert.deepEqual(call('toggleBlock', requested, 'wu').state.outgoing, []);
  assert.deepEqual(call('toggleBlock', state(), 'qiu').state.incoming, []);
});

test('creating a post trims fields, retains plain text, and never creates financial fields', () => {
  const original = freezeDeep(state()), input = { circleId: 'harvest', title: '  今天收获番茄  ', body: '  <script>示例文字</script>  ', art: 'tomato' };
  const created = call('createPost', original, input, now);
  assert.equal(created.ok, true); assert.equal(typeof created.postId, 'string');
  const post = call('getPost', created.state, created.postId);
  assert.equal(post.title, '今天收获番茄');
  assert.equal(post.body, '<script>示例文字</script>', 'rendering escapes text rather than changing its meaning in the pure model');
  assert.equal(post.authorId, 'me'); assert.equal(post.isMine, true); assert.equal(post.seeded, false);
  assert.equal(post.createdAt, now); assert.equal(post.likes, 0); assert.deepEqual(post.comments, []);
  assert.equal(original.posts.length, 6); assert.equal(created.state.posts.length, 7);
  assert.deepEqual(Object.keys(created.state).sort(), ['viewer', 'people', 'posts', 'friends', 'incoming', 'outgoing', 'joined', 'likes', 'blocked', 'reports', 'serial'].sort());
  assert.equal(input.title, '  今天收获番茄  ');
});

test('post validation rejects each malformed field atomically with field errors', () => {
  const original = freezeDeep(state());
  const cases = [
    ['title', '少字'], ['title', '题'.repeat(41)], ['title', 123], ['title', '\u0000四个字'],
    ['body', '太短'], ['body', '文'.repeat(601)], ['body', null],
    ['circleId', 'all'], ['circleId', '__proto__'], ['art', 'goat'], ['art', 'https://example.com/secret.png']
  ];
  for (const [key, value] of cases) {
    const result = call('createPost', original, { ...postInput(), [key]: value }, now);
    denied(result, original); assert.equal(typeof result.errors[key], 'string');
  }
  for (const input of [null, undefined, [], 'text']) denied(call('createPost', original, input, now), original);
  for (const time of [NaN, Infinity, -1, '2026-10-27', null]) {
    const result = call('createPost', original, postInput(), time);
    denied(result, original); assert.equal(typeof result.errors.now, 'string');
  }
});

test('post inclusive limits accept four and forty title characters and five and six hundred body characters', () => {
  for (const [title, body] of [['题'.repeat(4), '文'.repeat(5)], ['题'.repeat(40), '文'.repeat(600)]]) {
    const created = call('createPost', state(), { ...postInput(), title, body }, now);
    assert.equal(created.ok, true);
  }
  for (const art of ['tomato', 'carrot', 'lettuce', 'chicken', 'none']) assert.equal(call('createPost', state(), { ...postInput(), art }, now).ok, true);
});

test('same submission replay shares its post while a later intentional post has a new id', () => {
  const created = call('createPost', state(), postInput(), now);
  const replay = call('createPost', created.state, postInput(), now);
  assert.equal(replay.ok, true); assert.equal(replay.state, created.state); assert.equal(replay.postId, created.postId);
  const later = call('createPost', replay.state, postInput(), now + 1);
  assert.equal(later.ok, true); assert.notEqual(later.postId, created.postId);
  assert.equal(later.state.posts.length, 8);
});

test('a full community rejects the forty-first post and a deletion releases capacity', () => {
  let current = state(), last;
  for (let i = 0; i < 34; i++) { last = call('createPost', current, postInput(), now + i); assert.equal(last.ok, true); current = last.state; }
  assert.equal(current.posts.length, 40);
  denied(call('createPost', current, postInput(), now + 35), current);
  const removed = call('deletePost', current, last.postId);
  assert.equal(call('createPost', removed.state, postInput(), now + 35).ok, true);
  const replay = call('createPost', current, postInput(), now + 33);
  assert.equal(replay.state, current); assert.equal(replay.postId, last.postId);
});

test('comment validation preserves a plain text body and enforces both length boundaries', () => {
  const original = freezeDeep(state()), postId = original.posts[0].id;
  for (const body of ['字', '评'.repeat(240), '  <img src=x onerror=alert(1)>  ']) {
    const result = call('addComment', original, { postId, body }, now);
    assert.equal(result.ok, true);
    const comment = call('getPost', result.state, postId).comments.at(-1);
    assert.equal(comment.body, body.trim()); assert.equal(comment.authorId, 'me'); assert.equal(comment.author.id, 'me');
    assert.equal(comment.createdAt, now);
  }
  for (const body of ['', '  ', '评'.repeat(241), '\u0000', 25, null]) {
    const result = call('addComment', original, { postId, body }, now);
    denied(result, original); assert.equal(typeof result.errors.body, 'string');
  }
  denied(call('addComment', original, { postId: 'missing', body: '一条留言' }, now), original);
  denied(call('addComment', original, null, now), original);
  denied(call('addComment', original, { postId, body: '留言' }, NaN), original);
});

test('a repeated comment submission is one comment and the fifty-first is rejected', () => {
  const original = state(), postId = original.posts[0].id, initial = original.posts[0].comments.length;
  const added = call('addComment', original, { postId, body: '记下一次好心情' }, now);
  const replay = call('addComment', added.state, { postId, body: '记下一次好心情' }, now);
  assert.equal(replay.ok, true); assert.equal(replay.state, added.state);
  assert.equal(call('getPost', replay.state, postId).comments.length, initial + 1);
  let current = added.state;
  for (let i = initial + 1; i < 50; i++) { const result = call('addComment', current, { postId, body: '留言' + i }, now + i); assert.equal(result.ok, true); current = result.state; }
  assert.equal(call('getPost', current, postId).comments.length, 50);
  denied(call('addComment', current, { postId, body: '满额以后' }, now + 99), current);
});

test('only the viewer can delete their post and deletion clears viewer reaction indexes', () => {
  const original = state(), seedId = original.posts[0].id;
  denied(call('deletePost', original, seedId), original);
  const created = call('createPost', original, postInput(), now);
  const liked = call('toggleLike', created.state, created.postId);
  const deleted = call('deletePost', freezeDeep(liked.state), created.postId);
  assert.equal(deleted.ok, true); assert.equal(call('getPost', deleted.state, created.postId), null);
  assert.ok(!deleted.state.likes.includes(created.postId));
  assert.ok(call('getPost', liked.state, created.postId));
  denied(call('deletePost', deleted.state, created.postId), deleted.state);
});

test('sample reporting records one visible external post without pretending moderation removed it', () => {
  const original = freezeDeep(state()), postId = original.posts[0].id;
  const reported = call('reportPost', original, postId);
  assert.equal(reported.ok, true); assert.deepEqual(reported.state.reports, [postId]);
  assert.equal(call('getPost', reported.state, postId).reported, true);
  const replay = call('reportPost', reported.state, postId);
  assert.equal(replay.ok, true); assert.equal(replay.state, reported.state);
  denied(call('reportPost', original, 'missing'), original);
  const own = call('createPost', original, postInput(), now);
  denied(call('reportPost', own.state, own.postId), own.state);
});

test('browser UMD loads with forbidden external globals and all state stays inside returned values', () => {
  assert.equal(fs.existsSync(file), true, 'social module must exist');
  const sandbox = {};
  for (const key of ['document', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket']) Object.defineProperty(sandbox, key, { get() { throw new Error(`${key} is forbidden`); } });
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const browser = sandbox.FarmSocial, first = browser.createState(now), before = JSON.stringify(first);
  const posted = browser.createPost(first, postInput(), now);
  assert.equal(posted.ok, true);
  assert.equal(browser.getPosts(posted.state).length, 7);
  assert.equal(JSON.stringify(first), before);
  assert.equal(browser.getPosts(browser.createState(now)).length, 6);
});
