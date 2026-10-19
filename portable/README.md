# 深白片场 Windows 便携版

完整解压 ZIP 到一个可写文件夹，然后双击 `Start.cmd`。无需安装 Python。程序会打开本机浏览器；重复双击会打开已运行的同一份安装。

`userdata/` 保存画布、账号设置、素材和运行日志。更新只替换 `versions/` 下的程序版本，不会用新版本覆盖 `userdata/`。备份与版本切换记录位于 `updates/`；故障时请保留整个目录。

启动失败可查看 `updates/launcher.log` 与 `updates/server.log`。不要只复制一个启动文件，不要在 ZIP 压缩包内直接运行，也不要手工修改 `current.json`。

模型生成仍需自行配置支持的服务或本地引擎；便携版没有打入 API 密钥、模型权重、ComfyUI、ffmpeg 或第三方登录凭据。

本项目源码和发布说明：[344996/deepwhite-studio-collab](https://github.com/344996/deepwhite-studio-collab)。原作者、使用限制和第三方署名保留在版本目录内的 `LICENSE`、`README.md` 及 `app/` 对应文件中。
