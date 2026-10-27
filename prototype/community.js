/* Social H5 demonstration adapter. FarmSocial owns rules; app owns the one dialog and farm assets. */
(()=>{
 'use strict';
 window.FarmCommunity={create(ctx){
  const {state,S,icon,photoArt,esc,btn}=ctx,F=window.FarmSocial;
  const ownViews=new Set(['home','community','post','friends','friend']);
  const titles={home:'主页',community:'田园社区',post:'田园动态',friends:'田园好友',friend:'个人田园'};
  const circleIds=new Set(F.getCircles().map(c=>c.id)),personIds=new Set(['me',...F.getPeople(state.social).map(p=>p.id)]);
  const blankDraft=()=>({circleId:'harvest',title:'',body:'',art:'none'});
  state.socialUI={circle:'all',feed:'latest',postId:'',personId:'',friendsTab:'friends',composeDraft:blankDraft(),composeErrors:{},commentDrafts:{},commentErrors:{},...state.socialUI};
  const ui=state.socialUI,now=()=>Date.now();
  let composing=false,compositionEndedAt=-Infinity,pendingModalRender=false,pendingPageRender=false;
  const notice=(text='示例社区 · 所有互动仅保留在本页，刷新后重置。')=>`<p class="social-notice">${icon('shield')}<span>${text}</span></p>`;
  const back=(action,label)=>btn(action,icon('back')+label,'extension-back back-button');
  const heading=(title,copy,actions='')=>`<div class="community-heading"><div><h1>${title}</h1><p>${copy}</p></div>${actions}</div>`;
  const section=(title,action='',label='查看全部')=>`<div class="social-section-heading"><h2>${title}</h2>${action?btn(action,label+icon('chevron'),'link-button'):''}</div>`;
  const empty=(title,copy,action='s-community',label='回到社区')=>`<div class="social-empty">${icon('sprout')}<h2>${title}</h2><p>${copy}</p>${btn(action,label,'outline-button')}</div>`;
  const photo=(art,cls='')=>art&&art!=='none'?`<div class="${cls}">${photoArt(art)}</div>`:'';
  const avatar=p=>photo(p?.art||'lettuce','social-avatar');
  const circleName=id=>F.getCircles().find(c=>c.id===id)?.name||'田园日常';
  const dateText=at=>Number.isFinite(at)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)):'示例记录';
  const socialAttrs=(key,id)=>`data-${key}="${esc(id)}"`;
  function postAuthor(post){
   return `<div class="post-author">${btn('s-person',avatar(post.author), 'post-person-photo',`${socialAttrs('person',post.authorId)} aria-label="查看${esc(post.author.name)}的个人田园"`)}<div><strong>${esc(post.author.name)}</strong><p class="post-meta">${esc(circleName(post.circleId))} · ${esc(dateText(post.createdAt))}${post.seeded?' · 示例动态':' · 本页发布'}</p></div></div>`;
  }
  function postActions(post,detail=false){
   return `<div class="post-actions">${btn('s-like',`${icon('heart')}<span>${post.liked?'已赞':'点赞'} ${post.likes}</span>`,'',`${socialAttrs('post',post.id)} aria-pressed="${post.liked}" aria-label="${post.liked?'取消点赞':'点赞'}${esc(post.title)}，${post.likes}赞"`)}${btn('s-comment',`${icon('message')}<span>评论 ${post.comments.length}</span>`,'',socialAttrs('post',post.id))}${btn('s-share',`${icon('share')}<span>分享</span>`,'',`${socialAttrs('post',post.id)} aria-label="分享${esc(post.title)}"`)}</div>${detail?`<div class="post-safety-actions">${post.isMine?btn('s-delete-post','删除这条动态','link-button danger-text',socialAttrs('post',post.id)):btn('s-report',state.social.reports.includes(post.id)?'已记录演示举报':'举报这条动态','link-button',socialAttrs('post',post.id))+btn('s-block','屏蔽此示例作者','link-button',socialAttrs('person',post.authorId))}</div>`:''}`;
  }
  function postCard(post){
   return `<article class="community-post">${postAuthor(post)}${btn('s-post',`<div class="post-copy"><h3>${esc(post.title)}</h3><p>${esc(post.body.length>88?post.body.slice(0,88)+'…':post.body)}</p></div>${photo(post.art,'post-photo')}`,'post-entry',`${socialAttrs('post',post.id)} aria-label="阅读动态：${esc(post.title)}"`)}${postActions(post)}</article>`;
  }
  function circles(){
   return `<div class="community-circles" aria-label="田园圈子">${F.getCircles().map(c=>`<article class="circle-card ${ui.circle===c.id?'selected':''}">${btn('s-circle',`${photo(c.art,'circle-card-art')}<span><strong>${esc(c.name)}</strong><small>${esc(c.description)}</small></span>${icon('chevron')}`,'circle-entry',`${socialAttrs('circle',c.id)} aria-pressed="${ui.circle===c.id}"`)}${btn('s-join',state.social.joined.includes(c.id)?'退出圈子':'加入圈子','circle-join',`${socialAttrs('circle',c.id)} aria-label="${state.social.joined.includes(c.id)?'退出':'加入'}${esc(c.name)}" aria-pressed="${state.social.joined.includes(c.id)}"`)}</article>`).join('')}</div>`;
  }
  function feedTabs(){
   return `<div class="social-feed-tabs" role="group" aria-label="动态筛选">${[['latest','最新动态'],['friends','好友动态']].map(([id,label])=>btn('s-feed',label,ui.feed===id?'active':'',`data-feed="${id}" aria-pressed="${ui.feed===id}"`)).join('')}${btn('s-circle','全部圈子','social-all-circles',`data-circle="all" aria-pressed="${ui.circle==='all'}"`)}</div>`;
  }
  function home(){
   const sign=S.getSignIn(state.system,now()),friends=F.getFriends(state.social),requests=F.getRequests(state.social),posts=F.getPosts(state.social,{circle:'all',feed:'latest'}).slice(0,2);
   return `<div class="social-home"><section class="home-profile-row">${avatar(state.social.viewer)}<div><h1>田园动态</h1><p>记录种养，和农友聊聊</p></div>${btn('s-compose',icon('plus')+'发动态','primary-button')}</section><section class="home-farm-cover"><img src="assets/photos/farm-estate.webp" alt="农场田园风景" width="1536" height="1024"><div><strong>合耕小舍</strong><span>种养记录 · 农友分享</span></div></section><section class="social-checkin">${btn('x-signin-calendar',icon('gift')+'<small>七日礼</small>','checkin-symbol','aria-label="查看七日签到奖励"')}<div class="checkin-copy"><h2>${sign.todayClaimed?'今天已签到':'每日签到'}</h2><p>连续 ${sign.streak} 天${sign.todayClaimed?' · 明天再来':' · 今日可领 '+esc(sign.rewards[sign.nextIndex]?.label||'积分')}</p></div>${btn('x-signin',sign.todayClaimed?'已签到':'签到领取','primary-button',sign.todayClaimed?'disabled':'')}</section><div class="social-shortcuts" aria-label="田园快捷入口">${[['s-community','chat','社区'],['s-friends','users','好友'],['activities','gift','活动'],['farm','farm','我的农场']].map(([a,ic,label])=>btn(a,`${icon(ic)}<span>${label}</span>${a==='s-friends'&&requests.incoming.length?'<small class="shortcut-count">'+requests.incoming.length+'</small>':''}`,'social-shortcut')).join('')}</div>${section('常逛的圈子','s-community','全部圈子')}<div class="home-circle-strip">${F.getCircles().map(c=>btn('s-circle',`${photo(c.art,'home-circle-photo')}<span>${esc(c.name)}</span>`,'home-circle-link',socialAttrs('circle',c.id))).join('')}</div>${section('农友动态','s-community','查看全部')}<div class="social-feed">${posts.length?posts.map(postCard).join(''):empty('还没有动态','分享一条种养日常。','s-compose','发动态')}</div><div class="home-friends-row">${icon('users')}<span>我的好友 <strong>${friends.length}</strong></span>${btn('s-friends','查看好友'+icon('chevron'),'link-button')}</div>${notice()}</div>`;
  }
  function community(){
   const posts=F.getPosts(state.social,{circle:ui.circle,feed:ui.feed});
   return `${back('home','返回主页')}${heading('田园社区','分享收获，交流种养经验。',btn('s-share-community',icon('share')+'分享社区','outline-button'))}${notice()}${circles()}<div class="community-compose">${avatar(state.social.viewer)}<div><strong>今天，田里有什么新鲜事？</strong><p>文字和配图，只保留本页。</p></div>${btn('s-compose',icon('plus')+'发动态','primary-button')}</div>${feedTabs()}<p class="social-feed-description">${ui.circle==='all'?'全部圈子':esc(circleName(ui.circle))} · ${ui.feed==='friends'?'仅看本页示例好友':'按发布时间排序'} · ${posts.length} 条动态</p><div class="social-feed">${posts.length?posts.map(postCard).join(''):empty(ui.feed==='friends'?'这里还没有好友动态':'这里还没有新动态',ui.feed==='friends'?'换到最新动态，或去发现几位示例朋友。':'写下第一份田园记录，一起分享小收获。',ui.feed==='friends'?'s-show-latest':'s-compose',ui.feed==='friends'?'看看最新动态':'发一条动态')}</div>`;
  }
  function postPage(){
   const post=F.getPost(state.social,ui.postId);
   if(!post)return `${back('s-community','返回社区')}${empty('这条动态已失效','它可能是刷新前的本地动态，也可能已经删除或被屏蔽。')}${notice()}`;
   return `${back('s-community','返回社区')}<article class="community-post post-detail">${postAuthor(post)}<div class="post-copy"><h1>${esc(post.title)}</h1><p>${esc(post.body)}</p></div>${photo(post.art,'post-photo')}${postActions(post,true)}</article><section class="post-comments" aria-labelledby="post-comments-title"><div class="social-section-heading"><h2 id="post-comments-title">评论 ${post.comments.length}</h2></div>${btn('s-comment',icon('plus')+'写一条评论','outline-button full',socialAttrs('post',post.id))}${post.comments.length?post.comments.map(c=>`<article class="post-comment">${avatar(c.author)}<div><strong>${esc(c.author.name)}</strong><p>${esc(c.body)}</p><small>${esc(dateText(c.createdAt))} · ${c.authorId==='me'?'本页评论':'示例评论'}</small></div></article>`).join(''):'<p class="social-comment-empty">还没有评论，来聊聊你的想法。</p>'}</section>${notice(post.seeded?'示例社区 · 点赞、评论与举报仅保留本页，刷新后重置。':'本页新发动态 · 刷新后重置，分享链接不会同步这条文字和评论。')}`;
  }
  function friendActions(person){
   if(person.id==='me')return '<span class="tag">我的示例身份</span>';
   if(person.blocked)return btn('s-unblock','解除屏蔽','outline-button',socialAttrs('person',person.id));
   if(person.isFriend)return btn('s-remove-friend','移除示例好友','link-button',socialAttrs('person',person.id));
   if(person.incoming)return btn('s-accept-friend','接受示例申请','primary-button',socialAttrs('person',person.id));
   if(person.outgoing)return btn('s-cancel-request','取消示例申请','outline-button',socialAttrs('person',person.id));
   return btn('s-request-friend','申请示例好友','outline-button',socialAttrs('person',person.id));
  }
  function friendCard(person){
   return `<article class="friend-card">${btn('s-person',avatar(person),'friend-portrait',`${socialAttrs('person',person.id)} aria-label="查看${esc(person.name)}的个人田园"`)}<div class="friend-copy"><h3>${esc(person.name)}</h3><p>${esc(person.bio||'种一点绿色，分享田园日常。')}</p>${btn('s-person','看看个人田园'+icon('chevron'),'link-button',socialAttrs('person',person.id))}</div><div class="friend-card-action">${friendActions(person)}</div></article>`;
  }
  function friendsPage(){
   const requests=F.getRequests(state.social),friends=F.getFriends(state.social),people=state.social.people.map(p=>F.getPerson(state.social,p.id)).filter(Boolean);
   const current=['friends','requests','discover'].includes(ui.friendsTab)?ui.friendsTab:'friends';
   let list='';
   if(current==='friends')list=friends.length?friends.map(friendCard).join(''):empty('还没有示例好友','去发现里逛逛，体验申请好友。','s-discover','发现示例朋友');
   if(current==='requests')list=requests.incoming.length||requests.outgoing.length?`${requests.incoming.length?`<h2 class="friend-list-label">收到的示例申请</h2>${requests.incoming.map(friendCard).join('')}`:''}${requests.outgoing.length?`<h2 class="friend-list-label">发出的示例申请</h2>${requests.outgoing.map(friendCard).join('')}`:''}`:empty('暂时没有好友申请','本页操作不会发送给真实用户。','s-discover','发现示例朋友');
   if(current==='discover'){const discovered=people.filter(p=>!p.isFriend);list=discovered.length?discovered.map(friendCard).join(''):empty('田园里的示例朋友都认识了','回到好友列表，看看大家的田园。','s-show-friends','看看我的好友');}
   return `${back('home','返回主页')}${heading('田园好友','添加农友，查看彼此的田园动态。')}${notice('示例好友网络 · 不读取通讯录，不向真实用户发消息；刷新后重置。')}<div class="friend-tabs" role="group" aria-label="好友列表">${[['friends',`我的好友 ${friends.length}`],['requests',`好友申请 ${requests.incoming.length+requests.outgoing.length}`],['discover','发现朋友']].map(([id,label])=>btn('s-friend-tab',label,current===id?'active':'',`data-tab="${id}" aria-pressed="${current===id}"`)).join('')}</div>${list}`;
  }
  function friendPage(){
   const person=F.getPerson(state.social,ui.personId);
   if(!person)return `${back('s-friends','返回好友')}${empty('暂时找不到这位朋友','示例身份可能已失效，回到好友列表继续体验。','s-friends','返回好友')}`;
   const posts=F.getPosts(state.social,{circle:'all',feed:'latest'}).filter(p=>p.authorId===person.id);
   return `${back('s-friends','返回好友')}<section class="social-profile"><div class="social-profile-art"><img src="assets/photos/farm-estate.webp" alt="个人田园风景" width="1536" height="1024"></div><div class="social-profile-copy">${avatar(person)}<span class="section-kicker">个人田园 · 示例身份</span><h1>${esc(person.name)}</h1><p>${esc(person.bio||'把日常种进田里，慢慢等一份收获。')}</p><div class="social-profile-actions">${friendActions(person)}${btn('s-share-person',icon('share')+'分享个人田园','outline-button',socialAttrs('person',person.id))}</div></div></section>${notice('个人田园只读示意 · 不提供他人照料、资产或设备操作。')}<section class="social-garden-preview"><div>${photo('tomato','social-garden-photo')}<span>一畦番茄 · 示例种植</span></div><div>${photo('lettuce','social-garden-photo')}<span>一畦生菜 · 示例种植</span></div></section>${person.id==='me'?'':`<div class="social-profile-safety">${person.blocked?btn('s-unblock','解除屏蔽此示例作者','link-button',socialAttrs('person',person.id)):btn('s-block','屏蔽此示例作者','link-button',socialAttrs('person',person.id))}</div>`}${section('分享过的田园日常')}<div class="social-feed">${posts.length?posts.map(postCard).join(''):empty(person.blocked?'已屏蔽此示例作者':'还没有可展示的动态',person.blocked?'解除屏蔽后可以重新查看示例内容；好友关系需重新申请。':'可以回社区看看其他田园新鲜事。')}</div>`;
  }
  function renderPage(view){return ({home,community,post:postPage,friends:friendsPage,friend:friendPage}[view]||(()=>null))();}
  function field(name,label,value,help,errors,multiline=false,max=600){
   const id=`s-${name}`,error=errors[name],hint=name==='title'?'例：今天的小番茄长大了':max===240?'写下你的想法，友善交流':'分享今天的种养日常',attrs=`id="${id}" name="${name}" data-focus-key="${id}" maxlength="${max}" placeholder="${esc(hint)}" aria-invalid="${!!error}" aria-describedby="${id}-help${error?' '+id+'-error':''}" autocomplete="off"`;
   return `<div class="social-field"><label for="${id}">${label}</label>${multiline?`<textarea ${attrs} class="resize-none" rows="5">${esc(value)}</textarea>`:`<input ${attrs} type="text" value="${esc(value)}">`}<p id="${id}-help" class="helper">${help}</p>${error?`<p id="${id}-error" class="social-error" role="alert">${esc(error)}</p>`:''}</div>`;
  }
  function renderModal(m){
   if(!m||!m.type.startsWith('s-'))return null;
   if(m.type==='s-compose'){
    const d=ui.composeDraft,e=ui.composeErrors;
    return ctx.frame('发动态',`<form id="s-compose-form" class="social-editor" novalidate>
     <p class="social-editor-notice">${icon('shield')}<span>本页发布，刷新重置。请勿填写真实个人信息。</span></p>
     <fieldset class="social-form-choices social-editor-circle"><legend>选择圈子</legend>${F.getCircles().map(c=>btn('s-compose-circle',esc(c.name),d.circleId===c.id?'active':'',`data-circle="${c.id}" aria-pressed="${d.circleId===c.id}"`)).join('')}</fieldset>
     ${e.circleId?`<p class="social-error" role="alert">${esc(e.circleId)}</p>`:''}
     <div class="social-editor-fields">${field('title','标题',d.title,'4–40个字，让大家一眼看懂。',e,false,40)}${field('body','正文',d.body,'5–600个字，分享今天的种养日常。',e,true)}</div>
     <fieldset class="social-photo-choices social-editor-photos"><legend>配图 <span>选填</span></legend>${[['none','不配图'],['tomato','番茄'],['carrot','胡萝卜'],['lettuce','生菜'],['chicken','土鸡']].map(([art,label])=>btn('s-compose-photo',`${art==='none'?'':photoArt(art)}<span>${label}</span>${d.art===art?`<span class="social-photo-selection" aria-hidden="true">${icon('check')}</span>`:''}`,`social-photo-choice ${d.art===art?'active':''}`,`data-art="${art}" aria-pressed="${d.art===art}"`)).join('')}</fieldset>
     ${e.art?`<p class="social-error" role="alert">${esc(e.art)}</p>`:''}
     <div class="social-editor-actions">${e.form?`<p class="social-error" role="alert">${esc(e.form)}</p>`:''}<button type="submit" class="primary-button full">发布到本页社区</button><p class="helper">关闭会清除草稿；发布不产生积分或奖励。</p></div>
    </form>`);
   }
   if(m.type==='s-comment'){
    const p=F.getPost(state.social,m.postId);
    if(!p)return ctx.frame('动态已失效',`<p>这条动态目前无法评论。</p>${btn('close','关闭','outline-button full')}`);
    return ctx.frame('写一条评论',`<form id="s-comment-form" novalidate><p class="helper">回应「${esc(p.title)}」。仅本页可见，刷新后重置。</p>${field('body','你的评论',ui.commentDrafts[p.id]||'','1–240个字，请友善交流。',ui.commentErrors,true,240)}${ui.commentErrors.form?`<p class="social-error" role="alert">${esc(ui.commentErrors.form)}</p>`:''}<button type="submit" class="primary-button full">发布本页评论</button></form>`);
   }
   if(m.type==='s-report'){
    const p=F.getPost(state.social,m.postId);
    return ctx.frame('演示举报',`<p>你将为「${esc(p?.title||'已失效动态')}」记录一次演示举报。</p><p class="social-notice">此操作仅在本页记录，不会发送给真实客服，也不代表平台审核已处理。</p>${btn('s-confirm-report','记录演示举报','primary-button full')}${btn('close','暂不举报','outline-button full')}`);
   }
   if(m.type==='s-block'){
    const p=F.getPerson(state.social,m.personId);
    return ctx.frame('屏蔽示例作者',`<p>屏蔽「${esc(p?.name||'这位作者')}」后，本页将隐藏其动态和评论，并移除与其的示例好友关系及申请。</p><p class="helper">可以在发现朋友中解除屏蔽；好友关系需要重新申请。</p>${btn('close','先保留','outline-button full')}${btn('s-confirm-block','确认屏蔽示例作者','primary-button full')}`);
   }
   if(m.type==='s-remove'){
    const post=m.kind==='post',object=post?F.getPost(state.social,m.postId):F.getPerson(state.social,m.personId);
    return ctx.frame(post?'删除本页动态':'移除示例好友',`<p>${post?`删除「${esc(object?.title||'这条动态')}」和它的本页评论？当前页无法找回。`:`将「${esc(object?.name||'这位朋友')}」移出本页好友列表？之后可以重新申请。`}</p><p class="helper">仅影响本次演示，不会通知真实用户。</p>${btn('close','先保留','outline-button full')}${btn('s-confirm-remove',post?'删除这条本页动态':'确认移除示例好友','primary-button full')}`);
   }
   return null;
  }
  function commit(result,success){
   if(!result.ok){ctx.toast(result.reason);return false;}
   state.social=result.state;ctx.render();ctx.toast(success||result.reason);return true;
  }
  function focusError(){document.querySelector('#app-dialog')?.querySelector('[aria-invalid="true"]')?.focus();}
  function handleAction(action,target){
   if(!action.startsWith('s-'))return false;
   const postId=target.dataset.post,personId=target.dataset.person,circle=target.dataset.circle;
   if(action==='s-community'){ctx.rememberNavigation?.();ctx.navigate('community');return true;}
   if(action==='s-friends'){ctx.rememberNavigation?.();ctx.navigate('friends');return true;}
   if(action==='s-post'){if(F.getPost(state.social,postId)){ctx.rememberNavigation?.();ui.postId=postId;ctx.navigate('post');}else ctx.toast('这条动态已失效');return true;}
   if(action==='s-person'){if(F.getPerson(state.social,personId)){ctx.rememberNavigation?.();ui.personId=personId;ctx.navigate('friend');}else ctx.toast('这位示例朋友已失效');return true;}
   if(action==='s-circle'){if(circle==='all'||circleIds.has(circle)){ui.circle=circle;ctx.rememberNavigation?.();if(state.view!=='community')ctx.navigate('community');else ctx.render();}return true;}
   if(action==='s-feed'){if(['latest','friends'].includes(target.dataset.feed)){ui.feed=target.dataset.feed;ctx.rememberNavigation?.();ctx.render();}return true;}
   if(action==='s-show-latest'){ui.feed='latest';ctx.rememberNavigation?.();ctx.render();return true;}
   if(action==='s-join'){commit(F.toggleJoin(state.social,circle));return true;}
   if(action==='s-like'){commit(F.toggleLike(state.social,postId));return true;}
   if(action==='s-compose'){ui.composeErrors={};ctx.open('s-compose');return true;}
   if(action==='s-compose-circle'){if(circleIds.has(circle)){ui.composeDraft.circleId=circle;ctx.renderModal();}return true;}
   if(action==='s-compose-photo'){if(['none','tomato','carrot','lettuce','chicken'].includes(target.dataset.art)){ui.composeDraft.art=target.dataset.art;ctx.renderModal();}return true;}
   if(action==='s-comment'){if(F.getPost(state.social,postId)){ui.commentErrors={};ctx.open('s-comment',{postId});}return true;}
   if(action==='s-delete-post'){const post=F.getPost(state.social,postId);if(post?.isMine)ctx.open('s-remove',{kind:'post',postId});return true;}
   if(action==='s-remove-friend'){if(F.getPerson(state.social,personId)?.isFriend)ctx.open('s-remove',{kind:'friend',personId});return true;}
   if(action==='s-confirm-remove'){
    const m=ctx.getModal();if(m?.type!=='s-remove')return true;
    const result=m.kind==='post'?F.deletePost(state.social,m.postId):F.removeFriend(state.social,m.personId);
    if(commit(result)){ctx.close();if(m.kind==='post'){delete ui.commentDrafts[m.postId];ui.postId='';ctx.navigate('community');}}return true;
   }
   if(action==='s-report'){const p=F.getPost(state.social,postId);if(p&&!p.isMine)ctx.open('s-report',{postId});return true;}
   if(action==='s-confirm-report'){const m=ctx.getModal();if(m?.type==='s-report'&&commit(F.reportPost(state.social,m.postId),'演示举报已在本页记录，未发送给真实客服'))ctx.close();return true;}
   if(action==='s-block'){if(F.getPerson(state.social,personId)&&personId!=='me')ctx.open('s-block',{personId});return true;}
   if(action==='s-confirm-block'){const m=ctx.getModal();if(m?.type==='s-block'&&!state.social.blocked.includes(m.personId)&&commit(F.toggleBlock(state.social,m.personId),'已在本页屏蔽此示例作者'))ctx.close();return true;}
   if(action==='s-unblock'){if(state.social.blocked.includes(personId))commit(F.toggleBlock(state.social,personId),'已解除本页屏蔽，可重新申请示例好友');return true;}
   if(action==='s-friend-tab'){if(['friends','requests','discover'].includes(target.dataset.tab)){ui.friendsTab=target.dataset.tab;ctx.rememberNavigation?.();ctx.render();}return true;}
   if(action==='s-discover'||action==='s-show-friends'){ui.friendsTab=action==='s-discover'?'discover':'friends';ctx.rememberNavigation?.();ctx.render();return true;}
   const friendMethods={'s-request-friend':'requestFriend','s-cancel-request':'cancelRequest','s-accept-friend':'acceptFriend'};
   if(friendMethods[action]){commit(F[friendMethods[action]](state.social,personId));return true;}
   if(action==='s-share'){const p=F.getPost(state.social,postId);if(p)ctx.open('share',{socialShare:{view:'post',id:p.id,title:p.title}});return true;}
   if(action==='s-share-community'){ctx.open('share',{socialShare:{view:'community',id:ui.circle==='all'?'':ui.circle,title:'田园社区'}});return true;}
   if(action==='s-share-person'){const p=F.getPerson(state.social,personId);if(p)ctx.open('share',{socialShare:{view:'friend',id:p.id,title:`${p.name}的个人田园`}});return true;}
   return true;
  }
  const isSocialField=target=>target&&['s-title','s-body'].includes(target.id)&&['s-compose','s-comment'].includes(ctx.getModal()?.type);
  function handleInput(event){
   if(!isSocialField(event.target))return false;
   const m=ctx.getModal(),name=event.target.name,value=event.target.value;
   if(m.type==='s-compose'&&['title','body'].includes(name))ui.composeDraft[name]=value;
   if(m.type==='s-comment'&&name==='body')ui.commentDrafts[m.postId]=value;
   return true;
  }
  function handleComposition(event,active){
   if(!isSocialField(event.target))return false;
   composing=active;handleInput(event);
   if(!active){compositionEndedAt=now();if(pendingPageRender){pendingPageRender=false;ctx.render();}if(pendingModalRender){pendingModalRender=false;ctx.renderModal();}}
   return true;
  }
  function handleKeyDown(event){
   if(isSocialField(event.target)&&event.key==='Enter'&&(composing||event.isComposing||event.keyCode===229||now()-compositionEndedAt<50)){event.preventDefault();return true;}
   return false;
  }
  function handleSubmit(event){
   if(!['s-compose-form','s-comment-form'].includes(event.target.id))return false;
   event.preventDefault();
   if(composing||event.isComposing||now()-compositionEndedAt<50)return true;
   const m=ctx.getModal();
   if(event.target.id==='s-compose-form'&&m?.type==='s-compose'){
    const fields=Object.fromEntries(new FormData(event.target)),draft={...ui.composeDraft,title:fields.title??ui.composeDraft.title,body:fields.body??ui.composeDraft.body};
    ui.composeDraft=draft;
    const result=F.createPost(state.social,draft,now());
    if(!result.ok){ui.composeErrors={...result.errors,...(!result.errors?{form:result.reason}:{})};ctx.renderModal();focusError();return true;}
    ctx.rememberNavigation?.();state.social=result.state;ui.postId=result.postId;ui.composeDraft=blankDraft();ui.composeErrors={};ctx.close();ctx.navigate('post');ctx.toast('动态已发布到本页，刷新后重置');return true;
   }
   if(event.target.id==='s-comment-form'&&m?.type==='s-comment'){
    const fields=Object.fromEntries(new FormData(event.target)),body=fields.body??ui.commentDrafts[m.postId]??'';
    ui.commentDrafts[m.postId]=body;
    const result=F.addComment(state.social,{postId:m.postId,body},now());
    if(!result.ok){ui.commentErrors={...result.errors,...(!result.errors?{form:result.reason}:{})};ctx.renderModal();focusError();return true;}
    if(commit(result,'评论已发布到本页')){delete ui.commentDrafts[m.postId];ui.commentErrors={};ctx.close();}return true;
   }
   return true;
  }
  function beforeNavigate(){composing=false;pendingModalRender=false;pendingPageRender=false;}
  function deferRender(){if(composing){pendingPageRender=true;return true;}return false;}
  function deferModalRender(){if(composing&&['s-compose','s-comment'].includes(ctx.getModal()?.type)){pendingModalRender=true;return true;}return false;}
  function onClose(modal){
   const refresh=pendingPageRender;composing=false;pendingModalRender=false;pendingPageRender=false;
   if(modal?.type==='s-compose'){ui.composeDraft=blankDraft();ui.composeErrors={};}
   if(modal?.type==='s-comment'){delete ui.commentDrafts[modal.postId];ui.commentErrors={};}
   if(refresh)ctx.render();
  }
  function navigationContext(){return {circle:circleIds.has(ui.circle)?ui.circle:'all',feed:ui.feed==='friends'?'friends':'latest',postId:F.getPost(state.social,ui.postId)?ui.postId:'',personId:personIds.has(ui.personId)?ui.personId:'',friendsTab:['friends','requests','discover'].includes(ui.friendsTab)?ui.friendsTab:'friends'};}
  function restoreNavigationContext(value){
   const saved=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
   ui.circle=circleIds.has(saved.circle)?saved.circle:'all';ui.feed=saved.feed==='friends'?'friends':'latest';
   ui.postId=typeof saved.postId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(saved.postId)?saved.postId:'';
   ui.personId=personIds.has(saved.personId)?saved.personId:'';
   ui.friendsTab=['friends','requests','discover'].includes(saved.friendsTab)?saved.friendsTab:'friends';
  }
  function shareContext(){
   if(state.view==='post'){const post=F.getPost(state.social,ui.postId);return post?{view:'post',id:post.id,title:post.title}:{view:'community'};}
   if(state.view==='friend'){const person=F.getPerson(state.social,ui.personId);return person?{view:'friend',id:person.id,title:`${person.name}的个人田园`}:{view:'community'};}
   return {view:'community',id:circleIds.has(ui.circle)?ui.circle:'',title:'田园社区'};
  }
  return {renderPage,renderModal,handleAction,handleSubmit,handleInput,handleComposition,handleKeyDown,beforeNavigate,deferRender,deferModalRender,onClose,navigationContext,restoreNavigationContext,navOwner:view=>ownViews.has(view)?'home':null,titles,shareContext};
 }};
})();
