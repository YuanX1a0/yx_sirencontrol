# yx_sirencontrol 3.8.1

FiveM 警灯与警笛控制器，采用中文 RageUI 菜单、JavaScript 客户端和 C# OneSync 服务端。本仓库为公开发布仓库，项目仍采用专有许可，许可见 [LICENSE](LICENSE)。

C# 服务端仅提供运行需要的 `server/yuanx1a0_siren_control.net.dll`，不上传 `.cs`／`.csproj` 源码、C# 测试工程、编译脚本或调试符号。完整 C# 开发工程仅在作者本地保存。FiveM 运行需要的 JS／Lua 脚本、配置与原创模型正常保留。

仓库不包含任何第三方警笛录音、音频银行、RageUI 源码或游戏动画文件。默认可使用 GTA 原生警笛；SS2000／Rumbler、消防 Q 与 Modern 警笛包需使用者从作者页面自行下载并安装。下载链接和完整步骤见 [警笛安装说明](docs/audio-installation.md)。

## 安装

1. 单独取得 [LVC 提供的兼容 RageUI 2.0 目录](https://github.com/TrevorBarns/luxart-vehicle-control/tree/stable/dependencies/RageUI)，保留其原有署名和许可，资源目录命名为 `RageUI`。目录应有 `RMenu.lua`、`menu/RageUI.lua` 等文件。原作者当前主分支采用另一套 `src/` 布局，不能直接替换此版本。版本授权说明见 [外部依赖说明](THIRD-PARTY-NOTICES.md)。
2. 将本仓库作为 `yx_sirencontrol` 放入服务器 `resources`，目录名必须完全一致。已经包含自行编译的 `server/yuanx1a0_siren_control.net.dll`。
3. 开启 OneSync，并按以下顺序启动：

```cfg
ensure RageUI
# 可选音频资源安装后，在控制器之前启动：
# ensure yx_siren_audio_modern
# ensure yx_siren_audio_lvc
ensure yx_sirencontrol
```

没有安装可选音频时，菜单只显示 GTA 原生包；可选资源启动后重启控制器，才会注册对应菜单包。旧本地档案引用尚未安装的音频包时，自动回退到可用包。

资源目录名必须严格为 **`yx_sirencontrol`**，区分大小写。`YX_SIRENCONTROL`、`yx_sirencontrol-main` 或其他改名都不能使用：客户端、菜单、服务端和便携警灯模块分别检查实际资源名，名称不符时输出中文错误，不注册本资源的控制命令、事件或功能接口。检测不使用可配置的显示标题。FiveM 仍可能显示该资源处于启动状态，但灯笛控制、I 菜单和 `/putsiren` 均不会启用。

GitHub ZIP 解压后请先去掉目录的 `-main` 后缀；如果已经以错误名称启动，请在服务器控制台停止该名称的资源，将目录恢复为 `yx_sirencontrol`，再执行 `refresh` 和 `ensure yx_sirencontrol`。

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

菜单支持切换警笛包、设置 1～5 和 E／R 音色、下车自动关笛、单独开关持续警笛。方向键选择，Enter 确认，Backspace／Esc 关闭。最后一名前排乘员下车时，根据当前设置决定是否关笛保灯。

## 便携 LED 警灯

非紧急汽车先 `/siren on`，主驾驶输入 `/putsiren`。默认自动检测 ESX／QBCore／Qbox，授权职业为 `police`、`ambulance`、`sheriff`。服务端验证权限后播放游戏自带 Car Taunt 3 动作 2 秒，放置或收回原创红色 LED 警灯。RPEMOTES 不属于运行依赖。

I 菜单的“便携 LED 位置”可调左右、前后、高低：每次 1 cm，各轴 ±200 cm，实时应用并自动保存。未安装时可预设，下次放置生效；装拆期间暂时禁止调整。“重置 LED 位置”只清除位置偏移。位置是相对自动车顶落点或 `beacon-config.json` 的 `MountOffsets` 的增量，正数分别向右、向前、向上。

安装状态由服务器同步；个人位置偏移只影响本机显示，不覆盖其他玩家的本地设置。`/siren off`、删除车辆或停止资源会清理模型。模型与动作详情见 [便携警灯说明](docs/beacon-assets.md)。

## 本地保存与配置

使用 FiveM 客户端 KVP 保存警笛包、逐包按键绑定、当前模式、下车关笛选项与 LED 位置。默认按“服务器地址＋车型＋标准化车牌”区分；配置 `Persistence.VehicleIdStateKey` 后优先使用服务器提供的永久车辆 ID。重连可恢复。

同车型、同车牌的两辆车必须提供不同永久 ID 才能区分；无车牌、无永久 ID 时只保留当前会话。原有警笛设置重置会保留 LED 位置。

- `config.js`：按键、HUD、紧急车型、默认包和持久化标识。
- `beacon-config.json`：职业、框架、车顶基础位置、模型、闪光和照明参数。
- `sirens/*.json`：文本音色定义。带 `RequiredResource` 的包仅在指定资源已经启动时加载。

开发者接入新的外部警笛资源见 [自定义警笛包](docs/custom-sirens.md)。

## 发布检查

运行无需编译 C#；使用包内已有 DLL。本地 C# 编译与测试由作者在未上传的开发工程中完成。发布仓库可以执行以下 JS／Lua 回归和文件审查：

```powershell
node --test --test-isolation=none tests/client.test.js tests/beacon.test.js
npx --yes --package fengari-node-cli fengari tests/menu.test.lua
npx --yes --package fengari-node-cli fengari tests/beacon-server.test.lua
python tests/release-audit.test.py
python tools/audit-release.py
```

`release-files.json` 是允许上传的完整文件清单。新增文件需先审查来源，再显式加入清单；`.gitignore` 和上传检查会拒绝 C# 源码与工程、音频、来源归档、调试符号、个人配置及未审核文件。本发布分支从新的 Git 历史建立，不沿用含 C# 源码的旧提交，也不包含旧安装包或第三方素材历史。

本地模拟回归与模型检查不能代替 FiveM 实机验证。使用者应在自己的车辆模型和服务端环境中确认音色、动作及贴合。
