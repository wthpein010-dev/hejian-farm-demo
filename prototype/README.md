# 禾间 · 竖版农场 H5 Demo

面向 30–50 岁及中老年用户的手机竖版体验：认养农作物和牲畜、查看农田与牧场、按限制照料、看现场、参加福利，再体验实体产物收货。产品方向已确认，具体价格、周期、收益、次数和间隔均为 Demo 样本。

## 本地启动

在项目根目录运行：

```powershell
python prototype/serve.py
```

打开 [禾间本地 Demo](http://127.0.0.1:4173/)，按 `Ctrl+C` 结束服务。无需前端依赖或登录。当前为单一成熟竖版方向，不再提供旧三种首页链接。

## 体验路线

1. 在“我的农场”切换农田／牧场，查看自己的农作物、牲畜和生长状态。
2. 进入“认养优选”，查看前置推荐徽标、时令理由、周期、示例收获／收益，再完成一次模拟认养。
3. 体验浇水和投喂，查看剩余次数、间隔和忙碌原因；在设备面板体验在线、离线和无回执。
4. 打开“实景”，切换农田、牧场和猪第一视角的演示镜头。
5. 从右上或“我的”进入福利，分享／复制真实 H5 链接，体验完整观看才可领取的模拟广告和模拟邀请资格。
6. 选择成熟对象，预约采收或工作人员处理，再使用示例邮寄信息查看脱敏摘要和模拟配送进展。

## 数据与模拟边界

设备、摄像头、工作人员任务、商品金额、产量／收益、广告、邀请、订单与物流均为模拟。只有实际 H5 URL 的公开访问、系统分享或复制可真实使用；分享成功不代表产生有效拉新。

灌溉须收到模拟回执后才开始计时；无回执不显示成功、不自动重试、不增加湿度。浇水和投喂有 Demo 次数及间隔，福利不能绕过这些限制。

邮寄请只用示例信息。原始输入不外发、不进 storage、URL 或日志，确认后只在内存留下脱敏摘要。业务状态只在当前页面内存保存，刷新会重置；这不代表对真实设备执行停止。

## 独立发布

部署地址：[打开禾间 H5 Demo](https://wthpein010-dev.github.io/hejian-farm-demo/)。公开源码：[wthpein010-dev/hejian-farm-demo](https://github.com/wthpein010-dev/hejian-farm-demo)。

部署与线上验收状态见[验收记录](https://github.com/wthpein010-dev/hejian-farm-demo/blob/main/docs/VERIFICATION.md)；此处不预先宣称发布成功。页面使用相对资源，需在独立 Pages 项目路径检查首页、资源、刷新和主要交互。

当前交付是 H5 网页。微信／抖音小程序 SDK、平台构建、广告接入、审核与上架另行验收，不能将 H5 分享链接描述成已上架的小程序。

## 开发入口

vanilla HTML／CSS／JavaScript；`domain.js` 管理领域规则，`ui.js` 提供共享 SVG，`app.js` 管理界面和内存状态，`styles.css` 拥有运行时视觉 token，Python 仅提供本地静态服务。

[项目首页](https://github.com/wthpein010-dev/hejian-farm-demo) · [产品说明](https://github.com/wthpein010-dev/hejian-farm-demo/blob/main/docs/PRODUCT.md) · [验收记录](https://github.com/wthpein010-dev/hejian-farm-demo/blob/main/docs/VERIFICATION.md) · [视觉约定](https://github.com/wthpein010-dev/hejian-farm-demo/blob/main/DESIGN.md) · [交互契约](https://github.com/wthpein010-dev/hejian-farm-demo/blob/main/UX-CONTRACT.md)

真实农时、养殖与处理、硬件协议、安全隔离、费用、支付、平台 SDK、视频权限、地址保存和物流仍待生产阶段核定，详见产品说明的未决项。
