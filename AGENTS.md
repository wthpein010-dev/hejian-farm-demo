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
