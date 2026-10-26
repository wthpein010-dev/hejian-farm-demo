---
version: alpha
name: "禾间 · 竖版农场 H5 Demo"
description: "面向中年及中老年用户的真实农场种养体验提案，以大图大字连接农田、牧场、照料和实体收获。"
status: "产品方向已确认；Demo 视觉与参数待验证"
updated: "2026-10-27"
colors:
  canvas: "#f4f6f2"
  paper: "#ffffff"
  ink: "#1d3329"
  secondary: "#596c60"
  primary: "#244d3d"
  brand-soft: "#e8eee5"
  accent: "#b98c4b"
  line: "#dfe6dd"
  danger: "#9e4536"
  warning: "#7d5927"
  focus: "#3b7756"
  muted: "#78857d"
  scroll-thumb: "#a5b5a7"
  scroll-hover: "#708b77"
typography:
  display:
    fontFamily: '"STZhongsong", "SimSun", "Microsoft YaHei", serif'
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
  numeric:
    fontFamily: '"Consolas", monospace'
rounded:
  DEFAULT: "18px"
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

# 禾间 Design System

## Overview

### Creative North Star

像一家认真经营的农场寄来的种养手册：看得清的田和牲畜、看得懂的种养进展、清楚的照料与收货步骤。画面表达田野的真实感和收获感，操作保留成熟、稳妥的服务工具感。

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

浅田野底色、白纸表面、浓绿色主操作和深色文字传达成熟稳妥。金色对应成熟与收获，只作有限强调。农田、牧场、商店、福利和邮寄使用同一语义。

必要文字用 `ink` 或 `secondary`。白字在 `brand` 上约 9.53:1；`secondary` 在白／canvas／brand-soft 上分别约 5.62:1、5.17:1、4.76:1，可用于这些表面的普通字号必要信息。

`ink` 在 `accent` 上约 4.44:1，白字在 `accent` 上约 3.04:1，均不作为普通字号文字组合。金色用作装饰、边线或无文字图形；推荐徽标文字用 `ink` 放在 `paper`／`brand-soft` 上。若新增金底文字方案，须先定义并检查更深的文字色。

状态同时提供文字和图标，不能只靠绿／灰／红区分。`muted` 在白底约 3.85:1，只作非必要辅助或装饰，不承载小号必要文字。`line` 是静态分隔，不单独承担需要辨认的输入边界。本轮只支持浅色；系统强制颜色下保留可见焦点和原生可操作性。

## Typography

品牌与少量展示标题可用系统 `STZhongsong`／`SimSun`，回退到 `Microsoft YaHei`。正文以 `Segoe UI`、`Microsoft YaHei`、sans-serif 保证中文可读；数字使用等宽字体或等宽数字。使用系统字体，不依赖远程下载。

正文 16–18px，辅助小字至少 12px，关键状态和主动作优先使用正文级字号；标题通过 22px 及以上字号、字重与留白形成层级。中文自然换行，保持约 1.5–1.7 行高，不以细字重或很浅的灰字表达必要信息。

不把桌面上的手机页面整体缩小后宣称满足字号。金额、周期、剩余次数、下次可操作时间和计量单位靠近，数字变化不导致按钮跳动。长地址摘要与状态允许换行。

## Layout

移动内容最大宽度 480px，桌面居中呈现同一个竖版页面。以手机任务为主，不保留旧三变体、周围方案比较卡片或额外后台面板。

底部四入口为“我的农场／认养优选／实景／我的”。首页农田／牧场切换清晰可达；福利在右上和／或“我的”。推荐商品位于认养列表前部，徽标在图片或标题附近立即可见。

一屏有一个主要动作；卡片采用大图＋名称＋必要状态，详情再展开周期、收益示例与限制。触控区至少 48×48px，图标本体可以更小。布局保留底部安全区和导航空间，滚动拥有者明确；长页可到末尾，短屏模态操作始终可达。

## Elevation & Depth

通过浅底、白色表面、留白和分隔建立层级。轻阴影仅服务固定导航和浮层，卡片不叠加厚重阴影。模态遮罩突出当前任务；等待回执和错误保留在对应面板，不靠短暂提示代替。

## Shapes

容器柔和圆角，控件轮廓清楚，实际数值统一归属共享 CSS。农田田垄与牧场分区形成空间感；猪第一视角用镜头位置与画面构图表达，不用夸张幼态角色表现。照片或插画始终明确演示性质，不冒充真实直播。

## Components

### Foundational visual states

交互包含默认、hover、focus-visible、pressed、selected、disabled、busy；状态有中文解释。限制按钮显示剩余次数、间隔或忙碌原因。反馈不改变控件尺寸，不把等待设备回执画成已完成照料。

### Buttons and actions

主操作绿色实底，次操作弱底或轮廓；高影响确认列明对象与结果。停止动作可辨但不与启动混用。认养、收获、邮寄、领取福利用明确动词；在不满足资格时不只把按钮变灰，旁边给出原因。

### Navigation and data display

导航采用同一 SVG 家族＋中文文字。农作物和牲畜卡片都说明当前状态；推荐位置和徽标前置。收益、周期、价格、传感器值和配送进展标注示例或模拟。固定小量演示数据，不引入后台表格。

### Forms and overlays

原生 `dialog` 是唯一模态归属，详情、设备、广告演示、收货信息使用同一开关、层级和焦点规则。原生输入带 label；示例邮寄有大输入区、中文校验及示例填充。只保留脱敏摘要，不把地址全文塞进卡片、URL 或 toast。

### Iconography

统一内联 SVG、描边和视觉尺寸。底部入口保留文字，图标按钮有中文名称和至少 48px 触控区。装饰图形对读屏隐藏；不混用 emoji 充当必要操作图标。

### Motion

仅用短促的选中、浮层和状态过渡。广告观看进度按真实模拟播放时长推进，提前关闭不展示完成。设备执行动效由模拟回执驱动。`prefers-reduced-motion: reduce` 下移除非必要动态，保留文字进度和状态。

### Content and data visualization

口吻清楚、成熟、亲切，先说对象、现状、下一步。统一使用“农田／牧场”“认养优选”“浇水／投喂”“等待设备回执”“未确认启动”“邮寄信息”等词。奖励不暗示可绕过农事限制；牲畜实体收货明确是工作人员处理后的产品。

## Do's and Don'ts

- **Do:** 用大图、大字和清楚动作帮助用户辨认自己的农作物与牲畜。
- **Do:** 推荐理由、限制原因、模拟标识和收货状态在相关位置持续可见。
- **Don't:** 缩小手机视图、把必要字降到 12px 以下，或用低对比金色小字。
- **Don't:** 把演示视频、邀请、设备回执、农时、收益或物流写成真实已发生。
