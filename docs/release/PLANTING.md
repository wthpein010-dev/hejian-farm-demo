# 播种申请与授权农务作业

2026-10-27。本模块推进正式产品工程；当前仅开发沙盒可用，全部验证使用合成账户和档案。公开 Pages 继续部署 `prototype/` 内存演示，不部署此 API。生产平台身份、真实地块/经营计划、工作人员授权与现场作业、保留政策、运维和真机仍需验收。

## 用户可完成的流程

客户端在“我的农场”打开本人待开始地块档案，读取农场配置和当前申请后提交。每档案最多一笔未结束申请；重登后可从档案和申请列表核对，服务端唯一约束避免换编号再产生一笔。申请不表示购买、支付或设备执行。

“我的 → 我的播种申请”显示本人记录；服务端存在当前人员授权时提供“农务工作台”。人员只能查看当前授权范围，接单和指派需要 dispatch，开工和完成需要 execute 且是当前受派人员。入口隐藏不代替 HTTP 鉴权。

状态为 `requested → accepted → assigned → working → completed`。客户开工前可取消；dispatch 可在开工前改派。最早开工时间来自私有配置，申请时冻结，改配置不会修改已有承诺。未确认的真实 T+1 SLA、成熟期、库存和价格不会由演示参数自动转为经营规则。

工作人员确认现场已播种后，完成命令同时核对订单版本与原档案版本/归属/轮次。在一个 SQLite IMMEDIATE 事务内保存回执、事件和订单，并登记档案 `growing`。开始/观测时间为明确的发生时间，旧测量不复制为新观测，旧预计收获清空并保留在历史。金融 revision、资产、奖励、其他能力开关不变。

已开工后需要人工停工时，dispatch 明确核实后记录 `cancel-work`。这不发送设备停止指令，也不是设备 ACK。订单取消并禁用该计划，保留开工与停工历史；不宣称地块尚未播种。农场再次核查并私有重新配置前不能新申请。恢复禁权或人员撤权后，可由可信重新授权的 dispatch 走此结束路径。

## 归属与权限

`shared/planting.mjs` 唯一拥有严格 DTO、命令/回执与私有配置校验。`services/api/src/planting.mjs` 唯一拥有 schema8 五表及索引、授权、状态、事件、原命令账和内容验证。Store 拥有外层事务、账户与注销；HTTP 只做边界、路由、会话与慢正文后的重新认证。

私有配置只接受明确既有 planned 作物档案和既有 development 账户，按 recordId 授予 dispatch/execute。客户端没有 grant 接口，账户名不决定权限。完整名单替换会立即撤销遗漏人员；每次读写重新核对当前授权。工作人员展示随机 ref，不返回登录 subject、姓名或客户私人资料。

配置需要 `recordId/expectedPlanVersion/recordVersion/enabled/notBefore/staff`。计划版本只用于配置 CAS；既有订单按对象版本判断。当前每次最多40个账户/角色组合。单订单最多100个事件，为开始、完成或取消预留位置；达限不再允许改派，不裁剪历史。

新启用计划必须仍是待开始档案；关闭计划时可对已开始/待收获/已归档作物调整或清空人员名单，保证完成后仍能撤销历史读取权限。这不会开放重复申请或重置档案。

外部档案导入先查原批次回执，旧成功仍恢复原计数；新变更在同一事务中检查 active 订单，处理中不可导入改写对应档案。完成由窄模块调用既有 registry；不公开任意档案编辑。

## HTTP 契约

均相对 `/api/v1`，登录认证、请求大小、来源限流、no-store 和脱敏诊断沿用账户服务。所有 GET 响应携带 `{plantingFormat:1,ownerId,environment,serverTime}`，ownerId 为查看者。

| 路由 | 用途 |
|---|---|
| `GET /planting/status` | 当前沙盒能力及是否有人员授权 |
| `GET /planting/record/{recordId}` | 本人档案的申请条件、当前 active orderId |
| `GET /planting/orders/{cursor}` | 本人申请，按 ID 升序每页20 |
| `GET /staff/planting/orders/{cursor}` | 当前人员授权范围列表 |
| `GET /planting/order/{id}` | 本人订单、事件和当前按钮权限 |
| `GET /staff/planting/order/{id}` | 授权详情及可指派人员的随机 ref |
| `POST /planting/commands` | request/cancel |
| `POST /staff/planting/commands` | accept/assign/start/complete/cancel-work |

命令精确字段和可接受枚举以 shared 模块为准。客户申请只提交档案 ID/版本；服务端派生归属、轮次、名称、位置和计划。完成包含 `expectedOrderVersion/expectedRecordVersion/performedAt`，停工包含 `expectedOrderVersion/stoppedAt/reason:'farm-confirmed-stop'`。错误字段、客户端角色/归属、无效动作和游标拒绝。

POST 需要已有规范的 8–100 字符 `Idempotency-Key`。服务端先查 actor+environment+key/fingerprint，才检查当前权限/状态。成功及明确拒绝均持久化，历史最小回执只确认原命令；撤权后原 actor 仍能核对本人回执，当前订单需另读并重新授权。

## 客户端恢复与隐私

跨端复用唯一会话、读取代际和 pending 槽；financial、农友、论坛及作业不能互相绕过未知结果锁。通用 4xx/429/5xx 不丢原 key，401 仅原账户恢复，迟到回复不能污染新账户/新选择。确认回执后另读当前详情；读失败不重新发命令。

新客户端使用[schema9操作恢复](RECOVERY.md)：服务端保存播种固定参数、原key/回执和prepare代际，重新登录核对原意图；客户端token及本地pending仍仅内存，无storage或私有正文URL。此保障只覆盖新播种协议，旧单步/其他域及快照外灾备核对仍有缺口；不把“查到最新订单”冒充恢复原操作。

每次计划、授权或订单改变，撤销相关客户/旧新工作人员未用注销确认。本人有未结束订单或仍被指派未结束作业时，不允许静默注销；需先处理。结束后员工删除清当前关联、个人命令账，历史 staffRef 匿名保留；客户删除清本人计划/订单/事件及档案，其他人员的最小原回执只剩随机 orderId，不含客户资料。真实订单保留/法定删除仍需核定，生产保持关闭。

## 私有配置、备份与恢复

`tools/provision-planting.mjs` 仅显式私有输入及既有 schema8 库；先完整只读 inspect，再打开写 Store。拒绝链接、公开权限、缺失库、生产环境和未知字段；stdout 只输出固定操作名、版本和计数。运行库、名单和输入不入 Git。具体命令见服务 README/工具 `--` 参数实现，不在公开示例中填真实身份。

备份共用模块固定 DDL/索引/内容验证，继续支持旧版本。schema8以上恢复清session/注销准备、禁用全部播种计划、撤销人员授权并递增版本；schema9另轮换恢复epoch并隔离prepared，见[恢复契约](RECOVERY.md)。原操作回执不改。私有工具可显式保留经验证的schema7/8，不自动升级；HTTP启动升级到9。

分页与单订单事件预算不等于总体容量/保留策略。命令历史、结束订单和授权墓碑仍增长，不静默删除旧 key。最新撤权/注销清单、生产隐私/履约与灾备切流尚需实际运维证据。

验收证据和实际命令记录在 `.scratch/durable-planting/`；未在本地或 CI 实际完成的运行项不能以本文宣称通过。
