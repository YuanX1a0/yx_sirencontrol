-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Copyright (C) 2026 YuanX1a0

fx_version 'cerulean'
game 'gta5'

author 'YuanX1a0'
description '带 RageUI 中文设置菜单的紧急车辆与便衣警灯警笛控制器'
version '3.8.1'

dependencies {
    '/onesync',
    'RageUI'
}

-- Optional packs load only when their RequiredResource is already started.
-- Third-party audio is downloaded by the user and installed outside this repo.
siren_pack 'sirens/builtin.json'
siren_pack 'sirens/ss2000.json'
siren_pack 'sirens/fire_q.json'
siren_pack 'sirens/modern_police.json'
siren_pack 'sirens/modern_lafd.json'

files {
    'beacon-config.json',
    'stream/yx_movia_d_red_glow.ytyp',
    'sirens/builtin.json',
    'sirens/ss2000.json',
    'sirens/fire_q.json',
    'sirens/modern_police.json',
    'sirens/modern_lafd.json'
}

data_file 'DLC_ITYP_REQUEST' 'stream/yx_movia_d_red_glow.ytyp'

client_scripts {
    '@RageUI/RMenu.lua',
    '@RageUI/menu/RageUI.lua',
    '@RageUI/menu/Menu.lua',
    '@RageUI/menu/MenuController.lua',
    '@RageUI/components/Audio.lua',
    '@RageUI/components/Enum.lua',
    '@RageUI/components/Keys.lua',
    '@RageUI/components/Rectangle.lua',
    '@RageUI/components/Sprite.lua',
    '@RageUI/components/Text.lua',
    '@RageUI/components/Visual.lua',
    '@RageUI/menu/elements/ItemsBadge.lua',
    '@RageUI/menu/elements/ItemsColour.lua',
    '@RageUI/menu/elements/PanelColour.lua',
    '@RageUI/menu/items/UIButton.lua',
    '@RageUI/menu/items/UICheckBox.lua',
    '@RageUI/menu/items/UIList.lua',
    '@RageUI/menu/items/UISeparator.lua',
    '@RageUI/menu/items/UISlider.lua',
    '@RageUI/menu/items/UISliderHeritage.lua',
    '@RageUI/menu/items/UISliderProgress.lua',
    '@RageUI/menu/panels/UIColourPanel.lua',
    '@RageUI/menu/panels/UIGridPanel.lua',
    '@RageUI/menu/panels/UIPercentagePanel.lua',
    '@RageUI/menu/panels/UIStatisticsPanel.lua',
    '@RageUI/menu/windows/UIHeritage.lua',
    'menu.lua',
    'config.js',
    'settings.js',
    'beacon.js',
    'client.js'
}

server_script 'server/yuanx1a0_siren_control.net.dll'
server_script 'beacon-server.lua'
