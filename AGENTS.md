# 合耕小舍 · 竖版农场 H5 Demo

日期：2026-10-27；来源：用户需求与继续迭代／独立发布授权。当前工作为社交主页、论坛圈子、好友与分享设计；Demo 中的价格、库存、农时、成熟周期、收益、次数、间隔和奖励仍是提案。

本目录用于制作可公开分享的手机竖版 H5 Demo，后续面向微信、抖音小程序探索。真实农场和工作人员由用户确认存在；当前软件不连接真实农事设备、支付、身份、视频、广告或物流。

## 阅读入口

- [公开产品上下文](docs/PRODUCT.md)与[验收记录](docs/VERIFICATION.md)：仓库内可分享的产品范围和检查证据。
- [当前扩展规格](.scratch/farm-expansion/spec.md)：商城、活动、仓库与成长的范围、事务及验收。
- [当前扩展计划](.scratch/farm-expansion/plan.md)：模块接口、任务顺序与验证／发布。
- [社交主页](docs/SOCIAL.md)与[本轮规格](.scratch/social-home/spec.md)：主页、论坛、好友、分享及演示边界。
- [初版规格](.scratch/farm-prototype/spec.md)：历史基线；其中旧四入口以本轮五入口替代。
- [DESIGN.md](DESIGN.md)：成熟大气、图文清楚的移动视觉及 token 归属。
- [UX-CONTRACT.md](UX-CONTRACT.md)：农田／牧场、照料限制、福利、设备回执和收货流程。
- [prototype/README.md](prototype/README.md)：启动与体验方式。

本机长期记忆规则继续适用；当前明确指令优先于旧原型文档及历史默认流程。

## 正式上线目标推进（2026-10-27）

用户新增目标为“整体优化验收好，符合上线app和小程序的水平”。此前H5演示范围不能充当最终完成标准。`prototype/`继续遵守内存演示／设备模拟和示例地址约束；新 `apps/mobile/` 为uni-app Vue3跨端工程，`services/api/` 为Node24持久账户及资产服务，按 [API契约](docs/release/API-CONTRACT.md) 与 [上线验收矩阵](docs/release/READINESS.md) 推进。

生产平台身份、签名安装、真机、真实农场/硬件/视频/广告支付/实体履约及运维证据缺失时，必须保持目标未完成，不把跨端编译或沙盒HTTP测试替代真实上线。当前已询问用户公开平台配置和农场接口；秘密只进入服务端安全环境配置，不进聊天/源码/日志。开发登录须显式启用，production强制禁用；生产未开放能力失败关闭，不生成模拟执行成功。

新工程使用根workspace命令，最低Node24.15.0；根package不设type:module以保持prototype UMD兼容，服务端使用.mjs。运行数据/SQLite/备份不入Git。跨端视觉token经 `tools/sync-mobile-tokens.mjs` 从prototype/styles.css生成，不手改第二套颜色。新代码按实际HTTP、持久化、用户隔离、并发、响应丢失及跨会话场景验收。当前实施记录 `.scratch/release-readiness/`。

API运维归属 `services/api/src/operations.mjs`：日志只输出固定模板与脱敏运行指标，健康探针不是完整业务上线证明。`FarmStore`的prepared statement只按单连接复用固定内部SQL，动态参数每次重新绑定，禁止缓存用户快照或用用户输入扩展缓存键；schema、权限、事务和幂等语义不能因性能优化改变。负载工具为 `tools/load-api.mjs`（避免Node默认发现为测试），只创建自己的临时loopback服务；实际时长、资源变化和平台差异均如实记录，不把固定节奏短负载写成生产容量或无泄漏证明。

代理来源归属`services/api/src/client-address.mjs`，默认不信任任何转发头；只有部署方明确核实的网络配置才能启用XFF。必须保留规范IP、raw重复头检查、从右向左到首个不可信hop及头/链预算，不默认信任loopback、任意私网或固定跳数。来源地址不进入日志。幂等历史完整原结果重放仍为契约；持久增长不能通过静默删除旧key或改返最新快照来掩盖，需明确存储/容量/保留设计与备份兼容。

当前schema4的历史回执编码只由`receipt-codec.mjs`拥有，服务及备份共用；1024字节至8MiB有实际收益时压缩，否则原样JSON，预算不等于历史容量上限。旧schema2/3回执不批量重写，旧服务拒绝schema4；恢复清session和schema>=3注销确认，不放松固定表/索引与回执归属校验。未知资产请求不能因通用4xx/5xx丢原key，只有协议明确的Store后幂等拒绝＋合法同账户快照才可终结；保留generation、401原账户恢复和未知注销隔离。

## 实现约定

1. vanilla HTML／CSS／JavaScript 位于 `prototype/`。`domain.js` 负责原照料／推荐／邮寄／福利规则，`systems.js` 提供 UMD 纯模块 `FarmSystems` 的商城和活动等规则，`ui.js` 提供共享 SVG，`app.js` 拥有主状态和共享交互。`expansion.js` 通过 app bridge 接入，不复制钱包、设备或 modal；`styles.css` 拥有 canonical token，`expansion.css` 只消费这些 token 定义组合样式。
2. 保持单一成熟竖版移动方向，底部固定“我的农场／商城／主页／实景／我的”，中央主页大按钮；主页融合签到、社区圈子与好友，“商城”含当季认养／农场物资／积分好礼，原activities活动中心保留签到、任务、丰收集章和成就。我的农场保留农田／牧场，仓库、等级、图鉴、消息和每日农事从所属页面进入。
3. 面向 30–50 岁及中老年用户：正文 16–18px，辅助小字至少 12px，触控区域至少 48px。图文结合、原生语义、可见焦点、中文名称和减少动态效果均保留。
4. 农事限制在领域规则和界面两层执行。浇水／投喂明确剩余次数与下次可用时间；福利不绕过次数、间隔或设备忙碌限制。样本配置不能视作真实农业规则。
5. 设备保持“确认对象 → 发送 → 等待设备回执 → 执行 → 等待停止回执”的区别；无回执不显示已执行、不自动重试、不增加湿度或照料收益，需回面板核查。
6. 所有业务数据只保存在当前页面内存，刷新重置。邮寄使用示例信息；不外发、不写 storage、URL、日志或仓库，最终仅保留脱敏摘要。公开分享链接及复制可以使用真实 H5 URL。
7. 广告、邀请、订单、工作人员处理、设备与摄像头均标明模拟。广告完整观看才可领取且防重复；模拟邀请资格不能自称真实拉新，复制链接不等于邀请成功。
8. 共享按钮、SVG 图标、模态、toast、校验和导航统一行为；不能为农田与牧场复制不同的限制或设备逻辑。
9. 新增 8 种积分商品、购物车与满 60 减 20 积分券；余额、库存、数量、优惠券、收货资源原子提交，失败不扣分不发资源，重复事务不二次记账。原认养示例金额与积分价清楚区分，均无现金支付。
10. 签到按上海日界，连续中断开新轮次，已领日期不回溯刷；任务、印章、成就先满足条件后领一次。照料成功事件在灌溉 ACK／投喂成功后；收获事件在收蛋／首次采收或处理完成后，预约和无回执不计成功。

## 当前发布授权

用户已授权完成后发布 GitHub 独立分享链接，并明确不展示到其网站。本轮目标为独立仓库 `hejian-farm-demo` 及独立 GitHub Pages；不接入 AI Application Hub、不修改 Hub 目录或网站展示。此明确指令替代先前“仅本地、不建 Git、不发布”的限制，也优先于旧的 Hub 发布默认。

现场核实当前 GitHub 身份、目标仓库写权限、远端分支和 Pages 部署结果后再报告成功。不得上传凭据、真实个人信息、缓存或未经授权的素材。发布 H5 不代表微信／抖音小程序已提交、上架或平台 SDK 已通过验收；这些另行验证。

## 维护与验证

用户已授权继续反复优化 UI 并增加商城、活动和更多系统；在本轮范围内直接实现可修改的 Demo 样本，不重复要求审批样本。设计参数和新运营规则保持提案身份，用户验证后再记录结论。原领域与新增系统规则分别有意义测试，保持原设备、隐私及福利回归。验收记录实际命令、浏览器、窄屏／键盘／对比度和新部署结果；上一轮通过不等于本轮自动通过。生产系统重新核定真实业务与平台协议。本轮发布前不更新 Obsidian，待主任务明确授权后维护项目记忆。

## 写实摄影资产（2026-10-27）

用户要求全部可见场景、农产品、牲畜、积分物资及横幅改为写实照片风格；保留操作/状态SVG。当前25张均内置image_gen独立生成的AI摄影示意，不能当用户农场实拍或直播。`prototype/assets/photos/`和manifest.json为单一资产归属，ui.js的photoArt为H5统一图像入口，photography.css仅消费既有token；不得回退到旧SVG场景。mobile用`npm run assets`同步实际12图、`node tools/sync-photo-assets.mjs --check`验证摘要。原始PNG及含本机路径的过程json不发布，完整prompt/网络尺寸/hash在公开manifest。旧3个mobile插画副本已移除。视频与封面也应使用本轮照片版截图，保持截图讲解/非实拍/非直播说明。

## 农场档案实现

术语见[CONTEXT.md](CONTEXT.md)，接入契约见[农场档案](docs/release/FARM-RECORDS.md)。shared/farm-records.mjs拥有字段/页面/历史与转换校验；farm-registry.mjs拥有三表DDL、事务和历史，备份共用DDL。只读账户接口不改变金融Snapshot、revision、奖励或能力开关；观测不是设备回执。CLI仅显式私有文件/既有DB，真实资料和运行库不入Git。本轮全部验证使用合成数据。

## 持久农友实现

来源：2026-10-27用户社交/好友需求及持续上线目标。协议见[FRIENDS](docs/release/FRIENDS.md)，本轮计划`.scratch/durable-friends/`。`prototype`仍为内存示例社区；`apps/mobile`农友使用独立账户API，production保持关闭，不能把开发沙盒当已上线社交。

`shared/friends.mjs`拥有严格wire校验，`services/api/src/friends.mjs`拥有schema6四表、DDL/索引、关系和最小命令账，备份共用。先查原key回执再查独立社交expectedVersion；旧key只能恢复原命令结果，当前列表另读，不能复活后来移除的关系。别名由随机公开农友ID派生，码128bit；无公开目录/通讯录/UGC/奖励，不赋予好友私有农场/设备权限。关闭保留递增版本和当日额度，注销清双方引用并更新存活对象版本。

客户端复用唯一会话/待核对槽，社交回复不进入财务Snapshot，通用4xx/429/5xx不能丢未知key。列表/申请有界但命令账仍增长，不能静默裁剪历史；正式开放前仍需容量/保留、最新撤销删除记录、生产隐私及平台/真机证据。本轮不迁移用户运行库。

## 持久论坛实现

来源：2026-10-27持续上线目标及论坛/社交需求。契约见[FORUM](docs/release/FORUM.md)，计划`.scratch/durable-forum/`。`shared/forum.mjs`拥有严格DTO/文字/动作/审核批次与队列校验；`services/api/src/forum.mjs`拥有schema7五表、预审状态、分页、额度、最小命令账及无UGC审核元数据，备份共用DDL/索引和数据校验。帖子/评论先pending，明确审核后published；本人撤回擦除原帖及子评论文本，旧key/旧审核不能复活。陌生作者屏蔽仅凭当前可见内容，调用friends私有blockFromForum，同一事务影响双方关系与可见性。

命令先原回执/原批次再查版本；举报审核同时核对report和content版本。审核队列私有parents上下文最多40项；隐藏原帖下仍可拒绝/隐藏评论，批准/恢复须原帖公开。金融Snapshot/revision、财务原回执及奖励不变。production与非沙盒关闭，不以CLI测试冒充真实运营审核。

`tools/moderate-forum.mjs`仅明确既有schema7 DB；数据库/所在目录/输入文件/输出目录须私有，复用只读inspectApplicationDatabase后才打开写Store。新输出不覆盖/追链接，stdout仅固定结果/计数，operatorId为标签非人员认证。UGC仅在当前内容表与显式私有审阅文件，不进账/日志/URL/storage；墓碑/命令/审核历史仍增长，生产容量/保留和最新撤销删除清单待验。

跨端FarmTextField拥有H5原生label/input/textarea与非H5焦点；FarmForumActions/FarmDraftNotice及core/navigation+forum-draft统一拥有确认和草稿保护。全局快捷入口也须走同一导航保护，不允许经收据/主导航静默丢稿。全部验收用合成数据，不迁移运行库；原H5仍为内存论坛。

## 兑换记录实现

shared/exchanges.mjs拥有严格只读历史投影、资源标签与wire校验；三账户GET接口读取原purchase，不改schema/revision/经济规则。client.mjs保留已确认checkout原key定位收据，pending协议不变；farm.ts统一账户清理、读取代际、分页聚合及导航栈复用。FarmGoodsPhoto为商城/收据/仓库照片白名单入口，微信需virtualHost/shared保持列宽。分页仅限制响应，不解决整体JSON历史容量。公开Pages仍为prototype，无生产API。

## 社交主页实现

prototype/social.js的FarmSocial拥有纯内存圈子/帖子/评论/好友规则；community.js适配home/community/post/friends/friend页面，复用app的唯一dialog/frame/toast及导航。social.css仅消费canonical token；所有新文字/属性转义。社交操作不改积分/设备/广告或邀请资格。示例帖子/人物只按固定ID深链；本页自发帖只分享社区入口，不把正文/草稿放URL、storage、history或网络。历史仅白名单导航id/分类；取消清理、失败留稿、IME候选确认不能误发。正式移动工程本轮同步主页命名/视觉，生产社交仍关闭，不把H5示例好友当真实关系或实际审核。

## 持久播种申请与农务作业

契约见[PLANTING](docs/release/PLANTING.md)，本轮计划`.scratch/durable-planting/`。shared/planting.mjs拥有严格wire，services/api/src/planting.mjs拥有schema8五表、授权/状态/原命令账、备份校验和恢复禁权。只处理私有可信配置且已归属客户的planned作物档案，不把unitLabel当库存，不增加假支付/农时。production及非development身份失败关闭。

dispatch接单/派工，当前assignee+execute开工/完成；按记录每次重读权限。完成在同事务核对原档案版本/归属/轮次并新增growing历史，不复制旧测量/旧预测，不动financial Snapshot/revision/奖励。外部导入原批次先回放，新改写才检查active锁；不可在Store外抢先guard破坏原key语义。cancel-work是明确人工核实停工并禁用plan，非设备停止ACK，不能宣称地块未播种。

未知命令复用唯一pending，原最小回执和当前详情分开。独立工作流变化撤销相关注销准备；active本人/受派作业阻断注销，结束员工引用匿名化。恢复清session/注销准备并禁用plan、撤销grant/递增版本，防旧备份复活权限；仍需最新撤权/注销清单和保留/容量政策。私有工具显式保留经完整验证的旧schema7/8，当时HTTP升级schema9，当前schema10见下文。所有数据合成、不迁移运行库。

## 播种冷启动恢复

契约[RECOVERY](docs/release/RECOVERY.md)，计划`.scratch/cold-start-recovery/`。shared/recovery.mjs拥有严格wire，api/recovery.mjs拥有schema9 epoch/slots/intents三表、prepare代际墓碑、原回执状态、备份校验与恢复隔离。该阶段只保存planting固定字段，schema10另扩展固定eggs域，不额外保存UGC；production关闭。不把本模块当财务/农友/论坛或跨任意恢复点的全域保障。

登录结果明确environment，client严格核对并必须await恢复检查；失败锁新写但保留读资料/重试。open本体复用唯一pending，其他域原key不被覆盖；prepared冷启动不自动执行，settled只原结果、精确id ack，ack未知不重执行业务。原target和当前槽不同，不能拿GET current当旧ack证据。原账先查，raw保留intent-[32hex]非记账拒绝，避免毒化；只有owned当前prepared窄上下文可首次执行，execute/业务/原账/settle在同事务。

恢复轮换epoch、每槽version++、open prepared隔离quarantined，不自动继续或用户自助解除；原receipt不改。外部灾备核查仍必要，最新撤权/删除与快照外操作缺口不掩盖。准备/槽变化撤销注销确认，open先处理再删。客户端不写token/key/正文storage/URL/日志；当前唯一pending和账户/generation边界保持。全部合成数据，工作树/备份/私有输入不入Git。

## 每日鸡蛋登记与手动收取（2026-10-28）

契约[EGGS](docs/release/EGGS.md)，计划`.scratch/durable-eggs/`。shared/eggs拥有严格wire，api/eggs拥有schema10四表/固定索引/配置授权/实登批次/最小命令账及备份变换。显式chicken-eggs绑定本人animal/轮次，独立record权限；上海当日一笔非withdrawn批次/来源唯一，不自动补产或销毁。当前授权人员可撤回未收归档旧批次。

collect核对batchVersion和financial revision，Store同事务harvest items.eggs，继承XP8/收获统计与资格并revision+1；登记/撤回不动财务。原key优先，typed command/批次/事件/资产跨表校验；注销清本人对象和真实人员引用。私有provision-eggs仅inspect既有schema10，不迁移运行库。

新命令domain:'eggs'，旧无domain只严格planting；recovery固定分派/分别固定账，旧字节/指纹/墓碑不重写。schema9升级前拒绝伪造egg意图；备份2–10，恢复禁配置/撤权/version++及prepared隔离。旧工具明确保留7/8/9，HTTP升级10。

client唯一pending/全局原结果面板；成功collect抬高同账户/环境最低资产revision，ack不能解除旧资产写锁，GET可重试。FarmTextField数字语义/灰色placeholder与useFarmDraft复用唯一导航guard，错误保稿、label常显。全部合成开发沙盒，公开Pages仍内存示例，不把四端编译当正式上线。

## App微信授权基础（2026-10-28）

用户已选App微信登录；跨端账户资产共用方式及开放平台移动应用状态仍待答，不能自动创建另一套资产或合并。契约[APP-WEIXIN-AUTH](docs/release/APP-WEIXIN-AUTH.md)，本轮`.scratch/app-weixin-auth/`。api/weixin-app-oauth.mjs只提供固定OAuth交换与冻结私有摘要，不注册路由/环境fallback/Store建账；platform-http.mjs共享受限读取和同一PlatformIdentityError，旧小程序provider协议不变。UnionID证据namespace:null，没有已核实开放平台作用域，不是合并授权；未来入口仍须先持久claim再交换及核定映射。

core/weixin-app.mjs只用plus.oauth code/state，当前uni.login桥丢state不能替代。CSPRNG失败关闭，默认本地60秒覆盖发现/授权；cancel只清本地等待，不关闭微信。client.authorizePlatform在唯一登录代际中等code，退出/新登录可结束旧客户端等待，迟到code不HTTP；该动作不自动清另一authorizer的busy，最终页面生命周期必须显式协调。当前未接App UI/manifest/完整账户入口，标准基座/合成测试/四端资源不能冒充签名真机与正式登录。code/state/平台令牌/原标识/Secret只按契约短暂内存，不进客户端storage/路由URL、日志或原账；官方服务端HTTPS交换查询须按契约出站脱敏。不迁移运行库、不操作桌面或平台设置。

## Unity 安卓体验版（2026-10-31）

用户明确要求用Unity开发当前内容并打APK。原生工程`unity/`，边界[UNITY-APK](docs/release/UNITY-APK.md)，构建[README](unity/README.md)。FarmModel拥有唯一进程内演示钱包/规则，FarmUI共享UGUI控件，FarmApp导航/内存社区；不要误接生产账户或重复建账。主题由tools/sync-unity-theme.mjs从canonical CSS生成，照片同源转换并核摘要，字体Noto CJK+OFL许可随包。Unity对象不得用C# `??`代替其`==null`检查；共享Surface重用Image；自定义Graphic需要CanvasRenderer；旧Input模式显式设0。

本轮只生成体验签名APK，不代表微信/抖音SDK、生产设备/支付/广告/物流或正式上架。所有业务及UGC只在进程内、收货仅示例脱敏，退出重置。构建源码留工作树，Library/Gradle/TEMP/产物在有marker的D:/farm-unity-build；脚本只同步自身副本，不覆盖其他工程或操作其他模拟器。编辑器图形探针与APK编译/验签分别报告；后台或未知设备不能自动确认成功，草稿确认必须隔离原sheet键盘交互。

0.1.1按用户明确要求完成专属MuMu Android15安装和ADB交互，见[Android验收](docs/release/UNITY-ANDROID-VERIFICATION.md)，不替代ARM真机。Row只设最小高度，让实际字体行高决定首选高度。FarmInputField统一保留键盘取消/Escape直接结束路径的最新文字，临时事件保护仅内存，明确弃稿才销毁。空场景动态UI显式关闭stripEngineCode，避免MonoScript类115启动刷错；不能为减包重新启用而跳过实际启动日志。最终模拟器及App留运行，未触其他实例/包。
