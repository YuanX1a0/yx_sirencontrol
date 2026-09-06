-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Copyright (C) 2026 YuanX1a0

fx_version 'cerulean'
game 'gta5'

author 'YuanX1a0'
description '带 RageUI 中文设置菜单的紧急车辆与便衣警灯警笛控制器'
version '3.9.0'

dependencies {
    '/onesync',
    'RageUI'
}

-- Siren profiles live in this resource. Optional audio is installed under audio/.
siren_pack 'config/sirens/builtin.json'
siren_pack 'config/sirens/ss2000.json'
siren_pack 'config/sirens/fire_q.json'
siren_pack 'config/sirens/modern_police.json'
siren_pack 'config/sirens/modern_lafd.json'

files {
    'config/beacon.json',
    'stream/yx_movia_d_red_glow.ytyp',
    'config/sirens/builtin.json',
    'config/sirens/ss2000.json',
    'config/sirens/fire_q.json',
    'config/sirens/modern_police.json',
    'config/sirens/modern_lafd.json'
}

data_file 'DLC_ITYP_REQUEST' 'stream/yx_movia_d_red_glow.ytyp'

-- BEGIN YX_AUDIO_MODERN
-- audio/install.ps1 writes this managed block after Modern audio is installed.
-- END YX_AUDIO_MODERN

-- BEGIN YX_AUDIO_LVC
-- audio/install.ps1 writes this managed block after LVC audio is installed.
-- END YX_AUDIO_LVC

-- Add custom AUDIO_* registrations below. See audio/README.md.

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
    'client/menu.lua',
    'client/config.js',
    'client/settings.js',
    'client/beacon.js',
    'client/main.js'
}

server_script 'server/yuanx1a0_siren_control.net.dll'
server_script 'server/beacon.lua'
