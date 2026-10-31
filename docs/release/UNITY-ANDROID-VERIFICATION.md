# Unity Android 安装与交互验收

日期：2026-10-31。状态：**0.1.0基线及最终0.1.1安装、交互、启动日志复验已完成。** 本记录不表示正式上线或实体手机验收通过。

## 环境与证据

- 实际安装运行包：`com.hegeng.xiaoshe.demo`；基线 `0.1.0` / versionCode `1`，最终 `0.1.1` / versionCode `2`；体验签名v2验签及ADB安装通过。最终APK为71,447,244字节，SHA256 `ddc0cf36c11f7e14e312e7cf1c2bff43eed3651853698223c9e03cbc21b6ddb3`。
- 环境：专用 MuMu 实例，Android 15、x86_64，经 ARM 转译运行；截图分辨率 1440×2560。模拟器不能替代真实 ARM 手机。
- 操作使用普通 ADB 点击、滑动、按键和合成 ASCII 输入；后台恢复使用同一应用进程。未通过编辑器方法调用替代 Android 交互。
- 已只读核对截至冷启动检查的 `actions.jsonl`：155 条动作、49 份原始截图摘要，全部一致；其中包含中间失败尝试，不能将截图总数计为通过数。结论以画面与操作前后状态为准。原始操作记录、运行日志和环境信息留在本机，不随仓库发布。
- 公开截图归属 `unity/Documentation/android/`，从1440×2560原图等比缩至432×768，仅选取不含个人资料的应用画面。所有业务与输入均为离线合成演示。

## 0.1.0 已实测

| 检查 | 观察结果 | 原始截图索引 |
| --- | --- | --- |
| 启动与初始资产 | 实际进入主页；初始 80 积分、6 份饲料 | `initial.png` |
| 签到防重 | 80→100 积分；重复点击未再次加分 | `signed-once.png` |
| 积分购物车与券 | 两份饲料包合计 60；用券减 20，实扣 40 后余额 60，仓库饲料 12 | `cart-two-feed.png`、`checkout-success.png`、`warehouse-after-checkout.png` |
| 券门槛变化 | 已选券时减到一份，优惠归零；仍可取消券，再恢复两份并用券兑换 | `coupon-below-threshold.png` |
| 投喂防重 | 饲料 12→11；重复点击未再扣料，剩余 1 次，显示 4 小时间隔及下次时间 | `feed-cooldown.png` |
| 手动收蛋 | 收取 3 枚一次，随后按钮为“今日已收取”，重复点击未再次收取 | `eggs-collected-once.png` |
| A01 正常灌溉 | 实际看到启动回执后的运行状态；停止后湿度 32%→40%，剩余 1 次，显示 6 小时间隔 | `irrigation-running.png`、`irrigation-complete.png` |
| A03 无回执 | 显示“结果未确认”和人工核查提示，不宣称执行或停止；湿度保持 53% | `irrigation-no-ack.png` |
| A05 离线及后台未知 | 离线时明确未发送。改正常后确认并立刻 HOME，同进程恢复显示未知；人工核查后湿度仍 48%，剩余 1 次及冷却保留 | `irrigation-offline.png`、`irrigation-background-unknown.png`、`background-keeps-moisture.png` |
| 社区圈子 | 加入后显示“退出圈子”，再次点击返回未加入状态 | `circle-joined.png`、`community-circle.png` |

选取证据：[签到](../../unity/Documentation/android/signed-once.png)、[兑换后仓库](../../unity/Documentation/android/warehouse-after-checkout.png)、[正常灌溉完成](../../unity/Documentation/android/irrigation-complete.png)、[后台未知](../../unity/Documentation/android/irrigation-background-unknown.png)、[核查后湿度](../../unity/Documentation/android/background-keeps-moisture.png)。

## 问题复现与 0.1.1 修复复验

| 问题 | 原实际表现 | 0.1.1 C# 修复复验 |
| --- | --- | --- |
| 页面标题裁字 | Android 页面标题所在 40 点行高不足，社区等页面标题被裁切；返回按钮及正文仍可见 | 农场商城、我的农场标题完整可见：`new-shop-title.png`、`native-farm-title.png` |
| 键盘 Back 回滚草稿 | 0.1.0 两次输入均回空；中间修复包的 `new-before-back.png`→`new-after-back.png` 仍复现，不能记为修复通过 | 最终 C# 修复同时覆盖 Escape 直接取消输入的路径；`fixed-draft-entered.png`→`fixed-draft-after-back.png` 中 `keepdraft` 保留 |

旧 `draft-discard-confirm.png` 实际与 `community-circle.png` 摘要相同，画面没有放弃确认层；旧 `new-keyboard-back-retains.png` 名称也不代表内容已保留。只有下列最终 C# 修复后的实际画面用于本次复验结论。

| 检查 | 实际结果 | 原始截图索引 |
| --- | --- | --- |
| 关闭有稿面板 | Back 后内容仍为 `keepdraft`；点击关闭正确弹出“放弃未提交内容？” | `fixed-draft-after-back.png`、`fixed-discard-confirm.png` |
| 继续填写 | 点击“继续填写”返回原输入框，`keepdraft` 保留 | `fixed-continue-draft.png` |
| 动态发布 | 滚动到发布按钮后提交，社区显示新动态 `keepdraft` | `publish-ready.png`、`social-like-ready.png` |
| 点赞往返 | 新动态点赞数 0→1→0，页面位置保持 | `social-liked.png`、`social-like-cancelled.png` |
| 猪第一视角 | 成功切到相应照片及标题，明确显示“摄影示意·非直播” | `pig-first-person.png` |
| 我的页面 | 个人页、资产与菜单正常显示 | `native-profile.png` |
| 完全退出重启 | 签到后为 100 积分，强停再启动恢复初始 80、重新可签到，内存内容重置 | `before-cold-restart.png`、`after-cold-restart.png` |

选取证据：[标题完整](../../unity/Documentation/android/new-shop-title.png)、[Back 后保稿](../../unity/Documentation/android/fixed-draft-after-back.png)、[放弃确认层](../../unity/Documentation/android/fixed-discard-confirm.png)、[继续填写](../../unity/Documentation/android/fixed-continue-draft.png)、[发布及取消点赞](../../unity/Documentation/android/social-like-cancelled.png)、[猪第一视角](../../unity/Documentation/android/pig-first-person.png)、[冷启动重置](../../unity/Documentation/android/after-cold-restart.png)。

最终编辑器报告为 0 失败、7 页、10 项回归，包含真实排队 Escape 输入取消的新用例；这是 Editor PlayMode 证据。已有 43 条规则检查也保持独立归属，不合并为 Android 通过数。上表基础资产及灌溉检查来自 0.1.0，不能自动视为后续构建已全部重跑。

## 最终包与日志复验

日志检查实际发现启动时Unity类ID115被裁剪，重复报错16,202行。空场景动态创建UI明确关闭`PlayerSettings.stripEngineCode`后重新构建、验签、安装并启动；最终包采样129行，复验输入/返回/放弃确认后165行，Unity错误0、Fatal/托管异常/类裁剪错误0。系统仍有MuMu ARM转译和图形能力相关警告，未宣称系统日志全无警告。包专属退出历史仅见主动强停/更新，没有本轮崩溃或ANR记录。

最终71MB包再次实际完成输入`finaldraft`→Back保留→关闭显示放弃确认→明确放弃→返回主页，见[最终保稿](../../unity/Documentation/android/final-draft-kept.png)、[最终确认](../../unity/Documentation/android/final-discard-confirm.png)、[留在运行中的主页](../../unity/Documentation/android/final-home-left-running.png)。模拟器和应用保留运行；未清除其他包或操作其他实例。

## 尚未形成的证据

本轮尚未完成评论发布、中文 IME 候选确认与完整软键盘、广告及系统分享的 Android 验收。已验证切到猪第一视角，尚未逐一验收全部视角；多行输入框能接受 ASCII 不等于已验证 Enter 换行或中文软键盘。

真实 ARM 手机、系统读屏、大字与安全区、长时间运行及生产平台能力仍需另验。既有网页／跨端 CI 审计阻断仍未解除；Unity 原生工程不使用 npm 依赖，本记录不替代该 CI，也不把其状态归入 Unity Android 的实测结果。真实账户、设备、摄像头、广告、支付和履约边界继续遵守 [Unity APK 说明](UNITY-APK.md)与[上线矩阵](READINESS.md)。
