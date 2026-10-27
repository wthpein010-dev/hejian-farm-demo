# 账户归属档案与农场观测

2026-10-27。跨端客户端与API新增持久档案读取、版本历史及私有批次导入。它为真实资料接入提供接口和工具；本轮验证全部使用临时合成数据，没有导入用户运行库。工作人员业务应用、认养订单、设备、视频和履约仍按[上线矩阵](READINESS.md)待实现或联调。

## 边界与数据归属

术语见根目录[CONTEXT](../../CONTEXT.md)。一条档案对应一个账户、环境、对象类别和种养轮次；以上归属不可通过更新转移。观测与设备执行回执分开。归档不等于已采收、处理或寄送。当前记录状态单调向前，下一轮需新档案ID和轮次；这是本版本工程约束，不能当作已核定的农场经营流程。

档案不进入金融Snapshot或历史资产回执；导入不改变积分、购物车、奖励、金融revision或真实能力开关。开发/生产的同名档案及批次互相隔离。客户无公开写入入口，只能用当前Bearer读取自己名下的档案。原Snapshot中的farm兼容字段保持空，消费者应使用下方独立接口。

## 只读API

路径相对 `/api/v1`，均需现有会话；响应沿用 `{data,requestId}` 和 `no-store, private`。不接收账户选择参数或query string。

| GET路径 | 返回 |
|---|---|
| `/farm/records/plots/start`、`/farm/records/animals/start` | 首屏最多20项，按ID升序；`nextCursor`为下一页游标或null |
| `/farm/records/{plots或animals}/{nextCursor}` | 游标后的下一页，明确加载更多 |
| `/farm/record/{id}/0` | 当前档案与最多20条倒序观测；`nextBeforeVersion`为下一页游标或null |
| `/farm/record/{id}/{nextBeforeVersion}` | 该版本之前的观测，exclusive游标 |

每页包含recordFormat=1、ownerId、environment、serverTime。列表额外含kind/items/nextCursor；详情含record/events/nextBeforeVersion。不存在与无权查看的档案统一404；输入错误400、会话无效401、内部损坏500，错误不回显资料。日志只记录固定模板，不记录动态档案ID、账户ID、测量值或token。

客户端校验完整shape、账户、环境、种养轮次、时间和游标链。两个读取序号阻止同账户迟到请求覆盖当前选择；注销/退出/401清空私有缓存。历史翻页时若当前版本变化，只自动刷新首屏一次，刷新失败保留原一致记录并提示重试。详情返回保留已加载列表与分类；显式刷新重新读取首屏。

## 私有导入

工具不联网、不创建账户、不自动读取环境配置；操作方必须拥有私有资料文件和既有服务数据库的本机权限。输入应为UTF-8 JSON常规文件，最大1MiB，POSIX仅所有者可读写，Windows排除普通用户可读ACL；符号/硬链接、被替换的文件或不安全SQLite伴随文件均拒绝。

```powershell
node tools/import-farm-records.mjs --validate --environment development --input C:/private/farm-records.json
node tools/import-farm-records.mjs --apply --environment development --input C:/private/farm-records.json --database C:/private/farm.sqlite
```

`--validate`只检查数据，不打开数据库；`--apply`必须显式指定已存在的应用SQLite。成功只输出计数、失败只输出固定分类，不回显路径、账户或记录。真实生产导入前应先在隔离恢复库演练，不能将本轮合成数据作为真实农场资料。

输入顶层为 `{formatVersion:1,batchId,source,entries:[{expectedVersion,record}]}`，每批1–100项。同环境同batchId和规范内容重放返回原计数；同编号不同内容拒绝。整个批次一次事务，任何账户、版本或轮次错误全回滚。新记录expectedVersion=0；更新需当前版本。

record必需字段：id、ownerId、kind、name、unitLabel、cycleRef、status、startedAt、expectedHarvestAt、observedAt、measurements；不接收environment，它来自操作参数。ID/batchId为8–64位小写ASCII字母数字连字符，source为3–64位。kind为plot/animal，status为planned/growing/ready/archived；未知字段、非法或未来观测时间均拒绝。开始/预计收获可null，不补造日期。测量仅允许地块areaM2/moisturePercent、牲畜weightKg/headCount；不放地址、照片链接或工作人员个人信息。

## 存储、注销与备份

schema5新增farm_records、farm_record_events、farm_imports；DDL只由registry模块拥有，备份校验共用。旧schema2/3/4的金融回执原字节不重写。旧schema4服务拒绝打开schema5；不得手改user_version降级。迁移前备份、在全新隔离路径演练后再按正式运维流程切换。

备份支持schema2/3/4/5，检查固定表/索引、复合FK、版本连续性、归属/生命周期/日期、最后事件与当前记录一致、批次回执结构。恢复仍清旧会话与未用注销确认。账户注销原子删除该账户的档案和观测；匿名批次指纹/计数保留用于防重放，旧批次重放不能重建已删账户资料。历史备份删除清单和生产保留口径仍待核定。

## 证据

共享契约、真实Store/CLI、双环境/DDL篡改、真实HTTP及备份恢复测试位于 `tests/farm-records*.test.mjs` 和 `services/api/test/farm-*.test.mjs`。浏览器验证使用联调账户与23条合成档案/23版本观测；不代表真实农场已登记或平台真机通过。最新命令与发布结果记入[PROGRESS](PROGRESS.md)。
