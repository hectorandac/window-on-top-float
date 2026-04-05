import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const ICON_SIZE = 16;
const BUTTON_PADDING = 6;
const CORNER_OFFSET_X = 0;
const ABOVE_GAP = 4;
const POLL_INTERVAL_MS = 80;

const SHOW_RADIUS = 120;
const HIDE_RADIUS = 180;

const FADE_IN_MS = 180;
const FADE_OUT_MS = 250;

const STYLE_DARK =
    'background-color: rgba(40, 40, 40, 0.85);' +
    'border: 1px solid rgba(255, 255, 255, 0.12);' +
    'box-shadow: 0 1px 3px rgba(0,0,0,0.4);';

const STYLE_LIGHT =
    'background-color: rgba(255, 255, 255, 0.92);' +
    'border: 1px solid rgba(0, 0, 0, 0.15);' +
    'box-shadow: 0 1px 3px rgba(0,0,0,0.18);';

// Per-window state managed by the extension
class WindowWidget {
    constructor(ext, win) {
        this._ext = ext;
        this._win = win;
        this._isShown = false;
        this._signals = [];

        const btnDiameter = ICON_SIZE + BUTTON_PADDING * 2;

        this._topIcon = ext._createIcon(`${ext.path}/icons/top-symbolic.svg`);
        this._defaultIcon = ext._createIcon(`${ext.path}/icons/default-symbolic.svg`);

        this._button = new St.Bin({
            reactive: true,
            can_focus: false,
            track_hover: true,
            opacity: 0,
            visible: false,
            width: btnDiameter,
            height: btnDiameter,
        });
        this._button.set_pivot_point(0.5, 0.5);

        this._button.connect('button-press-event', () => {
            this._toggleOnTop();
            return Clutter.EVENT_STOP;
        });
        this._button.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                this._toggleOnTop();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._button.connect('enter-event', () => {
            if (!this._isShown) return;
            this._button.ease({ opacity: 255, duration: 100, mode: Clutter.AnimationMode.LINEAR });
        });
        this._button.connect('leave-event', () => {
            if (!this._isShown) return;
            const pinVis = this._isPinnedVisible();
            this._button.ease({ opacity: pinVis ? 160 : 200, duration: 100, mode: Clutter.AnimationMode.LINEAR });
        });

        Main.layoutManager.addTopChrome(this._button);

        this._connectWindow();
        this.applyStyle();
        this._updateIcon();
        this._updatePosition();
    }

    _connectWindow() {
        const w = this._win;
        this._signals = [
            { id: w.connect('position-changed', () => this._updatePosition()) },
            { id: w.connect('size-changed', () => this._updatePosition()) },
            { id: w.connect('notify::above', () => { this._updateIcon(); this._ext._onWindowPinChanged(this); }) },
            { id: w.connect('notify::minimized', () => this._updatePosition()) },
        ];
    }

    _disconnectWindow() {
        for (const s of this._signals) {
            try { this._win.disconnect(s.id); } catch (_e) { /* ok */ }
        }
        this._signals = [];
    }

    destroy() {
        this._disconnectWindow();
        if (this._button) {
            this.hide(true);
            Main.layoutManager.removeChrome(this._button);
            this._button.destroy();
            this._button = null;
        }
        this._topIcon = null;
        this._defaultIcon = null;
    }

    get window() { return this._win; }

    applyStyle() {
        if (!this._button) return;
        const dark = this._ext._isDarkTheme();
        const btnDiameter = ICON_SIZE + BUTTON_PADDING * 2;
        const base = `border-radius: ${btnDiameter}px; padding: ${BUTTON_PADDING}px;`;
        this._button.set_style(base + (dark ? STYLE_DARK : STYLE_LIGHT));

        const iconColor = dark ? 'color: rgba(255,255,255,0.9);' : 'color: rgba(0,0,0,0.8);';
        this._topIcon?.set_style(iconColor);
        this._defaultIcon?.set_style(iconColor);
    }

    _toggleOnTop() {
        const w = this._win;
        w.is_above() ? w.unmake_above() : w.make_above();
        this._updateIcon();
    }

    _updateIcon() {
        if (!this._button) return;
        this._button.set_child(this._win.is_above() ? this._topIcon : this._defaultIcon);
    }

    getTargetPosition() {
        const win = this._win;
        if (!win) return null;
        if (win.get_maximized() === Meta.MaximizeFlags.BOTH) return null;
        if (win.minimized) return null;

        const rect = win.get_frame_rect();
        const btnSize = ICON_SIZE + BUTTON_PADDING * 2;
        const side = this._ext._settings?.get_string('icon-position') ?? 'left';

        let x;
        if (side === 'right')
            x = rect.x + rect.width - CORNER_OFFSET_X - btnSize;
        else
            x = rect.x + CORNER_OFFSET_X;

        const y = rect.y - btnSize - ABOVE_GAP;
        return { x, y };
    }

    _updatePosition() {
        const pos = this.getTargetPosition();
        if (!pos) { this.hide(); return; }
        this._button.set_position(pos.x, pos.y);
    }

    _isPinnedVisible() {
        const keepVisible = this._ext._settings?.get_boolean('keep-visible-when-pinned') ?? true;
        return keepVisible && this._win.is_above();
    }

    checkProximity(mx, my) {
        const pos = this.getTargetPosition();
        if (!pos) {
            if (this._isShown) this.hide();
            return;
        }

        const halfSize = (ICON_SIZE + BUTTON_PADDING * 2) / 2;
        const dx = mx - (pos.x + halfSize);
        const dy = my - (pos.y + halfSize);
        const dist = Math.sqrt(dx * dx + dy * dy);

        const pinVis = this._isPinnedVisible();

        if (!this._isShown && (dist <= SHOW_RADIUS || pinVis)) {
            this.show(pinVis);
        } else if (this._isShown && !pinVis && dist > HIDE_RADIUS && !this._button.hover) {
            this.hide();
        }
    }

    show(pinnedVisible = false) {
        if (this._isShown) return;
        this._isShown = true;
        this._updatePosition();

        this._button.remove_all_transitions();
        this._button.visible = true;
        this._button.ease({
            opacity: pinnedVisible ? 160 : 200,
            duration: FADE_IN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    hide(instant = false) {
        if (!this._isShown && !instant) return;
        this._isShown = false;
        if (!this._button) return;

        if (instant) {
            this._button.opacity = 0;
            this._button.visible = false;
            return;
        }

        this._button.remove_all_transitions();
        this._button.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                if (!this._isShown && this._button)
                    this._button.visible = false;
            },
        });
    }
}

// ── Main extension ──────────────────────────────────────────────────
export default class WindowOnTopFloatExtension extends Extension {
    enable() {
        this._widgets = new Map();  // Meta.Window → WindowWidget
        this._pollTimerId = 0;
        this._overviewShowing = false;

        // ── Settings ────────────────────────────────────────────────
        this._settings = this.getSettings('org.gnome.shell.extensions.window-on-top');
        this._settingsChangedId = this._settings.connect('changed', () => {
            for (const w of this._widgets.values()) {
                w._updatePosition();
                w.applyStyle();
            }
        });

        // ── Theme tracking ──────────────────────────────────────────
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._colorSchemeId = this._interfaceSettings.connect('changed::color-scheme', () => this._applyStyleAll());
        this._gtkThemeId = this._interfaceSettings.connect('changed::gtk-theme', () => this._applyStyleAll());

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeChangedId = this._themeContext.connect('changed', () => this._applyStyleAll());

        // ── Overview (spotlight) visibility ──────────────────────────
        this._overviewShowingId = Main.overview.connect('showing', () => {
            this._overviewShowing = true;
            this._hideAll();
        });
        this._overviewHiddenId = Main.overview.connect('hidden', () => {
            this._overviewShowing = false;
        });

        // ── Track all windows ───────────────────────────────────────
        this._windowCreatedId = global.display.connect('window-created', (_d, win) => {
            this._onWindowAdded(win);
        });

        // Seed with existing windows
        for (const actor of global.get_window_actors()) {
            this._onWindowAdded(actor.meta_window);
        }

        // Track focus changes to add widgets for focused non-tracked windows
        Shell.WindowTracker.get_default().connectObject(
            'notify::focus-app', () => this._ensureFocusedWidget(), this
        );
        global.window_manager.connectObject(
            'switch-workspace', () => this._syncWorkspaceWindows(), this
        );

        // ── Proximity polling ───────────────────────────────────────
        this._pollTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
                this._pollAll();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;

        if (this._themeContext && this._themeChangedId) {
            this._themeContext.disconnect(this._themeChangedId);
            this._themeChangedId = null;
        }
        this._themeContext = null;

        if (this._interfaceSettings) {
            if (this._colorSchemeId) this._interfaceSettings.disconnect(this._colorSchemeId);
            if (this._gtkThemeId) this._interfaceSettings.disconnect(this._gtkThemeId);
            this._colorSchemeId = null;
            this._gtkThemeId = null;
        }
        this._interfaceSettings = null;

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = null;
        }

        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }

        global.window_manager.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);

        for (const widget of this._widgets.values())
            widget.destroy();
        this._widgets.clear();
    }

    // ── Public helpers used by WindowWidget ──────────────────────────

    _createIcon(giconPath) {
        return new St.Icon({
            gicon: Gio.icon_new_for_string(giconPath),
            icon_size: ICON_SIZE,
        });
    }

    _isDarkTheme() {
        try {
            const scheme = this._interfaceSettings?.get_string('color-scheme') ?? '';
            if (scheme === 'prefer-dark') return true;
            if (scheme === 'prefer-light') return false;
            const gtkTheme = this._interfaceSettings?.get_string('gtk-theme') ?? '';
            if (gtkTheme.toLowerCase().includes('dark')) return true;
            if (gtkTheme.length > 0) return false;
        } catch (_e) { /* fallback */ }
        return true;
    }

    _applyStyleAll() {
        for (const w of this._widgets.values())
            w.applyStyle();
    }

    // ── Window lifecycle ────────────────────────────────────────────

    _shouldTrack(win) {
        if (!win) return false;
        const type = win.get_window_type();
        return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG;
    }

    _onWindowAdded(win) {
        if (!this._shouldTrack(win)) return;
        if (this._widgets.has(win)) return;

        const widget = new WindowWidget(this, win);
        this._widgets.set(win, widget);

        // Watch for the window being destroyed/closed
        const unmanagedId = win.connect('unmanaged', () => {
            this._removeWidget(win);
        });
        widget._unmanagedId = unmanagedId;
    }

    _removeWidget(win) {
        const widget = this._widgets.get(win);
        if (!widget) return;
        try { win.disconnect(widget._unmanagedId); } catch (_e) { /* ok */ }
        widget.destroy();
        this._widgets.delete(win);
    }

    _ensureFocusedWidget() {
        const win = global.display.focus_window;
        if (win && this._shouldTrack(win) && !this._widgets.has(win))
            this._onWindowAdded(win);
    }

    _syncWorkspaceWindows() {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (this._shouldTrack(win) && !this._widgets.has(win))
                this._onWindowAdded(win);
        }
    }

    // ── Called by WindowWidget when pin state changes ────────────────

    _onWindowPinChanged(widget) {
        const win = widget.window;
        if (!win.is_above()) {
            // Unpinned — hide immediately
            widget.hide();
        } else {
            // Just pinned — show if keep-visible is on
            const keepVisible = this._settings?.get_boolean('keep-visible-when-pinned') ?? true;
            if (keepVisible) widget.show(true);
        }
    }

    // ── Polling ─────────────────────────────────────────────────────

    _hideAll() {
        for (const w of this._widgets.values())
            w.hide();
    }

    _pollAll() {
        if (this._overviewShowing) return;

        const [mx, my] = global.get_pointer();
        const activeWs = global.workspace_manager.get_active_workspace();

        // Collect visible windows on current workspace, sorted by stacking
        // (sort_windows_by_stacking returns bottom → top order)
        const visibleWindows = [];
        for (const actor of global.get_window_actors()) {
            const mw = actor.meta_window;
            if (!mw || mw.minimized) continue;
            if (mw.get_workspace() !== activeWs) continue;
            visibleWindows.push(mw);
        }
        const sorted = global.display.sort_windows_by_stacking(visibleWindows);
        const stackIndex = new Map();
        for (let i = 0; i < sorted.length; i++)
            stackIndex.set(sorted[i], i);

        for (const [win, widget] of this._widgets) {
            // Only show widgets for windows on the current workspace
            if (win.get_workspace() !== activeWs || win.minimized) {
                if (widget._isShown) widget.hide();
                continue;
            }

            // Occlusion: hide the button when ANY higher-stacked window
            // covers either the button itself or the top-edge of the
            // parent window where the button visually attaches.
            const pos = widget.getTargetPosition();
            if (pos) {
                const btnSize = ICON_SIZE + BUTTON_PADDING * 2;
                const btnCx = pos.x + btnSize / 2;
                const btnCy = pos.y + btnSize / 2;
                const frameRect = win.get_frame_rect();
                const attachX = btnCx;
                const attachY = frameRect.y + 2;
                const myIdx = stackIndex.get(win) ?? -1;
                let occluded = false;

                for (let i = myIdx + 1; i < sorted.length; i++) {
                    const other = sorted[i];
                    const r = other.get_frame_rect();
                    const coversBtn = btnCx >= r.x && btnCx <= r.x + r.width &&
                                      btnCy >= r.y && btnCy <= r.y + r.height;
                    const coversAttach = attachX >= r.x && attachX <= r.x + r.width &&
                                         attachY >= r.y && attachY <= r.y + r.height;
                    if (coversBtn || coversAttach) {
                        occluded = true;
                        break;
                    }
                }

                if (occluded) {
                    if (widget._isShown) widget.hide();
                    continue;
                }
            }

            widget.checkProximity(mx, my);
        }
    }
}
