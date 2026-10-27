# 账户与田园资产 API 契约 v1

状态：工程实施契约，2026-10-27。真实经营参数待核定；当前仅允许显式development沙盒测试积分/活动，不能将此契约视为真实支付或设备协议。

Base: `/api/v1`。JSON UTF-8，Bearer token只在客户端内存持有，不写URL/storage/日志。服务端生成requestId。所有资产请求鉴权，账户从会话解析，禁止客户端指定userId、余额、奖励值或完成时间。

## 返回模型

成功：`{data, message?, replayed?, requestId}`。
错误：`{error:{code,message}, requestId, data?:Snapshot}`。401会话无效；409版本冲突/幂等键被其他payload使用；422业务条件不满足；503能力未配置。错误不回显原始请求或秘密。

Snapshot:
```
{
 serverTime: number, revision: number,
 environment: 'development' | 'production',
 profile: {id: string, displayName: string},
 wallet: {points,feed,adToday,inviteCount,welcomeClaimed,receipts},
 system: FarmSystemsState,
 catalog: FarmSystemsCatalog,
 tasks: getTasks(...), signIn: getSignIn(...), season: getSeasonStatus(...),
 achievements: getAchievements(...), level: getLevel(...),
 farm: {plots: [], animals: []},
 capabilities: {pointShop:boolean,activities:boolean,care:false,adoption:false,live:false,shipping:false,payments:false,advertising:false}
}
```
纯规则字段以现有 `prototype/systems.js` 返回为准。服务端账户状态及时间为唯一权威。生产能力没有现场配置前false，真实账号初始资产为零，不生成模拟认养或作业。development的初始积分80、饲料6和样本库存仅作联调。

## 身份

- `POST /auth/development {account: string}` -> `data:{token,expiresAt,profile}`。account 3–40字符，只允许ASCII字母/数字/下划线/连字符；仅显式allowDevelopmentAuth并且mode=development允许。production必须拒绝启用此配置。相同account跨会话及重启仍对应相同账户，不能提交资产覆盖值。
- `POST /auth/platform {platform:'weixin'|'toutiao',code:string}`。平台服务端code换身份尚未配置时503，不伪造openid或fallback开发登录。未对接的provider使用显式不可用响应，不能宣称生产登录已完成。
- `POST /auth/logout` -> 注销当前token。
- token为高熵随机值，SQLite仅存SHA256摘要及期限；过期/注销后失效。

## 账户数据与注销

`GET /account/privacy`查阅当前账户保存的数据类别。`POST /account/deletion/prepare {expectedRevision}`要求5分钟内有效会话和当前版本，返回仅用于POST正文的2分钟确认凭证。`POST /account/deletion/confirm {confirmationToken}`原子删除当前账户及全部会话，保存不关联用户的最小完成回执。确认可不带Bearer，以便已删除会话后用原凭证核对未知结果；不接受userId，不允许URL或storage保存凭证。

准备、取消、版本变化或过期不会宣告已注销。网络错误、5xx或限流等通用4xx继续保留原凭证；只有有效完成回执或协议明确拒绝才结束核对。完整响应、错误码、备份与生产保留边界见[账户隐私契约](ACCOUNT-PRIVACY.md)。

## 查询与资产变更

- `GET /bootstrap` -> Snapshot；购物车、账户和历史从DB读取。只前进上海日界。
- `POST /cart/items {sku,delta,expectedRevision}` -> Snapshot。
- `POST /checkout {couponId?: string,expectedRevision}` -> Snapshot。
- `POST /events/shop-visit {expectedRevision}` -> Snapshot，当天只记录一次真实访问事件。
- `POST /activities/sign-in {expectedRevision}` -> Snapshot。
- `POST /activities/tasks/:taskId/claim {expectedRevision}` -> Snapshot。
- `POST /activities/achievements/:achievementId/claim {expectedRevision}` -> Snapshot。
- `POST /activities/season/claim {expectedRevision}` -> Snapshot。

所有POST资产变更必须带 `Idempotency-Key`（8–100字符ASCII安全ID）。在SQLite事务中按userId+key查重，指纹包含method/path/业务payload（包括expectedRevision）；相同请求重放返回原成功结果且不二次变更，不同指纹409。先检查幂等再检查版本；新请求expectedRevision不匹配409，返回最新Snapshot让用户重新核对。不自动重试冲突。不接受任意事件注入接口；care/harvest成功只能由未来已认证设备或工作人员事件产生。

结果未知后的资产核对只有合法同账户成功Snapshot，或以下精确Store拒绝且附合法同账户Snapshot，才能结束：409 `IDEMPOTENCY_CONFLICT`／`REVISION_CONFLICT`、422 `BUSINESS_RULE`、503 `CAPABILITY_UNAVAILABLE`。这些拒绝都发生在成功回执查找之后。普通429、通用4xx、维护/代理的503及缺少或无效Snapshot的同名错误码不能证明第一次未提交；客户端保留原key与正文。401清会话后保留原操作，只接受原账户恢复。首次无明确Store终态的5xx也进入未知结果核对。

schema4的无损回执编码及schema2/3/4备份兼容属于[内部存储契约](../../services/api/RECEIPTS.md)，不改变HTTP原结果重放。编码、SQL或持久化失败不能出现半扣款、半发放或仅保存状态而缺原成功回执。

## HTTP边界

JSON请求最大16KiB，拒绝未知字段、错误类型及无穷数，受限CORS，禁止缓存私有响应，添加nosniff和requestId；development登录限速。数据库文件不进Git；支持同进程并发串行事务、重启保留资产。生产备份恢复、监控、TLS及多实例/数据库运维须独立验证，不因HTTP单测通过宣称上线完成。

## 农友关系

独立 `GET /friends` 与 `POST /friends/commands` 采用[农友协议](FRIENDS.md)，不使用金融Snapshot/revision或资产幂等表。合法命令的HTTP200响应携带最小`applied/refused`原结果，之后另读当前关系；不是资产成功模型。原key重放不能恢复后来已取消或移除的关系。仅显式开发沙盒可用，production关闭；不赋予好友任何私人田园/设备权限。

## 农场归属档案与观测

新增独立Bearer只读接口：GET /farm/records/{plots|animals}/{start|cursor}、GET /farm/record/{id}/{0|beforeVersion}。每页20项，账户来自会话，暂无公开写入。字段/时间/游标与私有导入以[FARM-RECORDS](FARM-RECORDS.md)为准；账户privacy类别新增farm-records，注销一并删除归属档案与观测。financial Snapshot兼容farm空字段和原revision/幂等保持，不将档案同步计为设备执行、任务奖励或实体履约。

## 账户积分兑换记录

三个Bearer只读GET接口：`/account/exchanges/{start|beforeExchangeId}`、`/account/exchange/{id}`、`/account/checkout-receipt`。最后一个仅通过`Idempotency-Key`头查询已确认checkout的原操作，key不进入URL、响应或日志。账户由会话解析，缺失及其他账户记录统一404 `EXCHANGE_NOT_FOUND`；无效或非本账户游标400 `EXCHANGE_CURSOR_INVALID`。响应禁止缓存，日志只记录路由模板。

响应作用域为`{exchangeFormat:1,ownerId,environment,serverTime}`，列表追加`items,nextCursor`，详情追加`exchange`。单笔为`{id,day,items:[{sku,title,art,quantity,unitPoints,linePoints,grant}],count,subtotal,discount,total,couponId,received}`。`received`为原历史grant乘数量的本笔发放汇总；名称、单价、优惠及发放不从当前目录重算，day只代表上海日历日期。ID为`shop-api-`加64位小写hex。

每页20笔，最近优先，nextCursor为本页末笔ID或null；追加新兑换不影响更早游标。读取不syncDay、不改变revision、资产、schema或capabilities；坏历史固定500且不回显内容。原始purchases JSON仍整体读取和验证，分页仅限制响应与展示，不解决历史存储增长。当前仓库使用最新Snapshot的wallet.feed及system.inventory，不从收据反推余额。

客户端仅在checkout确认成功后保留原key、账户与环境的内存引用。未知操作沿用原key/body核对；确认后按该key打开收据，即使已同步较新Snapshot也不以最新purchase替代。401、退出、换登录及注销清理私有记录与确认引用，迟到响应不得污染新账户。新checkout确认后使旧列表失效；读取失败可重试，不发起第二笔兑换。
