// SPDX-License-Identifier: LicenseRef-Proprietary
// Run: node --test tests/client.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const packPaths = Array.from(fs.readFileSync(path.join(root, 'fxmanifest.lua'), 'utf8')
    .matchAll(/^siren_pack\s+'([^']+)'/gm), match => match[1]);
const packData = packPaths.map(file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')));

function boot(options = {}) {
    const calls = [], server = [], events = new Map(), commands = new Map(), keyMappings = [], kvp = options.kvp || new Map();
    const logs = { error: [], warn: [], log: [] };
    const testConsole = Object.create(console);
    for (const level of Object.keys(logs)) testConsole[level] = (...args) => logs[level].push(args);
    const resourceName = options.resourceName === undefined ? 'yx_sirencontrol' : options.resourceName;
    const resourceStates = options.resourceStates ?? { yx_siren_audio_lvc: 'started', yx_siren_audio_modern: 'started' };
    const cars = new Map([
        [10, { model: 100, plate: ' LAPD01 ', classId: 18, net: 110, coords: [0, 0, 0] }],
        [20, { model: 100, plate: 'LAPD02', classId: 18, net: 120, coords: [5, 0, 0] }],
        [30, { model: 300, plate: 'CIV01', classId: 1, net: 130, coords: [10, 0, 0] }]
    ]);
    let timer = 0, vehicle = options.vehicle === undefined ? 10 : options.vehicle, pedDead = false, paused = false;
    let seat = options.seat ?? -1;
    const occupants = new Map(Object.entries(options.seats || {}).map(([index, ped]) => [vehicle + ':' + index, ped]));
    const deadPeds = new Set(), draws = [];
    let drawingText = null, textColor = [], textCentre = false, textRight = false, textScale = 0;
    let tick, sound = 0, bankAvailable = true, beaconContext;
    const held = new Set(), pressed = new Set(), nativeSirens = new Map();
    function record(name) { return (...args) => { calls.push([name, ...args]); }; }
    function emit(name, ...args) { for (const fn of events.get(name) || []) fn(...args); }
    function register(name, fn) { events.set(name, [...events.get(name) || [], fn]); }
    const context = vm.createContext({ console: testConsole, Map, Set, JSON, Math, Number, Array, Object, Boolean, String, Infinity,
        GetCurrentResourceName: () => resourceName,
        GetResourceState: name => { record('GetResourceState')(name); return resourceStates[name] || 'missing'; },
        GetNumResourceMetadata: () => packPaths.length, GetResourceMetadata: (_resource, _key, i) => packPaths[i],
        LoadResourceFile: (_resource, file) => options.packOverrides?.[file] !== undefined
            ? JSON.stringify(options.packOverrides[file]) : fs.readFileSync(path.join(root, file), 'utf8'),
        PlayerPedId: () => 1, GetGameTimer: () => timer, GetNetworkTimeAccurate: () => options.networkTime ?? timer,
        GetCurrentServerEndpoint: () => options.endpoint || '127.0.0.1:30120',
        Entity: car => ({ state: options.vehicleStates?.[car] || {} }),
        GetVehiclePedIsIn: () => vehicle,
        GetPedInVehicleSeat: (car, index) => car === vehicle && index === seat ? 1 : occupants.get(car + ':' + index) || 0,
        DoesEntityExist: entity => entity === 1 || entity === 2 || entity === 3 || cars.has(entity),
        GetGamePool: () => [],
        IsEntityDead: entity => entity === 1 ? pedDead : deadPeds.has(entity),
        IsEntityAVehicle: entity => cars.has(entity), GetEntityModel: car => cars.get(car).model,
        GetVehicleClass: car => cars.get(car).classId, GetVehicleNumberPlateText: car => cars.get(car).plate,
        GetDisplayNameFromVehicleModel: model => 'MODEL_' + model, GetHashKey: value => Number(value),
        GetResourceKvpString: key => kvp.get(key) || null,
        SetResourceKvp: (key, value) => { if (options.kvpError) throw new Error('KVP write unavailable'); kvp.set(key, value); },
        GetExternalKvpString: options.noExternalKvp ? undefined : (resource, key) => {
            record('GetExternalKvpString')(resource, key);
            if (options.externalKvpError) throw new Error('External KVP unavailable');
            return options.externalKvp?.get(resource + ':' + key) ?? null;
        },
        NetworkGetEntityIsNetworked: () => true, NetworkRegisterEntityAsNetworked: record('NetworkRegisterEntityAsNetworked'),
        NetworkGetNetworkIdFromEntity: car => cars.get(car).net,
        NetworkDoesNetworkIdExist: id => [...cars.values()].some(car => car.net === id),
        NetworkGetEntityFromNetworkId: id => [...cars].find(([, car]) => car.net === id)?.[0] || 0,
        GetEntityCoords: entity => entity === 1 ? [0, 0, 0] : cars.get(entity).coords,
        GetModelDimensions: () => [[-1, -2, -0.5], [1, 2, 1]],
        GetOffsetFromEntityInWorldCoords: (_car, x, y, z) => [x, y, z],
        GetVehicleLightsState: () => options.lights || [true, false, false],
        IsVehicleSirenOn: car => options.numericNativeBools ? Number(nativeSirens.get(car) || false) : nativeSirens.get(car) || false,
        SetVehicleSiren: (car, active) => { nativeSirens.set(car, active); record('SetVehicleSiren')(car, active); },
        SetVehicleHasMutedSirens: record('SetVehicleHasMutedSirens'),
        SetVehicleLights: record('SetVehicleLights'), SetVehicleFullbeam: record('SetVehicleFullbeam'),
        DrawLightWithRange: record('DrawLightWithRange'),
        GetSoundId: () => ++sound, PlaySoundFromEntity: record('PlaySoundFromEntity'),
        StopSound: record('StopSound'), ReleaseSoundId: record('ReleaseSoundId'), HasSoundFinished: () => false,
        RequestScriptAudioBank: (...args) => { record('RequestScriptAudioBank')(...args); return bankAvailable; },
        ReleaseNamedScriptAudioBank: record('ReleaseNamedScriptAudioBank'),
        RemoveAnimDict: record('RemoveAnimDict'),
        IsPauseMenuActive: () => paused, IsNuiFocused: () => false,
        DisableControlAction: record('DisableControlAction'),
        IsControlPressed: (_group, control) => held.has(control), IsDisabledControlPressed: () => false,
        IsControlJustPressed: (_group, control) => pressed.has(control), IsDisabledControlJustPressed: () => false,
        RegisterCommand: (name, fn) => commands.set(name, fn),
        RegisterKeyMapping: (command, description, mapper, parameter) => keyMappings.push({ command, description, mapper, parameter }),
        on: register, onNet: register,
        TriggerServerEvent: (...args) => server.push(args), TriggerEvent: (name, ...args) => { record(name)(...args); emit(name, ...args); },
        setTick: fn => { tick = fn; }, setTimeout: fn => fn()
    });
    for (const name of ['BeginTextCommandThefeedPost', 'AddTextComponentSubstringPlayerName', 'EndTextCommandThefeedPostTicker',
        'SetTextFont', 'SetTextScale', 'SetTextProportional', 'SetTextColour', 'SetTextRightJustify', 'SetTextCentre', 'SetTextWrap',
        'SetTextDropshadow', 'SetTextEdge', 'SetTextOutline', 'BeginTextCommandDisplayText', 'EndTextCommandDisplayText']) {
        context[name] = record(name);
    }
    context.SetTextColour = (...rgba) => { textColor = rgba; record('SetTextColour')(...rgba); };
    context.SetTextScale = (x, scale) => { textScale = scale; record('SetTextScale')(x, scale); };
    context.SetTextCentre = value => { textCentre = value; record('SetTextCentre')(value); };
    context.SetTextRightJustify = value => { textRight = value; record('SetTextRightJustify')(value); };
    context.BeginTextCommandDisplayText = command => { drawingText = ''; record('BeginTextCommandDisplayText')(command); };
    context.AddTextComponentSubstringPlayerName = text => {
        if (drawingText !== null) drawingText += text;
        record('AddTextComponentSubstringPlayerName')(text);
    };
    context.EndTextCommandDisplayText = (x, y) => {
        draws.push({ text: drawingText, x, y, color: [...textColor], centre: textCentre, right: textRight, scale: textScale, timer });
        drawingText = null; record('EndTextCommandDisplayText')(x, y);
    };
    for (const file of ['config.js', 'settings.js', 'beacon.js', 'client.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
        if (file === 'beacon.js') {
            const create = context.YXRoofBeacon.create;
            context.YXRoofBeacon.create = options => { beaconContext = options; return create(options); };
        }
    }
    return { calls, server, kvp, cars, nativeSirens, context, emit, draws, commands, keyMappings, events, logs,
        get controllerMessages() { return server.filter(message => !message[0].startsWith('yx_sirencontrol:beacon:')); },
        get beaconContext() { return beaconContext; },
        hasTick() { return typeof tick === 'function'; },
        command(name, args = []) { commands.get(name)(0, args); },
        frame(ms = 200) { timer += ms; tick(); pressed.clear(); },
        ready() { emit('yx_sirencontrol:client:syncComplete'); this.frame(); },
        drive(car, nextSeat = seat) { vehicle = car; seat = nextSeat; }, seat(value) { seat = value; },
        occupy(car, index, ped) { occupants.set(car + ':' + index, ped); },
        die() { pedDead = true; }, killPed(ped) { deadPeds.add(ped); }, pause(value) { paused = value; },
        press(...controls) { controls.forEach(control => pressed.add(control)); },
        hold(...controls) { held.clear(); controls.forEach(control => held.add(control)); },
        banksAvailable(value) { bankAvailable = value; },
        open() {
            const count = calls.length; this.command('sirencontrol');
            const opened = calls.slice(count).some(call => call[0] === 'yx_sirencontrol:menu:open');
            if (opened) emit('yx_sirencontrol:menu:visibility', true);
            return opened;
        },
        key(value) {
            const mapping = keyMappings.find(entry => entry.mapper.toLowerCase() === 'keyboard'
                && entry.parameter.toLowerCase() === String(value).toLowerCase());
            if (!mapping) return false;
            const count = calls.length; this.command(mapping.command);
            const opened = calls.slice(count).some(call => call[0] === 'yx_sirencontrol:menu:open');
            if (opened) emit('yx_sirencontrol:menu:visibility', true);
            return opened;
        },
        action(...args) { emit('yx_sirencontrol:menu:action', ...args); },
        view() { return JSON.parse(calls.filter(call => /^yx_sirencontrol:menu:(open|update)$/.test(call[0])).at(-1)[1]); },
        hud() { return draws.filter(draw => draw.timer === timer); },
        synchronized(id, enabled, stage, slot, horn, pack = 'builtin', tone = 'wail', kill = true, muted = false,
            manualPack = pack, manualTone = '@horn') {
            emit('yx_sirencontrol:client:setState', id, enabled, stage, slot, horn, pack, tone, kill, muted, manualPack, manualTone);
        }
    };
}

test('client only starts when the resource keeps its required name', () => {
    const normal = boot();
    assert.equal(normal.hasTick(), true);
    assert.ok(normal.commands.size > 0);
    assert.ok(normal.events.size > 0);

    for (const actualName of ['renamed_siren_resource', 'YX_SIRENCONTROL', 'yx_sirencontrol-main', 'yx_sirencontorl', '', null]) {
        const renamed = boot({ resourceName: actualName });
        assert.equal(renamed.hasTick(), false, 'a renamed resource must not start its frame loop');
        assert.equal(renamed.commands.size, 0, 'a renamed resource must not register commands');
        assert.equal(renamed.events.size, 0, 'a renamed resource must not register local or network events');
        const errorText = renamed.logs.error.flat().map(String).join(' ');
        assert.match(errorText, /资源名验证失败/);
        assert.match(errorText, /yx_sirencontrol/);
        assert.ok(errorText.includes(String(actualName || '')));
    }
});

test('all registered packs validate; every key binding references a real tone', () => {
    const app = boot();
    for (const pack of packData) app.context.YXSirenSettings.validatePack(pack);
    const invalid = structuredClone(packData[0]);
    delete invalid.Id;
    assert.throws(() => app.context.YXSirenSettings.validatePack(invalid));
});

test('without optional audio providers the menu and old vehicle profiles fall back to builtin sounds', () => {
    const fixture = legacyProfileFixture();
    const app = boot({ resourceStates: {}, externalKvp: fixture.externalKvp }); app.ready(); app.open();
    assert.deepEqual(app.view().packs.map(pack => pack.id), ['builtin']);
    assert.equal(app.view().packId, 'builtin');
    assert.equal(app.view().slot, 4); assert.equal(app.view().parkKill, false);
    assert.equal(app.view().bindings[3], packData.find(pack => pack.Id === 'builtin').DefaultSlots[3]);
    assert.equal(JSON.parse(app.kvp.get(fixture.newKey)).packId, 'builtin');
    app.action('pack', 'ss2000'); assert.equal(app.view().packId, 'builtin');
    app.action('slot', 1); app.action('stage', 2); app.frame();
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity' && call[2] === 'VEHICLES_HORNS_SIREN_1'));
    assert.equal(app.calls.some(call => call[0] === 'RequestScriptAudioBank'), false);
});

test('optional packs require their exact provider to be fully started before the controller', () => {
    const both = boot(); both.ready(); both.open();
    assert.deepEqual(both.view().packs.map(pack => pack.id).sort(), packData.map(pack => pack.Id).sort());
    for (const state of ['missing', 'uninitialized', 'starting', 'stopped', 'stopping', 'unknown', 'STARTED']) {
        const app = boot({ resourceStates: { yx_siren_audio_lvc: 'started', yx_siren_audio_modern: state } });
        app.ready(); app.open();
        assert.deepEqual(app.view().packs.map(pack => pack.id).sort(), ['builtin', 'fire_q', 'ss2000'], state);
    }
    const modern = boot({ resourceStates: { yx_siren_audio_modern: 'started' } }); modern.ready(); modern.open();
    assert.deepEqual(modern.view().packs.map(pack => pack.id).sort(), ['builtin', 'modern_lafd', 'modern_police']);
});

test('invalid optional resource names cannot register packs or reach resource native calls', () => {
    const file = packPaths.find(file => file.endsWith('/ss2000.json'));
    const original = packData.find(pack => pack.Id === 'ss2000');
    for (const required of ['', 'provider/path', '../provider', 'provider name', 'provider\n', '_provider', 'a'.repeat(65), 123, true, [], {}]) {
        const app = boot({ packOverrides: { [file]: { ...original, RequiredResource: required } } });
        app.ready(); app.open();
        assert.equal(app.view().packs.some(pack => pack.id === 'ss2000'), false, JSON.stringify(required));
        assert.ok(app.logs.error.flat().some(line => /RequiredResource/.test(line)), JSON.stringify(required));
        assert.equal(app.calls.some(call => call[0] === 'GetResourceState' && call[1] === required), false);
    }
    for (const required of ['Provider-1_name', 'a'.repeat(64)]) {
        const app = boot({ resourceStates: { [required]: 'started' },
            packOverrides: { [file]: { ...original, RequiredResource: required } } });
        app.ready(); app.open();
        assert.equal(app.view().packs.some(pack => pack.id === 'ss2000'), true);
    }
    const unconditionallyAvailable = boot({ resourceStates: {},
        packOverrides: { [file]: { ...original, RequiredResource: null } } });
    unconditionallyAvailable.ready(); unconditionallyAvailable.open();
    assert.deepEqual(unconditionallyAvailable.view().packs.map(pack => pack.id).sort(), ['builtin', 'ss2000']);
});

test('every registered pack and tone has a Chinese display label', () => {
    const chinese = /[\u3400-\u9fff]/;
    for (const pack of packData) {
        assert.match(pack.Label, chinese, pack.Id + ' pack label');
        assert.match(pack.ManualHorn.Label, chinese, pack.Id + ' manual-horn label');
        for (const tone of pack.Tones) assert.match(tone.Label, chinese, pack.Id + '/' + tone.Id + ' tone label');
    }
});

function legacyProfileFixture() {
    const seed = boot(); seed.ready(); seed.open();
    seed.action('pack', 'ss2000'); seed.action('parkKill', false);
    seed.action('binding', 'rumbler_yelp', 4); seed.action('slot', 4);
    const [newKey, value] = [...seed.kvp][0];
    const resource = 'yx_sirencontorl';
    const oldKey = newKey.replace('yx_sirencontrol:v3:', resource + ':v3:');
    return { newKey, oldKey, value, externalKvp: new Map([[resource + ':' + oldKey, value]]) };
}

test('renamed resource migrates a valid old vehicle profile and leaves the original untouched', () => {
    const fixture = legacyProfileFixture();
    const app = boot({ externalKvp: fixture.externalKvp }); app.ready(); app.open();
    assert.equal(app.view().packId, 'ss2000'); assert.equal(app.view().slot, 4);
    assert.equal(app.view().parkKill, false); assert.equal(app.view().bindings[3], 'rumbler_yelp');
    assert.equal(app.kvp.get(fixture.newKey), fixture.value);
    assert.equal([...fixture.externalKvp.values()][0], fixture.value, 'migration must not remove the old data');
    app.drive(20); app.frame(); app.open();
    assert.equal(app.view().packId, 'builtin', 'migration still isolates individual vehicles');
});

test('new saved settings and explicit resets take precedence over legacy settings', () => {
    const fixture = legacyProfileFixture();
    const app = boot({ externalKvp: fixture.externalKvp }); app.ready(); app.open(); app.action('reset');
    const restarted = boot({ kvp: app.kvp, externalKvp: fixture.externalKvp }); restarted.ready(); restarted.open();
    assert.equal(restarted.view().packId, 'builtin'); assert.equal(restarted.view().parkKill, true);
    assert.equal(restarted.calls.filter(call => call[0] === 'GetExternalKvpString').length, 0);
    const corrupted = boot({ kvp: new Map([[fixture.newKey, '{broken']]), externalKvp: fixture.externalKvp });
    corrupted.ready(); corrupted.open();
    assert.equal(corrupted.view().packId, 'builtin');
    assert.equal(corrupted.calls.filter(call => call[0] === 'GetExternalKvpString').length, 0,
        'an existing but corrupt new save must not resurrect the old profile');
});

test('migration tolerates unavailable external APIs and supports an old key in the current namespace', () => {
    const fixture = legacyProfileFixture();
    for (const options of [{ noExternalKvp: true }, { externalKvpError: true }]) {
        const app = boot({ ...options, externalKvp: fixture.externalKvp });
        assert.doesNotThrow(() => { app.ready(); app.open(); });
        assert.equal(app.view().packId, 'builtin'); assert.equal(app.kvp.size, 0);
    }
    const sameNamespace = boot({ noExternalKvp: true, kvp: new Map([[fixture.oldKey, fixture.value]]) });
    sameNamespace.ready(); sameNamespace.open();
    assert.equal(sameNamespace.view().packId, 'ss2000');
    assert.equal(sameNamespace.kvp.get(fixture.newKey), fixture.value);
    assert.equal(sameNamespace.kvp.get(fixture.oldKey), fixture.value);
});

test('invalid legacy values and vehicles without a stable identity are not migrated', () => {
    const fixture = legacyProfileFixture();
    for (const oldValue of ['{broken', '{"version":99,"packId":"ss2000"}']) {
        const externalKvp = new Map([[[...fixture.externalKvp.keys()][0], oldValue]]);
        const app = boot({ externalKvp }); app.ready(); app.open();
        assert.equal(app.view().packId, 'builtin'); assert.equal(app.kvp.size, 0);
    }
    const blank = boot({ externalKvp: fixture.externalKvp }); blank.cars.get(10).plate = '  ';
    blank.ready(); blank.open();
    assert.equal(blank.kvp.size, 0);
    assert.equal(blank.calls.filter(call => call[0] === 'GetExternalKvpString').length, 0);
});

test('wait for server snapshot before emergency auto-enable; retain parked stage on takeover', () => {
    const app = boot(); app.frame();
    assert.equal(app.controllerMessages.length, 0);
    app.synchronized(110, true, 1, 1, false);
    app.ready();
    assert.equal(app.controllerMessages.at(-1)[3], 1);
    assert.equal(app.nativeSirens.get(10), true);
});

test('emergency stages only use factory lights; no underbody/headlight mutations even at stop', () => {
    const app = boot(); app.ready();
    app.hold(21); app.press(86); app.frame();
    assert.equal(app.nativeSirens.get(10), true);
    app.press(86); app.frame();
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity' && call[2] === 'VEHICLES_HORNS_SIREN_1'));
    app.emit('onClientResourceStop', 'yx_sirencontrol');
    assert.equal(app.nativeSirens.get(10), false);
    assert.equal(app.calls.filter(call => ['DrawLightWithRange', 'SetVehicleLights', 'SetVehicleFullbeam'].includes(call[0])).length, 0);
    assert.ok(app.calls.some(call => call[0] === 'SetVehicleHasMutedSirens' && call[2] === false));
});

test('numeric native BOOLs never restart the lightbar on unchanged frames or siren-only changes', () => {
    const app = boot({ numericNativeBools: true }); app.ready(); app.open();
    app.action('stage', 1); app.frame();
    const lightWrites = () => app.calls.filter(call => call[0] === 'SetVehicleSiren' && call[1] === 10);
    const enabledWrites = lightWrites().length;
    for (let i = 0; i < 120; i += 1) app.frame(16);
    assert.equal(lightWrites().length, enabledWrites, 'repeated siren writes reset the factory flash cycle');
    app.action('stage', 2); app.frame();
    app.action('slot', 3); app.frame();
    app.synchronized(110, true, 2, 3, false, 'builtin', 'pulse'); app.frame();
    app.action('stage', 1); app.frame();
    assert.equal(lightWrites().length, enabledWrites, 'changing tones or stages 1/2 must not restart the lightbar');
    app.action('stage', 0); app.frame();
    assert.equal(lightWrites().length, enabledWrites + 1);
    assert.deepEqual(lightWrites().at(-1), ['SetVehicleSiren', 10, false]);
    for (let i = 0; i < 30; i += 1) app.frame(16);
    assert.equal(lightWrites().length, enabledWrites + 1, 'numeric zero must also be treated as false');
});

test('civilian cars require /siren on and retain their original flashing lights', () => {
    const app = boot({ vehicle: 30 }); app.ready();
    assert.equal(app.controllerMessages.length, 0);
    app.command('siren', ['on']);
    app.hold(21); app.press(86); app.frame(200);
    assert.ok(app.calls.some(call => call[0] === 'SetVehicleLights'));
    assert.ok(app.calls.some(call => call[0] === 'DrawLightWithRange'));
    assert.equal(app.calls.filter(call => call[0] === 'SetVehicleSiren').length, 0);
});

test('civilian drivers and front passengers must use /siren on before opening settings', () => {
    for (const [position, options] of [
        ['driver', { vehicle: 30, seat: -1, seats: { '0': 2 } }],
        ['front passenger', { vehicle: 30, seat: 0, seats: { '-1': 2 } }]
    ]) {
        const app = boot(options); app.ready();
        assert.equal(app.key('I'), false, position + ' must not open civilian settings with I before /siren on');
        assert.equal(app.open(), false, position + ' must not open civilian settings by command before /siren on');
        const notice = app.calls.filter(call => call[0] === 'AddTextComponentSubstringPlayerName').at(-1)[1];
        assert.match(notice, /普通车辆/);
        assert.match(notice, /\/siren on/);

        app.command('siren', ['on']);
        assert.deepEqual(app.server.at(-1).slice(1, 5), [130, true, 0, 1]);
        assert.equal(app.key('I'), true, position + ' should open civilian settings with I after /siren on');
        assert.equal(app.view().enabled, true);
        app.emit('yx_sirencontrol:menu:visibility', false);
        assert.equal(app.open(), true, position + ' should open civilian settings by command after /siren on');
    }
});

test('disabling a civilian controller closes settings and rejects stale menu actions', () => {
    const disableCases = [
        ['/siren off', app => app.command('siren', ['off'])],
        ['the menu switch', app => app.action('enabled', false)],
        ['an authoritative server update', app => app.synchronized(130, false, 0, 1, false)]
    ];
    for (const [source, disable] of disableCases) {
        const app = boot({ vehicle: 30 }); app.ready(); app.command('siren', ['on']);
        assert.equal(app.key('I'), true);
        disable(app);
        assert.equal(app.calls.filter(call => call[0] === 'yx_sirencontrol:menu:close').length, 1,
            source + ' should close civilian settings');

        const serverCount = app.server.length, saved = [...app.kvp];
        app.action('enabled', true);
        app.action('stage', 2);
        app.action('pack', 'ss2000');
        assert.equal(app.server.length, serverCount, 'stale menu actions must not re-enable a civilian controller');
        assert.deepEqual([...app.kvp], saved, 'stale menu actions must not change civilian preferences');
        assert.equal(app.key('I'), false, 'civilian settings must stay unavailable until /siren on is used again');
    }
});

test('disabled emergency vehicles retain settings access and the menu enable switch', () => {
    const app = boot(); app.ready(); app.command('siren', ['off']);
    assert.equal(app.key('I'), true);
    assert.equal(app.view().isEmergency, true);
    assert.equal(app.view().enabled, false);
    assert.equal(app.calls.some(call => call[0] === 'yx_sirencontrol:menu:close'), false);
    app.action('enabled', true);
    assert.equal(app.server.at(-1)[2], true);
    assert.equal(app.view().enabled, true);
});

test('I menu beacon offsets save locally in metres and remain isolated by vehicle plate and server', () => {
    const app = boot({ vehicle: 30 }); app.ready(); app.command('siren', ['on']); assert.equal(app.key('I'), true);
    assert.deepEqual(app.view().beacon, { offset: { x: 0, y: 0, z: 0 }, busy: false });
    const networkCount = app.server.length;
    app.action('beaconOffset', -17, 'x'); app.action('beaconOffset', 28, 'y'); app.action('beaconOffset', 9, 'z');
    const firstOffset = { x: -0.17, y: 0.28, z: 0.09 };
    assert.deepEqual(app.view().beacon.offset, firstOffset);
    assert.deepEqual(JSON.parse(JSON.stringify(app.beaconContext.mountOffset(30))), firstOffset);
    assert.equal(app.server.length, networkCount, 'position edits never send audio/state or position packets');
    assert.deepEqual(JSON.parse([...app.kvp.values()][0]).beaconOffset, firstOffset);
    Object.assign(app.cars.get(20), { model: 300, plate: 'CIV02', classId: 1 });
    app.drive(20); app.frame(); app.command('siren', ['on']); assert.equal(app.key('I'), true);
    assert.deepEqual(app.view().beacon.offset, { x: 0, y: 0, z: 0 });
    app.action('beaconOffset', 42, 'z'); assert.equal(app.kvp.size, 2);
    app.drive(30); app.frame(); app.key('I'); assert.deepEqual(app.view().beacon.offset, firstOffset);
    const restarted = boot({ vehicle: 30, kvp: new Map(app.kvp) }); restarted.ready(); restarted.command('siren', ['on']); restarted.key('I');
    assert.deepEqual(restarted.view().beacon.offset, firstOffset);
    Object.assign(restarted.cars.get(20), { model: 300, plate: 'CIV02', classId: 1 });
    restarted.drive(20); restarted.frame(); restarted.command('siren', ['on']); restarted.key('I');
    assert.deepEqual(restarted.view().beacon.offset, { x: 0, y: 0, z: 0.42 });
    const other = boot({ vehicle: 30, kvp: new Map(app.kvp), endpoint: 'another-server:30120' });
    other.ready(); other.command('siren', ['on']); other.key('I');
    assert.deepEqual(other.view().beacon.offset, { x: 0, y: 0, z: 0 });
});

test('beacon position follows configured stable vehicle IDs and blank unidentified cars only retain session offsets', () => {
    function stable(kvp, id, plate) {
        const app = boot({ vehicle: 30, kvp, vehicleStates: { 30: { vin: id } } });
        app.context.YXSirenControlConfig.Persistence.VehicleIdStateKey = 'vin';
        app.cars.get(30).plate = plate; app.ready(); app.command('siren', ['on']); app.key('I'); return app;
    }
    const seed = stable(new Map(), 'VIN-A', ''); seed.action('beaconOffset', 31, 'x');
    const changedPlate = stable(new Map(seed.kvp), 'VIN-A', 'NEWPLATE');
    assert.deepEqual(changedPlate.view().beacon.offset, { x: 0.31, y: 0, z: 0 });
    const otherVin = stable(new Map(seed.kvp), 'VIN-B', 'NEWPLATE');
    assert.deepEqual(otherVin.view().beacon.offset, { x: 0, y: 0, z: 0 });
    const blank = boot({ vehicle: 30 }); blank.cars.get(30).plate = ' '; blank.ready(); blank.command('siren', ['on']); blank.key('I');
    blank.action('beaconOffset', 24, 'z'); assert.equal(blank.kvp.size, 0);
    assert.equal(blank.beaconContext.mountOffset(30).z, 0.24);
    const restart = boot({ vehicle: 30, kvp: new Map(blank.kvp) }); restart.cars.get(30).plate = '';
    restart.ready(); restart.command('siren', ['on']); restart.key('I');
    assert.deepEqual(restart.view().beacon.offset, { x: 0, y: 0, z: 0 });
});

test('position edits and dedicated reset preserve saved audio preferences and another occupant\'s live sound state', () => {
    const app = boot({ vehicle: 30 }); app.ready(); app.command('siren', ['on']); app.key('I');
    app.action('binding', 'hilo', 1); app.action('manualBinding', 'priority', 'r');
    app.action('slot', 5); app.action('parkKill', false); app.action('beaconOffset', 7, 'x');
    const personal = JSON.parse([...app.kvp.values()][0]);
    app.synchronized(130, true, 2, 4, true, 'ss2000', 'rumbler_wail', true, false, 'builtin', '@horn'); app.frame();
    app.open(); const shared = app.view(), networkCount = app.server.length;
    const soundCount = app.calls.filter(call => ['PlaySoundFromEntity', 'StopSound', 'SetVehicleSiren'].includes(call[0])).length;
    app.action('beaconOffset', 35, 'z'); app.action('beaconOffset', -12, 'y');
    assert.deepEqual(JSON.parse([...app.kvp.values()][0]), { ...personal, beaconOffset: { x: 0.07, y: -0.12, z: 0.35 } });
    for (const key of ['stage', 'slot', 'packId', 'parkKill', 'sirenMuted']) assert.deepEqual(app.view()[key], shared[key]);
    app.action('beaconReset');
    assert.deepEqual(JSON.parse([...app.kvp.values()][0]), { ...personal, beaconOffset: { x: 0, y: 0, z: 0 } });
    assert.equal(app.server.length, networkCount);
    assert.equal(app.calls.filter(call => ['PlaySoundFromEntity', 'StopSound', 'SetVehicleSiren'].includes(call[0])).length, soundCount);
    app.action('beaconOffset', 11, 'x'); app.action('pack', 'ss2000'); app.action('reset');
    assert.deepEqual(app.view().beacon.offset, { x: 0.11, y: 0, z: 0 }, 'the siren-settings reset must preserve the separate beacon adjustment');
    assert.equal(app.view().packId, 'builtin');
    assert.deepEqual(JSON.parse([...app.kvp.values()][0]).beaconOffset, { x: 0.11, y: 0, z: 0 });
});

test('old or malformed saved beacon positions normalize to finite centimetre steps within two metres', () => {
    const app = boot(), rules = app.context.YXSirenSettings, catalog = rules.catalog(packData);
    function normalize(beaconOffset) {
        return JSON.parse(JSON.stringify(rules.normalize(catalog,
            { version: 1, packId: 'ss2000', slot: 4, parkKill: false, beaconOffset }, 'builtin', true)));
    }
    for (const invalid of [undefined, null, 'broken', [1, 2, 3], { x: '0.25', y: Infinity, z: NaN }, { x: {}, y: false, z: null }]) {
        const repaired = normalize(invalid);
        assert.deepEqual(repaired.beaconOffset, { x: 0, y: 0, z: 0 });
        assert.equal(repaired.packId, 'ss2000'); assert.equal(repaired.slot, 4); assert.equal(repaired.parkKill, false);
    }
    assert.deepEqual(normalize({ x: 3.25, y: -9.5, z: 0.126 }).beaconOffset, { x: 2, y: -2, z: 0.13 });
    assert.deepEqual(normalize({ x: -0.126, y: 0.124, z: 1.999 }).beaconOffset, { x: -0.13, y: 0.12, z: 2 });
});

test('invalid position menu inputs and ineligible vehicles cannot change local offsets or shared state', () => {
    const app = boot({ vehicle: 30 }); app.ready(); app.command('siren', ['on']); app.key('I');
    app.action('beaconOffset', 12, 'x'); const saved = [...app.kvp], count = app.server.length;
    for (const value of ['25', 2.5, 201, -201, NaN, Infinity, null, undefined, true]) app.action('beaconOffset', value, 'x');
    for (const axis of ['X', 'w', '', null, {}, undefined]) app.action('beaconOffset', 25, axis);
    assert.deepEqual([...app.kvp], saved); assert.equal(app.server.length, count);
    app.action('beaconOffset', -200, 'y'); app.action('beaconOffset', 200, 'z');
    assert.deepEqual(app.view().beacon.offset, { x: 0.12, y: -2, z: 2 });
    const validSave = [...app.kvp]; app.command('siren', ['off']); const disabledCount = app.server.length;
    app.action('beaconOffset', 50, 'x'); app.action('beaconReset');
    assert.equal(app.key('I'), false); assert.deepEqual([...app.kvp], validSave); assert.equal(app.server.length, disabledCount);
    for (const classId of [18, 8, 13, 14, 15, 16, 21]) {
        const excluded = boot({ vehicle: 30 }); excluded.cars.get(30).classId = classId;
        excluded.ready(); excluded.synchronized(130, true, 0, 1, false); excluded.key('I');
        assert.equal(Object.hasOwn(excluded.view(), 'beacon'), false, 'this vehicle class must not expose position controls');
        const before = excluded.server.length;
        excluded.action('beaconOffset', 40, 'x'); excluded.action('beaconReset');
        assert.equal(excluded.kvp.size, 0); assert.equal(excluded.server.length, before);
    }
});

test('an in-progress beacon operation updates the open menu and blocks offset edits until cancellation', () => {
    const app = boot({ vehicle: 30 }); app.ready(); app.command('siren', ['on']); app.key('I');
    app.action('beaconOffset', 8, 'x'); assert.equal(app.view().beacon.busy, false);
    const before = [...app.kvp], count = app.server.length;
    app.emit('yx_sirencontrol:beacon:prepare', 130, 300, 'busy-offset', true);
    assert.equal(app.view().beacon.busy, true, 'the existing menu should reflect preparation without reopening');
    app.action('beaconOffset', 25, 'x'); app.action('beaconReset');
    assert.deepEqual([...app.kvp], before); assert.equal(app.server.length, count);
    app.emit('yx_sirencontrol:beacon:cancelled', 130, 'busy-offset');
    assert.equal(app.view().beacon.busy, false);
    app.action('beaconOffset', 25, 'x'); assert.equal(app.view().beacon.offset.x, 0.25);
});

test('a local beacon position stays applied for the session when KVP saving fails and reports the limitation', () => {
    const app = boot({ vehicle: 30, kvpError: true }); app.ready(); app.command('siren', ['on']); app.key('I');
    const count = app.server.length;
    assert.doesNotThrow(() => app.action('beaconOffset', 19, 'z'));
    assert.equal(app.view().beacon.offset.z, 0.19); assert.equal(app.beaconContext.mountOffset(30).z, 0.19);
    assert.equal(app.kvp.size, 0); assert.equal(app.server.length, count);
    assert.ok(app.calls.some(call => call[0] === 'AddTextComponentSubstringPlayerName' && /本地保存失败/.test(call[1])));
});

test('per-vehicle key bindings and park kill survive restart without leaking between same-model plates or servers', () => {
    const app = boot(); app.ready(); app.open();
    app.action('parkKill', false); app.action('binding', 'hilo', 1); app.action('slot', 5);
    app.drive(20); app.frame(); app.open();
    assert.equal(app.view().parkKill, true);
    assert.equal(app.view().bindings[0], 'wail');
    app.drive(10); app.frame(); app.open();
    assert.equal(app.view().parkKill, false);
    assert.equal(app.view().bindings[0], 'hilo');
    assert.equal(app.view().slot, 5);
    const restarted = boot({ kvp: app.kvp }); restarted.ready(); restarted.open();
    assert.equal(restarted.view().bindings[0], 'hilo');
    const otherServer = boot({ kvp: app.kvp, endpoint: 'different:30120' }); otherServer.ready(); otherServer.open();
    assert.equal(otherServer.view().bindings[0], 'wail');
    assert.equal(otherServer.view().parkKill, true);
});

test('exiting waits for the server to apply last-front-occupant park kill while retaining native lights', () => {
    for (const parkKill of [true, false]) {
        const app = boot(); app.ready(); app.open(); app.action('parkKill', parkKill); app.action('stage', 2); app.frame();
        const previousPlays = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
        const previousStops = app.calls.filter(call => call[0] === 'StopSound').length;
        app.drive(0); app.frame();
        assert.equal(app.nativeSirens.get(10), true);
        assert.ok(app.server.some(call => call[0] === 'yx_sirencontrol:server:driverExit' && call[1] === 110));
        assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, previousStops,
            'a client cannot predict whether the other front seat is still occupied');
        app.synchronized(110, true, parkKill ? 1 : 2, 1, false, 'builtin', 'wail', parkKill); app.frame();
        if (parkKill) assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, previousStops + 1);
        else assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, previousPlays);
    }
});

test('manual horn is released on exit and numbers use saved bindings in the network payload', () => {
    const app = boot(); app.ready(); app.open(); app.action('binding', 'priority', 3); app.action('stage', 2);
    app.emit('yx_sirencontrol:menu:visibility', false); app.press(160); app.frame();
    assert.equal(app.server.at(-1)[4], 3);
    assert.equal(app.server.at(-1)[6], 'priority');
    app.hold(86); app.frame();
    assert.ok(app.server.some(call => call[0] === 'yx_sirencontrol:server:setManualHorn' && call[2]));
    app.drive(0); app.frame();
    assert.ok(app.server.some(call => call[0] === 'yx_sirencontrol:server:setManualHorn' && call[2] === false));
});

test('invalid KVP/schema and removed tones repair to usable defaults; blank plates have no permanent shared key', () => {
    const app = boot(); const rules = app.context.YXSirenSettings;
    const catalog = rules.catalog(packData);
    const prefs = rules.normalize(catalog, { version: 1, packId: 'deleted', slot: 9, parkKill: 'yes', bindings: { builtin: ['missing'] } }, 'builtin', true);
    assert.equal(prefs.packId, 'builtin'); assert.equal(prefs.slot, 1); assert.equal(prefs.parkKill, true);
    assert.deepEqual(Array.from(prefs.bindings.builtin), packData.find(pack => pack.Id === 'builtin').DefaultSlots);
    assert.equal(rules.vehicleKey('server', 100, '  ', null), null);
    assert.notEqual(rules.vehicleKey('server', 100, '', 'VIN1'), rules.vehicleKey('server', 100, '', 'VIN2'));
});

test('disabled emergency controller remains off until re-entry; menu cannot edit a different vehicle', () => {
    const app = boot(); app.ready(); app.command('siren', ['off']);
    const count = app.server.length; app.frame(); app.frame(); assert.equal(app.server.length, count);
    app.open(); app.drive(20); app.action('parkKill', false); app.frame(); app.open();
    assert.equal(app.view().parkKill, true);
});

test('remote vehicles reproduce registered tones and release audio handles on stream-out', () => {
    const app = boot({ vehicle: 0 }); app.ready();
    app.synchronized(120, true, 2, 1, false, 'builtin', 'yelp'); app.frame();
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity' && call[2] === 'VEHICLES_HORNS_SIREN_2' && call[3] === 20));
    app.cars.delete(20); app.frame();
    assert.ok(app.calls.some(call => call[0] === 'ReleaseSoundId'));
});

test('custom audio banks are requested before playback, signatures change with pack, and banks release on stop', () => {
    const custom = packData.find(pack => pack.Id !== 'builtin' && (pack.AudioBanks?.length || pack.Tones[0].AudioBank));
    assert.ok(custom, 'At least one actual custom audio pack must be installed');
    const app = boot({ vehicle: 0 }); app.ready(); app.banksAvailable(false);
    app.synchronized(120, true, 2, 1, false, custom.Id, custom.DefaultSlots[0]); app.frame();
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, 0);
    app.banksAvailable(true); app.frame(50);
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity'));
    app.synchronized(120, false, 0, 1, false); app.emit('onClientResourceStop', 'yx_sirencontrol');
    assert.ok(app.calls.some(call => call[0] === 'ReleaseNamedScriptAudioBank'));
});

test('Modern resident packs play native strings immediately without requesting script audio banks', () => {
    const cases = [
        ['modern_police', 'VEHICLES_HORNS_SIREN_1'],
        ['modern_lafd', 'RESIDENT_VEHICLES_SIREN_FIRETRUCK_WAIL_01']
    ];
    for (const [packId, expectedTone] of cases) {
        const pack = packData.find(item => item.Id === packId);
        assert.ok(pack, packId + ' must be registered in fxmanifest.lua');
        assert.deepEqual(pack.AudioBanks, []);
        for (const sound of [pack.ManualHorn, ...pack.Tones]) {
            assert.equal(sound.SoundSet, null);
            assert.equal(sound.AudioBank, undefined);
        }

        const app = boot({ vehicle: 0 }); app.ready();
        app.synchronized(120, true, 2, 1, false, pack.Id, pack.DefaultSlots[0]); app.frame();
        let play = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1);
        assert.equal(play[2], expectedTone); assert.equal(play[3], 20); assert.equal(play[4], 0);
        assert.equal(app.calls.filter(call => call[0] === 'RequestScriptAudioBank').length, 0);

        app.synchronized(120, true, 2, 1, true, pack.Id, pack.DefaultSlots[0], true, false, pack.Id, '@horn'); app.frame();
        play = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1);
        assert.equal(play[2], 'SIRENS_AIRHORN'); assert.equal(play[4], 0);
        assert.equal(app.calls.filter(call => call[0] === 'RequestScriptAudioBank').length, 0);
    }
});

test('a false bank return is requested once, plays after the settle delay, and still releases', () => {
    const pack = packData.find(item => item.Id === 'ss2000');
    const app = boot({ vehicle: 0 }); app.ready(); app.banksAvailable(false);
    app.synchronized(120, true, 2, 1, false, pack.Id, pack.DefaultSlots[0]); app.frame();
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, 0);
    app.frame(49);
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, 0);
    app.frame(1);
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity'));
    for (let elapsed = 0; elapsed < 5000; elapsed += 200) app.frame(200);
    assert.equal(app.calls.filter(call => call[0] === 'RequestScriptAudioBank').length, 1);
    app.emit('onClientResourceStop', 'yx_sirencontrol');
    assert.ok(app.calls.some(call => call[0] === 'ReleaseNamedScriptAudioBank'));
});

test('civilian light cleanup restores the actual high-beam return value', () => {
    const app = boot({ vehicle: 30, lights: [true, true, false] }); app.ready(); app.command('siren', ['on']);
    app.hold(21); app.press(86); app.frame(); app.command('siren', ['off']);
    assert.deepEqual(app.calls.filter(call => call[0] === 'SetVehicleFullbeam').at(-1), ['SetVehicleFullbeam', 30, false]);
});

test('changing packs preserves that vehicle\'s separate key assignments for each pack', () => {
    const app = boot(); app.ready(); app.open(); app.action('binding', 'hilo', 1);
    app.action('pack', 'ss2000'); app.action('binding', 'rumbler_yelp', 1);
    assert.equal(app.view().bindings[0], 'rumbler_yelp');
    app.action('pack', 'builtin'); assert.equal(app.view().bindings[0], 'hilo');
    app.action('pack', 'ss2000'); assert.equal(app.view().bindings[0], 'rumbler_yelp');
    app.action('reset'); assert.equal(app.view().packId, 'builtin'); assert.equal(app.view().bindings[0], 'wail');
});

test('signed network timer rollover cannot crash an alternating siren', () => {
    const app = boot({ networkTime: -1 }); app.ready(); app.open();
    app.action('binding', 'hilo', 1); app.action('stage', 2);
    assert.doesNotThrow(() => app.frame());
    assert.ok(app.calls.some(call => call[0] === 'PlaySoundFromEntity'));
});

test('all five number keys start their saved tone directly from LIGHT in either front seat of emergency and enabled civilian cars', () => {
    const controls = [157, 158, 160, 164, 165];
    const tones = ['rumbler_yelp', 'priority', 'rumbler_wail', 'wail', 'yelp'];
    const pack = packData.find(pack => pack.Id === 'ss2000');
    for (const vehicle of [10, 30]) {
        const seed = boot({ vehicle }); seed.ready();
        if (vehicle === 30) seed.command('siren', ['on']);
        seed.open(); seed.action('pack', 'ss2000');
        tones.forEach((tone, index) => seed.action('binding', tone, index + 1));
        for (const seat of [-1, 0]) {
            for (const [index, control] of controls.entries()) {
                const app = boot({ vehicle, seat, seats: seat === 0 ? { '-1': 2 } : {},
                    kvp: new Map(seed.kvp), numericNativeBools: true });
                app.ready();
                if (vehicle === 30) app.command('siren', ['on']);
                const net = app.cars.get(vehicle).net;
                // The selected slot already matches the pressed key. LIGHT must
                // start it, never interpret this first press as a mute toggle.
                app.synchronized(net, true, 1, index + 1, false, 'ss2000', tones[index]); app.frame();
                assert.equal(app.open(), true); assert.equal(app.view().stage, 1);
                app.emit('yx_sirencontrol:menu:visibility', false);
                assert.equal(app.hud().at(-1).text, 'LIGHT');
                const previousPlays = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
                const lightWrites = app.calls.filter(call => call[0] === 'SetVehicleSiren' && call[1] === vehicle).length;
                const count = app.controllerMessages.length, callStart = app.calls.length;
                app.press(control); app.frame();
                assert.equal(app.controllerMessages.length, count + 1, 'one key press directly changes LIGHT to SIREN');
                assert.deepEqual(app.controllerMessages.at(-1).slice(1, 9), [net, true, 2, index + 1, 'ss2000', tones[index], true, false]);
                const plays = app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
                assert.equal(plays.length, previousPlays + 1);
                assert.equal(plays.at(-1)[2], pack.Tones.find(tone => tone.Id === tones[index]).SoundName);
                assert.equal(plays.at(-1)[3], vehicle);
                assert.equal(app.hud().at(-1).text, 'SIREN');
                const suppressed = app.calls.slice(callStart).filter(call => call[0] === 'DisableControlAction').map(call => call[2]);
                assert.ok(controls.every(control => suppressed.includes(control)), 'numeric GTA actions are suppressed while LIGHT is active');
                assert.equal(app.calls.filter(call => call[0] === 'SetVehicleSiren' && call[1] === vehicle).length, lightWrites,
                    'starting the tone must not restart the factory light cycle');
                const saved = JSON.parse([...app.kvp.values()][0]);
                assert.equal(saved.packId, 'ss2000'); assert.equal(saved.slot, index + 1);
                assert.deepEqual(saved.bindings.ss2000, tones);
            }
        }
    }
});

test('a direct LIGHT shortcut uses the shared active pack and its per-vehicle saved bindings', () => {
    const seed = boot(); seed.ready(); seed.open();
    seed.action('pack', 'ss2000'); seed.action('binding', 'rumbler_yelp', 2);
    seed.action('binding', 'priority', 4); seed.action('pack', 'builtin');
    const savedBefore = [...seed.kvp];
    for (const options of [{ seat: 0, seats: { '-1': 2 } }, { seat: -1, seats: { '0': 2 } }]) {
        for (const [control, slot, tone] of [[158, 2, 'rumbler_yelp'], [164, 4, 'wail']]) {
            const app = boot({ ...options, kvp: new Map(savedBefore) });
            app.synchronized(110, true, 1, 4, false, 'ss2000', 'wail', false); app.ready();
            assert.deepEqual([...app.kvp], savedBefore, 'joining another occupant preserves personal settings until explicit input');
            app.press(control); app.frame();
            assert.deepEqual(app.controllerMessages.at(-1).slice(1, 9), [110, true, 2, slot, 'ss2000', tone, false, false]);
            const saved = JSON.parse([...app.kvp.values()][0]);
            assert.equal(saved.packId, 'ss2000'); assert.equal(saved.slot, slot);
            assert.equal(saved.bindings.ss2000[slot - 1], tone,
                'the active shared slot keeps its actual tone; other slots use this vehicle\'s saved pack bindings');
        }
    }
});

test('number keys do nothing at OFF or with a disabled controller in either front seat', () => {
    const controls = [157, 158, 160, 164, 165];
    for (const vehicle of [10, 30]) {
        for (const seat of [-1, 0]) {
            for (const enabled of [true, false]) {
                const app = boot({ vehicle, seat, seats: seat === 0 ? { '-1': 2 } : {} }); app.ready();
                const net = app.cars.get(vehicle).net;
                app.synchronized(net, enabled, 0, 3, false, 'builtin', 'pulse'); app.frame();
                const messages = app.controllerMessages.length, saved = [...app.kvp], start = app.calls.length;
                for (const control of controls) { app.press(control); app.frame(); }
                assert.equal(app.controllerMessages.length, messages, 'OFF/disabled must not transmit a siren selection');
                assert.deepEqual([...app.kvp], saved, 'ignored keys must not change saved settings');
                assert.equal(app.calls.slice(start).some(call => call[0] === 'PlaySoundFromEntity'), false);
                assert.equal(app.calls.slice(start).some(call => call[0] === 'SetVehicleSiren' && call[2]), false);
                assert.equal(app.calls.slice(start).some(call => call[0] === 'DisableControlAction' && controls.includes(call[2])), false);
            }
        }
    }
});

test('all five number keys toggle the active siren without changing stage or restarting emergency lights', () => {
    const controls = [157, 158, 160, 164, 165];
    for (const [index, control] of controls.entries()) {
        const app = boot({ numericNativeBools: true }); app.ready(); app.open();
        // Use a continuous tone in every slot so silence is observable independently of pulse timing.
        app.action('binding', 'wail', index + 1); app.action('slot', index + 1); app.action('stage', 2); app.frame();
        app.emit('yx_sirencontrol:menu:visibility', false);
        const lightWrites = () => app.calls.filter(call => call[0] === 'SetVehicleSiren').length;
        const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
        const lightCount = lightWrites(), playingCount = plays();
        app.press(control); app.frame();
        assert.equal(app.server.at(-1)[3], 2);
        assert.equal(app.server.at(-1)[4], index + 1);
        assert.equal(app.server.at(-1)[8], true);
        assert.ok(app.calls.some(call => call[0] === 'StopSound'));
        for (let frame = 0; frame < 30; frame++) app.frame(16);
        assert.equal(plays(), playingCount, 'muted siren must not silently allocate/restart sound handles');
        assert.equal(lightWrites(), lightCount);
        assert.equal(app.nativeSirens.get(10), true);
        app.press(control); app.frame();
        assert.equal(app.server.at(-1)[8], false);
        assert.equal(plays(), playingCount + 1, 'same key resumes the selected tone');
        app.press(control); app.frame();
        app.press(controls[(index + 1) % 5]); app.frame();
        assert.equal(app.server.at(-1)[4], (index + 1) % 5 + 1);
        assert.equal(app.server.at(-1)[8], false, 'a different key selects and resumes its tone');
        assert.equal(lightWrites(), lightCount);
    }
});

test('manual horn works while continuous siren is muted and releasing it retains silence', () => {
    const app = boot(); app.ready(); app.open(); app.action('stage', 2); app.frame();
    app.emit('yx_sirencontrol:menu:visibility', false); app.press(157); app.frame();
    const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
    const sirenPlays = plays().length;
    app.hold(86); app.frame();
    assert.equal(plays().length, sirenPlays + 1);
    assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_POLICE_WARNING');
    app.hold(); app.frame(); app.frame();
    assert.equal(plays().length, sirenPlays + 1, 'releasing horn must not resume the muted siren');
    app.open(); assert.equal(app.view().sirenMuted, true); assert.equal(app.view().stage, 2);
});

test('remote mute synchronizes and muted vehicles do not consume the nearby sound budget', () => {
    const app = boot({ vehicle: 0 }); app.ready(); app.context.YXSirenControlConfig.Audio.MaxAudibleVehicles = 1;
    app.synchronized(110, true, 2, 1, false, 'builtin', 'wail', false, true);
    app.synchronized(120, true, 2, 1, false, 'builtin', 'wail', false, false); app.frame();
    const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
    assert.equal(plays().length, 1); assert.equal(plays()[0][3], 20);
    app.synchronized(120, true, 2, 1, false, 'builtin', 'wail', false, true); app.frame();
    assert.ok(app.calls.some(call => call[0] === 'StopSound'));
    app.synchronized(120, true, 2, 1, true, 'builtin', 'wail', false, true); app.frame();
    assert.equal(plays().length, 2); assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_POLICE_WARNING');
    app.synchronized(120, true, 2, 1, false, 'builtin', 'wail', false, true); app.frame();
    assert.equal(plays().length, 2);
    assert.equal(app.nativeSirens.get(10), true); assert.equal(app.nativeSirens.get(20), true);
});

test('only the correct menu command is registered; siren checkbox validates stage and preserves mute during edits', () => {
    const app = boot(); app.ready(); app.command('sirencontrol');
    assert.deepEqual([...app.commands.keys()].sort(), ['putsiren', 'siren', 'sirencontrol']);
    assert.equal(app.keyMappings.length, 1);
    assert.deepEqual(
        { command: app.keyMappings[0].command, mapper: app.keyMappings[0].mapper, parameter: app.keyMappings[0].parameter },
        { command: 'sirencontrol', mapper: 'keyboard', parameter: 'I' }
    );
    assert.match(app.keyMappings[0].description, /[\u3400-\u9fff]/, 'the I-key binding should have a Chinese settings-menu label');
    app.emit('yx_sirencontrol:menu:visibility', true);
    assert.equal(app.view().networkId, 110);
    const eventsBefore = app.server.length;
    app.action('sirenEnabled', false); assert.equal(app.server.length, eventsBefore);
    app.action('stage', 2); app.action('sirenEnabled', false);
    assert.equal(app.view().sirenMuted, true); assert.equal(app.view().stage, 2);
    app.action('stage', 2); assert.equal(app.view().sirenMuted, true, 'confirming the same stage must not resume the siren');
    app.action('parkKill', false); app.action('pack', 'ss2000'); app.action('binding', 'rumbler_yelp', 1);
    assert.equal(app.view().sirenMuted, true); assert.equal(app.server.at(-1)[8], true);
    for (const raw of app.kvp.values()) assert.equal(Object.hasOwn(JSON.parse(raw), 'sirenMuted'), false);
    const beforeInvalid = app.server.length;
    app.action('sirenEnabled', 'false'); assert.equal(app.server.length, beforeInvalid);
    app.action('sirenEnabled', true); assert.equal(app.view().sirenMuted, false);
    app.action('sirenEnabled', false); app.action('slot', 2); assert.equal(app.view().sirenMuted, false);
    app.emit('onClientResourceStart', 'yx_sirencontrol');
    app.emit('onClientResourceStop', 'yx_sirencontrol');
    for (const name of ['/sirencontrol']) {
        assert.ok(app.calls.some(call => call[0] === 'chat:addSuggestion' && call[1] === name));
        assert.ok(app.calls.some(call => call[0] === 'chat:removeSuggestion' && call[1] === name));
    }
});

test('mute survives parked stage-two takeover but is cleared by park kill and stage changes', () => {
    for (const parkKill of [true, false]) {
        const app = boot(); app.ready(); app.open(); app.action('parkKill', parkKill);
        app.action('stage', 2); app.action('sirenEnabled', false); app.frame();
        app.emit('yx_sirencontrol:menu:visibility', false); app.drive(0); app.frame();
        app.synchronized(110, true, parkKill ? 1 : 2, 1, false, 'builtin', 'wail', parkKill, !parkKill);
        app.drive(10); app.frame(); app.open();
        assert.equal(app.view().stage, parkKill ? 1 : 2);
        assert.equal(app.view().sirenMuted, !parkKill);
        app.action('stage', 1); app.action('stage', 2);
        assert.equal(app.view().sirenMuted, false);
    }
    const app = boot();
    app.synchronized(110, true, 2, 1, false, 'builtin', 'wail', false, true);
    app.ready(); app.open();
    assert.equal(app.view().sirenMuted, true, 'initial snapshot mute must survive driver setup');
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, 0);
});

test('I uses the existing settings command from either front seat, but not from a rear seat or outside the vehicle', () => {
    for (const [position, options] of [
        ['driver', { seat: -1, seats: { '0': 2 } }],
        ['front passenger', { seat: 0, seats: { '-1': 2 } }]
    ]) {
        const app = boot(options); app.ready();
        assert.equal(app.key('I'), true, position + ' should open settings with I');
        assert.equal(app.view().networkId, 110);

        const opens = () => app.calls.filter(call => call[0] === 'yx_sirencontrol:menu:open').length;
        const serverCount = app.server.length, saved = [...app.kvp];
        assert.equal(opens(), 1);
        assert.equal(app.key('I'), true, 'I should keep the existing menu-command behavior while settings are visible');
        assert.equal(opens(), 2, 'a repeated I press should still route through the existing menu command');
        assert.equal(app.server.length, serverCount, 'reopening settings must not change synchronized vehicle state');
        assert.deepEqual([...app.kvp], saved, 'reopening settings must not write vehicle preferences');

        app.emit('yx_sirencontrol:menu:visibility', false);
        assert.equal(app.key('I'), true, 'I should open settings again after the menu closes');
        assert.equal(opens(), 3);
    }

    for (const [position, options] of [
        ['rear passenger', { seat: 1, seats: { '-1': 2, '0': 3 } }],
        ['player outside', { vehicle: 0 }]
    ]) {
        const app = boot(options); app.ready();
        assert.equal(app.key('I'), false, position + ' must not open settings with I');
        assert.equal(app.calls.some(call => call[0] === 'yx_sirencontrol:menu:open'), false);
    }
});

test('front passenger operates keyboard, manual horn and menu while a driver remains seated', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } }); app.ready();
    assert.equal(app.controllerMessages.length, 0, 'a joining passenger must not auto-enable over the driver');
    app.synchronized(110, true, 1, 1, false);
    assert.equal(app.open(), true);
    app.action('stage', 2); assert.equal(app.view().stage, 2);
    app.action('binding', 'priority', 2);
    app.emit('yx_sirencontrol:menu:visibility', false);
    app.press(158); app.frame();
    assert.deepEqual(app.server.at(-1).slice(1, 7), [110, true, 2, 2, 'builtin', 'priority']);
    assert.equal(app.kvp.size, 1, 'a passenger\'s explicit selection is saved locally');
    app.hold(86); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'builtin', '@horn']);
    app.hold(); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, false, '', '']);
    app.hold(21); app.press(85); app.frame();
    assert.equal(app.server.at(-1)[3], 1, 'passenger downshift should reach lights-only stage');
});

test('rear passengers cannot issue commands, keyboard changes or stale menu actions', () => {
    const app = boot({ seat: 1, seats: { '-1': 2, '0': 3 } });
    app.synchronized(110, true, 2, 1, false); app.ready();
    assert.equal(app.controllerMessages.length, 0);
    assert.equal(app.open(), false);
    app.command('siren', ['off']);
    app.hold(21); app.press(86); app.frame(); app.hold(86); app.press(158); app.frame();
    assert.equal(app.controllerMessages.length, 0); assert.equal(app.kvp.size, 0);
    const formerDriver = boot(); formerDriver.ready(); formerDriver.open();
    formerDriver.seat(1);
    const count = formerDriver.server.length;
    formerDriver.action('stage', 2); formerDriver.action('pack', 'ss2000');
    assert.equal(formerDriver.server.length, count); assert.equal(formerDriver.kvp.size, 0);
});

test('driver can initially auto-enable with a passenger present and a lone passenger can auto-enable', () => {
    for (const options of [{ seats: { '0': 2 } }, { seat: 0 }, { seat: 0, seats: { '-1': 2 }, deadOther: true }]) {
        const app = boot(options);
        if (options.deadOther) app.killPed(2);
        app.ready();
        assert.deepEqual(app.controllerMessages.at(-1).slice(1, 5), [110, true, 0, 1]);
    }
});

test('joining either front seat preserves the other occupant\'s active selection without writing personal KVP', () => {
    const personal = boot(); personal.ready(); personal.open();
    personal.action('binding', 'hilo', 1); personal.action('slot', 5); personal.action('parkKill', false);
    const saved = [...personal.kvp];
    for (const options of [{ seat: 0, seats: { '-1': 2 } }, { seat: -1, seats: { '0': 2 } }]) {
        const app = boot({ ...options, kvp: new Map(saved) });
        app.synchronized(110, true, 2, 4, false, 'ss2000', 'rumbler_wail', true);
        app.ready(); app.open(); app.frame();
        assert.equal(app.controllerMessages.length, 0, 'joining an occupied controller must not send personal preferences');
        assert.equal(app.view().packId, 'ss2000'); assert.equal(app.view().slot, 4);
        assert.equal(app.view().bindings[3], 'rumbler_wail'); assert.equal(app.view().parkKill, true);
        assert.deepEqual([...app.kvp], saved, 'observing shared settings must never write KVP');
    }
    const solo = boot({ kvp: new Map(saved) });
    solo.synchronized(110, true, 1, 4, false, 'ss2000', 'rumbler_wail', true);
    solo.ready(); solo.open();
    assert.equal(solo.view().packId, 'builtin'); assert.equal(solo.view().slot, 5);
    assert.equal(solo.view().bindings[0], 'hilo'); assert.equal(solo.view().parkKill, false);
});

test('passenger shifts preserve the shared pack and tone; explicit number changes then save that selection', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 1, 4, false, 'ss2000', 'rumbler_wail', false); app.ready();
    app.hold(21); app.press(86); app.frame();
    assert.deepEqual(app.server.at(-1).slice(3, 8), [2, 4, 'ss2000', 'rumbler_wail', false]);
    app.press(85); app.frame();
    assert.deepEqual(app.server.at(-1).slice(3, 8), [1, 4, 'ss2000', 'rumbler_wail', false]);
    assert.equal(app.kvp.size, 0, 'shifting alone does not overwrite a saved profile');
    app.press(86); app.frame(); app.hold(); app.press(157); app.frame();
    assert.deepEqual(app.server.at(-1).slice(3, 7), [2, 1, 'ss2000', 'wail']);
    const saved = JSON.parse([...app.kvp.values()][0]);
    assert.equal(saved.packId, 'ss2000'); assert.equal(saved.slot, 1); assert.equal(saved.parkKill, false);
});

test('same-car front-seat swaps and passenger exit never locally change shared lights or siren', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 2, 2, false, 'builtin', 'yelp', true); app.ready(); app.frame();
    const count = app.server.length, stops = app.calls.filter(call => call[0] === 'StopSound').length;
    app.seat(-1); app.occupy(10, 0, 2); app.frame();
    app.seat(0); app.occupy(10, -1, 2); app.frame();
    assert.equal(app.server.length, count, 'front-seat swaps must not resubmit or exit the shared controller');
    app.drive(0); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:driverExit', 110]);
    assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops);
    assert.equal(app.nativeSirens.get(10), true);
    app.synchronized(110, true, 2, 2, false, 'builtin', 'yelp', true); app.frame();
    app.drive(10, 0); app.frame(); app.open();
    assert.equal(app.view().stage, 2); assert.equal(app.view().slot, 2);
    assert.equal(app.kvp.size, 0);
});

test('local horn release waits for the server to merge both front occupants\' held buttons', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 2, 1, false, 'builtin', 'wail', true, true); app.ready();
    app.hold(86); app.frame();
    app.synchronized(110, true, 2, 1, true, 'builtin', 'wail', true, true); app.frame();
    const stops = app.calls.filter(call => call[0] === 'StopSound').length;
    app.hold(); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, false, '', '']);
    assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops, 'local release cannot silence another occupant');
    app.synchronized(110, true, 2, 1, true, 'builtin', 'wail', true, true); app.frame();
    assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops, 'the other held horn remains audible');
    const releases = app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn' && call[2] === false).length;
    for (let i = 0; i < 10; i++) app.frame(16);
    assert.equal(app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn' && call[2] === false).length, releases);
    app.synchronized(110, true, 2, 1, false, 'builtin', 'wail', true, true); app.frame();
    assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops + 1);
    app.open(); assert.equal(app.view().sirenMuted, true); assert.equal(app.view().stage, 2);
});

test('HUD displays exactly two centered lines with plain ELS and yellow OFF, LIGHT or SIREN', () => {
    const app = boot(); app.ready(); app.open();
    const config = app.context.YXSirenControlConfig.Hud;
    Object.assign(config, { X: 0.48, Y: 0.65, LineSpacing: 0.047, Scale: 0.4, StatusScale: 0.3 });
    function assertHud(status) {
        const lines = app.hud();
        assert.deepEqual(lines.map(line => line.text), ['ELS', status]);
        assert.deepEqual(lines.map(line => [line.x, line.y]), [[0.48, 0.65], [0.48, 0.65 + 0.047]]);
        assert.deepEqual(lines[0].color, [255, 255, 255, 255]);
        assert.deepEqual(lines[1].color, [255, 205, 64, 255]);
        assert.equal(lines[0].scale, 0.4); assert.equal(lines[1].scale, 0.3);
        assert.ok(lines.every(line => line.centre && !line.right && !/[0-9~]/.test(line.text)));
    }
    app.action('stage', 0); app.frame(1); assertHud('OFF');
    app.action('stage', 1); app.frame(1); assertHud('LIGHT');
    app.action('pack', 'ss2000'); app.action('slot', 5); app.action('stage', 2); app.frame(1); assertHud('SIREN');
    app.action('sirenEnabled', false); app.frame(1); assertHud('LIGHT');
    app.emit('yx_sirencontrol:menu:visibility', false); app.hold(86); app.frame(1); assertHud('SIREN');
    app.hold(); app.synchronized(110, true, 2, 5, false, 'ss2000', 'rumbler_yelp', true, true); app.frame(1); assertHud('LIGHT');
});

test('same-vehicle remote state refreshes live HUD and its 2.4-second timer without writing KVP', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 1, 1, false); app.ready(); app.frame(2500);
    assert.equal(app.hud().length, 0);
    app.synchronized(120, true, 2, 1, false); app.frame(1);
    assert.equal(app.hud().length, 0, 'another vehicle must not reactivate this vehicle\'s HUD');
    app.synchronized(110, true, 2, 3, false, 'builtin', 'priority'); app.frame(1);
    assert.deepEqual(app.hud().map(line => line.text), ['ELS', 'SIREN']);
    app.synchronized(110, true, 2, 3, false, 'builtin', 'priority', true, true); app.frame(1);
    assert.deepEqual(app.hud().map(line => line.text), ['ELS', 'LIGHT']);
    app.synchronized(110, false, 0, 1, false); app.frame(1);
    assert.deepEqual(app.hud().map(line => line.text), ['ELS', 'OFF']);
    app.synchronized(110, true, 1, 1, false); app.frame(2300);
    assert.equal(app.hud()[0].color[3], Math.round(255 * 100 / 350));
    app.frame(100); assert.equal(app.hud().length, 0);
    assert.equal(app.kvp.size, 0); assert.equal(app.controllerMessages.length, 0);
});

test('full state changes retain a shared horn until server merge while disabling still stops immediately', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 2, 1, true, 'builtin', 'wail'); app.ready(); app.open(); app.frame();
    const stops = () => app.calls.filter(call => call[0] === 'StopSound').length;
    const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
    const initialStops = stops(), initialPlays = plays().length;
    assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_POLICE_WARNING');
    for (const action of [['stage', 1], ['stage', 2], ['parkKill', false]]) {
        app.action(...action); app.frame();
        assert.equal(stops(), initialStops, 'stage or park-kill edits must not interrupt another occupant\'s horn');
        assert.equal(plays().length, initialPlays, 'an edit must not switch a held horn back to the continuous siren');
        const live = app.view();
        app.synchronized(110, true, live.stage, 1, true, 'builtin', 'wail', live.parkKill); app.frame();
        assert.equal(stops(), initialStops, 'merged true must retain the existing horn handle');
    }
    const custom = packData.find(pack => pack.Id === 'ss2000');
    app.action('pack', custom.Id); app.frame();
    assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_POLICE_WARNING', 'changing the continuous pack cannot change another occupant\'s held manual tone');
    assert.equal(stops(), initialStops); assert.equal(plays().length, initialPlays);
    app.synchronized(110, true, 2, 1, true, custom.Id, custom.DefaultSlots[0], false, false, 'builtin', '@horn'); app.frame();
    assert.equal(stops(), initialStops); assert.equal(plays().length, initialPlays);
    app.synchronized(110, true, 2, 1, true, custom.Id, custom.DefaultSlots[0], false, false, custom.Id, '@horn'); app.frame();
    assert.equal(plays().at(-1)[2], custom.ManualHorn.SoundName, 'only explicit manual fields in a server update replace the held tone');
    const customStops = stops(), customPlays = plays().length;
    app.synchronized(110, true, 2, 1, true, custom.Id, custom.DefaultSlots[0], false); app.frame();
    assert.equal(stops(), customStops); assert.equal(plays().length, customPlays);
    app.synchronized(110, true, 2, 1, false, custom.Id, custom.DefaultSlots[0], false); app.frame();
    assert.equal(stops(), customStops + 1, 'only the merged false response releases the other occupant\'s horn');
    assert.equal(plays().at(-1)[2], custom.Tones.find(tone => tone.Id === custom.DefaultSlots[0]).SoundName);

    // A caller's own full-state change also waits for its authoritative horn release.
    const solo = boot(); solo.ready(); solo.open(); solo.action('stage', 2);
    solo.emit('yx_sirencontrol:menu:visibility', false); solo.hold(86); solo.frame();
    const soloStops = solo.calls.filter(call => call[0] === 'StopSound').length;
    const soloPlays = solo.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
    solo.press(158); solo.frame(); solo.hold(); solo.frame();
    assert.equal(solo.calls.filter(call => call[0] === 'StopSound').length, soloStops);
    assert.equal(solo.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, soloPlays);
    solo.synchronized(110, true, 2, 2, false, 'builtin', 'yelp'); solo.frame();
    assert.equal(solo.calls.filter(call => call[0] === 'StopSound').length, soloStops + 1);
    assert.equal(solo.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], 'VEHICLES_HORNS_SIREN_2');

    app.synchronized(110, true, 2, 1, true, custom.Id, custom.DefaultSlots[0], false); app.frame();
    const beforeDisable = stops(); app.action('enabled', false); app.frame();
    assert.equal(stops(), beforeDisable + 1, 'disabled means all audio stops immediately, including a shared horn');
    assert.equal(app.nativeSirens.get(10), false);
});

test('default E and both R controls play momentary tones at OFF, LIGHT and SIREN without changing the saved stage', () => {
    for (const stage of [0, 1, 2]) {
        for (const [control, tone, sound] of [[86, '@horn', 'VEHICLES_HORNS_POLICE_WARNING'],
            [80, 'wail', 'VEHICLES_HORNS_SIREN_1'], [45, 'wail', 'VEHICLES_HORNS_SIREN_1']]) {
            const app = boot(); app.ready(); app.open(); app.action('slot', 2); app.action('stage', stage); app.frame();
            assert.deepEqual(app.view().manualBindings, { e: '@horn', r: 'wail' });
            app.emit('yx_sirencontrol:menu:visibility', false);
            const lightWrites = app.calls.filter(call => call[0] === 'SetVehicleSiren').length;
            const fullStates = app.server.filter(call => call[0] === 'yx_sirencontrol:server:setState').length;
            const inputStart = app.calls.length;
            app.hold(control); app.frame();
            assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'builtin', tone]);
            assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], sound);
            for (const blocked of [80, 45]) assert.ok(app.calls.slice(inputStart).some(call => call[0] === 'DisableControlAction' && call[2] === blocked));
            const plays = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
            const stops = app.calls.filter(call => call[0] === 'StopSound').length;
            app.hold(); app.frame();
            assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, false, '', '']);
            assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops, 'release waits for the authoritative merged state');
            app.synchronized(110, true, stage, 2, false, 'builtin', 'yelp'); app.frame();
            assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, plays + (stage === 2 ? 1 : 0));
            if (stage === 2) assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], 'VEHICLES_HORNS_SIREN_2');
            assert.equal(app.calls.filter(call => call[0] === 'SetVehicleSiren').length, lightWrites);
            assert.equal(app.server.filter(call => call[0] === 'yx_sirencontrol:server:setState').length, fullStates);
            app.open(); assert.equal(app.view().stage, stage); assert.equal(app.view().slot, 2); assert.equal(app.view().sirenMuted, false);
        }
    }
});

test('releasing R restores stage-two mute without restarting its lights or continuous tone', () => {
    const app = boot(); app.ready(); app.open(); app.action('slot', 4); app.action('stage', 2); app.action('sirenEnabled', false); app.frame();
    app.emit('yx_sirencontrol:menu:visibility', false);
    const lightWrites = app.calls.filter(call => call[0] === 'SetVehicleSiren').length;
    app.hold(80); app.frame();
    const plays = app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length;
    app.hold(); app.frame();
    app.synchronized(110, true, 2, 4, false, 'builtin', 'priority', true, true); app.frame(); app.open();
    assert.equal(app.view().stage, 2); assert.equal(app.view().slot, 4); assert.equal(app.view().sirenMuted, true);
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').length, plays);
    assert.equal(app.calls.filter(call => call[0] === 'SetVehicleSiren').length, lightWrites);
});

test('Shift+E remains a stage shortcut and never sends a manual-tone start', () => {
    const app = boot(); app.ready(); app.hold(21, 86); app.press(86); app.frame();
    assert.equal(app.controllerMessages.at(-1)[3], 1);
    app.press(86); app.frame(); assert.equal(app.server.at(-1)[3], 2);
    assert.equal(app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn').length, 0);
    app.hold(86); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'builtin', '@horn']);
});

test('E wins over R while both are held and releasing E resumes the held R tone', () => {
    const app = boot(); app.ready();
    app.hold(80); app.frame();
    assert.deepEqual(app.server.at(-1).slice(2), [true, 'builtin', 'wail']);
    app.hold(80, 86); app.frame();
    assert.deepEqual(app.server.at(-1).slice(2), [true, 'builtin', '@horn']);
    const count = app.server.length;
    for (let index = 0; index < 30; index++) app.frame(16);
    assert.equal(app.server.length, count, 'holding both buttons must not alternate or resend requests');
    app.hold(80); app.frame(); assert.deepEqual(app.server.at(-1).slice(2), [true, 'builtin', 'wail']);
    app.hold(); app.frame(); assert.deepEqual(app.server.at(-1).slice(2), [false, '', '']);
});

test('manual E/R bindings save per vehicle and per pack, survive restart, and do not change active lights or siren', () => {
    const app = boot(); app.ready(); app.open(); app.action('slot', 2); app.action('stage', 2); app.frame();
    const before = app.view(), serverCount = app.server.length;
    const audioCalls = app.calls.filter(call => ['StopSound', 'PlaySoundFromEntity', 'SetVehicleSiren'].includes(call[0])).length;
    app.action('manualBinding', 'hilo', 'e'); app.action('manualBinding', 'priority', 'r'); app.frame();
    assert.equal(app.server.length, serverCount, 'manual binding edits must not send full state or manual requests');
    assert.equal(app.calls.filter(call => ['StopSound', 'PlaySoundFromEntity', 'SetVehicleSiren'].includes(call[0])).length, audioCalls);
    assert.deepEqual(app.view().manualBindings, { e: 'hilo', r: 'priority' });
    for (const field of ['stage', 'slot', 'packId', 'parkKill', 'sirenMuted']) assert.equal(app.view()[field], before[field]);
    app.action('pack', 'ss2000'); assert.deepEqual(app.view().manualBindings, { e: '@horn', r: 'wail' });
    app.action('manualBinding', 'rumbler_yelp', 'e'); app.action('manualBinding', 'rumbler_wail', 'r');
    app.action('pack', 'builtin'); assert.deepEqual(app.view().manualBindings, { e: 'hilo', r: 'priority' });
    app.action('pack', 'ss2000'); assert.deepEqual(app.view().manualBindings, { e: 'rumbler_yelp', r: 'rumbler_wail' });
    app.drive(20); app.frame(); app.open(); assert.deepEqual(app.view().manualBindings, { e: '@horn', r: 'wail' });
    app.drive(10); app.frame(); app.open(); assert.deepEqual(app.view().manualBindings, { e: 'rumbler_yelp', r: 'rumbler_wail' });
    const restarted = boot({ kvp: app.kvp }); restarted.ready(); restarted.open();
    assert.deepEqual(restarted.view().manualBindings, { e: 'rumbler_yelp', r: 'rumbler_wail' });
    restarted.emit('yx_sirencontrol:menu:visibility', false);
    for (const [control, toneId] of [[86, 'rumbler_yelp'], [80, 'rumbler_wail']]) {
        restarted.hold(control); restarted.frame();
        assert.deepEqual(restarted.server.at(-1).slice(2), [true, 'ss2000', toneId]);
        assert.equal(restarted.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2],
            packData.find(pack => pack.Id === 'ss2000').Tones.find(tone => tone.Id === toneId).SoundName);
    }
    restarted.hold(); restarted.open();
    restarted.action('reset'); assert.deepEqual(restarted.view().manualBindings, { e: '@horn', r: 'wail' });
});

test('old profiles gain manual defaults and a pack without wail exposes and plays the GTA wail fallback', () => {
    const seed = boot(); seed.ready(); seed.open(); seed.action('binding', 'hilo', 1);
    const [key, raw] = [...seed.kvp][0], old = JSON.parse(raw); delete old.manualBindings;
    const app = boot({ kvp: new Map([[key, JSON.stringify(old)]]) }); app.ready(); app.open();
    assert.deepEqual(app.view().manualBindings, { e: '@horn', r: 'wail' }); assert.equal(app.view().bindings[0], 'hilo');
    assert.equal(app.view().manualTones.some(tone => tone.id === '@wail'), false, 'a pack with wail does not need its fallback');
    app.action('pack', 'fire_q');
    assert.deepEqual(app.view().manualBindings, { e: '@horn', r: '@wail' });
    assert.ok(app.view().manualTones.some(tone => tone.id === '@wail'));
    assert.equal(app.view().manualTones.find(tone => tone.id === '@wail').label, 'GTA 原生长鸣');
    assert.equal(app.view().manualTones.find(tone => tone.id === '@horn').label, '消防气喇叭');
    assert.equal(app.view().manualTones.some(tone => tone.id === 'wail'), false);
    app.emit('yx_sirencontrol:menu:visibility', false); app.hold(80); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'fire_q', '@wail']);
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], 'VEHICLES_HORNS_SIREN_1');
    const rules = app.context.YXSirenSettings;
    const repaired = rules.normalize(rules.catalog(packData), { version: 1, manualBindings: {
        builtin: { e: 'removed', r: '@wail' }, fire_q: { e: null, r: 'removed' }
    } }, 'builtin', true);
    assert.equal(repaired.manualBindings.builtin.e, '@horn'); assert.equal(repaired.manualBindings.builtin.r, 'wail');
    assert.equal(repaired.manualBindings.fire_q.e, '@horn'); assert.equal(repaired.manualBindings.fire_q.r, '@wail');
});

test('invalid manual binding actions cannot save a profile or alter shared state', () => {
    const app = boot(); app.ready(); app.open();
    const before = app.view(), count = app.server.length;
    for (const value of ['missing', '@wail', null, true, 4, {}]) app.action('manualBinding', value, 'r');
    for (const key of ['x', 'E', '', null, 4]) app.action('manualBinding', 'wail', key);
    assert.equal(app.kvp.size, 0); assert.equal(app.server.length, count);
    assert.deepEqual(app.view().manualBindings, before.manualBindings);
    app.action('manualBinding', 'yelp', 'r'); assert.equal(app.kvp.size, 1);
    assert.equal(app.server.length, count); assert.equal(app.view().manualBindings.r, 'yelp');
});

test('remote eleven-field states play manual tones from an independent registered pack', () => {
    const app = boot({ vehicle: 0 }); app.ready();
    const custom = packData.find(pack => pack.Id === 'ss2000');
    const manual = custom.Tones.find(tone => tone.Id === 'rumbler_yelp');
    app.synchronized(120, true, 2, 1, true, 'builtin', 'wail', true, false, custom.Id, manual.Id); app.frame();
    const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
    assert.equal(plays().at(-1)[2], manual.SoundName); assert.equal(plays().at(-1)[4], manual.SoundSet);
    assert.ok(app.calls.some(call => call[0] === 'RequestScriptAudioBank' && call[1] === manual.AudioBank));
    const playCount = plays().length, stops = app.calls.filter(call => call[0] === 'StopSound').length;
    app.synchronized(120, true, 2, 1, true, 'fire_q', 'powercall', true, false, custom.Id, manual.Id); app.frame();
    assert.equal(plays().length, playCount); assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops);
    app.synchronized(120, true, 2, 1, true, 'fire_q', 'powercall', true, false, 'builtin', '@horn'); app.frame();
    assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_POLICE_WARNING');
    app.synchronized(120, true, 2, 1, true, 'builtin', 'wail', true, false, 'fire_q', '@wail'); app.frame();
    assert.equal(plays().at(-1)[2], 'VEHICLES_HORNS_SIREN_1');
});

test('a held local R does not repeatedly reclaim priority after another occupant wins with a different manual tone', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 2, 2, false, 'builtin', 'yelp'); app.ready(); app.hold(80); app.frame();
    const requests = () => app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn');
    const count = requests().length;
    app.synchronized(110, true, 2, 2, true, 'builtin', 'yelp', true, false, 'ss2000', 'rumbler_yelp'); app.frame();
    for (let frame = 0; frame < 90; frame++) app.frame(16);
    assert.equal(requests().length, count, 'another player\'s winning tone must not trigger a local resend loop');
    app.synchronized(110, true, 2, 2, true, 'builtin', 'yelp', true, false, 'builtin', 'wail'); app.frame();
    assert.equal(requests().length, count);
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], 'VEHICLES_HORNS_SIREN_1');
    app.hold(); app.frame(); assert.deepEqual(requests().at(-1).slice(2), [false, '', '']);
    app.synchronized(110, true, 2, 2, false, 'builtin', 'yelp'); app.frame();
    assert.equal(app.calls.filter(call => call[0] === 'PlaySoundFromEntity').at(-1)[2], 'VEHICLES_HORNS_SIREN_2');
    assert.equal(app.kvp.size, 0);
});

test('opening and using the menu keeps a held manual tone active until the key is released', () => {
    const app = boot(); app.ready(); app.hold(80); app.frame();
    const requests = () => app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn');
    const requestCount = requests().length;
    assert.equal(app.open(), true);
    for (let frame = 0; frame < 10; frame++) app.frame(16);
    assert.equal(requests().length, requestCount, 'opening the menu must not release or resend a held R tone');
    app.hold(); app.frame();
    assert.deepEqual(requests().at(-1), ['yx_sirencontrol:server:setManualHorn', 110, false, '', '']);
});

test('menu visibility leaves all ELS hotkeys active and never blocks vehicle driving controls', () => {
    const app = boot(); app.ready(); assert.equal(app.open(), true);
    const drivingControls = new Set([59, 71, 72, 76]);
    const disabledSince = start => app.calls.slice(start)
        .filter(call => call[0] === 'DisableControlAction').map(call => call[2]);

    let start = app.calls.length;
    app.hold(86); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'builtin', '@horn']);
    assert.ok(disabledSince(start).includes(86), 'the GTA horn action remains suppressed while E drives the custom tone');
    assert.equal(disabledSince(start).some(control => drivingControls.has(control)), false);

    app.hold(); app.frame();
    app.hold(21, 86); app.press(86); app.frame();
    assert.equal(app.server.at(-1)[0], 'yx_sirencontrol:server:setState');
    assert.equal(app.server.at(-1)[3], 1, 'Shift+E still raises the lighting stage with the menu visible');

    app.hold(); app.press(158); app.frame();
    assert.equal(app.server.at(-1)[3], 2, 'number 2 starts its siren directly from LIGHT with the menu visible');
    assert.equal(app.server.at(-1)[4], 2);

    app.hold(80); app.frame();
    assert.deepEqual(app.server.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, true, 'builtin', 'wail']);
    start = app.calls.length;
    app.hold(21, 85); app.press(85); app.frame();
    assert.equal(app.server.at(-1)[3], 1, 'Shift+Q still lowers the lighting stage with the menu visible');
    assert.equal(disabledSince(start).some(control => drivingControls.has(control)), false);
});

test('exit, rear-seat transfer, death and pause all release the held R request once', () => {
    for (const [name, leave] of [['exit', app => app.drive(0)],
        ['rear seat', app => app.seat(1)], ['death', app => app.die()], ['pause', app => app.pause(true)]]) {
        const app = boot(); app.ready(); app.hold(80); app.frame();
        const count = app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn').length;
        leave(app); app.frame(); app.frame();
        const requests = app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn');
        assert.equal(requests.length, count + 1, name + ' should send exactly one release');
        assert.deepEqual(requests.at(-1), ['yx_sirencontrol:server:setManualHorn', 110, false, '', '']);
    }
});

test('a held E locks its original manual pack until release despite another occupant changing the continuous pack', () => {
    const app = boot({ seat: 0, seats: { '-1': 2 } });
    app.synchronized(110, true, 2, 1, false, 'builtin', 'wail'); app.ready(); app.hold(86); app.frame();
    const requests = () => app.server.filter(call => call[0] === 'yx_sirencontrol:server:setManualHorn');
    const plays = () => app.calls.filter(call => call[0] === 'PlaySoundFromEntity');
    const requestCount = requests().length, playCount = plays().length;
    const stops = app.calls.filter(call => call[0] === 'StopSound').length;
    assert.deepEqual(requests().at(-1).slice(2), [true, 'builtin', '@horn']);
    app.synchronized(110, true, 2, 1, true, 'ss2000', 'wail', true, false, 'builtin', '@horn'); app.frame();
    for (let frame = 0; frame < 60; frame++) app.frame(16);
    assert.equal(requests().length, requestCount, 'changing the shared continuous pack cannot reassert an already-held manual request');
    assert.equal(plays().length, playCount, 'the original held horn must retain its sound handle');
    assert.equal(app.calls.filter(call => call[0] === 'StopSound').length, stops);
    app.hold(); app.frame(); assert.deepEqual(requests().at(-1).slice(2), [false, '', '']);
    app.synchronized(110, true, 2, 1, false, 'ss2000', 'wail'); app.frame();
    app.hold(86); app.frame();
    assert.deepEqual(requests().at(-1).slice(2), [true, 'ss2000', '@horn']);
    assert.equal(plays().at(-1)[2], packData.find(pack => pack.Id === 'ss2000').ManualHorn.SoundName);
});
