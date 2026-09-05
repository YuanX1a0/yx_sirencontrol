# 自行下载和安装警笛音频

本仓库不包含录音、AWC、DAT、REL、原作者压缩包或第三方音频定义。下面的安装工具只处理你已自行下载、获准使用的本地文件，不联网下载、不重新编码、不修改音频内容。

未安装可选音频时，控制器只显示“GTA 原生警笛”。音频资源需要在 `yx_sirencontrol` 之前启动；新增资源后重启控制器，客户端和服务端才会一起注册对应包。

## Modern Siren Pack：警车与消防组合

作者：**GravelRoadCop／LEDesigns**。

- [GTA5-Mods 原发布页](https://www.gta5-mods.com/misc/realistic-american-sirens-pack)
- [LCPDFR 原发布页](https://www.lcpdfr.com/downloads/gta5mods/audio/14373-modern-siren-pack/)

本项目的音色配置针对 **Modern Siren Pack 3.1.5.A**。从作者页面下载并自行阅读所下载版本的许可，解压后找到成品 `vehicles.awc`。使用包含该文件的目录作为输入：

```powershell
.\tools\install-audio.ps1 -Pack Modern `
  -SourceDirectory '<解压后的 vehicles 目录>' `
  -OutputDirectory '<仓库外的 FiveM resources 目录>'
```

工具将创建独立的 `yx_siren_audio_modern` 资源，原样复制 `vehicles.awc`，并生成挂载所需的 manifest。在服务器配置中使用：

```cfg
ensure RageUI
ensure yx_siren_audio_modern
ensure yx_sirencontrol
```

对应菜单为 `modern_police` 和 `modern_lafd`，包括警车、消防、EMS 等原生声音槽位。车型／部门名称用于说明风格，不表示 LAPD／LAFD 官方认证。

Modern 覆盖全局 `resident/vehicles.awc`，因此“GTA 原生”及其他脚本调用相同原生声音名称时，也会听到替换录音。同一服务器只保留一个有效的 resident 替换包；不要同时启动其他挂载该路径的音频资源。更换 AWC 后重新启动服务端并让玩家退出 FiveM 后重连，避免旧声音仍在缓存中。

## SS2000／Rumbler 与消防 Q

需要两份作者自行提供的下载内容：

1. [完整 Server-Sided-Sounds-and-Sirens 资源](https://github.com/fk-1997/Server-Sided-Sounds-and-Sirens)，用于取得原始 `serversideaudio_sounds.dat54.rel` 和完整 `dlc_serversideaudio` 银行目录。
2. [LVC Extras 的 Server Sided Mega Pack A (5+1)](https://github.com/TrevorBarns/luxart-vehicle-control-extras/tree/master/Siren%20Packs/Server%20Sided%20Mega%20Pack%20A%20%285%2B1%29)，其中 `dlc_serversideaudio.zip` 是替换银行，不是完整基础音频资源。

先解压完整基础资源，再把 Mega Pack 的替换 AWC 覆盖到这份**本地音频副本**的 `dlc_serversideaudio` 目录；保留原始 DAT 和其他银行。只提供 Mega Pack 的几个替换文件会缺少 DAT 所引用的银行，安装工具会拒绝不完整输入。

```powershell
.\tools\install-audio.ps1 -Pack Lvc `
  -SourceDirectory '<合并后的完整 Server-Sided-Sounds-and-Sirens 目录>' `
  -OutputDirectory '<仓库外的 FiveM resources 目录>'
```

工具验证 DAT 名称表引用的全部银行，再原样复制为独立 `yx_siren_audio_lvc` 资源。菜单中的 `ss2000` 与 `fire_q` 使用它原有的 `DLC_SERVERSIDEAUDIO`／`OISS_SSA_VEHAUD_*` 名称，不依赖旧私有包中改名的 `YX_*` 银行。

```cfg
ensure RageUI
ensure yx_siren_audio_lvc
ensure yx_sirencontrol
```

不要同时启动原始基础音频资源与生成的 `yx_siren_audio_lvc`，两者会重复挂载同一银行命名空间。Modern 和 LVC 这两种独立资源可以按需同时安装。

LVC Extras 对 Federal Signal／Rumbler 录音署名给 [ShotsFired932](https://www.lcpdfr.com/downloads/gta5mods/audio/22708-federal-signal-and-code-3-sirens/)，消防部分署名 MrLucky8／American Fire Sirens。请保留下载包附带的原始许可与署名，并核对你的使用或分发方式是否被允许；这里的配置和工具不授予音频再分发许可。

## 安装工具的边界

- 可使用 `-WhatIf` 先验证路径和所需文件，查看将创建的资源。
- 输出必须位于本发布仓库外，不允许覆盖已存在的目标资源目录。更新时先自行备份和处理旧目标，再重新运行。
- 复制前验证输入，复制后逐项核对 SHA-256；manifest 最后写入。
- 工具不会自动下载包、获取付费内容、编译第三方音频模板或修改服务器配置。
- `.gitignore` 和 `tools/audit-release.py` 会拦截音频文件进入本仓库。不要将安装后的独立音频资源再提交或附加为本项目 GitHub Release 附件。

安装验证不等于游戏实测。若菜单包没有出现，先检查对应资源名称及启动顺序；若出现但无声，检查实际音频版本、原始声音名、重复银行挂载和客户端缓存。
