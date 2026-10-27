# 田园账户与资产服务

Node.js 24，使用内置 HTTP、SQLite 和 crypto，无第三方运行依赖。对应 [API v1 契约](../../docs/release/API-CONTRACT.md)。此服务建立持久账户、资产和事务的联调闭环，并实现微信／抖音官方身份 HTTP 适配代码；当前尚未使用真实凭据完成官方联调，也未接入真实农场、支付、广告或物流。

当前数据库schema7包含[归属档案](../../docs/release/FARM-RECORDS.md)、[持久农友](../../docs/release/FRIENDS.md)及[论坛预审](../../docs/release/FORUM.md)；金融回执沿用schema4的[无损格式](RECEIPTS.md)，兼容旧原始JSON，备份支持schema2–7。论坛/农友仅开发沙盒开放，原金融key结果不变，旧服务不得打开新格式库或手工降级版本。

## 本地启动

在仓库根目录的 PowerShell 中执行：

```powershell
$env:FARM_MODE = 'development'
$env:FARM_ALLOW_DEVELOPMENT_AUTH = 'true'
$env:FARM_ALLOWED_ORIGINS = 'http://127.0.0.1:5174'
node services/api/src/server.mjs
# 或：npm run start -w @hejian/api
```

默认监听 `127.0.0.1:8787`；健康检查为 `GET http://127.0.0.1:8787/healthz`。若客户端使用其他来源或端口，需要明确加入 `FARM_ALLOWED_ORIGINS`，多个来源使用逗号分隔。CORS 不支持通配符或来源 `null`；原生客户端没有 Origin 头时仍须 Bearer 鉴权。

默认数据库为服务目录内的 `services/api/data/farm.sqlite`，与启动时的 shell 工作目录无关，持久保存账户、资产、会话摘要及幂等回执，刷新或重启不重置。整个 data 目录（除 `.gitignore`）均忽略，包括导出备份；数据库、WAL 和 SHM 也显式忽略，不得提交到 Git。自定义 `FARM_DATABASE_PATH` 请使用绝对私有路径。退出进程不会清除数据库，也不会向任何真实农场设备发送停止操作。`.env.example` 只是配置示例；服务不会自动加载 `.env`。

| 环境变量 | 默认值／要求 |
|---|---|
| `FARM_MODE` | `production`；只接受 `production` 或 `development` |
| `FARM_ALLOW_DEVELOPMENT_AUTH` | `false`；只有 development 并显式设为 `true` 才允许开发登录 |
| `FARM_HOST` | `127.0.0.1`；对外监听需由部署配置显式指定 |
| `FARM_PORT` | `8787` |
| `FARM_DATABASE_PATH` | `services/api/data/farm.sqlite` |
| `FARM_ALLOWED_ORIGINS` | 空列表；production 只接受明确 HTTPS 来源 |
| `FARM_WEIXIN_APP_ID`／`FARM_WEIXIN_APP_SECRET` | 微信小程序服务端凭据；可都不配，但不能只配一项 |
| `FARM_TOUTIAO_APP_ID`／`FARM_TOUTIAO_APP_SECRET` | 抖音小程序服务端凭据；可都不配，但不能只配一项 |

当 `NODE_ENV=production` 时，不允许 `FARM_MODE=development`。production 开启开发登录、非法 CORS／端口／会话时长、未知未来数据库 schema 都会拒绝启动。当前schema3保留已有账户资产并增加注销准备与匿名回执。

## 使用流程

1. development 联调先 `POST /api/v1/auth/development`，JSON 为 `{"account":"farm-tester"}`。账户名 3–40 个 ASCII 字母、数字、下划线或连字符，不用真实手机号／邮箱。
2. 从返回值读取 `data.token`，仅保存在客户端内存；之后使用 `Authorization: Bearer …`。相同账户名在新会话／重启后仍对应同一个沙盒账户，不能借登录提交余额或物资覆盖值。
3. `GET /api/v1/bootstrap` 读取完整 Snapshot，包括服务端时间、revision、钱包、购物车、任务、签到、成就和能力开关。
4. 资产 POST 使用当前 `expectedRevision`，并附稳定的 `Idempotency-Key`（8–100 个 ASCII 安全字符）。未知字段／类型拒绝；客户端不能提交余额、奖励、完成事件或时间。
5. 响应丢失时使用**完全相同业务正文、版本和幂等键**重试。成功回执先于版本检查；同一用户与 key 的不同指纹返回 409，不会补发第二份资源。
6. 409 带当前账户 Snapshot；先向用户展示最新明细，重新确认后使用新版本和新 key。不要自动把冲突请求换 key 重试。
7. 成功重放返回原成功 Snapshot；如果客户端已有更高 revision，不要用旧回包覆盖当前状态，应重新读取 bootstrap。
8. `POST /api/v1/auth/logout` 提交空 JSON 对象，注销当前会话。会话默认 30 分钟，过期／注销后失效。

## 已实现的资产接口

所有路径均以 `/api/v1` 为前缀；每个 POST 资产请求都要求鉴权、幂等键和 `expectedRevision`。

| 路径 | 业务字段 |
|---|---|
| `POST /cart/items` | `sku`, `delta`（非零安全整数） |
| `POST /checkout` | 可选 `couponId` |
| `POST /events/shop-visit` | 无额外字段；服务端按上海日界只计一次浏览 |
| `POST /activities/sign-in` | 无额外字段 |
| `POST /activities/tasks/:taskId/claim` | 无额外字段 |
| `POST /activities/achievements/:achievementId/claim` | 无额外字段 |
| `POST /activities/season/claim` | 无额外字段 |

development 沙盒初始 80 积分、6 份饲料与样本库存，仅用于联调。积分商品、活动及奖励复用已有 `prototype/systems.js` 纯规则。用户在服务端数据库中隔离，SQL 事务内统一校验版本、库存、余额、优惠券及回执；失败不会扣分或发资源。已验证通过的请求键保留原指纹；未成功的合法尝试也保留指纹，避免改正文复用同一编号。

服务端时间会记录已观察到的最大值，系统时钟回拨不恢复过期会话，也不回到旧上海日界。跨日 bootstrap 会同步每日状态并递增 revision，因此读取前一天版本的请求可能得到 409。正文读取期间跨日或会话过期，也会在提交前重新鉴权、取时间和校验版本。

没有客户端 care／harvest 事件入口；照料／收获任务不能靠任意上报“已完成”领奖。真实地块／牲畜返回空数组，`care/adoption/live/shipping/payments/advertising` 均为 false。

## 平台身份及生产边界

`POST /auth/platform` 接受 `platform: "weixin" | "toutiao"` 与一次性 `code`。服务端按成对环境变量启用对应 provider；没有凭据时仍返回 **503**，不会伪造 openid，也不会回退开发登录。只配AppID或只配Secret、增加未知凭据字段／自定义端点均拒绝配置。

固定官方请求如下，客户端不能提交或覆盖目标URL：

| 平台 | 官方端点与请求 |
|---|---|
| 微信 | `GET https://api.weixin.qq.com/sns/jscode2session`；query为 `appid`、`secret`、`js_code`、`grant_type=authorization_code` |
| 抖音 | `POST https://developer.toutiao.com/api/apps/v2/jscode2session`；JSON为 `appid`、`secret`、`code` |

依据：[微信官方code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)、[抖音官方code2Session](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/log-in/code-2-session)。2026-10-27已读取官方文档核对；微信文档使用直接HTTP读取，浏览索引工具不可访问。上述不是实际凭据调用成功的证明。

`providers.mjs` 使用真实 `fetch`，禁止重定向，默认5秒上限，并在响应头和实际读取流两层限制16KiB。只接受HTTP200、合法JSON及成功错误码，必须有合法、非匿名openid；错误码、HTTP错误、超时、缺字段或非法身份均拒绝，不返回原始平台错误。外层登录超时也会中止真实请求。微信协议要求AppSecret出现在固定HTTPS查询中，生产出站代理和观测系统必须屏蔽完整查询，不能记录实际密钥URL。

服务只把 `SHA256(AppID + 分隔符 + openid)` 作为内部身份，避免不同AppID的openid误合并；不存储／下发原始openid、unionid、session_key或临时code。真实账号仍返回自己的随机profile ID和高熵会话token，初始零资产。

在请求官方接口前，SQLite事务原子占用该平台／AppID命名空间／code的SHA256摘要。同code并发、失败或结果不明后的重放、服务重启后的重放均返回409 `IDENTITY_CODE_USED`，不会再次核验或产生第二个有效会话；客户端应重新调用平台登录获取新code。摘要保存状态而不是原code，当前保留用于持续防重，生产容量与保留策略仍须单独验证。数据库schema从v1迁移至v2仅增加此凭证摘要表，已有资产和会话保留。

工厂仍允许受信任的 `platformProviders` 注入，provider接收 `{platform,code,signal}`，核验成功后返回 `{subject}`；客户端不可设置。单测通过受控fetch模拟官方响应、超时与错误，并没有使用真实凭据或真实用户登录。密钥托管／轮换、平台真实code、SDK、真机和官方审核仍待现场联调。任何平台身份账户均初始零资产，即使development服务中使用平台provider，也不会自动变成沙盒。

production 平台账户的积分商城和活动同样关闭，须在真实经营规则与生产履约确认后另行实现能力启用。不能仅通过切换 `FARM_MODE` 将沙盒库存或演示奖励当作真实运营。

## 嵌入与测试接口

论坛帖子与评论先待审、通过后公开，支持作者撤回、举报状态和凭可见内容屏蔽陌生作者，详见[FORUM](../../docs/release/FORUM.md)。`tools/moderate-forum.mjs`仅对明确既有schema7/8私有目录操作，schema7显式保留版本不自动迁移；队列写私有新文件、审核批次原子提交，stdout不含正文。操作标签不等同真实人员认证，没有管理HTTP或production开启开关。

schema8新增[播种申请与授权农务](../../docs/release/PLANTING.md)：本人planned地块申请、按档案dispatch/execute权限、接单/指派/开工/完成及人工核实停工，实际SQLite事务与HTTP幂等。生产和非开发身份关闭，不是付费认养。`tools/provision-planting.mjs --environment development --database <absolute-private-existing-schema8-db> --input <absolute-private-json>`只读严格检查后按当前版本原子配置；输入及所在目录必须私有，命令参数不含JSON正文或账户名单。开工前客户可取消，已开工人工停工须dispatch明确核实；恢复禁用全部计划/人员权限。active作业保护档案导入和账户注销；回执与当前详情分开，不改变金融资产/奖励。

当前HTTP启动升级schema9，[播种操作恢复](../../docs/release/RECOVERY.md)提供账户current/prepare/execute/ack/abandon和精确intent详情。登录回复明确environment；新客户端必须检查恢复状态，不能缺字段默认开发或回退旧单步。服务端保存原planting固定字段及原key/回执，不存UGC正文。prepare代际墓碑、保留key、同事务执行、精确旧ack和恢复epoch隔离保持原结果与当前槽分开。此协议仅新planting，不改变其他域历史账/拒绝语义；production继续关闭。私有moderation明确保留7/8，provision接受8/9并保留8，不用工具偷偷迁移旧库。

schema6新增独立农友名片/关系/屏蔽及最小命令账，`GET /friends`与`POST /friends/commands`以服务器账户、环境和独立expectedVersion为准；原回执查找优先，旧命令不能复活已清关系。仅开发身份的development沙盒开放，真实平台身份及production均关闭。它不改变金融资产/revision或授权好友访问私人农场。名片开通、限额、注销与备份及未完成的生产门槛见[FRIENDS](../../docs/release/FRIENDS.md)。

账户类别查询及近期授权注销已接入，含全会话失效、原子回滚和匿名凭证重放，见[账户契约](../../docs/release/ACCOUNT-PRIVACY.md)。备份、校验和隔离恢复命令见[BACKUP.md](BACKUP.md)；恢复会清历史会话与未使用注销确认，不能把旧备份直接切入生产。

```js
import { createApp } from './services/api/src/server.mjs';

const app = createApp({
  databasePath: '/private/data/farm.sqlite',
  mode: 'production',
  allowedOrigins: ['https://your-farm-domain.example'],
});
app.server.listen(8787, '127.0.0.1');
// Graceful shutdown: await app.close();
```

工厂返回 `{server,store,close}`；可选测试配置为 `clock`、`sessionTtlMs`、`providerTimeoutMs`、`developmentAuthLimit: {maxAttempts,windowMs}`、`requestRateLimit: {maxRequests,windowMs}`。`close()` 为异步且幂等。不应从公网请求设置这些配置。

运行：

```powershell
node --test services/api/test/*.test.mjs
node --check services/api/src/config.mjs
node --check services/api/src/store.mjs
node --check services/api/src/providers.mjs
node --check services/api/src/server.mjs
```

26 项 HTTP／临时 SQLite 集成加8项provider验证，共34项：持久身份／资产／会话、服务重启、用户与环境隔离、过期／注销、同 key 并发重放、不同 key 版本冲突、丢回包后重启重试、库存／余额／券失败原子性、服务端日界和时间回拨、活动资格、伪造事件、恶意 JSON／16KiB、受限 CORS、限速、错误脱敏、启动配置／schema 保护、workspace 默认数据库路径、慢正文期间会话过期和跨日、固定官方请求、失败／超时／缺openid、同code并发和跨重启防重、schema升级。初次17项缺服务断言为 RED；慢正文两项实际出现 200 而不是401／409，workspace路径测试出现错误工作目录，provider新增10项先RED，修复后GREEN。

另有3项测试基础设施回归，验证Fetch安全端口分配及关闭／重启。Windows的动态TCP端口范围可能包含Fetch按标准禁止的端口；本机实际范围从1024开始，数量13977。`listen(0)`并不保证选择Fetch可访问的端口。共享 `test-support/listen-http.mjs` 会检查已分配端口、释放不合规则的空监听并重新分配，不关闭或覆盖Fetch安全限制。真实绑定6000时，原生HTTP可返回200而Fetch在发请求前报`bad port`；安全重新分配后同一服务可通过Fetch访问。API启动和重启fixture均使用该helper，保留业务HTTP／SQLite验收。

端口修复后，API集成文件已连续执行20轮、每轮26项全部通过，包含真实兑换、响应丢失和重启重放；监听回归另验证12次真实关闭／重启。没有跳过业务用例或关闭Fetch安全策略。

## 安全及运维约束

探活、只读准备检查、结构化安全日志、嵌入指标和有界关停见[OPERATIONS.md](OPERATIONS.md)；持续业务工具见[LOAD-TEST.md](LOAD-TEST.md)。这些本机工程检查不替代生产采集、告警、TLS、容量和真实平台验收。

仅存会话 token 的 SHA256 摘要，不在 DB 存明文 token；身份 code 不持久化，不写请求日志、URL或错误信息。私有响应 `no-store`，添加 `nosniff` 和 requestId。默认业务请求每来源地址每分钟240次、10次登录尝试；健康探针独立于业务限流。默认按socket地址，忽略所有转发头；需要反向代理时，只通过明确的`FARM_TRUSTED_PROXY_CIDRS`配置启用可信代理来源识别，详见[代理约束](OPERATIONS.md#可信代理与来源限流)。当前不是多实例分布式限流。

当前使用同进程同步 SQLite 事务。生产 TLS、数据库访问权限与加密、备份／恢复演练、监控告警、容量负载、灾备及多实例策略仍待真实部署验证。源码与这些本地检查不能作为已完成正式上线、官方身份联调、真实硬件或小程序官方审核的证明。
