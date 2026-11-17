/*
   Wave Top Bar Extension
   GNOME Shell 45+ (ESM)
   Modern, elegant macOS-inspired top bar featuring:
   - Fedora logo system menu with crash-proof native SystemActions
   - Active application title in bold (without icon)
   - Native background blur (glassmorphism) without borders
   - Spotlight file & app search with directory opening in Nautilus
   - One-click Wi-Fi & Bluetooth toggles (no GNOME panel opening)
   - Battery menu with clean text power profile selection (Performance, Balanced, Power-saver)
   - Crisp white horizontal battery icon with live percentage
   - Single Control Center button to open GNOME Quick Settings
   - Sleek and compact 26px design with 14px icons
   - Auto-hide with fullscreen and maximized windows with top edge hover trigger
   - Pure GDBus battery monitoring (crash-proof, zero UPowerGlib)
   - Date and time in the top-right corner
*/

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import NM from 'gi://NM';
import GnomeBluetooth from 'gi://GnomeBluetooth';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PointerTracker } from './pointerTracker.js';

export default class WaveTopBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._systemActions = new SystemActions.getDefault();

        // Prevent unredirect of fullscreen windows so overlay top bar always renders
        if (this.enableUnredirect == null) {
            this.enableUnredirect = global.compositor.enable_unredirect;
            global.compositor.enable_unredirect = function () {};
            global.compositor.disable_unredirect();
        }

        // State trackers
        this._clockTimeoutId = 0;
        this._blurEffect = null;
        this._topBarBg = null;
        this._contentBox = null;
        this._contextMenu = null;
        this._contextAnchor = null;
        this._systemMenu = null;
        this._appMenu = null;
        this._batteryMenu = null;
        this._clockMenu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        // Spotlight state
        this._spotlightDialog = null;
        this._spotlightShield = null;
        this._spotlightSearchTimeout = 0;

        // Battery DBus State
        this._batteryPercentage = 100;
        this._batteryCharging = false;
        this._upowerProxy = null;
        this._powerProfilesProxy = null;

        // Auto-hide state matching Zen Top Bar architecture
        this._barHeight = this._settings.get_int('bar-height') || 26;
        this._isBarHidden = false;
        this._userForced = false;
        this._waitingForEdgeHit = false;
        this._edgeTracker = null;
        this._panelTracker = null;
        this._edgeDebounceId = 0;
        this._hideDebounceId = 0;
        this._checkDebounceId = 0;
        this._focusWin = null;

        // Hide native GNOME panel without unparenting it (prevents GC crashes in GNOME 51)
        this._origPanelVisible = Main.panel.visible;
        this._origPanelOpacity = Main.panel.opacity;
        this._origPanelReactive = Main.panel.reactive;

        Main.panel.opacity = 0;
        Main.panel.reactive = false;
        Main.panel.visible = false;

        // Ensure panelBox does not affect window manager struts
        const panelBoxIdx = Main.layoutManager._findActor(Main.layoutManager.panelBox);
        if (panelBoxIdx !== -1) {
            this._origPanelBoxAffectsStruts = Main.layoutManager._trackedActors[panelBoxIdx].affectsStruts;
            Main.layoutManager._trackedActors[panelBoxIdx].affectsStruts = false;
            Main.layoutManager._queueUpdateRegions();
        }

        // Build custom top bar
        this._buildTopBar();
        this._applyBlur();

        // Add top bar directly to Chrome above all windows
        const autohide = this._settings.get_boolean('autohide-in-fullscreen-or-maximized');

        Main.layoutManager.addTopChrome(this._topBar, {
            affectsStruts: !autohide,
            trackFullscreen: true,
        });

        // Position immediately
        this._updateBarPosition();

        // Setup hardware monitors (Pure DBus + NM + BT)
        this._setupHardwareMonitors();

        // Window focus, app tracker and workspace listeners
        global.display.connectObject(
            'notify::focus-window', () => {
                this._updateActiveApp();
                this._trackFocusWindow();
            },
            this
        );

        Shell.WindowTracker.get_default().connectObject(
            'tracked-windows-changed', () => this._updateActiveApp(),
            this
        );

        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', () => this._updateActiveApp(),
            this
        );

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => {
                this._updateActiveApp();
                this._scheduleCheck();
            },
            this
        );

        Main.layoutManager.connectObject(
            'monitors-changed', () => {
                this._updateBarPosition();
                this._updateActiveApp();
                this._trackFocusWindow();
            },
            this
        );

        // Overview visibility: hide top bar completely during workspaces & app drawer
        Main.overview.connectObject(
            'showing', () => {
                this._userForced = false;
                this._teardownEdgeTracker();
                this._stopPointerWatch();
                this._hideTopBarAnimated();
            },
            'hiding', () => {
                this._userForced = false;
                this._scheduleCheck();
            },
            'hidden', () => {
                this._userForced = false;
                this._scheduleCheck();
            },
            this
        );

        // Listen to system color-scheme changes for auto dark/light theme
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._interfaceSettings.connectObject(
            'changed::color-scheme', () => this._updateTheme(),
            this
        );
        try {
            St.Settings.get().connectObject(
                'notify::color-scheme', () => this._updateTheme(),
                this
            );
        } catch (e) {
            // ignore
        }

        // Settings change listeners (Active in real-time)
        this._settings.connectObject(
            'changed::bar-height', () => this._updateTheme(),
            'changed::floating-bar', () => this._updateTheme(),
            'changed::bar-opacity', () => this._updateTheme(),
            'changed::bar-color', () => this._updateTheme(),
            'changed::bar-custom-color', () => this._updateTheme(),
            'changed::bar-blur', () => this._applyBlur(),
            'changed::bar-blur-radius', () => this._applyBlur(),
            'changed::clock-format', () => this._updateClock(),
            'changed::autohide-in-fullscreen-or-maximized', () => {
                const autohideSetting = this._settings.get_boolean('autohide-in-fullscreen-or-maximized');
                this._updateTopBarStruts(autohideSetting);
                if (!autohideSetting) {
                    this._userForced = false;
                    this._teardownEdgeTracker();
                    this._stopPointerWatch();
                    this._showTopBarAnimated();
                } else {
                    this._scheduleCheck();
                }
            },
            'changed::show-system-menu', () => this._updateVisibility(),
            'changed::show-active-app', () => this._updateVisibility(),
            'changed::show-clock', () => this._updateVisibility(),
            'changed::show-spotlight', () => this._updateVisibility(),
            'changed::show-wifi', () => this._updateVisibility(),
            'changed::show-bluetooth', () => this._updateVisibility(),
            'changed::show-battery', () => this._updateVisibility(),
            'changed::show-control-center', () => this._updateVisibility(),
            this
        );

        // Start clock timer
        this._startClockTimer();

        // Initial updates
        this._updateTheme();
        this._updateVisibility();
        this._updateActiveApp();
        this._updateClock();
        this._updateHardwareIndicators();

        // Initial window check
        this._trackFocusWindow();
    }

    _buildTopBar() {
        // Main container (no borders, thin, full width)
        this._topBar = new St.Widget({
            name: 'wave-topbar',
            style_class: 'wave-topbar',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        // Background actor for blur and theme background color
        this._topBarBg = new St.Widget({
            name: 'wave-topbar-bg',
            style_class: 'wave-topbar-bg',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._topBar.add_child(this._topBarBg);

        // Foreground content container
        this._contentBox = new St.BoxLayout({
            name: 'wave-topbar-content',
            style_class: 'wave-topbar-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._topBar.add_child(this._contentBox);

        // Right-click anywhere on the bar for context settings menu
        const handleRightClick = (actor, event) => {
            if (event.get_button() === 3) {
                const [clickX, clickY] = event.get_coords();
                this._showContextMenu(clickX, clickY);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        };

        this._topBar.connect('button-press-event', handleRightClick);
        this._topBarBg.connect('button-press-event', handleRightClick);
        this._contentBox.connect('button-press-event', handleRightClick);

        // Left section (Fedora Logo + Active App name only)
        this._leftBox = new St.BoxLayout({
            style_class: 'wave-topbar-left',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: false,
            y_expand: true,
        });
        this._contentBox.add_child(this._leftBox);
        this._leftBox.connect('button-press-event', handleRightClick);

        // Center section (expands to push right items to far right corner)
        this._centerBox = new St.BoxLayout({
            style_class: 'wave-topbar-center',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        this._contentBox.add_child(this._centerBox);
        this._centerBox.connect('button-press-event', handleRightClick);

        // Right section (Spotlight, Wi-Fi, Bluetooth, Battery, Control Center, Clock)
        this._rightBox = new St.BoxLayout({
            style_class: 'wave-topbar-right',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: false,
            y_expand: true,
        });
        this._contentBox.add_child(this._rightBox);
        this._rightBox.connect('button-press-event', handleRightClick);

        // 1. Fedora Logo Button (System Menu)
        this._logoBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-logo',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });

        const fedoraSvg = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'assets', 'fedora-logo.svg'])
        );
        this._logoIcon = new St.Icon({
            gicon: new Gio.FileIcon({ file: fedoraSvg }),
            fallback_icon_name: 'fedora-logo-icon',
            icon_size: 14,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._logoBtn.set_child(this._logoIcon);
        this._logoBtn.connect('clicked', () => this._showSystemMenu());
        this._logoBtn.connect('button-press-event', handleRightClick);
        this._leftBox.add_child(this._logoBtn);

        // 2. Active Application Button (Name ONLY, no icon)
        this._activeAppBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-app-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._activeAppLabel = new St.Label({
            text: _('Escritorio'),
            style_class: 'wave-topbar-app-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._activeAppBtn.set_child(this._activeAppLabel);
        this._activeAppBtn.connect('clicked', () => this._showActiveAppMenu());
        this._activeAppBtn.connect('button-press-event', handleRightClick);
        this._leftBox.add_child(this._activeAppBtn);

        // --- RIGHT SECTION ITEMS ---

        // 3. Spotlight File Search (Lupa) - Sleek 11px compact icon
        this._spotlightBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        const searchIcon = new St.Icon({
            icon_name: 'system-search-symbolic',
            fallback_icon_name: 'edit-find-symbolic',
            icon_size: 11,
            style_class: 'wave-topbar-icon wave-topbar-small-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._spotlightBtn.set_child(searchIcon);
        this._spotlightBtn.connect('clicked', () => this._toggleSpotlight());
        this._spotlightBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._spotlightBtn);

        // 4. Wi-Fi Status Button (Toggle only) - Sleek 11px compact icon
        this._wifiBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._wifiIcon = new St.Icon({
            icon_name: 'network-wireless-symbolic',
            icon_size: 11,
            style_class: 'wave-topbar-icon wave-topbar-small-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._wifiBtn.set_child(this._wifiIcon);
        this._wifiBtn.connect('clicked', () => this._toggleWifi());
        this._wifiBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._wifiBtn);

        // 5. Bluetooth Status Button (Toggle only) - Sleek 11px compact icon
        this._bluetoothBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._bluetoothIcon = new St.Icon({
            icon_name: 'bluetooth-active-symbolic',
            fallback_icon_name: 'bluetooth-symbolic',
            icon_size: 11,
            style_class: 'wave-topbar-icon wave-topbar-small-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bluetoothBtn.set_child(this._bluetoothIcon);
        this._bluetoothBtn.connect('clicked', () => this._toggleBluetooth());
        this._bluetoothBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._bluetoothBtn);

        // 6. Battery with Percentage (Horizontal 23x11px Icon, Power Profile Menu)
        this._batteryBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._batteryBox = new St.BoxLayout({
            style_class: 'wave-topbar-status-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._batteryDrawing = new St.DrawingArea({
            width: 23,
            height: 11,
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'wave-topbar-battery-drawing',
        });
        this._batteryDrawing.set_size(23, 11);
        this._batteryDrawing.connect('repaint', () => {
            this._paintBattery(this._batteryDrawing);
        });

        this._batteryLabel = new St.Label({
            text: '100%',
            style_class: 'wave-topbar-battery-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryBox.add_child(this._batteryDrawing);
        this._batteryBox.add_child(this._batteryLabel);
        this._batteryBtn.set_child(this._batteryBox);
        this._batteryBtn.connect('clicked', () => this._showBatteryMenu());
        this._batteryBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._batteryBtn);

        // 7. Control Center Button (THE ONLY ICON THAT OPENS GNOME QUICK SETTINGS)
        this._controlCenterBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        const ccSvg = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'assets', 'control-center-symbolic.svg'])
        );
        this._controlCenterIcon = new St.Icon({
            gicon: new Gio.FileIcon({ file: ccSvg }),
            fallback_icon_name: 'view-more-symbolic',
            icon_size: 13,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._controlCenterBtn.set_child(this._controlCenterIcon);
        this._controlCenterBtn.connect('clicked', () => this._toggleControlCenter());
        this._controlCenterBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._controlCenterBtn);

        // 8. Clock & Date Button (Far Right Corner)
        this._clockBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-clock-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._clockLabel = new St.Label({
            text: '--:--',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockBtn.set_child(this._clockLabel);
        this._clockBtn.connect('clicked', () => this._showClockMenu());
        this._clockBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._clockBtn);
    }

    _setupHardwareMonitors() {
        // 1. Network Manager Client (Toggle Wi-Fi directly)
        try {
            this._nmClient = NM.Client.new(null);
            this._nmClient.connectObject(
                'notify::wireless-enabled', () => this._updateNetwork(),
                'notify::connectivity', () => this._updateNetwork(),
                this
            );
        } catch (e) {
            console.warn('[WaveTopBar] Could not initialize NM.Client:', e);
        }

        // 2. Bluetooth Client (Toggle Bluetooth directly)
        try {
            this._btClient = new GnomeBluetooth.Client();
            this._btClient.connectObject(
                'notify::default-adapter-powered', () => this._updateBluetooth(),
                this
            );
        } catch (e) {
            console.warn('[WaveTopBar] Could not initialize GnomeBluetooth.Client:', e);
        }

        // 3. UPower via Pure Gio.DBusProxy (NO UPowerGlib crash!)
        try {
            this._upowerProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.UPower',
                g_object_path: '/org/freedesktop/UPower/devices/DisplayDevice',
                g_interface_name: 'org.freedesktop.UPower.Device',
            });
            this._upowerProxy.init(null);
            this._upowerProxy.connect('g-properties-changed', () => this._updateBatteryFromDBus());
            this._updateBatteryFromDBus();
        } catch (e) {
            console.warn('[WaveTopBar] UPower DBus error:', e);
        }

        // 4. PowerProfiles via Pure Gio.DBusProxy
        try {
            this._powerProfilesProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'net.hadess.PowerProfiles',
                g_object_path: '/net/hadess/PowerProfiles',
                g_interface_name: 'net.hadess.PowerProfiles',
            });
            this._powerProfilesProxy.init(null);
        } catch (e) {
            console.warn('[WaveTopBar] PowerProfiles DBus error:', e);
        }
    }

    _updateHardwareIndicators() {
        this._updateNetwork();
        this._updateBluetooth();
        this._updateBatteryFromDBus();
    }

    _updateNetwork() {
        if (!this._wifiIcon || !this._nmClient)
            return;

        const isWireless = this._nmClient.wireless_enabled;
        const connectivity = this._nmClient.connectivity;
        const isConnected = connectivity === NM.ConnectivityState.FULL || connectivity === NM.ConnectivityState.LIMITED;

        if (isConnected) {
            this._wifiIcon.icon_name = isWireless
                ? 'network-wireless-signal-excellent-symbolic'
                : 'network-wired-symbolic';
        } else {
            this._wifiIcon.icon_name = isWireless
                ? 'network-wireless-offline-symbolic'
                : 'network-offline-symbolic';
        }
    }

    _toggleWifi() {
        if (!this._nmClient) return;
        this._nmClient.wireless_enabled = !this._nmClient.wireless_enabled;
        this._updateNetwork();
    }

    _updateBluetooth() {
        if (!this._bluetoothIcon || !this._btClient)
            return;

        const isPowered = this._btClient.default_adapter_powered;
        this._bluetoothIcon.icon_name = isPowered
            ? 'bluetooth-active-symbolic'
            : 'bluetooth-disabled-symbolic';
    }

    _toggleBluetooth() {
        if (!this._btClient) return;
        this._btClient.default_adapter_powered = !this._btClient.default_adapter_powered;
        this._updateBluetooth();
    }

    _updateBatteryFromDBus() {
        if (!this._upowerProxy || !this._batteryDrawing || !this._batteryLabel)
            return;

        try {
            const pctVar = this._upowerProxy.get_cached_property('Percentage');
            const stateVar = this._upowerProxy.get_cached_property('State');

            if (pctVar) {
                this._batteryPercentage = Math.round(pctVar.unpack());
                this._batteryLabel.text = `${this._batteryPercentage}%`;
            }

            const state = stateVar ? stateVar.unpack() : 0;
            // 1: Charging, 4: Fully Charged, 5: Pending charge
            this._batteryCharging = (state === 1 || state === 4 || state === 5);

            this._batteryDrawing.queue_repaint();
        } catch (e) {
            // ignore
        }
    }

    _paintBattery(area) {
        const cr = area.get_context();
        if (!cr)
            return;

        const pct = Math.max(0, Math.min(100, this._batteryPercentage ?? 100));
        const isCharging = Boolean(this._batteryCharging);
        const isLight = Boolean(this._isLightMode);
        const [fr, fg, fb] = isLight ? [0.10, 0.10, 0.12] : [1.0, 1.0, 1.0];

        const roundedRect = (x, y, w, h, r) => {
            cr.newSubPath();
            cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
            cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
            cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
            cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
            cr.closePath();
        };

        // Outer battery shell: 18 x 9.5, x=0.75, y=0.75, radius=2.5
        roundedRect(0.75, 0.75, 18.0, 9.5, 2.5);
        cr.setLineWidth(1.0);
        cr.setSourceRGBA(fr, fg, fb, isLight ? 0.78 : 0.85);
        cr.stroke();

        // Terminal positive bump on right: x=19.5, y=3.25, w=1.5, h=4.5, r=0.7
        roundedRect(19.5, 3.25, 1.5, 4.5, 0.7);
        cr.setSourceRGBA(fr, fg, fb, isLight ? 0.55 : 0.65);
        cr.fill();

        // Inner battery fill (max width 14.0px)
        const fillW = Math.max(1.2, 14.0 * (pct / 100.0));

        // Color selection:
        // Charging: Green (#30d158)
        // Discharging <= 10%: Red (#ff453a)
        // Discharging <= 20%: Yellow/Orange (#ff9f0a)
        // Discharging > 20%: Crisp White (#ffffff) in dark mode, or crisp dark (#1a1a1c) in light mode
        if (isCharging) {
            cr.setSourceRGBA(0.188, 0.820, 0.345, 1.0);
        } else if (pct <= 10) {
            cr.setSourceRGBA(1.0, 0.271, 0.227, 1.0);
        } else if (pct <= 20) {
            cr.setSourceRGBA(1.0, 0.624, 0.039, 1.0);
        } else {
            cr.setSourceRGBA(fr, fg, fb, isLight ? 0.88 : 0.95);
        }

        roundedRect(2.0, 2.0, fillW, 7.0, 1.4);
        cr.fill();

        // Lightning bolt (⚡) when connected to charger
        if (isCharging) {
            const cx = 9.75;
            const cy = 5.5;
            cr.setSourceRGBA(isLight ? 0.10 : 1.0, isLight ? 0.10 : 1.0, isLight ? 0.12 : 1.0, 0.95);
            cr.moveTo(cx + 1.0, cy - 3.4);
            cr.lineTo(cx - 1.7, cy + 0.1);
            cr.lineTo(cx + 0.2, cy + 0.1);
            cr.lineTo(cx - 1.0, cy + 3.4);
            cr.lineTo(cx + 1.7, cy - 0.1);
            cr.lineTo(cx - 0.2, cy - 0.1);
            cr.closePath();
            cr.fill();
        }

        cr.$dispose();
    }

    _getPowerProfile() {
        if (!this._powerProfilesProxy) return 'balanced';
        try {
            const p = this._powerProfilesProxy.get_cached_property('ActiveProfile');
            return p ? p.unpack() : 'balanced';
        } catch (e) {
            return 'balanced';
        }
    }

    _setPowerProfile(profile) {
        if (!this._powerProfilesProxy) return;
        try {
            this._powerProfilesProxy.call(
                'org.freedesktop.DBus.Properties.Set',
                new GLib.Variant('(ssv)', ['net.hadess.PowerProfiles', 'ActiveProfile', new GLib.Variant('s', profile)]),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
        } catch (e) {
            console.warn('[WaveTopBar] Could not set power profile:', e);
        }
    }

    _registerMenu(menu) {
        menu.actor.add_style_class_name('wave-popup-menu');
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);

        menu.connect('open-state-changed', (m, isOpen) => {
            if (!isOpen) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                    if (this._panelTracker) {
                        if (!this._isMouseInBarArea()) {
                            this._startHideDebounce();
                        }
                    } else {
                        this._scheduleCheck();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        menu.open();
    }

    _showBatteryMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._batteryBtn, 0.5, St.Side.TOP);
        this._batteryMenu = menu;

        // Header: Battery percentage
        const header = new PopupMenu.PopupMenuItem(_(`Batería: ${this._batteryPercentage}%`), { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Performance profiles list (Clean text without emojis)
        const activeProfile = this._getPowerProfile();

        const profiles = [
            { id: 'power-saver', label: _('Ahorro de energía') },
            { id: 'balanced', label: _('Equilibrado') },
            { id: 'performance', label: _('Alto rendimiento') },
        ];

        for (const p of profiles) {
            const isCurrent = activeProfile === p.id;
            const mark = isCurrent ? '  ✓' : '';
            const item = new PopupMenu.PopupMenuItem(`${p.label}${mark}`);
            item.connect('activate', () => {
                this._setPowerProfile(p.id);
            });
            menu.addMenuItem(item);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const powerSettingsItem = new PopupMenu.PopupMenuItem(_('Configuración de Energía...'));
        powerSettingsItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center power');
        });
        menu.addMenuItem(powerSettingsItem);

        menu.connect('destroy', () => {
            if (this._batteryMenu === menu)
                this._batteryMenu = null;
        });

        this._registerMenu(menu);
    }

    _showClockMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._clockBtn, 0.9, St.Side.TOP);
        this._clockMenu = menu;

        const now = GLib.DateTime.new_now_local();
        const dateStr = now.format('%A, %d de %B de %Y') || now.format('%x');
        const header = new PopupMenu.PopupMenuItem(dateStr, { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const calItem = new PopupMenu.PopupMenuItem(_('Abrir Calendario'));
        calItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-calendar');
        });
        menu.addMenuItem(calItem);

        const dtSettingsItem = new PopupMenu.PopupMenuItem(_('Configuración de Fecha y Hora...'));
        dtSettingsItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center system datetime');
        });
        menu.addMenuItem(dtSettingsItem);

        menu.connect('destroy', () => {
            if (this._clockMenu === menu)
                this._clockMenu = null;
        });

        this._registerMenu(menu);
    }

    _toggleControlCenter() {
        this._closeAllMenus();

        if (Main.panel.statusArea && Main.panel.statusArea.quickSettings) {
            const qs = Main.panel.statusArea.quickSettings;
            const menu = qs.menu;

            if (menu._boxPointer) {
                menu.sourceActor = this._controlCenterBtn;
                menu._boxPointer.setPosition(this._controlCenterBtn, 0.5);
                menu._boxPointer.add_style_class_name('wave-popup-menu');
            }

            if (!this._qsMenuStateSignalId) {
                this._qsMenuStateSignalId = menu.connect('open-state-changed', (m, isOpen) => {
                    if (!isOpen) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                            if (this._panelTracker) {
                                if (!this._isMouseInBarArea()) {
                                    this._startHideDebounce();
                                }
                            } else {
                                this._scheduleCheck();
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });
            }

            menu.toggle();
        }
    }

    _applyBlur() {
        if (!this._topBarBg)
            return;

        // Shell.BlurEffect with Shell.BlurMode.BACKGROUND causes severe dirty-rect
        // scissor clipping and backbuffer blit artifacts (stale boxes around buttons and labels)
        // in Mutter/GNOME Shell Wayland compositing.
        // We safely remove any existing Shell.BlurEffect to guarantee 100% glitch-free rendering.
        if (this._blurEffect) {
            try {
                this._topBarBg.remove_effect_by_name('topbar-blur');
            } catch (e) {
                // ignore
            }
            this._blurEffect = null;
        }

        const isAcrylic = this._settings.get_boolean('bar-blur');
        if (isAcrylic) {
            this._topBarBg.add_style_class_name('wave-topbar-acrylic');
        } else {
            this._topBarBg.remove_style_class_name('wave-topbar-acrylic');
        }

        this._updateTheme();
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
        const configured = this._settings ? (this._settings.get_string('bar-color') || 'auto') : 'auto';
        if (configured === 'auto') {
            return this._isSystemDark() ? 'dark' : 'light';
        }
        return configured;
    }

    _updateTheme() {
        if (!this._topBar)
            return;

        const height = this._settings.get_int('bar-height') || 26;
        this._barHeight = height;
        this._topBar.height = height;
        this._updateBarPosition();

        const isFloating = this._settings.get_boolean('floating-bar');
        if (isFloating) {
            this._topBar.add_style_class_name('wave-topbar-floating');
        } else {
            this._topBar.remove_style_class_name('wave-topbar-floating');
        }

        const opacitySetting = (this._settings.get_int('bar-opacity') || 60) / 100.0;
        const colorMode = this._getEffectiveColorMode();
        const isAcrylic = this._settings.get_boolean('bar-blur');

        let r = 20, g = 20, b = 26;
        let effectiveOpacity = Math.max(0.15, Math.min(0.95, opacitySetting));

        if (colorMode === 'light') {
            r = 246; g = 246; b = 250;
        } else if (colorMode === 'black') {
            r = 8; g = 8; b = 10;
        } else if (colorMode === 'custom') {
            const hex = this._settings.get_string('bar-custom-color') || '#18181c';
            const parsed = this._hexToRgb(hex);
            if (parsed) {
                r = parsed.r; g = parsed.g; b = parsed.b;
            }
        }

        const isLightMode = (r * 0.299 + g * 0.587 + b * 0.114) > 160;
        this._isLightMode = isLightMode;
        const fgColor = isLightMode ? '#161618' : '#ffffff';

        // macOS Acrylic Glassmorphism styling (clean bottom separation border only, no top highlights)
        const borderColor = isLightMode ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.14)';

        this._topBar.style = `
            height: ${height}px;
            min-height: ${height}px;
            max-height: ${height}px;
        `;

        if (this._topBarBg) {
            let bgStyle = `
                background-color: rgba(${r}, ${g}, ${b}, ${effectiveOpacity});
                height: ${height}px;
                min-height: ${height}px;
                max-height: ${height}px;
            `;

            if (isAcrylic) {
                if (isFloating) {
                    bgStyle += `
                        border: 1px solid ${borderColor};
                        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.38);
                    `;
                } else {
                    bgStyle += `
                        border: none;
                        border-bottom: 1px solid ${borderColor};
                        box-shadow: none;
                    `;
                }
            } else {
                if (isFloating) {
                    bgStyle += `
                        border: none;
                        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
                    `;
                } else {
                    bgStyle += `
                        border: none;
                        border-bottom: none;
                        box-shadow: none;
                    `;
                }
            }

            this._topBarBg.style = bgStyle;
        }

        if (this._contentBox) {
            this._contentBox.style = `
                color: ${fgColor};
                text-shadow: none;
                height: ${height}px;
                min-height: ${height}px;
                max-height: ${height}px;
            `;
        }

        if (this._batteryDrawing) {
            this._batteryDrawing.queue_repaint();
        }
    }

    _hexToRgb(hex) {
        const cleaned = hex.replace('#', '');
        if (cleaned.length === 6) {
            return {
                r: parseInt(cleaned.substring(0, 2), 16),
                g: parseInt(cleaned.substring(2, 4), 16),
                b: parseInt(cleaned.substring(4, 6), 16),
            };
        }
        return null;
    }

    _updateVisibility() {
        if (!this._topBar)
            return;

        const showSys = this._settings.get_boolean('show-system-menu');
        const showApp = this._settings.get_boolean('show-active-app');
        const showSpot = this._settings.get_boolean('show-spotlight');
        const showWifi = this._settings.get_boolean('show-wifi');
        const showBt = this._settings.get_boolean('show-bluetooth');
        const showBat = this._settings.get_boolean('show-battery');
        const showCC = this._settings.get_boolean('show-control-center');
        const showClock = this._settings.get_boolean('show-clock');

        if (this._logoBtn) this._logoBtn.visible = showSys;
        if (this._activeAppBtn) this._activeAppBtn.visible = showApp;
        if (this._spotlightBtn) this._spotlightBtn.visible = showSpot;
        if (this._wifiBtn) this._wifiBtn.visible = showWifi;
        if (this._bluetoothBtn) this._bluetoothBtn.visible = showBt;
        if (this._batteryBtn) this._batteryBtn.visible = showBat;
        if (this._controlCenterBtn) this._controlCenterBtn.visible = showCC;
        if (this._clockBtn) this._clockBtn.visible = showClock;
    }

    _updateActiveApp() {
        if (!this._activeAppLabel)
            return;

        const focusWin = global.display.focus_window;
        if (!focusWin || focusWin.is_skip_taskbar()) {
            this._activeAppLabel.text = _('Escritorio');
            return;
        }

        const tracker = Shell.WindowTracker.get_default();
        let app = tracker.get_window_app(focusWin);
        if (!app && typeof tracker.get_app_from_pid === 'function') {
            try {
                const pid = focusWin.get_pid();
                if (pid) {
                    app = tracker.get_app_from_pid(pid);
                }
            } catch (e) {
                // ignore
            }
        }

        if (app && app.get_name()) {
            this._activeAppLabel.text = app.get_name();
        } else {
            const title = focusWin.get_title();
            this._activeAppLabel.text = title || _('Aplicación');
        }
    }

    _startClockTimer() {
        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateClock() {
        if (!this._clockLabel)
            return;

        const now = GLib.DateTime.new_now_local();
        const formatStr = this._settings.get_string('clock-format') || '%a %d %b  %H:%M';

        let formatted = now.format(formatStr);
        if (!formatted) {
            formatted = now.format('%H:%M');
        }
        this._clockLabel.text = formatted;
    }

    _showSystemMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._logoBtn, 0.0, St.Side.TOP);
        this._systemMenu = menu;

        // Header
        const header = new PopupMenu.PopupMenuItem(_('Fedora Linux'), { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const aboutItem = new PopupMenu.PopupMenuItem(_('Acerca de este equipo'));
        aboutItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center system');
        });
        menu.addMenuItem(aboutItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Configuración del sistema...'));
        settingsItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center');
        });
        menu.addMenuItem(settingsItem);

        const waveSettingsItem = new PopupMenu.PopupMenuItem(_('Configuración de Wave Top Bar...'));
        waveSettingsItem.connect('activate', () => {
            this._openPreferences();
        });
        menu.addMenuItem(waveSettingsItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Safe Native GNOME Actions (Crash-Proof via SystemActions)
        const lockItem = new PopupMenu.PopupMenuItem(_('Bloquear pantalla'));
        lockItem.connect('activate', () => {
            this._systemActions.activateLockScreen();
        });
        menu.addMenuItem(lockItem);

        const logoutItem = new PopupMenu.PopupMenuItem(_('Cerrar sesión...'));
        logoutItem.connect('activate', () => {
            this._systemActions.activateLogout();
        });
        menu.addMenuItem(logoutItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const suspendItem = new PopupMenu.PopupMenuItem(_('Suspender'));
        suspendItem.connect('activate', () => {
            this._systemActions.activateSuspend();
        });
        menu.addMenuItem(suspendItem);

        const rebootItem = new PopupMenu.PopupMenuItem(_('Reiniciar...'));
        rebootItem.connect('activate', () => {
            this._systemActions.activateRestart();
        });
        menu.addMenuItem(rebootItem);

        const powerItem = new PopupMenu.PopupMenuItem(_('Apagar equipo...'));
        powerItem.connect('activate', () => {
            this._systemActions.activatePowerOff();
        });
        menu.addMenuItem(powerItem);

        menu.connect('destroy', () => {
            if (this._systemMenu === menu)
                this._systemMenu = null;
        });

        this._registerMenu(menu);
    }

    _showActiveAppMenu() {
        this._closeAllMenus();

        const focusWin = global.display.focus_window;
        const app = focusWin ? Shell.WindowTracker.get_default().get_window_app(focusWin) : null;
        const appName = app ? app.get_name() : (focusWin ? focusWin.get_title() : _('Escritorio'));

        const menu = new PopupMenu.PopupMenu(this._activeAppBtn, 0.0, St.Side.TOP);
        this._appMenu = menu;

        const header = new PopupMenu.PopupMenuItem(appName, { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (focusWin && app) {
            const minimizeItem = new PopupMenu.PopupMenuItem(_('Minimizar'));
            minimizeItem.connect('activate', () => {
                focusWin.minimize();
            });
            menu.addMenuItem(minimizeItem);

            const quitItem = new PopupMenu.PopupMenuItem(_(`Salir de ${appName}`));
            quitItem.connect('activate', () => {
                app.request_quit();
            });
            menu.addMenuItem(quitItem);
        } else {
            const overviewItem = new PopupMenu.PopupMenuItem(_('Mostrar aplicaciones'));
            overviewItem.connect('activate', () => {
                Main.overview.show(2);
            });
            menu.addMenuItem(overviewItem);
        }

        menu.connect('destroy', () => {
            if (this._appMenu === menu)
                this._appMenu = null;
        });

        this._registerMenu(menu);
    }

    _showContextMenu(clickX, clickY) {
        this._closeAllMenus();

        const monitor = Main.layoutManager.primaryMonitor;
        const monX = monitor ? monitor.x : 0;
        const monY = monitor ? monitor.y : 0;
        const barHeight = this._barHeight || 26;

        const posX = (clickX !== undefined && clickX !== null) ? clickX : (monX + (monitor ? monitor.width / 2 : 500));
        const posY = (clickY !== undefined && clickY !== null) ? clickY : (monY + barHeight);

        if (this._contextAnchor) {
            try { this._contextAnchor.destroy(); } catch (e) {}
            this._contextAnchor = null;
        }

        this._contextAnchor = new St.Widget({
            name: 'wave-context-anchor',
            width: 2,
            height: 2,
            opacity: 0,
            reactive: false,
        });
        Main.uiGroup.add_child(this._contextAnchor);
        this._contextAnchor.set_position(posX, posY);

        const menu = new PopupMenu.PopupMenu(this._contextAnchor, 0.5, St.Side.TOP);
        this._contextMenu = menu;

        const header = new PopupMenu.PopupMenuItem(_('Wave Top Bar'), { reactive: false });
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem(_('Configuración de Wave Top Bar...'));
        prefsItem.connect('activate', () => this._openPreferences());
        menu.addMenuItem(prefsItem);

        const sysSettingsItem = new PopupMenu.PopupMenuItem(_('Configuración del Sistema...'));
        sysSettingsItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center');
        });
        menu.addMenuItem(sysSettingsItem);

        menu.connect('destroy', () => {
            if (this._contextMenu === menu)
                this._contextMenu = null;
            if (this._contextAnchor) {
                try { this._contextAnchor.destroy(); } catch (e) {}
                this._contextAnchor = null;
            }
        });

        this._registerMenu(menu);
    }

    _openPreferences() {
        try {
            this.openPreferences();
        } catch (e) {
            GLib.spawn_command_line_async('gnome-extensions prefs wave-topbar@demonc');
        }
    }

    // --- SPOTLIGHT FILE & APP SEARCH ---
    _toggleSpotlight() {
        if (this._spotlightDialog) {
            this._closeSpotlight();
        } else {
            this._openSpotlight();
        }
    }

    _openSpotlight() {
        this._closeAllMenus();

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        // Background shield
        this._spotlightShield = new St.Widget({
            style_class: 'wave-spotlight-shield',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });
        this._spotlightShield.connect('button-press-event', () => {
            this._closeSpotlight();
            return Clutter.EVENT_STOP;
        });
        Main.uiGroup.add_child(this._spotlightShield);

        // Spotlight window container (Clutter.Orientation.VERTICAL)
        const winWidth = 580;
        const xPos = monitor.x + Math.floor((monitor.width - winWidth) / 2);
        const yPos = monitor.y + 70;

        this._spotlightDialog = new St.BoxLayout({
            name: 'wave-spotlight-dialog',
            style_class: 'wave-spotlight-window',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x: xPos,
            y: yPos,
            width: winWidth,
        });
        Main.uiGroup.add_child(this._spotlightDialog);

        // Search Input Box
        const entryBox = new St.BoxLayout({
            style_class: 'wave-spotlight-entry-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        const icon = new St.Icon({
            icon_name: 'system-search-symbolic',
            fallback_icon_name: 'edit-find-symbolic',
            icon_size: 16,
            style_class: 'wave-spotlight-search-icon',
        });
        entryBox.add_child(icon);

        this._spotlightEntry = new St.Entry({
            style_class: 'wave-spotlight-entry',
            hint_text: _('Buscar archivos, carpetas o aplicaciones...'),
            can_focus: true,
            x_expand: true,
        });
        entryBox.add_child(this._spotlightEntry);
        this._spotlightDialog.add_child(entryBox);

        // Results Container directly inside dialog (clean layout without ScrollView overlap)
        this._spotlightResultsBox = new St.BoxLayout({
            style_class: 'wave-spotlight-results',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._spotlightDialog.add_child(this._spotlightResultsBox);

        // Input events
        this._spotlightEntry.clutter_text.connect('text-changed', () => {
            if (this._spotlightSearchTimeout) {
                GLib.source_remove(this._spotlightSearchTimeout);
                this._spotlightSearchTimeout = 0;
            }
            this._spotlightSearchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._spotlightSearchTimeout = 0;
                this._executeSpotlightSearch(this._spotlightEntry.get_text().trim());
                return GLib.SOURCE_REMOVE;
            });
        });

        this._spotlightEntry.clutter_text.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this._closeSpotlight();
                return Clutter.EVENT_STOP;
            } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                this._activateFirstSpotlightResult();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Focus text entry
        this._spotlightEntry.grab_key_focus();

        // Initial default results
        this._executeSpotlightSearch('');
    }

    _closeSpotlight() {
        if (this._spotlightSearchTimeout) {
            GLib.source_remove(this._spotlightSearchTimeout);
            this._spotlightSearchTimeout = 0;
        }

        if (this._spotlightDialog) {
            Main.uiGroup.remove_child(this._spotlightDialog);
            this._spotlightDialog.destroy();
            this._spotlightDialog = null;
        }

        if (this._spotlightShield) {
            Main.uiGroup.remove_child(this._spotlightShield);
            this._spotlightShield.destroy();
            this._spotlightShield = null;
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (this._panelTracker) {
                if (!this._isMouseInBarArea()) {
                    this._startHideDebounce();
                }
            } else {
                this._scheduleCheck();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _executeSpotlightSearch(query) {
        if (!this._spotlightResultsBox)
            return;

        this._spotlightResultsBox.destroy_all_children();
        const results = [];
        const queryLower = (query || '').toLowerCase();

        // 1. Search Applications (up to 3 without query, up to 4 with query)
        try {
            const appSys = Shell.AppSystem.get_default();
            const apps = appSys.get_installed();
            for (const app of apps) {
                const name = app.get_name();
                if (!name) continue;
                if (!query || name.toLowerCase().includes(queryLower)) {
                    results.push({
                        type: 'app',
                        title: name,
                        subtitle: app.get_description() || _('Aplicación'),
                        icon: app.get_icon(),
                        action: () => {
                            const shellApp = appSys.lookup_app(app.get_id());
                            if (shellApp) shellApp.activate();
                            else app.launch([], null);
                        },
                        openFolder: null,
                    });
                    if (results.length >= 3 && !query) break;
                    if (results.length >= 4) break;
                }
            }
        } catch (e) {
            // ignore
        }

        // 2. Search Recent Files via GLib.BookmarkFile
        try {
            const recentPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
            if (GLib.file_test(recentPath, GLib.FileTest.EXISTS)) {
                const bf = new GLib.BookmarkFile();
                bf.load_from_file(recentPath);
                const uris = bf.get_uris();
                for (const uri of uris) {
                    try {
                        const [filePath] = GLib.filename_from_uri(uri);
                        if (!filePath) continue;
                        const baseName = GLib.path_get_basename(filePath);
                        if (!query || baseName.toLowerCase().includes(queryLower)) {
                            // Avoid duplicates
                            if (results.some(r => r.title === baseName)) continue;

                            const file = Gio.File.new_for_path(filePath);
                            const info = file.query_info('standard::icon,standard::display-name', Gio.FileQueryInfoFlags.NONE, null);
                            const icon = info ? info.get_icon() : null;
                            const parentDir = GLib.path_get_dirname(filePath);

                            results.push({
                                type: 'file',
                                title: baseName,
                                subtitle: parentDir.replace(GLib.get_home_dir(), '~'),
                                icon: icon,
                                action: () => Gio.AppInfo.launch_default_for_uri(uri, null),
                                openFolder: () => GLib.spawn_command_line_async(`nautilus "${parentDir}"`),
                            });
                            if (results.length >= (query ? 6 : 4)) break;
                        }
                    } catch (e) {
                        // ignore broken uri
                    }
                }
            }
        } catch (e) {
            // ignore
        }

        // 3. Search User Files on Disk if query is provided
        if (query && results.length < 7) {
            try {
                const home = GLib.get_home_dir();
                const searchDirs = ['Documentos', 'Descargas', 'Imágenes', 'Vídeos', 'Música', 'Escritorio']
                    .map(d => `"${home}/${d}"`)
                    .join(' ');

                const cmd = `find ${searchDirs} -maxdepth 3 -iname "*${query}*" 2>/dev/null | head -n 6`;
                const [ok, stdout] = GLib.spawn_command_line_sync(cmd);
                if (ok && stdout) {
                    const lines = new TextDecoder().decode(stdout).trim().split('\n');
                    for (const line of lines) {
                        const filePath = line.trim();
                        if (!filePath) continue;
                        const baseName = GLib.path_get_basename(filePath);
                        const parentDir = GLib.path_get_dirname(filePath);

                        // Avoid duplicates
                        if (results.some(r => r.title === baseName)) continue;

                        const file = Gio.File.new_for_path(filePath);
                        let icon = null;
                        try {
                            const info = file.query_info('standard::icon', Gio.FileQueryInfoFlags.NONE, null);
                            icon = info?.get_icon();
                        } catch (e) {
                            // ignore
                        }

                        results.push({
                            type: 'file',
                            title: baseName,
                            subtitle: parentDir.replace(home, '~'),
                            icon: icon,
                            action: () => Gio.AppInfo.launch_default_for_uri(file.get_uri(), null),
                            openFolder: () => GLib.spawn_command_line_async(`nautilus "${parentDir}"`),
                        });
                        if (results.length >= 7) break;
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        // Render Results
        this._firstSpotlightAction = results.length > 0 ? results[0].action : null;

        if (results.length === 0) {
            const noResultsLabel = new St.Label({
                text: query ? _('No se encontraron archivos o aplicaciones.') : _('Empieza a escribir para buscar...'),
                style_class: 'wave-spotlight-item-path',
                style: 'padding: 16px; text-align: center;',
            });
            this._spotlightResultsBox.add_child(noResultsLabel);
            return;
        }

        for (const item of results) {
            const row = new St.Button({
                style_class: 'wave-spotlight-item',
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });

            const rowBox = new St.BoxLayout({
                style_class: 'wave-spotlight-item-box',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });

            const iconActor = new St.Icon({
                gicon: item.icon,
                fallback_icon_name: item.type === 'app' ? 'application-x-executable-symbolic' : 'text-x-generic-symbolic',
                icon_size: 20,
                style_class: 'wave-spotlight-item-icon',
            });
            rowBox.add_child(iconActor);

            const textBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                style_class: 'wave-spotlight-text-box',
            });
            const titleLabel = new St.Label({
                text: item.title,
                style_class: 'wave-spotlight-item-title',
            });
            const subLabel = new St.Label({
                text: item.subtitle,
                style_class: 'wave-spotlight-item-path',
            });
            textBox.add_child(titleLabel);
            textBox.add_child(subLabel);
            rowBox.add_child(textBox);

            // Folder open button
            if (item.openFolder) {
                const folderBtn = new St.Button({
                    style_class: 'wave-spotlight-folder-btn',
                    can_focus: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const folderIcon = new St.Icon({
                    icon_name: 'folder-symbolic',
                    icon_size: 14,
                });
                folderBtn.set_child(folderIcon);
                folderBtn.connect('clicked', () => {
                    item.openFolder();
                    this._closeSpotlight();
                });
                rowBox.add_child(folderBtn);
            }

            row.set_child(rowBox);
            row.connect('clicked', () => {
                item.action();
                this._closeSpotlight();
            });

            this._spotlightResultsBox.add_child(row);
        }
    }

    _activateFirstSpotlightResult() {
        if (this._firstSpotlightAction) {
            this._firstSpotlightAction();
            this._closeSpotlight();
        }
    }

    _closeAllMenus() {
        this._closeSpotlight();

        if (this._contextAnchor) {
            try { this._contextAnchor.destroy(); } catch (e) {}
            this._contextAnchor = null;
        }

        if (this._systemMenu) {
            this._systemMenu.close();
            this._systemMenu.destroy();
            this._systemMenu = null;
        }
        if (this._appMenu) {
            this._appMenu.close();
            this._appMenu.destroy();
            this._appMenu = null;
        }
        if (this._batteryMenu) {
            this._batteryMenu.close();
            this._batteryMenu.destroy();
            this._batteryMenu = null;
        }
        if (this._clockMenu) {
            this._clockMenu.close();
            this._clockMenu.destroy();
            this._clockMenu = null;
        }
        if (this._contextMenu) {
            this._contextMenu.close();
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
    }

    // --- ZEN TOP BAR PROVEN AUTO-HIDE ARCHITECTURE ---
    _updateBarPosition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._topBar)
            return;

        const barHeight = this._barHeight || 26;
        this._topBar.set_position(monitor.x, monitor.y);
        this._topBar.set_size(monitor.width, barHeight);
    }

    _updateTopBarStruts(autohideEnabled) {
        if (!this._topBar)
            return;

        try {
            const idx = Main.layoutManager._findActor(this._topBar);
            if (idx !== -1) {
                const data = Main.layoutManager._trackedActors[idx];
                const affects = !autohideEnabled;
                if (data && data.affectsStruts !== affects) {
                    data.affectsStruts = affects;
                    Main.layoutManager._queueUpdateRegions();
                }
            }
        } catch (e) {
            // ignore
        }
    }

    _trackFocusWindow() {
        if (this._focusWin) {
            this._focusWin.disconnectObject(this);
            this._focusWin = null;
        }

        this._updateActiveApp();

        const win = global.display.focus_window;
        if (!win || win.is_skip_taskbar()) {
            this._checkWin();
            return;
        }

        this._focusWin = win;
        this._focusWin.connectObject(
            'notify::title', () => this._updateActiveApp(),
            'position-changed', () => this._scheduleCheck(),
            'size-changed', () => this._scheduleCheck(),
            'unmanaged', () => {
                this._focusWin?.disconnectObject(this);
                this._focusWin = null;
                this._updateActiveApp();
                this._scheduleCheck();
            },
            this
        );

        this._updateActiveApp();
        this._scheduleCheck();
    }

    _scheduleCheck() {
        if (this._checkDebounceId) {
            GLib.source_remove(this._checkDebounceId);
            this._checkDebounceId = 0;
        }
        this._checkDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._checkDebounceId = 0;
            this._checkWin();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkWin() {
        if (!this._topBar || !this._settings)
            return;

        if (Main.overview.visible) {
            this._userForced = false;
            this._stopPointerWatch();
            this._teardownEdgeTracker();
            this._hideTopBarAnimated();
            return;
        }

        const autohide = this._settings.get_boolean('autohide-in-fullscreen-or-maximized');
        if (!autohide) {
            this._userForced = false;
            this._stopPointerWatch();
            this._teardownEdgeTracker();
            this._showTopBarAnimated();
            return;
        }

        if (!this._focusWin) {
            this._userForced = false;
            this._stopPointerWatch();
            this._teardownEdgeTracker();
            this._showTopBarAnimated();
            return;
        }

        const activeWS = global.workspace_manager.get_active_workspace_index();
        const winWS = this._focusWin.get_workspace()?.index();
        if (activeWS !== winWS)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._focusWin.get_monitor() !== monitor.index) {
            this._userForced = false;
            this._stopPointerWatch();
            this._teardownEdgeTracker();
            this._showTopBarAnimated();
            return;
        }

        const rect = this._focusWin.get_frame_rect();
        const isFS = this._focusWin.fullscreen || (typeof this._focusWin.is_fullscreen === 'function' && this._focusWin.is_fullscreen());
        const isMax = (this._focusWin.maximized_vertically && this._focusWin.maximized_horizontally) ||
                      this._focusWin.maximized_vertically ||
                      (typeof this._focusWin.is_maximized === 'function' && this._focusWin.is_maximized());
        const isNearTop = rect ? (rect.y < (monitor.y + this._barHeight)) : false;

        if (isFS || isMax || isNearTop) {
            if (this._userForced)
                return;
            this._hideTopBarAnimated();
            this._setupEdgeTracker();
        } else {
            this._userForced = false;
            this._stopPointerWatch();
            this._showTopBarAnimated();
            this._teardownEdgeTracker();
        }
    }

    _setupEdgeTracker() {
        if (this._edgeTracker || Main.overview.visible)
            return;

        this._edgeTracker = new PointerTracker(60, (x, y) => {
            if (Main.overview.visible)
                return;

            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return;

            const relativeY = y - monitor.y;
            // Within 2px of the top edge -> reveal top bar
            if (relativeY <= 2 && !this._waitingForEdgeHit) {
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
        if (Main.overview.visible)
            return;

        this._teardownEdgeTracker();
        this._userForced = true;
        this._showTopBarAnimated();
        this._startPointerWatch();
    }

    _startPointerWatch() {
        if (this._panelTracker)
            return;

        this._panelTracker = new PointerTracker(60, (_x, y) => {
            this._onPointerMove(y);
        });
    }

    _stopPointerWatch() {
        if (this._panelTracker) {
            this._panelTracker.destroy();
            this._panelTracker = null;
        }
        this._clearHideDebounce();
    }

    _onPointerMove(y) {
        if (this._isBarHidden) {
            this._stopPointerWatch();
            return;
        }

        if (this._isAnyMenuOpen()) {
            this._clearHideDebounce();
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const relativeY = y - monitor.y;
        const HIDE_MARGIN_PX = 10;

        if (relativeY < (this._barHeight + HIDE_MARGIN_PX)) {
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

            if (this._isMouseInBarArea() || this._isAnyMenuOpen()) {
                return GLib.SOURCE_REMOVE;
            }

            this._userForced = false;
            this._hideTopBarAnimated();
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

    _isMouseInBarArea() {
        const [, y] = global.get_pointer();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        const relativeY = y - monitor.y;
        return relativeY < (this._barHeight + 10);
    }

    _isPointerOnBar() {
        return this._isMouseInBarArea();
    }

    _shouldAutoHide() {
        if (Main.overview.visible)
            return true;
        if (!this._settings || !this._settings.get_boolean('autohide-in-fullscreen-or-maximized'))
            return false;
        if (!this._focusWin)
            return false;
        const rect = this._focusWin.get_frame_rect();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this._focusWin.get_monitor() !== monitor.index)
            return false;
        const isFS = this._focusWin.fullscreen || (typeof this._focusWin.is_fullscreen === 'function' && this._focusWin.is_fullscreen());
        const isMax = (this._focusWin.maximized_vertically && this._focusWin.maximized_horizontally) ||
                      this._focusWin.maximized_vertically ||
                      (typeof this._focusWin.is_maximized === 'function' && this._focusWin.is_maximized());
        const isNearTop = rect ? (rect.y < (monitor.y + (this._barHeight || 26))) : false;
        return Boolean(isFS || isMax || isNearTop);
    }

    _scheduleHideTopBar(_delayMs = 250) {
        this._startHideDebounce();
    }

    _isAnyMenuOpen() {
        return Boolean(
            (this._menuManager && this._menuManager.activeMenu) ||
            (this._contextMenu && this._contextMenu.isOpen) ||
            (this._spotlightDialog !== null) ||
            (Main.panel.statusArea?.quickSettings?.menu?.isOpen)
        );
    }

    _clearButtonsHover() {
        if (global.stage.key_focus && this._topBar && this._topBar.contains(global.stage.key_focus)) {
            global.stage.key_focus = null;
        }

        const btns = [
            this._logoBtn,
            this._activeAppBtn,
            this._spotlightBtn,
            this._wifiBtn,
            this._bluetoothBtn,
            this._batteryBtn,
            this._controlCenterBtn,
            this._clockBtn,
        ];
        for (const btn of btns) {
            if (btn) {
                try {
                    btn.hover = false;
                } catch (e) {
                    // ignore
                }
            }
        }
        if (this._topBar) {
            try {
                this._topBar.hover = false;
            } catch (e) {
                // ignore
            }
        }
    }

    _showTopBarAnimated() {
        if (!this._topBar)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const targetY = monitor ? monitor.y : 0;

        this._isBarHidden = false;
        this._topBar.remove_all_transitions();
        this._topBar.ease({
            y: targetY,
            opacity: 255,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideTopBarAnimated() {
        if (!this._topBar || this._isBarHidden)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const barHeight = this._barHeight || 26;
        const targetY = (monitor ? monitor.y : 0) - barHeight;

        this._isBarHidden = true;
        this._clearButtonsHover();
        this._topBar.remove_all_transitions();
        this._topBar.ease({
            y: targetY,
            opacity: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    disable() {
        if (this.enableUnredirect != null) {
            global.compositor.enable_unredirect = this.enableUnredirect;
            this.enableUnredirect = null;
        }

        if (this._clockTimeoutId) {
            GLib.source_remove(this._clockTimeoutId);
            this._clockTimeoutId = 0;
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

        this._closeAllMenus();

        if (this._contextAnchor) {
            try { this._contextAnchor.destroy(); } catch (e) {}
            this._contextAnchor = null;
        }

        if (this._qsMenuStateSignalId && Main.panel.statusArea?.quickSettings?.menu) {
            try {
                Main.panel.statusArea.quickSettings.menu.disconnect(this._qsMenuStateSignalId);
            } catch (e) {
                // ignore
            }
            this._qsMenuStateSignalId = 0;
        }

        global.display.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);

        if (this._nmClient) {
            this._nmClient.disconnectObject(this);
            this._nmClient = null;
        }

        if (this._btClient) {
            this._btClient.disconnectObject(this);
            this._btClient = null;
        }

        this._upowerProxy = null;
        this._powerProfilesProxy = null;

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

        // Restore sourceActor on quickSettings menu if modified
        if (Main.panel.statusArea?.quickSettings?.menu) {
            Main.panel.statusArea.quickSettings.menu.sourceActor = Main.panel.statusArea.quickSettings;
        }

        // Remove blur effect
        if (this._blurEffect && this._topBarBg) {
            try {
                this._topBarBg.remove_effect_by_name('topbar-blur');
            } catch (e) {
                // ignore
            }
            this._blurEffect = null;
        }

        // Remove custom top bar from chrome
        if (this._topBar) {
            this._topBar.remove_all_transitions();
            try {
                Main.layoutManager.removeChrome(this._topBar);
                this._topBar.destroy();
            } catch (e) {
                // ignore
            }
            this._topBar = null;
            this._topBarBg = null;
            this._contentBox = null;
            this._batteryDrawing = null;
        }

        // Restore panelBox struts
        const panelBoxIdx = Main.layoutManager._findActor(Main.layoutManager.panelBox);
        if (panelBoxIdx !== -1 && this._origPanelBoxAffectsStruts !== undefined) {
            Main.layoutManager._trackedActors[panelBoxIdx].affectsStruts = this._origPanelBoxAffectsStruts;
            Main.layoutManager._queueUpdateRegions();
        }

        // Restore native GNOME panel
        Main.panel.visible = this._origPanelVisible ?? true;
        Main.panel.opacity = this._origPanelOpacity ?? 255;
        Main.panel.reactive = this._origPanelReactive ?? true;
    }
}
