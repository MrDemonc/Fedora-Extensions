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
import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { PointerTracker } from './pointerTracker.js';
import Gvc from 'gi://Gvc';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

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
        this._volumeMenu = null;
        this._notificationsMenu = null;
        this._notificationsListBox = null;
        this._clockMenu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        // Notifications state & banner placement
        this._notificationsBtn = null;
        this._notificationsIcon = null;
        this._notificationsBadge = null;
        this._trackedSources = null;
        this._notifSignals = [];
        this._origUpdateShowingNotification = null;
        this._origBannerBinXAlign = null;
        this._origBannerBinMarginRight = null;

        // Audio mixer control state
        this._audioControl = null;
        this._audioControlSignals = [];
        this._currentSink = null;
        this._currentSource = null;
        this._sinkSignals = [];
        this._sourceSignals = [];
        this._isDraggingOutputSlider = false;
        this._isDraggingInputSlider = false;
        this._syncingVolumeUI = false;

        try {
            this._audioControl = getMixerControl();
            this._setupAudioListeners();
        } catch (e) {
            console.warn('[WaveTopBar] Error initializing audio mixer control:', e);
        }

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
            'in-fullscreen-changed', () => this._scheduleCheck(),
            'window-created', () => this._scheduleCheck(),
            'restacked', () => this._scheduleCheck(),
            this
        );

        global.window_manager.connectObject(
            'size-changed', () => this._scheduleCheck(),
            'minimize', () => {
                this._updateActiveApp();
                this._scheduleCheck();
            },
            'unminimize', () => {
                this._updateActiveApp();
                this._scheduleCheck();
            },
            'destroy', () => {
                this._updateActiveApp();
                this._scheduleCheck();
            },
            'map', () => {
                this._updateActiveApp();
                this._scheduleCheck();
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
            'changed::show-volume', () => this._updateVisibility(),
            'changed::show-battery', () => this._updateVisibility(),
            'changed::show-notifications', () => this._updateVisibility(),
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

        // Notification Center & Banner placement
        this._setupNotificationBanners();
        this._setupNotificationTracking();
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
        this._wifiBtn.connect('clicked', () => this._toggleWifiMenu());
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

        // 6. Volume Status Button (Toggle menu + scroll to volume up/down)
        this._volumeBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._volumeIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 11,
            style_class: 'wave-topbar-icon wave-topbar-small-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volumeBtn.set_child(this._volumeIcon);
        this._volumeBtn.connect('clicked', () => this._toggleVolumeMenu());
        this._volumeBtn.connect('button-press-event', handleRightClick);
        this._volumeBtn.connect('scroll-event', (actor, event) => {
            const direction = event.get_scroll_direction();
            let delta = 0;
            if (direction === Clutter.ScrollDirection.UP) {
                delta = 0.05;
            } else if (direction === Clutter.ScrollDirection.DOWN) {
                delta = -0.05;
            } else if (direction === Clutter.ScrollDirection.SMOOTH) {
                const [, dy] = event.get_scroll_delta();
                delta = -dy * 0.05;
            }
            if (delta !== 0) {
                this._stepVolume(delta);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._rightBox.add_child(this._volumeBtn);

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

        // 6.5. Notifications Button (Symbolic Bell with Unread Badge)
        this._notificationsBtn = new St.Button({
            style_class: 'wave-topbar-btn wave-topbar-pill-btn',
            can_focus: false,
            track_hover: false,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        const notifBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 2px;',
        });
        this._notificationsIcon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            fallback_icon_name: 'notification-symbolic',
            icon_size: 13,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notificationsBadge = new St.Label({
            text: '',
            style_class: 'wave-topbar-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        notifBox.add_child(this._notificationsIcon);
        notifBox.add_child(this._notificationsBadge);
        this._notificationsBtn.set_child(notifBox);
        this._notificationsBtn.connect('clicked', () => this._toggleNotificationsMenu());
        this._notificationsBtn.connect('button-press-event', handleRightClick);
        this._rightBox.add_child(this._notificationsBtn);

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
        this._updateAudioIndicators();
        this._updateBatteryFromDBus();
    }

    _updateNetwork() {
        if (!this._wifiIcon || !this._nmClient)
            return;

        const isWireless = this._nmClient.wireless_enabled;
        const connectivity = this._nmClient.connectivity;
        const isConnected = connectivity === NM.ConnectivityState.FULL || connectivity === NM.ConnectivityState.LIMITED;

        if (isConnected) {
            const info = this._getActiveWifiInfo();
            const strength = info ? info.strength : 80;
            this._wifiIcon.icon_name = isWireless
                ? this._getSignalIconName(strength)
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

    _runCommandAsync(argv, callback) {
        try {
            const proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (obj, res) => {
                try {
                    const [, stdout, stderr] = obj.communicate_utf8_finish(res);
                    const exitCode = obj.get_if_exited() ? obj.get_exit_status() : (obj.get_successful() ? 0 : 1);
                    if (callback) callback(stdout || '', stderr || '', exitCode);
                } catch (e) {
                    if (callback) callback('', '', e);
                }
            });
        } catch (e) {
            if (callback) callback('', '', e);
        }
    }

    _getWifiDevice() {
        if (!this._nmClient) return null;
        for (const dev of this._nmClient.get_devices()) {
            if (dev.get_device_type() === NM.DeviceType.WIFI) {
                return dev;
            }
        }
        return null;
    }

    _getActiveWifiInfo() {
        const dev = this._getWifiDevice();
        if (!dev) return null;
        const ap = dev.get_active_access_point();
        if (!ap) return null;
        const raw = ap.get_ssid();
        const ssid = raw ? NM.utils_ssid_to_utf8(raw.get_data()) : '';
        const bitrate = Math.round(ap.get_max_bitrate() / 1000); // Mbps
        const freq = ap.get_frequency();
        const band = freq >= 5000 ? '5 GHz' : '2.4 GHz';
        const strength = ap.get_strength();
        const iface = dev.get_iface();
        const activeConn = dev.get_active_connection();
        const uuid = activeConn ? activeConn.get_uuid() : null;
        return { dev, ap, ssid, bitrate, freq, band, strength, iface, uuid };
    }

    _getSignalIconName(signal) {
        if (signal >= 80) return 'network-wireless-signal-excellent-symbolic';
        if (signal >= 55) return 'network-wireless-signal-good-symbolic';
        if (signal >= 30) return 'network-wireless-signal-ok-symbolic';
        if (signal >= 10) return 'network-wireless-signal-weak-symbolic';
        return 'network-wireless-signal-none-symbolic';
    }

    _readWifiThroughput(iface) {
        try {
            const file = Gio.File.new_for_path('/proc/net/dev');
            const [, contents] = file.load_contents(null);
            const text = new TextDecoder().decode(contents);
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith(iface + ':')) {
                    const parts = trimmed.substring(iface.length + 1).trim().split(/\s+/);
                    const rxBytes = parseInt(parts[0], 10) || 0;
                    const txBytes = parseInt(parts[8], 10) || 0;
                    const now = GLib.get_monotonic_time(); // microseconds
                    if (!this._lastThroughput) {
                        this._lastThroughput = { rx: rxBytes, tx: txBytes, time: now };
                        return { down: '0.0 KB/s', up: '0.0 KB/s' };
                    }
                    const dt = (now - this._lastThroughput.time) / 1000000; // seconds
                    if (dt <= 0) return { down: '0.0 KB/s', up: '0.0 KB/s' };

                    const rxRate = Math.max(0, (rxBytes - this._lastThroughput.rx) / dt);
                    const txRate = Math.max(0, (txBytes - this._lastThroughput.tx) / dt);
                    this._lastThroughput = { rx: rxBytes, tx: txBytes, time: now };

                    const formatRate = (bytes) => {
                        if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB/s';
                        return (bytes / 1024).toFixed(1) + ' KB/s';
                    };

                    return { down: formatRate(rxRate), up: formatRate(txRate) };
                }
            }
        } catch (e) {
            console.warn('[WaveTopBar] Error reading throughput:', e);
        }
        return { down: '0.0 KB/s', up: '0.0 KB/s' };
    }

    _toggleWifiMenu() {
        if (this._wifiMenu && this._wifiMenu.isOpen) {
            this._wifiMenu.close();
        } else {
            this._showWifiMenu();
        }
    }

    _showWifiMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._wifiBtn, 0.5, St.Side.TOP);
        this._wifiMenu = menu;
        menu.actor.add_style_class_name('wave-wifi-menu');
        menu.actor.width = 330;
        menu.actor.style = 'background-color: transparent !important; background: transparent !important; border: none !important; box-shadow: none !important;';

        const isLight = Boolean(this._isLightMode);
        menu.actor.add_style_class_name(isLight ? 'theme-light' : 'theme-dark');
        if (menu.box) {
            menu.box.add_style_class_name('wave-wifi-menu-content');
            menu.box.add_style_class_name(isLight ? 'theme-light' : 'theme-dark');
            menu.box.style = (isLight
                ? 'background-color: #f6f6f8 !important; color: #1c1c1e !important; border: 1px solid rgba(0, 0, 0, 0.14) !important; border-radius: 14px !important; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.20) !important;'
                : 'background-color: #242428 !important; color: #ffffff !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 14px !important; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55) !important;')
                + ' width: 330px !important; min-width: 330px !important; max-width: 330px !important;';
        }

        // 1. Header: Wi-Fi toggle switch
        const isWifiOn = Boolean(this._nmClient && this._nmClient.wireless_enabled);
        const switchItem = new PopupMenu.PopupSwitchMenuItem(_('Wi-Fi'), isWifiOn);
        switchItem.activate = function(event) {
            if (this._switch.mapped)
                this.toggle();
        };
        menu.addMenuItem(switchItem);

        // Off status label (shown when Wi-Fi is disabled)
        const offLabelItem = new PopupMenu.PopupMenuItem(_('Wi-Fi desactivado'), { reactive: false });
        offLabelItem.actor.visible = !isWifiOn;
        menu.addMenuItem(offLabelItem);

        // 2. Clean Minimal Speed Throughput Card (NO "velocidad de internet" title, NO test button)
        const speedItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        speedItem.actor.visible = isWifiOn;
        const speedCard = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'wave-wifi-speed-card',
            style: 'spacing: 8px;',
        });

        const txRxIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            fallback_icon_name: 'network-wireless-symbolic',
            icon_size: 13,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        speedCard.add_child(txRxIcon);

        let activeInfo = this._getActiveWifiInfo();
        const linkStr = activeInfo ? `   (${activeInfo.band} • ${activeInfo.bitrate} Mbps)` : '';
        const throughputLabel = new St.Label({
            text: `↓  0.0 KB/s   ↑  0.0 KB/s${linkStr}`,
            style_class: 'wave-wifi-speed-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        throughputLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        speedCard.add_child(throughputLabel);
        speedItem.add_child(speedCard);
        menu.addMenuItem(speedItem);

        // Live throughput update timer (running only while menu is open)
        if (activeInfo && activeInfo.iface) {
            this._lastThroughput = null;
            this._wifiThroughputTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                if (this._wifiMenu !== menu || !menu.isOpen) {
                    this._wifiThroughputTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                const curInfo = this._getActiveWifiInfo();
                if (!curInfo || !curInfo.iface) return GLib.SOURCE_CONTINUE;
                const tp = this._readWifiThroughput(curInfo.iface);
                const curLink = `   (${curInfo.band} • ${curInfo.bitrate} Mbps)`;
                throughputLabel.text = `↓ ${tp.down}   ↑ ${tp.up}${curLink}`;
                return GLib.SOURCE_CONTINUE;
            });
        }

        // 3. Active Connected Network with Inline QR Button (ICON ONLY, NO TEXT, NO EMOJI)
        const activeSeparator = new PopupMenu.PopupSeparatorMenuItem();
        activeSeparator.actor.visible = isWifiOn && Boolean(activeInfo && activeInfo.ssid);
        menu.addMenuItem(activeSeparator);

        const activeItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        activeItem.activate = function() {};
        activeItem.actor.visible = isWifiOn && Boolean(activeInfo && activeInfo.ssid);
        const activeBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'wave-wifi-item-box',
        });

        const sigIcon = new St.Icon({
            icon_name: activeInfo ? this._getSignalIconName(activeInfo.strength) : 'network-wireless-signal-excellent-symbolic',
            icon_size: 14,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        activeBox.add_child(sigIcon);

        const ssidLabel = new St.Label({
            text: activeInfo ? activeInfo.ssid : '',
            style_class: 'wave-wifi-item-name wave-wifi-item-name-active',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        activeBox.add_child(ssidLabel);

        const badge5g = new St.Label({
            text: '5G',
            style_class: 'wave-wifi-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: Boolean(activeInfo && activeInfo.band === '5 GHz'),
        });
        activeBox.add_child(badge5g);

        const checkIcon = new St.Icon({
            icon_name: 'emblem-ok-symbolic',
            icon_size: 14,
            style_class: 'wave-topbar-icon wave-wifi-item-active-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        activeBox.add_child(checkIcon);

        // QR Icon Button: ONLY QR ICON, NO TEXT, NO EMOJI
        const qrBtn = new St.Button({
            style_class: 'wave-wifi-icon-btn',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const qrIconFile = Gio.File.new_for_path(
            GLib.build_filenamev([this.path, 'assets', 'qr-code-symbolic.svg'])
        );
        const qrIcon = new St.Icon({
            gicon: new Gio.FileIcon({ file: qrIconFile }),
            fallback_icon_name: 'view-reveal-symbolic',
            icon_size: 15,
            style_class: 'wave-topbar-icon',
        });
        qrBtn.set_child(qrIcon);
        activeBox.add_child(qrBtn);

        activeItem.add_child(activeBox);
        menu.addMenuItem(activeItem);

        // Inline QR Drawer (revealed inside the menu when clicking qrBtn)
        const inlineQrItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        inlineQrItem.actor.visible = false;
        const inlineQrCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wave-wifi-inline-card',
            style: 'spacing: 8px;',
        });
        inlineQrItem.add_child(inlineQrCard);
        menu.addMenuItem(inlineQrItem);

        let qrLoadedSsid = null;
        qrBtn.connect('clicked', () => {
            const curInfo = this._getActiveWifiInfo();
            if (!curInfo || !curInfo.ssid) return;
            const willOpen = !inlineQrItem.actor.visible;
            inlineQrItem.actor.visible = willOpen;
            if (willOpen && qrLoadedSsid !== curInfo.ssid) {
                qrLoadedSsid = curInfo.ssid;
                this._loadInlineQr(curInfo.ssid, inlineQrCard);
            }
        });

        // Helper to update active network section dynamically in-place
        const updateActiveSection = () => {
            const curInfo = this._getActiveWifiInfo();
            if (curInfo && curInfo.ssid && switchItem.state) {
                sigIcon.icon_name = this._getSignalIconName(curInfo.strength);
                ssidLabel.text = curInfo.ssid;
                badge5g.visible = (curInfo.band === '5 GHz');
                activeSeparator.actor.visible = true;
                activeItem.actor.visible = true;
            } else {
                activeSeparator.actor.visible = false;
                activeItem.actor.visible = false;
                inlineQrItem.actor.visible = false;
            }
        };

        // 4. Available Networks Section Header
        const netSeparator = new PopupMenu.PopupSeparatorMenuItem();
        netSeparator.actor.visible = isWifiOn;
        menu.addMenuItem(netSeparator);

        const netHeaderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        netHeaderItem.actor.visible = isWifiOn;
        const netHeaderBox = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const netTitle = new St.Label({
            text: _('REDES DISPONIBLES'),
            style_class: 'wave-wifi-section-title',
            x_expand: true,
        });
        netHeaderBox.add_child(netTitle);

        const rescanBtn = new St.Button({
            style_class: 'wave-wifi-btn-compact',
            can_focus: true,
            track_hover: true,
        });
        const rescanIcon = new St.Icon({
            icon_name: 'view-refresh-symbolic',
            icon_size: 12,
            style_class: 'wave-topbar-icon',
        });
        rescanBtn.set_child(rescanIcon);
        rescanBtn.connect('clicked', () => {
            this._runCommandAsync(['nmcli', 'dev', 'wifi', 'rescan'], () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    this._refreshWifiNetworksList(netListBox, menu, updateActiveSection);
                    return GLib.SOURCE_REMOVE;
                });
            });
        });
        netHeaderBox.add_child(rescanBtn);
        netHeaderItem.add_child(netHeaderBox);
        menu.addMenuItem(netHeaderItem);

        // Scrollable Networks List Container
        const scrollItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        scrollItem.actor.visible = isWifiOn;
        const scroll = new St.ScrollView({
            style: 'max-height: 200px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
        });
        const netListBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        scroll.set_child(netListBox);
        scrollItem.add_child(scroll);
        menu.addMenuItem(scrollItem);

        // Populate networks if Wi-Fi is on
        if (isWifiOn) {
            this._refreshWifiNetworksList(netListBox, menu, updateActiveSection);
        }

        // 5. Connect to Hidden Network (Inline Form inside the menu)
        const hiddenToggleItem = new PopupMenu.PopupMenuItem(_('+ Conectarse a una red oculta...'));
        hiddenToggleItem.closeOnActivate = false;
        hiddenToggleItem.actor.visible = isWifiOn;
        hiddenToggleItem.activate = function() {
            hiddenDrawerItem.actor.visible = !hiddenDrawerItem.actor.visible;
            if (hiddenDrawerItem.actor.visible) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    hiddenSsidEntry.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
            }
        };
        menu.addMenuItem(hiddenToggleItem);

        const hiddenDrawerItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, can_focus: false, activate: false });
        hiddenDrawerItem.activate = function() {};
        hiddenDrawerItem.closeOnActivate = false;
        hiddenDrawerItem.actor.visible = false;
        const hiddenDrawerCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wave-wifi-inline-card',
            style: 'spacing: 6px;',
        });

        const hiddenSsidEntry = new St.Entry({
            hint_text: _('Nombre de la red (SSID)'),
            style_class: 'wave-wifi-entry',
            can_focus: true,
        });
        hiddenDrawerCard.add_child(hiddenSsidEntry);

        // Security Selector
        const secOptions = [
            { id: 'wpa-psk', label: _('WPA / WPA2 Personal') },
            { id: 'sae', label: _('WPA3 Personal (SAE)') },
            { id: 'none', label: _('Sin seguridad (Abierta)') },
            { id: 'wep', label: _('WEP') },
        ];
        let currentSecId = 'wpa-psk';

        const secSelectorBtn = new St.Button({
            style_class: 'wave-wifi-net-row',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            style: 'padding: 5px 8px; border-radius: 6px;',
        });
        const secSelectorBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const secSelectorLabel = new St.Label({
            text: _('Seguridad: WPA / WPA2 Personal'),
            style_class: 'wave-wifi-item-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const secSelectorArrow = new St.Label({
            text: '▾',
            style_class: 'wave-wifi-item-rate',
            y_align: Clutter.ActorAlign.CENTER,
        });
        secSelectorBox.add_child(secSelectorLabel);
        secSelectorBox.add_child(secSelectorArrow);
        secSelectorBtn.set_child(secSelectorBox);
        hiddenDrawerCard.add_child(secSelectorBtn);

        const secOptionsCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
            style_class: 'wave-wifi-sec-menu',
        });
        hiddenDrawerCard.add_child(secOptionsCard);

        const checkIcons = {};
        for (const opt of secOptions) {
            const optBtn = new St.Button({
                style_class: 'wave-wifi-net-row',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                style: 'padding: 4px 8px; border-radius: 4px;',
            });
            const optBox = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const optLabel = new St.Label({
                text: opt.label,
                style_class: 'wave-wifi-item-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const optCheck = new St.Icon({
                icon_name: 'emblem-ok-symbolic',
                icon_size: 12,
                style_class: 'wave-topbar-icon',
                y_align: Clutter.ActorAlign.CENTER,
                visible: (opt.id === currentSecId),
            });
            checkIcons[opt.id] = optCheck;
            optBox.add_child(optLabel);
            optBox.add_child(optCheck);
            optBtn.set_child(optBox);

            optBtn.connect('clicked', () => {
                currentSecId = opt.id;
                secSelectorLabel.text = _('Seguridad: %s').format(opt.label);
                for (const key of Object.keys(checkIcons)) {
                    checkIcons[key].visible = (key === currentSecId);
                }
                secOptionsCard.visible = false;
                secSelectorArrow.text = '▾';
                hiddenPassRow.visible = (currentSecId !== 'none');
            });
            secOptionsCard.add_child(optBtn);
        }

        secSelectorBtn.connect('clicked', () => {
            secOptionsCard.visible = !secOptionsCard.visible;
            secSelectorArrow.text = secOptionsCard.visible ? '▴' : '▾';
        });

        const hiddenPassRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 4px;',
        });
        const hiddenPassEntry = new St.Entry({
            hint_text: _('Contraseña de seguridad'),
            style_class: 'wave-wifi-entry',
            can_focus: true,
            x_expand: true,
        });
        hiddenPassEntry.clutter_text.set_password_char('•');
        hiddenPassRow.add_child(hiddenPassEntry);

        let hiddenPassRevealed = false;
        const hiddenEyeBtn = new St.Button({
            style_class: 'wave-wifi-icon-btn',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const hiddenEyeIcon = new St.Icon({
            icon_name: 'view-reveal-symbolic',
            icon_size: 13,
            style_class: 'wave-topbar-icon',
        });
        hiddenEyeBtn.set_child(hiddenEyeIcon);
        hiddenEyeBtn.connect('clicked', () => {
            hiddenPassRevealed = !hiddenPassRevealed;
            hiddenPassEntry.clutter_text.set_password_char(hiddenPassRevealed ? '' : '•');
            hiddenEyeIcon.icon_name = hiddenPassRevealed ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        });
        hiddenPassRow.add_child(hiddenEyeBtn);
        hiddenDrawerCard.add_child(hiddenPassRow);

        const hiddenStatusLabel = new St.Label({
            text: '',
            style_class: 'wave-wifi-item-rate',
            visible: false,
        });
        hiddenDrawerCard.add_child(hiddenStatusLabel);

        const hiddenBtnBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.END,
            style: 'spacing: 6px; margin-top: 4px;',
        });
        const hiddenConnectBtn = new St.Button({
            label: _('Conectar'),
            style_class: 'wave-wifi-btn-primary',
            can_focus: true,
            track_hover: true,
        });
        const doHiddenConnect = () => {
            const hSsid = hiddenSsidEntry.get_text().trim();
            const hPass = hiddenPassEntry.get_text();
            if (!hSsid) {
                hiddenStatusLabel.text = _('Por favor ingresa un SSID');
                hiddenStatusLabel.visible = true;
                return;
            }
            if (currentSecId !== 'none' && !hPass) {
                hiddenStatusLabel.text = _('Por favor ingresa la contraseña');
                hiddenStatusLabel.visible = true;
                return;
            }
            if ((currentSecId === 'wpa-psk' || currentSecId === 'sae') && hPass.length < 8) {
                hiddenStatusLabel.text = _('La contraseña debe tener al menos 8 caracteres');
                hiddenStatusLabel.visible = true;
                return;
            }

            hiddenConnectBtn.label = _('Conectando...');
            hiddenStatusLabel.visible = false;

            // Remove previous profile with this SSID if any exists to avoid duplication
            this._runCommandAsync(['nmcli', 'connection', 'delete', 'id', hSsid], () => {
                const addCmd = [
                    'nmcli', 'connection', 'add',
                    'type', 'wifi',
                    'con-name', hSsid,
                    'ifname', '*',
                    'ssid', hSsid,
                    'wifi.hidden', 'yes',
                ];
                if (currentSecId === 'wpa-psk') {
                    addCmd.push('wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', hPass);
                } else if (currentSecId === 'sae') {
                    addCmd.push('wifi-sec.key-mgmt', 'sae', 'wifi-sec.psk', hPass);
                } else if (currentSecId === 'wep') {
                    addCmd.push('wifi-sec.key-mgmt', 'none', 'wifi-sec.wep-key-type', 'key', 'wifi-sec.wep-key0', hPass);
                }

                this._runCommandAsync(addCmd, (_outAdd, errAdd, codeAdd) => {
                    if (codeAdd) {
                        hiddenConnectBtn.label = _('Conectar');
                        hiddenStatusLabel.text = errAdd ? errAdd.trim() : _('Error al configurar la red');
                        hiddenStatusLabel.visible = true;
                        return;
                    }
                    this._runCommandAsync(['nmcli', 'connection', 'up', 'id', hSsid], (_outUp, errUp, codeUp) => {
                        if (codeUp) {
                            hiddenConnectBtn.label = _('Conectar');
                            hiddenStatusLabel.text = errUp ? errUp.trim() : _('Error al conectar a la red oculta');
                            hiddenStatusLabel.visible = true;
                        } else {
                            hiddenConnectBtn.label = _('✓ Conectado');
                            this._updateNetwork();
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                                if (this._wifiMenu === menu && menu.isOpen) {
                                    hiddenDrawerItem.actor.visible = false;
                                    hiddenConnectBtn.label = _('Conectar');
                                    hiddenSsidEntry.set_text('');
                                    hiddenPassEntry.set_text('');
                                    updateActiveSection();
                                    this._refreshWifiNetworksList(netListBox, menu, updateActiveSection);
                                }
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    });
                });
            });
        };
        hiddenSsidEntry.clutter_text.connect('activate', () => {
            if (currentSecId === 'none') {
                doHiddenConnect();
            } else {
                hiddenPassEntry.grab_key_focus();
            }
        });
        hiddenPassEntry.clutter_text.connect('activate', () => doHiddenConnect());
        hiddenConnectBtn.connect('clicked', () => doHiddenConnect());
        hiddenBtnBox.add_child(hiddenConnectBtn);
        hiddenDrawerCard.add_child(hiddenBtnBox);

        hiddenDrawerItem.add_child(hiddenDrawerCard);
        menu.addMenuItem(hiddenDrawerItem);

        // 6. Manage Saved Networks (Inline Drawer to forget/manage saved Wi-Fi networks)
        const savedToggleItem = new PopupMenu.PopupMenuItem(_('Redes guardadas...'));
        savedToggleItem.closeOnActivate = false;
        savedToggleItem.actor.visible = isWifiOn;
        menu.addMenuItem(savedToggleItem);

        const savedDrawerItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, can_focus: false, activate: false });
        savedDrawerItem.activate = function() {};
        savedDrawerItem.closeOnActivate = false;
        savedDrawerItem.actor.visible = false;

        const savedDrawerCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wave-wifi-inline-card',
            style: 'spacing: 4px;',
        });
        savedDrawerItem.add_child(savedDrawerCard);
        menu.addMenuItem(savedDrawerItem);

        const refreshSavedList = () => {
            savedDrawerCard.destroy_all_children();
            const loadingLabel = new St.Label({
                text: _('Cargando redes guardadas...'),
                style_class: 'wave-wifi-item-rate',
                style: 'padding: 6px;',
            });
            savedDrawerCard.add_child(loadingLabel);

            this._runCommandAsync(['nmcli', '-t', '-f', 'NAME,TYPE,UUID', 'connection', 'show'], (stdout) => {
                if (this._wifiMenu !== menu) return;
                savedDrawerCard.destroy_all_children();

                const savedWifi = [];
                if (stdout) {
                    for (const line of stdout.split('\n')) {
                        if (!line.trim()) continue;
                        const parts = line.split(':');
                        if (parts.length >= 3 && parts[1] === '802-11-wireless') {
                            savedWifi.push({ name: parts[0], uuid: parts[2] });
                        }
                    }
                }

                if (savedWifi.length === 0) {
                    const emptyLabel = new St.Label({
                        text: _('No hay redes guardadas'),
                        style_class: 'wave-wifi-item-rate',
                        style: 'padding: 6px;',
                    });
                    savedDrawerCard.add_child(emptyLabel);
                    return;
                }

                for (const conn of savedWifi) {
                    const row = new St.BoxLayout({
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                        style: 'padding: 4px 6px; spacing: 8px;',
                    });

                    const netIcon = new St.Icon({
                        icon_name: 'network-wireless-symbolic',
                        icon_size: 13,
                        style_class: 'wave-topbar-icon',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    row.add_child(netIcon);

                    const nameLabel = new St.Label({
                        text: conn.name,
                        style_class: 'wave-wifi-item-name',
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    row.add_child(nameLabel);

                    const delBtn = new St.Button({
                        style_class: 'wave-wifi-icon-btn',
                        can_focus: true,
                        track_hover: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const delIcon = new St.Icon({
                        icon_name: 'user-trash-symbolic',
                        fallback_icon_name: 'edit-delete-symbolic',
                        icon_size: 13,
                        style_class: 'wave-topbar-icon',
                    });
                    delBtn.set_child(delIcon);
                    delBtn.connect('clicked', () => {
                        delIcon.icon_name = 'process-working-symbolic';
                        this._runCommandAsync(['nmcli', 'connection', 'delete', 'uuid', conn.uuid], () => {
                            this._updateNetwork();
                            refreshSavedList();
                            updateActiveSection();
                            this._refreshWifiNetworksList(netListBox, menu, updateActiveSection);
                        });
                    });
                    row.add_child(delBtn);

                    savedDrawerCard.add_child(row);
                }
            });
        };

        savedToggleItem.activate = function() {
            savedDrawerItem.actor.visible = !savedDrawerItem.actor.visible;
            if (savedDrawerItem.actor.visible) {
                refreshSavedList();
            }
        };

        // 6. Network Settings (always at bottom)
        const settingsSep = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(settingsSep);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Configuración de red...'));
        settingsItem.connect('activate', () => {
            GLib.spawn_command_line_async('gnome-control-center wifi');
        });
        menu.addMenuItem(settingsItem);

        // Dynamic Wi-Fi switch toggle in-place (DOES NOT CLOSE THE MENU)
        switchItem.connect('toggled', (item, state) => {
            if (this._nmClient) {
                this._nmClient.wireless_enabled = state;
            } else {
                this._runCommandAsync(['nmcli', 'radio', 'wifi', state ? 'on' : 'off']);
            }
            this._updateNetwork();

            offLabelItem.actor.visible = !state;
            speedItem.actor.visible = state;
            activeSeparator.actor.visible = state && Boolean(activeInfo && activeInfo.ssid);
            activeItem.actor.visible = state && Boolean(activeInfo && activeInfo.ssid);
            inlineQrItem.actor.visible = false;
            netSeparator.actor.visible = state;
            netHeaderItem.actor.visible = state;
            scrollItem.actor.visible = state;
            hiddenToggleItem.actor.visible = state;
            hiddenDrawerItem.actor.visible = false;
            savedToggleItem.actor.visible = state;
            savedDrawerItem.actor.visible = false;

            if (state) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    if (this._wifiMenu === menu && menu.isOpen) {
                        updateActiveSection();
                        this._refreshWifiNetworksList(netListBox, menu, updateActiveSection);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        menu.connect('destroy', () => {
            if (this._wifiThroughputTimerId) {
                GLib.source_remove(this._wifiThroughputTimerId);
                this._wifiThroughputTimerId = 0;
            }
            if (this._wifiMenu === menu)
                this._wifiMenu = null;
        });

        this._registerMenu(menu);
    }

    _loadInlineQr(ssid, container) {
        container.destroy_all_children();

        const loading = new St.Label({
            text: _('Generando código QR...'),
            style_class: 'wave-wifi-item-rate',
            style: 'text-align: center; padding: 12px 0;',
        });
        container.add_child(loading);

        this._runCommandAsync(
            ['nmcli', '-s', '-g', '802-11-wireless-security.psk', 'connection', 'show', ssid],
            (stdout) => {
                const password = (stdout || '').trim();
                const escapeWifiQr = (s) => (s || '').replace(/([\\;,":])/g, '\\$1');
                const secType = password ? 'WPA' : 'nopass';
                const qrPayload = password
                    ? `WIFI:S:${escapeWifiQr(ssid)};T:${secType};P:${escapeWifiQr(password)};;`
                    : `WIFI:S:${escapeWifiQr(ssid)};T:nopass;;`;

                const scriptPath = GLib.build_filenamev([this.path, 'qr_helper.py']);
                this._runCommandAsync(['python3', scriptPath, qrPayload], (qrOut) => {
                    container.destroy_all_children();
                    let qrData = null;
                    try {
                        qrData = JSON.parse(qrOut);
                    } catch (e) {
                        console.warn('[WaveTopBar] Failed to parse QR JSON:', e);
                    }

                    if (!qrData || !qrData.success) {
                        const errLabel = new St.Label({
                            text: _('No se pudo generar el código QR'),
                            style_class: 'wave-wifi-item-rate',
                            style: 'text-align: center;',
                        });
                        container.add_child(errLabel);
                        return;
                    }

                    const qrBox = new St.BoxLayout({
                        style_class: 'wave-wifi-inline-qr-container',
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                        style: 'padding: 6px; background-color: #ffffff; border-radius: 10px;',
                    });

                    if (qrData.svg_path) {
                        const qrFile = Gio.File.new_for_path(qrData.svg_path);
                        const qrIcon = new St.Icon({
                            gicon: new Gio.FileIcon({ file: qrFile }),
                            icon_size: 160,
                        });
                        qrBox.add_child(qrIcon);
                    }
                    container.add_child(qrBox);

                    if (password) {
                        const passBox = new St.BoxLayout({
                            style_class: 'wave-wifi-pass-box',
                            y_align: Clutter.ActorAlign.CENTER,
                            x_expand: true,
                            style: 'spacing: 6px;',
                        });
                        const lockIcon = new St.Icon({
                            icon_name: 'channel-secure-symbolic',
                            icon_size: 12,
                            style_class: 'wave-topbar-icon',
                        });
                        passBox.add_child(lockIcon);

                        let isRevealed = false;
                        const maskedText = '•'.repeat(Math.max(8, password.length));
                        const passLabel = new St.Label({
                            text: maskedText,
                            style_class: 'wave-wifi-pass-label',
                            x_expand: true,
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        passBox.add_child(passLabel);

                        // Eye button to reveal / hide password
                        const eyeBtn = new St.Button({
                            style_class: 'wave-wifi-icon-btn',
                            can_focus: true,
                            track_hover: true,
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        const eyeIcon = new St.Icon({
                            icon_name: 'view-reveal-symbolic',
                            icon_size: 13,
                            style_class: 'wave-topbar-icon',
                        });
                        eyeBtn.set_child(eyeIcon);
                        eyeBtn.connect('clicked', () => {
                            isRevealed = !isRevealed;
                            passLabel.text = isRevealed ? password : maskedText;
                            eyeIcon.icon_name = isRevealed ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
                        });
                        passBox.add_child(eyeBtn);

                        const copyBtn = new St.Button({
                            label: _('Copiar'),
                            style_class: 'wave-wifi-btn-compact',
                            can_focus: true,
                            track_hover: true,
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        copyBtn.connect('clicked', () => {
                            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, password);
                            copyBtn.label = _('✓ Copiado');
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
                                copyBtn.label = _('Copiar');
                                return GLib.SOURCE_REMOVE;
                            });
                        });
                        passBox.add_child(copyBtn);
                        container.add_child(passBox);
                    }
                });
            }
        );
    }

    _refreshWifiNetworksList(container, menu, onConnectedCallback) {
        if (!container || !menu || this._wifiMenu !== menu) return;
        container.destroy_all_children();

        const loadingLabel = new St.Label({
            text: _('Buscando redes...'),
            style_class: 'wave-wifi-item-rate',
            style: 'padding: 8px 12px;',
        });
        container.add_child(loadingLabel);

        this._runCommandAsync(['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'], (connsOut) => {
            if (this._wifiMenu !== menu) return;
            const savedWifiSet = new Set();
            if (connsOut) {
                for (const line of connsOut.split('\n')) {
                    const parts = line.split(':');
                    if (parts.length >= 2 && parts[1] === '802-11-wireless') {
                        savedWifiSet.add(parts[0].trim());
                    }
                }
            }

            this._runCommandAsync(
                ['nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY,RATE,FREQ', 'dev', 'wifi', 'list'],
                (stdout, stderr, err) => {
                    if (this._wifiMenu !== menu) return;
                    container.destroy_all_children();

                    if (err || !stdout) {
                        const errLabel = new St.Label({
                            text: _('No se encontraron redes'),
                            style_class: 'wave-wifi-item-rate',
                            style: 'padding: 8px 12px;',
                        });
                        container.add_child(errLabel);
                        return;
                    }

                    const networksMap = new Map();
                    for (const line of stdout.split('\n')) {
                        if (!line.trim()) continue;
                        const parts = line.split(':');
                        if (parts.length < 4) continue;
                        const inUse = parts[0].trim() === '*';
                        const ssid = parts[1].trim();
                        if (!ssid) continue;
                        const signal = parseInt(parts[2], 10) || 0;
                        const security = parts[3] ? parts[3].trim() : '';
                        const rate = parts[4] ? parts[4].trim() : '';
                        const freq = parts[5] ? parts[5].trim() : '';

                        if (!networksMap.has(ssid) || inUse || signal > networksMap.get(ssid).signal) {
                            networksMap.set(ssid, { ssid, signal, security, rate, freq, inUse });
                        }
                    }

                    const allNets = Array.from(networksMap.values());
                    const networks = allNets.filter(n => !n.inUse);
                    networks.sort((a, b) => b.signal - a.signal);

                    if (networks.length === 0) {
                        const emptyLabel = new St.Label({
                            text: _('No hay otras redes disponibles'),
                            style_class: 'wave-wifi-item-rate',
                            style: 'padding: 8px 12px;',
                        });
                        container.add_child(emptyLabel);
                        return;
                    }

                    for (const net of networks) {
                        const netItemBox = new St.BoxLayout({
                            orientation: Clutter.Orientation.VERTICAL,
                            x_expand: true,
                        });

                        const rowBtn = new St.Button({
                            style_class: 'wave-wifi-net-row',
                            can_focus: true,
                            track_hover: true,
                            x_expand: true,
                        });

                        const rowBox = new St.BoxLayout({
                            style_class: 'wave-wifi-item-box',
                            y_align: Clutter.ActorAlign.CENTER,
                            x_expand: true,
                        });

                        const sigIcon = new St.Icon({
                            icon_name: this._getSignalIconName(net.signal),
                            icon_size: 14,
                            style_class: 'wave-topbar-icon',
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        rowBox.add_child(sigIcon);

                        const ssidLabel = new St.Label({
                            text: net.ssid,
                            style_class: 'wave-wifi-item-name',
                            y_align: Clutter.ActorAlign.CENTER,
                            x_expand: true,
                        });
                        rowBox.add_child(ssidLabel);

                        if (net.freq && parseInt(net.freq, 10) >= 5000) {
                            const badge = new St.Label({
                                text: '5G',
                                style_class: 'wave-wifi-badge',
                                y_align: Clutter.ActorAlign.CENTER,
                            });
                            rowBox.add_child(badge);
                        }

                        const isSecured = net.security && net.security !== '--';
                        if (isSecured) {
                            const lockIcon = new St.Icon({
                                icon_name: 'channel-secure-symbolic',
                                icon_size: 12,
                                style_class: 'wave-topbar-icon',
                                y_align: Clutter.ActorAlign.CENTER,
                            });
                            rowBox.add_child(lockIcon);
                        }

                        rowBtn.set_child(rowBox);
                        netItemBox.add_child(rowBtn);

                        // Inline Password Drawer for secured networks
                        const passDrawer = new St.BoxLayout({
                            x_expand: true,
                            y_align: Clutter.ActorAlign.CENTER,
                            style: 'spacing: 4px; margin: 2px 8px 6px 8px;',
                            visible: false,
                        });
                        const passEntry = new St.Entry({
                            hint_text: _('Contraseña...'),
                            style_class: 'wave-wifi-entry',
                            can_focus: true,
                            x_expand: true,
                        });
                        passEntry.clutter_text.set_password_char('•');
                        passDrawer.add_child(passEntry);

                        let listPassRevealed = false;
                        const listEyeBtn = new St.Button({
                            style_class: 'wave-wifi-icon-btn',
                            can_focus: true,
                            track_hover: true,
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        const listEyeIcon = new St.Icon({
                            icon_name: 'view-reveal-symbolic',
                            icon_size: 13,
                            style_class: 'wave-topbar-icon',
                        });
                        listEyeBtn.set_child(listEyeIcon);
                        listEyeBtn.connect('clicked', () => {
                            listPassRevealed = !listPassRevealed;
                            passEntry.clutter_text.set_password_char(listPassRevealed ? '' : '•');
                            listEyeIcon.icon_name = listPassRevealed ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
                        });
                        passDrawer.add_child(listEyeBtn);

                        const connectBtn = new St.Button({
                            label: _('Conectar'),
                            style_class: 'wave-wifi-btn-primary',
                            can_focus: true,
                            track_hover: true,
                        });
                        const doConnect = () => {
                            const p = passEntry.get_text();
                            connectBtn.label = _('Conectando...');
                            this._runCommandAsync(
                                ['nmcli', 'dev', 'wifi', 'connect', net.ssid, 'password', p],
                                (out, errStr, errCode) => {
                                    if (errCode || (errStr && errStr.toLowerCase().includes('error'))) {
                                        connectBtn.label = _('Conectar');
                                        passEntry.set_text('');
                                        passEntry.hint_text = _('Contraseña incorrecta');
                                    } else {
                                        connectBtn.label = _('✓ Conectado');
                                        this._updateNetwork();
                                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                                            if (this._wifiMenu === menu && menu.isOpen) {
                                                passDrawer.visible = false;
                                                if (onConnectedCallback) onConnectedCallback();
                                                this._refreshWifiNetworksList(container, menu, onConnectedCallback);
                                            }
                                            return GLib.SOURCE_REMOVE;
                                        });
                                    }
                                }
                            );
                        };
                        passEntry.clutter_text.connect('activate', () => doConnect());
                        connectBtn.connect('clicked', () => doConnect());
                        passDrawer.add_child(connectBtn);
                        netItemBox.add_child(passDrawer);

                        rowBtn.connect('clicked', () => {
                            if (savedWifiSet.has(net.ssid)) {
                                ssidLabel.text = `${net.ssid} (${_('Conectando...')})`;
                                this._runCommandAsync(['nmcli', 'connection', 'up', 'id', net.ssid], () => {
                                    this._updateNetwork();
                                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                                        if (this._wifiMenu === menu && menu.isOpen) {
                                            if (onConnectedCallback) onConnectedCallback();
                                            this._refreshWifiNetworksList(container, menu, onConnectedCallback);
                                        }
                                        return GLib.SOURCE_REMOVE;
                                    });
                                });
                            } else if (!isSecured) {
                                ssidLabel.text = `${net.ssid} (${_('Conectando...')})`;
                                this._runCommandAsync(['nmcli', 'dev', 'wifi', 'connect', net.ssid], () => {
                                    this._updateNetwork();
                                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                                        if (this._wifiMenu === menu && menu.isOpen) {
                                            if (onConnectedCallback) onConnectedCallback();
                                            this._refreshWifiNetworksList(container, menu, onConnectedCallback);
                                        }
                                        return GLib.SOURCE_REMOVE;
                                    });
                                });
                            } else {
                                passDrawer.visible = !passDrawer.visible;
                                if (passDrawer.visible) {
                                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                                        passEntry.grab_key_focus();
                                        return GLib.SOURCE_REMOVE;
                                    });
                                }
                            }
                        });

                        container.add_child(netItemBox);
                    }
                }
            );
        });
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

    // ==========================================
    // Audio / Volume & Microphone Management
    // ==========================================

    _setupAudioListeners() {
        if (!this._audioControl) return;

        const connectCtrl = (sig, fn) => {
            const id = this._audioControl.connect(sig, fn);
            this._audioControlSignals.push(id);
        };

        connectCtrl('state-changed', () => {
            this._connectSinkSignals();
            this._connectSourceSignals();
            this._updateAudioIndicators();
        });
        connectCtrl('default-sink-changed', () => {
            this._connectSinkSignals();
            this._updateAudioIndicators();
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._syncVolumeMenuValues();
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('default-source-changed', () => {
            this._connectSourceSignals();
            this._updateAudioIndicators();
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._syncVolumeMenuValues();
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('output-added', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('output-removed', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('active-output-update', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('input-added', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('input-removed', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });
        connectCtrl('active-input-update', () => {
            if (this._volumeMenu && this._volumeMenu.isOpen) {
                this._refreshAudioDeviceLists();
            }
        });

        this._connectSinkSignals();
        this._connectSourceSignals();
        this._updateAudioIndicators();
    }

    _connectSinkSignals() {
        if (this._currentSink && this._sinkSignals.length) {
            for (const id of this._sinkSignals) {
                try { this._currentSink.disconnect(id); } catch (e) {}
            }
        }
        this._sinkSignals = [];
        this._currentSink = this._audioControl ? this._audioControl.get_default_sink() : null;
        if (this._currentSink) {
            this._sinkSignals.push(
                this._currentSink.connect('notify::volume', () => {
                    this._updateAudioIndicators();
                    if (this._volumeMenu && this._volumeMenu.isOpen && !this._isDraggingOutputSlider) {
                        this._syncVolumeMenuValues();
                    }
                })
            );
            this._sinkSignals.push(
                this._currentSink.connect('notify::is-muted', () => {
                    this._updateAudioIndicators();
                    if (this._volumeMenu && this._volumeMenu.isOpen) {
                        this._syncVolumeMenuValues();
                    }
                })
            );
        }
    }

    _connectSourceSignals() {
        if (this._currentSource && this._sourceSignals.length) {
            for (const id of this._sourceSignals) {
                try { this._currentSource.disconnect(id); } catch (e) {}
            }
        }
        this._sourceSignals = [];
        this._currentSource = this._audioControl ? this._audioControl.get_default_source() : null;
        if (this._currentSource) {
            this._sourceSignals.push(
                this._currentSource.connect('notify::volume', () => {
                    if (this._volumeMenu && this._volumeMenu.isOpen && !this._isDraggingInputSlider) {
                        this._syncVolumeMenuValues();
                    }
                })
            );
            this._sourceSignals.push(
                this._currentSource.connect('notify::is-muted', () => {
                    if (this._volumeMenu && this._volumeMenu.isOpen) {
                        this._syncVolumeMenuValues();
                    }
                })
            );
        }
    }

    _updateAudioIndicators() {
        if (!this._volumeIcon || !this._audioControl) return;

        const sink = this._audioControl.get_default_sink();
        if (!sink) {
            this._volumeIcon.icon_name = 'audio-volume-muted-symbolic';
            return;
        }

        const maxNorm = this._audioControl.get_vol_max_norm() || 65536;
        const fraction = sink.volume / maxNorm;
        const isMuted = sink.is_muted;

        this._volumeIcon.icon_name = this._getVolumeIconName(fraction, isMuted);
    }

    _getVolumeIconName(fraction, isMuted) {
        if (isMuted || fraction <= 0.001) {
            return 'audio-volume-muted-symbolic';
        }
        if (fraction < 0.33) {
            return 'audio-volume-low-symbolic';
        }
        if (fraction < 0.66) {
            return 'audio-volume-medium-symbolic';
        }
        return 'audio-volume-high-symbolic';
    }

    _getMicIconName(fraction, isMuted) {
        if (isMuted || fraction <= 0.001) {
            return 'microphone-sensitivity-muted-symbolic';
        }
        if (fraction < 0.33) {
            return 'microphone-sensitivity-low-symbolic';
        }
        if (fraction < 0.66) {
            return 'microphone-sensitivity-medium-symbolic';
        }
        return 'microphone-sensitivity-high-symbolic';
    }

    _stepVolume(step) {
        if (!this._audioControl) return;
        const sink = this._audioControl.get_default_sink();
        if (!sink) return;

        const maxNorm = this._audioControl.get_vol_max_norm() || 65536;
        let current = sink.volume / maxNorm;
        let next = Math.max(0, Math.min(1.0, current + step));

        sink.volume = Math.round(next * maxNorm);
        sink.push_volume();
        if (sink.is_muted && next > 0) {
            sink.change_is_muted(false);
        }

        this._updateAudioIndicators();
        const iconName = this._getVolumeIconName(next, sink.is_muted);
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({ name: iconName }), null, next, 1.0);
    }

    _getSymbolicGIcon(origGicon, fallbackName) {
        if (origGicon instanceof Gio.ThemedIcon) {
            const names = origGicon.get_names();
            const symNames = [];
            for (const n of names) {
                if (n.endsWith('-symbolic')) {
                    symNames.push(n);
                } else {
                    symNames.push(`${n}-symbolic`);
                }
            }
            for (const n of names) {
                if (!symNames.includes(n))
                    symNames.push(n);
            }
            return new Gio.ThemedIcon({ names: symNames });
        }
        if (origGicon)
            return origGicon;
        return fallbackName ? new Gio.ThemedIcon({ name: fallbackName }) : null;
    }

    _toggleVolumeMenu() {
        if (this._volumeMenu && this._volumeMenu.isOpen) {
            this._volumeMenu.close();
        } else {
            this._showVolumeMenu();
        }
    }

    _showVolumeMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._volumeBtn, 0.5, St.Side.TOP);
        this._volumeMenu = menu;
        menu.actor.add_style_class_name('wave-wifi-menu');
        menu.actor.add_style_class_name('wave-volume-menu');
        menu.actor.width = 330;

        menu.connect('destroy', () => {
            if (this._volumeMenu === menu) {
                this._volumeMenu = null;
                this._outputDevicesBox = null;
                this._inputDevicesBox = null;
                this._outputToggleLabel = null;
                this._inputToggleLabel = null;
                this._outputToggleIcon = null;
                this._inputToggleIcon = null;
                this._outputSlider = null;
                this._inputSlider = null;
                this._outputPercentLabel = null;
                this._inputPercentLabel = null;
                this._outputMuteIcon = null;
                this._inputMuteIcon = null;
            }
        });

        // 1. Output Section: Title
        const outputHeaderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const outputHeaderBox = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'padding: 4px 6px 2px 6px;' });
        const outputHeaderLabel = new St.Label({
            text: _('SALIDA DE AUDIO'),
            style_class: 'wave-wifi-section-title',
            x_expand: true,
        });
        outputHeaderBox.add_child(outputHeaderLabel);
        outputHeaderItem.add_child(outputHeaderBox);
        menu.addMenuItem(outputHeaderItem);

        // 2. Output Section: Volume Slider Row (Inline, unboxed)
        const outputSliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const outputSliderRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px; padding: 2px 8px; margin: 0 4px;',
        });

        const outputMuteBtn = new St.Button({
            style_class: 'wave-wifi-icon-btn',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sink = this._audioControl ? this._audioControl.get_default_sink() : null;
        const maxNorm = this._audioControl ? (this._audioControl.get_vol_max_norm() || 65536) : 65536;
        const outputFraction = sink ? Math.max(0, Math.min(1.0, sink.volume / maxNorm)) : 0;
        const isSinkMuted = sink ? sink.is_muted : false;

        this._outputMuteIcon = new St.Icon({
            icon_name: this._getVolumeIconName(outputFraction, isSinkMuted),
            icon_size: 16,
            style_class: 'wave-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        outputMuteBtn.set_child(this._outputMuteIcon);
        outputMuteBtn.connect('clicked', () => {
            const curSink = this._audioControl?.get_default_sink();
            if (!curSink) return;
            curSink.change_is_muted(!curSink.is_muted);
        });
        outputSliderRow.add_child(outputMuteBtn);

        this._outputSlider = new Slider(outputFraction);
        this._outputSlider.x_expand = true;
        this._outputSlider.y_align = Clutter.ActorAlign.CENTER;

        this._outputSlider.connect('drag-begin', () => { this._isDraggingOutputSlider = true; });
        this._outputSlider.connect('drag-end', () => {
            this._isDraggingOutputSlider = false;
            const curSink = this._audioControl?.get_default_sink();
            if (curSink) {
                const val = this._outputSlider.value;
                curSink.volume = Math.round(val * maxNorm);
                curSink.push_volume();
            }
        });
        this._outputSlider.connect('notify::value', () => {
            if (this._syncingVolumeUI) return;
            const curSink = this._audioControl?.get_default_sink();
            if (!curSink) return;
            const val = this._outputSlider.value;
            curSink.volume = Math.round(val * maxNorm);
            curSink.push_volume();
            if (curSink.is_muted && val > 0) {
                curSink.change_is_muted(false);
            }
            if (this._outputPercentLabel) {
                this._outputPercentLabel.text = `${Math.round(val * 100)}%`;
            }
            this._outputMuteIcon.icon_name = this._getVolumeIconName(val, curSink.is_muted);
            this._updateAudioIndicators();
        });

        const outputSliderBin = new St.Bin({
            style_class: 'slider-bin',
            child: this._outputSlider,
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        outputSliderRow.add_child(outputSliderBin);

        this._outputPercentLabel = new St.Label({
            text: `${Math.round(outputFraction * 100)}%`,
            style_class: 'wave-wifi-item-rate',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 36px; text-align: right;',
        });
        outputSliderRow.add_child(this._outputPercentLabel);

        outputSliderItem.add_child(outputSliderRow);
        menu.addMenuItem(outputSliderItem);

        // 3. Output Section: Collapsible Devices Drawer (Compressed)
        const curSinkDev = sink ? this._audioControl.lookup_output_id(sink.get_id()) : null;
        const curSinkName = curSinkDev ? curSinkDev.get_description() : (sink ? sink.get_description() : _('Altavoces'));

        const outputToggleItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const outputToggleBtn = new St.Button({
            style_class: 'wave-wifi-net-row',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            style: 'padding: 5px 8px; margin: 0 4px; border-radius: 6px;',
        });
        const outputToggleBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px;',
        });
        this._outputToggleIcon = new St.Icon({
            icon_size: 16,
            style_class: 'wave-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._outputToggleIcon.gicon = this._getSymbolicGIcon(curSinkDev?.get_gicon(), 'audio-speakers-symbolic');

        this._outputToggleLabel = new St.Label({
            text: _('Salida: %s').format(curSinkName),
            style_class: 'wave-wifi-item-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const outputArrowLabel = new St.Label({
            text: '▾',
            style_class: 'wave-wifi-item-rate',
            y_align: Clutter.ActorAlign.CENTER,
        });
        outputToggleBox.add_child(this._outputToggleIcon);
        outputToggleBox.add_child(this._outputToggleLabel);
        outputToggleBox.add_child(outputArrowLabel);
        outputToggleBtn.set_child(outputToggleBox);
        outputToggleItem.add_child(outputToggleBtn);
        menu.addMenuItem(outputToggleItem);

        const outputDrawerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        outputDrawerItem.actor.visible = false;
        this._outputDevicesBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wave-wifi-sec-menu',
            style: 'margin: 2px 8px 4px 8px; padding: 2px;',
        });
        outputDrawerItem.add_child(this._outputDevicesBox);
        menu.addMenuItem(outputDrawerItem);

        outputToggleBtn.connect('clicked', () => {
            outputDrawerItem.actor.visible = !outputDrawerItem.actor.visible;
            outputArrowLabel.text = outputDrawerItem.actor.visible ? '▴' : '▾';
            if (outputDrawerItem.actor.visible) {
                this._rebuildAudioDevicesList(this._outputDevicesBox, 'output');
            }
        });

        // 4. Separator
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 5. Input Section (Microphone): Title
        const inputHeaderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const inputHeaderBox = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'padding: 4px 6px 2px 6px;' });
        const inputHeaderLabel = new St.Label({
            text: _('MICRÓFONO'),
            style_class: 'wave-wifi-section-title',
            x_expand: true,
        });
        inputHeaderBox.add_child(inputHeaderLabel);
        inputHeaderItem.add_child(inputHeaderBox);
        menu.addMenuItem(inputHeaderItem);

        // 6. Input Section: Mic Volume Slider Row (Inline, unboxed)
        const inputSliderItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const inputSliderRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px; padding: 2px 8px; margin: 0 4px;',
        });

        const inputMuteBtn = new St.Button({
            style_class: 'wave-wifi-icon-btn',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const source = this._audioControl ? this._audioControl.get_default_source() : null;
        const inputFraction = source ? Math.max(0, Math.min(1.0, source.volume / maxNorm)) : 0;
        const isSourceMuted = source ? source.is_muted : false;

        this._inputMuteIcon = new St.Icon({
            icon_name: this._getMicIconName(inputFraction, isSourceMuted),
            icon_size: 16,
            style_class: 'wave-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        inputMuteBtn.set_child(this._inputMuteIcon);
        inputMuteBtn.connect('clicked', () => {
            const curSource = this._audioControl?.get_default_source();
            if (!curSource) return;
            curSource.change_is_muted(!curSource.is_muted);
        });
        inputSliderRow.add_child(inputMuteBtn);

        this._inputSlider = new Slider(inputFraction);
        this._inputSlider.x_expand = true;
        this._inputSlider.y_align = Clutter.ActorAlign.CENTER;

        this._inputSlider.connect('drag-begin', () => { this._isDraggingInputSlider = true; });
        this._inputSlider.connect('drag-end', () => {
            this._isDraggingInputSlider = false;
            const curSource = this._audioControl?.get_default_source();
            if (curSource) {
                const val = this._inputSlider.value;
                curSource.volume = Math.round(val * maxNorm);
                curSource.push_volume();
            }
        });
        this._inputSlider.connect('notify::value', () => {
            if (this._syncingVolumeUI) return;
            const curSource = this._audioControl?.get_default_source();
            if (!curSource) return;
            const val = this._inputSlider.value;
            curSource.volume = Math.round(val * maxNorm);
            curSource.push_volume();
            if (curSource.is_muted && val > 0) {
                curSource.change_is_muted(false);
            }
            if (this._inputPercentLabel) {
                this._inputPercentLabel.text = `${Math.round(val * 100)}%`;
            }
            this._inputMuteIcon.icon_name = this._getMicIconName(val, curSource.is_muted);
        });

        const inputSliderBin = new St.Bin({
            style_class: 'slider-bin',
            child: this._inputSlider,
            reactive: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        inputSliderRow.add_child(inputSliderBin);

        this._inputPercentLabel = new St.Label({
            text: `${Math.round(inputFraction * 100)}%`,
            style_class: 'wave-wifi-item-rate',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 36px; text-align: right;',
        });
        inputSliderRow.add_child(this._inputPercentLabel);

        inputSliderItem.add_child(inputSliderRow);
        menu.addMenuItem(inputSliderItem);

        // 7. Input Section: Collapsible Devices Drawer (Compressed)
        const curSourceDev = source ? this._audioControl.lookup_input_id(source.get_id()) : null;
        const curSourceName = curSourceDev ? curSourceDev.get_description() : (source ? source.get_description() : _('Micrófono'));

        const inputToggleItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const inputToggleBtn = new St.Button({
            style_class: 'wave-wifi-net-row',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            style: 'padding: 5px 8px; margin: 0 4px; border-radius: 6px;',
        });
        const inputToggleBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 8px;',
        });
        this._inputToggleIcon = new St.Icon({
            icon_size: 16,
            style_class: 'wave-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._inputToggleIcon.gicon = this._getSymbolicGIcon(curSourceDev?.get_gicon(), 'audio-input-microphone-symbolic');

        this._inputToggleLabel = new St.Label({
            text: _('Entrada: %s').format(curSourceName),
            style_class: 'wave-wifi-item-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const inputArrowLabel = new St.Label({
            text: '▾',
            style_class: 'wave-wifi-item-rate',
            y_align: Clutter.ActorAlign.CENTER,
        });
        inputToggleBox.add_child(this._inputToggleIcon);
        inputToggleBox.add_child(this._inputToggleLabel);
        inputToggleBox.add_child(inputArrowLabel);
        inputToggleBtn.set_child(inputToggleBox);
        inputToggleItem.add_child(inputToggleBtn);
        menu.addMenuItem(inputToggleItem);

        const inputDrawerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        inputDrawerItem.actor.visible = false;
        this._inputDevicesBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'wave-wifi-sec-menu',
            style: 'margin: 2px 8px 4px 8px; padding: 2px;',
        });
        inputDrawerItem.add_child(this._inputDevicesBox);
        menu.addMenuItem(inputDrawerItem);

        inputToggleBtn.connect('clicked', () => {
            inputDrawerItem.actor.visible = !inputDrawerItem.actor.visible;
            inputArrowLabel.text = inputDrawerItem.actor.visible ? '▴' : '▾';
            if (inputDrawerItem.actor.visible) {
                this._rebuildAudioDevicesList(this._inputDevicesBox, 'input');
            }
        });

        // 8. Separator
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 9. Sound Settings Item
        const settingsItem = new PopupMenu.PopupMenuItem(_('Configuración de sonido...'));
        const settingsIcon = new St.Icon({
            icon_name: 'emblem-system-symbolic',
            fallback_icon_name: 'preferences-system-symbolic',
            icon_size: 16,
            style_class: 'wave-volume-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsItem.insert_child_at_index(settingsIcon, 0);
        settingsItem.connect('activate', () => {
            menu.close();
            this._runCommandAsync(['gnome-control-center', 'sound']);
        });
        menu.addMenuItem(settingsItem);

        this._registerMenu(menu);
    }

    _syncVolumeMenuValues() {
        if (!this._audioControl || !this._volumeMenu || !this._volumeMenu.isOpen) return;

        this._syncingVolumeUI = true;
        try {
            const maxNorm = this._audioControl.get_vol_max_norm() || 65536;

            // Output sync
            const sink = this._audioControl.get_default_sink();
            if (sink) {
                const fraction = Math.max(0, Math.min(1.0, sink.volume / maxNorm));
                if (this._outputSlider && !this._isDraggingOutputSlider) {
                    this._outputSlider.value = fraction;
                }
                if (this._outputPercentLabel) {
                    this._outputPercentLabel.text = `${Math.round(fraction * 100)}%`;
                }
                if (this._outputMuteIcon) {
                    this._outputMuteIcon.icon_name = this._getVolumeIconName(fraction, sink.is_muted);
                }
                if (this._outputToggleLabel) {
                    const dev = this._audioControl.lookup_output_id(sink.get_id());
                    const name = dev ? dev.get_description() : sink.get_description();
                    this._outputToggleLabel.text = _('Salida: %s').format(name);
                    if (this._outputToggleIcon) {
                        this._outputToggleIcon.gicon = this._getSymbolicGIcon(dev?.get_gicon(), 'audio-speakers-symbolic');
                    }
                }
            }

            // Input sync
            const source = this._audioControl.get_default_source();
            if (source) {
                const fraction = Math.max(0, Math.min(1.0, source.volume / maxNorm));
                if (this._inputSlider && !this._isDraggingInputSlider) {
                    this._inputSlider.value = fraction;
                }
                if (this._inputPercentLabel) {
                    this._inputPercentLabel.text = `${Math.round(fraction * 100)}%`;
                }
                if (this._inputMuteIcon) {
                    this._inputMuteIcon.icon_name = this._getMicIconName(fraction, source.is_muted);
                }
                if (this._inputToggleLabel) {
                    const dev = this._audioControl.lookup_input_id(source.get_id());
                    const name = dev ? dev.get_description() : source.get_description();
                    this._inputToggleLabel.text = _('Entrada: %s').format(name);
                    if (this._inputToggleIcon) {
                        this._inputToggleIcon.gicon = this._getSymbolicGIcon(dev?.get_gicon(), 'audio-input-microphone-symbolic');
                    }
                }
            }
        } finally {
            this._syncingVolumeUI = false;
        }
    }

    _refreshAudioDeviceLists() {
        if (!this._volumeMenu || !this._volumeMenu.isOpen) return;
        if (this._outputDevicesBox && this._outputDevicesBox.mapped) {
            this._rebuildAudioDevicesList(this._outputDevicesBox, 'output');
        }
        if (this._inputDevicesBox && this._inputDevicesBox.mapped) {
            this._rebuildAudioDevicesList(this._inputDevicesBox, 'input');
        }
    }

    _rebuildAudioDevicesList(container, type) {
        container.destroy_all_children();
        if (!this._audioControl) return;

        const isOutput = type === 'output';
        const streams = isOutput ? this._audioControl.get_sinks() : this._audioControl.get_sources();
        const defaultStream = isOutput ? this._audioControl.get_default_sink() : this._audioControl.get_default_source();

        if (!streams || streams.length === 0) {
            const emptyLabel = new St.Label({
                text: isOutput ? _('No hay salidas de audio') : _('No hay micrófonos disponibles'),
                style_class: 'wave-wifi-item-rate',
                style: 'padding: 4px 8px;',
            });
            container.add_child(emptyLabel);
            return;
        }

        for (const s of streams) {
            const dev = isOutput
                ? this._audioControl.lookup_output_id(s.get_id())
                : this._audioControl.lookup_input_id(s.get_id());

            const devName = dev ? dev.get_description() : s.get_description();
            const isActive = defaultStream && defaultStream.get_id() === s.get_id();

            const rowBtn = new St.Button({
                style_class: 'wave-wifi-net-row',
                can_focus: true,
                track_hover: true,
                x_expand: true,
                style: 'padding: 5px 8px; border-radius: 6px;',
            });
            const rowBox = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 8px;',
            });

            const devIcon = new St.Icon({
                icon_size: 16,
                style_class: isActive
                    ? 'wave-volume-icon wave-audio-dev-icon wave-wifi-item-active-icon'
                    : 'wave-volume-icon wave-audio-dev-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            devIcon.gicon = this._getSymbolicGIcon(dev?.get_gicon(), isOutput ? 'audio-speakers-symbolic' : 'audio-input-microphone-symbolic');
            rowBox.add_child(devIcon);

            const nameLabel = new St.Label({
                text: devName,
                style_class: isActive ? 'wave-wifi-item-name-active' : 'wave-wifi-item-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            rowBox.add_child(nameLabel);

            if (isActive) {
                const checkIcon = new St.Icon({
                    icon_name: 'emblem-ok-symbolic',
                    icon_size: 14,
                    style_class: 'wave-volume-icon wave-wifi-item-active-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                rowBox.add_child(checkIcon);
            }

            rowBtn.set_child(rowBox);
            rowBtn.connect('clicked', () => {
                if (isOutput) {
                    if (dev) {
                        this._audioControl.change_output(dev);
                    } else if (this._audioControl.set_default_sink) {
                        this._audioControl.set_default_sink(s);
                    }
                    if (this._outputToggleLabel) {
                        this._outputToggleLabel.text = _('Salida: %s').format(devName);
                    }
                    if (this._outputToggleIcon) {
                        this._outputToggleIcon.gicon = this._getSymbolicGIcon(dev?.get_gicon(), 'audio-speakers-symbolic');
                    }
                } else {
                    if (dev) {
                        this._audioControl.change_input(dev);
                    } else if (this._audioControl.set_default_source) {
                        this._audioControl.set_default_source(s);
                    }
                    if (this._inputToggleLabel) {
                        this._inputToggleLabel.text = _('Entrada: %s').format(devName);
                    }
                    if (this._inputToggleIcon) {
                        this._inputToggleIcon.gicon = this._getSymbolicGIcon(dev?.get_gicon(), 'audio-input-microphone-symbolic');
                    }
                }
                this._rebuildAudioDevicesList(container, type);
            });
            container.add_child(rowBtn);
        }
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
        menu.actor.style = 'background-color: transparent !important; background: transparent !important; border: none !important; box-shadow: none !important;';

        if (menu.box) {
            menu.box.add_style_class_name('wave-popup-menu-content');
        }
        const isLight = Boolean(this._isLightMode);
        if (isLight) {
            menu.actor.add_style_class_name('theme-light');
            menu.actor.remove_style_class_name('theme-dark');
            if (menu.box) {
                menu.box.add_style_class_name('theme-light');
                menu.box.remove_style_class_name('theme-dark');
                menu.box.style = 'background-color: #f6f6f8 !important; color: #1c1c1e !important; border: 1px solid rgba(0, 0, 0, 0.14) !important; border-radius: 14px !important; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.20) !important;';
            }
        } else {
            menu.actor.add_style_class_name('theme-dark');
            menu.actor.remove_style_class_name('theme-light');
            if (menu.box) {
                menu.box.add_style_class_name('theme-dark');
                menu.box.remove_style_class_name('theme-light');
                menu.box.style = 'background-color: #242428 !important; color: #ffffff !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 14px !important; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55) !important;';
            }
        }
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

    // --- NOTIFICATIONS SYSTEM & MENU ---
    _setupNotificationBanners() {
        if (!Main.messageTray) return;

        try {
            if (Main.messageTray._bannerBin) {
                this._origBannerBinXAlign = Main.messageTray._bannerBin.x_align;
                this._origBannerBinMarginRight = Main.messageTray._bannerBin.margin_right;
                Main.messageTray._bannerBin.x_align = Clutter.ActorAlign.END;
                Main.messageTray._bannerBin.margin_right = 16;
            }

            const self = this;
            const origUpdate = Main.messageTray._updateShowingNotification;
            this._origUpdateShowingNotification = origUpdate;

            Main.messageTray._updateShowingNotification = function () {
                this._notification.acknowledged = true;
                this._notification.playSound();

                if (this._notification.urgency === MessageTray.Urgency.CRITICAL ||
                    this._notification.source.policy.forceExpanded)
                    this._expandBanner(true);

                this._notificationState = MessageTray.State.SHOWING;
                this._bannerBin.remove_all_transitions();
                this._bannerBin.ease({
                    opacity: 255,
                    duration: MessageTray.ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                this._bannerBin.set_pivot_point(0.5, 0.5);
                this._bannerBin.scale_x = 0.9;
                this._bannerBin.scale_y = 0.9;
                const targetY = (self._barHeight || 28) + 6;
                this._bannerBin.ease({
                    y: targetY,
                    scale_x: 1,
                    scale_y: 1,
                    duration: MessageTray.ANIMATION_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK,
                    onComplete: () => {
                        this._notificationState = MessageTray.State.SHOWN;
                        this._showNotificationCompleted();
                        this._updateState();
                    },
                });
            };
        } catch (e) {
            console.warn('[WaveTopBar] Error setting up notification banner positioning:', e);
        }
    }

    _restoreNotificationBanners() {
        if (this._origUpdateShowingNotification && Main.messageTray) {
            Main.messageTray._updateShowingNotification = this._origUpdateShowingNotification;
            this._origUpdateShowingNotification = null;
        }
        if (Main.messageTray?._bannerBin) {
            if (this._origBannerBinXAlign !== undefined && this._origBannerBinXAlign !== null)
                Main.messageTray._bannerBin.x_align = this._origBannerBinXAlign;
            if (this._origBannerBinMarginRight !== undefined && this._origBannerBinMarginRight !== null)
                Main.messageTray._bannerBin.margin_right = this._origBannerBinMarginRight;
        }
    }

    _setupNotificationTracking() {
        if (!Main.messageTray) return;

        this._trackedSources = new Set();
        this._notifSignals = [];

        const onSourcesChanged = () => {
            this._updateNotificationBadge();
            if (this._notificationsMenu && this._notificationsMenu.isOpen) {
                this._rebuildNotificationsList();
            }
        };

        const connectSource = (source) => {
            if (!source || this._trackedSources.has(source)) return;
            this._trackedSources.add(source);

            const addedId = source.connect('notification-added', onSourcesChanged);
            const removedId = source.connect('notification-removed', onSourcesChanged);
            const destroyId = source.connect('destroy', () => {
                this._trackedSources.delete(source);
                onSourcesChanged();
            });

            source._waveNotifSignals = [addedId, removedId, destroyId];
        };

        const sig1 = Main.messageTray.connect('source-added', (_tray, source) => {
            connectSource(source);
            onSourcesChanged();
        });
        const sig2 = Main.messageTray.connect('source-removed', () => {
            onSourcesChanged();
        });
        const sig3 = Main.messageTray.connect('queue-changed', () => {
            onSourcesChanged();
        });

        this._notifSignals = [sig1, sig2, sig3];

        try {
            const sources = Main.messageTray.getSources();
            for (const s of sources) {
                connectSource(s);
            }
        } catch (e) {
            // ignore
        }

        this._updateNotificationBadge();
    }

    _teardownNotificationTracking() {
        if (Main.messageTray && this._notifSignals) {
            for (const id of this._notifSignals) {
                try { Main.messageTray.disconnect(id); } catch (e) {}
            }
            this._notifSignals = [];
        }
        if (this._trackedSources) {
            for (const source of this._trackedSources) {
                if (source._waveNotifSignals) {
                    for (const id of source._waveNotifSignals) {
                        try { source.disconnect(id); } catch (e) {}
                    }
                    delete source._waveNotifSignals;
                }
            }
            this._trackedSources.clear();
            this._trackedSources = null;
        }
    }

    _getNotificationCount() {
        let count = 0;
        try {
            const sources = Main.messageTray ? Main.messageTray.getSources() : [];
            for (const source of sources) {
                if (source && source.notifications) {
                    count += source.notifications.length;
                }
            }
        } catch (e) {
            // ignore
        }
        return count;
    }

    _updateNotificationBadge() {
        if (!this._notificationsBadge) return;
        const count = this._getNotificationCount();
        if (count > 0) {
            this._notificationsBadge.text = count > 99 ? '99+' : `${count}`;
            this._notificationsBadge.visible = true;
        } else {
            this._notificationsBadge.text = '';
            this._notificationsBadge.visible = false;
        }
    }

    _getAllNotifications() {
        const list = [];
        try {
            const sources = Main.messageTray ? Main.messageTray.getSources() : [];
            for (const source of sources) {
                if (source && source.notifications && source.notifications.length) {
                    for (const notif of source.notifications) {
                        list.push({ source, notif });
                    }
                }
            }
        } catch (e) {
            console.warn('[WaveTopBar] Error reading notifications:', e);
        }
        list.sort((a, b) => {
            const timeA = a.notif.datetime ? a.notif.datetime.to_unix() : 0;
            const timeB = b.notif.datetime ? b.notif.datetime.to_unix() : 0;
            return timeB - timeA;
        });
        return list;
    }

    _clearAllNotifications() {
        try {
            const sources = Main.messageTray ? Main.messageTray.getSources() : [];
            for (const source of sources) {
                if (source && source.notifications) {
                    const copy = [...source.notifications];
                    for (const notif of copy) {
                        try {
                            notif.destroy();
                        } catch (e) {
                            // ignore
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[WaveTopBar] Error clearing notifications:', e);
        }
        this._updateNotificationBadge();
        if (this._notificationsMenu && this._notificationsMenu.isOpen) {
            this._rebuildNotificationsList();
        }
    }

    _formatNotificationTime(datetime) {
        if (!datetime) return _('ahora');
        try {
            const now = GLib.DateTime.new_now_local();
            const diffSec = now.to_unix() - datetime.to_unix();
            if (diffSec < 60) {
                return _('ahora');
            } else if (diffSec < 3600) {
                const mins = Math.floor(diffSec / 60);
                return `${mins}m`;
            } else if (diffSec < 86400) {
                const hours = Math.floor(diffSec / 3600);
                return `${hours}h`;
            } else {
                return datetime.format('%d %b') || '';
            }
        } catch (e) {
            return '';
        }
    }

    _toggleNotificationsMenu() {
        if (this._notificationsMenu && this._notificationsMenu.isOpen) {
            this._notificationsMenu.close();
        } else {
            this._showNotificationsMenu();
        }
    }

    _showNotificationsMenu() {
        this._closeAllMenus();

        const menu = new PopupMenu.PopupMenu(this._notificationsBtn, 0.5, St.Side.TOP);
        this._notificationsMenu = menu;
        menu.actor.add_style_class_name('wave-wifi-menu');
        menu.actor.add_style_class_name('wave-notifications-menu');
        menu.actor.width = 350;

        menu.connect('destroy', () => {
            if (this._notificationsMenu === menu) {
                this._notificationsMenu = null;
                this._notificationsListBox = null;
                this._notificationsClearAllBtn = null;
            }
        });

        // 1. Header: "NOTIFICACIONES" + "Limpiar todo" button
        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'wave-wifi-header-item',
        });
        const headerBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const headerTitle = new St.Label({
            text: _('NOTIFICACIONES'),
            style_class: 'wave-wifi-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(headerTitle);

        const headerSpacer = new St.Widget({ x_expand: true });
        headerBox.add_child(headerSpacer);

        this._notificationsClearAllBtn = new St.Button({
            style_class: 'wave-wifi-refresh-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const clearAllLabel = new St.Label({
            text: _('Limpiar todo'),
            style: 'font-size: 11px; font-weight: 600;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notificationsClearAllBtn.set_child(clearAllLabel);
        this._notificationsClearAllBtn.connect('clicked', () => {
            this._clearAllNotifications();
        });
        headerBox.add_child(this._notificationsClearAllBtn);

        headerItem.add_child(headerBox);
        menu.addMenuItem(headerItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 2. Scrollable Notifications List
        const scrollItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style: 'padding: 0 !important; margin: 0 !important;',
        });
        const scrollView = new St.ScrollView({
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            style: 'max-height: 380px;',
        });
        this._notificationsListBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        scrollView.add_child(this._notificationsListBox);
        scrollItem.add_child(scrollView);
        menu.addMenuItem(scrollItem);

        this._rebuildNotificationsList();

        // 3. Footer: Settings shortcut
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem(_('Configuración de Notificaciones...'));
        const settingsIcon = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            fallback_icon_name: 'emblem-system-symbolic',
            icon_size: 14,
            style_class: 'wave-topbar-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsItem.insert_child_at_index(settingsIcon, 0);
        settingsItem.connect('activate', () => {
            menu.close();
            this._runCommandAsync(['gnome-control-center', 'notifications']);
        });
        menu.addMenuItem(settingsItem);

        this._registerMenu(menu);
    }

    _rebuildNotificationsList() {
        if (!this._notificationsListBox) return;
        this._notificationsListBox.destroy_all_children();

        const notifs = this._getAllNotifications();

        if (this._notificationsClearAllBtn) {
            this._notificationsClearAllBtn.visible = notifs.length > 0;
        }

        if (notifs.length === 0) {
            const placeholder = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'padding: 32px 16px; spacing: 8px;',
            });

            const emptyIcon = new St.Icon({
                icon_name: 'notifications-disabled-symbolic',
                fallback_icon_name: 'preferences-system-notifications-symbolic',
                icon_size: 32,
                style: 'opacity: 0.5;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            placeholder.add_child(emptyIcon);

            const emptyTitle = new St.Label({
                text: _('No hay notificaciones'),
                style: 'font-size: 13px; font-weight: 700; opacity: 0.75;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            placeholder.add_child(emptyTitle);

            const emptySub = new St.Label({
                text: _('Todas las notificaciones al día'),
                style: 'font-size: 11px; opacity: 0.5;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            placeholder.add_child(emptySub);

            this._notificationsListBox.add_child(placeholder);
            return;
        }

        for (const item of notifs) {
            const { source, notif } = item;

            const card = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'wave-notification-card',
            });

            // Top row: App icon, app title, time, close button
            const topRow = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 4px;',
            });

            let appIcon = null;
            if (notif.gicon) {
                appIcon = new St.Icon({ gicon: notif.gicon, icon_size: 14 });
            } else if (source && source.icon) {
                appIcon = new St.Icon({ gicon: source.icon, icon_size: 14 });
            } else {
                appIcon = new St.Icon({
                    icon_name: 'preferences-system-notifications-symbolic',
                    icon_size: 14,
                });
            }
            topRow.add_child(appIcon);

            const appName = new St.Label({
                text: (source && source.title) ? source.title : _('Sistema'),
                style_class: 'wave-notification-app-name',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.START,
            });
            appName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            topRow.add_child(appName);

            const dotLabel = new St.Label({
                text: '•',
                style: 'opacity: 0.4; font-size: 10px;',
                y_align: Clutter.ActorAlign.CENTER,
            });
            topRow.add_child(dotLabel);

            const timeLabel = new St.Label({
                text: this._formatNotificationTime(notif.datetime),
                style_class: 'wave-wifi-item-rate',
                y_align: Clutter.ActorAlign.CENTER,
            });
            topRow.add_child(timeLabel);

            const topSpacer = new St.Widget({ x_expand: true });
            topRow.add_child(topSpacer);

            // Individual delete button
            const closeBtn = new St.Button({
                style_class: 'wave-wifi-action-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const closeIcon = new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 11,
            });
            closeBtn.set_child(closeIcon);
            closeBtn.connect('clicked', () => {
                try {
                    notif.destroy();
                } catch (e) {
                    console.warn('[WaveTopBar] Error dismissing notification:', e);
                }
                this._updateNotificationBadge();
                this._rebuildNotificationsList();
            });
            topRow.add_child(closeBtn);

            card.add_child(topRow);

            // Notification content button (activates notification when clicked)
            const contentBtn = new St.Button({
                can_focus: true,
                x_expand: true,
                style: 'background-color: transparent !important; background: transparent !important; border: none !important; box-shadow: none !important; text-align: left; padding: 2px 0;',
            });
            const contentBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style: 'spacing: 2px;',
            });

            if (notif.title) {
                const titleLabel = new St.Label({
                    text: notif.title,
                    style_class: 'wave-notification-title',
                    x_align: Clutter.ActorAlign.START,
                });
                titleLabel.clutter_text.line_wrap = false;
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                contentBox.add_child(titleLabel);
            }

            if (notif.body) {
                const bodyLabel = new St.Label({
                    text: notif.body,
                    style_class: 'wave-notification-body',
                    x_align: Clutter.ActorAlign.START,
                });
                bodyLabel.clutter_text.line_wrap = true;
                bodyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                contentBox.add_child(bodyLabel);
            }

            contentBtn.set_child(contentBox);
            contentBtn.connect('clicked', () => {
                this._closeAllMenus();
                try {
                    notif.activate();
                } catch (e) {
                    console.warn('[WaveTopBar] Error activating notification:', e);
                }
            });
            card.add_child(contentBtn);

            // Action buttons (if any)
            if (notif.actions && notif.actions.length > 0) {
                const actionsBox = new St.BoxLayout({
                    vertical: false,
                    style: 'spacing: 6px; margin-top: 6px;',
                });
                for (const action of notif.actions) {
                    const actionBtn = new St.Button({
                        label: action.label,
                        style_class: 'wave-wifi-connect-btn',
                        can_focus: true,
                    });
                    actionBtn.connect('clicked', () => {
                        this._closeAllMenus();
                        try {
                            action.activate();
                        } catch (e) {
                            console.warn('[WaveTopBar] Error activating action:', e);
                        }
                    });
                    actionsBox.add_child(actionBtn);
                }
                card.add_child(actionsBox);
            }

            this._notificationsListBox.add_child(card);
        }
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

        if (isLightMode) {
            this._topBar.add_style_class_name('theme-light');
            this._topBar.remove_style_class_name('theme-dark');
            if (this._contentBox) {
                this._contentBox.add_style_class_name('theme-light');
                this._contentBox.remove_style_class_name('theme-dark');
            }
        } else {
            this._topBar.add_style_class_name('theme-dark');
            this._topBar.remove_style_class_name('theme-light');
            if (this._contentBox) {
                this._contentBox.add_style_class_name('theme-dark');
                this._contentBox.remove_style_class_name('theme-light');
            }
        }

        const updateMenuTheme = (m) => {
            if (!m) return;
            if (isLightMode) {
                m.actor.add_style_class_name('theme-light');
                m.actor.remove_style_class_name('theme-dark');
                if (m.box) {
                    m.box.add_style_class_name('theme-light');
                    m.box.remove_style_class_name('theme-dark');
                    m.box.style = 'background-color: #f6f6f8 !important; color: #1c1c1e !important; border: 1px solid rgba(0, 0, 0, 0.14) !important; border-radius: 14px !important; box-shadow: 0 10px 32px rgba(0, 0, 0, 0.20) !important;';
                }
            } else {
                m.actor.add_style_class_name('theme-dark');
                m.actor.remove_style_class_name('theme-light');
                if (m.box) {
                    m.box.add_style_class_name('theme-dark');
                    m.box.remove_style_class_name('theme-light');
                    m.box.style = 'background-color: #242428 !important; color: #ffffff !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; border-radius: 14px !important; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55) !important;';
                }
            }
        };

        if (this._wifiMenu && this._wifiMenu.isOpen) updateMenuTheme(this._wifiMenu);
        if (this._volumeMenu && this._volumeMenu.isOpen) updateMenuTheme(this._volumeMenu);
        if (this._batteryMenu && this._batteryMenu.isOpen) updateMenuTheme(this._batteryMenu);
        if (this._clockMenu && this._clockMenu.isOpen) updateMenuTheme(this._clockMenu);
        if (this._systemMenu && this._systemMenu.isOpen) updateMenuTheme(this._systemMenu);
        if (this._appMenu && this._appMenu.isOpen) updateMenuTheme(this._appMenu);
        if (this._contextMenu && this._contextMenu.isOpen) updateMenuTheme(this._contextMenu);

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
        const showVol = this._settings.get_boolean('show-volume');
        const showBat = this._settings.get_boolean('show-battery');
        const showNotif = this._settings.get_boolean('show-notifications');
        const showCC = this._settings.get_boolean('show-control-center');
        const showClock = this._settings.get_boolean('show-clock');

        if (this._logoBtn) this._logoBtn.visible = showSys;
        if (this._activeAppBtn) this._activeAppBtn.visible = showApp;
        if (this._spotlightBtn) this._spotlightBtn.visible = showSpot;
        if (this._wifiBtn) this._wifiBtn.visible = showWifi;
        if (this._bluetoothBtn) this._bluetoothBtn.visible = showBt;
        if (this._volumeBtn) this._volumeBtn.visible = showVol;
        if (this._batteryBtn) this._batteryBtn.visible = showBat;
        if (this._notificationsBtn) this._notificationsBtn.visible = showNotif;
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

        const prefsItem = new PopupMenu.PopupMenuItem(_('Configuración de MyTopBar...'));
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
            GLib.spawn_command_line_async('gnome-extensions prefs MyTopBar@demonc');
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

        if (this._wifiMenu) {
            this._wifiMenu.close();
            this._wifiMenu.destroy();
            this._wifiMenu = null;
        }
        if (this._wifiThroughputTimerId) {
            GLib.source_remove(this._wifiThroughputTimerId);
            this._wifiThroughputTimerId = 0;
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
        if (this._notificationsMenu) {
            this._notificationsMenu.close();
            this._notificationsMenu.destroy();
            this._notificationsMenu = null;
        }
        if (this._volumeMenu) {
            this._volumeMenu.close();
            this._volumeMenu.destroy();
            this._volumeMenu = null;
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
            this._scheduleCheck();
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

    _isWindowTriggeringAutoHide(win, monitor) {
        if (!win || win.get_monitor() !== monitor.index)
            return false;
        if (win.is_hidden() || win.minimized)
            return false;
        if (win.is_skip_taskbar())
            return false;

        const activeWS = global.workspace_manager.get_active_workspace();
        if (activeWS && win.get_workspace() && win.get_workspace() !== activeWS)
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

        // Overlapping top bar resting area
        const frameRect = win.get_frame_rect();
        if (frameRect) {
            const isNearTop = frameRect.y < (monitor.y + this._barHeight);
            if (isNearTop)
                return true;
        }

        return false;
    }

    _shouldAutoHide() {
        if (!this._settings || !this._settings.get_boolean('autohide-in-fullscreen-or-maximized'))
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

        // 2. Focused window (if valid, visible and not minimized)
        const focusWin = global.display.focus_window;
        if (focusWin && !focusWin.minimized && !focusWin.is_hidden() && this._isWindowTriggeringAutoHide(focusWin, monitor))
            return true;

        // 3. Any visible, non-minimized window on the current active workspace that is maximized, fullscreen, or overlapping top bar
        const workspace = global.workspace_manager.get_active_workspace();
        if (workspace) {
            const windows = workspace.list_windows();
            for (const win of windows) {
                if (this._isWindowTriggeringAutoHide(win, monitor))
                    return true;
            }
        }

        return false;
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

        if (this._shouldAutoHide()) {
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
            this._volumeBtn,
            this._batteryBtn,
            this._notificationsBtn,
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
        global.window_manager.disconnectObject(this);
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

        if (this._audioControl && this._audioControlSignals.length) {
            for (const id of this._audioControlSignals) {
                try { this._audioControl.disconnect(id); } catch (e) {}
            }
            this._audioControlSignals = [];
        }
        if (this._currentSink && this._sinkSignals.length) {
            for (const id of this._sinkSignals) {
                try { this._currentSink.disconnect(id); } catch (e) {}
            }
            this._sinkSignals = [];
        }
        if (this._currentSource && this._sourceSignals.length) {
            for (const id of this._sourceSignals) {
                try { this._currentSource.disconnect(id); } catch (e) {}
            }
            this._sourceSignals = [];
        }
        this._audioControl = null;
        this._currentSink = null;
        this._currentSource = null;
        this._volumeMenu = null;
        this._volumeBtn = null;
        this._volumeIcon = null;

        // Teardown notifications & banner placement
        this._teardownNotificationTracking();
        this._restoreNotificationBanners();
        this._notificationsBtn = null;
        this._notificationsIcon = null;
        this._notificationsBadge = null;
        this._notificationsMenu = null;
        this._notificationsListBox = null;
        this._notificationsClearAllBtn = null;

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
