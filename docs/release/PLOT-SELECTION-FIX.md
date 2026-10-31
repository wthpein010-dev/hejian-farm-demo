# 农场图片点击闪动修复 · 0.1.2

2026-10-31，用户反馈我的农场点击地块图片会闪。已在专属MuMu Android15复现、修复并安装0.1.2/versionCode3。

原按钮每次选择都会调用整页Render，销毁ScrollRect、场景与照片，下一帧才恢复滚动。实际录屏中番茄、胡萝卜、横幅同步向下跳382个录屏像素，下一帧返回；不是照片替换，也没有整屏纯白。

现在选择只更新地块/牲畜高亮和同一个照料面板内的文字与动作，保留viewport、content、场景、全部照片及地块/牲畜卡片按钮；照料子项按当前对象更新。同一对象重复点击不刷新；内容高度改变时同步重排并保留原像素位置，只在超过新的底部边界时钳制。照料动作绑定当前对象，资产、照料次数与设备规则不变。

## 验证

- 新增农田、牧场两项真实Button点击/跨帧回归，原代码均在“ScrollRect被替换”处失败；修复后12项编辑器回归全部通过，7页文字/字体/触控检查无问题。
- 43项领域规则再次通过；实际Unity Android构建正常退出，v2签名验证通过。
- MuMu实际安装、设备base.apk摘要核对一致。中段连续切换10次，胡萝卜/鸡的照料信息及档案对象正确；选择没有改变80积分或6份饲料。本次应用日志采样128行，Unity错误、Fatal、托管及引擎裁剪错误均为0。
- 同样操作的8秒ADB录屏：原版462原始帧中10次单帧同步位移；修正版479原始帧中0次，三照片全部匹配、0未知帧，并识别到10次有效高亮切换。两个视频初始位置相差11录屏像素，分别校准后比较。录屏帧率不当作游戏性能指标，也不推广为所有手机或低于采样间隔的保证。

[逐帧判据和视频摘要](../../unity/Documentation/plot-selection/portable-video-comparison.json) · [真实连续帧对比](../../unity/Documentation/plot-selection/recording-comparison.png) · [胡萝卜照料](../../unity/Documentation/plot-selection/selected-carrot-care.png) · [鸡的照料](../../unity/Documentation/plot-selection/selected-chicken-care.png)。原始录屏留本机，公开材料不含设备地址或个人资料。

最终APK71,450,412字节，SHA256 `3d8758cda68caec50b0423f3606533ced77b23b5f2457d90c867e72dcd32b433`。应用在MuMu我的农场保持运行。仍为离线体验，真实ARM手机、生产微信/设备/履约另验；原跨端依赖审计阻断状态不因本次Unity修复改变。
