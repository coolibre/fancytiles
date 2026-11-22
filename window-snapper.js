const Clutter = imports.gi.Clutter;
const Main = imports.ui.main;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;

const { snapToRect, getUsableScreenArea } = require('./window-utils');
const { SnappingOperation } = require('./node_tree');

// light orange, used when the color setting cannot be parsed
const DefaultOverlayColor = [255, 179, 102];

// appearance of a region relative to the overlay color
const NormalRegion = { fillAlpha: 0.06, borderAlpha: 0.45, borderWidth: 1 };
const HighlightedRegion = { fillAlpha: 0.18, borderAlpha: 1, borderWidth: 3 };

// parse an "rgb(r,g,b)" or "rgba(r,g,b,a)" color string into [r, g, b]
function parseColor(color) {
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color || '');
    return match ? match.slice(1, 4).map(Number) : DefaultOverlayColor;
}

function regionStyle([r, g, b], { fillAlpha, borderAlpha, borderWidth }) {
    return `background-color: rgba(${r}, ${g}, ${b}, ${fillAlpha});`
        + ` border: ${borderWidth}px solid rgba(${r}, ${g}, ${b}, ${borderAlpha});`;
}

// the WindowSnapper is used to snap a window to the given layout
// when the user is dragging a window to a new position and it
// holds any of the #enableSnappingModifiers keys down the layout region where the mouse is
// hovering over will be highlighted. when the user ends the dragging
// whilst holding any of the #enableSnappingModifiers keys down the window will be snapped
// to the layout region.
//
// The overlay is built from one plain St.Widget per region instead of a
// single full-screen Cairo canvas. The widgets have square corners, so
// St paints them as GPU rectangles: highlighting a region only changes
// its style, without rasterizing anything on the CPU. This keeps the
// overlay fast on very large displays.
class WindowSnapper {
    // UI actor holding the region actors
    #container;

    // [{ node, actor }] for every leaf region of the layout
    #regionActors = [];

    // actor for the merged region when snapping to multiple regions
    #insetActor;

    // styles of a region in the normal and highlighted state
    #normalStyle;
    #highlightStyle;

    // offset of the overlay on the screen
    #origin;

    // the window that is being dragged and needs to be snapped
    #window;

    // the layout to use for the snapping operation
    #layout;

    // the snapping operation
    #snappingOperation;

    // the modifier key to enable snapping
    #enableSnappingModifiers;

    // the modifier key to enable snapping to multiple areas
    #enableMultiSnappingModifiers;

    // whether to merge adjacent regions when hovering over the shared border
    #enableAdjacentMerging;

    // the radius around the mouse position used for merging
    #mergingRadius;

    // whether to use the non-primary button to activate snapping
    #activateWithNonPrimaryButton;

    #signals = new SignalManager.SignalManager(null);

    constructor(displayIdx, layout, window, enableSnappingModifiers, enableMultiSnappingModifiers, enableAdjacentMerging, mergingRadius, activateWithNonPrimaryButton, autoStartSnapping, overlayColor) {
        // the layout to use for the snapping operation
        this.#layout = layout;

        // the window that is being dragged and needs to be snapped
        this.#window = window;

        // the modifier key to enable snapping
        this.#enableSnappingModifiers = enableSnappingModifiers;

        // the modifier key to enable snapping to multiple areas
        this.#enableMultiSnappingModifiers = enableMultiSnappingModifiers;

        // whether to merge adjacent regions when hovering over the shared border
        this.#enableAdjacentMerging = enableAdjacentMerging;

        this.#mergingRadius = mergingRadius;

        // whether to use the non-primary button to activate snapping
        this.#activateWithNonPrimaryButton = activateWithNonPrimaryButton;

        // get the size of the display
        let workArea = getUsableScreenArea(displayIdx);
        this.#origin = { x: workArea.x, y: workArea.y };

        const rgb = parseColor(overlayColor);
        this.#normalStyle = regionStyle(rgb, NormalRegion);
        this.#highlightStyle = regionStyle(rgb, HighlightedRegion);

        // container for the region actors
        this.#container = new St.Widget({
            reactive: false,
            can_focus: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.#container.set_size(workArea.width, workArea.height);
        this.#container.set_position(workArea.x, workArea.y);
        this.#container.hide();

        Main.uiGroup.add_actor(this.#container);

        // ensure the layout is correct for the snap area
        this.#layout.calculateRects(workArea.x, workArea.y, workArea.width, workArea.height);
        this.#snappingOperation = new SnappingOperation(this.#layout, this.#enableSnappingModifiers, this.#enableMultiSnappingModifiers, this.#enableAdjacentMerging, this.#mergingRadius, this.#activateWithNonPrimaryButton, autoStartSnapping);

        // the regions do not change during a drag, so their actors are created once
        for (const node of this.#layout.findAllNodes(n => n.isLeaf())) {
            const actor = this.#createRegionActor();
            this.#placeActor(actor, node.rect, node.margin);
            this.#regionActors.push({ node, actor });
        }
        this.#insetActor = this.#createRegionActor();
        this.#insetActor.set_style(this.#highlightStyle);
        this.#insetActor.hide();

        this.#signals.connect(this.#window, 'position-changed', this.#onWindowMoved.bind(this));
    }

    // Whether snapping is currently enabled for this drag.
    get isSnappingEnabled() {
        return this.#snappingOperation ? this.#snappingOperation.isSnappingEnabled : false;
    }

    // Run an onMotion pass for the current pointer position, show or
    // hide the overlay as needed, and update the regions. Used both for
    // window motion events and for DragSession's activation poller.
    refreshFromPointer() {
        if (!this.#snappingOperation) return;
        const [x, y, state] = global.get_pointer();
        const result = this.#snappingOperation.onMotion(x, y, state);
        if (!(result && result.shouldRedraw)) return;
        if (this.#snappingOperation.showRegions) {
            this.#updateRegions();
            this.#container.show();
        } else {
            this.#container.hide();
        }
    }

    // snap if the user wants to
    finalize() {
        const snappingRect = this.#snappingOperation.currentSnapToRect();
        if (snappingRect) {
            // the user wants to snap, resize the window to the region
            snapToRect(this.#window, snappingRect);
        }

        this.#snappingOperation.cancel();
        this.#snappingOperation = null;
    }

    destroy() {
        this.#signals.disconnectAllSignals();
        this.#signals = null;

        if (this.#snappingOperation) {
            this.#snappingOperation.cancel();
            this.#snappingOperation = null;
        }

        Main.uiGroup.remove_actor(this.#container);
        this.#container.destroy();
        this.#container = null;
        this.#regionActors = [];
        this.#insetActor = null;
        this.#layout = null;
    }

    #createRegionActor() {
        const actor = new St.Widget({ reactive: false, can_focus: false, style: this.#normalStyle });
        this.#container.add_actor(actor);
        return actor;
    }

    // position an actor at a screen rect, shrunk by the region margin
    #placeActor(actor, rect, margin) {
        actor.set_position(rect.x - this.#origin.x + margin, rect.y - this.#origin.y + margin);
        actor.set_size(Math.max(0, rect.width - margin * 2), Math.max(0, rect.height - margin * 2));
    }

    // sync the region actors with the highlight state of the layout
    #updateRegions() {
        const inset = this.#snappingOperation.tree.insetNode;

        for (const { node, actor } of this.#regionActors) {
            actor.set_style(node.isHighlighted ? this.#highlightStyle : this.#normalStyle);
            // regions merged into the inset region are covered by it
            actor.visible = !(inset && node.isSnappingDestination);
        }

        if (inset && inset.rect) {
            this.#placeActor(this.#insetActor, inset.rect, inset.margin);
            this.#insetActor.show();
        } else {
            this.#insetActor.hide();
        }
    }

    // position-changed signal handler on the dragged window.
    #onWindowMoved() {
        this.refreshFromPointer();
    }
}

module.exports = { WindowSnapper };
