-- Run from the resource directory:
-- npm exec --yes --package=fengari-node-cli -- fengari tests/menu.test.lua
--
-- Integration-style unit test for menu.lua. It supplies the public RageUI
-- 2.0.0 surface used by the resource, without requiring a game runtime.

local manifestDependencies, manifestClientScripts = {}, {}
fx_version = function() end
game = function() end
author = function() end
description = function() end
version = function() end
dependencies = function(items) manifestDependencies = items end
siren_pack = function() end
files = function() end
data_file = function() return function() end end
client_scripts = function(items) manifestClientScripts = items end
server_script = function() end
dofile('fxmanifest.lua')
local dependencySet = {}
for _, name in ipairs(manifestDependencies) do dependencySet[name] = true end
assert(dependencySet.RageUI, 'fxmanifest.lua must declare the RageUI dependency')
local scriptIndexes = {}
for index, path in ipairs(manifestClientScripts) do scriptIndexes[path] = index end
for _, path in ipairs({
    '@RageUI/RMenu.lua', '@RageUI/menu/RageUI.lua', '@RageUI/menu/Menu.lua',
    '@RageUI/menu/MenuController.lua', '@RageUI/menu/items/UIButton.lua',
    '@RageUI/menu/items/UICheckBox.lua', '@RageUI/menu/items/UIList.lua',
    '@RageUI/menu/items/UISeparator.lua'
}) do
    assert(scriptIndexes[path], 'fxmanifest.lua is missing ' .. path)
end
assert(scriptIndexes['client/menu.lua'] > scriptIndexes['@RageUI/menu/items/UIList.lua'],
    'client/menu.lua must load after the RageUI library scripts')

local handlers, events, threads, waits = {}, {}, {}, {}
local disabledThisFrame, enabledThisFrame = {}, {}
local disableAllCount, renderItems = 0, {}
local currentVehicle, networkId = 42, 88
local driver, frontPassenger, rearPassenger = 1, 0, 0
local paused, nui, dead, vehicleExists = false, false, false, true
local resourceName = 'yx_sirencontrol'

local payload = {
    vehicle = 42, networkId = 88, vehicleLabel = 'POLICE / UNIT 7', vehicleKey = 'VIN:7',
    isEmergency = true, enabled = true, stage = 1, parkKill = true, sirenMuted = false,
    packId = 'builtin', slot = 2, bindings = { 'wail', 'wail', 'wail', 'wail', 'wail' },
    packs = { { id = 'builtin', label = 'GTA V' }, { id = 'ss2000', label = 'SS2000' } },
    tones = { { id = 'wail', label = 'WAIL' }, { id = 'yelp', label = 'YELP' } },
    manualTones = {
        { id = '@horn', label = 'AIRHORN' }, { id = 'wail', label = 'WAIL' },
        { id = 'yelp', label = 'YELP' }
    },
    manualBindings = { e = '@horn', r = 'wail' }
}

local function copyPayload(source)
    local result = {}
    for key, value in pairs(source) do
        if type(value) == 'table' then
            result[key] = {}
            for childKey, childValue in pairs(value) do
                if type(childValue) == 'table' then
                    result[key][childKey] = {}
                    for itemKey, itemValue in pairs(childValue) do result[key][childKey][itemKey] = itemValue end
                else result[key][childKey] = childValue end
            end
        else result[key] = value end
    end
    return result
end

json = { decode = function(value)
    if value == 'valid' then return payload end
    if value == 'other' then
        local other = copyPayload(payload)
        other.vehicle, other.networkId = 43, 89
        return other
    end
    error('invalid JSON')
end }

function AddEventHandler(name, callback) handlers[name] = callback end
function TriggerEvent(name, ...)
    local args = { ... }
    events[#events + 1] = { name = name, args = args }
    if name ~= 'yx_sirencontrol:menu:action' then return end
    local action, value, extra = args[1], args[2], args[3]
    if action == 'enabled' or action == 'stage' or action == 'parkKill' or action == 'slot' then
        payload[action] = value
    elseif action == 'sirenEnabled' then payload.sirenMuted = not value
    elseif action == 'pack' then payload.packId = value
    elseif action == 'binding' then payload.bindings[extra] = value
    elseif action == 'manualBinding' then payload.manualBindings[extra] = value
    elseif action == 'beaconOffset' then payload.beacon.offset[extra] = value / 100
    elseif action == 'beaconReset' then payload.beacon.offset = { x = 0, y = 0, z = 0 } end
    -- client.js returns an authoritative view after each menu action.
    handlers['yx_sirencontrol:menu:update']('valid')
end

function CreateThread(callback) threads[#threads + 1] = coroutine.create(callback) end
function Wait(milliseconds) waits[#waits + 1] = milliseconds; coroutine.yield(milliseconds) end
function PlayerPedId() return 1 end
function IsPauseMenuActive() return paused end
function IsNuiFocused() return nui end
function IsEntityDead() return dead end
function DoesEntityExist(entity) if entity == 1 then return true end; return vehicleExists end
function GetVehiclePedIsIn() return currentVehicle end
function GetPedInVehicleSeat(_, seat)
    if seat == -1 then return driver end
    if seat == 0 then return frontPassenger end
    return rearPassenger
end
function NetworkGetNetworkIdFromEntity() return networkId end
function GetCurrentResourceName() return resourceName end
function DisableAllControlActions() disableAllCount = disableAllCount + 1 end
function DisableControlAction(group, id)
    local key = group .. ':' .. id
    disabledThisFrame[key] = (disabledThisFrame[key] or 0) + 1
end
function EnableControlAction(group, id)
    local key = group .. ':' .. id
    enabledThisFrame[key] = (enabledThisFrame[key] or 0) + 1
end

-- Minimal RageUI 2.0.0 mock -------------------------------------------------
local rageCalls = {
    createMenu = 0, add = 0, get = 0, visible = {}, isVisible = 0,
    separators = 0, buttons = 0, checkboxes = 0, lists = 0
}
local menuMethods = {}
function menuMethods:SetRectangleBanner(r, g, b, a)
    self.Rectangle = { R = r, G = g, B = b, A = a }
    -- Match iTexZoz RageUI 2.0.0 exactly. Its renderer dereferences Sprite even
    -- though this method clears it, which caused the real menu-open crash.
    self.Sprite = nil
end
function menuMethods:SetTotalItemsPerPage(value) self.Pagination.Total = value end
function menuMethods:DisplayGlare(value) self.Display.Glare = value end
function menuMethods:DisplayInstructionalButton(value) self.Display.InstructionalButton = value end
function menuMethods:DisplayHeader(value) self.Display.Header = value end
function menuMethods:SetTitle(value) self.Title = value end
function menuMethods:SetSubtitle(value) self.Subtitle = value end

RMenu = { registry = {} }
function RMenu.Add(kind, name, menu)
    rageCalls.add = rageCalls.add + 1
    rageCalls.addArgs = { kind, name, menu }
    RMenu.registry[kind] = RMenu.registry[kind] or {}
    RMenu.registry[kind][name] = menu
end
function RMenu:Get(kind, name)
    rageCalls.get = rageCalls.get + 1
    return self.registry[kind] and self.registry[kind][name]
end

RageUI = {}
function RageUI.CreateMenu(title, subtitle)
    rageCalls.createMenu = rageCalls.createMenu + 1
    local menu = {
        Title = title, Subtitle = subtitle, Open = false, EnableMouse = false, Index = 1,
        Pagination = { Minimum = 1, Maximum = 10, Total = 10 },
        Display = { Header = true, Glare = true, InstructionalButton = true },
        Sprite = { Dictionary = 'commonmenu', Texture = 'interaction_bgd' }
    }
    return setmetatable(menu, { __index = menuMethods, __call = function() return true end })
end
function RageUI.Visible(menu, value)
    if value == nil then return menu.Open end
    menu.Open = value == true
    rageCalls.visible[#rageCalls.visible + 1] = value == true
end
function RageUI.CloseAll()
    for _, byName in pairs(RMenu.registry) do
        for _, menu in pairs(byName) do menu.Open = false end
    end
end
function RageUI.IsVisible(menu, callback)
    rageCalls.isVisible = rageCalls.isVisible + 1
    if not menu.Open then return end
    if menu.Display.Header then
        -- RageUI/menu/RageUI.lua:402 performs this access before it renders any
        -- item. The test intentionally fails if the compatibility sentinel is gone.
        local dictionary = menu.Sprite.Dictionary
        if not dictionary then assert(menu.Rectangle, 'rectangle banner has no rectangle data') end
    end
    renderItems = {}
    if callback then callback() end
end
function RageUI.Separator(label)
    rageCalls.separators = rageCalls.separators + 1
    renderItems[#renderItems + 1] = { kind = 'separator', label = label }
end
function RageUI.Button(label, description, style, enabled, actions, submenu)
    rageCalls.buttons = rageCalls.buttons + 1
    renderItems[#renderItems + 1] = {
        kind = 'button', label = label, description = description, style = style,
        enabled = enabled, actions = actions or {}, submenu = submenu
    }
end
function RageUI.Checkbox(label, description, checked, style, actions)
    rageCalls.checkboxes = rageCalls.checkboxes + 1
    renderItems[#renderItems + 1] = {
        kind = 'checkbox', label = label, description = description, checked = checked,
        style = style, actions = actions or {}
    }
end
function RageUI.List(label, items, index, description, style, enabled, actions, submenu)
    rageCalls.lists = rageCalls.lists + 1
    renderItems[#renderItems + 1] = {
        kind = 'list', label = label, items = items, index = index, description = description,
        style = style, enabled = enabled, actions = actions or {}, submenu = submenu
    }
end

local menuPath = arg[1] or 'client/menu.lua'
for _, badName in ipairs({ 'YX_SIRENCONTROL', 'yx_sirencontrol-main', 'yx_sirencontorl', 'wrongname', '' }) do
    local printed, originalPrint = {}, print
    print = function(message) printed[#printed + 1] = tostring(message) end
    resourceName = badName
    local ok, failure = pcall(dofile, menuPath)
    print = originalPrint
    assert(ok, failure)

    assert(#threads == 0, 'a wrongly named resource must not create the RageUI frame thread')
    assert(next(handlers) == nil, 'a wrongly named resource must not register menu handlers')
    assert(rageCalls.createMenu == 0 and rageCalls.add == 0 and rageCalls.get == 0,
        'a wrongly named resource must not access RageUI or RMenu')
    local nameError = table.concat(printed, '\n')
    assert(nameError:find('资源名', 1, true), 'wrong resource name must print a Chinese diagnostic')
    assert(nameError:find(badName, 1, true) and nameError:find('yx_sirencontrol', 1, true),
        'wrong resource name diagnostic must include the current and required names')
end

resourceName = 'yx_sirencontrol'
dofile(menuPath)

local function dispatch(suffix, value)
    local handler = handlers['yx_sirencontrol:menu:' .. suffix]
    assert(handler, 'missing menu event handler: ' .. suffix)
    handler(value)
end
local function frame()
    disabledThisFrame, enabledThisFrame, renderItems = {}, {}, {}
    local ok, errorMessage = coroutine.resume(threads[1])
    assert(ok, errorMessage)
end
local function lastEvent(name, value)
    local event = events[#events]
    assert(event and event.name == name, 'expected last event ' .. name)
    if value ~= nil then assert(event.args[1] == value, 'incorrect value for ' .. name) end
    return event
end
local function lastAction(action, value, extra)
    local event = lastEvent('yx_sirencontrol:menu:action')
    assert(event.args[1] == action, 'expected action ' .. tostring(action) .. ', got ' .. tostring(event.args[1]))
    assert(event.args[2] == value, 'incorrect value for action ' .. tostring(action))
    assert(event.args[3] == extra, 'incorrect extra for action ' .. tostring(action))
end
local function item(label)
    for _, candidate in ipairs(renderItems) do if candidate.label == label then return candidate end end
    error('rendered RageUI item not found: ' .. label)
end
local function functionalItems()
    local result = {}
    for _, candidate in ipairs(renderItems) do
        if candidate.kind ~= 'separator' then result[#result + 1] = candidate end
    end
    return result
end
local function refreshItem(label) frame(); return item(label) end
local function changeList(label, index)
    local row = refreshItem(label)
    assert(row.kind == 'list' and row.enabled ~= false, label .. ' must be an enabled RageUI list')
    assert(type(row.actions.onListChange) == 'function', label .. ' has no onListChange callback')
    row.actions.onListChange(index, row.items[index])
end
local function selectList(label)
    local row = refreshItem(label)
    assert(row.kind == 'list' and row.enabled ~= false, label .. ' must be an enabled RageUI list')
    assert(type(row.actions.onSelected) == 'function', label .. ' has no onSelected callback')
    row.actions.onSelected(row.index, row.items[row.index])
end
local function setCheckbox(label, checked)
    local row = refreshItem(label)
    assert(row.kind == 'checkbox', label .. ' must use RageUI.Checkbox')
    assert(row.actions.onSelected == nil, label .. ' must not emit every selected render frame')
    local callback = checked and row.actions.onChecked or row.actions.onUnChecked
    assert(type(callback) == 'function', label .. ' is missing its checkbox callback')
    callback()
end
local function pressButton(label)
    local row = refreshItem(label)
    assert(row.kind == 'button' and row.enabled ~= false, label .. ' must be an enabled RageUI button')
    assert(type(row.actions.onSelected) == 'function', label .. ' is missing onSelected')
    row.actions.onSelected()
end
local function openMenu()
    dispatch('open', 'valid')
    lastEvent('yx_sirencontrol:menu:visibility', true)
    frame()
end

-- Real RageUI construction and its 14 settings rows ------------------------
assert(#threads == 1, 'menu.lua must create one lifecycle/render thread')
assert(rageCalls.createMenu == 1 and rageCalls.add == 1 and rageCalls.get >= 1,
    'menu.lua must construct and register a RageUI menu through RMenu')
assert(rageCalls.addArgs[1] == 'yx_sirencontrol' and rageCalls.addArgs[2] == 'main', 'unexpected RMenu type/name')
local mainMenu = RMenu:Get('yx_sirencontrol', 'main')
assert(mainMenu and mainMenu.Title == '警灯警笛控制' and mainMenu.Subtitle == '当前车辆设置',
    'RageUI menu title/subtitle changed')
assert(mainMenu.EnableMouse == false, 'mouse mode would make RageUI disable all controls')
assert(mainMenu.Rectangle and mainMenu.Rectangle.R == 23 and mainMenu.Rectangle.G == 75
    and mainMenu.Rectangle.B == 145 and mainMenu.Rectangle.A == 255, 'blue RageUI banner changed')
assert(type(mainMenu.Sprite) == 'table' and not mainMenu.Sprite.Dictionary,
    'RageUI 2.0.0 rectangle banner compatibility sentinel is missing')
assert(mainMenu.Display.Glare == false, 'RageUI glare must remain disabled')
assert(mainMenu.Pagination.Total == 10, 'RageUI page size must be ten items')

openMenu()
assert(mainMenu.Open and rageCalls.isVisible > 0, 'open event did not show/render through RageUI')
local expectedLabels = {
    '控制器开关', '警灯档位', '警笛开关', '下车自动关笛',
    '警笛包', '当前警笛模式', '数字键 1 音色', '数字键 2 音色', '数字键 3 音色',
    '数字键 4 音色', '数字键 5 音色', 'E 键音色', 'R 键音色', '重置当前车辆设置'
}
local renderedFunctional = functionalItems()
assert(#renderedFunctional == 14, 'expected exactly fourteen functional RageUI items')
for index, label in ipairs(expectedLabels) do
    assert(renderedFunctional[index].label == label,
        'functional item ' .. index .. ' should be ' .. label .. ', got ' .. tostring(renderedFunctional[index].label))
end
local separators = {}
for _, row in ipairs(renderItems) do if row.kind == 'separator' then separators[#separators + 1] = row.label end end
assert(#separators == 3 and separators[1] == '警灯控制'
    and separators[2] == '警笛设置' and separators[3] == '存储管理',
    'RageUI section separators changed')
assert(rageCalls.checkboxes >= 3 and rageCalls.lists >= 10 and rageCalls.buttons >= 1,
    'expected RageUI Checkbox, List, and Button APIs to render the menu')
local stageRow = item('警灯档位')
assert(stageRow.items[1] == '关闭' and stageRow.items[2] == '1 - 仅警灯'
    and stageRow.items[3] == '2 - 警灯和警笛', 'lighting-stage choices are not localized')
assert(item('重置当前车辆设置').style.RightLabel == '重置', 'reset action is not localized')
assert(item('警笛开关').style.Enabled == false,
    'stage-2-only siren checkbox must be disabled while lighting stage is 1')
local idleEventCount = #events
frame(); frame()
assert(#events == idleEventCount, 'idle RageUI rendering emitted an action or visibility event')

-- RageUI navigation remains isolated while vehicle controls stay enabled.
assert(disableAllCount == 0, 'menu.lua called DisableAllControlActions')
local expectedDisabled = { [27] = true, [99] = true, [172] = true, [173] = true, [174] = true, [175] = true }
for key in pairs(disabledThisFrame) do
    local group, id = key:match('^(%d+):(%d+)$')
    group, id = tonumber(group), tonumber(id)
    assert(group == 0 and expectedDisabled[id], 'unnecessary control disabled while driving: ' .. key)
end
for id in pairs(expectedDisabled) do
    assert(disabledThisFrame['0:' .. id], 'RageUI navigation control was not isolated: ' .. id)
end
for _, id in ipairs({ 59, 71, 72, 76 }) do
    assert(enabledThisFrame['0:' .. id], 'vehicle control must stay usable with the menu open: ' .. id)
    assert(not disabledThisFrame['0:' .. id], 'vehicle control was disabled with the menu open: ' .. id)
end

-- Every functional row emits the client.js contract with the correct id/value.
setCheckbox('控制器开关', false); lastAction('enabled', false)
setCheckbox('控制器开关', true); lastAction('enabled', true)
changeList('警灯档位', 3); lastAction('stage', 2)
setCheckbox('警笛开关', false); lastAction('sirenEnabled', false)
frame()
assert(item('当前警笛模式').items[1] == '1（已关笛）', 'muted siren suffix is not localized')
setCheckbox('警笛开关', true); lastAction('sirenEnabled', true)
setCheckbox('下车自动关笛', false); lastAction('parkKill', false)
changeList('警笛包', 2); lastAction('pack', 'ss2000')
changeList('当前警笛模式', 1); lastAction('slot', 1)
for slot = 1, 5 do
    changeList('数字键 ' .. slot .. ' 音色', 2)
    lastAction('binding', 'yelp', slot)
end
changeList('E 键音色', 2); lastAction('manualBinding', 'wail', 'e')
changeList('R 键音色', 3); lastAction('manualBinding', 'yelp', 'r')
selectList('当前警笛模式'); lastAction('slot', 1)
pressButton('重置当前车辆设置'); lastAction('reset', nil, nil)

-- Empty developer option lists become disabled RageUI rows and cannot emit ids.
local savedPacks, savedTones, savedManualTones = payload.packs, payload.tones, payload.manualTones
payload.packs, payload.tones, payload.manualTones = {}, {}, {}
dispatch('update', 'valid'); frame()
for _, label in ipairs({
    '警笛包', '数字键 1 音色', '数字键 2 音色', '数字键 3 音色', '数字键 4 音色', '数字键 5 音色',
    'E 键音色', 'R 键音色'
}) do
    local row = item(label)
    assert(row.kind == 'button' and row.enabled == false,
        'empty options must render a disabled RageUI button: ' .. label)
    assert(row.style and row.style.RightLabel == '无可用选项',
        'empty options must be labeled Unavailable: ' .. label)
    assert(next(row.actions) == nil, 'empty option row exposed an action callback: ' .. label)
end
payload.packs, payload.tones, payload.manualTones = savedPacks, savedTones, savedManualTones
dispatch('update', 'valid'); frame()

-- Same-vehicle updates retain RageUI selection/pagination and visibility.
mainMenu.Index = 9
mainMenu.Pagination.Minimum, mainMenu.Pagination.Maximum = 4, 13
local eventCount = #events
payload.vehicleLabel = 'UPDATED UNIT'
dispatch('update', 'valid'); frame()
assert(mainMenu.Open and mainMenu.Index == 9
    and mainMenu.Pagination.Minimum == 4 and mainMenu.Pagination.Maximum == 13,
    'same-vehicle update reset or closed the active RageUI menu')
assert(#events == eventCount, 'same-vehicle update emitted an unexpected event')
dispatch('open', 'valid')
assert(#events == eventCount, 'repeat open emitted duplicate visibility')
assert(mainMenu.Index == 9, 'repeat open reset the selected RageUI item')

-- RageUI.CloseAll does not call Closed; the render loop repairs local state.
RageUI.CloseAll(); frame()
lastEvent('yx_sirencontrol:menu:visibility', false)
assert(not mainMenu.Open, 'RageUI.CloseAll left local menu visibility active')

-- RageUI Back invokes Closed; it must hide the menu and emit visibility once.
openMenu()
assert(type(mainMenu.Closed) == 'function', 'RageUI Closed callback is missing')
mainMenu.Closed()
lastEvent('yx_sirencontrol:menu:visibility', false)
assert(not mainMenu.Open, 'Closed callback left the RageUI menu open')
eventCount = #events
mainMenu.Closed()
assert(#events == eventCount, 'repeated close duplicated the visibility event')

-- Both front seats can use the menu and swap seats in the same vehicle.
driver, frontPassenger, rearPassenger = 2, 1, 0
openMenu()
setCheckbox('下车自动关笛', true); lastAction('parkKill', true)
eventCount = #events
driver, frontPassenger = 1, 2; frame()
assert(mainMenu.Open and #events == eventCount, 'front passenger to driver swap closed the menu')
driver, frontPassenger = 2, 1; frame()
assert(mainMenu.Open and #events == eventCount, 'driver to front passenger swap closed the menu')
changeList('E 键音色', 1); lastAction('manualBinding', '@horn', 'e')

-- Invalid occupants/state/views close immediately.
frontPassenger, rearPassenger = 0, 1
frame(); lastEvent('yx_sirencontrol:menu:visibility', false)
eventCount = #events
dispatch('open', 'valid'); frame()
assert(#events == eventCount and not mainMenu.Open, 'rear passenger opened the menu')
driver, frontPassenger, rearPassenger = 1, 0, 0
openMenu(); currentVehicle = 43; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); currentVehicle = 42
openMenu(); networkId = 89; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); networkId = 88
openMenu(); vehicleExists = false; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); vehicleExists = true
openMenu(); paused = true; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); paused = false
openMenu(); nui = true; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); nui = false
openMenu(); dead = true; frame(); lastEvent('yx_sirencontrol:menu:visibility', false); dead = false
openMenu(); dispatch('update', 'other'); lastEvent('yx_sirencontrol:menu:visibility', false)
openMenu(); dispatch('update', 'invalid'); lastEvent('yx_sirencontrol:menu:visibility', false)

-- Civilian controllers must be explicitly enabled; emergency menus remain accessible.
payload.isEmergency, payload.enabled = false, false
dispatch('open', 'valid'); assert(not mainMenu.Open, 'disabled civilian menu opened')
payload.enabled = true
openMenu()
dispatch('close'); assert(not mainMenu.Open, 'explicit close event did not hide RageUI')
openMenu()
payload.enabled = false
dispatch('update', 'valid'); assert(not mainMenu.Open, 'disabled civilian update kept RageUI open')
payload.isEmergency = true
openMenu(); assert(mainMenu.Open, 'disabled emergency menu must remain accessible')
payload.enabled = true

-- Civilian LED position controls add to the original rows without installing a beacon.
dispatch('close')
payload.isEmergency = false
payload.beacon = { offset = { x = 0.12, y = -0.34, z = 0.05 }, busy = false }
openMenu()
renderedFunctional = functionalItems()
assert(#renderedFunctional == 18, 'civilian LED view must add exactly three axis lists and one reset button')
for index, label in ipairs(expectedLabels) do
    assert(renderedFunctional[index].label == label, 'LED position controls reordered an existing row: ' .. label)
end
local ledLabels = { 'LED 左右位置', 'LED 前后位置', 'LED 高低位置', '重置 LED 位置' }
for index, label in ipairs(ledLabels) do
    assert(renderedFunctional[14 + index].label == label, 'unexpected LED row order: ' .. label)
end
assert(item('便携 LED 位置').kind == 'separator', 'LED position controls need their Chinese section label')
local positionIndexes = { 213, 167, 206 }
for index = 1, 3 do
    local row = item(ledLabels[index])
    assert(row.kind == 'list' and row.enabled == true, 'LED axis must be editable before installation')
    assert(#row.items == 401 and row.items[1] == '-200 cm' and row.items[201] == '+0 cm'
        and row.items[401] == '+200 cm', 'LED position range or signed centimetre labels are incorrect')
    assert(row.index == positionIndexes[index], 'metres were not converted to the correct centimetre selection')
    assert(row.description:find('相对', 1, true) and row.description:find('自动保存', 1, true)
        and row.description:find('本地', 1, true) and row.description:find('/putsiren', 1, true),
        'LED axis help must explain relative positioning, local saving and next-install behavior')
end
assert(item('重置 LED 位置').description:find('仅', 1, true)
    and item('重置 LED 位置').description:find('其他警灯警笛设置保持不变', 1, true),
    'LED reset help must make its position-only scope clear')
eventCount = #events; frame(); frame()
assert(#events == eventCount, 'rendering LED controls must not save or install anything')
assert(disableAllCount == 0 and enabledThisFrame['0:59'] and enabledThisFrame['0:71']
    and enabledThisFrame['0:72'] and enabledThisFrame['0:76'], 'LED controls blocked normal driving')

changeList('LED 左右位置', 401); lastAction('beaconOffset', 200, 'x')
changeList('LED 前后位置', 1); lastAction('beaconOffset', -200, 'y')
changeList('LED 高低位置', 202); lastAction('beaconOffset', 1, 'z')
assert(payload.beacon.offset.x == 2 and payload.beacon.offset.y == -2 and payload.beacon.offset.z == 0.01,
    'LED callbacks must send centimetre integers to the client action handler')
selectList('LED 高低位置'); lastAction('beaconOffset', 1, 'z')
frame()
assert(item('LED 左右位置').index == 401 and item('LED 前后位置').index == 1
    and item('LED 高低位置').index == 202, 'authoritative position updates did not refresh the axis selections')
mainMenu.Index, mainMenu.Pagination.Minimum, mainMenu.Pagination.Maximum = 17, 9, 18
dispatch('update', 'valid'); frame()
assert(mainMenu.Index == 17 and mainMenu.Pagination.Minimum == 9 and mainMenu.Pagination.Maximum == 18,
    'position updates reset menu selection or pagination')

local beforeLedReset = copyPayload(payload)
pressButton('重置 LED 位置'); lastAction('beaconReset', nil, nil)
assert(payload.beacon.offset.x == 0 and payload.beacon.offset.y == 0 and payload.beacon.offset.z == 0,
    'LED reset did not refresh all three relative coordinates')
assert(payload.packId == beforeLedReset.packId and payload.parkKill == beforeLedReset.parkKill
    and payload.stage == beforeLedReset.stage and payload.manualBindings.e == beforeLedReset.manualBindings.e
    and payload.bindings[1] == beforeLedReset.bindings[1], 'LED reset affected another vehicle setting')
frame()
assert(item('LED 左右位置').index == 201 and item('LED 前后位置').index == 201
    and item('LED 高低位置').index == 201, 'LED reset selections must show zero relative offset')

-- Driver and front passenger use the same local-adjustment entry point without job gating.
driver, frontPassenger = 2, 1
changeList('LED 左右位置', 200); lastAction('beaconOffset', -1, 'x')
assert(mainMenu.Open, 'front passenger was denied civilian LED position adjustment')
driver, frontPassenger = 1, 0

-- Busy view disables both axes and reset, including callbacks retained from an earlier frame.
local staleAxis = refreshItem('LED 左右位置').actions.onListChange
local staleReset = refreshItem('重置 LED 位置').actions.onSelected
payload.beacon.busy = true
dispatch('update', 'valid'); frame()
for _, label in ipairs(ledLabels) do
    local row = item(label)
    assert(row.enabled == false and row.description:find('正在放置或收回', 1, true),
        'busy LED controls must be disabled with an explanation: ' .. label)
end
eventCount = #events
item('LED 左右位置').actions.onListChange(203)
item('重置 LED 位置').actions.onSelected()
staleAxis(204); staleReset()
assert(#events == eventCount, 'busy LED control or stale callback emitted a position action')
changeList('E 键音色', 2); lastAction('manualBinding', 'wail', 'e')
payload.beacon.busy = false
dispatch('update', 'valid'); frame()
assert(item('LED 左右位置').enabled and item('重置 LED 位置').enabled,
    'LED controls stayed disabled after the action finished')

-- Missing/emergency LED capability hides all new rows and rejects stale position callbacks.
local savedBeacon = payload.beacon
payload.beacon = nil
dispatch('update', 'valid'); frame()
assert(#functionalItems() == 14, 'missing beacon view must not show LED controls')
eventCount = #events; staleAxis(205); staleReset()
assert(#events == eventCount, 'a disappeared LED section retained a working callback')
payload.beacon, payload.isEmergency = savedBeacon, true
dispatch('update', 'valid'); frame()
assert(#functionalItems() == 14, 'emergency vehicle must ignore even a supplied beacon view')
eventCount = #events; staleAxis(205); staleReset()
assert(#events == eventCount, 'emergency view accepted a stale LED callback')

-- Position normalization bounds finite offsets and does not propagate malformed values.
payload.isEmergency = false
payload.beacon.offset = { x = 3.5, y = -4, z = 0.125 }
dispatch('update', 'valid'); frame()
assert(item('LED 左右位置').index == 401 and item('LED 前后位置').index == 1
    and item('LED 高低位置').index == 214, 'LED normalization must clamp to two metres and round to centimetres')
payload.beacon.offset = { x = math.huge, y = 0 / 0, z = 'invalid' }
dispatch('update', 'valid'); frame()
for index = 1, 3 do assert(item(ledLabels[index]).index == 201, 'malformed offset must display a safe zero') end
payload.beacon.offset = { z = -0.125 }
dispatch('update', 'valid'); frame()
assert(item('LED 高低位置').index == 188, 'negative centimetre rounding must be symmetric')
eventCount = #events
item('LED 高低位置').actions.onListChange(0)
item('LED 高低位置').actions.onListChange(402)
assert(#events == eventCount, 'out-of-range list indexes must not emit a position action')
dispatch('close')
payload.beacon, payload.isEmergency = nil, true

-- Resource-stop closure is scoped and idempotent.
openMenu()
eventCount = #events
handlers.onResourceStop('another_resource')
assert(mainMenu.Open and #events == eventCount, 'another resource stop closed this RageUI menu')
handlers.onResourceStop('yx_sirencontrol')
lastEvent('yx_sirencontrol:menu:visibility', false)
assert(not mainMenu.Open, 'resource stop left RageUI visible')
eventCount = #events
handlers.onResourceStop('yx_sirencontrol')
assert(#events == eventCount, 'repeated resource stop duplicated visibility')
assert(disableAllCount == 0, 'DisableAllControlActions was called during a later lifecycle path')

print('PASS: real RageUI registration/rendering, fourteen original settings actions, civilian LED position/reset actions, centimetre bounds and normalization, busy/stale callback guards, driver/front-passenger use, seat/vehicle/lifecycle closure, idempotent visibility, mouse-off mode, navigation-only suppression, and live steering/accelerate/brake/handbrake controls')
