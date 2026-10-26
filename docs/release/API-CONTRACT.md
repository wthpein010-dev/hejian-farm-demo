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

## HTTP边界

JSON请求最大16KiB，拒绝未知字段、错误类型及无穷数，受限CORS，禁止缓存私有响应，添加nosniff和requestId；development登录限速。数据库文件不进Git；支持同进程并发串行事务、重启保留资产。生产备份恢复、监控、TLS及多实例/数据库运维须独立验证，不因HTTP单测通过宣称上线完成。
