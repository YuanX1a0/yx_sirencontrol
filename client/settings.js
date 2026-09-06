// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 YuanX1a0

// Pure registry and persistence rules, shared by the client and the regression tests.
(function (root) {
    'use strict';
    var identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    var resourceFile = /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/)*[A-Za-z0-9][A-Za-z0-9_.-]*$/;
    function soundValid(sound) {
        return sound && typeof sound.SoundName === 'string' && sound.SoundName.length > 0 &&
            (sound.SoundSet == null || typeof sound.SoundSet === 'string') &&
            (sound.AudioBank == null || typeof sound.AudioBank === 'string');
    }
    function validatePack(pack) {
        if (!pack || typeof pack.Id !== 'string' || !identifier.test(pack.Id) || typeof pack.Label !== 'string' || !pack.Label ||
            !Array.isArray(pack.Tones) || !pack.Tones.length || pack.Tones.length > 128) {
            throw new Error('Invalid siren pack identity or tone list');
        }
        if (pack.AudioBanks != null && (!Array.isArray(pack.AudioBanks) ||
            pack.AudioBanks.some(function (bank) { return typeof bank !== 'string' || !bank; }))) {
            throw new Error(pack.Id + ': invalid AudioBanks');
        }
        if (pack.RequiredFile != null && (typeof pack.RequiredFile !== 'string' ||
            pack.RequiredFile.length > 255 || !resourceFile.test(pack.RequiredFile) ||
            pack.RequiredFile.split('/').some(function (part) { return part === '.' || part === '..'; }))) {
            throw new Error(pack.Id + ': invalid RequiredFile');
        }
        var ids = new Set();
        pack.Tones.forEach(function (tone) {
            if (!tone || typeof tone.Id !== 'string' || !identifier.test(tone.Id) || ids.has(tone.Id) || !tone.Label) {
                throw new Error(pack.Id + ': invalid or duplicate tone Id');
            }
            ids.add(tone.Id);
            var type = tone.Type || 'continuous';
            if (['continuous', 'pulse', 'alternate'].indexOf(type) < 0 ||
                (type === 'alternate' ? !Array.isArray(tone.Sounds) || !tone.Sounds.length ||
                    !tone.Sounds.every(soundValid) : !soundValid(tone))) {
                throw new Error(pack.Id + '/' + tone.Id + ': invalid audio definition');
            }
            if ((type === 'pulse' && (!(tone.OnMs >= 50) || !(tone.OffMs >= 30))) ||
                (type === 'alternate' && !(tone.SwitchMs >= 100))) {
                throw new Error(pack.Id + '/' + tone.Id + ': invalid timing');
            }
        });
        if (!Array.isArray(pack.DefaultSlots) || pack.DefaultSlots.length !== 5 ||
            !pack.DefaultSlots.every(function (id) { return ids.has(id); }) ||
            (pack.ManualHorn && !soundValid(pack.ManualHorn))) {
            throw new Error(pack.Id + ': invalid DefaultSlots or ManualHorn');
        }
        return pack;
    }
    function catalog(packs) {
        var byId = new Map();
        packs.forEach(function (pack) {
            validatePack(pack);
            if (byId.has(pack.Id)) { throw new Error('Duplicate siren pack ' + pack.Id); }
            byId.set(pack.Id, pack);
        });
        if (!byId.has('builtin')) { throw new Error('The builtin siren pack is required'); }
        return byId;
    }
    function tone(pack, id) {
        return pack.Tones.find(function (entry) { return entry.Id === id; });
    }
    function manualValid(pack, id) {
        return id === '@horn' || (id === '@wail' && !tone(pack, 'wail')) || Boolean(tone(pack, id));
    }
    function manualOptions(catalogue, pack) {
        var horn = pack.ManualHorn || catalogue.get('builtin').ManualHorn;
        var options = [{ id: '@horn', label: horn.Label || '气喇叭' }];
        pack.Tones.forEach(function (entry) { options.push({ id: entry.Id, label: entry.Label }); });
        if (!tone(pack, 'wail')) { options.push({ id: '@wail', label: 'GTA 原生长鸣' }); }
        return options;
    }
    function beaconOffset(raw) {
        var result = {};
        ['x', 'y', 'z'].forEach(function (axis) {
            var value = raw && raw[axis];
            result[axis] = typeof value === 'number' && Number.isFinite(value)
                ? Math.round(Math.max(-2, Math.min(2, value)) * 100) / 100 : 0;
        });
        return result;
    }
    function normalize(catalogue, raw, defaultPack, defaultParkKill) {
        raw = raw && typeof raw === 'object' && raw.version === 1 ? raw : {};
        var fallback = catalogue.has(defaultPack) ? defaultPack : 'builtin';
        var packId = catalogue.has(raw.packId) ? raw.packId : fallback;
        var bindings = Object.create(null);
        var manualBindings = Object.create(null);
        catalogue.forEach(function (pack, id) {
            var saved = raw.bindings && Object.prototype.hasOwnProperty.call(raw.bindings, id) && raw.bindings[id];
            bindings[id] = pack.DefaultSlots.map(function (defaultId, index) {
                return Array.isArray(saved) && tone(pack, saved[index]) ? saved[index] : defaultId;
            });
            var manual = raw.manualBindings && Object.prototype.hasOwnProperty.call(raw.manualBindings, id) && raw.manualBindings[id];
            manualBindings[id] = {
                e: manual && manualValid(pack, manual.e) ? manual.e : '@horn',
                r: manual && manualValid(pack, manual.r) ? manual.r : (tone(pack, 'wail') ? 'wail' : '@wail')
            };
        });
        return {
            version: 1,
            packId: packId,
            parkKill: typeof raw.parkKill === 'boolean' ? raw.parkKill : defaultParkKill !== false,
            slot: Number.isInteger(raw.slot) && raw.slot >= 1 && raw.slot <= 5 ? raw.slot : 1,
            bindings: bindings,
            manualBindings: manualBindings,
            beaconOffset: beaconOffset(raw.beaconOffset)
        };
    }
    function vehicleKey(server, model, plate, persistentId) {
        var scope = String(server || 'local').trim().toLowerCase();
        var id = persistentId == null ? '' : String(persistentId).trim();
        plate = String(plate || '').trim().toUpperCase();
        // Blank plates without a stable ID must not share a permanent save slot.
        if (!id && !plate) { return null; }
        return JSON.stringify([scope, id ? 'id' : 'plate', id || (Number(model) >>> 0), id ? null : plate]);
    }
    root.YXSirenSettings = { catalog: catalog, validatePack: validatePack, tone: tone, manualValid: manualValid,
        manualOptions: manualOptions, normalize: normalize, vehicleKey: vehicleKey };
}(typeof globalThis !== 'undefined' ? globalThis : this));
