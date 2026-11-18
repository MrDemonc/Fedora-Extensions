/*
   Wave Top Bar Preferences
   GNOME Shell 45+ (Adwaita / GTK4)
*/

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MyTopBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        // --- GROUP 1: DISEÑO Y APARIENCIA ---
        const designGroup = new Adw.PreferencesGroup({
            title: _('Diseño y Apariencia'),
            description: _('Personaliza el estilo visual, desenfoque y dimensiones de la barra.'),
        });
        page.add(designGroup);

        // Barra flotante
        const floatingRow = new Adw.SwitchRow({
            title: _('Barra flotante'),
            subtitle: _('Muestra la barra con esquinas redondeadas y márgenes flotantes.'),
        });
        settings.bind('floating-bar', floatingRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        designGroup.add(floatingRow);

        // Efecto Blur
        const blurRow = new Adw.SwitchRow({
            title: _('Efecto Blur (Vidrio esmerilado)'),
            subtitle: _('Aplica desenfoque de fondo al estilo de macOS.'),
        });
        settings.bind('bar-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        designGroup.add(blurRow);

        // Radio de blur
        const blurRadiusRow = new Adw.SpinRow({
            title: _('Radio del Blur (px)'),
            subtitle: _('Intensidad del efecto de desenfoque.'),
            adjustment: new Gtk.Adjustment({
                lower: 8,
                upper: 64,
                step_increment: 2,
                page_increment: 4,
                value: settings.get_int('bar-blur-radius'),
            }),
        });
        settings.bind('bar-blur-radius', blurRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        designGroup.add(blurRadiusRow);

        // Altura de la barra
        const heightRow = new Adw.SpinRow({
            title: _('Altura de la barra (px)'),
            subtitle: _('Altura vertical de la barra superior.'),
            adjustment: new Gtk.Adjustment({
                lower: 26,
                upper: 52,
                step_increment: 2,
                page_increment: 4,
                value: settings.get_int('bar-height'),
            }),
        });
        settings.bind('bar-height', heightRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        designGroup.add(heightRow);

        // Opacidad del fondo
        const opacityRow = new Adw.SpinRow({
            title: _('Opacidad del fondo (%)'),
            subtitle: _('Nivel de transparencia del fondo de la barra (recomendado 55%-75% para blur).'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('bar-opacity'),
            }),
        });
        settings.bind('bar-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        designGroup.add(opacityRow);

        // Estilo de color
        const colorModel = new Gtk.StringList();
        colorModel.append(_('Automático (Según el sistema)'));
        colorModel.append(_('Oscuro'));
        colorModel.append(_('Claro'));
        colorModel.append(_('Negro'));
        colorModel.append(_('Personalizado'));

        const colorMap = ['auto', 'dark', 'light', 'black', 'custom'];
        const currentColor = settings.get_string('bar-color') || 'auto';
        let currentIdx = colorMap.indexOf(currentColor);
        if (currentIdx === -1) currentIdx = 0;

        const colorRow = new Adw.ComboRow({
            title: _('Color del tema'),
            subtitle: _('Elige entre automático (según modo claro/oscuro de GNOME), temas fijos o personalizado.'),
            model: colorModel,
            selected: currentIdx,
        });

        colorRow.connect('notify::selected', () => {
            const selected = colorMap[colorRow.selected] || 'auto';
            settings.set_string('bar-color', selected);
            customColorRow.set_visible(selected === 'custom');
        });
        designGroup.add(colorRow);

        // Color personalizado con selector nativo
        const initialHex = settings.get_string('bar-custom-color') || '#18181c';
        const customColorRow = new Adw.ActionRow({
            title: _('Color personalizado'),
            subtitle: _('Haz clic para elegir el tono del fondo.'),
            visible: currentColor === 'custom',
        });

        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({
                title: _('Seleccionar Color de la Barra'),
                with_alpha: false,
            }),
            valign: Gtk.Align.CENTER,
        });

        const initialRgba = new Gdk.RGBA();
        initialRgba.parse(initialHex);
        colorButton.set_rgba(initialRgba);

        colorButton.connect('notify::rgba', () => {
            const rgba = colorButton.get_rgba();
            const hex = this._rgbaToHex(rgba);
            settings.set_string('bar-custom-color', hex);
        });

        customColorRow.add_suffix(colorButton);
        customColorRow.activatable_widget = colorButton;
        designGroup.add(customColorRow);

        // --- GROUP: COMPORTAMIENTO Y OCULTACIÓN ---
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Comportamiento y Ocultación'),
            description: _('Configura cómo reacciona la barra superior ante ventanas y aplicaciones.'),
        });
        page.add(behaviorGroup);

        // Ocultar con pantalla completa y ventanas maximizadas
        const autohideRow = new Adw.SwitchRow({
            title: _('Ocultar automáticamente con pantalla completa y ventanas maximizadas'),
            subtitle: _('Oculta la barra cuando una ventana esté maximizada o en pantalla completa, revelándola al pasar el cursor por el borde superior.'),
        });
        settings.bind('autohide-in-fullscreen-or-maximized', autohideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(autohideRow);

        // --- GROUP 2: ELEMENTOS Y CONTROLES ---
        const elementsGroup = new Adw.PreferencesGroup({
            title: _('Elementos y Controles'),
            description: _('Activa o desactiva widgets individuales en la barra.'),
        });
        page.add(elementsGroup);

        // Menú Fedora / Sistema
        const systemMenuRow = new Adw.SwitchRow({
            title: _('Menú de Sistema Fedora (Izquierda)'),
            subtitle: _('Botón con logo de Fedora para accesos rápidos, reinicio y apagado seguro.'),
        });
        settings.bind('show-system-menu', systemMenuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(systemMenuRow);

        // Aplicación activa
        const activeAppRow = new Adw.SwitchRow({
            title: _('Aplicación activa'),
            subtitle: _('Muestra el nombre e icono de la ventana enfocada con su menú de opciones.'),
        });
        settings.bind('show-active-app', activeAppRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(activeAppRow);

        // Spotlight Buscador de archivos
        const spotlightRow = new Adw.SwitchRow({
            title: _('Buscador Spotlight (Lupa)'),
            subtitle: _('Buscador flotante de archivos, carpetas y apps con botón para abrir en Nautilus.'),
        });
        settings.bind('show-spotlight', spotlightRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(spotlightRow);

        // Wi-Fi
        const wifiRow = new Adw.SwitchRow({
            title: _('Indicador de Wi-Fi'),
            subtitle: _('Muestra el estado de la conexión Wi-Fi.'),
        });
        settings.bind('show-wifi', wifiRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(wifiRow);

        // Bluetooth
        const btRow = new Adw.SwitchRow({
            title: _('Indicador de Bluetooth'),
            subtitle: _('Muestra si el adaptador Bluetooth está activo o conectado.'),
        });
        settings.bind('show-bluetooth', btRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(btRow);

        // Volumen y Audio
        const volumeRow = new Adw.SwitchRow({
            title: _('Control de Volumen y Audio'),
            subtitle: _('Muestra el icono de volumen para controlar audio, micrófono y dispositivos.'),
        });
        settings.bind('show-volume', volumeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(volumeRow);

        // Batería con porcentaje
        const batteryRow = new Adw.SwitchRow({
            title: _('Batería con porcentaje'),
            subtitle: _('Muestra el icono de la batería y su porcentaje numérico en vivo.'),
        });
        settings.bind('show-battery', batteryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(batteryRow);

        // Centro de Control
        const controlCenterRow = new Adw.SwitchRow({
            title: _('Centro de Control (Icono de sliders)'),
            subtitle: _('Abre el panel rápido de ajustes de GNOME.'),
        });
        settings.bind('show-control-center', controlCenterRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(controlCenterRow);

        // Reloj y Fecha (Esquina derecha)
        const clockRow = new Adw.SwitchRow({
            title: _('Reloj y Calendario (Esquina derecha)'),
            subtitle: _('Muestra la fecha y hora en el extremo derecho e interactúa con el calendario.'),
        });
        settings.bind('show-clock', clockRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        elementsGroup.add(clockRow);

        // Formato del reloj
        const clockFormatRow = new Adw.EntryRow({
            title: _('Formato de fecha y hora'),
            text: settings.get_string('clock-format') || '%a %d %b  %H:%M',
        });
        clockFormatRow.connect('changed', () => {
            settings.set_string('clock-format', clockFormatRow.text.trim() || '%a %d %b  %H:%M');
        });
        elementsGroup.add(clockFormatRow);
    }

    _rgbaToHex(rgba) {
        const r = Math.round(rgba.red * 255).toString(16).padStart(2, '0');
        const g = Math.round(rgba.green * 255).toString(16).padStart(2, '0');
        const b = Math.round(rgba.blue * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }
}
