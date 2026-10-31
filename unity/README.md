# 合耕小舍 · Unity 安卓体验版

Unity 2022.3.62f3c1 / 原生 C# 与 UGUI，离线竖屏。包名 `com.hegeng.xiaoshe.demo`，版本 `0.1.0`，Android 7.0 / API24 起，目标 API34，IL2CPP ARM64 与 ARMv7。仅提供本地体验签名，不是正式上架包。

直接用Unity打开本目录并进入Play模式即可体验。编辑器菜单“合耕小舍 → 构建安卓体验包”可选择APK输出位置；命令行可复现构建见下文。当前默认使用旧Input Manager，UGUI按钮与输入不依赖新版Input System。

所有农场数值、设备、实景、广告、邀请、社区和配送都是演示。25张摄影示意为既有AI生成图片，不是农场实拍或直播。状态仅保留在本次进程内，不连接账户、微信、支付或生产服务。

## 资源准备

在仓库根执行（Python 3，Pillow）：

```powershell
python tools/prepare-unity.py
python tools/prepare-unity.py --check
```

照片单一来源为 `prototype/assets/photos/manifest.json` 中的25张WebP。工具先核实源SHA256和尺寸，保持尺寸转换为RGB JPEG（quality90、subsampling0）；`Assets/Resources/Photos/manifest.json` 记录源及衍生文件的SHA256、字节与转换参数，完整生成prompt仍归原manifest。JSON清单指纹按Git统一的UTF-8/LF计算，Windows CRLF与导出工程能得到同一结果；25张照片仍核对原始二进制摘要。工具不生成新图片。

字体仅复制本机已明确授权的 `D:/app/RingHaven/Assets/Resources/Fonts/NotoSansCJKsc.otf` 和同目录 `NotoSansCJKsc-LICENSE.txt`；不读取该项目其他文件。副本与OFL许可证一起交付，摘要见 `Assets/Resources/Fonts/provenance.json`。已有资源的 `--check` 不依赖外部字体目录，其他电脑可直接验收仓库中的副本。

运行时使用 `Resources.Load<Sprite>("Photos/farm-estate")` 等原25个资源key和 `Resources.Load<Font>("Fonts/NotoSansCJKsc")`。Editor构建统一设置照片Sprite导入参数，避免重复占有图像配置。

颜色源为原H5的canonical CSS，更新时先运行 `node tools/sync-unity-theme.mjs`，验收运行同命令加`--check`；不要手改FarmTheme.cs。

## 界面证据

[主页](Documentation/screenshots/home.png)、[农场](Documentation/screenshots/farm.png)、[商城](Documentation/screenshots/shop.png)、[我的](Documentation/screenshots/profile.png)为本轮实际Unity Editor PlayMode的432×900截图，不是安卓真机截图。`Documentation/preview-report.json`记录7页和7项操作回归，全数通过；不把编辑器证据当作Android安装验收。

## 构建

```powershell
# 只验证资源与同步源文件，不启动 Unity：
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-unity.ps1 -PrepareOnly

# 正式发起本地体验APK构建：
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-unity.ps1
```

工具使用已安装的 `D:/unity/2022.3.62f3c1/Editor/Unity.exe` 及其内置Android SDK/NDK/JDK/Gradle，不改全局PATH、工具偏好或许可。构建进程单独设置TEMP、TMP、GRADLE_USER_HOME和Android/JDK环境变量。首次包解析或构建可能下载Unity包/Gradle依赖；构建需要有效Unity许可。

工作目录固定为 `D:/farm-unity-build`。首次创建所有权marker，已存在的未知目录、其他checkout的marker和链接均拒绝操作。仅将本仓库 `unity/Assets`、`Packages`、`ProjectSettings` 同步到 `D:/farm-unity-build/project`；这些副本由源码覆盖，不在其中手改。Library、临时文件、Gradle缓存、日志和输出均留D盘。构建互斥锁与现场Unity进程检查阻止并发覆盖；脚本不结束任何已有进程。

Editor入口 `FarmBuild.BuildAndroid` 先调用 `Hegeng.FarmChecks.RunAll()`，再设置包名/方向/架构，创建空 `Assets/Scenes/Farm.unity` 并打包；运行时由 `FarmApp` 的 `RuntimeInitializeOnLoadMethod` 启动。检查失败或APK非新产物都失败退出。源码中的ProjectSettings是初始配置，构建入口重新明确关键字段；不设置生产签名、不接平台SDK。

产物为 `D:/farm-unity-build/output/合耕小舍-Unity体验版.apk`，摘要为同目录 `build-info.json`，每次日志归 `D:/farm-unity-build/logs/`。不要把缓存、日志、设备标识、签名私钥或运行时数据提交仓库。

## 验包

构建后用明确工具路径核实，不改PATH：

```powershell
$android = 'D:/unity/2022.3.62f3c1/Editor/Data/PlaybackEngines/AndroidPlayer'
$apk = 'D:/farm-unity-build/output/合耕小舍-Unity体验版.apk'
& "$android/SDK/build-tools/34.0.0/aapt2.exe" dump badging $apk
& "$android/OpenJDK/bin/java.exe" -jar "$android/SDK/build-tools/34.0.0/lib/apksigner.jar" verify --verbose --print-certs $apk
```

核对包名、版本、portrait、min/target SDK、两种ABI以及签名验证结果。只有实际构建、验签、安装与页面测试才是相应证据。构建脚本不启动模拟器、不安装或启动APK；真机、微信正式身份、真实农场/设备和平台审核另行验收。
