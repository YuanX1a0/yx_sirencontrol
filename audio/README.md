# 警笛音频放置目录

所有警笛音频都安装在 **`yx_sirencontrol` 资源内部**，不需要再创建或 `ensure` 一个警笛音频资源。

本目录随发行版只包含安装工具和说明，不包含第三方录音、AWC、REL 或原作者压缩包。请从作者页面自行下载并确认许可：

- Modern Siren Pack／Realistic American Sirens Pack：运行 `audio/install.ps1 -Pack Modern`。
- LVC 的 SS2000／Rumbler／消防 Q：运行 `audio/install.ps1 -Pack Lvc`。
- 其他自定义包：放入 `audio/custom/<包名>/`，并在主 `fxmanifest.lua` 中注册。

完整命令、目录示例和故障检查见：

- [Modern／LVC 安装说明](../docs/audio-installation.md)
- [自定义警笛教程](../docs/custom-sirens.md)

安装或修改音频后，重启 `yx_sirencontrol`。服务器配置只需要：

```cfg
ensure RageUI
ensure yx_sirencontrol
```
