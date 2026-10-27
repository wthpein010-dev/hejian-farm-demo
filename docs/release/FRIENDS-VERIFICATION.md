# 持久农友切片验收

日期2026-10-27；基线ba4b939；全部账户、数据库和关系均为自建合成数据。当前为工程进展，正式App/小程序完整上线目标未完成。协议见[FRIENDS](FRIENDS.md)。

## 本机验证

- Node24.15.0根`npm test`最终602项：600通过、0失败、2项既有Windows POSIX信号跳过。新增服务/协议31项，客户端/HTTP/页面用例见friends-http/storage/wire、durable-friends-client/integration/ui及mobile-home-ui。
- 最终`typecheck`、`verify:dependencies`、H5/微信/抖音/App四端资源构建退出0；token与12张同源照片摘要通过，依赖审计0已知漏洞。上游peer例外未变，离线资源不是签名包或真机证明。
- 新共享协议、服务、HTTP和客户端语法、`git diff --check`通过；premium UI strict audit 0 findings。canonical token/照片未改，未谎称运行已缺失的旧DESIGN lint。

## 状态与存储

真实HTTP/SQLite覆盖开通同意、双方确认/拒绝/撤回、交叉申请、200关系/200屏蔽/20日申请边界、停用重开限额/版本、同key原结果、异正文拒绝、移除/屏蔽后旧请求不复活、未使用旧接受不能作用于重建申请、跨账户/环境/非沙盒关闭、慢正文会话过期、两连接重查、命令账写失败整笔回滚、版本溢出回滚。

schema6固定DDL/索引/外键、图关系/时间/回执校验、重算哈希仍拒绝篡改、注销双向清理、恢复清会话及旧schema兼容均已测。旧测试仅更新当前schema和真实旧结构构造，保留schema2–5备份与混合金融回执。另实际执行ba4b939的schema5旧Store原源码：拒绝schema6，DB文件SHA256前后一致。未升级用户运行库。

独立审查发现不可用身份伪造成功回执可能被恢复重放，已以生产及development非沙盒身份先RED再修复；备份与运行重放均拒绝。财务Snapshot/revision、兑换原结果和农场权限不因农友操作变化。命令历史没有静默裁剪，总容量与生产保留仍待设计。

## 客户端与浏览器

原key/body与唯一pending槽、4xx/429/5xx未知保留、401原账户恢复、账户/迟到读取失效、独立版本下限、写后另读和刷新失败不重发均有回归。异步剪贴板在隐藏或换账户后失效，草稿不进storage/URL/日志。最终独立审查专项59项通过，字段修复后相关33项通过，无剩余P1/P2。

实际ChatGPT内置浏览器＋Vite5174/SQLite API8787完成：

1. 两个独立合成账户开通，B使用A界面农友码申请，A刷新收到申请并以Enter接受，双方各1位农友；复制不等于申请成功。
2. B刷新后重新登录恢复原名片/关系。停掉自建API时GET显示连接失败并保留名单；同DB重启后刷新恢复、错误消失，没有重发申请。
3. 非法码保留草稿并聚焦真实`INPUT#friend-code-input`，`aria-invalid=true`与有效帮助/错误关联。清除后仅关联帮助，原生label点击也聚焦。最初uni-input宿主焦点失败，经浏览器复现后改H5原生label/input；小程序显式focus编译已验，真机仍待验。
4. 390×844、320×640、390×360实际CSS视口无横溢。320页面全部可见button至少48px；移除确认默认聚焦安全返回，短屏Tab可达确认（按钮底264.72px、底栏始277.33px），取消回列表控制。未在浏览器执行账户注销。
5. 主页农友入口在照片封面后、活动前，正式未开放提示保留；最终浏览器warn/error为`[]`。截图留本机`.scratch/durable-friends/`，不上传数据库、会话或农友码。

真实OS输入法候选、屏幕阅读器、软键盘、真机及官方审核未宣称通过。持久论坛/消息、审核举报、平台身份/分享归因、真实农场/设备/视频/支付履约、API部署/运维和签名上架仍按READINESS推进。

## 发布

仍仅发布独立`wthpein010-dev/hejian-farm-demo`及Pages，不接Hub或其他网站。本机已核验身份wthpein010-dev、push/admin权限和main基线；本轮提交/CI/线上结果按实际回执补记。Pages只部署prototype，论坛/好友仍是内存演示；本账户API未部署公网。
