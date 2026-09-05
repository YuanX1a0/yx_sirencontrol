# 接入自行取得授权的警笛包

先按声音作者提供的方式安装独立 FiveM 音频资源。资源需要自行注册 `AUDIO_WAVEPACK` 和声音定义；一个新的标签或 JSON 不会自动产生音频。

本控制器只需要文本配置。例如：

```json
{
  "Id": "my_siren",
  "Label": "我的警笛包",
  "RequiredResource": "my_siren_audio",
  "AudioBanks": ["DLC_MY_SIREN\\MY_SIREN"],
  "ManualHorn": {
    "Label": "气喇叭",
    "SoundName": "MY_HORN",
    "SoundSet": "MY_SOUNDSET"
  },
  "DefaultSlots": ["wail", "wail", "wail", "wail", "wail"],
  "Tones": [
    {
      "Id": "wail",
      "Label": "长鸣",
      "Type": "continuous",
      "SoundName": "MY_WAIL",
      "SoundSet": "MY_SOUNDSET"
    }
  ]
}
```

把示例中的银行、soundset 和声音名称替换为声音包实际导出的名称，存入 `sirens/my_siren.json`，再同时加入 `fxmanifest.lua` 的 `siren_pack` 与 `files`。

`RequiredResource` 必须是实际资源名，且在控制器启动前处于 `started` 状态。客户端和服务端采用相同检查。不要写磁盘路径、URL 或临时车辆 ID。省略此字段适用于不依赖外部资源的原生声音包。

先启动音频资源，再启动／重启 `yx_sirencontrol`。菜单出现新包后，每位玩家可在当前车辆的设置中选择，并分别保存 1～5、E、R 绑定。音频加载失败时应检查实际注册名称与资源状态；本地 JSON 通过校验不代表音频已实机出声。

只将自行拥有版权或获得相应许可的文本配置加入本发布仓库；音频留在仓库外，并保留作者要求的署名及条款。
