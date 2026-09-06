# 在控制器资源内安装 Modern／LVC 警笛

发行版不包含任何第三方录音、AWC、REL 或原作者压缩包。`audio/install.ps1` 只会读取你自行下载并解压的文件，逐字节复制到当前 `yx_sirencontrol/audio/`，然后更新本资源的 `fxmanifest.lua`。它不会联网下载、修改音频或建立另一个资源。

安装前确认资源目录准确命名为 `yx_sirencontrol`。在 PowerShell 中进入该目录，再执行下面对应的命令。可以先加 `-WhatIf` 只做输入检查和预演。

## Modern Siren Pack（音色配置按 3.1.5.A 验证）

作者：GravelRoadCop／LEDesigns。

- [GTA5-Mods 原发布页](https://www.gta5-mods.com/misc/realistic-american-sirens-pack)
- [LCPDFR 原发布页](https://www.lcpdfr.com/downloads/gta5mods/audio/14373-modern-siren-pack/)

两个发布页可能提供不同版本。本项目内置的音色名称按用户提供的 **3.1.5.A** 验证；从作者页面取得你获准使用的版本并解压后，找到成品 `vehicles.awc`，再把包含它的目录交给安装器：

```powershell
.\audio\install.ps1 -Pack Modern `
  -SourceDirectory 'D:\Downloads\MODERN SIREN PACK - 3.1.5.A'
```

安装器会生成以下运行文件，并把对应 `files` 和 `AUDIO_WAVEPACK` 注册写进主 manifest 的 `YX_AUDIO_MODERN` 受管区块：

```text
yx_sirencontrol/
└─ audio/
   └─ modern/
      ├─ installed-files.json
      └─ sfx/
         └─ resident/
            └─ vehicles.awc
```

菜单会出现 `modern_police` 与 `modern_lafd`。Modern 的 `resident/vehicles.awc` 会替换 GTA 原生车辆警笛槽位，因此同一服务器只能保留一份 resident 替换；其他脚本调用相同原生声音名时也会听到这份录音。

## LVC：SS2000／Rumbler／消防 Q

准备以下两份作者提供的内容：

1. [Server-Sided-Sounds-and-Sirens](https://github.com/fk-1997/Server-Sided-Sounds-and-Sirens) 的完整音频，用于取得 `serversideaudio_sounds.dat54.rel` 和全部 `dlc_serversideaudio` 银行。
2. [LVC Extras：Server Sided Mega Pack A (5+1)](https://github.com/TrevorBarns/luxart-vehicle-control-extras/tree/master/Siren%20Packs/Server%20Sided%20Mega%20Pack%20A%20%285%2B1%29) 的替换 AWC。

先解压完整基础包，再把 Mega Pack 的 AWC 覆盖到这份**本地副本**的 `dlc_serversideaudio` 目录。Mega Pack 本身没有完整 DAT 和全部银行，不能单独安装。准备好以后运行：

```powershell
.\audio\install.ps1 -Pack Lvc `
  -SourceDirectory 'D:\Downloads\Server-Sided-Sounds-and-Sirens'
```

安装器会验证 DAT54 引用的全部银行，然后生成：

```text
yx_sirencontrol/
└─ audio/
   └─ lvc/
      ├─ installed-files.json
      ├─ data/
      │  └─ serversideaudio_sounds.dat54.rel
      └─ sfx/
         └─ dlc_serversideaudio/
            └─ *.awc
```

主 manifest 的 `YX_AUDIO_LVC` 受管区块会同时注册 `AUDIO_WAVEPACK` 和 `AUDIO_SOUNDDATA`。菜单会出现 `ss2000` 与 `fire_q`。不要同时启动原始 Server-Sided-Sounds-and-Sirens 资源，否则会重复注册 `DLC_SERVERSIDEAUDIO` 命名空间。

## 启动与更新

服务器配置不再需要 `yx_siren_audio_modern` 或 `yx_siren_audio_lvc`：

```cfg
ensure RageUI
ensure yx_sirencontrol
```

安装后执行 `restart yx_sirencontrol`，并让玩家重新连接。若客户端仍使用旧音频，让玩家完全退出 FiveM 后再进入以清除本次连接的音频缓存。

安装器拒绝覆盖已有的 `audio/modern` 或 `audio/lvc`。更新包时先停止资源，备份后删除对应安装目录，再用新输入重新运行安装器。安装器会核对 AWC 签名和复制前后的 SHA-256，并最后才写入 `installed-files.json`；标记不存在时，控制器不会把相应音色放进菜单。

安装器不会复制第三方脚本、DLL、README 或可执行文件。不要把安装后的音频提交到本仓库或附加到 GitHub Release；请保留下载包自带的许可和署名。自定义 AWC／REL 的接入方式见 [自定义警笛教程](custom-sirens.md)。

若菜单没有出现对应包，检查 `audio/<包名>/installed-files.json` 和 `fxmanifest.lua` 的受管区块是否存在，再查看启动日志。若菜单出现但无声，检查所用版本、AWC／REL 内部声音名、重复银行挂载和客户端缓存。
