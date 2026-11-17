/* Mac Wave Dock Extension
   GNOME Shell 45+ (ESM)
   macOS-style compact dock with wave magnification, minimize/maximize to dock,
   trash bin with system icon theme, native DND app reordering,
   drag-and-drop from App Grid to Dock, fullscreen auto-hide, and custom styling.
*/

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { PointerTracker } from './pointerTracker.js';

function getAppIcon(app, size = 40) {
    if (app && typeof app.create_icon_texture === 'function') {
        try {
            const texture = app.create_icon_texture(size);
            if (texture)
                return texture;
        } catch (e) {
            // ignore
        }
    }

    try {
        const icon = (typeof app.get_icon === 'function') ? app.get_icon() : null;
        if (icon) {
            return new St.Icon({
                gicon: icon,
                icon_size: size,
            });
        }
    } catch (e) {
        // Fallback
    }

    return new St.Icon({
        icon_name: 'application-x-executable',
        icon_size: size,
    });
}

function getAppFromSource(source) {
    if (!source)
        return null;
    if (source.app)
        return source.app;
    if (source._app)
        return source._app;
    if (typeof source.getApp === 'function')
        return source.getApp();
    if (source.id)
        return Shell.AppSystem.get_default().lookup_app(source.id);
    return null;
}

function updateWindowGeometryForApp(app, item) {
    if (!app || !item)
        return;

    const windows = app.get_windows();
    if (windows.length === 0)
        return;

    try {
        const [itemX, itemY] = item.get_transformed_position();
        const [itemW, itemH] = item.get_transformed_size();

        const rect = new Mtk.Rectangle();
        rect.x = Math.round(itemX);
        rect.y = Math.round(itemY);
        rect.width = Math.round(itemW);
        rect.height = Math.round(itemH);

        for (const win of windows) {
            try {
                win.set_icon_geometry(rect);
            } catch (e) {
                // ignore
            }
        }
    } catch (err) {
        // ignore
    }
}

function handleAppClick(app, item) {
    if (!app)
        return;

    const windows = app.get_windows();
    if (windows.length === 0) {
        // App is not running: launch it
        app.activate();
        return;
    }

    // Ensure Mutter knows the exact dock icon coordinates for minimize/restore animations
    updateWindowGeometryForApp(app, item);

    const focusWindow = global.display.get_focus_window();
    const isAppFocused = windows.some(w => w === focusWindow);

    if (isAppFocused) {
        // App is focused: minimize directly towards the dock icon!
        focusWindow.minimize();
    } else {
        // App is not focused: bring most recent window to front and unminimize
        let targetWin = windows.find(w => !w.minimized) || windows[0];
        if (targetWin.minimized) {
            targetWin.unminimize();
        }
        Main.activateWindow(targetWin);
    }
}

export default class MacWaveDockExtension extends Extension {
    enable() {
        try {
            this.enableUnredirect = global.compositor.enable_unredirect;
            global.compositor.disable_unredirect();
        } catch (e) {
            console.warn('[MacWaveDock] Could not disable unredirect:', e);
        }

        this._settings = this.getSettings();
        this._items = [];
        this._contextMenu = null;
        this._blurEffect = null;

        // Auto-hide in fullscreen & maximized windows state (Zen / PointerTracker)
        this._isDockHidden = false;
        this._userForced = false;
        this._waitingForEdgeHit = false;
        this._edgeTracker = null;
        this._dockTracker = null;
        this._hideDebounceId = 0;
        this._checkDebounceId = 0;
        this._focusWin = null;

        // Menu manager to handle click-outside closing
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        // Volume Monitor for mounted drives / removable media
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._volumeMonitor.connectObject(
            'mount-added', () => this._buildDock(),
            'mount-removed', () => this._buildDock(),
            'mount-changed', () => this._buildDock(),
            'volume-added', () => this._buildDock(),
            'volume-removed', () => this._buildDock(),
            'drive-connected', () => this._buildDock(),
            'drive-disconnected', () => this._buildDock(),
            this
        );

        // Base settings
        this._iconSize = this._settings.get_int('icon-size') || 40;
        this._maxScale = this._settings.get_double('magnification-scale') || 1.45;
        this._waveRadius = this._settings.get_int('wave-radius') || 130;

        // The floating dock box
        this._dockBox = new St.BoxLayout({
            name: 'mac-wave-dock-box',
            style_class: 'wave-dock-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: false,
        });

        // Set DND delegate so the dock receives dropped apps from App Grid & dock reorders
        this._dockBox._delegate = this;

        // macOS Floating Tooltip
        this._tooltip = new St.Label({
            style_class: 'wave-dock-tooltip',
            visible: false,
            opacity: 0,
        });

        // Add dock and tooltip directly to Chrome
        Main.layoutManager.addTopChrome(this._dockBox, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        Main.layoutManager.addTopChrome(this._tooltip, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        // Dock leave resets wave magnification and hides tooltip
        this._dockBox.connect('leave-event', () => {
            if (!this._dockBox)
                return Clutter.EVENT_PROPAGATE;
            this._resetWaveEffect();
            this._hideTooltip();
            return Clutter.EVENT_PROPAGATE;
        });

        // Replace native overview dash
        if (this._settings.get_boolean('hide-overview-dash')) {
            Main.overview.dash.visible = false;
        }

        // Overview visibility listener
        Main.overview.connectObject(
            'showing', () => {
                if (this._settings.get_boolean('hide-overview-dash'))
                    Main.overview.dash.visible = false;
                this._scheduleCheck();
            },
            'hiding', () => {
                this._scheduleCheck();
            },
            this
        );

        // Dock background right-click (open settings)
        this._dockBox.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3 && event.get_source() === this._dockBox) {
                this._showDockSettingsMenu(this._dockBox);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Fluid wave animation on hover
        this._dockBox.connect('motion-event', (actor, event) => {
            const [stageX] = event.get_coords();
            this._applyWaveEffect(stageX);
            return Clutter.EVENT_PROPAGATE;
        });

        // Dynamic recentering when width changes (e.g. app launched or closed)
        this._dockBox.connect('notify::width', () => this._updatePosition());

        // Monitor & layout updates
        Main.layoutManager.connectObject(
            'monitors-changed', () => {
                this._updatePosition();
                this._scheduleCheck();
            },
            this
        );

        // Favorites changed
        AppFavorites.getAppFavorites().connectObject(
            'changed', () => this._buildDock(),
            this
        );

        // Running applications changed
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', () => this._buildDock(),
            this
        );

        // Window state, focus & fullscreen changes
        global.display.connectObject(
            'in-fullscreen-changed', () => this._scheduleCheck(),
            'notify::focus-window', () => {
                this._updateRunningDots();
                this._updateAllWindowGeometries();
                this._trackFocusWindow();
            },
            'window-created', () => this._scheduleCheck(),
            'restacked', () => this._scheduleCheck(),
            this
        );

        global.window_manager.connectObject(
            'size-changed', () => this._scheduleCheck(),
            'minimize', () => this._scheduleCheck(),
            'unminimize', () => this._scheduleCheck(),
            'destroy', () => this._scheduleCheck(),
            'map', () => this._scheduleCheck(),
            this
        );

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._scheduleCheck(),
            this
        );

        // Listen to system color-scheme changes for auto dark/light theme
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._interfaceSettings.connectObject(
            'changed::color-scheme', () => this._updateDockTheme(),
            this
        );
        try {
            St.Settings.get().connectObject(
                'notify::color-scheme', () => this._updateDockTheme(),
                this
            );
        } catch (e) {
            // ignore
        }

        // Settings changes
        this._settings.connectObject(
            'changed::icon-size', () => {
                this._iconSize = this._settings.get_int('icon-size') || 40;
                this._buildDock();
            },
            'changed::magnification-scale', () => {
                this._maxScale = this._settings.get_double('magnification-scale') || 1.45;
            },
            'changed::wave-radius', () => {
                this._waveRadius = this._settings.get_int('wave-radius') || 130;
            },
            'changed::show-trash', () => {
                this._buildDock();
            },
            'changed::show-running', () => {
                this._buildDock();
            },
            'changed::show-apps-drawer', () => {
                this._buildDock();
            },
            'changed::show-mounts', () => {
                this._buildDock();
            },
            'changed::dock-bottom-margin', () => {
                this._updatePosition();
            },
            'changed::dock-padding', () => {
                this._updateDockTheme();
            },
            'changed::dock-border-radius', () => {
                this._updateDockTheme();
            },
            'changed::dock-color', () => {
                this._updateDockTheme();
                this._updateRunningDots();
            },
            'changed::dock-custom-color', () => {
                this._updateDockTheme();
            },
            'changed::dock-opacity', () => {
                this._updateDockTheme();
            },
            'changed::dock-border-opacity', () => {
                this._updateDockTheme();
            },
            'changed::dock-blur', () => {
                this._applyBlur();
            },
            'changed::dock-blur-radius', () => {
                this._applyBlur();
            },
            'changed::hide-overview-dash', () => {
                const hideDash = this._settings.get_boolean('hide-overview-dash');
                Main.overview.dash.visible = !hideDash;
            },
            'changed::autohide-in-fullscreen', () => {
                this._scheduleCheck();
            },
            this
        );

        this._applyBlur();
        this._buildDock();
        this._trackFocusWindow();
    }

    // --- FULLSCREEN & MAXIMIZED AUTO-HIDE LOGIC (Zen / PointerTracker) ---
    _scheduleCheck() {
        if (this._checkDebounceId) {
            GLib.source_remove(this._checkDebounceId);
        }
        this._checkDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._checkDebounceId = 0;
            this._checkAutoHide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _trackFocusWindow() {
        if (this._focusWin) {
            this._focusWin.disconnectObject(this);
            this._focusWin = null;
        }

        const win = global.display.focus_window;
        if (!win || win.is_skip_taskbar()) {
            this._scheduleCheck();
            return;
        }

        this._focusWin = win;
        this._focusWin.connectObject(
            'position-changed', () => this._scheduleCheck(),
            'size-changed', () => this._scheduleCheck(),
            'unmanaged', () => {
                this._focusWin = null;
                this._scheduleCheck();
            },
            this
        );

        this._scheduleCheck();
    }

    _isWindowMaximizedOrFullscreen(win, monitor) {
        if (!win || win.get_monitor() !== monitor.index)
            return false;
        if (win.is_hidden() || win.minimized)
            return false;
        if (win.is_skip_taskbar())
            return false;

        // Fullscreen
        if (win.fullscreen || (typeof win.is_fullscreen === 'function' && win.is_fullscreen()))
            return true;

        // Maximized (both horizontally & vertically, or vertically tiled)
        if ((typeof win.is_maximized === 'function' && win.is_maximized()) ||
            win.maximized_vertically ||
            (win.maximized_horizontally && win.maximized_vertically)) {
            return true;
        }

        // Overlapping dock resting area
        const frameRect = win.get_frame_rect();
        if (frameRect && this._dockBox) {
            const bottomMargin = this._settings?.get_int('dock-bottom-margin') ?? 8;
            const dockH = this._dockBox.height || 64;
            const dockW = this._dockBox.width || 300;
            const dockX = this._dockBox.x;
            const dockY = monitor.y + monitor.height - dockH - bottomMargin;

            const overlaps = !(
                frameRect.x + frameRect.width <= dockX ||
                frameRect.x >= dockX + dockW ||
                frameRect.y + frameRect.height <= dockY ||
                frameRect.y >= dockY + dockH + bottomMargin
            );

            if (overlaps)
                return true;
        }

        return false;
    }

    _shouldAutoHide() {
        if (!this._settings || !this._settings.get_boolean('autohide-in-fullscreen'))
            return false;

        if (Main.overview.visible)
            return false;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        // 1. Primary monitor in fullscreen mode
        if (typeof monitor.inFullscreen === 'boolean' && monitor.inFullscreen)
            return true;

        if (typeof global.display.get_monitor_in_fullscreen === 'function') {
            if (global.display.get_monitor_in_fullscreen(monitor.index))
                return true;
        }

        // 2. Focused window on primary monitor
        const focusWin = global.display.focus_window;
        if (focusWin && this._isWindowMaximizedOrFullscreen(focusWin, monitor))
            return true;

        // 3. Any visible window on current active workspace on primary monitor
        const workspace = global.workspace_manager.get_active_workspace();
        if (workspace) {
            const windows = workspace.list_windows();
            for (const win of windows) {
                if (this._isWindowMaximizedOrFullscreen(win, monitor))
                    return true;
            }
        }

        return false;
    }

    _checkAutoHide() {
        if (!this._dockBox || !this._settings)
            return;

        const autohide = this._settings.get_boolean('autohide-in-fullscreen');
        if (!autohide || Main.overview.visible) {
            this._userForced = false;
            this._stopPointerWatch();
            this._teardownEdgeTracker();
            this._showDockAnimated();
            return;
        }

        if (this._shouldAutoHide()) {
            if (this._userForced)
                return;
            this._hideDockAnimated();
            this._setupEdgeTracker();
        } else {
            this._userForced = false;
            this._stopPointerWatch();
            this._showDockAnimated();
            this._teardownEdgeTracker();
        }
    }

    _setupEdgeTracker() {
        if (this._edgeTracker)
            return;

        this._edgeTracker = new PointerTracker(60, (x, y) => {
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return;

            const distFromBottom = (monitor.y + monitor.height) - y;
            // Within 2px of the bottom edge -> reveal dock
            if (distFromBottom <= 2 && !this._waitingForEdgeHit) {
                this._waitingForEdgeHit = true;
                this._onEdgeHit();

                if (this._edgeDebounceId) {
                    GLib.source_remove(this._edgeDebounceId);
                }
                this._edgeDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._edgeDebounceId = 0;
                    this._waitingForEdgeHit = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _teardownEdgeTracker() {
        if (this._edgeTracker) {
            this._edgeTracker.destroy();
            this._edgeTracker = null;
        }
        if (this._edgeDebounceId) {
            GLib.source_remove(this._edgeDebounceId);
            this._edgeDebounceId = 0;
        }
        this._waitingForEdgeHit = false;
    }

    _onEdgeHit() {
        this._teardownEdgeTracker();
        this._userForced = true;
        this._showDockAnimated();
        this._startPointerWatch();
    }

    _startPointerWatch() {
        if (this._dockTracker)
            return;

        this._dockTracker = new PointerTracker(60, (x, y) => {
            this._onPointerMove(x, y);
        });
    }

    _stopPointerWatch() {
        if (this._dockTracker) {
            this._dockTracker.destroy();
            this._dockTracker = null;
        }
        this._clearHideDebounce();
    }

    _onPointerMove(x, y) {
        if (this._isDockHidden) {
            this._stopPointerWatch();
            return;
        }

        if (this._isAnyMenuOpen()) {
            this._clearHideDebounce();
            return;
        }

        if (this._isMouseInDockArea(x, y)) {
            this._clearHideDebounce();
        } else {
            this._startHideDebounce();
        }
    }

    _startHideDebounce() {
        if (this._hideDebounceId)
            return;

        this._hideDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._hideDebounceId = 0;

            if (this._isMouseInDockArea() || this._isAnyMenuOpen()) {
                return GLib.SOURCE_REMOVE;
            }

            this._userForced = false;
            this._hideDockAnimated();
            this._stopPointerWatch();
            this._setupEdgeTracker();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHideDebounce() {
        if (this._hideDebounceId) {
            GLib.source_remove(this._hideDebounceId);
            this._hideDebounceId = 0;
        }
    }

    _isMouseInDockArea(optX, optY) {
        const [curX, curY] = (optX !== undefined && optY !== undefined)
            ? [optX, optY]
            : global.get_pointer();

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._dockBox)
            return false;

        const bottomMargin = this._settings?.get_int('dock-bottom-margin') ?? 8;
        const dockX = this._dockBox.x || (monitor.x + Math.round((monitor.width - this._dockBox.width) / 2));
        const dockY = this._dockBox.y || (monitor.y + monitor.height - this._dockBox.height - bottomMargin);
        const dockW = this._dockBox.width || 300;
        const dockH = this._dockBox.height || 64;

        const MARGIN_X = 30;
        const MARGIN_TOP = 25;

        return (
            curX >= (dockX - MARGIN_X) &&
            curX <= (dockX + dockW + MARGIN_X) &&
            curY >= (dockY - MARGIN_TOP) &&
            curY <= (monitor.y + monitor.height)
        );
    }

    _isAnyMenuOpen() {
        return Boolean(this._contextMenu && this._contextMenu.isOpen);
    }

    _clearItemsHover() {
        if (global.stage.key_focus && this._dockBox && this._dockBox.contains(global.stage.key_focus)) {
            global.stage.key_focus = null;
        }
        if (this._items) {
            for (const item of this._items) {
                try {
                    item.hover = false;
                } catch (e) {
                    // ignore
                }
            }
        }
        if (this._dockBox) {
            try {
                this._dockBox.hover = false;
            } catch (e) {
                // ignore
            }
        }
    }

    _hideDockAnimated() {
        if (!this._dockBox || this._isDockHidden)
            return;

        this._isDockHidden = true;
        this._hideTooltip();
        this._resetWaveEffect();
        this._clearItemsHover();

        const bottomMargin = this._settings?.get_int('dock-bottom-margin') ?? 8;
        const hideOffset = (this._dockBox.height || 64) + bottomMargin + 25;

        this._dockBox.remove_all_transitions();
        this._dockBox.ease({
            translation_y: hideOffset,
            opacity: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    _showDockAnimated() {
        if (!this._dockBox)
            return;

        this._clearHideDebounce();
        this._isDockHidden = false;

        this._dockBox.remove_all_transitions();
        this._dockBox.ease({
            translation_y: 0,
            opacity: 255,
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // --- DND DROP TARGET INTERFACE ---
    handleDragOver(source, _actor, _x, _y, _time) {
        const app = getAppFromSource(source);
        if (!app || app.is_window_backed())
            return DND.DragMotionResult.NO_DROP;

        const id = app.get_id();
        if (!id)
            return DND.DragMotionResult.NO_DROP;

        const favManager = AppFavorites.getAppFavorites();
        return favManager.isFavorite(id)
            ? DND.DragMotionResult.MOVE_DROP
            : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, _actor, x, _y, _time) {
        const app = getAppFromSource(source);
        if (!app || app.is_window_backed())
            return false;

        const id = app.get_id();
        if (!id)
            return false;

        const favManager = AppFavorites.getAppFavorites();
        const favorites = favManager.getFavorites();
        const isFav = favManager.isFavorite(id);

        // Calculate drop slot index among favorite apps
        let targetPos = favorites.length;
        const pinnedItems = this._items.filter(it => it._isPinned && it._app);
        for (let i = 0; i < pinnedItems.length; i++) {
            const item = pinnedItems[i];
            const [itemX] = item.get_transformed_position();
            const [dockX] = this._dockBox.get_transformed_position();
            const relCenterX = (itemX - dockX) + item.width / 2;
            if (x < relCenterX) {
                targetPos = i;
                break;
            }
        }

        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (isFav) {
                favManager.moveFavoriteToPos(id, targetPos);
            } else {
                favManager.addFavoriteAtPos(id, targetPos);
            }
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _applyBlur() {
        if (!this._dockBox)
            return;

        // Shell.BlurEffect with Shell.BlurMode.BACKGROUND causes dirty-rect scissor clipping
        // and box glitches in Mutter Wayland compositing. We safely remove it.
        if (this._blurEffect) {
            try {
                this._dockBox.remove_effect_by_name('dock-blur');
            } catch (e) {
                // ignore
            }
            this._blurEffect = null;
        }

        this._updateDockTheme();
    }

    _isSystemDark() {
        if (this._interfaceSettings) {
            const scheme = this._interfaceSettings.get_string('color-scheme');
            if (scheme === 'prefer-dark')
                return true;
            if (scheme === 'default' || scheme === 'prefer-light')
                return false;
        }
        try {
            const stSettings = St.Settings.get();
            if (stSettings && stSettings.colorScheme !== undefined)
                return stSettings.colorScheme === St.SystemColorScheme.PREFER_DARK;
        } catch (e) {
            // fallback
        }
        return false;
    }

    _getEffectiveColorMode() {
        const configured = this._settings ? (this._settings.get_string('dock-color') || 'auto') : 'auto';
        if (configured === 'auto') {
            return this._isSystemDark() ? 'dark' : 'light';
        }
        return configured;
    }

    _isLightMode() {
        const mode = this._getEffectiveColorMode();
        if (mode === 'light')
            return true;
        if (mode === 'dark' || mode === 'black')
            return false;
        if (mode === 'custom') {
            const customHex = this._settings?.get_string('dock-custom-color') || '#18181c';
            const clean = customHex.replace('#', '');
            if (clean.length === 6) {
                const r = parseInt(clean.substring(0, 2), 16) || 24;
                const g = parseInt(clean.substring(2, 4), 16) || 24;
                const b = parseInt(clean.substring(4, 6), 16) || 28;
                return (r * 0.299 + g * 0.587 + b * 0.114) > 160;
            }
        }
        return false;
    }

    _updateDockTheme() {
        if (!this._dockBox)
            return;

        const padding = this._settings.get_int('dock-padding') ?? 6;
        const borderRadius = this._settings.get_int('dock-border-radius') ?? 20;
        const opacity = (this._settings.get_int('dock-opacity') ?? 78) / 100;
        const borderOpacity = (this._settings.get_int('dock-border-opacity') ?? 20) / 100;
        const colorType = this._getEffectiveColorMode();

        let r = 24, g = 24, b = 28;
        let borderR = 255, borderG = 255, borderB = 255;

        if (colorType === 'light') {
            r = 242; g = 242; b = 247;
            borderR = 0; borderG = 0; borderB = 0;
        } else if (colorType === 'black') {
            r = 0; g = 0; b = 0;
        } else if (colorType === 'custom') {
            const customHex = this._settings.get_string('dock-custom-color') || '#18181c';
            const clean = customHex.replace('#', '');
            if (clean.length === 6) {
                r = parseInt(clean.substring(0, 2), 16) || 24;
                g = parseInt(clean.substring(2, 4), 16) || 24;
                b = parseInt(clean.substring(4, 6), 16) || 28;
            }
            if ((r * 0.299 + g * 0.587 + b * 0.114) > 160) {
                borderR = 0; borderG = 0; borderB = 0;
            }
        }

        const bgStr = `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(2)})`;
        const borderStr = `rgba(${borderR}, ${borderG}, ${borderB}, ${borderOpacity.toFixed(2)})`;
        const hPadding = Math.round(padding * 1.8);

        // Clean CSS styling with no broken square box-shadow
        this._dockBox.set_style(`background-color: ${bgStr}; border: 1px solid ${borderStr}; border-radius: ${borderRadius}px; padding: ${padding}px ${hPadding}px;`);
        this._updateSeparators();
        this._updateRunningDots();
        this._updatePosition();
    }

    _updateSeparators() {
        if (!this._dockBox)
            return;
        const isLight = this._isLightMode();
        for (const child of this._dockBox.get_children()) {
            if (child._isSeparator) {
                child.style_class = isLight ? 'wave-dock-separator-light' : 'wave-dock-separator';
            }
        }
    }

    _updatePosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._dockBox)
            return;

        const bottomMargin = this._settings?.get_int('dock-bottom-margin') ?? 8;
        const [, natW] = this._dockBox.get_preferred_width(-1);
        const [, natH] = this._dockBox.get_preferred_height(natW);

        // Center horizontally and place at bottom
        const x = monitor.x + Math.round((monitor.width - natW) / 2);
        const y = monitor.y + monitor.height - natH - bottomMargin;

        this._dockBox.set_position(x, y);

        this._updateAllWindowGeometries();
    }

    _updateAllWindowGeometries() {
        for (const item of this._items) {
            if (item._app)
                updateWindowGeometryForApp(item._app, item);
        }
    }

    _createSeparator(isLightMode) {
        const sep = new St.Widget({
            style_class: isLightMode ? 'wave-dock-separator-light' : 'wave-dock-separator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        sep._isSeparator = true;
        return sep;
    }

    _buildDock() {
        if (!this._dockBox)
            return;

        const oldItems = this._items;
        this._items = [];

        for (const item of oldItems) {
            try {
                item.remove_all_transitions?.();
            } catch (e) {
                // ignore
            }
        }

        this._dockBox.destroy_all_children();

        const favoritesManager = AppFavorites.getAppFavorites();
        const favoriteApps = favoritesManager.getFavorites();
        const baseIconSize = this._iconSize;
        const appSystem = Shell.AppSystem.get_default();
        const isLightMode = this._isLightMode();

        // 1. Applications Drawer / Grid launcher (if enabled, placed at start)
        if (this._settings.get_boolean('show-apps-drawer')) {
            const drawerItem = this._createAppDrawerItem(baseIconSize);
            this._dockBox.add_child(drawerItem);
            this._items.push(drawerItem);
        }

        // 2. Pinned Favorites
        for (const app of favoriteApps) {
            const item = this._createAppItem(app, baseIconSize, true);
            this._dockBox.add_child(item);
            this._items.push(item);
        }

        // 3. Running Apps not in favorites (if enabled)
        if (this._settings.get_boolean('show-running')) {
            const running = appSystem.get_running();
            const unpinnedRunning = running.filter(app => {
                const id = app.get_id();
                const appInfo = app.app_info || (typeof app.get_app_info === 'function' ? app.get_app_info() : null);
                return id && !favoritesManager.isFavorite(id) && (!appInfo || appInfo.should_show());
            });

            if (unpinnedRunning.length > 0 && (favoriteApps.length > 0 || this._items.length > 0)) {
                this._dockBox.add_child(this._createSeparator(isLightMode));
            }

            for (const app of unpinnedRunning) {
                const item = this._createAppItem(app, baseIconSize, false);
                this._dockBox.add_child(item);
                this._items.push(item);
            }
        }

        // 4. Mounted Volumes & Removable Media (if enabled)
        if (this._settings.get_boolean('show-mounts') && this._volumeMonitor) {
            const mounts = this._volumeMonitor.get_mounts().filter(m => {
                if (m.is_shadowed())
                    return false;
                const drive = m.get_drive() || m.get_volume()?.get_drive();
                const canUnmount = m.can_unmount() || m.can_eject();
                const isRemovable = drive ? (drive.is_removable() || drive.is_media_removable()) : canUnmount;
                return canUnmount || isRemovable;
            });

            if (mounts.length > 0) {
                this._dockBox.add_child(this._createSeparator(isLightMode));
                for (const mount of mounts) {
                    const mountItem = this._createMountItem(mount, baseIconSize);
                    this._dockBox.add_child(mountItem);
                    this._items.push(mountItem);
                }
            }
        }

        // 5. Trash Bin (if enabled, with system icon theme)
        if (this._settings.get_boolean('show-trash')) {
            this._dockBox.add_child(this._createSeparator(isLightMode));

            const trashItem = this._createTrashItem(baseIconSize);
            this._dockBox.add_child(trashItem);
            this._items.push(trashItem);
        }

        this._updateRunningDots();
        this._updateDockTheme();

        // Let children allocate, then position accurately so elements never overflow
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updatePosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggleAppDrawer() {
        if (Main.overview.visible) {
            if (Main.overview.dash?.showAppsButton?.checked) {
                Main.overview.hide();
            } else if (Main.overview.dash?.showAppsButton) {
                Main.overview.dash.showAppsButton.checked = true;
            } else {
                Main.overview.show(2);
            }
        } else {
            // 2 is ControlsState.APP_GRID in GNOME Shell, showing the applications grid directly
            Main.overview.show(2);
            if (Main.overview.dash?.showAppsButton) {
                Main.overview.dash.showAppsButton.checked = true;
            }
        }
    }

    _createAppDrawerItem(size) {
        const item = new St.Button({
            style_class: 'wave-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: false,
        });

        item._isAppDrawer = true;
        item._tooltipText = _('Aplicaciones');
        item.set_pivot_point(0.5, 1.0);

        const itemBox = new St.BoxLayout({
            style_class: 'wave-dock-item-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            clip_to_allocation: false,
        });

        const iconActor = new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            icon_size: size,
        });
        itemBox.add_child(iconActor);

        const dummyDot = new St.Widget({
            style_class: 'wave-dock-dot-inactive',
            x_align: Clutter.ActorAlign.CENTER,
        });
        itemBox.add_child(dummyDot);

        item.set_child(itemBox);

        item.connect('clicked', () => {
            this._toggleAppDrawer();
        });

        item.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3) {
                this._showDockSettingsMenu(item);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return item;
    }

    _createMountItem(mount, size) {
        const item = new St.Button({
            style_class: 'wave-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: false,
        });

        item._mount = mount;
        item._tooltipText = mount.get_name();
        item.set_pivot_point(0.5, 1.0);

        const itemBox = new St.BoxLayout({
            style_class: 'wave-dock-item-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            clip_to_allocation: false,
        });

        const gicon = mount.get_icon() || mount.get_symbolic_icon();
        const iconActor = new St.Icon({
            gicon: gicon,
            icon_size: size,
        });
        itemBox.add_child(iconActor);

        const dummyDot = new St.Widget({
            style_class: 'wave-dock-dot-inactive',
            x_align: Clutter.ActorAlign.CENTER,
        });
        itemBox.add_child(dummyDot);

        item.set_child(itemBox);

        item.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            Gio.AppInfo.launch_default_for_uri(mount.get_root().get_uri(), global.create_app_launch_context(0, -1));
        });

        item.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3) {
                this._showMountContextMenu(item, mount);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return item;
    }

    _showMountContextMenu(item, mount) {
        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        const menu = new PopupMenu.PopupMenu(item, 0.5, St.Side.TOP);
        this._contextMenu = menu;
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        const header = new PopupMenu.PopupMenuItem(mount.get_name(), { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openItem = new PopupMenu.PopupMenuItem(_('Abrir'));
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(mount.get_root().get_uri(), global.create_app_launch_context(0, -1));
        });
        menu.addMenuItem(openItem);

        const canEject = mount.can_eject();
        const unmountItem = new PopupMenu.PopupMenuItem(canEject ? _('Expulsar') : _('Desmontar'));
        unmountItem.connect('activate', () => {
            if (canEject) {
                mount.eject_with_operation(Gio.MountUnmountFlags.NONE, null, null, (m, res) => {
                    try {
                        m.eject_with_operation_finish(res);
                    } catch (e) {
                        // ignore
                    }
                });
            } else {
                mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, null, null, (m, res) => {
                    try {
                        m.unmount_with_operation_finish(res);
                    } catch (e) {
                        // ignore
                    }
                });
            }
        });
        menu.addMenuItem(unmountItem);

        // Quick dock preferences access
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem(_('Configuración'));
        prefsItem.connect('activate', () => this._openPreferencesWindow());
        menu.addMenuItem(prefsItem);

        menu.connect('destroy', () => {
            if (this._contextMenu === menu)
                this._contextMenu = null;
            if (this._dockTracker) {
                if (!this._isMouseInDockArea()) {
                    this._startHideDebounce();
                }
            } else {
                this._scheduleCheck();
            }
        });

        menu.open();
    }

    _showDockSettingsMenu(sourceActor) {
        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        const menu = new PopupMenu.PopupMenu(sourceActor, 0.5, St.Side.TOP);
        this._contextMenu = menu;
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        const header = new PopupMenu.PopupMenuItem(_('Mac Wave Dock'), { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Configuración'));
        prefsItem.connect('activate', () => this._openPreferencesWindow());
        menu.addMenuItem(prefsItem);

        menu.connect('destroy', () => {
            if (this._contextMenu === menu)
                this._contextMenu = null;
            if (this._dockTracker) {
                if (!this._isMouseInDockArea()) {
                    this._startHideDebounce();
                }
            } else {
                this._scheduleCheck();
            }
        });

        menu.open();
    }

    _openPreferencesWindow() {
        try {
            this.openPreferences();
        } catch (e) {
            GLib.spawn_command_line_async('gnome-extensions prefs MyDock@demonc');
        }
    }

    _createAppItem(app, size, isPinned) {
        const item = new St.Button({
            style_class: 'wave-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: false,
        });

        item._app = app;
        item._isPinned = isPinned;
        item.set_pivot_point(0.5, 1.0);

        const itemBox = new St.BoxLayout({
            style_class: 'wave-dock-item-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            clip_to_allocation: false,
        });

        const iconActor = getAppIcon(app, size);
        itemBox.add_child(iconActor);

        // Running dot indicator
        const dot = new St.Widget({
            style_class: 'wave-dock-dot-inactive',
            x_align: Clutter.ActorAlign.CENTER,
        });
        item._dot = dot;
        itemBox.add_child(dot);

        item.set_child(itemBox);

        // DND Source delegate so GNOME Shell knows what app is being dragged
        item._delegate = {
            app: app,
            getDragActor: () => getAppIcon(app, size),
            getDragActorSource: () => item,
        };

        // Pinned apps can be dragged natively to reorder on the dock
        if (isPinned) {
            item._draggable = DND.makeDraggable(item, {
                restoreOnSuccess: false,
            });
        }

        // 100% Reliable click using native St.Button 'clicked' signal
        item.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            handleAppClick(app, item);
        });

        // Right-click and middle-click handling
        item.connect('button-press-event', (actor, event) => {
            const btn = event.get_button();
            if (btn === 3) {
                this._showContextMenu(item, app, false);
                return Clutter.EVENT_STOP;
            } else if (btn === 2) {
                app.open_new_window(-1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return item;
    }

    _createTrashItem(size) {
        const item = new St.Button({
            style_class: 'wave-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: false,
        });

        item._isTrash = true;
        item._tooltipText = _('Papelera');
        item.set_pivot_point(0.5, 1.0);

        const itemBox = new St.BoxLayout({
            style_class: 'wave-dock-item-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            clip_to_allocation: false,
        });

        // Use system theme full-color icons
        const hasItems = this._checkTrashHasItems();
        const gicon = Gio.ThemedIcon.new_with_default_fallbacks(hasItems ? 'user-trash-full' : 'user-trash');
        const trashIcon = new St.Icon({
            gicon: gicon,
            icon_size: size,
        });
        this._trashIcon = trashIcon;
        itemBox.add_child(trashIcon);

        // Invisible spacing dot to match app heights
        const dummyDot = new St.Widget({
            style_class: 'wave-dock-dot-inactive',
            x_align: Clutter.ActorAlign.CENTER,
        });
        itemBox.add_child(dummyDot);

        item.set_child(itemBox);
        this._updateTrashIcon();

        item.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            Gio.AppInfo.launch_default_for_uri('trash:///', global.create_app_launch_context(0, -1));
        });

        item.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 3) {
                this._showContextMenu(item, null, true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return item;
    }

    _checkTrashHasItems() {
        try {
            const trashFile = Gio.File.new_for_uri('trash:///');
            const enumerator = trashFile.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            const hasItems = enumerator.next_file(null) !== null;
            enumerator.close(null);
            return hasItems;
        } catch (e) {
            return false;
        }
    }

    _updateTrashIcon() {
        if (!this._trashIcon)
            return;

        const hasItems = this._checkTrashHasItems();
        const iconName = hasItems ? 'user-trash-full' : 'user-trash';
        this._trashIcon.gicon = Gio.ThemedIcon.new_with_default_fallbacks(iconName);
    }

    _updateRunningDots() {
        const focusWindow = global.display.get_focus_window();
        const isLightMode = this._isLightMode();

        for (const item of this._items) {
            if (!item._dot || !item._app)
                continue;

            const windows = item._app.get_windows();
            if (windows.length > 0) {
                const isFocused = windows.some(w => w === focusWindow);
                if (isLightMode) {
                    item._dot.style_class = isFocused ? 'wave-dock-dot-light-active' : 'wave-dock-dot-light';
                } else {
                    item._dot.style_class = isFocused ? 'wave-dock-dot-active' : 'wave-dock-dot';
                }
            } else {
                item._dot.style_class = 'wave-dock-dot-inactive';
            }
        }
    }

    _applyWaveEffect(stageX) {
        if (DND.dragInProgress)
            return;

        const waveRadius = this._waveRadius;
        const maxScale = this._maxScale;

        let closestItem = null;
        let minDistance = Infinity;

        // Perform instant property updates without tween lag during active mousemove
        for (const item of this._items) {
            try {
                if (!item || !item.get_parent())
                    continue;

                const [itemStageX] = item.get_transformed_position();
                const itemWidth = item.width;
                const itemCenterX = itemStageX + itemWidth / 2;
                const dist = Math.abs(stageX - itemCenterX);

                if (dist < minDistance) {
                    minDistance = dist;
                    closestItem = item;
                }

                let targetScale = 1.0;
                let push = 0;

                if (dist < waveRadius) {
                    const norm = dist / waveRadius;
                    const factor = Math.cos(norm * (Math.PI / 2));
                    targetScale = 1.0 + (maxScale - 1.0) * (factor * factor);

                    // Push adjacent icons sideways so they part gracefully like waves
                    const dir = (itemCenterX < stageX) ? -1 : 1;
                    const pushFactor = Math.sin(norm * Math.PI);
                    push = dir * pushFactor * 10 * (maxScale - 1.0);
                }

                item.scale_x = targetScale;
                item.scale_y = targetScale;
                item.translation_x = push;
            } catch (e) {
                // Ignore disposed actors during rebuild
            }
        }

        // Show macOS tooltip for directly hovered item
        if (closestItem && minDistance < 32) {
            this._showTooltip(closestItem);
        } else {
            this._hideTooltip();
        }
    }

    _resetWaveEffect() {
        this._hideTooltip();

        // Single smooth ease back when leaving the dock
        const items = this._items ? [...this._items] : [];
        for (const item of items) {
            try {
                if (!item)
                    continue;

                item.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    translation_x: 0,
                    duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } catch (e) {
                // Ignore disposed actors
            }
        }
    }

    _showTooltip(item) {
        const name = item._app ? item._app.get_name() : (item._tooltipText || '');
        if (!name || !this._tooltip)
            return;

        this._tooltip.set_text(name);
        this._tooltip.opacity = 255;
        this._tooltip.visible = true;

        const [itemX, itemY] = item.get_transformed_position();
        const currentScale = item.scale_x || 1.0;
        const itemWidth = item.width * currentScale;

        const [, tooltipWidth] = this._tooltip.get_preferred_width(-1);
        const [, tooltipHeight] = this._tooltip.get_preferred_height(tooltipWidth);

        const targetX = Math.round(itemX + itemWidth / 2 - tooltipWidth / 2);
        const targetY = Math.round(itemY - tooltipHeight - 14);

        this._tooltip.set_position(targetX, targetY);
    }

    _hideTooltip() {
        if (this._tooltip) {
            this._tooltip.opacity = 0;
            this._tooltip.visible = false;
        }
    }

    _showContextMenu(item, app, isTrash) {
        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        const menu = new PopupMenu.PopupMenu(item, 0.5, St.Side.TOP);
        this._contextMenu = menu;
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        if (isTrash) {
            const header = new PopupMenu.PopupMenuItem(_('Papelera'), { reactive: false });
            menu.addMenuItem(header);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const openItem = new PopupMenu.PopupMenuItem(_('Abrir Papelera'));
            openItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri('trash:///', global.create_app_launch_context(0, -1));
            });
            menu.addMenuItem(openItem);

            const emptyItem = new PopupMenu.PopupMenuItem(_('Vaciar Papelera'));
            emptyItem.connect('activate', () => {
                GLib.spawn_command_line_async('gio trash --empty');
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this._updateTrashIcon();
                    return GLib.SOURCE_REMOVE;
                });
            });
            menu.addMenuItem(emptyItem);
        } else {
            const appId = app.get_id();
            const favorites = AppFavorites.getAppFavorites();
            const isFav = favorites.isFavorite(appId);
            const windows = app.get_windows();

            // Header: App name
            const header = new PopupMenu.PopupMenuItem(app.get_name(), { reactive: false });
            menu.addMenuItem(header);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Open new window
            if (windows.length > 0) {
                const newWinItem = new PopupMenu.PopupMenuItem(_('Nueva ventana'));
                newWinItem.connect('activate', () => {
                    app.open_new_window(-1);
                });
                menu.addMenuItem(newWinItem);
            }

            // Pin / Unpin option
            if (isFav) {
                const unpinItem = new PopupMenu.PopupMenuItem(_('Desfijar del Dock'));
                unpinItem.connect('activate', () => {
                    favorites.removeFavorite(appId);
                });
                menu.addMenuItem(unpinItem);
            } else {
                const pinItem = new PopupMenu.PopupMenuItem(_('Mantener en el Dock'));
                pinItem.connect('activate', () => {
                    favorites.addFavorite(appId);
                });
                menu.addMenuItem(pinItem);
            }

            // Quit application
            if (windows.length > 0) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const quitItem = new PopupMenu.PopupMenuItem(_('Cerrar todas las ventanas'));
                quitItem.connect('activate', () => {
                    app.request_quit();
                });
                menu.addMenuItem(quitItem);
            }
        }

        // Quick dock preferences access in every context menu
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem(_('Configuración'));
        prefsItem.connect('activate', () => this._openPreferencesWindow());
        menu.addMenuItem(prefsItem);

        menu.connect('destroy', () => {
            if (this._contextMenu === menu)
                this._contextMenu = null;
            if (this._dockTracker) {
                if (!this._isMouseInDockArea()) {
                    this._startHideDebounce();
                }
            } else {
                this._scheduleCheck();
            }
        });

        menu.open();
    }

    disable() {
        if (this.enableUnredirect != null) {
            global.compositor.enable_unredirect = this.enableUnredirect;
            this.enableUnredirect = null;
        }

        this._teardownEdgeTracker();
        this._stopPointerWatch();

        if (this._checkDebounceId) {
            GLib.source_remove(this._checkDebounceId);
            this._checkDebounceId = 0;
        }

        if (this._focusWin) {
            this._focusWin.disconnectObject(this);
            this._focusWin = null;
        }

        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        // Restore native GNOME overview dash
        Main.overview.dash.visible = true;

        // Disconnect all listeners
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);

        if (this._dockBox) {
            this._dockBox.remove_all_transitions();
            this._dockBox.translation_y = 0;
            this._dockBox.opacity = 255;
            this._dockBox._delegate = null;
            Main.layoutManager.removeChrome(this._dockBox);
            this._dockBox.destroy();
            this._dockBox = null;
        }

        if (this._tooltip) {
            Main.layoutManager.removeChrome(this._tooltip);
            this._tooltip.destroy();
            this._tooltip = null;
        }

        this._items = [];

        if (this._volumeMonitor) {
            this._volumeMonitor.disconnectObject(this);
            this._volumeMonitor = null;
        }

        if (this._interfaceSettings) {
            this._interfaceSettings.disconnectObject(this);
            this._interfaceSettings = null;
        }

        try {
            St.Settings.get().disconnectObject(this);
        } catch (e) {
            // ignore
        }

        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }

        if (this._blurEffect) {
            this._blurEffect = null;
        }
    }
}
