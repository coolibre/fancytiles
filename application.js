const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;

const { DefaultColors } = require('./drawing');
const { DragSession } = require('./drag-session');
const { GridEditor } = require('./grid-editor');
const { getUsableScreenArea, snapToRect } = require('./window-utils');
const { LayoutIO } = require('./io-utils');
const { LayoutNode } = require('./node_tree');

// a hardcoded layout for 2x2 layout as default
const LayoutOf2x2 = new LayoutNode(0, [
    new LayoutNode(0.5, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ])
]);

const LayoutOf3x2 = new LayoutNode(0, [
    new LayoutNode(1 / 3, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(2 / 3, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-0.5), new LayoutNode(0)
    ])
]);

const LayoutOf3x3 = new LayoutNode(0, [
    new LayoutNode(1 / 3, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(2 / 3, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ])
]);

const LayoutOf2x3 = new LayoutNode(0, [
    new LayoutNode(0.5, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ]),
    new LayoutNode(0, [
        new LayoutNode(-1 / 3), new LayoutNode(-2 / 3), new LayoutNode(0)
    ])
]);

function getFocusedDisplay() {
    let focusWindow = global.display.focus_window;
    if (!focusWindow) {
        global.logError('No focused window');
        return;
    }

    // Get the display index instead of monitor
    return focusWindow.get_monitor();
}

// hotkey settings that move the focused window to the neighbouring
// region in a direction, as [dx, dy]
const DirectionHotkeys = {
    snapLeftHotkey: [-1, 0],
    snapRightHotkey: [1, 0],
    snapUpHotkey: [0, -1],
    snapDownHotkey: [0, 1],
};

// hotkey settings that move the focused window to region 1..9
const ZoneHotkeys = Array.from({ length: 9 }, (_, i) => `snapZone${i + 1}Hotkey`);

const SnapHotkeySettings = [...Object.keys(DirectionHotkeys), ...ZoneHotkeys];

// find the nearest region from the window in the direction (dx, dy).
// regions that overlap the window on the other axis are preferred, so
// moving left stays in the same row when possible.
function findRegionInDirection(regions, frame, dx, dy) {
    const center = (r) => [r.x + r.width / 2, r.y + r.height / 2];
    const [wx, wy] = center(frame);

    // distance along the direction of travel and across it
    const along = (r) => { const [x, y] = center(r); return (x - wx) * dx + (y - wy) * dy; };
    const across = (r) => { const [x, y] = center(r); return Math.abs((x - wx) * dy + (y - wy) * dx); };
    const overlapsAcross = (r) => dx !== 0
        ? r.y < frame.y + frame.height && r.y + r.height > frame.y
        : r.x < frame.x + frame.width && r.x + r.width > frame.x;

    let candidates = regions.filter(r => along(r) > 1);
    const overlapping = candidates.filter(overlapsAcross);
    if (overlapping.length > 0) candidates = overlapping;

    candidates.sort((a, b) => along(a) - along(b) || across(a) - across(b));
    return candidates[0] || null;
}

function mapModifierSettingToModifierType(modifierSetting) {
    switch(modifierSetting) {
        case 'CTRL':
            return [Clutter.ModifierType.CONTROL_MASK];
        case 'ALT':
            return [Clutter.ModifierType.MOD1_MASK, Clutter.ModifierType.MOD5_MASK];
        case 'SUPER':
            return [Clutter.ModifierType.SUPER_MASK, Clutter.ModifierType.MOD4_MASK];
        case 'SHIFT':
            return [Clutter.ModifierType.SHIFT_MASK];
        default:
            return [];
    }
}

// The application class is only constructed once and is the main entry
// of the extension.
class Application {
    // the active grid editor
    #gridEditor = null;

    // the active drag session, if any (null between drags)
    #dragSession = null;

    #layoutIO;

    // the layout trees for each display
    #layouts = {};

    // the layout trees for each preset
    #presets = null;

    #signals = new SignalManager.SignalManager(null);

    #settings;

    #colors = DefaultColors;

    constructor(uuid) {
        this.#layoutIO = new LayoutIO(uuid);
        this.#connectWindowGrabs();

        this.#settings = new Settings.ExtensionSettings(this, uuid);
        this.#settings.bindProperty(Settings.BindingDirection.IN, 'hotkey', 'hotkey', this.#enableHotkey);
        for (const key of SnapHotkeySettings) {
            this.#settings.bindProperty(Settings.BindingDirection.IN, key, key, this.#enableHotkey);
        }

        this.#loadThemeColors();
        this.#enableHotkey();
    }

    destroy() {
        this.#disableHotkey();
        this.#signals.disconnectAllSignals();
        this.#signals = null;

        if (this.#gridEditor) {
            this.#gridEditor.destroy();
            this.#gridEditor = null;
        }

        if (this.#dragSession) {
            this.#dragSession.finish();
            this.#dragSession = null;
        }
    }

    #loadThemeColors() {
        // hidden element to fetch the styling
        let stylingActor = new St.DrawingArea({
            style_class: 'tile-preview tile-hud',
            visible: false
        });
        global.stage.add_actor(stylingActor);

        let bgColor = stylingActor.get_theme_node().get_background_color();
        if (bgColor) {
            this.#colors.background = {
                r: bgColor.red / 255,
                g: bgColor.green / 255,
                b: bgColor.blue / 255,
                a: bgColor.alpha / 255
            };
        }

        let borderColor = stylingActor.get_theme_node().get_border_color(St.Side.TOP);
        if (borderColor) {
            this.#colors.border = {
                r: borderColor.red / 128,
                g: borderColor.green / 128,
                b: borderColor.blue / 128,
                a: borderColor.alpha / 128
            };
        }

        // add the snap style class to get the highlighted colors
        stylingActor.add_style_class_name('snap');

        let highlightColor = stylingActor.get_theme_node().get_background_color();
        if (highlightColor) {
            this.#colors.highlight = {
                r: highlightColor.red / 255,
                g: highlightColor.green / 255,
                b: highlightColor.blue / 255,
                a: highlightColor.alpha / 255
            };
        }

        stylingActor.remove_style_class_name('snap');

        global.stage.remove_actor(stylingActor);
    }

    #disableHotkey() {
        Main.keybindingManager.removeHotKey('fancytiles');
        for (const key of SnapHotkeySettings) {
            Main.keybindingManager.removeHotKey(`fancytiles-${key}`);
        }
    }

    #enableHotkey() {
        this.#disableHotkey();
        const s = this.#settings.settingsData;
        Main.keybindingManager.addHotKey('fancytiles', s.hotkey.value, this.#toggleEditor.bind(this));

        for (const [key, [dx, dy]] of Object.entries(DirectionHotkeys)) {
            Main.keybindingManager.addHotKey(`fancytiles-${key}`, s[key].value,
                () => this.#snapFocusedWindow((regions, frame) => findRegionInDirection(regions, frame, dx, dy)));
        }

        ZoneHotkeys.forEach((key, idx) => {
            Main.keybindingManager.addHotKey(`fancytiles-${key}`, s[key].value,
                () => this.#snapFocusedWindow((regions) => regions[idx]));
        });
    }

    // snap the focused window to the region picked by selectRegion, which
    // receives the regions of the window's display in reading order
    // (top to bottom, left to right) and the window's frame rect
    #snapFocusedWindow(selectRegion) {
        if (this.#gridEditor) return;

        const window = global.display.focus_window;
        if (!window || window.window_type !== Meta.WindowType.NORMAL) return;

        const displayIdx = window.get_monitor();
        const workArea = getUsableScreenArea(displayIdx);
        if (!workArea) return;

        const layout = this.#readOrCreateLayoutForDisplay(displayIdx);
        layout.calculateRects(workArea.x, workArea.y, workArea.width, workArea.height);
        const regions = layout.findAllNodes(n => n.isLeaf())
            .map(n => n.snapRect())
            .sort((a, b) => a.y - b.y || a.x - b.x);

        const rect = selectRegion(regions, window.get_frame_rect());
        if (!rect) return;

        if (window.get_maximized()) {
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        }
        snapToRect(window, rect);
    }

    #saveLayouts() {
        for (let key in this.#layouts) {
            this.#layoutIO.saveLayoutForDisplay(key, this.#layouts[key]);
        }
        // save user presets
        for (let i = 0; i < 4; i++) {
            this.#layoutIO.saveLayoutForPreset(i, this.#presets[i]);
        }
    }

    #toggleEditor() {
        if (this.#gridEditor) {
            this.#closeEditor();
        } else {
            this.#openEditor();
        }
    }

    #loadPresets() {
        // load all user presets
        let userPresets = [];
        for (let i = 0; i < 4; i++) {
            const preset = this.#layoutIO.loadLayoutForPreset(i) || new LayoutNode(0);
            userPresets.push(preset);
        }

        // load the system preset
        this.#presets = [
            ...userPresets,
            LayoutOf2x2.clone(),
            LayoutOf3x2.clone(),
            LayoutOf2x3.clone(),
            LayoutOf3x3.clone()
        ];
    }

    #openEditor() {
        const displayIdx = getFocusedDisplay();
        if (typeof displayIdx !== 'number') {
            global.logError('No focused display');
            return;
        }

        let layout = this.#readOrCreateLayoutForDisplay(displayIdx);

        if (!this.#presets || this.#presets.length === 0) {
            this.#loadPresets();
        }

        const showGuideLines = this.#settings.settingsData.showGuideLines.value;

        this.#gridEditor = new GridEditor(
            displayIdx,
            layout,
            this.#colors,
            this.#closeEditor.bind(this),
            this.#presets,
            showGuideLines
        );
    }

    #closeEditor() {
        if (this.#gridEditor) {
            this.#gridEditor.destroy();
            this.#gridEditor = null;
            this.#saveLayouts();
        }
    }

    // read the layout from the configuration file, or set the default
    #readOrCreateLayoutForDisplay(displayIdx, defaultLayout = LayoutOf2x2.clone()) {
        if (this.#layouts[displayIdx]) {
            return this.#layouts[displayIdx];
        }

        let tree = this.#layoutIO.loadLayoutForDisplay(displayIdx);
        if (!tree) {
            tree = defaultLayout;
        }
        this.#layouts[displayIdx] = tree;
        return tree;
    }

    #connectWindowGrabs() {
        this.#signals.connect(global.display, 'grab-op-begin',
            (display, screen, window, op) => this.#onGrabBegin(window, op));
        this.#signals.connect(global.display, 'grab-op-end',
            (display, screen, window, op) => this.#onGrabEnd(window, op));
    }

    #onGrabBegin(window, op) {
        if (op !== Meta.GrabOp.MOVING || window.window_type !== Meta.WindowType.NORMAL) return;

        // A grab-begin while a session is alive is our own restart landing.
        if (this.#dragSession) {
            this.#dragSession.onGrabRestart(window);
            return;
        }

        // Fresh drag.
        this.#loadThemeColors();
        this.#dragSession = new DragSession({
            window,
            layoutFor: (i) => this.#readOrCreateLayoutForDisplay(i, LayoutOf2x2.clone()),
            options: this.#snapshotDragOptions(),
        });
    }

    #onGrabEnd(window, op) {
        if (!this.#dragSession) return;
        if (op !== Meta.GrabOp.MOVING || window.window_type !== Meta.WindowType.NORMAL) return;

        if (this.#dragSession.tryRestart()) return;  // session continues

        this.#dragSession.finish();
        this.#dragSession = null;
    }

    #snapshotDragOptions() {
        const s = this.#settings.settingsData;
        return {
            enableSnappingModifiers: mapModifierSettingToModifierType(s.enableSnappingModifiers.value),
            enableMultiSnappingModifiers: mapModifierSettingToModifierType(s.enableMultiSnappingModifiers.value),
            mergeAdjacentOnHover: s.mergeAdjacentOnHover.value,
            mergingRadius: s.mergingRadius.value,
            activateWithNonPrimaryButton: s.activateWithNonPrimaryButton.value,
            autoStartSnapping: s.autoStartSnapping.value,
            overlayColor: s.overlayColor.value,
        };
    }
}

module.exports = { Application, LayoutOf2x2 };
