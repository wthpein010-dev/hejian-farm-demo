/* Sample community rules. Returned state is page memory only; no assets or external services. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarmSocial = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const CIRCLES = [
    { id: 'harvest', name: '丰收分享', description: '记下田里的好收成，分享一份喜悦', art: 'tomato' },
    { id: 'questions', name: '种养问答', description: '把照料中的疑问带来，一起交流经验', art: 'lettuce' },
    { id: 'chat', name: '田园闲聊', description: '聊聊时令与生活，慢慢认识田园朋友', art: 'carrot' }
  ];
  const PEOPLE = [
    { id: 'lin', name: '林间有风', art: 'lettuce', bio: '喜欢清晨的菜园，也爱记录四季。', farmName: '林间小菜园' },
    { id: 'chen', name: '陈家小院', art: 'tomato', bio: '把每一份收获，写成生活里的小事。', farmName: '陈家小院' },
    { id: 'wu', name: '吴桐听雨', art: 'carrot', bio: '刚开始学习种菜，欢迎一起交流。', farmName: '听雨田园' },
    { id: 'qiu', name: '秋日慢慢', art: 'chicken', bio: '爱看田园风景，爱分享朴素的快乐。', farmName: '秋日小田' }
  ];
  const POST_ART = ['tomato', 'carrot', 'lettuce', 'chicken', 'none'];
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  const timeOK = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  const circleOK = id => CIRCLES.some(circle => circle.id === id);
  const objectInput = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
  const without = (items, id) => items.filter(item => item !== id);
  const success = (state, reason, extra = {}) => ({ ok: true, state, reason, ...extra });
  const failure = (state, reason, errors) => ({ ok: false, state, reason, ...(errors ? { errors } : {}) });
  const rawPerson = (state, id) => id === state.viewer.id ? state.viewer : state.people.find(person => person.id === id);
  const visiblePost = (state, id) => state.posts.find(post => post.id === id && !state.blocked.includes(post.authorId));

  function createState(now) {
    if (!timeOK(now)) throw new TypeError('社区时间必须是有效的毫秒时间');
    const posts = [
      { id: 'seed-harvest-tomato', authorId: 'lin', circleId: 'harvest', title: '清晨的小番茄，红得刚刚好', body: '今天来田里看看，枝头又添了几颗红番茄。慢慢等它长大，也是种菜的乐趣。大家最近收到了什么？', art: 'tomato', likes: 12, minutes: 18 },
      { id: 'seed-question-water', authorId: 'wu', circleId: 'questions', title: '天气转凉，蔬菜该怎样照料？', body: '这几天早晚有些凉，想听听大家平时观察土壤和叶片的经验。实际照料还是按农场建议与设备面板来。', art: 'lettuce', likes: 5, minutes: 42 },
      { id: 'seed-chat-morning', authorId: 'chen', circleId: 'chat', title: '留十分钟，看看田园的早晨', body: '忙了一周，今天坐下来看看菜地，心情也跟着慢下来。愿大家都能有一段属于自己的安静时光。', art: 'none', likes: 9, minutes: 75 },
      { id: 'seed-harvest-eggs', authorId: 'qiu', circleId: 'harvest', title: '把鸡蛋装进篮子，收获小小满足', body: '分享一张鸡蛋收获的示意照片。田园里寻常的小事，记录下来也很有意思。这里是示例社区，一起体验交流吧。', art: 'chicken', likes: 8, minutes: 120 },
      { id: 'seed-question-soil', authorId: 'chen', circleId: 'questions', title: '刚开始种菜，大家怎样做记录？', body: '想为自己的小菜园记一本农事日记。日期、叶片变化和天气之外，你还会记下哪些观察？只交流经验，不替代农场指导。', art: 'carrot', likes: 4, minutes: 165 },
      { id: 'seed-chat-season', authorId: 'lin', circleId: 'chat', title: '一畦青菜，装着这个季节的颜色', body: '青菜的叶色一天一个样，发现变化的时候特别开心。欢迎在田园闲聊里留下你眼中的季节。', art: 'lettuce', likes: 7, minutes: 210 }
    ].map(({ minutes, ...post }) => ({ ...post, createdAt: Math.max(0, now - minutes * 60000), seeded: true, comments: [] }));
    posts[0].comments.push({ id: 'seed-comment-tomato', authorId: 'chen', body: '这份小收获，看着就让人开心。', createdAt: Math.max(0, now - 12 * 60000) });
    posts[1].comments.push({ id: 'seed-comment-water', authorId: 'lin', body: '先观察，再参考农场工作人员的照料建议。', createdAt: Math.max(0, now - 30 * 60000) });
    return {
      viewer: { id: 'me', name: '我的田园', art: 'lettuce', bio: '在合耕小舍，记录自己的田园时光。', farmName: '我的小田园' },
      people: copy(PEOPLE), posts, friends: ['lin', 'chen'], incoming: ['qiu'], outgoing: [], joined: ['harvest'], likes: [], blocked: [], reports: [], serial: 0
    };
  }

  function getCircles() { return copy(CIRCLES); }
  function getPerson(state, id) {
    const person = rawPerson(state, id);
    return person ? { ...copy(person), isFriend: state.friends.includes(id), incoming: state.incoming.includes(id), outgoing: state.outgoing.includes(id), blocked: state.blocked.includes(id), isMe: id === state.viewer.id } : null;
  }
  function getPeople(state) { return state.people.filter(person => !state.blocked.includes(person.id)).map(person => getPerson(state, person.id)); }
  function getFriends(state) { return state.friends.filter(id => !state.blocked.includes(id)).map(id => getPerson(state, id)).filter(Boolean); }
  function getRequests(state) {
    const peopleFor = ids => ids.filter(id => !state.blocked.includes(id)).map(id => getPerson(state, id)).filter(Boolean);
    return { incoming: peopleFor(state.incoming), outgoing: peopleFor(state.outgoing) };
  }
  function projectPost(state, post) {
    const liked = state.likes.includes(post.id);
    return {
      ...copy(post), author: getPerson(state, post.authorId), isMine: post.authorId === state.viewer.id,
      liked, likes: post.likes + (liked ? 1 : 0), reported: state.reports.includes(post.id),
      comments: post.comments.filter(comment => !state.blocked.includes(comment.authorId)).map(comment => ({ ...copy(comment), author: getPerson(state, comment.authorId) }))
    };
  }
  function getPost(state, id) { const post = visiblePost(state, id); return post ? projectPost(state, post) : null; }
  function getPosts(state, options = {}) {
    if (!objectInput(options)) return [];
    const { circle = 'all', feed = 'latest' } = options;
    if ((circle !== 'all' && !circleOK(circle)) || !['latest', 'friends'].includes(feed)) return [];
    return state.posts.filter(post => !state.blocked.includes(post.authorId) && (circle === 'all' || post.circleId === circle) && (feed !== 'friends' || state.friends.includes(post.authorId)))
      .slice().sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).map(post => projectPost(state, post));
  }

  function toggleJoin(state, circleId) {
    if (!circleOK(circleId)) return failure(state, '这个圈子不存在');
    const next = copy(state), joined = state.joined.includes(circleId);
    next.joined = joined ? without(next.joined, circleId) : [...next.joined, circleId];
    return success(next, joined ? '已退出示例圈子' : '已加入示例圈子');
  }
  function toggleLike(state, postId) {
    if (!visiblePost(state, postId)) return failure(state, '这条动态不可用');
    const next = copy(state), liked = state.likes.includes(postId);
    next.likes = liked ? without(next.likes, postId) : [...next.likes, postId];
    return success(next, liked ? '已取消喜欢' : '已喜欢这条动态');
  }
  function personDenied(state, personId) {
    if (!rawPerson(state, personId) || personId === state.viewer.id) return '请选择其他示例田友';
    if (state.blocked.includes(personId)) return '请先解除屏蔽再进行好友操作';
    return '';
  }
  function requestFriend(state, personId) {
    const denied = personDenied(state, personId); if (denied) return failure(state, denied);
    if (state.friends.includes(personId)) return success(state, '已经是示例田友');
    if (state.outgoing.includes(personId)) return success(state, '已在示例申请列表中');
    if (state.incoming.includes(personId)) return failure(state, '对方已发来示例申请，请先接受');
    const next = copy(state); next.outgoing.push(personId);
    return success(next, '已加入示例申请列表，不会向真实用户发消息');
  }
  function cancelRequest(state, personId) {
    const denied = personDenied(state, personId); if (denied) return failure(state, denied);
    if (!state.outgoing.includes(personId)) return success(state, '没有待取消的申请');
    const next = copy(state); next.outgoing = without(next.outgoing, personId);
    return success(next, '已取消示例申请');
  }
  function acceptFriend(state, personId) {
    const denied = personDenied(state, personId); if (denied) return failure(state, denied);
    if (state.friends.includes(personId)) return success(state, '已经是示例田友');
    if (!state.incoming.includes(personId)) return failure(state, '没有这位田友的待接受申请');
    const next = copy(state); next.incoming = without(next.incoming, personId); next.outgoing = without(next.outgoing, personId); next.friends.push(personId);
    return success(next, '已接受示例田友申请');
  }
  function removeFriend(state, personId) {
    const denied = personDenied(state, personId); if (denied) return failure(state, denied);
    if (!state.friends.includes(personId)) return success(state, '对方不在示例田友列表中');
    const next = copy(state); next.friends = without(next.friends, personId);
    return success(next, '已移除示例田友');
  }
  function toggleBlock(state, personId) {
    if (!rawPerson(state, personId) || personId === state.viewer.id) return failure(state, '请选择其他示例田友');
    const next = copy(state), blocked = state.blocked.includes(personId);
    next.blocked = blocked ? without(next.blocked, personId) : [...next.blocked, personId];
    if (!blocked) { next.friends = without(next.friends, personId); next.incoming = without(next.incoming, personId); next.outgoing = without(next.outgoing, personId); }
    return success(next, blocked ? '已解除屏蔽，好友关系需要重新建立' : '本页已屏蔽这位示例作者');
  }

  function validText(value, min, max, multiline) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length >= min && text.length <= max && !CONTROL.test(text) && (multiline || !/[\r\n\t]/.test(text)) ? text : null;
  }
  function nextSerial(state) { return Number.isSafeInteger(state.serial) && state.serial >= 0 && state.serial < Number.MAX_SAFE_INTEGER ? state.serial + 1 : null; }
  function createPost(state, input, now) {
    if (!objectInput(input)) return failure(state, '请填写动态内容', { title: '请输入4至40字的标题', body: '请输入5至600字的正文' });
    const errors = {}, title = validText(input.title, 4, 40, false), body = validText(input.body, 5, 600, true);
    if (!circleOK(input.circleId)) errors.circleId = '请选择一个社区圈子';
    if (title === null) errors.title = '标题需4至40字，不能包含控制字符或换行';
    if (body === null) errors.body = '正文需5至600字，不能包含控制字符';
    if (!POST_ART.includes(input.art)) errors.art = '请选择提供的示意照片，或选择不配图';
    if (!timeOK(now)) errors.now = '发布时间无效，请重新打开页面';
    if (Object.keys(errors).length) return failure(state, '请检查动态内容', errors);
    const repeated = state.posts.find(post => post.authorId === state.viewer.id && post.createdAt === now && post.circleId === input.circleId && post.title === title && post.body === body && post.art === input.art);
    if (repeated) return success(state, '这条动态已发布在当前页面', { postId: repeated.id });
    if (state.posts.length >= 40) return failure(state, '本页动态已达40条，请先删除自己的旧动态');
    const serial = nextSerial(state); if (serial === null) return failure(state, '本页操作已达上限，请刷新后体验');
    const next = copy(state), postId = 'local-post-' + serial;
    next.serial = serial;
    next.posts.push({ id: postId, authorId: state.viewer.id, circleId: input.circleId, title, body, art: input.art, createdAt: now, seeded: false, likes: 0, comments: [] });
    return success(next, '已发布到本页示例社区，刷新后重置', { postId });
  }
  function addComment(state, input, now) {
    if (!objectInput(input)) return failure(state, '请填写评论内容', { body: '请输入1至240字的评论' });
    const post = visiblePost(state, input.postId);
    if (!post) return failure(state, '这条动态不可用');
    const errors = {}, body = validText(input.body, 1, 240, true);
    if (body === null) errors.body = '评论需1至240字，不能包含控制字符';
    if (!timeOK(now)) errors.now = '评论时间无效，请重新打开页面';
    if (Object.keys(errors).length) return failure(state, '请检查评论内容', errors);
    if (post.comments.some(comment => comment.authorId === state.viewer.id && comment.createdAt === now && comment.body === body)) return success(state, '这条评论已留在当前页面', { postId: post.id });
    if (post.comments.length >= 50) return failure(state, '这条动态的评论已达50条');
    const serial = nextSerial(state); if (serial === null) return failure(state, '本页操作已达上限，请刷新后体验');
    const next = copy(state); next.serial = serial;
    next.posts.find(item => item.id === post.id).comments.push({ id: 'local-comment-' + serial, authorId: state.viewer.id, body, createdAt: now });
    return success(next, '评论已留在本页，刷新后重置', { postId: post.id });
  }
  function deletePost(state, postId) {
    const post = visiblePost(state, postId);
    if (!post) return failure(state, '这条动态不可用');
    if (post.authorId !== state.viewer.id) return failure(state, '只能删除自己发布的动态');
    const next = copy(state); next.posts = next.posts.filter(item => item.id !== postId); next.likes = without(next.likes, postId); next.reports = without(next.reports, postId);
    return success(next, '已删除自己的动态');
  }
  function reportPost(state, postId) {
    const post = visiblePost(state, postId);
    if (!post) return failure(state, '这条动态不可用');
    if (post.authorId === state.viewer.id) return failure(state, '自己的动态可直接删除');
    if (state.reports.includes(postId)) return success(state, '本页已记录这条演示举报');
    const next = copy(state); next.reports.push(postId);
    return success(next, '本页已记录演示举报，未发送给审核人员');
  }
  return Object.freeze({ createState, getCircles, getPeople, getPosts, getPost, getPerson, getFriends, getRequests, toggleLike, toggleJoin, requestFriend, cancelRequest, acceptFriend, removeFriend, createPost, addComment, deletePost, toggleBlock, reportPost });
});
