# 写实摄影风格素材来源

日期：2026-10-27；依据：用户要求全部可见场景和对象图改为实景／写实照片风格。

当前25张图均由 **OpenAI内置image_gen独立生成并视检**，不是SVG渲染、图库照片、用户农场实拍或真实监控。未使用外部图库，未声称具体未返回的模型版本。界面保留“AI生成／非实拍／非直播”标记；经营、库存和设备模拟边界不因照片变化而改变。

| 类别 | photos/中的文件 | 内容 |
|---|---|---|
| 场景3张 | farm-estate、livestock、pig-pov | 菜田温室、黑猪圈舍、猪第一视角 |
| 横幅3张 | shop-banner、activity-banner、season-banner | 农产品篮、萝卜鸡蛋收获、成长田野 |
| 作物及收获8张 | tomato、carrot、lettuce、radish、onion、bokchoy、egg、empty | 对应农产品、鸡蛋和翻整土畦，上海青与奶油生菜分开 |
| 动物3张 | pig、goat、chicken | 黑猪、山羊、土鸡，正常体态与农场环境 |
| 积分商品8张 | feed、fertilizer、tools、seed、sign、frame、bundle、gift | 饲料、肥料、工具、种子、木牌、相框、照料组合及物资礼盒；不代表真实库存 |

完整提示词、实际尺寸、网络字节数和SHA256见[photos/manifest.json](photos/manifest.json)。内置原图保存在本机生成目录，原始PNG和含本机路径的过程记录不发布。仅等比缩小并编码WebP，未拼接、绘图或修改图像内容。场景／横幅960px宽，对象640px宽，25张共2,676,924字节。

`prototype/assets/photos/`是照片唯一归属。`tools/sync-photo-assets.mjs`为移动端同步实际使用的12张图（共1,257,698字节），`--check`核对来源和副本摘要；不手改第二套照片。操作、导航和状态SVG图标继续保留。

此前SVG场景及旧WebP仅作历史源文件留存，当前页面不引用；移动端根目录3张旧插画已移除。旧网关尝试未成功，不能用此前的generation-prompts.jsonl证明旧插画是模型生成照片。

新版video/walkthrough.mp4及封面来自六张实际摄影版H5截图，每张4秒，共24秒；是静态截图讲解，非连续实机录屏、非农场直播。
