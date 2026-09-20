# 维护与发布 · 2.3.1

本项目的更新路径为：提交代码 → 稳定版本标签 → GitHub Actions 构建安装包 → 受保护环境签名 → 草稿 Release → 人工审核发布 → 客户端验证并下载 → 用户点击「重启并更新」。创建仓库本身不会让已安装客户端自动获得更新能力。

下列 `OWNER/REPOSITORY` 是占位参数，必须替换为实际来源。先检查 `update-config.json`：`repository`、`publicKey` 均为 `null` 表示更新源未启用。首次交付可自动更新的安装版前，必须完成来源和公钥配置；不能先交付停用版本，再期待它自行发现公钥。

## 一次性本地初始化

当前仓库为 <https://github.com/icjunge/gpt-orb-safe>。仓库已公开，日常测试与 Windows 安装包构建由 GitHub Actions 执行。此仓库已有发布源和签名公钥时，应沿用现有配置及私钥；下面的初始化只适用于尚未完成设置的仓库。

维护者在自己的电脑安装 Node.js 22.12+、Git 和 [GitHub CLI](https://cli.github.com/)，然后在终端运行：

Windows 可先下载并运行 [Install-Tools.cmd](scripts/Install-Tools.cmd)，自动检测并通过微软 WinGet 安装缺失的三个工具，安装后显示实际版本。脚本保留管理员授权提示，不自动重启，不更改 PowerShell 执行策略；已有满足要求的工具会跳过。缺少 WinGet 时按提示安装微软 App Installer。`Install-Tools.cmd --check` 只检查，不安装。安装成功后重新打开终端，再执行下面的初始化命令。

```sh
gh auth login --hostname github.com --git-protocol https --web
gh repo clone icjunge/gpt-orb-safe
cd gpt-orb-safe
npm run release:setup -- icjunge/gpt-orb-safe
```

如果已克隆仓库，直接进入已有目录并确保 `main` 已与远程同步，不要重复克隆到同一位置。此初始化脚本只用 Node.js 内置模块，不需要先运行 `npm ci`。它会检查仓库、当前分支和发布保护，创建或复用仓库外的本地 Ed25519 私钥，经标准输入将它交给 GitHub 的 `release` 环境 Secret，再把公钥写入 `update-config.json`。不同的既有环境保护或签名公钥会使操作停止，不会被覆盖。运行 `npm run release:setup -- icjunge/gpt-orb-safe --dry-run` 可只检查，不写入。

脚本不自动提交、推送或发布。成功后按它打印的命令提交和推送 `update-config.json`，再创建并推送 `v2.3.1` 标签。保护的签名作业会等待你在 GitHub Actions 审核；完成后生成草稿 Release，检查安装包并正式发布。为便于单人维护，初始化允许发布者审核自己的发布；脚本不会执行审核或跳过审核。

初始化会显示当前阶段。若 Git 检查失败，错误会指出固定操作名、错误类别和可用的退出码，底层输出仍隐藏，避免泄露凭据。只有查询远端 `main` 的只读操作遇到明确临时连接故障时才自动重试一次；认证、证书及其他错误会直接停止。没有明确连接错误的命令超时也可能是等待凭据，因此不会自动重试。GitHub 写入操作不会自动重试。

“只读检查通过”之后仍有写入前与写入后的 Git 复核，不代表初始化已经完成。失败时以阶段和恢复提示为准：远端写入可能已经生效，原有本地密钥与恢复记录会保留；不要删除或重新生成密钥。获取脚本修复时先执行 `git pull --ff-only`，成功后再运行 `node scripts/setup-release.cjs`。若 Git 提示本地修改或分支不同步，先处理对应提示。将最后的阶段和错误信息提供给维护者即可，无需发送密钥文件。

脚本通过公开 API 核验指定审核人和 `v*` 标签限制；它不能配置或核验管理员绕过保护的界面开关。可在 Settings → Environments → release 中取消允许管理员绕过保护。仓库管理员始终能够修改这些设置，发布保护不能防御已被控制的管理员账号。

妥善备份脚本提示位置中的私钥，**不要将它发到聊天、issue 或仓库**。之后发布新版本继续使用同一密钥，不必每次初始化。普通使用者运行桌面只需最终 EXE，无需 Git 或 GitHub CLI；本机 Codex 来源需另有官方 CLI。使用 npm 安装 CLI 时需要 Node.js/npm。

Windows 初始化仅使用用户目录下的默认密钥位置，不接受 `--key-file` 自定义路径或 UNC 形式的网络路径。它依赖 Windows 用户目录现有的访问权限，不会把 POSIX 的 `0600` 当作 Windows ACL 保证；请使用本机用户目录，不要使用映射网络盘，也不要将该目录共享或改成其他用户可读。Linux / macOS 可用仓库外的 `--key-file` 绝对路径，已有密钥须仅当前用户有访问权限。

以下各节保留分步配置与后续版本发布说明。

## 1. 仓库与工具

使用 Node.js 22.12+、Git、GitHub CLI（运行仓库辅助脚本时）及 Python 3.10+（生成源码 / 扩展压缩包时）。维护者使用自己的 GitHub CLI 登录；桌面用户无需 GitHub 登录或 PAT。

```sh
npm ci
npm test
```

仓库尚未初始化时，先执行 `git init -b main`，检查将提交的内容，再提交。现有仓库不要重复初始化或覆盖其历史。`.gitignore` 排除依赖、构建目录、环境文件及私钥，但仍须检查提交内容；忽略规则不能撤销此前已提交的秘密。

仅在远程仓库尚未建立时，可使用：

```sh
node scripts/setup-repository.cjs OWNER/REPOSITORY --private
```

该脚本调用 `gh repo create`，创建 origin 并推送现有本地提交，默认是私有仓库。**匿名桌面更新需要公开可下载的 Release 资产；当前工作流直接在配置的同一仓库发布。** 若确认愿意公开项目源码，可在创建时明确使用 `--public`。如需源码保持私有，请先设计独立公开分发仓库及相应工作流，不要把 PAT 嵌入客户端。该双仓库流程不在当前脚本实现范围内。

## 2. 首次建立发布签名

在仓库外创建私钥目录，保管其备份并限制文件访问。下面以已存在的绝对路径 `/secure/orb-release` 为例；Windows 可替换为本机绝对路径。生成私钥的脚本拒绝写入仓库、拒绝覆盖已有文件，输出公钥及其指纹，不输出私钥。

```sh
node scripts/generate-signing-key.cjs /secure/orb-release/orb-update-private.pem
```

将输出中完整的 `BEGIN PUBLIC KEY` 到 `END PUBLIC KEY` 段保存为 `/secure/orb-release/orb-update-public.pem`。然后配置客户端信任锚点：

```sh
node scripts/configure-release.cjs OWNER/REPOSITORY /secure/orb-release/orb-update-public.pem
node scripts/validate-release.cjs
```

`configure-release.cjs` 也支持从环境变量 `ORB_UPDATE_PRIVATE_KEY` 推导公钥，工作流使用该方式；本地配置优先使用公钥文件，不必把私钥加载到构建环境。若存在 `GITHUB_REPOSITORY` 环境变量，它必须与目标仓库一致。脚本拒绝悄悄更换已配置的仓库或公钥。

审核并提交 `update-config.json`。这里只允许出现公开仓库名称和公钥，**不得提交私钥**。公钥一经随安装版发行，就成为该版本信任的更新签名来源；私钥丢失或泄漏需要单独制定迁移方案，不能直接重新生成并替换。

## 3. GitHub 发布环境

在仓库 Settings → Environments 创建 `release` 环境，按仓库可用功能设置所需审核者和发布保护规则。工作流写有 `environment: release`，但这不自动提供审批规则。

在该环境添加 `ORB_UPDATE_PRIVATE_KEY`，值为完整 Ed25519 私钥 PEM。可通过 GitHub Secret 界面填写，或在已登录维护者的 Bash 环境执行以下命令（输入文件必须保留在仓库外）：

```sh
gh secret set ORB_UPDATE_PRIVATE_KEY --repo OWNER/REPOSITORY --env release < /secure/orb-release/orb-update-private.pem
```

不要将密钥放进 workflow 文本、Release 附件、issue、日志或桌面设置。构建作业不使用此密钥；只有发布签名作业从环境 Secret 读取，且会确认它与已提交公钥匹配。

工作流用 GitHub 自带的 `github.token` 创建草稿 Release，发布作业获得 `contents: write` 权限，无需给桌面客户端配置任何令牌。

## 4. 发行一个新版本

1. 更新 `package.json` 与 `package-lock.json` 的版本（例如 `npm version 2.3.1 --no-git-tag-version`），同时将 `extension/manifest.json` 的 `version` 改为完全相同的 `X.Y.Z`（各段不带前导零且不超过 65535）。更新说明文档。
2. 执行 `npm test` 和 `node scripts/validate-release.cjs`。需要预览 Windows 安装包时，在 Windows 构建环境执行 `npm run build:win`；安装包位于 `dist/GPT-Orb-Setup-X.Y.Z-x64.exe`。此步骤只是构建，不上传发布。
3. 提交并推送代码，再创建与应用版本完全相同的 `vX.Y.Z` 标签并推送。例如当前版本：

```sh
git tag v2.3.1
git push origin HEAD
git push origin v2.3.1
```

`.github/workflows/release.yml` 会在 Windows runner 构建并测试，用 Python 生成源码和扩展 ZIP；后续发布作业校验仓库、公钥、版本标签，签名真实安装包，并创建**草稿** Release。手动运行工作流也必须选择相应版本标签；默认分支不是发行入口。

检查草稿中的资产、版本、提交与变更说明，完成 Windows 安装 / 升级及目标浏览器验收后，再在 GitHub 发布 Release。当前工作流不会自行发布草稿。客户端只读取公开的最新正式 Release；草稿或仅推送代码不会触发用户下载。

不要重写已发行标签或替换同版本资产；需要修复时递增版本重新发布。客户端拒绝比当前安装版本更旧的描述；它没有自动降级或完整程序回滚功能。

## 5. 资产与签名格式

每个正式 Release 至少保留以下同一构建的文件：

| 文件 | 用途 |
|---|---|
| `GPT-Orb-Setup-X.Y.Z-x64.exe` | Windows x64 NSIS 安装器，包含桌面应用、运行依赖、Electron 和扩展 |
| `orb-update.json` | Ed25519 签名的发布描述，客户端首先验证它 |
| `latest.yml` | electron-updater 下载描述，其版本、文件、长度与哈希必须与签名一致 |
| `GPT-Orb-Setup-X.Y.Z-x64.exe.sha256` | 初次手动下载时可核对的哈希；它本身不是发布者证书 |
| `GPT-Orb-X.Y.Z-Source.zip` | 源码、lockfile、测试、文档和发布流程 |
| `GPT-Orb-X.Y.Z-Browser-Extension.zip` | 单独的本地浏览器扩展文件及说明 |

`orb-update.json` 是 `{payload, signature}` 信封；二者均为 Base64，签名覆盖 payload 的原始 UTF-8 JSON 字节。payload 含 `schema`、`version`、`tag`、`platform`、`arch`、`file`、`size`、`sha256`、`sha512`、`publishedAt`。客户端不信任单独的 `latest.yml`，也不在 UI 中执行发布内容。

如需在受控维护环境手动签名，先将 `ORB_UPDATE_PRIVATE_KEY` 安全加载到该进程环境，再运行 `node scripts/sign-release.cjs dist`。脚本验证实际 EXE、固定公钥、仓库环境与标签（存在时），生成上述更新描述和哈希；不要在命令历史中直接粘贴密钥。

生成源码与扩展 ZIP 的命令：

```sh
python scripts/package_windows.py --source-only --extension-zip --output dist
```

2.1+ 不再用此 Python 脚本构建便携 Windows 包；安装版使用 electron-builder。所有构建依赖均通过 lockfile 固定，但首次下载依赖仍需要可用网络。

## 6. 客户端与恢复边界

2.3.0 起提供的本机读取能力在桌面主进程中，通过已安装的官方 Codex CLI stdio App Server 查询。必须更新桌面程序；仅 `npm run extension:update` 或扩展 ZIP 不会带来本机来源。构建包不捆绑 CLI，不携带账号登录状态，不执行 `npm install` 或官方登录。源码开发运行需 `npm ci` 后 `npm start`；不要在用户启动流程中加 `--ignore-scripts`，否则 Electron 运行时可能缺失。

CLI 发布验收须包含：干净用户目录中默认未启用；CLI 未安装 / 未登录 / 登录过期的固定提示；安装官方 CLI 并登录同一 ChatGPT 账号后立即读取；关闭浏览器后按 1–1440 分钟间隔继续刷新；启用偏好在桌面重启后保留；禁用停止查询且不退出官方登录；各窗口及剩余重置次数正确映射；可选服务端 Token 统计不支持时保持未知；错误保留上次成功记录；切换来源不串数据；睡眠与恢复不并发堆积任务。使用真实 Windows npm 安装路径验证 CLI 查找与进程清理，不能仅依赖模拟 RPC 测试。

额度查询只发送固定请求，不发起模型任务或消耗重置次数。不要把官方 CLI 使用和续期本机凭据误写成“整个调用链不读取凭据”，也不要把服务端最新日桶称为“本机今日 Token”。官方 App Server 仍是实验性接口，记录实际验证的 CLI 版本；不要宣称所有 CLI 版本或所有账号结构均受支持。

浏览器备用模式保留 2.2 引入的 `alarms` 与可选 `https://chatgpt.com/*` 权限，清单权限不扩大。继续验收拒绝授权可当前页读取、未知页面不覆盖成功记录、临时标签页被接管后不关闭、停止后撤销授权，以及浏览器重启 / 扩展重载后重新配对。切换桌面到本机模式前，可在扩展「关闭并撤销授权」，避免旧会话任务继续打开页面。

新版清单校验器接受完整旧形状及完整新形状，拒绝额外或混合权限。旧桌面（例如 2.1.1）可能因不能校验新清单显示扩展目录更新警告，但保留现有文件；正式桌面升级后使用新版校验器。沿用已提交发布仓库、公钥及原有受保护环境，不重新初始化或生成签名密钥。

维护者调试扩展时，可在 Windows 仓库目录运行 `npm run extension:update`，无需 `npm ci`。它只把本地 `extension` 同步到当前用户默认的 `%APPDATA%\GPT Usage Orb Safe\Browser-Extension`，使用与桌面一致的清单校验、完整替换和防降级策略；不读取浏览器配置，不启动桌面，不自动重载。该源码路径不经过安装包签名验证，普通用户仍使用正式签名更新。浏览器若加载了其他目录，必须先迁移到打印出的固定目录一次；之后在扩展管理页重载并重新配对即可。这个命令既不发布 Release，也不改变安装的桌面版本。

应用名与用户数据目录保持为 `GPT Usage Orb Safe`。从旧便携版迁移到 NSIS 需要一次安装；后续由应用验证、下载，用户点击后重启更新。安装器按当前用户安装，不要求应用用户提供 GitHub 或 GPT 凭据。

扩展每次由桌面安装包同步到用户数据目录的 `Browser-Extension`。旧目录首次迁移需在浏览器移除并加载固定目录一次；之后点击扩展内「重新加载扩展」即可读取新版文件。重载会清除会话配对，必须重新复制桌面配对码。

更新安装前在 `recovery` 保留偏好设置备份；不备份账号凭据，也不提供 NSIS 原子回滚。安装失败可能需要重新运行可信安装器；手动恢复偏好时先退出程序，再将选择的 JSON 备份复制为用户数据目录的 `preferences.json`。请勿在说明中将模拟更新测试写成实体 Windows 升级通过，或把 Ed25519 更新签名写成 Windows Authenticode 签名。
