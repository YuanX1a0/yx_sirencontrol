// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 YuanX1a0

(function () {
    'use strict';

    var EXPECTED_RESOURCE_NAME = 'yx_sirencontrol';
    var resourceName = String(GetCurrentResourceName() || '');
    if (resourceName !== EXPECTED_RESOURCE_NAME) {
        console.error('[yx_sirencontrol] 资源名验证失败：当前资源名为 "' + resourceName +
            '"，资源目录必须命名为 "' + EXPECTED_RESOURCE_NAME + '"。客户端功能已停用。');
        return;
    }

    var config = globalThis.YXSirenControlConfig;
    if (!config) {
        throw new Error('yx_sirencontrol: config.js was not loaded.');
    }

    var settings = globalThis.YXSirenSettings;
    var packs = loadPacks();
    var savedSettings = new Map();
    var audioBanks = new Map();
    var synced = false;
    var menuOpen = false;
    var menuVehicle = 0;
    var controlContext = null;
    var nextControlCheck = 0;
    var nextSyncRequest = 5000;
    var states = new Map();
    var runtimes = new Map();
    var modelLayouts = new Map();
    var nextInputAt = 0;
    var localManualHornNetworkId = 0;
    var localManualSignature = '';
    var localManualKey = '';
    var beacon;
    var hudState = { until: 0, stage: 0, sirenMuted: false };

    var EVENT_SET_SERVER = 'yx_sirencontrol:server:setState';
    var EVENT_HORN_SERVER = 'yx_sirencontrol:server:setManualHorn';
    var EVENT_SYNC_SERVER = 'yx_sirencontrol:server:requestSync';
    var EVENT_SET_CLIENT = 'yx_sirencontrol:client:setState';
    var EVENT_REJECTED_CLIENT = 'yx_sirencontrol:client:rejected';
    var EVENT_EXIT_SERVER = 'yx_sirencontrol:server:driverExit';

    function loadPacks() {
        var loaded = [];
        var count = GetNumResourceMetadata(resourceName, 'siren_pack');
        for (var index = 0; index < count; index += 1) {
            var path = GetResourceMetadata(resourceName, 'siren_pack', index);
            try {
                var pack = settings.validatePack(JSON.parse(LoadResourceFile(resourceName, path).replace(/^\uFEFF/, '')));
                var required = pack.RequiredResource;
                if (required != null) {
                    if (typeof required !== 'string' || required.trim() !== required ||
                        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(required)) {
                        throw new Error('invalid RequiredResource name');
                    }
                    if (GetResourceState(required) !== 'started') {
                        console.log('yx_sirencontrol: skipped pack ' + pack.Id + '; start ' + required +
                            ' before restarting yx_sirencontrol.');
                        continue;
                    }
                }
                loaded.push(pack);
            } catch (error) {
                console.error('yx_sirencontrol: invalid pack ' + path + ': ' + error.message);
            }
        }
        return settings.catalog(loaded);
    }

    function modelMatches(vehicle, models) {
        var model = GetEntityModel(vehicle) >>> 0;
        return models.some(function (name) {
            return (typeof name === 'number' ? name >>> 0 : GetHashKey(name) >>> 0) === model;
        });
    }

    function isEmergencyVehicle(vehicle) {
        return !modelMatches(vehicle, config.Emergency.ExcludeModels) &&
            (GetVehicleClass(vehicle) === 18 || modelMatches(vehicle, config.Emergency.IncludeModels));
    }

    function vehicleIdentity(vehicle) {
        var persistentId = null;
        if (config.Persistence.VehicleIdStateKey) {
            try { persistentId = Entity(vehicle).state[config.Persistence.VehicleIdStateKey]; } catch (error) { /* No state bag yet. */ }
        }
        var model = GetEntityModel(vehicle) >>> 0;
        var plate = String(GetVehicleNumberPlateText(vehicle) || '').trim();
        var key = settings.vehicleKey(GetCurrentServerEndpoint(), model, plate, persistentId);
        return {
            key: key,
            cacheKey: key || 'session:' + vehicle + ':' + model,
            label: GetDisplayNameFromVehicleModel(model) + ' / ' + (plate || '无车牌'),
            display: persistentId ? String(persistentId) : (plate || '仅本次驾驶保存')
        };
    }

    function defaultPackForVehicle(vehicle) {
        var assignments = config.Persistence.ModelPacks;
        var match = Object.keys(assignments).find(function (model) { return modelMatches(vehicle, [model]); });
        return match ? assignments[match] : config.Persistence.DefaultPack;
    }

    function preferencesForVehicle(vehicle, reset) {
        var identity = vehicleIdentity(vehicle);
        if (!reset && savedSettings.has(identity.cacheKey)) { return savedSettings.get(identity.cacheKey); }
        var raw = null;
        var migrated = false;
        if (!reset && identity.key) {
            var saved = null;
            try { saved = GetResourceKvpString(config.Persistence.KeyPrefix + identity.key); } catch (error) { /* Storage unavailable. */ }
            // Read-only migration of v3.2.0 and earlier. The old resource need not
            // be installed or running; its persistent KVP namespace remains readable.
            // Legacy spelling is deliberately limited to this compatibility lookup.
            if (saved == null) {
                var legacyResource = 'yx_sirencontorl';
                var legacyKey = legacyResource + ':v3:' + identity.key;
                try {
                    saved = GetResourceKvpString(legacyKey);
                    if (saved == null && typeof GetExternalKvpString === 'function') {
                        saved = GetExternalKvpString(legacyResource, legacyKey);
                    }
                    migrated = saved != null;
                } catch (error) { /* Older clients may not support external KVP reads. */ }
            }
            try { raw = JSON.parse(saved); } catch (error) { /* Reset corrupt/old settings. */ }
        }
        var preferences = settings.normalize(packs, raw, defaultPackForVehicle(vehicle), config.Persistence.DefaultParkKill);
        savedSettings.set(identity.cacheKey, preferences);
        if (migrated && raw && raw.version === 1) {
            try { SetResourceKvp(config.Persistence.KeyPrefix + identity.key, JSON.stringify(preferences)); }
            catch (error) { console.warn('yx_sirencontrol: could not save migrated vehicle settings:', error); }
        }
        return preferences;
    }

    function persistPreferences(vehicle, preferences) {
        var identity = vehicleIdentity(vehicle);
        savedSettings.set(identity.cacheKey, preferences);
        if (identity.key) {
            SetResourceKvp(config.Persistence.KeyPrefix + identity.key, JSON.stringify(preferences));
        }
    }

    function operatingPreferences(vehicle, state) {
        // Display and operate the shared active selection without overwriting this
        // player's saved profile merely because another front occupant changed it.
        var preferences = settings.normalize(packs, preferencesForVehicle(vehicle), defaultPackForVehicle(vehicle), config.Persistence.DefaultParkKill);
        if (state) {
            preferences.packId = state.packId;
            preferences.slot = state.sirenMode;
            preferences.parkKill = state.parkKill;
            preferences.bindings[state.packId][state.sirenMode - 1] = state.toneId;
        }
        return preferences;
    }

    function stateFromPreferences(preferences, stage, sirenMuted) {
        return { enabled: true, stage: stage, sirenMode: preferences.slot, manualHorn: false,
            packId: preferences.packId, toneId: preferences.bindings[preferences.packId][preferences.slot - 1],
            parkKill: preferences.parkKill, sirenMuted: stage === 2 && Boolean(sirenMuted) };
    }

    function sendState(networkId, state) {
        // A stage/settings change releases this player's hold on the server. The
        // shared flag may belong to the other front occupant, so retain it until
        // the server replies with the merged result instead of cutting their horn.
        var previous = states.get(networkId);
        var manualHorn = Boolean(state.manualHorn || (previous && previous.manualHorn));
        applyState(networkId, state.enabled, state.stage, state.sirenMode, manualHorn, state.packId, state.toneId, state.parkKill, state.sirenMuted);
        TriggerServerEvent(EVENT_SET_SERVER, networkId, state.enabled, state.stage, state.sirenMode, state.packId, state.toneId, state.parkKill, state.sirenMuted);
    }

    function viewForVehicle(vehicle) {
        var networkId = getVehicleNetworkId(vehicle, false);
        var state = states.get(networkId);
        var preferences = operatingPreferences(vehicle, state);
        var pack = packs.get(preferences.packId);
        var identity = vehicleIdentity(vehicle);
        return { vehicle: vehicle, networkId: networkId, vehicleLabel: identity.label, vehicleKey: identity.display,
            isEmergency: isEmergencyVehicle(vehicle), enabled: Boolean(state), stage: state ? state.stage : 0,
            sirenMuted: state ? state.sirenMuted : false,
            parkKill: preferences.parkKill, packId: pack.Id, slot: preferences.slot, bindings: preferences.bindings[pack.Id],
            packs: Array.from(packs.values()).map(function (entry) { return { id: entry.Id, label: entry.Label }; }),
            tones: pack.Tones.map(function (tone) { return { id: tone.Id, label: tone.Label }; }),
            manualBindings: preferences.manualBindings[pack.Id], manualTones: settings.manualOptions(packs, pack),
            beacon: canAdjustBeacon(vehicle, state) ? {
                offset: preferences.beaconOffset,
                busy: Boolean(beacon && beacon.isBusy && beacon.isBusy(vehicle))
            } : undefined };
    }

    function canAdjustBeacon(vehicle, state) {
        return Boolean(state && state.enabled) && !isEmergencyVehicle(vehicle) &&
            [8, 13, 14, 15, 16, 21].indexOf(GetVehicleClass(vehicle)) === -1;
    }

    function refreshMenu() {
        if (menuOpen && menuVehicle && getControlVehicle(false) === menuVehicle) {
            var networkId = getVehicleNetworkId(menuVehicle, false);
            var state = states.get(networkId);
            if (!isEmergencyVehicle(menuVehicle) && (!state || !state.enabled)) {
                menuOpen = false;
                menuVehicle = 0;
                TriggerEvent('yx_sirencontrol:menu:close');
                return;
            }
            TriggerEvent('yx_sirencontrol:menu:update', JSON.stringify(viewForVehicle(menuVehicle)));
        }
    }

    function openMenu() {
        if (!synced) { notify('警笛数据正在同步，请稍后再试。'); return; }
        var vehicle = getControlVehicle(true);
        if (!vehicle) { return; }
        var networkId = getVehicleNetworkId(vehicle, true);
        if (!networkId) { return; }
        var state = states.get(networkId);
        if (!isEmergencyVehicle(vehicle) && (!state || !state.enabled)) {
            notify('普通车辆请先输入 /' + config.Command + ' on，再打开设置菜单。');
            return;
        }
        menuVehicle = vehicle;
        TriggerEvent('yx_sirencontrol:menu:open', JSON.stringify(viewForVehicle(vehicle)));
    }

    function handleMenuAction(action, value, extra) {
        if (!menuOpen || !synced || getControlVehicle(false) !== menuVehicle) { return; }
        var vehicle = menuVehicle;
        var networkId = getVehicleNetworkId(vehicle, false);
        var current = states.get(networkId);
        if (!isEmergencyVehicle(vehicle) && (!current || !current.enabled)) {
            refreshMenu();
            return;
        }
        if (action === 'beaconOffset' || action === 'beaconReset') {
            if (!canAdjustBeacon(vehicle, current)) { return; }
            if (beacon && beacon.isBusy && beacon.isBusy(vehicle)) {
                notify('请等待车顶警灯放置或收回完成，再调整位置。');
                refreshMenu(); return;
            }
            if (action === 'beaconOffset' &&
                (['x', 'y', 'z'].indexOf(extra) < 0 || !Number.isInteger(value) || value < -200 || value > 200)) { return; }
            // Position is a personal visual preference. Keep the owner's saved
            // audio profile and the vehicle's shared active siren state intact.
            var localPreferences = settings.normalize(packs, preferencesForVehicle(vehicle),
                defaultPackForVehicle(vehicle), config.Persistence.DefaultParkKill);
            if (action === 'beaconReset') { localPreferences.beaconOffset = { x: 0, y: 0, z: 0 }; }
            else { localPreferences.beaconOffset[extra] = value / 100; }
            try { persistPreferences(vehicle, localPreferences); }
            catch (error) { notify('位置已应用，但本地保存失败；重新连接后可能恢复默认。'); }
            refreshMenu(); return;
        }
        var preferences = operatingPreferences(vehicle, current);
        if (action === 'enabled') { handleCommand([value ? 'on' : 'off']); refreshMenu(); return; }
        if (action === 'stage') {
            if (current && Number.isInteger(value) && value >= 0 && value <= 2) { requestStage(networkId, value); }
            refreshMenu(); return;
        }
        if (action === 'sirenEnabled') {
            if (current && current.stage === 2 && typeof value === 'boolean') {
                releaseLocalManualHorn();
                sendState(networkId, stateFromPreferences(preferences, 2, !value));
                showElsStatus(2, !value);
            }
            refreshMenu(); return;
        }
        if (action === 'manualBinding') {
            if ((extra === 'e' || extra === 'r') && settings.manualValid(packs.get(preferences.packId), value)) {
                preferences.manualBindings[preferences.packId][extra] = value;
                persistPreferences(vehicle, preferences);
            }
            // This edits this player's momentary key assignment, not the shared lights or ongoing siren.
            refreshMenu(); return;
        }
        if (action === 'parkKill' && typeof value === 'boolean') { preferences.parkKill = value; }
        else if (action === 'pack' && packs.has(value)) { preferences.packId = value; }
        else if (action === 'slot' && Number.isInteger(value) && value >= 1 && value <= 5) { preferences.slot = value; }
        else if (action === 'binding' && Number.isInteger(extra) && extra >= 1 && extra <= 5 && settings.tone(packs.get(preferences.packId), value)) {
            preferences.bindings[preferences.packId][extra - 1] = value;
        } else if (action === 'reset') {
            var savedBeaconOffset = preferences.beaconOffset;
            preferences = preferencesForVehicle(vehicle, true);
            preferences.beaconOffset = savedBeaconOffset;
        }
        else { return; }
        persistPreferences(vehicle, preferences);
        if (current) {
            releaseLocalManualHorn();
            // Selecting a slot explicitly resumes it; editing settings keeps the current mute state.
            sendState(networkId, stateFromPreferences(preferences, current.stage, action === 'slot' ? false : current.sirenMuted));
        }
        refreshMenu();
    }

    function checkControlVehicle() {
        if (!synced) { return; }
        var vehicle = getControlVehicle(false);
        var networkId = vehicle ? getVehicleNetworkId(vehicle, false) : 0;
        if (controlContext && (controlContext.vehicle !== vehicle || controlContext.networkId !== networkId)) {
            releaseLocalManualHorn();
            var previous = states.get(controlContext.networkId);
            if (previous) {
                // The server sees both front seats. A local exit cannot decide whether
                // the other occupant still controls the vehicle or is holding its horn.
                TriggerServerEvent(EVENT_EXIT_SERVER, controlContext.networkId);
            }
            if (!controlContext.identity.key) { savedSettings.delete(controlContext.identity.cacheKey); }
            controlContext = null;
            hudState.until = 0;
        }
        if (!vehicle || !networkId || controlContext) { return; }
        controlContext = { vehicle: vehicle, networkId: networkId, identity: vehicleIdentity(vehicle) };
        var preferences = preferencesForVehicle(vehicle);
        var current = states.get(networkId);
        var playerPed = PlayerPedId();
        var driver = GetPedInVehicleSeat(vehicle, -1);
        var frontPassenger = GetPedInVehicleSeat(vehicle, 0);
        var otherOccupant = driver === playerPed ? frontPassenger : driver;
        var hasOtherOccupant = otherOccupant > 0 && DoesEntityExist(otherOccupant) && !IsEntityDead(otherOccupant);
        // A second front occupant joins the live state; never apply their saved
        // profile automatically over the person already operating this vehicle.
        if ((current && !hasOtherOccupant) || (!current && (driver === playerPed || !hasOtherOccupant) &&
            config.Emergency.AutoEnable && isEmergencyVehicle(vehicle))) {
            sendState(networkId, stateFromPreferences(preferences, current ? current.stage : 0, current && current.sirenMuted));
        }
        if (current) { showElsStatus(current.stage, current.sirenMuted); }
    }

    function numberOrZero(value) {
        value = Number(value);
        return Number.isFinite(value) ? value : 0.0;
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function normalizeNativeArray(value) {
        if (Array.isArray(value)) {
            return value;
        }

        if (value && typeof value === 'object') {
            return Object.keys(value).map(function (key) {
                return value[key];
            });
        }

        return [];
    }

    function vector3(value) {
        if (Array.isArray(value)) {
            return {
                x: numberOrZero(value[0]),
                y: numberOrZero(value[1]),
                z: numberOrZero(value[2])
            };
        }

        if (value && typeof value === 'object') {
            return {
                x: numberOrZero(value.x !== undefined ? value.x : value[0]),
                y: numberOrZero(value.y !== undefined ? value.y : value[1]),
                z: numberOrZero(value.z !== undefined ? value.z : value[2])
            };
        }

        return { x: 0.0, y: 0.0, z: 0.0 };
    }

    function squaredDistance(left, right) {
        var x = left.x - right.x;
        var y = left.y - right.y;
        var z = left.z - right.z;
        return (x * x) + (y * y) + (z * z);
    }

    function asControlList(value) {
        return Array.isArray(value) ? value : [value];
    }

    function disableControls(value) {
        var controls = asControlList(value);
        for (var index = 0; index < controls.length; index += 1) {
            DisableControlAction(0, controls[index], true);
        }
    }

    function anyControlPressed(value) {
        var controls = asControlList(value);
        for (var index = 0; index < controls.length; index += 1) {
            if (IsControlPressed(0, controls[index]) || IsDisabledControlPressed(0, controls[index])) {
                return true;
            }
        }
        return false;
    }

    function anyControlJustPressed(value) {
        var controls = asControlList(value);
        for (var index = 0; index < controls.length; index += 1) {
            if (IsControlJustPressed(0, controls[index]) || IsDisabledControlJustPressed(0, controls[index])) {
                return true;
            }
        }
        return false;
    }

    function notify(message) {
        BeginTextCommandThefeedPost('STRING');
        AddTextComponentSubstringPlayerName(config.Notifications.Prefix + message);
        EndTextCommandThefeedPostTicker(false, false);
    }

    function rejectionMessage(code) {
        if (code === 'not_driver' || code === 'not_front_seat') {
            return '~r~操作失败：~s~你必须坐在该载具的驾驶位或副驾驶位。';
        }

        if (code === 'enable_first') {
            return '~r~操作失败：~s~请先输入 /' + config.Command + ' on。';
        }

        if (code === 'invalid_siren') { return '~r~警笛包配置不匹配。~s~请检查客户端和服务端注册表并重启资源。'; }
        if (code === 'not_owner_or_still_driver') { return '~r~该车辆前排乘员状态已改变。'; }

        return '~r~操作失败：~s~载具无效或尚未联网。';
    }

    function showElsStatus(stage, sirenMuted) {
        hudState.until = GetGameTimer() + Math.max(250, Math.trunc(config.Hud.DurationMs));
        hudState.stage = clamp(Math.trunc(numberOrZero(stage)), 0, 2);
        hudState.sirenMuted = Boolean(sirenMuted);
    }

    function drawHudText(text, y, scale, alpha, color) {
        SetTextFont(config.Hud.Font);
        SetTextScale(0.0, scale);
        SetTextProportional(true);
        SetTextColour(color.r, color.g, color.b, alpha);
        SetTextRightJustify(false);
        SetTextCentre(true);
        SetTextWrap(0.0, 1.0);
        SetTextDropshadow(2, 0, 0, 0, 255);
        SetTextEdge(2, 0, 0, 0, 255);
        SetTextOutline();
        BeginTextCommandDisplayText('STRING');
        AddTextComponentSubstringPlayerName(text);
        EndTextCommandDisplayText(config.Hud.X, y);
    }

    function drawElsHud() {
        var remaining = hudState.until - GetGameTimer();
        if (remaining <= 0 || IsPauseMenuActive()) {
            return;
        }

        var fadeMs = Math.max(1, Math.trunc(config.Hud.FadeMs));
        var alpha = remaining < fadeMs ? Math.round(255 * (remaining / fadeMs)) : 255;
        var vehicle = getControlVehicle(false);
        var current = vehicle ? states.get(getVehicleNetworkId(vehicle, false)) : null;
        var state = current || hudState;
        var sounding = state.manualHorn || (state.stage === 2 && !state.sirenMuted);
        var status = sounding ? 'SIREN' : (state.stage > 0 ? 'LIGHT' : 'OFF');
        drawHudText('ELS', config.Hud.Y, config.Hud.Scale, alpha, { r: 255, g: 255, b: 255 });
        drawHudText(status, config.Hud.Y + config.Hud.LineSpacing, config.Hud.StatusScale, alpha, config.Hud.StatusColor);
    }

    function getControlVehicle(showError) {
        var playerPed = PlayerPedId();
        var vehicle = GetVehiclePedIsIn(playerPed, false);

        if (!vehicle || !DoesEntityExist(vehicle) || IsEntityDead(playerPed) ||
            (GetPedInVehicleSeat(vehicle, -1) !== playerPed && GetPedInVehicleSeat(vehicle, 0) !== playerPed)) {
            if (showError) {
                notify('你必须坐在载具的驾驶位或副驾驶位。');
            }
            return 0;
        }

        return vehicle;
    }

    function getVehicleNetworkId(vehicle, showError) {
        try {
            if (!NetworkGetEntityIsNetworked(vehicle)) {
                NetworkRegisterEntityAsNetworked(vehicle);
            }

            var networkId = Math.trunc(numberOrZero(NetworkGetNetworkIdFromEntity(vehicle)));
            if (networkId > 0) {
                return networkId;
            }
        } catch (error) {
            // The message below covers old artifacts and local-only entities.
        }

        if (showError) {
            notify('该载具尚未联网，无法同步警笛。');
        }
        return 0;
    }

    function resolveVehicle(networkId) {
        try {
            if (!NetworkDoesNetworkIdExist(networkId)) {
                return 0;
            }

            var vehicle = NetworkGetEntityFromNetworkId(networkId);
            return vehicle && DoesEntityExist(vehicle) && IsEntityAVehicle(vehicle) ? vehicle : 0;
        } catch (error) {
            return 0;
        }
    }

    function readVehicleLayout(vehicle) {
        var modelHash = GetEntityModel(vehicle) >>> 0;
        var cached = modelLayouts.get(modelHash);
        if (cached) {
            return cached;
        }

        var minimum = { x: -0.8, y: -1.5, z: -0.45 };
        var maximum = { x: 0.8, y: 1.5, z: 1.0 };

        try {
            var dimensions = GetModelDimensions(modelHash);

            if (Array.isArray(dimensions) && dimensions.length >= 6 && typeof dimensions[0] === 'number') {
                minimum = vector3(dimensions.slice(0, 3));
                maximum = vector3(dimensions.slice(3, 6));
            } else if (Array.isArray(dimensions) && dimensions.length >= 2) {
                minimum = vector3(dimensions[0]);
                maximum = vector3(dimensions[1]);
            } else if (dimensions && typeof dimensions === 'object') {
                minimum = vector3(dimensions.minimum || dimensions.min);
                maximum = vector3(dimensions.maximum || dimensions.max);
            }
        } catch (error) {
            // Keep the generic passenger-car fallback.
        }

        var centerY = (minimum.y + maximum.y) * 0.5;
        var halfLightLength = Math.max(0.45, (maximum.y - minimum.y) * 0.24);
        var layout = {
            leftX: Math.min(-0.25, minimum.x * 0.62),
            rightX: Math.max(0.25, maximum.x * 0.62),
            frontY: centerY + halfLightLength,
            rearY: centerY - halfLightLength,
            z: minimum.z + Math.min(0.18, Math.max(0.08, (maximum.z - minimum.z) * 0.08))
        };

        modelLayouts.set(modelHash, layout);
        return layout;
    }

    function getLightsState(vehicle) {
        try {
            return normalizeNativeArray(GetVehicleLightsState(vehicle));
        } catch (error) {
            return [];
        }
    }

    function createRuntime(vehicle) {
        var originalLights = getLightsState(vehicle);
        return {
            vehicle: vehicle,
            sirenSoundId: null,
            sirenSignature: null,
            manualSoundId: null,
            manualSignature: null,
            nativeSiren: null,
            emergency: isEmergencyVehicle(vehicle),
            headlightsOn: null,
            originalHighBeam: Boolean(originalLights[2])
        };
    }

    function stopRuntimeSound(runtime, channel) {
        var idKey = channel + 'SoundId';
        var signatureKey = channel + 'Signature';
        var soundId = runtime[idKey];

        if (soundId !== null && soundId !== undefined) {
            try {
                StopSound(soundId);
                ReleaseSoundId(soundId);
            } catch (error) {
                // The entity or sound may already have been released.
            }
        }

        runtime[idKey] = null;
        runtime[signatureKey] = null;
    }

    function updateRuntimeSound(runtime, channel, vehicle, desired) {
        var idKey = channel + 'SoundId';
        var signatureKey = channel + 'Signature';

        if (!desired) {
            stopRuntimeSound(runtime, channel);
            return;
        }

        if (!ensureAudioBanks(desired.banks)) {
            stopRuntimeSound(runtime, channel);
            return;
        }

        if (runtime[idKey] !== null && runtime[signatureKey] === desired.signature) {
            try {
                if (!HasSoundFinished(runtime[idKey])) {
                    return;
                }
            } catch (error) {
                return;
            }
        }

        stopRuntimeSound(runtime, channel);

        try {
            var soundId = GetSoundId();
            runtime[idKey] = soundId;
            PlaySoundFromEntity(
                soundId,
                desired.soundName,
                vehicle,
                desired.soundSet === null || desired.soundSet === undefined ? 0 : desired.soundSet,
                false,
                0
            );
            runtime[idKey] = soundId;
            runtime[signatureKey] = desired.signature;
        } catch (error) {
            stopRuntimeSound(runtime, channel);
            console.warn('yx_sirencontrol: unable to play emergency audio:', error);
        }
    }

    function ensureAudioBanks(banks) {
        var ready = true;
        var now = GetGameTimer();
        banks.forEach(function (name) {
            var bank = audioBanks.get(name);
            if (!bank) {
                bank = { requested: false, reportedReady: false, retryAt: 0, usedAt: now, requestedAt: 0, attempts: 0 };
                audioBanks.set(name, bank);
            }
            bank.usedAt = now;
            if (!bank.requested && now >= bank.retryAt) {
                try {
                    // FiveM can return false even when the bank loaded successfully
                    // (citizenfx/fivem#2989). Treat a completed native call as the
                    // request; data-file mount errors are reported by FiveM itself.
                    bank.reportedReady = Boolean(RequestScriptAudioBank(name, false));
                    bank.requested = true;
                    bank.requestedAt = now;
                    bank.attempts += 1;
                } catch (error) {
                    bank.retryAt = now + config.Audio.BankRetryMs;
                    console.warn('yx_sirencontrol: unable to request audio bank ' + name + ':', error);
                }
            }
            var delayMs = Math.max(0, Number(config.Audio.BankRequestDelayMs) || 0);
            if (!bank.requested || (!bank.reportedReady && now - bank.requestedAt < delayMs)) { ready = false; }
        });
        return ready;
    }

    function releaseUnusedBanks(all) {
        var now = GetGameTimer();
        audioBanks.forEach(function (bank, name) {
            if (all || now - bank.usedAt > config.Audio.BankIdleMs) {
                if (bank.requested) { ReleaseNamedScriptAudioBank(name); }
                audioBanks.delete(name);
            }
        });
    }

    function soundDefinition(pack, mode, selected, suffix) {
        var banks = selected.AudioBank || mode.AudioBank;
        banks = banks ? [banks] : (pack.AudioBanks || []);
        return { signature: [pack.Id, mode.Id || 'manual', suffix || '', selected.SoundName, selected.SoundSet || '', banks.join('|')].join(':'),
            soundName: selected.SoundName, soundSet: selected.SoundSet, banks: banks };
    }

    function sirenSoundForMode(state, time) {
        var pack = packs.get(state.packId);
        var mode = settings.tone(pack, state.toneId);

        if (mode.Type === 'pulse') {
            var onMs = Math.max(50, Math.trunc(mode.OnMs));
            var offMs = Math.max(30, Math.trunc(mode.OffMs));
            if ((time % (onMs + offMs)) >= onMs) {
                return null;
            }

            return soundDefinition(pack, mode, mode);
        }

        if (mode.Type === 'alternate') {
            var switchMs = Math.max(100, Math.trunc(mode.SwitchMs));
            var soundIndex = Math.floor(time / switchMs) % mode.Sounds.length;
            var selected = mode.Sounds[soundIndex];
            return soundDefinition(pack, mode, selected, soundIndex);
        }

        return soundDefinition(pack, mode, mode);
    }

    function manualHornSound(state, time) {
        var pack = packs.get(state.manualPackId);
        if (state.manualToneId === '@horn') {
            if (!pack.ManualHorn) { pack = packs.get('builtin'); }
            return soundDefinition(pack, pack.ManualHorn, pack.ManualHorn);
        }
        if (state.manualToneId === '@wail') {
            return sirenSoundForMode({ packId: 'builtin', toneId: 'wail' }, time);
        }
        return sirenSoundForMode({ packId: pack.Id, toneId: state.manualToneId }, time);
    }

    function restoreVehicleLights(runtime) {
        if (runtime.headlightsOn === null) {
            return;
        }

        var vehicle = runtime.vehicle;
        if (vehicle && DoesEntityExist(vehicle)) {
            try {
                SetVehicleLights(vehicle, 0);
                SetVehicleFullbeam(vehicle, runtime.originalHighBeam);
            } catch (error) {
                // The entity may despawn during cleanup.
            }
        }

        runtime.headlightsOn = null;
    }

    function cleanupRuntime(networkId) {
        var runtime = runtimes.get(networkId);
        if (!runtime) {
            return;
        }

        stopRuntimeSound(runtime, 'siren');
        stopRuntimeSound(runtime, 'manual');
        restoreVehicleLights(runtime);
        if (runtime.emergency && DoesEntityExist(runtime.vehicle)) {
            SetVehicleSiren(runtime.vehicle, false);
            SetVehicleHasMutedSirens(runtime.vehicle, false);
        }
        runtimes.delete(networkId);
    }

    function getRuntime(networkId, vehicle) {
        var runtime = runtimes.get(networkId);

        if (runtime && runtime.vehicle !== vehicle) {
            cleanupRuntime(networkId);
            runtime = null;
        }

        if (!runtime) {
            runtime = createRuntime(vehicle);
            runtimes.set(networkId, runtime);
        }

        return runtime;
    }

    function phaseInWindows(phase, windows) {
        for (var index = 0; index < windows.length; index += 1) {
            if (phase >= windows[index][0] && phase < windows[index][1]) {
                return true;
            }
        }
        return false;
    }

    function synchronizedTime() {
        try {
            if (typeof GetNetworkTimeAccurate === 'function') {
                var networkTime = Number(GetNetworkTimeAccurate());
                if (Number.isFinite(networkTime)) {
                    return networkTime >>> 0;
                }
            }
        } catch (error) {
            // Fall back to the local monotonic timer.
        }

        return Number(GetGameTimer()) >>> 0;
    }

    function currentFlashState(time) {
        var cycle = Math.max(1, Math.trunc(config.Lights.CycleMs));
        var phase = time % cycle;
        if (phase < 0) {
            phase += cycle;
        }

        var redOn = phaseInWindows(phase, config.Lights.RedWindows);
        var blueOn = phaseInWindows(phase, config.Lights.BlueWindows);
        return { redOn: redOn, blueOn: blueOn, headlightsOn: redOn || blueOn };
    }

    function setHeadlightPulse(runtime, vehicle, enabled) {
        if (runtime.headlightsOn === enabled) {
            return;
        }

        SetVehicleLights(vehicle, enabled ? 2 : 1);
        SetVehicleFullbeam(vehicle, enabled);
        runtime.headlightsOn = enabled;
    }

    function drawUnderbodyPoint(vehicle, x, y, z, color) {
        var position = vector3(GetOffsetFromEntityInWorldCoords(vehicle, x, y, z));
        DrawLightWithRange(
            position.x,
            position.y,
            position.z,
            color.r,
            color.g,
            color.b,
            config.Lights.Range,
            config.Lights.Intensity
        );
    }

    function drawUnderbodyLights(vehicle, layout, flash) {
        if (flash.redOn) {
            drawUnderbodyPoint(vehicle, layout.leftX, layout.frontY, layout.z, config.Lights.Red);
            drawUnderbodyPoint(vehicle, layout.leftX, layout.rearY, layout.z, config.Lights.Red);
        }

        if (flash.blueOn) {
            drawUnderbodyPoint(vehicle, layout.rightX, layout.frontY, layout.z, config.Lights.Blue);
            drawUnderbodyPoint(vehicle, layout.rightX, layout.rearY, layout.z, config.Lights.Blue);
        }
    }

    function renderVehicleState(networkId, state, playerPosition, time, flash, audible) {
        if (!state.enabled) {
            cleanupRuntime(networkId);
            return;
        }

        var vehicle = resolveVehicle(networkId);
        if (!vehicle) {
            cleanupRuntime(networkId);
            return;
        }

        if (state.stage === 0 && !state.manualHorn && !isEmergencyVehicle(vehicle)) {
            cleanupRuntime(networkId);
            return;
        }

        var runtime = getRuntime(networkId, vehicle);

        if (runtime.emergency) {
            // GTA's native siren switch drives the vehicle's own lightbar/extras.
            // Mute only the stock siren; all nearby clients play the registered tone.
            SetVehicleHasMutedSirens(vehicle, true);
            var lightsOn = state.stage > 0;
            // JS native BOOLs can be 0/1. Comparing 1 !== true calls SetVehicleSiren
            // every frame and restarts GTA's lightbar animation at its first phase.
            var nativeLightsOn = Boolean(IsVehicleSirenOn(vehicle));
            if (runtime.nativeSiren !== lightsOn || nativeLightsOn !== lightsOn) {
                SetVehicleSiren(vehicle, lightsOn);
                runtime.nativeSiren = lightsOn;
            }
        } else if (state.stage > 0) {
            try {
                setHeadlightPulse(runtime, vehicle, flash.headlightsOn);
            } catch (error) {
                // A streamed entity may disappear between checks.
            }
        } else {
            restoreVehicleLights(runtime);
        }

        updateRuntimeSound(
            runtime,
            'siren',
            vehicle,
            audible && state.stage === 2 && !state.sirenMuted && !state.manualHorn ? sirenSoundForMode(state, time) : null
        );
        updateRuntimeSound(runtime, 'manual', vehicle, audible && state.manualHorn ? manualHornSound(state, time) : null);

        if (state.stage <= 0 || runtime.emergency) {
            return;
        }

        var vehiclePosition = vector3(GetEntityCoords(vehicle, false));
        var maximumDistance = Math.max(1.0, numberOrZero(config.Lights.RenderDistance));
        if (squaredDistance(playerPosition, vehiclePosition) <= maximumDistance * maximumDistance) {
            drawUnderbodyLights(vehicle, readVehicleLayout(vehicle), flash);
        }
    }

    function applyState(networkId, enabled, stage, sirenMode, manualHorn, packId, toneId, parkKill, sirenMuted, manualPackId, manualToneId) {
        networkId = Math.trunc(numberOrZero(networkId));
        stage = clamp(Math.trunc(numberOrZero(stage)), 0, 2);
        sirenMode = clamp(Math.trunc(numberOrZero(sirenMode || 1)), 1, 5);

        if (networkId <= 0) {
            return;
        }

        if (!enabled) {
            states.delete(networkId);
            cleanupRuntime(networkId);
            if (beacon) { beacon.disabled(networkId); }
            if (localManualHornNetworkId === networkId) {
                localManualHornNetworkId = 0;
            }
            return;
        }

        var previous = states.get(networkId);
        packId = packId || (previous && previous.packId) || 'builtin';
        var pack = packs.get(packId);
        if (!pack) { console.warn('yx_sirencontrol: unknown synchronized pack ' + packId); return; }
        toneId = toneId || (previous && previous.toneId) || pack.DefaultSlots[sirenMode - 1];
        if (!settings.tone(pack, toneId)) { console.warn('yx_sirencontrol: unknown synchronized tone ' + toneId); return; }
        manualPackId = manualPackId || (previous && previous.manualHorn && previous.manualPackId) || packId;
        manualToneId = manualToneId || (previous && previous.manualHorn && previous.manualToneId) || '@horn';
        var manualPack = packs.get(manualPackId);
        if (manualHorn && (!manualPack || (manualToneId !== '@horn' && manualToneId !== '@wail' && !settings.tone(manualPack, manualToneId)))) {
            console.warn('yx_sirencontrol: unknown synchronized manual tone');
            manualHorn = false;
        }

        states.set(networkId, {
            enabled: true,
            stage: stage,
            sirenMode: sirenMode,
            sirenMuted: stage === 2 && (typeof sirenMuted === 'boolean' ? sirenMuted : Boolean(previous && previous.sirenMuted)),
            manualHorn: Boolean(manualHorn),
            manualPackId: manualPackId,
            manualToneId: manualToneId,
            packId: packId,
            toneId: toneId,
            parkKill: typeof parkKill === 'boolean' ? parkKill : (previous ? previous.parkKill : config.Persistence.DefaultParkKill)
        });
    }

    function releaseLocalManualHorn() {
        var networkId = localManualHornNetworkId;
        if (!networkId) {
            return;
        }

        localManualHornNetworkId = 0;
        var state = states.get(networkId);
        if (!state || !state.enabled) {
            return;
        }

        // Another front occupant can still be holding E or R. Only the server can
        // merge both releases into the shared manualHorn flag.
        TriggerServerEvent(EVENT_HORN_SERVER, networkId, false, '', '');
    }

    function setLocalManualHorn(networkId, key) {
        var state = states.get(networkId);
        if (!state || !state.enabled) {
            return;
        }

        if (key) {
            // Keep the current press attached to the selected tone. Another front
            // occupant changing the shared pack must not remap our held key or
            // submit a newer request on our behalf.
            if (localManualHornNetworkId === networkId && localManualKey === key) { return; }
            var vehicle = getControlVehicle(false);
            if (!vehicle || getVehicleNetworkId(vehicle, false) !== networkId) { return; }
            var preferences = preferencesForVehicle(vehicle);
            var manualToneId = preferences.manualBindings[state.packId][key];
            var signature = state.packId + ':' + manualToneId;
            // A different player's newer request may currently win. Holding this key
            // must not repeatedly reassert our request and steal their priority.
            if (localManualHornNetworkId === networkId && localManualSignature === signature) {
                localManualKey = key;
                return;
            }

            if (localManualHornNetworkId && localManualHornNetworkId !== networkId) {
                releaseLocalManualHorn();
            }

            localManualHornNetworkId = networkId;
            localManualSignature = signature;
            localManualKey = key;
            applyState(networkId, true, state.stage, state.sirenMode, true, state.packId, state.toneId,
                state.parkKill, state.sirenMuted, state.packId, manualToneId);
            TriggerServerEvent(EVENT_HORN_SERVER, networkId, true, state.packId, manualToneId);
            showElsStatus(state.stage, state.sirenMuted);
            return;
        }

        if (localManualHornNetworkId === networkId) {
            releaseLocalManualHorn();
        }
    }

    function requestStage(networkId, stage) {
        var state = states.get(networkId);
        if (!state) {
            return;
        }

        stage = clamp(Math.trunc(stage), 0, 2);
        localManualHornNetworkId = 0;
        var vehicle = getControlVehicle(false);
        if (!vehicle || getVehicleNetworkId(vehicle, false) !== networkId) { return; }
        var preferences = operatingPreferences(vehicle, state);
        var nextState = stateFromPreferences(preferences, stage, stage === state.stage && state.sirenMuted);
        sendState(networkId, nextState);
        showElsStatus(stage, nextState.sirenMuted);
    }

    function requestSirenMode(networkId, sirenMode) {
        var state = states.get(networkId);
        if (!state || state.stage <= 0) {
            return;
        }

        sirenMode = clamp(Math.trunc(sirenMode), 1, 5);
        localManualHornNetworkId = 0;
        var vehicle = getControlVehicle(false);
        if (!vehicle || getVehicleNetworkId(vehicle, false) !== networkId) { return; }
        var preferences = operatingPreferences(vehicle, state);
        // A key in LIGHT always starts its tone, including the saved slot.
        // Only repeating a currently sounding slot switches the siren off.
        var sirenMuted = state.stage === 2 && sirenMode === state.sirenMode && !state.sirenMuted;
        preferences.slot = sirenMode;
        persistPreferences(vehicle, preferences);
        sendState(networkId, stateFromPreferences(preferences, 2, sirenMuted));
        showElsStatus(2, sirenMuted);
    }

    function handleCommand(args) {
        if (!synced) { notify('警笛数据正在同步，请稍后再试。'); return; }
        var action = args && args.length > 0 ? String(args[0]).toLowerCase() : '';
        if (action !== 'on' && action !== 'off') {
            notify('用法：/' + config.Command + ' on 或 /' + config.Command + ' off');
            return;
        }

        var vehicle = getControlVehicle(true);
        if (!vehicle) {
            return;
        }

        var networkId = getVehicleNetworkId(vehicle, true);
        if (!networkId) {
            return;
        }

        checkControlVehicle();

        if (action === 'on') {
            var current = states.get(networkId);
            if (current && current.enabled) {
                showElsStatus(current.stage, current.sirenMuted);
                return;
            }

            var preferences = preferencesForVehicle(vehicle);
            sendState(networkId, stateFromPreferences(preferences, 0));
            showElsStatus(0, false);
            notify('功能已开启；SHIFT+E/Q 换档，LIGHT 时按 1～5 开启对应警笛，按住 E/R 播放手动警笛。');
            return;
        }

        if (localManualHornNetworkId === networkId) {
            localManualHornNetworkId = 0;
        }
        var offPreferences = preferencesForVehicle(vehicle);
        var offState = stateFromPreferences(offPreferences, 0);
        offState.enabled = false;
        sendState(networkId, offState);
        showElsStatus(0, false);
        if (!isEmergencyVehicle(vehicle)) { refreshMenu(); }
    }

    function handleVehicleControls() {
        if (!synced || IsPauseMenuActive() || (typeof IsNuiFocused === 'function' && IsNuiFocused())) {
            releaseLocalManualHorn();
            return;
        }

        var vehicle = getControlVehicle(false);
        if (!vehicle) {
            releaseLocalManualHorn();
            return;
        }

        var networkId = getVehicleNetworkId(vehicle, false);
        var state = states.get(networkId);
        if (!networkId || !state || !state.enabled) {
            releaseLocalManualHorn();
            return;
        }

        var controls = config.Controls;

        // Suppress all radio actions while this vehicle's ELS is enabled. Q is
        // then exclusively available to the Shift+Q downshift shortcut.
        disableControls(controls.Radio);
        disableControls(controls.Up);
        disableControls(controls.Down);
        disableControls(controls.Horn);
        disableControls(controls.ManualR);

        if (state.stage > 0) {
            disableControls(controls.SirenModes);
        }

        var shiftPressed = anyControlPressed(controls.Shift);
        if (shiftPressed) {
            releaseLocalManualHorn();

            var upPressed = anyControlJustPressed(controls.Up);
            var downPressed = anyControlJustPressed(controls.Down);
            if (!upPressed && !downPressed) {
                return;
            }

            var now = GetGameTimer();
            if (now < nextInputAt) {
                return;
            }
            nextInputAt = now + Math.max(100, Math.trunc(controls.DebounceMs));

            if (upPressed) {
                requestStage(networkId, (state.stage + 1) % 3);
            } else if (state.stage > 0) {
                requestStage(networkId, state.stage - 1);
            } else {
                showElsStatus(0, false);
            }
            return;
        }

        var manualKey = anyControlPressed(controls.Horn) ? 'e' : (anyControlPressed(controls.ManualR) ? 'r' : null);
        setLocalManualHorn(networkId, manualKey);

        if (state.stage <= 0) {
            return;
        }

        for (var modeIndex = 0; modeIndex < controls.SirenModes.length; modeIndex += 1) {
            if (anyControlJustPressed(controls.SirenModes[modeIndex])) {
                requestSirenMode(networkId, modeIndex + 1);
                return;
            }
        }
    }

    RegisterCommand(config.Command, function (source, args) {
        handleCommand(args);
    }, false);
    var menuCommands = [config.MenuCommand];
    var menuKey = typeof config.MenuKey === 'string' && config.MenuKey.trim() ? config.MenuKey.trim() : 'I';
    menuCommands.forEach(function (command) { RegisterCommand(command, openMenu, false); });
    RegisterKeyMapping(config.MenuCommand, '打开警灯警笛设置菜单', 'keyboard', menuKey);
    on('yx_sirencontrol:menu:action', handleMenuAction);
    on('yx_sirencontrol:menu:visibility', function (visible) {
        menuOpen = Boolean(visible);
        if (!menuOpen) { menuVehicle = 0; }
    });

    onNet(EVENT_SET_CLIENT, function (networkId, enabled, stage, sirenMode, manualHorn, packId, toneId, parkKill, sirenMuted, manualPackId, manualToneId) {
        applyState(networkId, Boolean(enabled), stage, sirenMode, Boolean(manualHorn), packId, toneId, parkKill, sirenMuted, manualPackId, manualToneId);
        var vehicle = getControlVehicle(false);
        if (vehicle && getVehicleNetworkId(vehicle, false) === Number(networkId)) {
            showElsStatus(enabled ? stage : 0, enabled && sirenMuted);
        }
        refreshMenu();
    });
    onNet('yx_sirencontrol:client:syncComplete', function () {
        synced = true;
        beacon.sync();
    });

    onNet(EVENT_REJECTED_CLIENT, function (networkId, reason) {
        if (localManualHornNetworkId === Math.trunc(numberOrZero(networkId))) {
            localManualHornNetworkId = 0;
        }
        notify(rejectionMessage(String(reason || 'invalid_vehicle')));
    });

    beacon = globalThis.YXRoofBeacon.create({
        resourceName: resourceName,
        command: config.Command,
        state: function (networkId) { return states.get(networkId); },
        synced: function () { return synced; },
        isEmergency: isEmergencyVehicle,
        mountOffset: function (vehicle) { return preferencesForVehicle(vehicle).beaconOffset; },
        changed: refreshMenu,
        notify: notify
    });

    setTick(function () {
        var now = GetGameTimer();
        if (!synced && now >= nextSyncRequest) {
            nextSyncRequest = now + 5000;
            TriggerServerEvent(EVENT_SYNC_SERVER);
        }
        if (now >= nextControlCheck) {
            nextControlCheck = now + 100;
            checkControlVehicle();
            releaseUnusedBanks(false);
        }
        beacon.tick();
        handleVehicleControls();

        if (states.size > 0) {
            var playerPed = PlayerPedId();
            if (playerPed && DoesEntityExist(playerPed)) {
                var playerPosition = vector3(GetEntityCoords(playerPed, false));
                var time = synchronizedTime();
                var flash = currentFlashState(time);
                // Allocate sound handles only to nearby vehicles; parked/streamed fleets
                // must not exhaust the game's finite sound pool.
                var maxDistance = Math.max(1, config.Audio.RenderDistance);
                var audibleIds = new Set(Array.from(states.entries()).filter(function (pair) {
                    return (pair[1].stage === 2 && !pair[1].sirenMuted) || pair[1].manualHorn;
                }).map(function (pair) {
                    var vehicle = resolveVehicle(pair[0]);
                    return { id: pair[0], distance: vehicle ? squaredDistance(playerPosition, vector3(GetEntityCoords(vehicle, false))) : Infinity };
                }).filter(function (item) { return item.distance <= maxDistance * maxDistance; })
                    .sort(function (a, b) { return a.distance - b.distance; })
                    .slice(0, Math.max(1, config.Audio.MaxAudibleVehicles)).map(function (item) { return item.id; }));

                states.forEach(function (state, networkId) {
                    renderVehicleState(networkId, state, playerPosition, time, flash, audibleIds.has(networkId));
                });
            }
        }

        drawElsHud();
    });

    on('onClientResourceStart', function (startedResource) {
        if (startedResource !== resourceName) {
            return;
        }

        TriggerEvent('chat:addSuggestion', '/' + config.Command, '开启或关闭当前载具的 ELS 警灯警笛', [
            { name: 'on/off', help: 'on 开启；off 关闭' }
        ]);
        menuCommands.forEach(function (command) {
            TriggerEvent('chat:addSuggestion', '/' + command,
                '打开当前车辆的警笛设置（默认 ' + menuKey + ' 键）');
        });

        setTimeout(function () {
            TriggerServerEvent(EVENT_SYNC_SERVER);
        }, 500);
    });

    on('onClientResourceStop', function (stoppedResource) {
        if (stoppedResource !== resourceName) {
            return;
        }

        beacon.stop();
        Array.from(runtimes.keys()).forEach(cleanupRuntime);
        releaseUnusedBanks(true);
        states.clear();
        localManualHornNetworkId = 0;
        TriggerEvent('chat:removeSuggestion', '/' + config.Command);
        menuCommands.forEach(function (command) { TriggerEvent('chat:removeSuggestion', '/' + command); });
    });
}());
