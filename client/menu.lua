-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Copyright (C) 2026 YuanX1a0
-- RageUI renders this menu. State and per-vehicle persistence belong to client/main.js.

local EXPECTED_RESOURCE_NAME = 'yx_sirencontrol'
local currentResourceName = tostring(GetCurrentResourceName() or '')
if currentResourceName ~= EXPECTED_RESOURCE_NAME then
    print(('[yx_sirencontrol] 资源名验证失败：当前资源名为 "%s"，资源目录必须命名为 "%s"。菜单已停用。')
        :format(currentResourceName, EXPECTED_RESOURCE_NAME))
    return
end

local view, rows = nil, {}
local visible = false
local mainMenu

local MENU_TYPE = 'yx_sirencontrol'
local MENU_NAME = 'main'
local MENU_PAGE_SIZE = 10
local MENU_NAVIGATION_CONTROLS = { 27, 99, 172, 173, 174, 175 }
local VEHICLE_CONTROLS = { 59, 63, 64, 71, 72, 76 }
local BEACON_OFFSET_OPTIONS = {}
for centimetres = -200, 200 do
    BEACON_OFFSET_OPTIONS[#BEACON_OFFSET_OPTIONS + 1] = {
        id = centimetres, label = ('%+d cm'):format(centimetres)
    }
end

local function offsetCentimetres(value)
    value = tonumber(value)
    if not value or value ~= value or value == math.huge or value == -math.huge then return 0 end
    value = math.max(-2, math.min(2, value)) * 100
    return value >= 0 and math.floor(value + 0.5) or math.ceil(value - 0.5)
end

local function safeText(value, fallback)
    if type(value) ~= 'string' or value == '' then value = fallback or '' end
    -- GTA text commands interpret ~...~ directives even when the source is a label.
    value = value:gsub('~[^~]*~', ''):gsub('~', ''):gsub('%c', ' ')
    local ok, length = pcall(utf8.len, value)
    if not ok or not length then value = value:gsub('[\128-\255]', '?') end
    local limit = utf8.offset(value, 513)
    if limit then value = value:sub(1, limit - 1) end
    return value
end

local function identifier(value)
    return type(value) == 'string' and value or ''
end

local function choices(items)
    local result = {}
    if type(items) ~= 'table' then return result end
    for _, item in ipairs(items) do
        if type(item) == 'table' and type(item.id) == 'string' and item.id ~= '' then
            result[#result + 1] = { id = item.id, label = safeText(item.label, item.id) }
        end
    end
    return result
end

local function normalizeView(payload)
    if type(payload) == 'string' then
        local ok, decoded = pcall(json.decode, payload)
        if not ok then return nil end
        payload = decoded
    end
    if type(payload) ~= 'table' then return nil end

    local vehicle = tonumber(payload.vehicle)
    if not vehicle or vehicle <= 0 or vehicle % 1 ~= 0 then return nil end

    local stage, slot = tonumber(payload.stage) or 0, tonumber(payload.slot) or 1
    if stage ~= stage or slot ~= slot then return nil end

    local bindings = {}
    for index = 1, 5 do
        bindings[index] = type(payload.bindings) == 'table' and identifier(payload.bindings[index]) or ''
    end

    local beacon
    if payload.isEmergency ~= true and payload.enabled == true and type(payload.beacon) == 'table' then
        local offset = type(payload.beacon.offset) == 'table' and payload.beacon.offset or {}
        beacon = {
            centimetres = { x = offsetCentimetres(offset.x), y = offsetCentimetres(offset.y), z = offsetCentimetres(offset.z) },
            busy = payload.beacon.busy == true
        }
    end

    return {
        vehicle = vehicle,
        networkId = tonumber(payload.networkId) or 0,
        vehicleLabel = safeText(payload.vehicleLabel, '当前车辆'),
        vehicleKey = safeText(payload.vehicleKey),
        isEmergency = payload.isEmergency == true,
        enabled = payload.enabled == true,
        beacon = beacon,
        stage = math.max(0, math.min(2, math.floor(stage))),
        parkKill = payload.parkKill == true,
        sirenMuted = payload.sirenMuted == true,
        packId = identifier(payload.packId),
        slot = math.max(1, math.min(5, math.floor(slot))),
        bindings = bindings,
        packs = choices(payload.packs),
        tones = choices(payload.tones),
        manualTones = choices(payload.manualTones),
        manualBindings = {
            e = type(payload.manualBindings) == 'table' and identifier(payload.manualBindings.e) or '',
            r = type(payload.manualBindings) == 'table' and identifier(payload.manualBindings.r) or ''
        }
    }
end

local function canInteract(current)
    if not current or IsPauseMenuActive() then return false end
    if not current.isEmergency and not current.enabled then return false end
    if type(IsNuiFocused) == 'function' and IsNuiFocused() then return false end

    local ped = PlayerPedId()
    if not DoesEntityExist(ped) or not DoesEntityExist(current.vehicle) or IsEntityDead(ped) then return false end
    if GetVehiclePedIsIn(ped, false) ~= current.vehicle then return false end
    if GetPedInVehicleSeat(current.vehicle, -1) ~= ped and GetPedInVehicleSeat(current.vehicle, 0) ~= ped then
        return false
    end

    return current.networkId <= 0 or NetworkGetNetworkIdFromEntity(current.vehicle) == current.networkId
end

local function optionIndex(options, id)
    for index, option in ipairs(options) do
        if option.id == id then return index end
    end
    return 1
end

local function makeRows(current)
    local result = {
        {
            kind = 'checkbox', label = '控制器开关', action = 'enabled', value = current.enabled,
            description = '开启或关闭当前车辆的警灯和警笛控制。'
        },
        {
            kind = 'list', label = '警灯档位', action = 'stage', index = current.stage + 1,
            enabled = current.enabled,
            options = {
                { id = 0, label = '关闭' },
                { id = 1, label = '1 - 仅警灯' },
                { id = 2, label = '2 - 警灯和警笛' }
            },
            description = current.enabled
                and '关闭：灯笛全关；1 档：仅警灯；2 档：警灯和警笛。LIGHT 时按 1～5 可直接开启对应警笛。'
                or '请先开启控制器，再调整警灯档位。'
        },
        {
            kind = 'checkbox', label = '警笛开关', action = 'sirenEnabled',
            enabled = current.enabled and current.stage == 2,
            value = current.enabled and current.stage == 2 and not current.sirenMuted,
            description = current.enabled and current.stage == 2
                and '在保留 2 档和警灯的情况下单独开启或关闭警笛，当前模式不会改变。'
                or 'LIGHT 时按 1～5 可直接开笛；此开关在持续警笛档位可用。'
        },
        {
            kind = 'checkbox', label = '下车自动关笛', action = 'parkKill', value = current.parkKill,
            description = '最后一名前排乘员下车后自动关笛保灯；驾驶员或副驾驶仍在车内时保持警笛。'
        },
        {
            kind = 'list', label = '警笛包', action = 'pack', index = optionIndex(current.packs, current.packId),
            options = current.packs,
            description = '选择当前车辆使用的警笛包，并保存到本地。'
        },
        {
            kind = 'list', label = '当前警笛模式', action = 'slot', index = current.slot,
            valueSuffix = current.sirenMuted and '（已关笛）' or '',
            options = {
                { id = 1, label = '1' }, { id = 2, label = '2' }, { id = 3, label = '3' },
                { id = 4, label = '4' }, { id = 5, label = '5' }
            },
            description = current.sirenMuted
                and '警笛当前关闭，所选模式已保留；在 2 档重新选择即可恢复。'
                or '选择当前警笛模式；2 档下会立即播放。'
        }
    }

    for slot = 1, 5 do
        result[#result + 1] = {
            kind = 'list', label = '数字键 ' .. slot .. ' 音色', action = 'binding', extra = slot,
            index = optionIndex(current.tones, current.bindings[slot]), options = current.tones,
            description = '设置数字键 ' .. slot .. ' 的音色，并保存到当前车辆。'
        }
    end

    result[#result + 1] = {
        kind = 'list', label = 'E 键音色', action = 'manualBinding', extra = 'e',
        index = optionIndex(current.manualTones, current.manualBindings.e), options = current.manualTones,
        description = '在关闭、1 档或 2 档时按住 E 播放，松开后恢复；Shift+E 升档，同时按 E/R 时 E 优先。'
    }
    result[#result + 1] = {
        kind = 'list', label = 'R 键音色', action = 'manualBinding', extra = 'r',
        index = optionIndex(current.manualTones, current.manualBindings.r), options = current.manualTones,
        description = '在关闭、1 档或 2 档时按住 R 播放，松开后恢复；同时按 E/R 时 E 优先。'
    }
    result[#result + 1] = {
        kind = 'button', label = '重置当前车辆设置', action = 'reset', value = '重置',
        description = '恢复当前车辆的默认警笛包、按键绑定和下车关笛设置。'
    }

    for index, row in ipairs(result) do
        row.section = index <= 2 and '警灯控制'
            or (index == #result and '存储管理' or '警笛设置')
    end
    if current.beacon then
        local busy = current.beacon.busy
        local busyDescription = '正在放置或收回 LED 警灯，请等待动作完成后再调整位置。'
        for _, axis in ipairs({
            { id = 'x', label = 'LED 左右位置', direction = '负值向左，正值向右。' },
            { id = 'y', label = 'LED 前后位置', direction = '负值向后，正值向前。' },
            { id = 'z', label = 'LED 高低位置', direction = '负值降低，正值升高。' }
        }) do
            result[#result + 1] = {
                kind = 'list', section = '便携 LED 位置', label = axis.label,
                action = 'beaconOffset', extra = axis.id, enabled = not busy,
                index = current.beacon.centimetres[axis.id] + 201, options = BEACON_OFFSET_OPTIONS,
                description = busy and busyDescription or ('相对自动或配置的车顶放置点，每次调整 1 cm。' .. axis.direction
                    .. '自动保存到当前车辆的本地档案；已安装时实时生效，未安装时用于下次 /putsiren。')
            }
        end
        result[#result + 1] = {
            kind = 'button', section = '便携 LED 位置', label = '重置 LED 位置',
            action = 'beaconReset', enabled = not busy, value = '重置',
            description = busy and busyDescription
                or '仅将当前车辆的 LED 相对位置归零并自动保存到本地，恢复自动或配置的放置点；其他警灯警笛设置保持不变。'
        }
    end
    return result
end

local function setVisibility(value)
    if visible == value then return end
    visible = value
    TriggerEvent('yx_sirencontrol:menu:visibility', value)
end

local function closeMenu()
    if mainMenu and RageUI.Visible(mainMenu) then RageUI.Visible(mainMenu, false) end
    view, rows = nil, {}
    setVisibility(false)
end

local function sendAction(row, value)
    if not visible or not canInteract(view) then
        closeMenu()
        return false
    end
    if row.enabled == false then return false end
    if row.action == 'beaconOffset' or row.action == 'beaconReset' then
        -- Re-check the latest view because RageUI may still hold a callback from
        -- the frame before an action became busy or the LED section disappeared.
        if not view.beacon or view.beacon.busy or view.isEmergency or not view.enabled then return false end
    end
    TriggerEvent('yx_sirencontrol:menu:action', row.action, value, row.extra)
    return true
end

local function listLabels(row)
    local labels = {}
    for index, option in ipairs(row.options) do
        labels[index] = option.label .. (row.valueSuffix or '')
    end
    return labels
end

local function selectListValue(row, index)
    local option = row.options[index]
    if not option then return end
    row.index = index
    sendAction(row, option.id)
end

local function drawRow(row)
    local enabled = row.enabled ~= false
    if row.kind == 'checkbox' then
        RageUI.Checkbox(row.label, row.description, row.value == true, { Enabled = enabled }, {
            onChecked = function() sendAction(row, true) end,
            onUnChecked = function() sendAction(row, false) end
        })
        return
    end

    if row.kind == 'list' then
        if #row.options == 0 then
            RageUI.Button(row.label, row.description, { RightLabel = '无可用选项' }, false, {})
            return
        end
        RageUI.List(row.label, listLabels(row), row.index, row.description, {}, enabled, {
            onListChange = function(index) selectListValue(row, index) end,
            onSelected = function(index) selectListValue(row, index) end
        })
        return
    end

    RageUI.Button(row.label, row.description, { RightLabel = row.value or '' }, enabled, {
        onSelected = function() sendAction(row, nil) end
    })
end

local function drawMenuItems()
    local previousSection
    for _, row in ipairs(rows) do
        if row.section ~= previousSection then
            RageUI.Separator(row.section)
            previousSection = row.section
        end
        drawRow(row)
    end
end

local function preserveDrivingControls()
    -- These are the same navigation controls used by RageUI/LVC. Vehicle controls
    -- remain available, so the menu can be operated while driving.
    for _, control in ipairs(MENU_NAVIGATION_CONTROLS) do
        DisableControlAction(0, control, true)
    end
    for _, control in ipairs(VEHICLE_CONTROLS) do
        EnableControlAction(0, control, true)
    end
end

RMenu.Add(MENU_TYPE, MENU_NAME, RageUI.CreateMenu('警灯警笛控制', '当前车辆设置'))
mainMenu = RMenu:Get(MENU_TYPE, MENU_NAME)
mainMenu.EnableMouse = false
mainMenu:SetRectangleBanner(23, 75, 145, 255)
-- iTexZoz RageUI 2.0.0 clears Sprite for rectangle banners, but its Banner()
-- renderer still dereferences Sprite.Dictionary. Keep a false dictionary
-- sentinel so this resource can retain the blue rectangle without patching the
-- shared RageUI resource used by other scripts.
if mainMenu.Sprite == nil then mainMenu.Sprite = { Dictionary = false } end
mainMenu:DisplayGlare(false)
mainMenu:SetTotalItemsPerPage(MENU_PAGE_SIZE)
mainMenu.Closed = function() closeMenu() end

AddEventHandler('yx_sirencontrol:menu:open', function(payload)
    local nextView = normalizeView(payload)
    if not canInteract(nextView) then
        closeMenu()
        return
    end

    if not visible then
        mainMenu.Index = 1
        mainMenu.Pagination.Minimum = 1
        mainMenu.Pagination.Maximum = mainMenu.Pagination.Total
    end

    view, rows = nextView, makeRows(nextView)
    if not RageUI.Visible(mainMenu) then RageUI.Visible(mainMenu, true) end
    setVisibility(true)
end)

AddEventHandler('yx_sirencontrol:menu:close', closeMenu)

AddEventHandler('yx_sirencontrol:menu:update', function(payload)
    if not visible then return end
    local nextView = normalizeView(payload)
    if not nextView or not view or nextView.vehicle ~= view.vehicle
        or nextView.networkId ~= view.networkId or not canInteract(nextView) then
        closeMenu()
        return
    end
    view, rows = nextView, makeRows(nextView)
end)

AddEventHandler('onResourceStop', function(resourceName)
    if resourceName == GetCurrentResourceName() then closeMenu() end
end)

CreateThread(function()
    while true do
        if visible then
            if not canInteract(view) then
                closeMenu()
            else
                preserveDrivingControls()
                RageUI.IsVisible(mainMenu, drawMenuItems)
                -- RageUI.CloseAll() does not call Menu.Closed, so repair our local
                -- visibility state if another resource closes all menus.
                if visible and not RageUI.Visible(mainMenu) then closeMenu() end
            end
            Wait(0)
        else
            Wait(150)
        end
    end
end)
