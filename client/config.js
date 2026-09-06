// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (C) 2026 YuanX1a0

globalThis.YXSirenControlConfig = {
    Command: 'siren',
    MenuCommand: 'sirencontrol',
    MenuKey: 'I',

    Emergency: {
        AutoEnable: true,
        // Class 18 is automatic. Add model spawn names for incorrectly classified add-ons.
        IncludeModels: [],
        ExcludeModels: []
    },

    Persistence: {
        KeyPrefix: 'yx_sirencontrol:v3:',
        // Optional replicated, persistent vehicle ID (e.g. 'vin'). Otherwise model + plate.
        VehicleIdStateKey: '',
        DefaultParkKill: true,
        DefaultPack: 'builtin',
        // Spawn name -> installed siren_pack Id. Players can override this per vehicle.
        ModelPacks: {
            firetruk: 'modern_lafd',
            ambulance: 'modern_lafd'
        }
    },

    Controls: {
        Shift: 21,
        // Vehicle E/Horn and Q/Radio Wheel, plus compatibility fallbacks.
        Up: [86, 38],
        Down: [85, 44],
        Horn: 86,
        // R: vehicle cinematic camera and reload fallback. Both are suppressed while ELS owns the input.
        ManualR: [80, 45],
        Radio: [81, 82, 83, 84, 85],
        SirenModes: [157, 158, 160, 164, 165],
        DebounceMs: 180
    },

    Lights: {
        RenderDistance: 120.0,
        CycleMs: 720,
        RedWindows: [[0, 90], [150, 240]],
        BlueWindows: [[360, 450], [510, 600]],
        Red: { r: 255, g: 18, b: 18 },
        Blue: { r: 18, g: 72, b: 255 },
        Range: 5.5,
        Intensity: 4.0
    },

    // Audio definitions live in config/sirens/*.json, registered by siren_pack in fxmanifest.lua.
    Audio: {
        RenderDistance: 180.0,
        MaxAudibleVehicles: 12,
        // Retry only if the native call itself throws. Its boolean return value is
        // unreliable on current FiveM builds and must not gate playback.
        BankRetryMs: 1000,
        // Give the audio thread a brief moment after the first request, matching
        // established server-sided audio testers while keeping manual tones quick.
        BankRequestDelayMs: 50,
        BankIdleMs: 15000
    },

    Hud: {
        DurationMs: 2400,
        FadeMs: 350,
        X: 0.95,
        Y: 0.745,
        Font: 4,
        Scale: 0.50,
        StatusScale: 0.50,
        LineSpacing: 0.045,
        StatusColor: { r: 255, g: 205, b: 64 }
    },

    Notifications: {
        Prefix: '~o~ELS~s~ | '
    }
};
