# App微信授权接入与验收边界

2026-10-28。用户已选择App使用微信登录；App与微信小程序是否共用账户/资产仍待确认。当前完成授权基础模块，**尚未开放App登录入口或创建App账户**，不能当作正式微信登录、签名安装或上架证据。

## 已实现的接缝

| 所有者 | 当前行为 | 尚未完成 |
|---|---|---|
| `services/api/src/weixin-app-oauth.mjs` | 显式factory固定调用微信移动应用OAuth端点，验证响应并只返回服务端私有身份摘要 | 生产配置、持久code claim后的路由接入、账户绑定/映射、正式会话签发 |
| `apps/mobile/src/core/weixin-app.mjs` | 官方plus.oauth只取code，CSPRNG state与回调精确核对；本地单次尝试、截止和旧回调隔离 | OAuth模块/公开AppID/包名签名配置、自有安装包、真实微信回跳与移动WebCrypto验证 |
| `createFarmClient.authorizePlatform` | 原生等待纳入既有登录代际；退出或新登录可及时结束旧等待，迟到code不能再发HTTP，未配服务不打开SDK | App页面/生命周期/authorizer组合；正式App平台key仍未加入服务端allowlist |

现有小程序provider、账户数据、schema、备份、资产规则与原财务回执不变。新增App模块不读取生产环境变量，也没有将App配置偷偷注册到旧`weixin`或`toutiao`分支。当前页面仍展示原准备中状态；独立Pages仍只发布prototype内存H5。

## 协议与身份

原微信小程序使用`GET https://api.weixin.qq.com/sns/jscode2session`及`js_code`。App必须使用`GET https://api.weixin.qq.com/sns/oauth2/access_token`及`appid/secret/code/grant_type=authorization_code`。临时code不自动重放；未来登录路由仍须先原子占用原有provider/AppID/code摘要，再交换身份，失败或结果未知不能释放供再次兑换。

独立App交换默认5秒/16KiB，禁止重定向；HTTP、实际流、UTF-8/JSON、错误码、openid及平台令牌/期限/scope均校验，支持外部取消。只返回冻结私有投影：AppID namespace摘要、app-scoped subject摘要及可选`unionIdentity:{namespace:null,digest}`。原openid/unionid、code、access/refresh token、Secret及完整上游URL不进入返回DTO、日志或原账。微信平台令牌不能当作Farm会话token。

`unionIdentity.namespace=null`明确表示**没有验证开放平台作用域**，不能据此自动合并账号。当前小程序适配器也没有保存UnionID，无法由既有openid摘要反推。若用户确认共用资产，需独立身份映射、既有账号认领/冲突处理、注销和备份恢复设计，核实两个应用的开放平台归属；不能覆盖users原身份或重写历史财务回执。

## 原生调用与取消

当前锁定的uni-app-plus 503运行库中，`uni.login({onlyAuthorize:true})`调用`service.authorize`时没有传入第三项options，回给业务的只有code/authResult，不提供本次state核对。因此采用官方`plus.oauth.AuthService.authorize(success,error,{scope:'snsapi_userinfo',state,appid})`薄适配，不修改DCloud依赖。

state由WebCrypto的16随机字节生成；无密码学随机能力时失败关闭。只选择唯一weixin服务，成功只接受本次own-data code/state，不读取平台token或userinfo。服务发现与授权共用默认60秒本地截止；即使JS timer晚调度，回调已过截止也不能成功。

`authorizer.cancel()`仅结束本地等待、清计时器并作废代际。微信没有官方通用abort句柄；不能声称已关闭微信界面，`closeAuthView`不是微信授权取消接口。客户端退出/新登录会解除自己的旧授权等待和写锁，**不会自动调用authorizer.cancel**；最终页面/生命周期组合仍需显式结束原生协调器的本地busy。两层均不能替代另一层，也不能替代真实SDK回调与签名核对。

## 正式配置及必须取得的证据

- 微信开放平台已审核的移动应用、微信登录权限、对应AppID，Android包名与实际签名，iOS发行时的Bundle ID和Universal Links。AppID是公开标识，Secret/签名私钥只进入服务端或打包安全配置。
- DCloud manifest的`app-plus.modules.OAuth`、`app-plus.distribute.sdkConfigs.oauth.weixin.appid`及需要的iOS UniversalLinks。不得配appsecret进客户端；根DCloud AppID、小程序AppID和移动微信AppID是不同标识。配置后需重打自定义基座/自有签名包，标准HBuilder基座不能验收用户微信身份。
- 服务端HTTPS、出站查询脱敏、实际平台API安全模式及账户归属策略。官方GET含secret/code，生产代理/APM必须屏蔽完整query，不能仅依赖本模块固定错误就宣称部署无泄漏。
- 本项目实际签名包上的授权回跳、取消/拒绝、微信未安装、弱网/超时、旧回调、重复点击、重登/退出/注销及同账户资产；若发行iOS，另做其真机和Universal Links矩阵。

本轮测试仅有合成fetch/原生服务、时钟/计时器及实际客户端行为证据；资源编译不证明上述配置或平台审核通过。当前正式上线目标仍未完成。

## 官方依据

- [微信移动应用登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/WeChat_Login/Development_Guide.html)、[UnionID接口](https://developers.weixin.qq.com/doc/oplatform/Mobile_App/WeChat_Login/Authorized_API_call_UnionID.html)
- [DCloud App微信登录](https://uniapp.dcloud.net.cn/tutorial/app-oauth-weixin.html)、[uni.login](https://uniapp.dcloud.net.cn/api/plugins/login.html)、[HTML5+ OAuth](https://www.html5plus.org/doc/zh_cn/oauth.html)

以上官方文档于2026-10-28现场读取；当前依赖桥的只读源码证据与完整来源记录留在本机`.scratch/app-weixin-auth/recon.md`。未使用真实平台凭据或调用真实授权。
