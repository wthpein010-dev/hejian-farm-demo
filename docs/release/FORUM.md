# 论坛帖子、评论与预审

日期2026-10-27；当前为持续上线目标中的开发沙盒工程，生产与非沙盒身份保持关闭。公开prototype论坛仍是独立内存演示，不与本账户内容同步。真实运营、内容安全服务、人员权限、生产部署和平台审核尚未完成。

## 投稿与公开

圈子固定为丰收分享、种养问答、田园闲聊。使用已经主动开通的农友系统别名，不公开农友码或平台身份。发帖/评论/举报/屏蔽需要该名片处于开通状态；读取自己已提交内容和撤回不因关闭名片而失去入口。关闭农友名片与撤回投稿是不同操作。

帖子标题4–40个Unicode码点、正文5–600；评论1–240。纯文本显示，不执行HTML，不接收用户图片上传或自由举报说明。客户端去首尾空白后明确点击“提交审核”；输入、回车与输入法候选确认均不直接投稿。请勿把真实个人资料或秘密用于本机联调。

新帖和评论为pending；审核前仅本人及持私有DB权限的审核工具可看。状态为pending→published/rejected、published→hidden、hidden→published（明确复核恢复）。没有原位编辑，修改采用撤回后重新提交。本人从任何状态撤回后留下最小withdrawn墓碑，标题/正文清空；撤回原帖同时清空其子评论并解决关联未处理举报。旧提交、审核或丢回复重放不能恢复内容。

公开列表、详情与评论均在服务端分页前执行双向屏蔽过滤。可凭当前可见帖子/评论屏蔽陌生作者，复用全局农友屏蔽并移除双方申请/关系；不开放任意账户预览，解除也不恢复关系。自己的管理页可以查阅各状态；他人的待审/拒绝/隐藏/撤回内容不能借详情或游标读取。

举报理由固定spam/abuse/privacy/misinformation/other，不允许自举报，每人同一内容只一条。举报不自动全站下架；运营可dismiss或hide并解决，本人可查open/resolved和结果。作者撤回导致的关闭不冒充人工审核结论。

当前样本限制：服务器北京时间每日10篇帖子/50条评论/20次新举报，本人最多200条非withdrawn内容。撤回、换key或重开名片不重置日额度；失败/原key重放不二次消耗。额度、圈子和运营措辞为Agent提案，尚非农场确认的正式规则。墓碑、命令及审核历史仍增长，生产容量/保留不能以这些列表上限替代。

## 账户API

全部Bearer鉴权、账户与环境由服务端解析，禁止缓存。固定日志模板只记录路由类别，不记录ID、正文、标题、理由或查询字符串。接口不改变金融Snapshot/revision、财务原结果回执或农事奖励。

- GET `/forum/status`：forumFormat/ownerId/environment/serverTime，以及available/canPost/alias/limits/usage。
- GET `/forum/posts/{all|harvest|questions|chat}/{start|beforeId}`：公开帖子，20项createdAt/id倒序，nextCursor为本页末ID。
- GET `/forum/mine/{start|beforeId}`：本人帖子/评论/墓碑。
- GET `/forum/post/{id}/{start|beforeCommentId}`：原帖和20条可见评论，仅本人能看自己的未公开原帖。不存在和无权查看统一404。
- GET `/forum/reports/{start|beforeReportId}`：本人举报状态，无UGC副本。
- POST `/forum/commands`：稳定Idempotency-Key，精确正文为submit-post/circle/title/body，submit-comment/postId/expectedVersion/body，withdraw或block-author/contentId/expectedVersion，report/contentId/expectedVersion/reason。

共同读取作用域为forumFormat:1/ownerId/environment/serverTime。内容包括随机32hex ID、kind/parentId/circle、系统author、title/body/state/version、时间及固定reasonCode；举报有独立version。完整DTO以shared/forum.mjs严格校验，客户端不指定作者、状态、奖励或完成时间。

合法命令HTTP200返回最小`{forumFormat,ownerId,environment,operationKey,action,outcome,code,contentId,completedAt}`，applied/refused都是可确认结果；未知形状400、过期401。先查原key/正文指纹，再核对目标version/权限/额度；同key异正文拒绝，不替换原账。只保存最小结果和指纹，不保存标题/正文/他人快照的历史副本。合法旧回执只证明过去命令，当前状态另读。

论坛复用现有唯一pending槽、会话和代际，不走财务Snapshot解析。未知操作保留原key/body，通用4xx/429/5xx不能丢弃；401仅原账户重新登录后核对。切换/注销/迟到读取清理旧视图，输入/草稿/会话/请求仅运行内存，不进URL/storage/log。客户端进程重启的未知结果恢复、生产保留和撤销记录仍需后续完整设计。

## 私有审核工具

`tools/moderate-forum.mjs`仅接受明确的既有SQLite DB及development环境。没有管理HTTP接口、默认运行库、命令行正文或自动审批；系统权限是当前操作边界，operatorId只是审核标签，不能称作已验证工作人员身份。

导出：`--database <绝对DB> --environment development --export --output <绝对新文件>`，可选`--state pending|published|hidden|rejected`（默认pending，只能用于导出）。队列contentState标明筛选，最多20条对应状态内容和20open举报；parents另附最多40条去重原帖，精确覆盖所选/被举报评论上下文。隐藏内容可重新导出再复核恢复，公开内容可重新导出主动隐藏，不依赖原始SQL或猜版本。UGC只写私有新JSON；stdout仅固定状态/计数。DB和输出目录均须私有，拒绝覆盖、链接、非私有输入/数据库、路径替换和异常SQLite伴随文件。打开写连接前复用备份模块只读完整应用结构/数据检查，拒绝伪标schema7或非应用DB。

应用：`--database <绝对DB> --environment development --apply --input <绝对私有JSON>`。文件为`{formatVersion:1,batchId,operatorId,decisions:[{kind,id,expectedVersion,decision,reason,expectedContentVersion?}]}`，最多20项。content允许approve/reject/hide/restore且不带expectedContentVersion；report只hide/dismiss，必须带expectedContentVersion，核对举报与其当前目标两份版本。固定reason枚举与领域规则共享；一批全原子，旧batch同指纹只恢复原计数，不重复执行，异正文/旧版本/撤回后审核拒绝整批。审核账保留操作者标签、决定/版本/固定理由和时间，不保存UGC或作者映射。隐藏原帖不妨碍拒绝/隐藏其不当评论，评论公开/恢复仍须原帖已公开。

导出文件为显式私有审阅资料，需要自行保护和清理；它不是日志、公开分享材料或自动审核结果。正式平台内容安全、审核人员鉴权、举报处置SLA、申诉和审计政策均未因此完成。

## 存储与恢复

schema7由forum模块单源维护DDL/索引与数据校验；服务、备份共用。支持旧schema2–6校验/隔离恢复并由当前服务升级；旧schema6服务须拒绝7且不修改库。农场导入CLI准入同步7。只对合成临时库验证，不迁移用户运行库。

注销在同一事务清本人内容、原帖子评论、本人举报/命令及相关引用；审核账仅指纹和最小结果，无UGC副本。其他账户最小回执可保留已不存在的随机contentId，不能保留原作者映射或已删正文。恢复仍清旧会话和未用注销确认，但旧备份可能复活后来已撤回/隐藏的内容或已注销账户；正式切流仍需最新撤销/删除清单、保留政策、隔离、加密和灾备验收。

这里的正文清空/删除指活动业务记录和读取投影，不证明SQLite空闲页、WAL、此前私有审核导出或历史备份已经按字节擦除。正式删除与保留必须覆盖这些副本，当前工具尚未自动回收既有审阅文件。
