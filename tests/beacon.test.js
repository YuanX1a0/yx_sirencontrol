// SPDX-License-Identifier: LicenseRef-Proprietary
// Exercises real beacon.js with simulated streamed entities and server packets.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const prefix = 'yx_sirencontrol:beacon:';

function boot(options = {}) {
    const config = { ...JSON.parse(fs.readFileSync(path.join(root, 'beacon-config.json'))), ...options.config };
    const calls = [], server = [], notices = [], errors = [], events = new Map(), commands = new Map();
    const testConsole = Object.create(console);
    testConsole.error = (...args) => errors.push(args.join(' '));
    const states = new Map([[11, { enabled: true, stage: options.stage ?? 0 }]]);
    const props = new Map(), attachments = new Map(), visibility = new Map(), networkedProps = new Set();
    const timers = new Map(), timerHistory = new Map();
    let nextTimer = 1;
    let time = 0, nextProp = 1000, vehicle = 101, driver = 1, dead = false, emergency = false;
    let streamed = true, distance = 0, carHash = 900, loaded = options.loaded ?? true, animLoaded = true, paused = false;
    let animationPlaying = false;
    let attachmentFailures = options.attachmentFailures || 0;
    const record = name => (...args) => calls.push([name, ...args]);
    const on = (name, callback) => events.set(name, callback);
    const hash = name => ({ yx_movia_d_red: 501, yx_movia_d_red_glow: 502, yx_movia_d_red_led: 503,
        yx_portable_beacon: 504, yx_portable_beacon_rotor: 505 }[name] || 900);
    const isVehicle = id => id === 101 || (options.twoVehicles && id === 102);
    function elapse(ms) {
        const end = time + ms;
        for (let count = 0; count < 10000; count++) {
            const pending = [...timers].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!pending) { time = end; return; }
            const [id, timer] = pending; timers.delete(id); time = timer.at; timer.callback();
        }
        throw new Error('Fake timer loop failed to settle');
    }
    const context = vm.createContext({ console: testConsole, Map, Set, JSON, Math, Number, Array, Object, Boolean, String, Infinity,
        GetCurrentResourceName: () => options.resourceName === undefined ? 'yx_sirencontrol' : options.resourceName,
        setTimeout: (callback, delay) => {
            const id = nextTimer++, timer = { callback, at: time + Math.max(0, Number(delay) || 0) };
            timers.set(id, timer); timerHistory.set(id, timer); return id;
        },
        clearTimeout: id => timers.delete(id),
        LoadResourceFile: (...args) => { calls.push(['LoadResourceFile', ...args]); return JSON.stringify(config); }, GetHashKey: hash,
        PlayerPedId: () => 1, PlayerId: () => 0, GetPlayerServerId: () => 1,
        GetPlayerFromServerId: id => id === 1 ? 0 : id === 2 ? 1 : -1,
        GetPlayerPed: id => id === 0 ? 1 : 2,
        GetGameTimer: () => time, GetNetworkTimeAccurate: () => time,
        GetVehiclePedIsIn: () => vehicle, GetPedInVehicleSeat: () => driver,
        DoesEntityExist: id => id === 1 || id === 2 || (isVehicle(id) && streamed) || props.has(id),
        IsEntityAVehicle: isVehicle, IsEntityDead: () => dead,
        GetEntityModel: id => props.get(id) || carHash, GetVehicleClass: () => emergency ? 18 : 1,
        GetGamePool: type => type === 'CObject' ? [...props.keys()] : [],
        NetworkGetEntityIsNetworked: id => networkedProps.has(id),
        GetEntityAttachedTo: id => attachments.get(id)?.[0] || 0,
        IsEntityAttachedToEntity: (id, target) => attachments.get(id)?.[0] === target,
        NetworkDoesNetworkIdExist: id => (id === 11 || (options.twoVehicles && id === 12)) && streamed,
        NetworkGetEntityFromNetworkId: id => streamed ? (options.twoVehicles && id === 12 ? 102 : 101) : 0,
        NetworkGetNetworkIdFromEntity: id => options.twoVehicles && id === 102 ? 12 : 11,
        IsPauseMenuActive: () => paused, IsNuiFocused: () => false,
        GetEntityCoords: id => id === 1 ? [0, 0, 0] : [distance, 0, 0],
        GetModelDimensions: () => [[-1, -2, -0.5], [1, 2, 1]],
        GetEntityBoneIndexByName: () => -1, GetWorldPositionOfEntityBone: () => [0, 0, 0],
        GetOffsetFromEntityInWorldCoords: (_, x, y, z) => [x + distance, y, z],
        GetOffsetFromEntityGivenWorldCoords: (_, x, y, z) => [x - distance, y, z],
        GetPedBoneIndex: (_, bone) => bone,
        GetPedBoneCoords: () => { calls.push(['GetPedBoneCoords']); return [-0.4 + distance, 0.1, 0.4]; },
        RequestModel: record('RequestModel'), HasModelLoaded: () => loaded,
        SetModelAsNoLongerNeeded: record('SetModelAsNoLongerNeeded'),
        RequestAnimDict: record('RequestAnimDict'), HasAnimDictLoaded: () => animLoaded,
        RemoveAnimDict: record('RemoveAnimDict'),
        CreateObjectNoOffset: (model, x, y, z, networked, mission, dynamic) => {
            const id = nextProp++; props.set(id, model); if (networked) networkedProps.add(id);
            calls.push(['CreateObjectNoOffset', model, networked, mission, dynamic]); return id;
        },
        SetEntityAsMissionEntity: record('SetEntityAsMissionEntity'), SetEntityCollision: record('SetEntityCollision'),
        SetEntityInvincible: record('SetEntityInvincible'), SetEntityHasGravity: record('SetEntityHasGravity'),
        SetEntityVisible: (...args) => { calls.push(['SetEntityVisible', ...args]); visibility.set(args[0], args[1]); },
        DeleteEntity: id => { calls.push(['DeleteEntity', id]); props.delete(id); attachments.delete(id); visibility.delete(id); networkedProps.delete(id); },
        DetachEntity: record('DetachEntity'),
        AttachEntityToEntity: (...args) => {
            calls.push(['AttachEntityToEntity', ...args]);
            if (attachmentFailures > 0) { attachmentFailures--; return; }
            if (!options.stickyAttachments || !attachments.has(args[0])) attachments.set(args[0], args.slice(1));
        },
        StartShapeTestRay: () => 1,
        GetShapeTestResult: () => options.rayHit ? [2, true, [-0.48 + distance, 0.3, 0.88], [0, 0, 1], 101] : [2, false, [0, 0, 0], [0, 0, 0], 0],
        TaskPlayAnim: (...args) => {
            calls.push(['TaskPlayAnim', ...args]);
            if (options.animationThrows) throw new Error('simulated native exception');
            animationPlaying = !options.animationBlocked;
        },
        IsEntityPlayingAnim: () => animationPlaying && time >= (options.animationObservedAfter || 0),
        SetEntityAnimCurrentTime: record('SetEntityAnimCurrentTime'), SetEntityAnimSpeed: record('SetEntityAnimSpeed'),
        StopAnimTask: (...args) => { calls.push(['StopAnimTask', ...args]); animationPlaying = false; },
        SetPedCanArmIk: record('SetPedCanArmIk'), RollDownWindow: record('RollDownWindow'),
        SetIkTarget: record('SetIkTarget'),
        DrawSpotLight: record('DrawSpotLight'), DrawLightWithRange: record('DrawLightWithRange'),
        RegisterCommand: (name, callback) => commands.set(name, callback), on, onNet: on,
        TriggerServerEvent: (...args) => server.push(args), TriggerEvent: record('TriggerEvent')
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'beacon.js'), 'utf8'), context);
    const controller = context.YXRoofBeacon.create({ resourceName: options.contextResourceName ?? 'yx_sirencontrol', command: 'siren',
        state: id => states.get(id), synced: () => true, isEmergency: () => emergency,
        mountOffset: options.mountOffset, changed: options.changed, notify: message => notices.push(message) });
    return { calls, server, notices, errors, props, attachments, visibility, states, controller, config, timers, timerHistory, events, commands,
        duration: config.Animation.DurationMs,
        get now() { return time; },
        emit: (name, ...args) => events.get(prefix + name)(...args),
        event: (name, ...args) => events.get(name)(...args),
        command: () => commands.get('putsiren')(),
        frame(ms = 100) { elapse(ms); controller.tick(); },
        elapse,
        advance(ms, step = 20) {
            while (ms > 0) { const elapsed = Math.min(step, ms); this.frame(elapsed); ms -= elapsed; }
        },
        prop(model = 501) { return [...props].find(([, hash]) => hash === model)?.[0]; },
        handProps() { return [...attachments].filter(([, attachment]) => attachment[0] === 1).map(([id]) => id); },
        orphan(model, target = 1, networked = false) {
            const id = nextProp++; props.set(id, model); attachments.set(id, [target, 18905]);
            if (networked) networkedProps.add(id); return id;
        },
        callsOf(name) { return calls.filter(call => call[0] === name); },
        reachRoof() { this.advance(this.duration / 2); },
        change(values) {
            if ('vehicle' in values) vehicle = values.vehicle;
            if ('driver' in values) driver = values.driver;
            if ('dead' in values) dead = values.dead;
            if ('emergency' in values) emergency = values.emergency;
            if ('streamed' in values) streamed = values.streamed;
            if ('distance' in values) distance = values.distance;
            if ('hash' in values) carHash = values.hash;
            if ('loaded' in values) loaded = values.loaded;
            if ('animLoaded' in values) animLoaded = values.animLoaded;
            if ('paused' in values) paused = values.paused;
            if ('animationPlaying' in values) animationPlaying = values.animationPlaying;
        },
        messages(name) { return server.filter(message => message[0] === prefix + name); },
        start(placing = true, token = '1', revision = 0, render = true) {
            this.emit('prepare', 11, 900, token, placing); this.frame(0);
            this.emit('action', 11, 900, token, 1, placing, this.duration, revision); if (render) this.frame(0);
        },
        install() { this.emit('state', 11, 900, true, 1); this.frame(0); }
    };
}

test('renamed beacon factories stay inert even when the caller claims the required resource name', () => {
    for (const resourceName of ['renamed_siren', 'yx_sirencontorl', 'YX_SIRENCONTROL', '']) {
        for (const contextResourceName of [resourceName, 'yx_sirencontrol']) {
            const app = boot({ resourceName, contextResourceName });
            assert.equal(app.errors.length, 1);
            assert.match(app.errors[0], /资源名验证失败/);
            assert.ok(app.errors[0].includes('"' + resourceName + '"'));
            assert.match(app.errors[0], /必须命名为 "yx_sirencontrol"/);
            app.controller.sync(); app.controller.tick(); app.controller.disabled(11); app.controller.stop();
            assert.equal(app.controller.isBusy(101), false);
            app.advance(10000);
            assert.equal(app.commands.size, 0, 'a renamed resource must register no commands');
            assert.equal(app.events.size, 0, 'a renamed resource must register no events');
            assert.equal(app.timerHistory.size, 0, 'a renamed resource must schedule no timers');
            assert.equal(app.calls.length, 0, 'inert methods must not load config, call game natives or emit local events');
            assert.equal(app.server.length, 0); assert.equal(app.props.size, 0);
        }
    }
});

test('valid beacon factories use the native resource identity for config and lifecycle events', () => {
    const app = boot({ contextResourceName: 'another_resource' });
    assert.deepEqual(app.callsOf('LoadResourceFile'), [['LoadResourceFile', 'yx_sirencontrol', 'beacon-config.json']]);
    assert.equal(app.errors.length, 0);
    app.command(); assert.equal(app.messages('request').length, 1);
    app.event('onClientResourceStart', 'another_resource');
    assert.equal(app.callsOf('TriggerEvent').length, 0);
    app.event('onClientResourceStart', 'yx_sirencontrol');
    assert.ok(app.callsOf('TriggerEvent').some(call => call[1] === 'chat:addSuggestion'));
});

test('putsiren rejects disabled controllers, emergency cars, passengers, dead actors and players outside', () => {
    const app = boot(); app.states.clear(); app.command(); assert.match(app.notices.at(-1), /siren on/);
    assert.equal(app.messages('request').length, 0);
    for (const change of [{ emergency: true }, { driver: 2 }, { vehicle: 0 }, { dead: true }, { paused: true }]) {
        const app = boot(); app.change(change); app.command(); assert.equal(app.messages('request').length, 0);
    }
    const valid = boot(); valid.command(); assert.deepEqual(valid.messages('request')[0], [prefix + 'request', 11]);
    valid.command(); assert.equal(valid.messages('request').length, 1);
    assert.equal(valid.props.size, 0, 'a request must not optimistically install a prop');
});

test('models and animation load before ready; timeout and seat changes release the server lock', () => {
    const app = boot({ loaded: false }); app.emit('prepare', 11, 900, '1', true); app.frame(0);
    assert.equal(app.messages('ready').length, 0); assert.equal(app.props.size, 0);
    app.change({ loaded: true, animLoaded: false }); app.frame(); assert.equal(app.messages('ready').length, 0);
    app.change({ animLoaded: true }); app.frame(); app.frame(); assert.equal(app.messages('ready').length, 1);
    assert.equal(app.props.size, 0, 'ready still waits for the server action');
    app.change({ driver: 2 }); app.frame(); assert.equal(app.messages('cancel').length, 1);
    const timeout = boot({ loaded: false }); timeout.emit('prepare', 11, 900, '2', true); timeout.frame(6100);
    assert.equal(timeout.messages('cancel').length, 1); assert.match(timeout.notices.at(-1), /超时/);
});

test('Car Taunt 3 plays naturally for exactly two seconds with transfer at one second', () => {
    const app = boot({ stickyAttachments: true }); app.start(); app.elapse(250); app.frame(0);
    assert.equal(app.props.size, 2);
    assert.equal(app.duration, 2000);
    assert.ok(app.calls.filter(call => call[0] === 'CreateObjectNoOffset').every(call => call[2] === false));
    const base = app.prop();
    assert.equal(app.attachments.get(base)[0], 1); assert.equal(app.attachments.get(base)[1], 18905);
    assert.ok(app.calls.some(call => call[0] === 'RollDownWindow' && call[2] === 0));
    const pose = app.callsOf('TaskPlayAnim')[0];
    assert.deepEqual(pose.slice(2, 4), ['missarmenian1driving_taunts@lamar_1', 'hahahakeepup']);
    assert.deepEqual(pose.slice(4, 9), [5, 5, 2000, 51, 0], 'use the native RPEMOTES Car Taunt 3 playback arguments');
    app.advance(749);
    assert.equal(app.attachments.get(base)[0], 1, 'the prop remains in the left hand before the midpoint');
    assert.equal(app.messages('complete').length, 0);
    app.frame(1); assert.equal(app.now, 1000);
    assert.equal(app.props.has(base), false, 'the old hand model must be deleted, not retargeted');
    const roofBase = app.prop(); assert.notEqual(roofBase, base);
    assert.equal(app.attachments.get(roofBase)[0], 101);
    assert.equal(app.handProps().length, 0);
    assert.equal(app.messages('complete').length, 0, 'midpoint transfer must not finish the two-second operation');
    app.advance(999); assert.equal(app.messages('complete').length, 0);
    assert.equal(app.callsOf('StopAnimTask').length, 0, 'the clip must not stop before two seconds');
    app.frame(1); assert.equal(app.now, 2000);
    assert.deepEqual(app.messages('complete'), [[prefix + 'complete', 11, '1']]);
    assert.equal(app.props.size, 2); assert.equal(app.callsOf('StopAnimTask').length, 1);
    for (const native of ['SetIkTarget', 'SetPedCanArmIk', 'GetPedBoneCoords', 'SetEntityAnimCurrentTime', 'SetEntityAnimSpeed']) {
        assert.equal(app.callsOf(native).length, 0, native + ' must not alter or hold the native animation');
    }
    app.advance(600);
    assert.equal(app.callsOf('TaskPlayAnim').length, 1);
    assert.equal(app.messages('complete').length, 1, 'waiting for server commit must not replay or re-complete');
    app.emit('state', 11, 900, true, 1); app.frame(0);
    assert.equal(app.props.size, 2); assert.equal(app.callsOf('StopAnimTask').length, 1);
    assert.equal(app.callsOf('DrawLightWithRange').length, 0, 'stage OFF must keep the physical beacon dark');
});

test('animation playback failure cancels without transferring or confirming a beacon', () => {
    const app = boot({ animationBlocked: true }); app.start(); app.elapse(649);
    assert.equal(app.handProps().length, 0); assert.equal(app.messages('cancel').length, 0);
    app.elapse(1);
    assert.deepEqual(app.messages('cancel'), [[prefix + 'cancel', 11, '1']]);
    assert.equal(app.messages('complete').length, 0); assert.equal(app.props.size, 0);
    assert.match(app.notices.at(-1), /动作未能播放/);
    assert.equal(app.callsOf('SetEntityAnimCurrentTime').length, 0);
    assert.equal(app.callsOf('StopAnimTask').length, 1);
});

test('a native error while starting animation reports the failure and releases the action', () => {
    const app = boot({ animationThrows: true });
    assert.doesNotThrow(() => app.start());
    assert.deepEqual(app.messages('cancel'), [[prefix + 'cancel', 11, '1']]);
    assert.equal(app.props.size, 0); assert.equal(app.messages('complete').length, 0);
    assert.match(app.notices.at(-1), /异常|无法|失败|取消/);
    assert.ok(app.errors.some(error => error.includes('simulated native exception')));
    app.elapse(3000); app.command();
    assert.equal(app.messages('request').length, 1, 'a startup exception must not leave a permanent busy action');
    assert.equal(app.props.size, 0); assert.equal(app.messages('complete').length, 0);
});

test('the action event starts animation and its timers finish even without rendering frames', () => {
    const app = boot(); app.start(true, 'no-render', 0, false);
    assert.equal(app.callsOf('TaskPlayAnim').length, 1, 'animation cannot depend on the render loop reaching a visual');
    app.elapse(1999); assert.equal(app.messages('complete').length, 0);
    app.elapse(1);
    assert.deepEqual(app.messages('complete'), [[prefix + 'complete', 11, 'no-render']]);
    assert.equal(app.callsOf('StopAnimTask').length, 1); assert.equal(app.handProps().length, 0);
    app.elapse(1000); assert.equal(app.messages('complete').length, 1);
});

test('a hand prop is never bound before native animation playback has been observed', () => {
    const app = boot({ animationObservedAfter: 250 }); app.start();
    assert.equal(app.callsOf('TaskPlayAnim').length, 1); assert.equal(app.handProps().length, 0);
    app.advance(249); assert.equal(app.handProps().length, 0);
    app.elapse(1); app.frame(0);
    assert.equal(app.handProps().length, 2, 'a confirmed animation may display the base and glow layer in hand');
    const oldHand = app.handProps();
    app.elapse(750);
    assert.ok(oldHand.every(id => !app.props.has(id)), 'the one-second timer clears old hand handles even when rendering stops');
    assert.equal(app.handProps().length, 0);
    app.elapse(1000); assert.equal(app.messages('complete').length, 1); assert.equal(app.handProps().length, 0);
});

test('callbacks queued for an old action cannot stop or delete the next action', () => {
    const app = boot(); app.start(true, 'old'); app.elapse(250); app.frame(0);
    const oldCallbacks = [...app.timerHistory.values()].map(timer => timer.callback);
    app.emit('cancelled', 11, 'old');
    app.start(true, 'new'); app.elapse(250); app.frame(0);
    const newHand = app.handProps(), stops = app.callsOf('StopAnimTask').length;
    assert.equal(newHand.length, 2);
    oldCallbacks.forEach(callback => callback());
    assert.ok(newHand.every(id => app.props.has(id)));
    assert.equal(app.callsOf('StopAnimTask').length, stops);
    assert.equal(app.messages('complete').length, 0);
    app.elapse(1750);
    assert.deepEqual(app.messages('complete'), [[prefix + 'complete', 11, 'new']]);
});

test('resource stop clears hand models and makes pending or already-queued timers inert', () => {
    const app = boot(); app.start(); app.elapse(250); app.frame(0);
    assert.equal(app.handProps().length, 2);
    const queuedCallbacks = [...app.timerHistory.values()].map(timer => timer.callback);
    app.controller.stop(); assert.equal(app.props.size, 0);
    const stops = app.callsOf('StopAnimTask').length, creates = app.callsOf('CreateObjectNoOffset').length;
    app.elapse(5000); queuedCallbacks.forEach(callback => callback()); app.frame(0);
    assert.equal(app.props.size, 0); assert.equal(app.messages('complete').length, 0);
    assert.equal(app.callsOf('StopAnimTask').length, stops); assert.equal(app.callsOf('CreateObjectNoOffset').length, creates);
});

test('local orphan cleanup only removes this resource\'s non-networked models bound to the local ped', () => {
    for (const trigger of [app => app.command(), app => app.event('onClientResourceStart', 'yx_sirencontrol')]) {
        const app = boot();
        const own = [501, 502, 503, 504, 505].map(model => app.orphan(model));
        const others = [app.orphan(777), app.orphan(501, 2), app.orphan(501, 101), app.orphan(501, 1, true)];
        trigger(app);
        assert.ok(own.every(id => !app.props.has(id)), 'stale local hand beacons must be cleared');
        assert.ok(others.every(id => app.props.has(id)), 'unrelated, remote, roof and network-owned objects must remain untouched');
    }
    const active = boot(); active.start(); active.elapse(250); active.frame(0);
    const hand = active.handProps(); assert.equal(hand.length, 2);
    active.command();
    assert.ok(hand.every(id => active.props.has(id)), 'a repeated busy command must not treat the active hand models as orphans');
    assert.equal(active.messages('request').length, 0); assert.match(active.notices.at(-1), /正在操作/);
});

test('a native animation ending naturally at two seconds still completes placement and removal', () => {
    for (const placing of [true, false]) {
        const app = boot();
        if (!placing) app.install();
        app.start(placing, 'natural', placing ? 0 : 1);
        app.advance(1999); assert.equal(app.messages('complete').length, 0);
        app.change({ animationPlaying: false }); app.frame(1);
        assert.equal(app.now, 2000);
        assert.deepEqual(app.messages('complete'), [[prefix + 'complete', 11, 'natural']]);
        assert.equal(app.messages('cancel').length, 0, 'a previously observed clip ending naturally is not a start failure');
        assert.equal(app.props.size, placing ? 2 : 0);
        app.advance(300);
        assert.equal(app.messages('complete').length, 1); assert.equal(app.callsOf('TaskPlayAnim').length, 1);
    }
});

test('removal reaches roof then takes the beacon into left hand and deletes it once', () => {
    const app = boot({ stickyAttachments: true }); app.install(); app.start(false, '2', 1);
    const base = app.prop();
    assert.equal(app.attachments.get(base)[0], 101);
    app.advance(999); assert.equal(app.attachments.get(base)[0], 101);
    app.frame(1); assert.equal(app.now, 1000); assert.equal(app.props.has(base), false);
    const handBase = app.prop(); assert.notEqual(handBase, base); assert.equal(app.attachments.get(handBase)[0], 1);
    assert.equal(app.messages('complete').length, 0);
    app.advance(999); assert.equal(app.props.size, 2); assert.equal(app.messages('complete').length, 0);
    app.elapse(1); assert.equal(app.now, 2000); assert.equal(app.props.size, 0);
    assert.deepEqual(app.messages('complete'), [[prefix + 'complete', 11, '2']]);
    const created = app.callsOf('CreateObjectNoOffset').length, deleted = app.callsOf('DeleteEntity').length;
    app.advance(1000);
    assert.equal(app.callsOf('CreateObjectNoOffset').length, created);
    assert.equal(app.callsOf('DeleteEntity').length, deleted);
    assert.equal(app.messages('complete').length, 1);
    app.emit('state', 11, 900, false, 2); app.frame(); assert.equal(app.props.size, 0);
    assert.equal(app.callsOf('CreateObjectNoOffset').length, created);
    assert.equal(app.callsOf('DeleteEntity').length, deleted);
});

test('red LEDs flash four times per cycle without rotating the fixed model', () => {
    const app = boot(); app.install(); const base = app.prop(), led = app.prop(502);
    assert.equal(app.config.LedModel, 'yx_movia_d_red_glow');
    assert.equal(app.visibility.get(led), false); assert.equal(app.callsOf('DrawLightWithRange').length, 0);
    const baseTransform = [...app.attachments.get(base)], ledTransform = [...app.attachments.get(led)];
    const attached = app.callsOf('AttachEntityToEntity').length;
    app.states.get(11).stage = 1;
    const phases = [[0, true], [89, true], [90, false], [160, true], [249, true], [250, false],
        [320, true], [409, true], [410, false], [480, true], [569, true], [570, false], [799, false], [800, true]];
    for (const [time, lit] of phases) {
        const lights = app.callsOf('DrawLightWithRange').length;
        app.frame(time - app.now); assert.equal(app.visibility.get(led), lit, 'unexpected LED state at phase ' + time);
        assert.equal(app.callsOf('DrawLightWithRange').length, lights + (lit ? 1 : 0));
    }
    assert.ok(app.callsOf('DrawLightWithRange').every(call => call[4] === 255 && call[5] === 12 && call[6] === 12));
    assert.ok(app.callsOf('DrawLightWithRange').every(call => call[7] === 12 && call[8] === 3));
    assert.equal(app.callsOf('DrawSpotLight').length, 0);
    assert.deepEqual(app.attachments.get(base), baseTransform); assert.deepEqual(app.attachments.get(led), ledTransform);
    assert.equal(app.callsOf('AttachEntityToEntity').length, attached, 'LED flashing must not repeatedly reattach or rotate the models');
    app.states.get(11).stage = 0; app.frame(0); assert.equal(app.visibility.get(led), false);
    assert.equal(app.props.size, 2, 'lights-off keeps the installed housing visible');
});

test('silent native attachment failures retry and a missing glow layer recreates the complete beacon', () => {
    const app = boot({ attachmentFailures: 2 }); app.install();
    assert.equal(app.props.size, 2); assert.equal(app.attachments.size, 0, 'the first two native attaches were silently rejected');
    app.frame();
    assert.equal(app.attachments.get(app.prop())[0], 101);
    assert.equal(app.attachments.get(app.prop(502))[0], 101);
    assert.equal(app.callsOf('AttachEntityToEntity').length, 4, 'both attachments must retry after the actual native state is checked');
    const oldBase = app.prop(), oldGlow = app.prop(502);
    app.props.delete(oldGlow); app.attachments.delete(oldGlow); app.visibility.delete(oldGlow);
    app.frame();
    assert.equal(app.props.size, 2); assert.equal(app.props.has(oldBase), false);
    assert.notEqual(app.prop(), oldBase); assert.notEqual(app.prop(502), oldGlow);
    assert.equal(app.attachments.get(app.prop())[0], 101); assert.equal(app.attachments.get(app.prop(502))[0], 101);
});

test('interruption cancels placement and reverts a cancelled removal to the existing installed beacon', () => {
    for (const change of [{ vehicle: 0 }, { driver: 2 }, { dead: true }, { streamed: false }, { hash: 901 }, { paused: true }]) {
        const app = boot(); app.start(); app.change(change); app.frame();
        assert.equal(app.messages('cancel').length, 1); assert.equal(app.props.size, 0);
    }
    const app = boot(); app.install(); app.start(false, '2', 1); app.reachRoof();
    app.emit('cancelled', 11, '2'); app.frame(); assert.equal(app.props.size, 2);
    assert.ok([...app.attachments.values()].every(attachment => attachment[0] === 101));
    app.controller.disabled(11); app.frame(); assert.equal(app.props.size, 0);
});

test('installed props recreate on stream-in without duplicates and do not follow a reused network model', () => {
    const app = boot({ stage: 1 }); app.install(); app.frame(); app.frame(); assert.equal(app.props.size, 2);
    app.change({ streamed: false }); app.frame(); assert.equal(app.props.size, 0);
    app.change({ streamed: true }); app.frame(); assert.equal(app.props.size, 2);
    app.change({ hash: 901 }); app.frame(); assert.equal(app.props.size, 0);
    app.change({ hash: 900, distance: 500 }); app.frame(); assert.equal(app.props.size, 0);
    app.change({ distance: 0 }); app.frame(); assert.equal(app.props.size, 2);
    app.controller.stop(); assert.equal(app.props.size, 0);
    assert.equal(app.calls.filter(call => call[0] === 'SetModelAsNoLongerNeeded').length, 2);
    app.frame(); assert.equal(app.props.size, 0);
});

test('snapshots remove ghosts, reject stale revisions and do not cancel an action with old installed state', () => {
    const app = boot(); app.install(); app.start(false, '2', 1); app.reachRoof();
    app.emit('state', 11, 900, true, 1);
    app.emit('snapshot', JSON.stringify({ revision: 1, beacons: [{ networkId: 11, modelHash: 900, installed: true, revision: 1 }] }));
    app.frame(0);
    assert.ok([...app.attachments.values()].every(attachment => attachment[0] === 1), 'snapshot must not move an in-progress removal back to the roof');
    app.emit('state', 11, 900, false, 2); app.emit('state', 11, 900, true, 1); app.frame(); assert.equal(app.props.size, 0);
    app.emit('state', 11, 900, true, 3); app.frame(); assert.equal(app.props.size, 2);
    app.emit('snapshot', JSON.stringify({ revision: 2, beacons: [] })); app.frame(); assert.equal(app.props.size, 2);
    app.emit('snapshot', JSON.stringify({ revision: 3, beacons: [] })); app.frame(); assert.equal(app.props.size, 0);
});

test('roof raycast refines placement and explicit model offsets take precedence', () => {
    const app = boot({ rayHit: true }); app.install();
    const base = [...app.props].find(([, model]) => model === 501)[0];
    assert.ok(Math.abs(app.attachments.get(base)[4] - 0.886) < 0.0001);
    const custom = boot({ rayHit: true, config: { MountOffsets: { customcar: [-0.3, 0.2, 1.1] } } }); custom.install();
    const customBase = [...custom.props].find(([, model]) => model === 501)[0];
    assert.deepEqual(custom.attachments.get(customBase).slice(2, 5), [-0.3, 0.2, 1.1]);
});

test('saved roof adjustments update the existing housing, glow and light together without per-frame reattachment', () => {
    let offset = { x: 0.1, y: -0.2, z: 0.3 };
    const app = boot({ stage: 1, mountOffset: vehicle => { assert.equal(vehicle, 101); return offset; } });
    app.install();
    const base = app.prop(), glow = app.prop(502);
    const rounded = values => values.map(value => Number(value.toFixed(6)));
    const check = expected => {
        for (const prop of [base, glow]) assert.deepEqual(rounded(app.attachments.get(prop).slice(2, 5)), expected);
        assert.deepEqual(rounded(app.callsOf('DrawLightWithRange').at(-1).slice(1, 4)),
            rounded([expected[0], expected[1], expected[2] + app.config.LightHeight]));
    };
    check([-0.5, 0.1, 1.306]);
    const creates = app.callsOf('CreateObjectNoOffset').length, deletes = app.callsOf('DeleteEntity').length;
    const attached = app.callsOf('AttachEntityToEntity').length;
    offset = { x: -0.2, y: 0.4, z: -0.1 }; app.frame(0);
    check([-0.8, 0.7, 0.906]);
    assert.equal(app.callsOf('AttachEntityToEntity').length, attached + 2, 'one offset change reattaches each layer once');
    for (let i = 0; i < 20; i++) app.frame(0);
    check([-0.8, 0.7, 0.906]);
    assert.equal(app.callsOf('AttachEntityToEntity').length, attached + 2, 'unchanged offsets must not cause repeated attachment work');
    assert.equal(app.callsOf('CreateObjectNoOffset').length, creates);
    assert.equal(app.callsOf('DeleteEntity').length, deletes);
    assert.equal(app.prop(), base); assert.equal(app.prop(502), glow);
});

test('a saved delta adds to raycast or developer mount position without drifting and reset restores the base', () => {
    const rounded = values => values.map(value => Number(value.toFixed(6)));
    for (const [config, base] of [[{}, [-0.48, 0.3, 0.886]],
        [{ MountOffsets: { customcar: [-0.3, 0.2, 1.1] } }, [-0.3, 0.2, 1.1]]]) {
        let offset = { x: 0.2, y: -0.1, z: 0.4 };
        const app = boot({ rayHit: true, config, mountOffset: () => offset }); app.install();
        const prop = app.prop();
        const expected = rounded([base[0] + 0.2, base[1] - 0.1, base[2] + 0.4]);
        for (let i = 0; i < 30; i++) {
            app.frame(10);
            assert.deepEqual(rounded(app.attachments.get(prop).slice(2, 5)), expected);
        }
        offset = { x: 0, y: 0, z: 0 }; app.frame(0);
        assert.deepEqual(rounded(app.attachments.get(prop).slice(2, 5)), base);
        offset = null; app.frame(0);
        assert.deepEqual(rounded(app.attachments.get(prop).slice(2, 5)), base, 'no saved value is the zero-delta default');
        assert.equal(app.prop(), prop);
    }
    const legacy = boot(); legacy.install();
    assert.deepEqual(rounded(legacy.attachments.get(legacy.prop()).slice(2, 5)), [-0.6, 0.3, 1.006],
        'callers that omit mountOffset keep the existing automatic mounting behavior');
});

test('roof adjustment changes during an action do not move the hand grip and apply at roof transfer', () => {
    let offset = { x: 0.7, y: -0.4, z: 0.2 };
    const app = boot({ mountOffset: () => offset }); app.start();
    const hand = app.handProps(); assert.equal(hand.length, 2);
    for (const prop of hand) assert.deepEqual(app.attachments.get(prop).slice(2, 5), app.config.HandOffset);
    const attached = app.callsOf('AttachEntityToEntity').length;
    offset = { x: 0.5, y: 0.2, z: -0.3 }; app.frame(100);
    for (const prop of hand) assert.deepEqual(app.attachments.get(prop).slice(2, 5), app.config.HandOffset);
    assert.equal(app.callsOf('AttachEntityToEntity').length, attached, 'a roof edit must not rebind the hand pose');
    app.advance(900);
    assert.ok(hand.every(prop => !app.props.has(prop)));
    for (const prop of [app.prop(), app.prop(502)]) {
        assert.deepEqual(app.attachments.get(prop).slice(2, 5).map(value => Number(value.toFixed(6))), [-0.1, 0.5, 0.706]);
    }
});

test('each streamed vehicle receives its own saved delta, including after returning to a vehicle', () => {
    const offsets = new Map([[101, { x: 0.1, y: 0, z: 0.2 }], [102, { x: -0.2, y: 0.3, z: -0.1 }]]);
    const readVehicles = new Set();
    const app = boot({ twoVehicles: true, mountOffset: vehicle => { readVehicles.add(vehicle); return offsets.get(vehicle); } });
    app.install(); app.states.set(12, { enabled: true, stage: 0 }); app.emit('state', 12, 900, true, 2); app.frame(0);
    const verify = () => {
        for (const [vehicle, expected] of [[101, [-0.5, 0.3, 1.206]], [102, [-0.8, 0.6, 0.906]]]) {
            const pairs = [...app.attachments].filter(([, attachment]) => attachment[0] === vehicle);
            assert.equal(pairs.length, 2);
            for (const [, attachment] of pairs) assert.deepEqual(attachment.slice(2, 5).map(value => Number(value.toFixed(6))), expected);
        }
    };
    verify(); assert.deepEqual([...readVehicles].sort(), [101, 102]);
    app.change({ vehicle: 102 }); app.frame(0); verify();
    app.change({ streamed: false }); app.frame(0); assert.equal(app.props.size, 0);
    app.change({ streamed: true, vehicle: 101 }); app.frame(0); verify();
});

test('isBusy only gates the matching vehicle during preparation, action and pending server confirmation', () => {
    const app = boot({ twoVehicles: true, loaded: false });
    assert.equal(app.controller.isBusy(101), false);
    app.emit('prepare', 11, 900, 'busy', true);
    assert.equal(app.controller.isBusy(101), true);
    for (const vehicle of [0, 1, 102, 999]) assert.equal(app.controller.isBusy(vehicle), false);
    app.change({ loaded: true }); app.frame(0);
    app.emit('action', 11, 900, 'busy', 1, true, 2000, 0); app.frame(0);
    assert.equal(app.controller.isBusy(101), true);
    app.advance(2000); assert.equal(app.controller.isBusy(101), true, 'server confirmation is still pending');
    app.emit('state', 11, 900, true, 1); assert.equal(app.controller.isBusy(101), false);
    app.emit('prepare', 11, 900, 'cancelled', false);
    app.emit('cancelled', 11, 'cancelled'); assert.equal(app.controller.isBusy(101), false);
    app.emit('prepare', 11, 900, 'stopped', false); app.controller.stop();
    assert.equal(app.controller.isBusy(101), false);
});

test('busy changes refresh an open menu on transitions without per-frame or resource-stop callbacks', () => {
    const busy = [];
    let app;
    app = boot({ changed: () => busy.push(app.controller.isBusy(101)) });
    app.emit('prepare', 11, 900, 'busy', true); app.frame(0);
    assert.deepEqual(busy, [true]);
    app.emit('action', 11, 900, 'busy', 1, true, 2000, 0);
    app.advance(2000);
    assert.deepEqual(busy, [true], 'preparation-to-action and finished-awaiting-confirmation stay busy');
    app.emit('state', 11, 900, true, 1);
    assert.deepEqual(busy, [true, false]);
    app.emit('prepare', 11, 900, 'cancel', false); app.emit('cancelled', 11, 'cancel');
    assert.deepEqual(busy, [true, false, true, false]);
    app.emit('prepare', 11, 900, 'seat', false); app.change({ driver: 2 }); app.frame(0);
    assert.deepEqual(busy, [true, false, true, false, true, false], 'local preparation cancellation unlocks the rows');
    app.change({ driver: 1 }); app.emit('prepare', 11, 900, 'stop', false);
    const beforeStop = busy.length; app.controller.stop();
    assert.equal(busy.length, beforeStop, 'resource shutdown must not reopen or refresh a menu');
});

test('an optional menu refresh failure does not break beacon preparation or cancellation', () => {
    const app = boot({ changed: () => { throw new Error('simulated menu refresh failure'); } });
    assert.doesNotThrow(() => app.emit('prepare', 11, 900, 'safe', true));
    assert.equal(app.controller.isBusy(101), true);
    app.frame(0); assert.equal(app.messages('ready').length, 1);
    assert.doesNotThrow(() => app.emit('cancelled', 11, 'safe'));
    assert.equal(app.controller.isBusy(101), false);
    assert.ok(app.errors.some(error => error.includes('simulated menu refresh failure')));
});

test('late-join snapshots create installed props and malformed packets do not allocate entities', () => {
    const app = boot(); app.emit('state', '11', 900, true, 1); app.emit('action', 11, 900, {}, 1, true, app.duration, 0);
    app.emit('snapshot', '{invalid'); app.frame(); assert.equal(app.props.size, 0);
    app.emit('snapshot', JSON.stringify({ revision: 10, beacons: [{ networkId: 11, modelHash: 900, installed: true, revision: 10 }] }));
    app.frame(); assert.equal(app.props.size, 2);
});

test('duplicate and late action packets cannot restart a completed placement', () => {
    const app = boot(); app.start(); app.reachRoof();
    app.emit('action', 11, 900, '1', 1, true, app.duration, 0); app.frame(0);
    assert.equal(app.calls.filter(call => call[0] === 'TaskPlayAnim').length, 1);
    assert.ok([...app.attachments.values()].every(attachment => attachment[0] === 101));
    app.advance(app.duration / 2); assert.equal(app.messages('complete').length, 1);
    app.emit('state', 11, 900, true, 1);
    app.emit('action', 11, 900, '1', 1, true, app.duration, 0); app.frame(0);
    assert.equal(app.calls.filter(call => call[0] === 'TaskPlayAnim').length, 1);
    assert.equal(app.messages('complete').length, 1);
});
