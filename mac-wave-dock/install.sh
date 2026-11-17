#!/usr/bin/env bash
set -e

UUID="mac-wave-dock@demonc"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
TARGET_DIR="$EXT_DIR/$UUID"

case "$1" in
    --uninstall|-u)
        echo "Desinstalando extensión $UUID..."
        gnome-extensions disable "$UUID" 2>/dev/null || true
        rm -rf "$TARGET_DIR"
        echo "Extensión desinstalada correctamente."
        exit 0
        ;;
    *)
        echo "1. Compilando esquemas GSettings..."
        glib-compile-schemas "$PROJECT_DIR/schemas"

        echo "2. Copiando extensión a $TARGET_DIR..."
        mkdir -p "$EXT_DIR"
        rm -rf "$TARGET_DIR"
        mkdir -p "$TARGET_DIR"
        cp -r "$PROJECT_DIR/metadata.json" \
              "$PROJECT_DIR/extension.js" \
              "$PROJECT_DIR/pointerTracker.js" \
              "$PROJECT_DIR/prefs.js" \
              "$PROJECT_DIR/stylesheet.css" \
              "$PROJECT_DIR/schemas" \
              "$TARGET_DIR/"

        echo "3. Añadiendo a la lista de extensiones habilitadas..."
        python3 -c "
import subprocess, ast
try:
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']).decode().strip()
    lst = ast.literal_eval(out)
    if '$UUID' not in lst:
        lst.append('$UUID')
        subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(lst)])
        print('Extensión añadida a org.gnome.shell.enabled-extensions.')
    else:
        print('La extensión ya estaba en enabled-extensions.')
except Exception as e:
    print('Nota: no se pudo modificar gsettings automáticamente:', e)
"

        echo "4. Recargando extensión en tiempo real en GNOME Shell..."
        gnome-extensions disable "$UUID" 2>/dev/null || true
        sleep 0.5
        gnome-extensions enable "$UUID" 2>/dev/null || true

        echo ""
        echo "=========================================================="
        echo "  ¡Mac Wave Dock instalado y activo en tiempo real!"
        echo "=========================================================="
        echo ""
        echo "  Archivos instalados en: $TARGET_DIR"
        echo "  Estado: La extensión se ha recargado en vivo."
        echo "  NO es necesario cerrar sesión."
        echo ""
        echo "  Para abrir la ventana de preferencias:"
        echo "    gnome-extensions prefs $UUID"
        echo "=========================================================="
        ;;
esac
