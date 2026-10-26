# 禾间农场 · 竖版 H5 Demo

面向 30–50 岁及中老年用户的农场体验演示：认养农作物与牲畜、远程照料、看农田与牧场、参加福利，再体验收获到家。

- 部署地址：[打开禾间 Demo](https://wthpein010-dev.github.io/hejian-farm-demo/)（部署与线上验收状态见[验收记录](docs/VERIFICATION.md)）。
- 公开源代码：[wthpein010-dev/hejian-farm-demo](https://github.com/wthpein010-dev/hejian-farm-demo)。

这是 H5 网页，后续可探索微信、抖音小程序；当前不代表小程序已接入 SDK、通过审核或上架。

## 可以体验什么

- **我的农场：** 切换农田／牧场，查看作物与牲畜，按次数和间隔照料。
- **认养优选：** 前置当季推荐，比较周期、示例价格和收获参考价值，体验认养与工作人员安排。
- **实景：** 切换农田、牧场和猪第一视角的演示镜头。
- **农场商城：** 当季认养、8种积分物资与好礼、购物车、数量限购、优惠券和积分结算。
- **田园活动：** 七日签到、每日农事、丰收集章、成长成就，配合原有广告与邀请福利。
- **田园资产：** 仓库取用、累计收获、成长等级、种养图鉴和农场消息；所有界面共用同一钱包。
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

## 验证与部署

```sh
node --test
node --check prototype/app.js
node --check prototype/ui.js
node --check prototype/domain.js
node --check prototype/systems.js
node --check prototype/expansion.js
```

[Pages 工作流](.github/workflows/pages.yml) 在 `main` 推送或手动触发后，使用 Node.js 22 执行测试及语法检查，再将 `prototype/` 直接部署为 GitHub Pages；没有安装依赖或构建步骤。仓库 Pages 来源需配置为 GitHub Actions。

本地检查、浏览器体验和实际部署结果分开记录，详见[验收记录](docs/VERIFICATION.md)。

## 项目文档

[产品说明](docs/PRODUCT.md) · [验收记录](docs/VERIFICATION.md) · [演示操作说明](prototype/README.md) · [视觉约定](DESIGN.md) · [交互约定](UX-CONTRACT.md)
