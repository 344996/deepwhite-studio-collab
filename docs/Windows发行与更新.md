# Windows 发行与更新维护

适用：0.10.2-studio.16 起的 Windows x64 便携版签名更新机制，当前版本 0.11.0-studio.6。源码运行版继续用 Git 更新。画廊网站部署和数据库备份独立管理。[本次公开下载与真实升级验收](公开发布与在线更新-20261021.md)。

## 使用方式

完整解压 `deepwhite-<版本>-windows-x64-portable.zip`，双击根目录 `Start.cmd`。使用包内 Python，无需用户安装 Python 或运行 pip。不要直接在 ZIP 内启动，也不要把新版本文件覆盖到旧版本目录。

默认地址 `http://127.0.0.1:3848/`。端口已占用时，可在安装根目录新建 `installation.json`，内容例如 `{"port":3858}`，再启动；文件只接受一个整数 port（1024–65535）。显式 `--port` 和 `DEEPWHITE_STUDIO_PORT` 优先于此文件。

设置 → 基础设置 → 关于 → **版本更新、安装与回退**；新版也可从“设置 → 存储与更新”进入。检查更新、下载、安装是分开的操作；下载不会关闭画布。安装前先保存并关闭其他画布标签页，处理未完成或待核实的生成任务。安装期间暂时禁止 API 读写，健康检查和更新状态仍可查看。

```text
安装目录/
  Start.cmd / Start.ps1 / launcher.py
  current.json                    当前程序版本
  versions/<版本>/
    python/                       官方嵌入式运行时和锁定依赖
    app/                          已提交的应用源代码
    references/                   构建来源、依赖锁
    release.json                  包内版本与数据兼容声明
  userdata/                       用户项目、素材、账号设置、任务回执
  updates/
    downloads/                    已校验 ZIP 与可续传暂存文件
    staged/                       解压验证；安装时再次从校验 ZIP 解压
    backups/<操作ID>/userdata/    停止服务后的一致性备份
    backups/<操作ID>/manifest.json
    previous.json                 上一个可回退程序版本
    transaction.json              durable 更新事务
    state.json / server.log        当前状态与服务日志
    launcher.log                   稳定启动器日志，不占用userdata
```

安装成功后如出现“完成更新并重启”，点击并确认保存，程序会安全退出旧服务再启动新版启动器。这个步骤完成前不能再次安装或回退。不要仅重复双击 Start.cmd；它会复用正在运行的服务。

启动器自身是稳定 bootstrap v1。更新清单需要更高 bootstrap 时明确要求完整下载，不尝试替换正在执行的启动器。

如果存在有效但尚未提交的更新事务，稳定启动器使用事务记录中的旧版Python和监督程序进入恢复，避免新运行时或监督脚本损坏导致无法回退。已提交或已回退的事务按当前版本启动。重复字段、未知阶段、矛盾指针会拒绝启动并保留证据；启动器本身不绕过监督程序修改数据或版本指针。

## 签名和发布源

固定更新源：`https://github.com/344996/deepwhite-studio-collab/releases/latest/download/update-stable.json`。版本包 URL 仅允许支持的 GitHub HTTPS 发布及下载域名，重定向同样校验。不使用用户 API Key，不把账户会话发到下载服务器。

清单的 `signed` 对象按 UTF-8、排序 JSON 键、无空白规范化后使用 **Ed25519** 签名。客户端只信任应用随附 `app/update-trust.json` 中的公钥。清单还限制应用、平台、通道、版本、递增序号、有效期、bootstrap 和数据 schema；包校验 SHA-256、字节数、包内元数据及安全路径。损坏包不会执行，断点暂存可重试。

当前更新密钥 ID 为 `deepwhite-stable-2026`。私钥只保存在发布维护者电脑的 `%LOCALAPPDATA%\DeepWhiteReleaseSecrets\deepwhite-stable-2026.pem`，不进入任何 Git 工作树和下载包，Windows ACL 限制当前账户及 SYSTEM。请另做离线加密备份；丢失私钥时无法给旧客户端发布新可信版本。不要把私钥粘贴到问题、日志或 AI 对话。

**Ed25519 更新签名不等同于 Windows Authenticode 代码签名。** 本发行未购置或配置 Authenticode 证书，Windows 下载信誉提示仍取决于系统策略；不能把更新验签描述成已经解决 SmartScreen 信誉。

## 构建和发布

在 Windows 发布机准备 Git、Python 3.12+ 和仓库独立 `.venv`，安装 `requirements.lock.txt`。构建器从指定 Git 提交读取跟踪源码，不把工作区未提交修改、运行数据、`.env`、测试输出或本机全局 Python 装入包。先提交实现及版本文档，再构建。

```powershell
.\.venv\Scripts\python.exe -B scripts\build_windows_release.py `
  --ref HEAD `
  --cache .\release-cache `
  --output .\dist\0.11.0-studio.6 `
  --private-key "$env:LOCALAPPDATA\DeepWhiteReleaseSecrets\deepwhite-stable-2026.pem" `
  --key-id deepwhite-stable-2026 `
  --sequence 19 `
  --notes-file .\app\docs\releases\0.11.0-studio.6.md
```

下一版需修改版本及递增 sequence，不能复用已发布的同名版本包。构建目录已存在时保留原产物，使用新的输出目录。构建器验证官方 Python 3.13.16 嵌入式 ZIP 和 PyPI wheel 摘要，使用 cp313/Windows wheels，验证依赖闭包及包内导入；用户启动时无需联网安装依赖。

输出完整便携包、增量分发用完整版本 ZIP（不含用户数据）、`update-stable.json`、`SHA256SUMS.txt` 和 `build-report.json`。`build-report.json` 包含本机 stage 路径，只在本地留存；公开发布上传前四种文件即可。依赖来源摘要保存在版本内 `references/build-provenance.json`。

发布顺序：

1. 完成源码、浏览器、真实包启动、升级成功和失败回退测试，确认 ZIP 中不含用户数据与私钥。
2. 推送版本提交，在该提交建立 `v<版本>` 标签。
3. 创建该标签的 GitHub Release，上传两个 ZIP、清单及 SHA256SUMS；发布说明引用本版本文档。
4. 确认完整发布后再设为 stable latest；浏览器下载和客户端检查要读取同一个版本。使用普通 HTTPS 客户端重新下载清单和包，验证签名与校验值。
5. 记录 Git SHA、包 SHA256、构建 Python/wheels 和测试证据；不要覆盖旧包。

清单有效期最长 93 天。长期没有版本更新时也需由维护者续签清单并递增序号，旧已过期清单会被客户端拒绝。密钥轮换先发布“旧公钥仍保留、加入新公钥”的过渡版本，再切换新签名；不能直接移除仍被旧安装依赖的密钥。

## 数据保护与回退规则

监督进程持有安装锁；子服务只有在 PID、创建时间登记成功且父进程仍存活后才能访问数据，并持有独立 runtime OS 锁。备份/恢复必须拿到这个锁。父进程在登记前崩溃时，未登记子进程不访问数据；父进程死亡后子服务退出。恢复不能只凭“找不到 PID 记录”推断没有服务。

安装事务：检查并冻结 → 停止自有子服务 → 完整复制 userdata → SHA-256 对照源和副本 → 原子替换 current.json → 启动新版本 → 版本/PID/安装目录/健康检查 → 持久写入 committed → 解除维护。包内 schema 1 数据启动前会校验项目 JSON 与素材 SQLite。任何未知事务阶段或矛盾版本状态都拒绝自动恢复，保留维护状态和所有目录。

**失败自动回退**发生在解除维护前：停止新子服务，验证并恢复更新前备份，再启动旧版。失败时产生的新数据目录移动到 `updates/failed-data-*` 保留，不静默删除。

**成功后手动回退**只切换到可读取相同 schema 的上一个程序版本，保留用户最新 userdata，并先为最新数据再备份。不恢复过期快照，不撤销升级后新增作品。当前只允许 schema 1；不同 schema 的迁移尚未开放，需要后续专门的可逆迁移实现和演练。

外部素材/结果目录只保留配置引用，更新不移动那些目录，userdata 备份也不覆盖外部素材内容。浏览器尚未保存的草稿不属于服务端备份，必须先保存。备份可能含本机账号和 API 凭据，不能作为公开附件上传。

文件占用、磁盘不足、签名错误、过期清单、未知任务状态会阻止更新。程序保留旧版本和失败诊断目录，不自动清空备份；用户确认不再需要后可自行归档备份。

## 异常恢复

正常中断后重新双击 Start.cmd。启动器先回收经过 PID/创建时间/命令行身份校验的自有旧服务，再取得 runtime 锁并检查事务。提交后的事务只恢复维护状态，不能恢复旧数据快照。

若提示事务损坏、目录占用或备份校验失败，先保留整个安装目录。查看 `updates/state.json`、`transaction.json`、`server.log` 与 `launcher.log`；不要直接删除 userdata、维护文件或修改 current.json 让程序“强行启动”。恢复到独立新目录后核对项目、媒体和回执再使用。运行中的启动器日志放在 updates 内，避免 Windows 文件句柄阻止 userdata 目录恢复。

从既有源码工作区迁入便携版：停止旧服务并备份其完整运行目录，将副本放入全新安装目录的 userdata（初次启动前），外部素材路径继续保留；验证画布重开、媒体和任务记录后再决定是否继续使用新版。不能在旧服务运行时复制正在写入的 SQLite 作为可靠迁移。

实现依据：[Python 嵌入式发行说明](https://docs.python.org/3/using/windows.html#the-embeddable-package)、[cryptography Ed25519 接口](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ed25519/)。

## 版本目录不可变与旧工作流

从 .6 起，安装目录内 HTML 只在响应时变换缓存版本；上传和自定义配置写 userdata。安装已有同名版本时，必须与签名 ZIP 新鲜解压结果逐文件一致才复用，不移动或覆盖任何已有版本。不同则保留现场并拒绝安装。回退旧程序时，新旧式工作流目录仍保留，但旧程序不可见；重新运行 .6 后恢复。旧版本 custom/自定义 内容只读兼容。
