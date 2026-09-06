-- Run: npx --yes --package fengari-node-cli fengari tests/beacon-server.test.lua
-- Behavior tests execute the real Lua event handlers with deterministic server natives.
local prefix, passed = 'yx_sirencontrol:beacon:', 0
local function equal(a, b, message) assert(a == b, (message or 'mismatch') .. ': ' .. tostring(a) .. ' ~= ' .. tostring(b)) end
local function check(condition, message) assert(condition, message) end
local function run(name, callback) callback(); passed = passed + 1; print('PASS ' .. name) end
local sim

local function setup(options)
    options = options or {}
    sim = { now = 0, sent = {}, handlers = {}, network = {}, timers = {}, threads = {}, logs = {}, fileReads = 0,
        peds = { [1] = 101, [2] = 102 }, jobs = { [1] = 'police', [2] = 'police' },
        enabled = { [11] = true }, ids = { [11] = 201 },
        entities = { [101] = { kind = 1, health = 200, bucket = 0 }, [102] = { kind = 1, health = 200, bucket = 0 },
            [201] = { kind = 2, health = 1000, driver = 101, model = 9, bucket = 0, vehicleType = 'automobile' } },
        resources = { ['yx_sirencontrol'] = 'started', [options.framework or 'es_extended'] = 'started' },
        config = { Framework = 'auto', AllowedJobs = { 'police', 'ambulance', 'sheriff' }, EmergencyModels = { 'custompolice' },
            Animation = { DurationMs = 2000 }, PrepareTimeoutMs = 10000 },
        metadata = {}, files = {}, snapshots = {}, name = options.name or 'yx_sirencontrol' }
    function GetCurrentResourceName() return sim.name end
    function GetResourceState(name) return sim.resources[name] or 'missing' end
    function GetGameTimer() return sim.now end
    function GetHashKey(name) local value = 0; for i = 1, #name do value = value * 13 + name:byte(i); value = value % 1000003 end; return value end
    function LoadResourceFile(name, path)
        sim.fileReads = sim.fileReads + 1
        if name == 'yx_sirencontrol' and path == 'config/beacon.json' then return 'config' end
        return sim.files[name .. ':' .. path]
    end
    json = { decode = function(text)
        if text == 'config' then return sim.config end
        if text and text:sub(1, 1) == '@' then return { text:sub(2) } end
        error('Invalid test JSON')
    end, encode = function(value) sim.snapshots[#sim.snapshots + 1] = value; return 'snapshot' end }
    function NetworkGetEntityFromNetworkId(net) return sim.ids[net] or 0 end
    function DoesEntityExist(entity) return sim.entities[entity] ~= nil end
    function GetEntityType(entity) return sim.entities[entity].kind end
    function GetEntityModel(entity) return sim.entities[entity].model end
    function GetEntityHealth(entity) return sim.entities[entity].health end
    function GetPlayerPed(id) return sim.peds[id] or 0 end
    function GetPedInVehicleSeat(entity, seat) return seat == -1 and sim.entities[entity].driver or 0 end
    function GetPlayerRoutingBucket(id) return sim.entities[sim.peds[id]].bucket end
    function GetEntityRoutingBucket(entity) return sim.entities[entity].bucket end
    function GetVehicleType(entity) return sim.entities[entity].vehicleType end
    function GetNumResourceMetadata(name, kind) return #(sim.metadata[name .. ':' .. kind] or {}) end
    function GetResourceMetadata(name, kind, index) return (sim.metadata[name .. ':' .. kind] or {})[index + 1] end
    function GetNumResources() return 0 end
    function GetResourceByFindIndex() return nil end
    function RegisterNetEvent(name, callback) sim.handlers[name] = callback; sim.network[name] = true end
    function AddEventHandler(name, callback) sim.handlers[name] = callback end
    function TriggerClientEvent(name, target, ...) sim.sent[#sim.sent + 1] = { name = name, target = target, args = { ... } } end
    function SetTimeout(delay, callback) sim.timers[#sim.timers + 1] = { at = sim.now + delay, callback = callback } end
    function CreateThread(callback) sim.threads[#sim.threads + 1] = coroutine.create(callback) end
    function Wait() coroutine.yield() end
    local function player(id) return sim.jobs[id] and { PlayerData = { job = { name = sim.jobs[id] } } } end
    exports = {
        yx_sirencontrol = { IsSirenEnabled = function(_, net) if sim.exportFailure then error('missing export') end; return sim.enabled[net] == true end },
        qbx_core = { GetPlayer = function(_, id) return player(id) end },
        ['qb-core'] = { GetCoreObject = function() return { Functions = { GetPlayer = player } } end },
        es_extended = { getSharedObject = function() return { GetPlayerFromId = function(id)
            return sim.jobs[id] and { getJob = function() return { name = sim.jobs[id] } end }
        end } end }
    }
    local originalPrint = print
    print = function(message) sim.logs[#sim.logs + 1] = tostring(message) end
    local ok, failure = pcall(dofile, 'server/beacon.lua')
    print = originalPrint
    check(ok, failure)
end

local function fire(name, actor, ...)
    source = actor
    check(sim.handlers[name], 'missing handler ' .. name)
    sim.handlers[name](...)
end
local function client(name, actor, ...) fire(prefix .. name, actor, ...) end
local function latest(name)
    for index = #sim.sent, 1, -1 do if sim.sent[index].name == prefix .. name then return sim.sent[index] end end
end
local function count(name)
    local result = 0; for _, event in ipairs(sim.sent) do if event.name == prefix .. name then result = result + 1 end end; return result
end
local function advance(ms)
    sim.now = sim.now + ms
    local waiting = sim.timers; sim.timers = {}
    for _, timer in ipairs(waiting) do if sim.now >= timer.at then timer.callback() else sim.timers[#sim.timers + 1] = timer end end
end
local function watchdog()
    for _, thread in ipairs(sim.threads) do local ok, err = coroutine.resume(thread); check(ok, err) end
end
local function begin(net, actor)
    client('request', actor or 1, net or 11)
    local event = latest('prepare'); check(event, 'expected prepared action')
    client('ready', actor or 1, net or 11, event.args[3])
    return event.args[3]
end
local function install()
    local token = begin(); advance(2000); client('complete', 1, 11, token)
    equal(latest('state').args[3], true); return token
end

run('installation and removal require actor completion after the server duration', function()
    setup(); client('request', 1, 11)
    equal(count('state'), 0); equal(count('action'), 0)
    local prepared = latest('prepare'); equal(prepared.target, 1); equal(prepared.args[2], 9); equal(prepared.args[4], true)
    client('complete', 1, 11, prepared.args[3]); equal(count('state'), 0)
    client('ready', 1, 11, prepared.args[3]); equal(latest('action').target, -1); equal(latest('action').args[6], 2000)
    equal(latest('action').args[7], 0)
    client('complete', 1, 11, prepared.args[3]); equal(count('state'), 0)
    advance(1999); client('complete', 1, 11, prepared.args[3]); equal(count('state'), 0)
    advance(1); equal(count('state'), 0)
    client('complete', 1, 11, prepared.args[3]); equal(latest('state').args[3], true)
    local firstRevision = latest('state').args[4]
    local token = begin(); equal(latest('prepare').args[4], false); equal(latest('action').args[7], firstRevision)
    advance(2000); equal(count('state'), 1); client('complete', 1, 11, token)
    equal(latest('state').args[3], false); check(latest('state').args[4] > firstRevision)
end)
run('all three authorized jobs work with ESX, QB and Qbox auto detection', function()
    for _, framework in ipairs({ 'es_extended', 'qb-core', 'qbx_core' }) do
        for _, job in ipairs({ 'police', 'ambulance', 'sheriff' }) do setup({ framework = framework }); sim.jobs[1] = job; install() end
    end
end)
run('job failure, absent framework and missing enabled export fail closed', function()
    for _, change in ipairs({ function() sim.jobs[1] = 'unemployed' end, function() sim.jobs[1] = nil end,
        function() sim.resources.es_extended = 'missing' end, function() sim.exportFailure = true end,
        function() exports.es_extended.getSharedObject = function() error('framework restart') end end }) do
        setup(); change(); client('request', 1, 11); equal(count('prepare'), 0); equal(count('error'), 1)
    end
end)
run('siren on, live driver, same routing bucket and automobile are required', function()
    for _, change in ipairs({ function() sim.enabled[11] = nil end, function() sim.entities[201].driver = 102 end,
        function() sim.entities[101].health = 0 end, function() sim.entities[101].bucket = 7 end,
        function() sim.entities[201].vehicleType = 'bike' end, function() sim.entities[201].vehicleType = 'heli' end,
        function() sim.entities[201].model = GetHashKey('police4') end,
        function() sim.entities[201].model = GetHashKey('custompolice') end }) do
        setup(); change(); client('request', 1, 11); equal(count('prepare'), 0); equal(count('error'), 1)
    end
end)
run('malformed IDs, forged ready/cancel and repeat packets cannot install', function()
    setup(); for _, bad in ipairs({ '11', -1, 0, 1.25, 65536, {} }) do client('request', 1, bad) end
    equal(count('prepare'), 0); client('request', 1, 11)
    local token = latest('prepare').args[3]
    client('ready', 2, 11, token); client('ready', 1, 11, 'forged'); client('cancel', 2, 11, token)
    advance(3000); equal(count('state'), 0); equal(count('cancelled'), 0)
    client('ready', 1, 11, token); client('ready', 1, 11, token); equal(count('action'), 1)
    advance(2000); equal(count('state'), 0); client('complete', 1, 11, token); equal(count('state'), 1)
end)
run('malformed, forged, stale and duplicate completion packets cannot commit', function()
    setup(); local token = begin(); advance(2000)
    for _, bad in ipairs({ '11', -1, 0, 1.25, 65536, {} }) do client('complete', 1, bad, token) end
    for _, bad in ipairs({ 1, false, {} }) do client('complete', 1, 11, bad) end
    client('complete', 2, 11, token); client('complete', 1, 11, 'forged'); client('complete', 1, 12, token)
    equal(count('state'), 0); equal(count('cancelled'), 0)
    client('complete', 1, 11, token); equal(count('state'), 1)
    client('complete', 1, 11, token); equal(count('state'), 1)
    local removal = begin(); advance(2000)
    client('complete', 1, 11, token); equal(count('state'), 1)
    client('cancel', 1, 11, removal); client('complete', 1, 11, removal); equal(count('state'), 1)
    local retry = begin(); advance(2000)
    client('complete', 1, 11, removal); equal(count('state'), 1)
    client('complete', 1, 11, retry); equal(count('state'), 2); equal(latest('state').args[3], false)
    advance(10000); equal(count('state'), 2); equal(count('cancelled'), 1)
end)
run('completion grace permits delayed network confirmation but missing completion times out and releases locks', function()
    setup(); local token = begin(); advance(6999); equal(count('state'), 0)
    client('complete', 1, 11, token); equal(latest('state').args[3], true)
    advance(1); equal(count('cancelled'), 0)
    for _, trigger in ipairs({ 'timer', 'watchdog', 'complete' }) do
        for _, installed in ipairs({ false, true }) do
            setup(); if installed then install() end
            local pendingToken = begin()
            local priorStateCount = count('state')
            if trigger == 'timer' then advance(7000)
            else
                sim.now = sim.now + 7000
                if trigger == 'watchdog' then watchdog(); watchdog()
                else client('complete', 1, 11, pendingToken) end
            end
            equal(count('cancelled'), 1); equal(count('state'), priorStateCount)
            equal(latest('error').target, 1); check(latest('error').args[1]:find('超时'))
            client('complete', 1, 11, pendingToken); equal(count('state'), priorStateCount)
            local nextToken = begin(); check(nextToken ~= pendingToken, 'timeout must release vehicle and actor locks')
            advance(2000); equal(count('cancelled'), 1, 'expired timer must not cancel the replacement action')
            client('complete', 1, 11, nextToken); equal(count('state'), priorStateCount + 1)
            equal(latest('state').args[3], not installed, 'failed removal must keep the installed beacon')
        end
    end
end)
run('permission loss and vehicle changes during preparation and animation cancel', function()
    for _, phase in ipairs({ 'prepare', 'action' }) do
        for _, change in ipairs({ function() sim.jobs[1] = 'unemployed' end, function() sim.enabled[11] = nil end,
            function() sim.entities[101].health = 0 end, function() sim.entities[201].driver = 102 end,
            function() sim.entities[201].model = 21 end, function() sim.ids[11] = 202; sim.entities[202] = sim.entities[201] end }) do
            setup(); client('request', 1, 11); local token = latest('prepare').args[3]
            if phase == 'action' then client('ready', 1, 11, token) end
            change()
            if phase == 'prepare' then client('ready', 1, 11, token)
            else advance(2000); client('complete', 1, 11, token) end
            equal(count('state'), 0); equal(count('cancelled'), 1)
        end
    end
end)
run('request flood, per-actor locking and per-vehicle locking reject duplicate work', function()
    setup(); client('request', 1, 11); for i = 1, 100 do client('request', 1, 11) end
    equal(count('prepare'), 1)
    advance(801); client('request', 1, 11); equal(count('prepare'), 1); equal(count('error'), 1)
    sim.entities[201].driver = 102; client('request', 2, 11); equal(count('prepare'), 1); equal(count('error'), 2)
    sim.ids[12] = 202; sim.enabled[12] = true
    sim.entities[202] = { kind = 2, model = 9, bucket = 0, driver = 101, vehicleType = 'automobile' }
    advance(801); client('request', 1, 12); equal(count('prepare'), 1)
end)
run('late ready, model load failure and pending watchdog do not leave busy locks', function()
    setup(); client('request', 1, 11); local token = latest('prepare').args[3]
    advance(10001); client('ready', 1, 11, token); equal(count('cancelled'), 1); equal(count('action'), 0)
    client('request', 1, 11); client('cancel', 1, 11, latest('prepare').args[3]); equal(count('cancelled'), 2)
    advance(801); client('request', 1, 11); watchdog(); advance(10001); watchdog(); equal(count('cancelled'), 3)
    client('request', 1, 11); check(latest('prepare').args[3] ~= token)
end)
run('local disable, entity deletion, player drop and stop clean pending and installed state', function()
    for _, kind in ipairs({ 'disabled', 'entity', 'drop', 'stop' }) do
        for _, installed in ipairs({ false, true }) do
            setup(); if installed then install() else begin() end
            if kind == 'disabled' then fire('yx_sirencontrol:internal:disabled', 0, 11)
            elseif kind == 'entity' then fire('entityRemoved', 0, 201)
            elseif kind == 'drop' then fire('playerDropped', 1)
            else fire('onResourceStop', 0, 'yx_sirencontrol') end
            advance(3000)
            if installed then equal(latest('state').args[3], false) else equal(count('state'), 0); equal(count('cancelled'), 1) end
        end
    end
end)
run('snapshot carries global revision and removes disabled or reused network IDs', function()
    setup(); install(); client('sync', 2)
    local snapshot = sim.snapshots[#sim.snapshots]; equal(snapshot.revision, 1); equal(#snapshot.beacons, 1)
    equal(snapshot.beacons[1].networkId, 11); equal(latest('state').target, 2)
    client('sync', 2); equal(#sim.snapshots, 1)
    sim.entities[201].model = 88; advance(3001); client('sync', 2)
    snapshot = sim.snapshots[#sim.snapshots]; equal(#snapshot.beacons, 0); equal(snapshot.revision, 2); equal(latest('state').args[3], false)
    setup(); install(); watchdog(); sim.enabled[11] = nil; watchdog(); equal(latest('state').args[3], false)
end)
run('nested emergency metadata, comments and explicit file paths are scanned', function()
    setup(); sim.resources.fleet = 'started'
    sim.metadata['fleet:data_file'] = { 'VEHICLE_METADATA_FILE' }
    sim.metadata['fleet:data_file_extra'] = { '@data/vehicles.meta' }
    sim.files['fleet:data/vehicles.meta'] = [[<InitDatas><Item><modelName>custom1</modelName><extras><Item>x</Item></extras><vehicleClass>VC_EMERGENCY</vehicleClass></Item><Item><modelName>normalcar</modelName><vehicleClass>VC_SEDAN</vehicleClass></Item><!-- <modelName>commentcar</modelName><vehicleClass>VC_EMERGENCY</vehicleClass> --></InitDatas>]]
    fire('onResourceStart', 0, 'fleet')
    sim.entities[201].model = GetHashKey('custom1'); client('request', 1, 11); equal(count('prepare'), 0)
    advance(801); sim.entities[201].model = GetHashKey('normalcar'); client('request', 1, 11); equal(count('prepare'), 1)
end)
run('internal cleanup is local only', function()
    setup(); check(not sim.network['yx_sirencontrol:internal:disabled']); check(sim.handlers['yx_sirencontrol:internal:disabled'])
end)
run('renamed resource registers no beacon functionality or background work', function()
    for _, name in ipairs({ 'wrongname', 'YX_SIRENCONTROL', 'yx_sirencontrol-main', 'yx_sirencontorl', '' }) do
        setup({ name = name })
        equal(next(sim.handlers), nil); equal(next(sim.network), nil)
        equal(#sim.sent, 0); equal(#sim.timers, 0); equal(#sim.threads, 0); equal(sim.fileReads, 0)
        equal(#sim.logs, 1)
        check(sim.logs[1]:find('资源名验证失败', 1, true))
        check(sim.logs[1]:find(name, 1, true) and sim.logs[1]:find('yx_sirencontrol', 1, true))
    end
    setup(); check(sim.handlers[prefix .. 'request'], 'restoring the required name must restore normal initialization')
end)
print(('PASS: %d beacon server behavior scenarios.'):format(passed))
