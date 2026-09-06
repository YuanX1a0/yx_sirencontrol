# 外部依赖、素材来源与许可范围

本仓库的专有许可仅覆盖 YuanX1a0 拥有的代码、文档与原创模型。第三方组件由使用者分别取得，仍适用各自的许可；公开提供控制器代码或 DLL 不会改变第三方条款。

## 不随仓库提供的内容

| 内容 | 来源 | 处理方式 |
| --- | --- | --- |
| RageUI 2.0 | [兼容版本目录](https://github.com/TrevorBarns/luxart-vehicle-control/tree/stable/dependencies/RageUI)／[原作者](https://github.com/iTexZoz/RageUI) | 独立下载、安装并遵守所用版本的授权 |
| Modern Siren Pack | [GravelRoadCop／LEDesigns 发布页](https://www.gta5-mods.com/misc/realistic-american-sirens-pack) | 仓库只提供下载链接、音色文本配置和资源内本地安装工具 |
| SS2000／Rumbler／消防录音 | [LVC Extras Mega Pack A](https://github.com/TrevorBarns/luxart-vehicle-control-extras/tree/master/Siren%20Packs/Server%20Sided%20Mega%20Pack%20A%20%285%2B1%29) | 不附带原始或改名录音、音频数据及来源归档 |
| Server-Sided Sounds and Sirens | [fk-1997 项目](https://github.com/fk-1997/Server-Sided-Sounds-and-Sirens) | 用户自行取得完整音频资源，本地原样安装 |
| CitizenFX 程序集 | [FXServer](https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/) | 仅作为外部编译／运行依赖，不复制到本仓库 |
| CodeWalker、SharpDX | [CodeWalker](https://github.com/dexyfex/CodeWalker) | 仅重建原创模型时需要，工具 DLL 不随仓库提供 |
| GTA 动画与游戏资源 | 用户自己的游戏安装 | 仅调用游戏原生接口，不提取或分发游戏文件 |

## RageUI 版本说明

运行所需的是带根目录 `RMenu.lua`、`menu/` 与 `components/` 的 2.0 布局，下载入口为上表所列的 LVC 依赖目录。原作者当前主分支的 `src/` 布局与本控制器 manifest 不兼容，作者链接仅用于来源与授权核对。本仓库不包含任何版本的 RageUI 文件。

控制器兼容此前使用的 RageUI 2.0 API。所核对的旧版本文件头写有非商用限制，而作者后来在 [2023 年版本的 README](https://github.com/ImBaphomettt/RageUI/blob/ca410ccf85220272c5c7f9c689f832612c05a467/README.md) 中允许商业用途。两者存在时间和版本差异；本仓库没有将 RageUI 重新许可为 MIT、GPL 或本项目的专有代码。使用者应确认所下载版本及使用方式的授权，必要时向作者取得明确许可。这里不附带 LVC 的 RageUI 副本，也不附带 LVC 控制器。

## 原创 LED 与动画调用

`stream/yx_movia_d_red*.ydr`、对应 YTYP、几何生成源码及预览图由本项目程序化制作，未从第三方车辆模组提取。品牌、产品名称和参考链接不表示厂商背书；公开仓库的 `docs/beacon-assets.md` 记录了建模和核验过程。

Car Taunt 3 仅使用用户指定的原生动画字典、片段名与调用参数；未附带 RPEmotes 源码。已退役的自定义 YCD、来自第三方的骨骼资料和整套旧动画工具均未纳入上传清单。

## 旧版许可证

原始代码版权归属由仓库所有者确认。当前公开发行仓库采用专有许可；公开可见不等于开放源码许可。先前按 GPL 发布的版本仍保留已经授予接收者的权利。参阅 [GNU 对版权持有者另行许可的说明](https://www.gnu.org/licenses/gpl-faq.en.html#CanDeveloperThirdParty)。
