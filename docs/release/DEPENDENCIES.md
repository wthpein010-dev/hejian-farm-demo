# 移动端依赖修补与兼容边界

日期：2026-10-28。范围：uni-app 503 系列的 H5、微信、抖音和 App 资源编译链。依赖审计通过不代表真实平台登录、支付、设备控制、签名包或上架审核已经通过。

## 保留的框架边界

- DCloud 包保持 `3.0.0-5030320261023001`，Vue 与原编译器保持 `3.4.21`；没有采用 `npm audit fix --force`，没有把 DCloud 降到审计器建议的旧 `0.x` 包。
- Vite `6.4.5`、esbuild `0.25.12`、Babel core `7.29.7` 以及其他安全版本由根 `package.json` 的 `overrides` 统一拥有，具体解析以 `package-lock.json` 为准。
- 原生 App 编译产物是待签名、联调和打包的资源，不是已验收的 APK／IPA。当前入口使用 uni-app 要求的 `createSSRApp`，不等于产品提供了服务端渲染。

## 必要兼容修补

### qs安全更新（2026-10-28）

本次新审计发现`qs@6.16.0`受[GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)影响：comma数组格式序列化遇到不可调用的自有toString可能抛出未捕获异常。它由移动开发工具链的Express/body-parser间接引入；不将公告扩大为当前API已经受到实际攻击的证据。

根override与锁文件仅把qs升级到修复版6.16.1，其余框架/peer边界不变。`npm install --package-lock-only`最初没有更新解析，显式`npm update qs --package-lock-only --ignore-scripts`后才取得正确锁；随后普通安装仍保留旧的本机6.16.0，因此以`npm ci --ignore-scripts`重新安装，再实际读取包版本为6.16.1。不能只凭锁文件审计为0就宣称本机依赖已经更新。

新安装后`verify:dependencies`通过，`npm audit --json`退出0、已知漏洞0；原始中危报告与最终结果留在本机`.scratch/session-contract/`。安装仍有vue-i18n/phin维护提示，按本文持续维护处理；此检查不等于完整安全或生产容量验收。

### 官方 peer 声明的明确例外

| 依赖 | 官方 peer 声明 | 当前实际版本与处理 |
|---|---|---|
| `@dcloudio/vite-plugin-uni@3.0.0-5030320261023001` | Vite `5.2.8` | 使用已修复安全问题的 Vite `6.4.5`，保留 DCloud 503 |
| `@vitejs/plugin-legacy@5.3.2` | Vite `^5.0.0` | 同一 Vite `6.4.5`，需持续验收 H5 兼容输出 |
| `@vitejs/plugin-vue-jsx@3.1.0` | Vite `^4.0.0 \|\| ^5.0.0` | 同一 Vite `6.4.5`，当前产品模板未使用 JSX |

这是工程明确承担的兼容例外，**不是上游声明支持 Vite 6**。`npm ls vite --all` 当前仍会因这些 peer 声明返回 `ELSPROBLEMS`／退出码 1，不能将它记录成依赖树全绿。本轮验证以锁定版本、四端真实编译和运行检查为证；未来升级须重跑，正式渠道和原生运行仍单独验收。检查脚本固定关键版本，防止无意漂移。Vite 的安全版本不能为了消除 peer 警告退回存在已知漏洞的旧版。

### 完整替换旧 i18n runtime

经典 uni-app 503 会将 `vue-i18n` 强制指向 CLI 内置的 9.1.9 runtime。该 runtime 依赖 `handleFlatJson` 和 `getLocaleChain`，这两个导出在安全修复版 core-base 9.14.5 中已变化。仅升级 core-base 会破坏这个接口。

移动工程显式依赖 `vue-i18n@9.14.5`，`vite.config.ts` 对 `vue-i18n` 和 `vue-i18n/runtime` 都设置完整 runtime 别名，并在最终配置解析阶段检查它们确实优先。`@intlify/core-base`、`shared`、`vue-devtools` 同步为 9.14.5。版本或别名顺序不匹配会终止构建，不静默退回内置旧版。

### 隔离修复 renderer

`@vue/server-renderer` 单独固定为 3.5.42，以修复属性名缺少 CR 过滤的 XSS。没有全局替换 uni-app 的 Vue 编译器或定制运行时。依赖边界检查会验证旧 Vue VNode 的基础渲染与恶意属性名被拒绝；这不是对混合版本 SSR 的全面支持声明。

Vite 配置明确拒绝 SSR 构建。本产品如果以后增加 SSR，需要另行对齐渲染器、编译器和运行时并验收，而不能移除这个门禁后直接上线。

### Jimp 与修复后的文件识别器

微信自动化工具使用 `require('jimp').read(buffer).bitmap` 识别远程调试二维码。Jimp 保持提供该 API 的 0.22.12，文件识别器使用已修复 ASF 无限循环和 ZIP 解压炸弹问题的 `file-type@21.3.2`。

file-type 已改为 ESM 命名导出 `fileTypeFromBuffer`。`tools/patch-mobile-dependencies.mjs` 对 `@jimp/core@0.22.12` 的 CJS／ESM 两个文件做窄范围 API 适配，保留原许可与其余逻辑。脚本同时校验版本、原始 SHA256、修补后 SHA256；未知源码或版本会失败，重复执行安全。

普通安装的 `postinstall` 会处理该适配；API 单独安装、未安装移动端依赖时可以跳过。移动端每次 dev／build 的前置脚本仍强制验证，因此 `npm ci --ignore-scripts` 之后也不能绕过移动构建检查。

## 验证命令

```powershell
npm ci
npm run verify:dependencies
npm audit --json
npm run typecheck
npm run build:h5
npm run build:weixin
npm run build:douyin
npm run build:app
```

`verify:dependencies` 检查框架版本、PNG／JPEG 实际编码再解码、非法图片拒绝、renderer 属性转义。四端构建还会执行最终 i18n 别名门禁。应分别检查运行行为，不能只把安装摘要或构建成功当作完整上线验收。

本轮原始审计为 45 项（33 high、9 moderate、3 low），原件及各阶段结果保存在本地 `.scratch/release-readiness/`。旧锁和现有安装中曾出现 override 未收敛的结果，最终以重新解析后的锁、干净安装和实际审计为证。

2026-10-27，Windows 本机 Node `24.15.0`／npm `11.12.1` 的依赖接入基线实际结果：`npm ci`、`verify:dependencies`、`typecheck` 和上述四端构建均曾退出码 0；`npm audit --json` 退出码 0，已知漏洞 0（包括 high／critical／moderate／low）。最近一次完整复跑于 UTC 2026-10-26 20:24:26 结束（北京时间 2026-10-27 04:24:26），包含显式属性转发的 FarmButton；逐命令起止时间及源码／锁文件哈希见本地 `mobile-build-results.json`。之后的 UI 源码变动必须重跑相应构建，最新结果由主验收记录汇总，不能复用旧基线。该审计针对当时锁文件，不是对所有源代码、打包内置代码或未知漏洞的完整安全证明。官方 peer 例外仍按上表如实保留。

SSR 负向检查也已执行：`npm run build:h5 --workspace @hejian/mobile -- --ssr` 返回退出码 1，并出现本工程“仅支持客户端渲染”的明确门禁信息；该非零结果是预期拒绝，不是 SSR 已通过。

## 持续维护

vue-i18n 9 和 phin 3 的发布包有停止维护提示。这里使用已知漏洞修复版本并保留明确版本门禁；“未发现已知漏洞”不能替代后续安全维护。升级 DCloud 时应优先移除这些兼容适配，并重新验证四端、i18n 和二维码工具；不能只改哈希让未知源码通过。
