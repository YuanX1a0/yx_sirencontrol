// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 YuanX1a0
// Server-owned attachment state; each observer renders one non-networked prop.
(function () {
    'use strict';

    function inactive() {
        return { tick: function () {}, stop: function () {}, sync: function () {}, disabled: function () {}, isBusy: function () { return false; } };
    }

    globalThis.YXRoofBeacon = { create: function (context) {
        var resourceName = String(GetCurrentResourceName() || '');
        if (resourceName !== 'yx_sirencontrol') {
            console.error('[yx_sirencontrol] 资源名验证失败：当前资源名为 "' + resourceName +
                '"，资源目录必须命名为 "yx_sirencontrol"。便携警灯已停用。');
            return inactive();
        }
        var prefix = 'yx_sirencontrol:beacon:';
        var config;
        try { config = JSON.parse(LoadResourceFile(resourceName, 'config/beacon.json').replace(/^\uFEFF/, '')); }
        catch (error) {
            console.error('[yx_sirencontrol] 无法加载车顶警灯配置：' + error.message);
            return inactive();
        }
        var command = config.Command || 'putsiren';
        var model = GetHashKey(config.Model || 'yx_movia_d_red');
        var ledModel = config.LedModel ? GetHashKey(config.LedModel) : 0;
        var animation = config.Animation || {};
        var records = new Map(), visuals = new Map(), actions = new Map();
        var pendingTimers = new Set();
        var preparation = null, requestedAt = null, modelsRequested = false;
        var busySignature = '';
        var nextSync = 0, snapshotReceived = false, stopped = false;
        var loadTimeout = bounded(config.LoadTimeoutMs, 6000, 1000, 15000);
        var range = bounded(config.RenderDistance, 120, 10, 300);
        var cycle = bounded(config.FlashPeriodMs, 800, 200, 5000);
        var flashes = config.FlashWindowsMs || [[0, 90], [160, 250], [320, 410], [480, 570]];
        var handBone = 18905; // SKEL_L_Hand

        function bounded(value, fallback, min, max) {
            value = Number(value);
            return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
        }
        function point(value) {
            return { x: Number(value[0] === undefined ? value.x : value[0]) || 0,
                y: Number(value[1] === undefined ? value.y : value[1]) || 0,
                z: Number(value[2] === undefined ? value.z : value[2]) || 0 };
        }
        function world(vehicle, p) { return point(GetOffsetFromEntityInWorldCoords(vehicle, p.x, p.y, p.z)); }
        function localPoint(vehicle, p) { return point(GetOffsetFromEntityGivenWorldCoords(vehicle, p.x, p.y, p.z)); }
        function resolve(networkId, modelHash) {
            if (!NetworkDoesNetworkIdExist(networkId)) return 0;
            var vehicle = NetworkGetEntityFromNetworkId(networkId);
            return vehicle && DoesEntityExist(vehicle) && IsEntityAVehicle(vehicle) &&
                (GetEntityModel(vehicle) >>> 0) === (modelHash >>> 0) ? vehicle : 0;
        }
        function validId(id) { return Number.isInteger(id) && id > 0; }
        function validModel(hash) { return Number.isInteger(hash) && hash !== 0; }
        function validToken(token) { return (typeof token === 'string' && token.length > 0 && token.length < 128) || validId(token); }
        function actorPed(serverId) {
            var player = GetPlayerFromServerId(serverId);
            if (player === -1) return 0;
            var ped = GetPlayerPed(player);
            return ped && DoesEntityExist(ped) ? ped : 0;
        }
        function isLocalActor(serverId) { return Number(serverId) === GetPlayerServerId(PlayerId()); }
        function notifyBusyChange() {
            if (stopped) return;
            var busy = new Set();
            if (preparation) busy.add(preparation.id + ':' + preparation.modelHash);
            actions.forEach(function (action, id) { busy.add(id + ':' + action.modelHash); });
            var signature = Array.from(busy).sort().join(',');
            if (signature === busySignature) return;
            busySignature = signature;
            if (typeof context.changed !== 'function') return;
            try { context.changed(); }
            catch (error) { console.error('[yx_sirencontrol] 无法刷新车顶警灯设置菜单：' + (error.stack || error)); }
        }
        function operatorVehicle(showError) {
            var ped = PlayerPedId(), vehicle = GetVehiclePedIsIn(ped, false);
            var message;
            if (!vehicle || !DoesEntityExist(vehicle) || IsEntityDead(ped) || GetPedInVehicleSeat(vehicle, -1) !== ped) {
                message = '只有主驾驶位的玩家可以放置或收回车顶警灯。';
            } else if (context.isEmergency(vehicle)) {
                message = '紧急车辆不能使用便携车顶警灯。';
            } else if ([8, 13, 14, 15, 16, 21].indexOf(GetVehicleClass(vehicle)) !== -1) {
                message = '请在有车顶的非紧急汽车内使用。';
            } else if (!context.synced() || !context.state(NetworkGetNetworkIdFromEntity(vehicle))) {
                message = '请先输入 /' + context.command + ' on，再使用 /' + command + '。';
            } else if (IsPauseMenuActive() || (typeof IsNuiFocused === 'function' && IsNuiFocused())) {
                return 0;
            }
            if (message) { if (showError) context.notify(message); return 0; }
            return vehicle;
        }
        function modelsReady() {
            if (!modelsRequested) {
                RequestModel(model);
                if (ledModel) RequestModel(ledModel);
                modelsRequested = true;
            }
            return HasModelLoaded(model) && (!ledModel || HasModelLoaded(ledModel));
        }
        function deleteProp(entity) {
            if (entity && DoesEntityExist(entity)) {
                DetachEntity(entity, true, true);
                SetEntityAsMissionEntity(entity, true, true);
                DeleteEntity(entity);
            }
        }
        function dropVisual(id) {
            var visual = visuals.get(id);
            if (!visual) return;
            // Clear ownership before native cleanup, so delayed callbacks cannot
            // reuse a handle that has already been retired.
            visuals.delete(id);
            deleteProp(visual.base); deleteProp(visual.led);
        }
        function cleanupOldHandProps() {
            // Older releases could leave a local mission prop attached after a
            // resource reload. Touch only this resource's known models on our ped.
            var ped = PlayerPedId();
            if (!ped || !DoesEntityExist(ped)) return;
            var hashes = new Set(['yx_portable_beacon', 'yx_portable_beacon_rotor',
                'yx_movia_d_red', 'yx_movia_d_red_led', 'yx_movia_d_red_glow'].map(function (name) { return GetHashKey(name) >>> 0; }));
            GetGamePool('CObject').forEach(function (entity) {
                if (DoesEntityExist(entity) && !NetworkGetEntityIsNetworked(entity) &&
                    hashes.has(GetEntityModel(entity) >>> 0) && IsEntityAttachedToEntity(entity, ped)) deleteProp(entity);
            });
        }
        function makeProp(hash, position) {
            var entity = CreateObjectNoOffset(hash, position.x, position.y, position.z, false, false, false);
            if (!entity) return 0;
            SetEntityAsMissionEntity(entity, true, true);
            SetEntityCollision(entity, false, false);
            SetEntityInvincible(entity, true);
            SetEntityHasGravity(entity, false);
            return entity;
        }
        function roofPosition(vehicle) {
            var dimensions = GetModelDimensions(GetEntityModel(vehicle));
            var min = point(dimensions[0]), max = point(dimensions[1]);
            var seat = GetEntityBoneIndexByName(vehicle, 'seat_dside_f');
            var seatPosition = seat >= 0 ? localPoint(vehicle, point(GetWorldPositionOfEntityBone(vehicle, seat))) : { y: max.y * 0.15 };
            var roof = { x: min.x * 0.60, y: bounded(seatPosition.y, 0, min.y * 0.65, max.y * 0.65), z: max.z + 0.006 };
            var overrides = config.MountOffsets || {};
            var override = Object.keys(overrides).find(function (name) { return (GetHashKey(name) >>> 0) === (GetEntityModel(vehicle) >>> 0); });
            if (override) return { roof: point(overrides[override]), min: min, fixed: true };
            return { roof: roof, min: min, fixed: false };
        }
        function ensureVisual(id, vehicle) {
            var previous = visuals.get(id);
            if (previous && (previous.vehicle !== vehicle || !DoesEntityExist(previous.base) ||
                (previous.led && !DoesEntityExist(previous.led)))) {
                dropVisual(id); previous = null;
            }
            if (previous) return previous;
            if (!modelsReady()) return null;
            var mount = roofPosition(vehicle), position = world(vehicle, mount.roof);
            var base = makeProp(model, position);
            if (!base) return null;
            var led = ledModel ? makeProp(ledModel, position) : 0;
            if (ledModel && !led) { deleteProp(base); return null; }
            var visual = { vehicle: vehicle, base: base, led: led, baseRoof: mount.roof, roof: mount.roof,
                min: mount.min, target: '', lit: false };
            if (led) SetEntityVisible(led, false, false);
            if (!mount.fixed) {
                var above = world(vehicle, { x: mount.roof.x, y: mount.roof.y, z: mount.roof.z + 0.8 });
                var below = world(vehicle, { x: mount.roof.x, y: mount.roof.y, z: mount.roof.z - 1.0 });
                visual.ray = StartShapeTestRay(above.x, above.y, above.z, below.x, below.y, below.z, 2, PlayerPedId(), 7);
                visual.rayUntil = GetGameTimer() + 1000;
            }
            visuals.set(id, visual);
            return visual;
        }
        function adjustRoof(visual) {
            if (!visual.ray) return;
            var result = GetShapeTestResult(visual.ray);
            if (result[0] === 1 && GetGameTimer() < visual.rayUntil) return;
            visual.ray = 0;
            if (result[0] === 2 && result[1] && result[4] === visual.vehicle) {
                var hit = localPoint(visual.vehicle, point(result[2]));
                visual.baseRoof = { x: hit.x, y: hit.y, z: hit.z + 0.006 };
            }
        }
        function refreshMountOffset(visual) {
            var delta = typeof context.mountOffset === 'function' ? context.mountOffset(visual.vehicle) : null;
            delta = delta || {};
            // Always add the saved delta to the original automatic/configured
            // mount, never to the previous effective position (which would drift).
            var roof = { x: visual.baseRoof.x + bounded(delta.x, 0, -2, 2),
                y: visual.baseRoof.y + bounded(delta.y, 0, -2, 2),
                z: visual.baseRoof.z + bounded(delta.z, 0, -2, 2) };
            if (roof.x === visual.roof.x && roof.y === visual.roof.y && roof.z === visual.roof.z) return;
            visual.roof = roof;
            // A roof adjustment should reattach both roof entities once, without
            // changing the separate hand offset or recreating either model.
            if (visual.target === 'roof') visual.target = '';
        }
        function attach(visual, ped) {
            var target = ped ? 'hand:' + ped : 'roof';
            var offset = ped ? point(config.HandOffset || [0.06, 0, -0.075]) : visual.roof;
            var rotation = ped ? point(config.HandRotation || [0, 0, 0]) : { x: 0, y: 0, z: 0 };
            var entity = ped || visual.vehicle, bone = ped ? GetPedBoneIndex(ped, handBone) : 0;
            if (visual.target !== target || !IsEntityAttachedToEntity(visual.base, entity)) {
                DetachEntity(visual.base, true, true);
                AttachEntityToEntity(visual.base, entity, bone, offset.x, offset.y, offset.z,
                    rotation.x, rotation.y, rotation.z, false, false, false, Boolean(ped), 2, true);
            }
            if (visual.led && (visual.target !== target || !IsEntityAttachedToEntity(visual.led, entity))) {
                DetachEntity(visual.led, true, true);
                AttachEntityToEntity(visual.led, entity, bone, offset.x, offset.y, offset.z,
                    rotation.x, rotation.y, rotation.z, false, false, false, Boolean(ped), 2, true);
            }
            visual.target = IsEntityAttachedToEntity(visual.base, entity) &&
                (!visual.led || IsEntityAttachedToEntity(visual.led, entity)) ? target : '';
        }
        function setLit(visual, enabled) {
            if (visual.lit !== enabled) {
                if (visual.led) SetEntityVisible(visual.led, enabled, false);
                visual.lit = enabled;
            }
        }
        function stopPose(action) {
            if (action.played && !action.poseStopped && isLocalActor(action.actor)) {
                action.poseStopped = true;
                StopAnimTask(action.ped || PlayerPedId(), animation.Dict, animation.Clip, 5.0);
            }
        }
        function stopAction(id) {
            var action = actions.get(id);
            if (!action) return;
            actions.delete(id);
            // Never retain the hand object for a cancelled removal. The installed
            // roof object is recreated from authoritative state on the next frame.
            dropVisual(id);
            stopPose(action);
            notifyBusyChange();
        }
        function cancelPreparation(message) {
            if (!preparation) return;
            TriggerServerEvent(prefix + 'cancel', preparation.id, preparation.token);
            preparation = null;
            notifyBusyChange();
            if (message) context.notify(message);
        }
        function handlePreparation(now) {
            if (!preparation) return;
            var vehicle = operatorVehicle(false);
            if (!vehicle || vehicle !== resolve(preparation.id, preparation.modelHash)) {
                cancelPreparation('操作已取消：车辆或驾驶位状态发生变化。'); return;
            }
            if (now > preparation.until) { cancelPreparation('警灯模型或动作加载超时，请检查资源文件。'); return; }
            var ready = modelsReady();
            if (animation.Dict && animation.Clip) {
                RequestAnimDict(animation.Dict);
                ready = ready && HasAnimDictLoaded(animation.Dict);
            }
            if (ready && !preparation.sent) {
                preparation.sent = true;
                TriggerServerEvent(prefix + 'ready', preparation.id, preparation.token);
            }
        }
        function failAction(id, action, message) {
            stopAction(id);
            if (isLocalActor(action.actor)) {
                TriggerServerEvent(prefix + 'cancel', id, action.token);
                context.notify(message);
            }
        }
        function scheduleAction(id, action, delay, callback) {
            var timer = setTimeout(function () {
                pendingTimers.delete(timer);
                if (stopped || actions.get(id) !== action) return;
                try { callback(); }
                catch (error) {
                    failAction(id, action, '车顶警灯操作异常，已清理临时模型。');
                    console.error('[yx_sirencontrol] putsiren: ' + (error.stack || error));
                }
            }, delay);
            pendingTimers.add(timer);
        }
        function checkAction(id, action) {
            var vehicle = resolve(id, action.modelHash);
            if (isLocalActor(action.actor) && (!vehicle || operatorVehicle(false) !== vehicle)) {
                failAction(id, action, '操作已取消：车辆或驾驶位状态发生变化。'); return false;
            }
            return true;
        }
        function observePose(action) {
            var ped = action.ped || actorPed(action.actor);
            if (ped && DoesEntityExist(ped) && IsEntityPlayingAnim(ped, animation.Dict, animation.Clip, 3)) action.sawPlaying = true;
        }
        function transferAction(id, action) {
            if (action.transferred || !checkAction(id, action)) return;
            action.transferred = true;
            // Recreate the roof/hand object instead of reparenting the same entity.
            // This guarantees the old hand attachment is explicitly deleted.
            dropVisual(id);
        }
        function finishAction(id, action) {
            if (action.finished || !checkAction(id, action)) return;
            observePose(action);
            if (isLocalActor(action.actor) && !action.sawPlaying) {
                failAction(id, action, '车内动作未能播放，本次操作已取消。'); return;
            }
            action.finished = true;
            dropVisual(id);
            stopPose(action);
            if (isLocalActor(action.actor) && !action.completed) {
                action.completed = true;
                TriggerServerEvent(prefix + 'complete', id, action.token);
            }
        }
        function beginAction(id, action) {
            if (!checkAction(id, action)) return;
            action.ped = isLocalActor(action.actor) ? PlayerPedId() : actorPed(action.actor);
            if (isLocalActor(action.actor)) {
                if (!animation.Dict || !animation.Clip || !HasAnimDictLoaded(animation.Dict)) {
                    failAction(id, action, '车内动作尚未加载，本次操作已取消。'); return;
                }
                RollDownWindow(resolve(id, action.modelHash), 0);
                // Match RPEmotes' in-vehicle path exactly: blend 5/5, flags 51,
                // playback argument 0 and a finite 2000 ms duration.
                TaskPlayAnim(action.ped, animation.Dict, animation.Clip, 5.0, 5.0, action.duration, 51, 0.0, false, false, false);
                action.played = true;
            }
            observePose(action);
            scheduleAction(id, action, 250, function () { if (checkAction(id, action)) observePose(action); });
            scheduleAction(id, action, 650, function () {
                if (!checkAction(id, action)) return;
                observePose(action);
                if (isLocalActor(action.actor) && !action.sawPlaying) failAction(id, action, '车内动作未能播放，本次操作已取消。');
            });
            scheduleAction(id, action, action.duration / 2, function () { transferAction(id, action); });
            scheduleAction(id, action, action.duration, function () { finishAction(id, action); });
            scheduleAction(id, action, action.duration + 4000, function () {
                failAction(id, action, '操作确认超时，已清理临时模型。');
            });
        }
        function lamp(visual, now) {
            var time = typeof GetNetworkTimeAccurate === 'function' ? GetNetworkTimeAccurate() >>> 0 : now;
            var phase = time % cycle;
            var lit = flashes.some(function (window) { return phase >= window[0] && phase < window[1]; });
            attach(visual, 0); setLit(visual, lit);
            if (!lit) return;
            var origin = world(visual.vehicle, { x: visual.roof.x, y: visual.roof.y, z: visual.roof.z + bounded(config.LightHeight, 0.088, 0.02, 0.25) });
            var color = config.Color || [255, 12, 12];
            DrawLightWithRange(origin.x, origin.y, origin.z, color[0], color[1], color[2],
                bounded(config.LightRange, 12, 1, 30), bounded(config.LightIntensity, 3.0, 0.1, 10));
        }
        function setState(id, hash, installed, revision) {
            if (!validId(id) || !validModel(hash) || typeof installed !== 'boolean' || !Number.isInteger(revision) || revision < 0) return;
            var previous = records.get(id);
            if (previous && previous.revision > revision) return;
            if (previous && previous.revision === revision && previous.modelHash === (hash >>> 0) && previous.installed === installed) return;
            if (!previous || previous.modelHash !== (hash >>> 0)) dropVisual(id);
            records.set(id, { modelHash: hash >>> 0, installed: installed, revision: revision });
            var action = actions.get(id);
            if (action && revision > action.baseRevision) {
                if (isLocalActor(action.actor)) context.notify(installed ? '车顶 LED 警灯已放置。' : '车顶 LED 警灯已收回。');
                stopAction(id);
            }
            if (!installed && !actions.has(id)) dropVisual(id);
        }

        RegisterCommand(command, function () {
            var vehicle = operatorVehicle(true);
            if (!vehicle) return;
            var id = NetworkGetNetworkIdFromEntity(vehicle), now = GetGameTimer();
            if (!validId(id)) { context.notify('车辆尚未联网，请稍后再试。'); return; }
            if (preparation || actions.has(id) || (requestedAt !== null && now - requestedAt < 1500)) {
                context.notify('正在操作车顶警灯，请稍候。'); return;
            }
            cleanupOldHandProps();
            requestedAt = now;
            TriggerServerEvent(prefix + 'request', id);
        }, false);
        onNet(prefix + 'prepare', function (id, hash, token, placing) {
            if (!validId(id) || !validModel(hash) || !validToken(token) || typeof placing !== 'boolean') return;
            preparation = { id: id, modelHash: hash >>> 0, token: token, placing: placing, until: GetGameTimer() + loadTimeout };
            notifyBusyChange();
        });
        onNet(prefix + 'action', function (id, hash, token, actor, placing, duration, baseRevision) {
            if (!validId(id) || !validModel(hash) || !validToken(token) || !validId(actor) || typeof placing !== 'boolean') return;
            var existing = actions.get(id), current = records.get(id);
            if ((existing && existing.token === token) || (current && Number.isInteger(baseRevision) && current.revision > baseRevision)) return;
            if (preparation && preparation.id === id && preparation.token === token) preparation = null;
            stopAction(id);
            var action = { modelHash: hash >>> 0, token: token, actor: actor, placing: placing,
                duration: bounded(duration, 2000, 500, 10000), start: GetGameTimer(),
                baseRevision: Number.isInteger(baseRevision) ? baseRevision : ((records.get(id) || {}).revision || 0) };
            actions.set(id, action);
            notifyBusyChange();
            try { beginAction(id, action); }
            catch (error) {
                failAction(id, action, '车顶警灯动作启动失败，已清理临时模型。');
                console.error('[yx_sirencontrol] putsiren: ' + (error.stack || error));
            }
        });
        onNet(prefix + 'state', setState);
        onNet(prefix + 'cancelled', function (id, token) {
            if (preparation && preparation.id === id && preparation.token === token) preparation = null;
            var action = actions.get(id);
            if (action && action.token === token) stopAction(id);
            notifyBusyChange();
        });
        onNet(prefix + 'error', function (message) {
            requestedAt = null;
            context.notify(String(message || '车顶警灯操作失败。').slice(0, 300));
        });
        onNet(prefix + 'snapshot', function (payload) {
            var snapshot;
            try { snapshot = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (error) { return; }
            var list = Array.isArray(snapshot) ? snapshot : snapshot && snapshot.beacons;
            if (!Array.isArray(list) || list.length > 4096) return;
            var revision = Array.isArray(snapshot) ? Infinity : Number(snapshot.revision);
            if (!Number.isFinite(revision) && revision !== Infinity) return;
            var present = new Set();
            list.forEach(function (entry) {
                if (!entry || !validId(entry.networkId)) return;
                present.add(entry.networkId);
                setState(entry.networkId, entry.modelHash, entry.installed, entry.revision);
            });
            records.forEach(function (entry, id) {
                if (!present.has(id) && entry.revision <= revision) {
                    records.delete(id);
                    if (!actions.has(id)) dropVisual(id);
                }
            });
            snapshotReceived = true;
        });
        on('onClientResourceStart', function (name) {
            if (name === resourceName) {
                cleanupOldHandProps();
                TriggerEvent('chat:addSuggestion', '/' + command,
                    '主驾驶放置／收回车顶 LED 警灯；授权职业、非紧急车且先 /' + context.command + ' on');
            }
        });

        return {
            sync: function () { snapshotReceived = false; nextSync = 0; },
            isBusy: function (vehicle) {
                if (stopped || !vehicle || !DoesEntityExist(vehicle) || !IsEntityAVehicle(vehicle)) return false;
                var id = NetworkGetNetworkIdFromEntity(vehicle);
                if (!validId(id)) return false;
                var action = actions.get(id);
                return Boolean((preparation && preparation.id === id && resolve(id, preparation.modelHash) === vehicle) ||
                    (action && resolve(id, action.modelHash) === vehicle));
            },
            disabled: function (id) {
                if (preparation && preparation.id === id) cancelPreparation();
                var action = actions.get(id);
                if (action && isLocalActor(action.actor)) TriggerServerEvent(prefix + 'cancel', id, action.token);
                stopAction(id); dropVisual(id); records.delete(id);
            },
            tick: function () {
                if (stopped) return;
                var now = GetGameTimer();
                if (context.synced() && now >= nextSync) {
                    nextSync = now + (snapshotReceived ? 30000 : 5000);
                    TriggerServerEvent(prefix + 'sync');
                }
                handlePreparation(now);
                var ids = new Set(Array.from(records.keys()).concat(Array.from(actions.keys())));
                var playerPosition = point(GetEntityCoords(PlayerPedId(), false));
                ids.forEach(function (id) {
                    var action = actions.get(id), record = records.get(id);
                    var hash = action ? action.modelHash : record.modelHash;
                    var vehicle = resolve(id, hash);
                    if (action && (now > action.start + action.duration + 4500 ||
                        (isLocalActor(action.actor) && (!vehicle || operatorVehicle(false) !== vehicle)))) {
                        if (isLocalActor(action.actor)) TriggerServerEvent(prefix + 'cancel', id, action.token);
                        stopAction(id); return;
                    }
                    if (!vehicle) { dropVisual(id); return; }
                    var position = point(GetEntityCoords(vehicle, false));
                    var distance = Math.pow(position.x - playerPosition.x, 2) + Math.pow(position.y - playerPosition.y, 2) + Math.pow(position.z - playerPosition.z, 2);
                    if (distance > range * range || context.isEmergency(vehicle)) { dropVisual(id); return; }
                    if (!action && (!record || !record.installed)) { dropVisual(id); return; }
                    if (action && action.finished && !action.placing) { dropVisual(id); return; }
                    if (action && !action.finished) {
                        observePose(action);
                        if (!action.sawPlaying && action.placing && !action.transferred) { dropVisual(id); return; }
                    }
                    var visual = ensureVisual(id, vehicle);
                    if (!visual) return;
                    adjustRoof(visual);
                    refreshMountOffset(visual);
                    if (action && !action.finished) {
                        var ped = action.ped || actorPed(action.actor);
                        var inHand = action.placing ? !action.transferred : action.transferred;
                        if (inHand && (!ped || !DoesEntityExist(ped))) { dropVisual(id); return; }
                        attach(visual, inHand ? ped : 0); setLit(visual, false);
                        return;
                    }
                    // Keep the transition's final prop placement while awaiting server commit.
                    var state = context.state(id);
                    if (record && record.installed && state && state.stage > 0) lamp(visual, now);
                    else { attach(visual, 0); setLit(visual, false); }
                });
            },
            stop: function () {
                stopped = true;
                pendingTimers.forEach(function (timer) { clearTimeout(timer); });
                pendingTimers.clear();
                if (preparation) cancelPreparation();
                actions.forEach(function (_, id) { stopAction(id); });
                visuals.forEach(function (_, id) { dropVisual(id); });
                records.clear();
                if (modelsRequested) { SetModelAsNoLongerNeeded(model); if (ledModel) SetModelAsNoLongerNeeded(ledModel); }
                if (animation.Dict) RemoveAnimDict(animation.Dict);
                TriggerEvent('chat:removeSuggestion', '/' + command);
            }
        };
    } };
})();
