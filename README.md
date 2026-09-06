# yx_sirencontrol 3.9.1

FiveM 警灯与警笛控制器，提供中文 RageUI 设置菜单、紧急车辆灯笛控制、非紧急车辆便衣警灯，以及可装拆的红色车顶 LED 警灯。

本仓库不包含第三方警笛录音、音频银行、RageUI 源码或游戏动画文件。C# 服务端项目源码不在公开仓库中；发行版只提供运行所需的 `server/yuanx1a0_siren_control.net.dll`。许可见 [LICENSE](LICENSE)，外部来源和下载链接见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 安装

请从 Releases 下载 `yx_sirencontrol-v3.9.1.zip`，不要用 GitHub 自动生成的 Source code 压缩包。正式 ZIP 只有一个 `yx_sirencontrol/` 顶层目录，并且不含测试、模型工具、审查脚本或本地音频。

1. 单独取得 [LVC 提供的兼容 RageUI 2.0 目录](https://github.com/TrevorBarns/luxart-vehicle-control/tree/stable/dependencies/RageUI)，保留其原有署名和许可，资源目录命名为 `RageUI`。该目录应有 `RMenu.lua`、`menu/RageUI.lua` 等文件。
2. 把 ZIP 内的 `yx_sirencontrol` 目录放入服务器 `resources`。目录名必须完全一致，不能带 `-main`、版本号或其他后缀。
3. 开启 OneSync，并按顺序启动：

```cfg
ensure RageUI
ensure yx_sirencontrol
```

资源名检测区分大小写。名称不是 `yx_sirencontrol` 时，客户端、菜单、服务端和便携警灯模块都会停用，并在控制台显示中文错误。

默认只有 GTA 原生警笛。Modern、SS2000／Rumbler 和消防 Q 的音频由使用者自行下载，然后直接安装到本资源的 `audio/` 内；不再创建额外的警笛资源。命令和来源见 [内置可选音频安装说明](docs/audio-installation.md)。

## 操作

| 操作 | 作用 |
| --- | --- |
| `/siren on`、`/siren off` | 为当前车辆启用／关闭控制器 |
| `I` 或 `/sirencontrol` | 打开中文设置菜单，可边驾驶边操作 |
| `Shift+E`、`Shift+Q` | 升／降档：OFF、LIGHT、SIREN |
| `1～5` | LIGHT 时直接开启对应警笛；再次按正在响的数字关笛保灯 |
| 按住 `E`、`R` | 播放各自绑定的手动音色；松开恢复 |
| `/putsiren` | 主驾驶放置／收回便携红色 LED 警灯 |

驾驶员和副驾驶均可控制灯笛及设置。紧急车辆使用自身原生警灯；非紧急汽车需先 `/siren on` 才能打开菜单。每辆车独立控制，不会因操作另一辆车而关闭上一辆车。

菜单可以切换警笛包、设置 1～5 和 E／R 音色、设置下车自动关笛、单独开关持续警笛，并调整便携 LED 位置。方向键选择，Enter 确认，Backspace／Esc 关闭。

## 便携 LED 警灯

非紧急汽车先 `/siren on`，主驾驶输入 `/putsiren`。模块自动识别 ESX／QBCore／Qbox，默认授权职业为 `police`、`ambulance`、`sheriff`。服务端验证权限后播放游戏自带 Car Taunt 3 动作 2 秒，再放置或收回本项目的红色 LED 模型；RPEMOTES 不是运行依赖。

I 菜单可以按左右、前后、高低调整位置，每次 1 cm、各轴 ±200 cm，实时应用并自动保存。偏移以自动车顶落点或 `config/beacon.json` 的车型基础位置为起点。安装状态由服务器同步；个人位置偏移只影响本机显示。`/siren off`、删除车辆或停止资源会清理模型。

## 本地保存与配置

警笛包、逐包 1～5／E／R 绑定、当前模式、下车关笛和 LED 位置使用 FiveM 客户端 KVP 保存。默认按“服务器地址＋车型＋标准化车牌”区分；配置 `Persistence.VehicleIdStateKey` 后优先使用服务器提供的永久车辆 ID。无车牌且无永久 ID 的车辆只在当前会话保存。

运行目录按用途划分：

| 目录 | 内容 |
| --- | --- |
| `client/` | RageUI 菜单、控制器、保存和便携 LED 客户端代码 |
| `server/` | 包含灯笛控制与便携 LED 权限同步的服务端 DLL |
| `config/` | `beacon.json` 与 `sirens/*.json` 文本配置 |
| `audio/` | 本地安装器、教程，以及使用者自己放入的音频 |
| `stream/` | 本项目的红色 LED 运行模型 |
| `docs/` | 安装与自定义教程 |

开发者添加自定义 AWC／REL、注册 `AUDIO_WAVEPACK`／`AUDIO_SOUNDDATA` 并建立菜单 JSON 的完整步骤见 [自定义警笛教程](docs/custom-sirens.md)。

本地模拟回归不能代替 FiveM 实机验证。请在自己的车辆模型和服务端环境中确认音色、动作和车顶贴合。
