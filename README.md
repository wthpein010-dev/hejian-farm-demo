# 合耕小舍 · 竖版 H5 Demo

> 正式App／微信／抖音小程序工程正在推进，尚未达到全量上线验收。新增 `apps/mobile` 跨端客户端与 `services/api` 持久账户/资产服务；现有公开Pages仍是 `prototype/` H5演示。两者验证边界见[上线矩阵](docs/release/READINESS.md)，不能把演示发布或跨端编译写成正式上架。

跨端本地开发（Node≥24.15）：先按[服务端说明](services/api/README.md)启动明确的本机沙盒，再运行 `npm ci --ignore-scripts` 及根 `npm run dev:mobile`。客户端公开配置与构建说明见[移动工程](apps/mobile/README.md)。真实平台AppID／后端HTTPS域名、签名和设备联调仍待配置。

跨端“我的”页已补[账户数据查阅与确认注销](docs/release/ACCOUNT-PRIVACY.md)，服务端另提供[SQLite在线备份与隔离恢复](services/api/BACKUP.md)。[持久农友](docs/release/FRIENDS.md)的切片证据见[农友验收](docs/release/FRIENDS-VERIFICATION.md)；这些账户功能位于跨端工程与API，生产仍关闭，公开Pages继续提供内存H5演示。

跨端新增[论坛帖子/评论预审](docs/release/FORUM.md)，包括举报、屏蔽、作者撤回和本机私有审核闭环；schema7与旧备份兼容，草稿、跨域缓存和原key恢复经回归。本轮本机684项：682通过、0失败、2既有Windows平台跳过，四端资源构建通过；详见[论坛验收](docs/release/FORUM-VERIFICATION.md)。完整工程进展见[上线证据](docs/release/PROGRESS.md)，生产社区与平台上架尚未完成。

面向 30–50 岁及中老年用户的农场体验演示：认养农作物与牲畜、远程照料、看农田与牧场、参加福利，再体验收获到家。

- 部署地址：[打开合耕小舍 Demo](https://wthpein010-dev.github.io/hejian-farm-demo/)（部署与线上验收状态见[验收记录](docs/VERIFICATION.md)）。
- 公开源代码：[wthpein010-dev/hejian-farm-demo](https://github.com/wthpein010-dev/hejian-farm-demo)。

这是 H5 网页，后续可探索微信、抖音小程序；当前不代表小程序已接入 SDK、通过审核或上架。

## 可以体验什么

- **我的农场：** 切换农田／牧场，查看作物与牲畜，按次数和间隔照料。
- **认养优选：** 前置当季推荐，比较周期、示例价格和收获参考价值，体验认养与工作人员安排。
- **实景：** 切换农田、牧场和猪第一视角的演示镜头。
- **农场商城：** 当季认养、8种积分物资与好礼、购物车、数量限购、优惠券和积分结算。
- **田园活动：** 七日签到、每日农事、丰收集章、成长成就，配合原有广告与邀请福利。
- **田园会客厅：** 中央主页大按钮、照片封面与异形布局，融合签到、论坛圈子、动态评论、示例好友和照片分享卡；互动刷新重置。
- **田园资产：** 仓库取用、累计收获、成长等级、种养图鉴和农场消息；所有界面共用同一钱包。
- **本轮体验打磨：** 场景直达照料、购物车常驻摘要、活动奖励速览、优惠券按来源返回、完整积分兑换记录；浏览器前进／后退保留返回上下文。
- **商城与活动第四轮：** 积分排序、详情限购同步、物资去向；按当前状态引导下一步、活动说明、最近到账与按日奖励明细。保留大字、48px按钮及照料次数与间隔。
- **收获到家：** 预约采收或工作人员处理，填写示例邮寄信息，查看脱敏摘要与模拟配送进展。

页面采用成熟竖版、大图与清楚文字；手机内容最大宽度 480px，桌面居中展示同一页面。

## 模拟边界

设备、视频、支付、身份、广告、邀请归因、工作人员任务和物流均未连接真实服务。商品、农时、周期、产量、收益、次数和间隔是 Demo 样本，不是实际农场规则或收益承诺。公开链接分享／复制可以实际使用，分享成功不等于产生有效拉新。

设备只有收到模拟回执后才显示执行；无回执会保留未确认状态。奖励不能绕过浇水／投喂限制。

邮寄请只填示例信息。原始输入不外发、不进入 storage、URL 或日志，确认后只在当前页面内存保存脱敏摘要。刷新清空演示状态，不代表对真实设备执行停止。

## 本地运行

在项目根目录运行：

```sh
python prototype/serve.py
```

打开 [http://127.0.0.1:4173/](http://127.0.0.1:4173/)，按 `Ctrl+C` 结束服务。无需安装前端依赖，也不需要账户或 API Key。

## 跨端依赖校验

移动工程需要 Node≥24.15。依赖修补由根锁文件、版本与哈希校验脚本统一维护：

```sh
npm ci --ignore-scripts
npm run verify:dependencies
npm run typecheck
npm run build:h5
npm run build:weixin
npm run build:douyin
npm run build:app
npm audit --json
```

普通 `npm ci` 会执行适配脚本；即使用 `--ignore-scripts`，移动 dev／build 前置步骤仍会核查。不要手工跳过版本或哈希失败，也不要运行 `npm audit fix --force`。当前 Vite 存在明确记录的上游 peer 例外，`npm ls` 的非零结果不能写成全绿；具体版本、四端验证、i18n／图片识别适配与 SSR 边界见[依赖修补说明](docs/release/DEPENDENCIES.md)。App 构建资源仍须真实渠道配置、签名、原生联调与平台验收。

## 验证与部署

```sh
node --test
node --check prototype/app.js
node --check prototype/ui.js
node --check prototype/domain.js
node --check prototype/systems.js
node --check prototype/expansion.js
```

[Pages 工作流](.github/workflows/pages.yml) 在 `main` 推送或手动触发后，使用 Node.js 24.15.0 执行测试与语法检查；独立任务按锁文件安装移动工程依赖，校验适配与已知漏洞、类型和视觉 token，再实际编译 H5、微信、抖音及 App 离线资源。两组验证全部成功后，将 `prototype/` 部署为 GitHub Pages；未签名的跨端资源另存为工作流附件。仓库 Pages 来源需配置为 GitHub Actions。

本地检查、浏览器体验和实际部署结果分开记录，详见[验收记录](docs/VERIFICATION.md)。

## 项目文档

[产品说明](docs/PRODUCT.md) · [验收记录](docs/VERIFICATION.md) · [演示操作说明](prototype/README.md) · [视觉约定](DESIGN.md) · [交互约定](UX-CONTRACT.md)

## 账户农场档案

跨端客户端与API增加[归属档案与观测接入](docs/release/FARM-RECORDS.md)：账户鉴权列表/详情、分页历史、私有原子导入、注销与schema5备份恢复。当前证据来自临时合成账户，尚未接入真实工作人员/设备；公开Pages仍是原型演示。
