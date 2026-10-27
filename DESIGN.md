---
version: alpha
name: "合耕小舍 · 竖版农场 H5 Demo"
description: "面向中年及中老年用户的真实农场种养体验提案，以大图大字连接农田、商城、活动、成长和实体收获。"
status: "产品方向已确认；Demo 视觉与参数待验证"
updated: "2026-10-27"
colors:
  canvas: "#f5f6fa"
  paper: "#ffffff"
  ink: "#1f2633"
  secondary: "#5d6675"
  primary: "#006cd9"
  brand-soft: "#eaf3ff"
  accent: "#b57c28"
  line: "#e6e9f0"
  danger: "#b33e3e"
  warning: "#805b24"
  focus: "#006cd9"
  muted: "#727c8b"
  scroll-thumb: "#b0bac8"
  scroll-hover: "#7c8b9f"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
  numeric:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
rounded:
  DEFAULT: "12px"
omitted:
  - section: spacing
    reason: "间距由移动共享布局 CSS 拥有，本文保留可阅读和可触控的约束。"
components:
  canvas:
    backgroundColor: "{colors.canvas}"
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    height: "48px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  secondary-copy:
    textColor: "{colors.secondary}"
  selected:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.ink}"
  recommendation:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.ink}"
  harvest-decoration:
    backgroundColor: "{colors.accent}"
  divider:
    backgroundColor: "{colors.line}"
  dialog:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  danger:
    textColor: "{colors.danger}"
  warning:
    textColor: "{colors.warning}"
  focus-ring:
    backgroundColor: "{colors.focus}"
  decorative-mark:
    backgroundColor: "{colors.muted}"
  scrollbar-thumb:
    backgroundColor: "{colors.scroll-thumb}"
  scrollbar-hover:
    backgroundColor: "{colors.scroll-hover}"
---

# 合耕小舍 Design System

## Overview

### Creative North Star

参考手机 QQ 的轻盈、简洁和熟悉的社交结构：普通顶栏、圆头像、清楚的列表与动态，蓝色只强调主要操作和当前状态。写实农场照片提供对象识别，界面采用自然中文与系统无衬线字体，面向30–50岁及中老年用户。

本轮已确认单一成熟竖版方向，替代此前三种首页比较。用户与业务方向见[产品说明](docs/PRODUCT.md)，具体视觉、样本及运营参数仍是 Demo 提案，不作为已批准的生产设计系统。

### Product context and register

- 用户：30–50 岁及中老年中文用户，远程认养农作物或牲畜，查看照料和收获。
- 主任务：辨认自己的田和牧场；理解推荐商品、成熟周期、照料限制及实体收货。
- 场景：手机竖版网页，后续探索微信／抖音小程序；桌面居中呈现同一页面。
- 语言：`zh-CN`，操作、辅助说明、状态、日期及可访问名称均为中文。
- Register：产品应用。图像帮助识别对象，大字和明确动作优先于装饰。
- 记忆点：同一农场里的农田和牧场可切换，作物与牲畜贯穿认养、照料、现场和收获。
- 克制处：不把牲畜画成低幼宠物，不用过量漂浮金币、庆祝或游戏化动效遮盖状态。
- 避免参照：小号字体密集后台、三栏桌面控制台、只有图标的导航、低幼卡通及收益承诺式促销页。
- 市场：具体地区与经营规则尚待确认，中文界面不等于已完成当地合规或平台验收。

### Token ownership/runtime mapping

采用 runtime canonical 模式。`prototype/styles.css` 是运行时 token 的唯一归属，本文件镜像本轮约定值与使用理由。不生成第二套主题、Tailwind 或独立手抄参数文件。

| 本文件路径 | 运行时变量／规则 | 消费者 |
|---|---|---|
| `colors.canvas` | `--canvas` | 页面底色 |
| `colors.paper` | `--paper` | 卡片与模态表面 |
| `colors.ink` | `--ink` | 标题、正文、操作和关键状态 |
| `colors.secondary` | `--secondary` | 次要说明、状态标签、单位 |
| `colors.primary` | `--brand` | 主动作、当前导航、焦点语言 |
| `colors.brand-soft` | `--brand-soft` | 已选项与推荐徽标背景 |
| `colors.accent` | `--accent` | 成熟与收获的金色装饰 |
| `colors.line` | `--line` | 分隔线与静态边界 |
| `colors.danger/warning` | `--danger/--warning` | 停止、错误及警示文字 |
| `colors.focus` | `--focus` | 可见键盘焦点 |
| `colors.muted` | `--muted` | 非必要装饰，不能替代必要正文 |
| `colors.scroll-thumb/scroll-hover` | `--scroll-thumb/--scroll-hover` | 全局滚动条及 hover |
| `typography.display` | `--font-display` | 少量品牌标题 |
| `typography.body` | `--font-body` | 页面、表单、按钮、状态 |
| `typography.numeric` | `--font-data` 与 `tabular-nums` | 周期、数量和计时 |
| `rounded.DEFAULT` | `--radius` | 共享卡片的默认圆角 |
| `components.button.height` | 共享控件至少 48px | 按钮与同类触控入口 |

三种旧首页不再作为消费者。共享色值改变时同步核对文档与 CSS；滚动轨道 `--scroll-track` 为 transparent。间距和组件专用圆角由当前共享 CSS 统一拥有，不在各页面重复一套值。

## Colors

浅灰底色、白色表面、蓝色主操作和深色文字建立熟悉的社交产品层级。金色对应成熟与收获，只作有限强调。农田、牧场、商城、活动、成长和邮寄使用同一语义。`expansion.css` 消费现有 token，不另造主题。

必要文字用 `ink` 或 `secondary`。白字在 `brand` 上约 5.06:1；`secondary` 在白／canvas／brand-soft 上分别约 5.80:1、5.37:1、5.18:1，可用于这些表面的普通字号必要信息。

`ink` 在 `accent` 上约 4.25:1，白字在 `accent` 上约 3.57:1，均不作为普通字号文字组合。金色用作装饰、边线或无文字图形；推荐徽标文字用 `ink` 放在 `paper`／`brand-soft` 上。若新增金底文字方案，须先定义并检查更深的文字色。

状态同时提供文字和图标，不能只靠绿／灰／红区分。`muted` 在白底约 4.22:1，只作非必要辅助或装饰，不承载小号必要文字。`line` 是静态分隔，不单独承担需要辨认的输入边界。本轮只支持浅色；系统强制颜色下保留可见焦点和原生可操作性。

## Typography

品牌、标题、正文与数字统一使用系统无衬线字体：Apple系统字体、Segoe UI、Microsoft YaHei及sans-serif回退；数值使用tabular-nums保持稳定。不使用宋体展示字或装饰字距，不依赖远程字体。

正文 16–18px，辅助小字至少 12px，关键状态和主动作优先使用正文级字号；标题通过 22px 及以上字号、字重与留白形成层级。中文自然换行，保持约 1.5–1.7 行高，不以细字重或很浅的灰字表达必要信息。

不把桌面上的手机页面整体缩小后宣称满足字号。金额、周期、剩余次数、下次可操作时间和计量单位靠近，数字变化不导致按钮跳动。长地址摘要与状态允许换行。

## Layout

移动内容最大宽度 480px，桌面居中呈现同一个竖版页面。以手机任务为主，不保留旧三变体、周围方案比较卡片或额外后台面板。

底部五入口为“我的农场／商城／主页／实景／我的”。中央主页以66px列宽、66px高的蓝色按钮突出，其余保留14px文字、图标和至少48px触控区；320px也不通过缩小页面解决拥挤。我的农场保留农田／牧场切换，商城前置三分类与推荐；主页聚合签到与社交，旧活动页保持独立子页。原福利和订单从所属入口仍可到达。

本轮组合层级由 `expansion.css` 拥有：商城使用横幅、分类、商品与购物车摘要；活动使用签到主卡、任务列表、三枚印章和成就；农场／我的用等级、每日农事和仓库摘要串联。每组信息先有标题和一项主要动作，再展开说明，不把所有系统挤进首屏。金币和积分为可读数值，不以持续飘动吸引注意。

一屏有一个主要动作；卡片采用大图＋名称＋必要状态，详情再展开周期、收益示例与限制。触控区至少 48×48px，图标本体可以更小。布局保留底部安全区和导航空间，滚动拥有者明确；长页可到末尾，短屏模态操作始终可达。

## Elevation & Depth

第三轮打磨保留同一视觉方向：农场场景底部显示当前种养对象与“查看照料／查看收获”，快捷入口移到照料卡之后。商城有车时使用滚动区之外的独立摘要行，不用浮层覆盖商品；活动顶部集中签到、待领任务与好友福利。完整兑换记录采用同族白卡、大字明细与分隔线，日期只展示保存的北京时间日期。必要的任务说明与照料原因提升至14–16px。新增布局只消费原有token；减少动态效果规则仍统一生效。

通过浅底、白色表面、留白和分隔建立层级。轻阴影仅服务固定导航和浮层，卡片不叠加厚重阴影。模态遮罩突出当前任务；等待回执和错误保留在对应面板，不靠短暂提示代替。

## Shapes

容器柔和圆角，控件轮廓清楚，实际数值统一归属共享 CSS。农田田垄与牧场分区形成空间感；猪第一视角用镜头位置与画面构图表达，不用夸张幼态角色表现。所有可见场景、作物、动物与积分物资使用摄影风格AI图，明确示意性质，不冒充实拍或真实直播；操作与状态图标保持SVG。

## Components

### Foundational visual states

交互包含默认、hover、focus-visible、pressed、selected、disabled、busy；状态有中文解释。限制按钮显示剩余次数、间隔或忙碌原因。反馈不改变控件尺寸，不把等待设备回执画成已完成照料。

### Buttons and actions

主操作蓝色实底，次操作弱底或轮廓；高影响确认列明对象与结果。停止动作可辨但不与启动混用。认养、收获、邮寄、领取福利用明确动词；在不满足资格时不只把按钮变灰，旁边给出原因。

### Navigation and data display

导航采用同一 SVG 家族＋中文文字。农作物和牲畜卡片都说明当前状态；推荐位置和徽标前置。原认养示例金额与新增积分价分开标单位；购物车同时显示数量、库存、优惠前小计、积分券和应付积分。任务与成就区分“未完成／可领取／已领取”，不能只靠颜色；签到七日格和印章是状态，领取按钮仍有完整标签与至少 48px 触控区。

用户本轮明确改为写实摄影方向。场景、商品与season／shop／activity横幅统一为25张内置image_gen原创照片风格示意。prototype/assets/photos是canonical，WebP仅作等比压缩，来源/提示词/hash见assets/ASSET-SOURCES及manifest。photography.css消费原token，照片按容器cover裁切、预留尺寸；横幅深色遮罩配白字，图片来源用可见文字。HTML保留所有标题、按钮与规则。移动端12图由tools/sync-photo-assets.mjs同步并核对，移除旧文字商品占位及旧插画副本。

第四轮组合层由 `shop-refinement.css` 与 `activity-refinement.css` 消费相同 token。活动横幅收紧到约 140px，让320px手机首屏能看到主要领取按钮；单一动态引导按当前可领取状态推荐下一步，最近到账用细金色边线强调。活动明细采用按日排列的白纸收据，积分、物资、券分项展示；仅用已有短促入场过渡，继续服从全局减少动态效果规则。商品排序用大触控按钮组，商品列表和详情共享可加额度与禁用语言；不另造色板或钱包。

第五轮 `experience.css` 继续消费同一组token，增加商品搜索、四种筛选、心愿与攒分目标。心愿卡以细金色边线、商品图和同一余额进度连接商城与活动，进度不代表库存或自动兑换。七日签到改为四列双排，末日积分券占双列；320px每格仍超过48px，可点开完整奖励。任务筛选显示文字、数量与选中边界。新增按压、入场和进度过渡在减少动态效果下关闭，不加入自动轮播或漂浮金币。商品说明提升为14px，查询与差额使用正文级字号。

仓库、等级、图鉴、消息和每日农事使用同一内容表面及数字语言。优先呈现资源数量、来源、进度和下一步，已读／未读或已发现／未解锁同时有文字。收益、周期、价格、传感器值和配送进展继续标注示例或模拟；不引入密集后台表格。

### Forms and overlays

原生 `dialog` 是唯一模态归属，详情、设备、广告、购物车、积分结算、资源、活动和收货信息复用同一开关、层级与焦点规则；`expansion.js` 复用原 frame，不另建模态。数量加减有明确名称、可见数量与库存边界；优惠券显示门槛和已用状态。失败仍能在原结算上下文修正，成功后去向明确。

原生输入带 label；示例邮寄保留大输入区和中文校验，仅保存脱敏摘要。仓库与活动弹层不泄露原始邮寄数据；不把地址全文塞进卡片、URL 或 toast。

### Iconography

统一内联 SVG、描边和视觉尺寸。底部入口保留文字，图标按钮有中文名称和至少 48px 触控区。装饰图形对读屏隐藏；不混用 emoji 充当必要操作图标。

### Motion

仅用短促的选中、浮层和状态过渡。活动达成可以短暂提示，不做转盘、老虎机、低幼金币漂浮或自动轮播。广告观看进度按真实模拟播放时长推进，提前关闭不展示完成；设备执行动效由模拟回执驱动。`prefers-reduced-motion: reduce` 下移除非必要动态，保留文字进度和状态。

### Content and data visualization

口吻清楚、成熟、亲切，先说对象、现状、下一步。统一使用“农田／牧场”“商城”“当季认养／农场物资／积分好礼”“活动”“浇水／投喂”“等待设备回执”“未确认启动”“邮寄信息”等词。积分券写明“积分”而非现金券；活动奖励不暗示可绕过农事限制，牲畜实体收货明确是工作人员处理后的产品。

## Do's and Don'ts

- **Do:** 用大图、大字和清楚动作帮助用户辨认自己的农作物与牲畜。
- **Do:** 推荐理由、限制原因、模拟标识和收货状态在相关位置持续可见。
- **Don't:** 缩小手机视图、把必要字降到 12px 以下，或用低对比金色小字。
- **Don't:** 把演示视频、邀请、设备回执、农时、收益或物流写成真实已发生。

## 跨端运行时适配与共享控件（2026-10-27）

正式工程位于 `apps/mobile`。`prototype/styles.css`继续拥有canonical视觉token，`tools/sync-mobile-tokens.mjs`生成`src/styles/tokens.css`，通过`--check`阻止第二套色板漂移。新客户端CSS组合样式不反向覆盖原H5演示。

`FarmButton`拥有跨端按钮行为：H5用真正原生HTML button处理Enter/Space，防重复和忙碌后焦点恢复；非H5保留平台button并显式传递原生属性（小程序不支持对象v-bind展开）。FarmNavigation在H5和微信/抖音提供13–14px、至少48px控件的共享五入口；App使用明确配置14px/64px的平台tabBar。微信/抖音原生tabBar不能通过fontSize改大，因此按官方hideTabBar+switchTab模式使用页面导航；真实切页闪烁、安全区和层级仍待真机验收。FarmScreen统一状态、错误、未登录、未知操作核对与数据不可用，不用零值掩盖缺失Snapshot。

购物车确认区在完整明细后正常文档流呈现，核对/返回/成功都有明确焦点目标；不能用浮动按钮遮挡优惠券或金额。API响应完整性和账户代际由core客户端处理，属于行为约束，不在屏幕里复制。真实软键盘、系统字体缩放及屏幕阅读器仍须真机验收。

账户隐私在“我的”页使用同一纸色panel与16px正文。注销先查阅数据类别、核对账户和资产，再进入文档流内确认区；默认焦点落安全返回，取消恢复原入口。危险动作使用既有danger token的轮廓／实底语义，不扩展第二套颜色。未知注销复用FarmScreen持续状态和核对按钮，不能用短暂toast冒充已删除。

账户农场档案继续使用FarmScreen/FarmButton与canonical tokens，列表和详情保持16px正文、48px动作与纸色panel。状态文字解释待开始/生长/待农场安排收获/归档，日期及缺失值可读；测量与观测时间线保留实际时间，不用插画冒充现场。详情归属底部“我的农场”，返回保留列表分类与已加载项。更多观测使用明确按钮，无自动滚动；资料更新时保留一致记录或有界刷新首屏。

跨端完整兑换记录、原值收据及当前仓库沿用相同纸色panel、16px正文与48px动作，归属“我的”。FarmGoodsPhoto复用商城八种照片白名单，微信组件以virtualHost及共享样式保持同源列宽；图片失败显示文字并预留几何空间。历史日期只有日历日期，发放与当前库存分区说明；读取中和读取失败保持合法旧内容，不用0伪装未知余额。详情返回保留列表，重复进入历史/仓库复用既有页面栈。

## 田园会客厅与社交（2026-10-27）

用户2026-10-27明确更名“合耕小舍”，要求减少AI模板感并参考QQ。当前采用手机QQ式简洁社交方向：系统无衬线、蓝白灰色系、12px默认圆角；去除英文眉题、错位票券和大面积暗色营销横幅。主页由身份行、小幅田园照片、单行签到、四个快捷入口与农友动态组成；好友使用普通列表。中央主页保持较大48px以上触控区，仅保留轻微抬升；照片/少数对象卡允许局部非对称轮廓，不复制QQ商标或企鹅素材。social.css拥有社交组合，styles.css继续拥有canonical token，移动token由工具生成。普通控件至少48px、主动作至少56px；320px自然换行。

示例头像使用作物照片与昵称，不冒充真人。模拟属性持续可见；圈子加入/点赞用文字+选中边界，好友区分申请/已友/已屏蔽，不用虚假在线人数、未读红点或收益诱导。表单复用原dialog、label、错误与焦点恢复，中文输入期间合并重绘。手机H5/微信抖音共享中央大主页样式；App此轮仅改原生底栏名称，凸起与真实社交需另验。

视觉参考：腾讯ISUX《设计故事｜QQ9轻松做自己》https://cloud.tencent.com/developer/news/1288723 （2024设计原则）；具体颜色、尺寸及适老约束以本项目token为准，不视作QQ官方参数。
