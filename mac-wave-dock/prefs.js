/* Mac Wave Dock - Preferences
   GNOME Shell 45+ Libadwaita
*/

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DesktopAppInfo = GioUnix?.DesktopAppInfo || Gio.DesktopAppInfo;

export default class MacWaveDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        // Preferences Page
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'view-paged-symbolic',
        });
        window.add(page);

        // --- GROUP 1: DIMENSIONS & WAVE EFFECT ---
        const appearanceGroup = new Adw.PreferencesGroup({
            title: _('Dimensiones y Efecto de Ola (Magnificación)'),
            description: _('Personaliza las dimensiones, relleno y la animación de ola al pasar el ratón.'),
        });
        page.add(appearanceGroup);

        // Base Icon Size
        const iconSizeRow = Adw.SpinRow.new_with_range(28, 64, 2);
        iconSizeRow.title = _('Tamaño base de los iconos (px)');
        iconSizeRow.subtitle = _('Tamaño estándar compacto del dock (por defecto: 40px).');
        settings.bind('icon-size', iconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(iconSizeRow);

        // Magnification Scale
        const scaleRow = Adw.SpinRow.new_with_range(1.1, 2.0, 0.05);
        scaleRow.title = _('Escala de magnificación (Ola)');
        scaleRow.subtitle = _('Factor máximo de aumento al pasar el ratón (por defecto: 1.45x).');
        scaleRow.digits = 2;
        settings.bind('magnification-scale', scaleRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(scaleRow);

        // Wave Radius
        const waveRadiusRow = Adw.SpinRow.new_with_range(60, 240, 10);
        waveRadiusRow.title = _('Radio de propagación de la ola (px)');
        waveRadiusRow.subtitle = _('Distancia alrededor del ratón en la que los iconos vecinos responden (por defecto: 130px).');
        settings.bind('wave-radius', waveRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(waveRadiusRow);

        // Dock Padding (spacing between dock border and icons)
        const paddingRow = Adw.SpinRow.new_with_range(2, 20, 1);
        paddingRow.title = _('Relleno interior del dock (padding px)');
        paddingRow.subtitle = _('Espaciado entre el borde del dock y los iconos.');
        settings.bind('dock-padding', paddingRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(paddingRow);

        // Corner Radius
        const radiusRow = Adw.SpinRow.new_with_range(0, 40, 2);
        radiusRow.title = _('Radio de las esquinas (px)');
        radiusRow.subtitle = _('Curvatura de los bordes del dock (0px cuadrado, 20px estándar, 32px píldora).');
        settings.bind('dock-border-radius', radiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(radiusRow);

        // Bottom Margin
        const marginRow = Adw.SpinRow.new_with_range(0, 30, 2);
        marginRow.title = _('Separación del borde inferior (px)');
        marginRow.subtitle = _('Margen entre el dock y la parte inferior de la pantalla.');
        settings.bind('dock-bottom-margin', marginRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(marginRow);

        // --- GROUP 2: COLOR, TRANSPARENCY & BLUR ---
        const colorGroup = new Adw.PreferencesGroup({
            title: _('Color, Transparencia y Estilo Visual'),
            description: _('Personaliza el fondo, la opacidad, los bordes y el color personalizado.'),
        });
        page.add(colorGroup);

        // Dock Color Theme
        const colorModel = new Gtk.StringList();
        colorModel.append(_('Automático (Según el sistema)'));
        colorModel.append(_('Oscuro (macOS Dark)'));
        colorModel.append(_('Claro (macOS Light)'));
        colorModel.append(_('Negro puro'));
        colorModel.append(_('Personalizado'));

        const colorMap = ['auto', 'dark', 'light', 'black', 'custom'];
        const currentColor = settings.get_string('dock-color') || 'auto';
        let currentIdx = colorMap.indexOf(currentColor);
        if (currentIdx === -1) currentIdx = 0;

        const colorRow = new Adw.ComboRow({
            title: _('Tema de color del dock'),
            subtitle: _('Elige entre automático (según el sistema), temas fijos o personalizado.'),
            model: colorModel,
            selected: currentIdx,
        });

        colorGroup.add(colorRow);

        // Custom Color with Wheel Dialog Button
        const colorDialog = new Gtk.ColorDialog({
            title: _('Seleccionar Color Personalizado'),
            with_alpha: false,
        });

        const colorDialogButton = new Gtk.ColorDialogButton({
            dialog: colorDialog,
            valign: Gtk.Align.CENTER,
        });

        const initialRgba = new Gdk.RGBA();
        const savedHex = settings.get_string('dock-custom-color') || '#18181c';
        initialRgba.parse(savedHex);
        colorDialogButton.set_rgba(initialRgba);

        colorDialogButton.connect('notify::rgba', () => {
            const rgba = colorDialogButton.get_rgba();
            const r = Math.round(rgba.red * 255).toString(16).padStart(2, '0');
            const g = Math.round(rgba.green * 255).toString(16).padStart(2, '0');
            const b = Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
            const hex = `#${r}${g}${b}`;
            settings.set_string('dock-custom-color', hex);
        });

        const customColorRow = new Adw.ActionRow({
            title: _('Color personalizado (Círculo de colores)'),
            subtitle: _('Haz clic para abrir el círculo de colores interactivo y elegir tu tono.'),
        });
        customColorRow.add_suffix(colorDialogButton);
        customColorRow.activatable_widget = colorDialogButton;
        customColorRow.visible = (currentColor === 'custom');
        colorGroup.add(customColorRow);

        colorRow.connect('notify::selected', () => {
            const chosen = colorMap[colorRow.selected] || 'auto';
            settings.set_string('dock-color', chosen);
            customColorRow.visible = (chosen === 'custom');
        });

        // Dock Opacity
        const opacityRow = Adw.SpinRow.new_with_range(0, 100, 5);
        opacityRow.title = _('Opacidad del fondo (%)');
        opacityRow.subtitle = _('Nivel de transparencia del dock (0% transparente, 100% opaco).');
        settings.bind('dock-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        colorGroup.add(opacityRow);

        // Border Opacity
        const borderOpacityRow = Adw.SpinRow.new_with_range(0, 100, 5);
        borderOpacityRow.title = _('Opacidad del borde (%)');
        borderOpacityRow.subtitle = _('Intensidad del contorno luminoso del dock.');
        settings.bind('dock-border-opacity', borderOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        colorGroup.add(borderOpacityRow);

        // Blur Toggle
        const blurRow = new Adw.SwitchRow({
            title: _('Efecto de desenfoque experimental (Blur)'),
            subtitle: _('Aplica desenfoque detrás del dock (puede mostrar esquinas oscuras según el tema).'),
        });
        settings.bind('dock-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        colorGroup.add(blurRow);

        // Blur Radius
        const blurRadiusRow = Adw.SpinRow.new_with_range(5, 60, 5);
        blurRadiusRow.title = _('Radio de desenfoque (px)');
        blurRadiusRow.subtitle = _('Intensidad del efecto de desenfoque de fondo.');
        settings.bind('dock-blur-radius', blurRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        colorGroup.add(blurRadiusRow);

        // --- GROUP 3: BEHAVIOR & INTEGRATION ---
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Elementos y Comportamiento'),
            description: _('Activa o desactiva elementos visuales y la integración con GNOME.'),
        });
        page.add(behaviorGroup);

        // Replace GNOME Overview Dash
        const replaceDashRow = new Adw.SwitchRow({
            title: _('Reemplazar el dock nativo de GNOME'),
            subtitle: _('Oculta el dash original de GNOME al presionar la tecla Super para usar este dock.'),
        });
        settings.bind('hide-overview-dash', replaceDashRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(replaceDashRow);

        // Auto-hide in fullscreen or maximized
        const autoHideRow = new Adw.SwitchRow({
            title: _('Ocultar automáticamente en pantalla completa o maximizado'),
            subtitle: _('Oculta el dock cuando una ventana está en pantalla completa o maximizada y lo muestra al pasar el ratón por el borde inferior.'),
        });
        settings.bind('autohide-in-fullscreen', autoHideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(autoHideRow);

        // Show App Drawer
        const appDrawerRow = new Adw.SwitchRow({
            title: _('Mostrar cajón de aplicaciones'),
            subtitle: _('Muestra el icono del lanzador de aplicaciones (App Drawer) en el dock.'),
        });
        settings.bind('show-apps-drawer', appDrawerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(appDrawerRow);

        // Show Mounts
        const mountsRow = new Adw.SwitchRow({
            title: _('Mostrar discos y dispositivos conectados'),
            subtitle: _('Muestra memorias USB, discos externos y particiones montadas con opción de expulsar.'),
        });
        settings.bind('show-mounts', mountsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(mountsRow);

        // Show Running Apps
        const runningRow = new Adw.SwitchRow({
            title: _('Mostrar aplicaciones en ejecución'),
            subtitle: _('Incluye en el dock las aplicaciones abiertas aunque no estén fijadas.'),
        });
        settings.bind('show-running', runningRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(runningRow);

        // Show Trash
        const trashRow = new Adw.SwitchRow({
            title: _('Mostrar papelera en el dock'),
            subtitle: _('Muestra el icono interactivo de la papelera con el tema de iconos del sistema.'),
        });
        settings.bind('show-trash', trashRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(trashRow);

        // --- GROUP 4: FAVORITE APPS MANAGER ---
        const favSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const favGroup = new Adw.PreferencesGroup({
            title: _('Aplicaciones Fijadas en el Dock'),
            description: _('Gestiona las aplicaciones fijadas. Para cambiar el orden, mantén presionado un icono y arrástralo directamente en el dock.'),
        });
        page.add(favGroup);

        // Expander to add new apps
        const addExpander = new Adw.ExpanderRow({
            title: _('➕ Añadir aplicación al Dock'),
            subtitle: _('Selecciona una aplicación de la lista instalada para fijarla.'),
        });
        favGroup.add(addExpander);

        const updateFavoritesList = () => {
            const favorites = favSettings.get_strv('favorite-apps') || [];

            if (favGroup._rows) {
                for (const row of favGroup._rows)
                    favGroup.remove(row);
            }
            favGroup._rows = [];

            for (let i = 0; i < favorites.length; i++) {
                const appId = favorites[i];
                const appInfo = DesktopAppInfo ? DesktopAppInfo.new(appId) : Gio.DesktopAppInfo.new(appId);
                const title = appInfo ? appInfo.get_name() : appId;

                const row = new Adw.ActionRow({
                    title: title,
                    subtitle: appId,
                });

                if (appInfo) {
                    const icon = appInfo.get_icon();
                    if (icon) {
                        const img = Gtk.Image.new_from_gicon(icon);
                        img.pixel_size = 28;
                        row.add_prefix(img);
                    }
                }

                // Delete / Unpin button ONLY (reordering is done by hold & drag on the dock)
                const removeBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'destructive-action'],
                    tooltip_text: _('Desfijar del Dock'),
                });
                removeBtn.connect('clicked', () => {
                    const arr = favorites.filter(id => id !== appId);
                    favSettings.set_strv('favorite-apps', arr);
                });
                row.add_suffix(removeBtn);

                favGroup.add(row);
                favGroup._rows.push(row);
            }

            // Populate add expander
            const allApps = Gio.AppInfo.get_all()
                .filter(info => info && info.should_show() && !favorites.includes(info.get_id()))
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));

            if (addExpander._rows) {
                for (const row of addExpander._rows)
                    addExpander.remove(row);
            }
            addExpander._rows = [];

            for (const appInfo of allApps) {
                const id = appInfo.get_id();
                const row = new Adw.ActionRow({
                    title: appInfo.get_name(),
                    subtitle: id,
                });

                const icon = appInfo.get_icon();
                if (icon) {
                    const img = Gtk.Image.new_from_gicon(icon);
                    img.pixel_size = 24;
                    row.add_prefix(img);
                }

                const addBtn = new Gtk.Button({
                    icon_name: 'list-add-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'suggested-action'],
                    tooltip_text: _('Fijar en el Dock'),
                });

                addBtn.connect('clicked', () => {
                    const arr = [...favorites];
                    if (!arr.includes(id)) {
                        arr.push(id);
                        favSettings.set_strv('favorite-apps', arr);
                    }
                });

                row.add_suffix(addBtn);
                addExpander.add_row(row);
                addExpander._childRows = addExpander._childRows || [];
                addExpander._childRows.push(row);
            }
        };

        favSettings.connect('changed::favorite-apps', () => {
            updateFavoritesList();
        });

        updateFavoritesList();
    }
}
