-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Copyright (C) 2026 YuanX1a0
-- Network clients only request actions. Framework jobs, controller enablement,
-- vehicle identities, animation timing, and installed state belong to the server.
local resource = GetCurrentResourceName()
if resource ~= 'yx_sirencontrol' then
    print(('^1[yx_sirencontrol] 资源名验证失败：当前资源名为 "%s"，资源目录必须命名为 "yx_sirencontrol"（区分大小写）。便携警灯服务端已停用。^7')
        :format(tostring(resource or '（空）')))
    return
end

local prefix = 'yx_sirencontrol:beacon:'
local configOk, config = pcall(function()
    return json.decode(LoadResourceFile(resource, 'config/beacon.json'))
end)
if not configOk or type(config) ~= 'table' then
    print('^1[yx_sirencontrol] config/beacon.json 无效，便携警灯已停用。^7')
    return
end

local function bounded(value, fallback, minimum, maximum)
    value = tonumber(value)
    if not value or value ~= value then return fallback end
    return math.floor(math.max(minimum, math.min(maximum, value)))
end

local duration = bounded((config.Animation or {}).DurationMs, 2000, 1000, 5000)
local completionGrace = 5000
local prepareTimeout = bounded(config.PrepareTimeoutMs, 10000, 3000, 30000)
local cooldown = bounded(config.RequestCooldownMs, 800, 300, 5000)
local jobs, emergency, states, pending, actorPending, rates = {}, {}, {}, {}, {}, {}
local sequence, revision = 0, 0
for _, job in ipairs(config.AllowedJobs or {}) do
    if type(job) == 'string' then jobs[job:lower()] = true end
end

local function hash(model)
    if type(model) == 'string' then return GetHashKey(model:lower()) & 0xffffffff end
    return tonumber(model) and (math.floor(model) & 0xffffffff) or 0
end

-- GTA's emergency class includes unmarked cars and emergency SUVs, not only
-- obvious liveries. Add-on emergency models are discovered from vehicles.meta.
local stockEmergency = {
    'ambulance', 'fbi', 'fbi2', 'firetruk', 'lguard', 'pbus', 'police', 'police2',
    'police3', 'police4', 'police5', 'policeb', 'policeold1', 'policeold2', 'policet',
    'policeb2', 'polbuffalo', 'polcoquette4', 'poldominator10', 'poldorado',
    'polfaction', 'polgauntlet', 'polgreenwood', 'policeimpaler', 'polimpaler5',
    'polimpaler6', 'polstanier', 'polterminus', 'predator', 'pranger', 'riot',
    'riot2', 'sheriff', 'sheriff2'
}
for _, model in ipairs(stockEmergency) do emergency[hash(model)] = true end
for _, model in ipairs(config.EmergencyModels or {}) do emergency[hash(model)] = true end

local scannedResources = {}
local function scanResource(name)
    if config.ScanEmergencyMetadata == false or not name or GetResourceState(name) ~= 'started' then return end
    local paths, unresolved = {}, false
    for index = 0, GetNumResourceMetadata(name, 'data_file') - 1 do
        if GetResourceMetadata(name, 'data_file', index) == 'VEHICLE_METADATA_FILE' then
            local ok, extra = pcall(json.decode, GetResourceMetadata(name, 'data_file_extra', index) or '')
            if ok and type(extra) == 'table' and type(extra[1]) == 'string' then paths[extra[1]] = true end
        end
    end
    -- Explicit file entries supplement wildcard data_file declarations.
    for index = 0, GetNumResourceMetadata(name, 'file') - 1 do
        local path = GetResourceMetadata(name, 'file', index)
        if type(path) == 'string' and path:lower():match('vehicles%.meta$') then paths[path] = true end
    end
    for path in pairs(paths) do
        if path:find('[*?]') then
            unresolved = true
        else
            local xml = LoadResourceFile(name, path)
            if type(xml) == 'string' and #xml < 16777216 then
                -- Split at modelName boundaries: nested Item nodes in a vehicle's
                -- extras/livery lists must not truncate the enclosing definition.
                xml = xml:gsub('<!%-%-.-%-%->', '')
                local cursor = 1
                while true do
                    local _, modelEnd, model = xml:find('<modelName>%s*(.-)%s*</modelName>', cursor)
                    if not modelEnd then break end
                    local nextStart = xml:find('<modelName>', modelEnd + 1, true)
                    local body = xml:sub(modelEnd + 1, nextStart and nextStart - 1 or #xml)
                    if body:match('<vehicleClass>%s*(.-)%s*</vehicleClass>') == 'VC_EMERGENCY' then
                        emergency[hash(model)] = true
                    end
                    cursor = modelEnd + 1
                end
            end
        end
    end
    if unresolved and not scannedResources[name] then
        print(('[yx_sirencontrol] %s 的 vehicles.meta 使用通配符；请在 config/beacon.json EmergencyModels 中补充无法读取的紧急车型，或为该资源添加具体 file 路径。'):format(name))
    end
    scannedResources[name] = true
end

local function frameworkJob(playerId)
    local framework = tostring(config.Framework or 'auto'):lower()
    if framework == 'auto' then
        if GetResourceState('qbx_core') == 'started' then framework = 'qbox'
        elseif GetResourceState('qb-core') == 'started' then framework = 'qb'
        elseif GetResourceState('es_extended') == 'started' then framework = 'esx'
        else return nil end
    end
    local ok, name = pcall(function()
        if framework == 'qbox' or framework == 'qbx' then
            if GetResourceState('qbx_core') ~= 'started' then return nil end
            local player = exports.qbx_core:GetPlayer(playerId)
            return player and player.PlayerData and player.PlayerData.job and player.PlayerData.job.name
        elseif framework == 'qb' or framework == 'qbcore' then
            if GetResourceState('qb-core') ~= 'started' then return nil end
            local core = exports['qb-core']:GetCoreObject()
            local player = core.Functions.GetPlayer(playerId)
            return player and player.PlayerData and player.PlayerData.job and player.PlayerData.job.name
        elseif framework == 'esx' then
            if GetResourceState('es_extended') ~= 'started' then return nil end
            local core = exports.es_extended:getSharedObject()
            local player = core.GetPlayerFromId(playerId)
            local job = player and (player.getJob and player.getJob() or player.job)
            return job and job.name
        end
    end)
    if ok and type(name) == 'string' then return name:lower() end
    return nil -- Missing/failed framework lookups always fail closed.
end

local function validId(value)
    return type(value) == 'number' and value == math.floor(value) and value > 0 and value <= 65535
end

local function enabled(netId)
    local ok, value = pcall(function() return exports[resource]:IsSirenEnabled(netId) end)
    return ok and value == true
end

local function resolve(netId)
    local vehicle = NetworkGetEntityFromNetworkId(netId)
    if vehicle and vehicle ~= 0 and DoesEntityExist(vehicle) and GetEntityType(vehicle) == 2 then return vehicle end
    return nil
end

local function sameVehicle(netId, record)
    local vehicle = resolve(netId)
    return vehicle and vehicle == record.entity and hash(GetEntityModel(vehicle)) == record.modelHash
end

local function authorize(playerId, netId, record)
    local vehicle = resolve(netId)
    if not vehicle then return nil, '当前载具已不存在。' end
    if record and (vehicle ~= record.entity or hash(GetEntityModel(vehicle)) ~= record.modelHash) then
        return nil, '载具已变更，请重新操作。'
    end
    local ped = GetPlayerPed(playerId)
    if not ped or ped == 0 or not DoesEntityExist(ped) or GetEntityHealth(ped) <= 0
        or GetPedInVehicleSeat(vehicle, -1) ~= ped
        or GetPlayerRoutingBucket(playerId) ~= GetEntityRoutingBucket(vehicle) then
        return nil, '请在存活状态下坐在主驾驶位使用。'
    end
    if GetVehicleType(vehicle) ~= 'automobile' or emergency[hash(GetEntityModel(vehicle))] then
        return nil, '便携警灯只能安装在非紧急民用汽车上。'
    end
    if not enabled(netId) then return nil, '请先输入 /siren on 启用当前载具。' end
    local job = frameworkJob(playerId)
    if not job or not jobs[job] then return nil, '仅授权职业可操作便携警灯（默认 police、ambulance、sheriff）。' end
    return vehicle
end

local function emitState(netId, record, installed, target)
    TriggerClientEvent(prefix .. 'state', target or -1, netId, record.modelHash, installed, record.revision)
end

local function cancel(netId)
    local action = pending[netId]
    if not action then return end
    pending[netId] = nil
    if actorPending[action.actor] == netId then actorPending[action.actor] = nil end
    TriggerClientEvent(prefix .. 'cancelled', -1, netId, action.token)
end

local function completionTimeout(netId, action)
    if pending[netId] ~= action then return end
    cancel(netId)
    TriggerClientEvent(prefix .. 'error', action.actor, '警灯动作确认超时，请重新操作。')
end

local function remove(netId)
    cancel(netId)
    local state = states[netId]
    if not state then return end
    states[netId] = nil
    revision = revision + 1
    state.revision = revision
    emitState(netId, state, false)
end

local function allow(playerId, kind, delay)
    local now = GetGameTimer()
    local rate = rates[playerId] or {}
    rates[playerId] = rate
    if rate[kind] and now >= rate[kind] and now - rate[kind] < delay then return false end
    rate[kind] = now
    return true
end

RegisterNetEvent(prefix .. 'request', function(netId)
    local playerId = tonumber(source)
    if not playerId or playerId <= 0 or not validId(netId) or not allow(playerId, 'request', cooldown) then return end
    if states[netId] and not sameVehicle(netId, states[netId]) then remove(netId) end
    local vehicle, reason = authorize(playerId, netId)
    if not vehicle then TriggerClientEvent(prefix .. 'error', playerId, reason); return end
    if pending[netId] or actorPending[playerId] then
        TriggerClientEvent(prefix .. 'error', playerId, '正在放置或收回警灯，请稍候。')
        return
    end
    sequence = sequence + 1
    local action = {
        entity = vehicle, modelHash = hash(GetEntityModel(vehicle)), actor = playerId,
        token = tostring(sequence), placing = states[netId] == nil, phase = 'prepare',
        deadline = GetGameTimer() + prepareTimeout
    }
    pending[netId], actorPending[playerId] = action, netId
    TriggerClientEvent(prefix .. 'prepare', playerId, netId, action.modelHash, action.token, action.placing)
end)

RegisterNetEvent(prefix .. 'ready', function(netId, token)
    local playerId = tonumber(source)
    if not validId(netId) or type(token) ~= 'string' then return end
    local action = pending[netId]
    if not action or action.actor ~= playerId or action.token ~= token or action.phase ~= 'prepare' then return end
    local vehicle, reason = authorize(playerId, netId, action)
    if not vehicle or GetGameTimer() > action.deadline then
        cancel(netId)
        TriggerClientEvent(prefix .. 'error', playerId, reason or '模型加载超时，请重新操作。')
        return
    end
    action.phase, action.startedAt = 'action', GetGameTimer()
    action.deadline = action.startedAt + duration + completionGrace
    TriggerClientEvent(prefix .. 'action', -1, netId, action.modelHash, action.token, playerId, action.placing, duration, revision)
    SetTimeout(duration + completionGrace, function()
        completionTimeout(netId, action)
    end)
end)

RegisterNetEvent(prefix .. 'complete', function(netId, token)
    local playerId = tonumber(source)
    if not validId(netId) or type(token) ~= 'string' then return end
    local action = pending[netId]
    if not action or action.actor ~= playerId or action.token ~= token or action.phase ~= 'action' then return end
    local now = GetGameTimer()
    if now >= action.deadline then completionTimeout(netId, action); return end
    local vehicle, reason = authorize(playerId, netId, action)
    if not vehicle then
        cancel(netId)
        TriggerClientEvent(prefix .. 'error', playerId, reason)
        return
    end
    if now < action.startedAt + duration then return end
    pending[netId], actorPending[playerId] = nil, nil
    revision = revision + 1
    local state = { entity = action.entity, modelHash = action.modelHash, owner = playerId, revision = revision }
    states[netId] = action.placing and state or nil
    emitState(netId, state, action.placing)
end)

RegisterNetEvent(prefix .. 'cancel', function(netId, token)
    if not validId(netId) or type(token) ~= 'string' then return end
    local action = pending[netId]
    if action and action.actor == tonumber(source) and action.token == token then cancel(netId) end
end)

RegisterNetEvent(prefix .. 'sync', function()
    local playerId = tonumber(source)
    if not playerId or playerId <= 0 or not allow(playerId, 'sync', 3000) then return end
    local snapshot = {}
    for netId, state in pairs(states) do
        if not sameVehicle(netId, state) or not enabled(netId) then remove(netId)
        else
            emitState(netId, state, true, playerId)
            snapshot[#snapshot + 1] = { networkId = netId, modelHash = state.modelHash, installed = true, revision = state.revision }
        end
    end
    -- Explicit empty snapshot also removes ghost props after a missed state packet.
    TriggerClientEvent(prefix .. 'snapshot', playerId, json.encode({ revision = revision, beacons = snapshot }))
end)

-- Local-only bridge: do not RegisterNetEvent for this event.
AddEventHandler('yx_sirencontrol:internal:disabled', function(netId) remove(netId) end)
AddEventHandler('entityRemoved', function(entity)
    for netId, state in pairs(states) do if state.entity == entity then remove(netId) end end
    for netId, action in pairs(pending) do if action.entity == entity then cancel(netId) end end
end)
AddEventHandler('playerDropped', function()
    local playerId = tonumber(source)
    rates[playerId] = nil
    if actorPending[playerId] then cancel(actorPending[playerId]) end
    for netId, state in pairs(states) do if state.owner == playerId then remove(netId) end end
end)
AddEventHandler('onResourceStart', scanResource)
AddEventHandler('onResourceStop', function(name)
    if name ~= resource then return end
    for netId in pairs(states) do remove(netId) end
    for netId in pairs(pending) do cancel(netId) end
end)

CreateThread(function()
    for index = 0, GetNumResources() - 1 do scanResource(GetResourceByFindIndex(index)) end
    while true do
        Wait(500)
        local now = GetGameTimer()
        for netId, action in pairs(pending) do
            if action.phase == 'action' and now >= action.deadline then
                completionTimeout(netId, action)
            elseif (action.phase == 'prepare' and now > action.deadline)
                or not authorize(action.actor, netId, action) then cancel(netId) end
        end
        for netId, state in pairs(states) do
            if not sameVehicle(netId, state) or not enabled(netId) then remove(netId) end
        end
    end
end)
