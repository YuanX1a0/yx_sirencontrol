# 在 `yx_sirencontrol` 内添加自定义警笛

本教程用于已经取得合法使用权、并且已经编译成 FiveM 可加载格式的警笛包。最终文件直接放在 `yx_sirencontrol` 内，不要再建立单独的音频资源。

FiveM 运行时需要 `.awc` 和 `.dat54.rel`／`.dat151.rel`。WAV、MP3、OAC、XML 和 OpenFormats 工程不能直接播放，需要先按声音包作者的工具链编译。给文件改名也不会改变其内部银行、soundset 或声音名称。

## 1. 建立独立目录

每个包使用自己的短名称。本例使用 `my_pack`：

```text
yx_sirencontrol/
├─ audio/
│  └─ custom/
│     └─ my_pack/
│        ├─ data/
│        │  ├─ my_pack_sounds.dat54.rel
│        │  └─ my_pack_game.dat151.rel      # 只有原包提供时才需要
│        └─ sfx/
│           └─ dlc_my_pack/
│              └─ *.awc
└─ config/
   └─ sirens/
      └─ my_pack.json
```

不要混用不同包的 REL 和 AWC。`dlc_my_pack` 应采用不会与其他资源冲突的 wavepack 名称。

## 2. 在主 manifest 注册音频

打开资源根目录的 `fxmanifest.lua`，在 `Add custom AUDIO_* registrations below` 注释下加入：

```lua
files {
    'audio/custom/my_pack/data/my_pack_sounds.dat54.rel',
    'audio/custom/my_pack/data/my_pack_game.dat151.rel',
    'audio/custom/my_pack/sfx/dlc_my_pack/*.awc',
    'config/sirens/my_pack.json'
}

data_file 'AUDIO_WAVEPACK' 'audio/custom/my_pack/sfx/dlc_my_pack'
data_file 'AUDIO_SOUNDDATA' 'audio/custom/my_pack/data/my_pack_sounds.dat'
data_file 'AUDIO_GAMEDATA' 'audio/custom/my_pack/data/my_pack_game.dat'

siren_pack 'config/sirens/my_pack.json'
```

实际文件保留 `.dat54.rel` 和 `.dat151.rel` 后缀；`AUDIO_SOUNDDATA`／`AUDIO_GAMEDATA` 的注册值按 FiveM 约定写成结尾 `.dat` 的逻辑路径。原包没有 `.dat151.rel` 时，删掉示例中的该文件和整行 `AUDIO_GAMEDATA`。

`files` 可以用 `*.awc`，但每个 `AUDIO_WAVEPACK` 目录和每份 REL 仍须明确注册，所以不能只把任意文件丢进目录而完全不改 manifest。

## 3. 创建菜单音色 JSON

把以下示例保存为 `config/sirens/my_pack.json`：

```json
{
  "Id": "my_pack",
  "Label": "我的警笛包",
  "AudioBanks": ["DLC_MY_PACK\\MY_PACK"],
  "ManualHorn": {
    "Label": "气喇叭",
    "SoundName": "MY_HORN",
    "SoundSet": "MY_SOUNDSET"
  },
  "DefaultSlots": ["wail", "yelp", "priority", "hilo", "pulse"],
  "Tones": [
    {
      "Id": "wail",
      "Label": "Wail（长鸣）",
      "Type": "continuous",
      "SoundName": "MY_WAIL",
      "SoundSet": "MY_SOUNDSET"
    },
    {
      "Id": "yelp",
      "Label": "Yelp（急促）",
      "Type": "continuous",
      "SoundName": "MY_YELP",
      "SoundSet": "MY_SOUNDSET"
    },
    {
      "Id": "priority",
      "Label": "Priority（优先）",
      "Type": "continuous",
      "SoundName": "MY_PRIORITY",
      "SoundSet": "MY_SOUNDSET"
    },
    {
      "Id": "hilo",
      "Label": "Hi-Lo（高低音）",
      "Type": "alternate",
      "SwitchMs": 650,
      "Sounds": [
        { "SoundName": "MY_HILO_HIGH", "SoundSet": "MY_SOUNDSET" },
        { "SoundName": "MY_HILO_LOW", "SoundSet": "MY_SOUNDSET" }
      ]
    },
    {
      "Id": "pulse",
      "Label": "Pulse（脉冲）",
      "Type": "pulse",
      "SoundName": "MY_YELP",
      "SoundSet": "MY_SOUNDSET",
      "OnMs": 180,
      "OffMs": 120
    }
  ]
}
```

必须把 `AudioBanks`、`SoundName` 和 `SoundSet` 换成 AWC／REL 实际导出的内部名称，大小写也保持一致：

- `AudioBanks` 是客户端需要请求的银行列表；没有额外银行请求时可写 `[]`。
- `ManualHorn` 是菜单中 E 键默认的手动鸣笛；省略时回退到 GTA 原生气喇叭。
- `DefaultSlots` 必须正好有 5 项，对应数字 1～5，且每项都是本文件 `Tones` 中存在的 `Id`。
- `continuous` 持续循环；`pulse` 需要至少 50 ms 的 `OnMs` 和至少 30 ms 的 `OffMs`；`alternate` 需要至少 100 ms 的 `SwitchMs` 和一个非空 `Sounds` 数组。
- `Id` 使用小写字母、数字、下划线或连字符，长度不超过 64，且在所有包中唯一。

自定义包通常不需要 `RequiredFile`，因为音频与 JSON 由你一起安装。若希望音频未放齐时隐藏菜单，可以加入：

```json
"RequiredFile": "audio/custom/my_pack/installed-files.json"
```

同时把该标记加入 manifest 的 `files`，并在音频准备完成后创建一个非空的 `installed-files.json`。这个标记只控制菜单是否注册，不会验证声音内容。

## 4. 重启并设置按键

保存后重启主资源：

```text
restart yx_sirencontrol
```

不需要添加其他 `ensure`。进入游戏后在车辆内输入 `/siren on`，按 `I` 打开中文菜单，选择新包，并为 1～5、E、R 分别绑定音色。设置按服务器、车型和车辆标识在本机独立保存。

菜单没有新包时，检查 `siren_pack` 路径、JSON 语法、`Id` 和可选 `RequiredFile`。菜单存在但没有声音时，优先核对 REL 中的 bank／soundset／sound 名称、`AUDIO_*` 类型、wavepack 路径和是否有其他资源重复注册同一命名空间。修改音频后仍听到旧声音时，完全退出 FiveM 后重新连接。

只在自己的服务器资源副本中放置你有权使用的音频。Git 会忽略 `audio/modern`、`audio/lvc` 和 `audio/custom`，官方发行 ZIP 也不会包含这些本地文件。
