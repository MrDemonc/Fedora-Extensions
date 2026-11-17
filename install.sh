#!/usr/bin/env bash
# ==============================================================================
# Demonc Extensions Suite - Unified Installer
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

TOPBAR_UUID="wave-topbar@demonc"
DOCK_UUID="mac-wave-dock@demonc"

# Colors
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
BOLD="\033[1m"
RESET="\033[0m"

print_header() {
    echo -e "${BLUE}${BOLD}"
    echo "=========================================================="
    echo "          Demonc Extensions Suite - Installer            "
    echo "=========================================================="
    echo -e "${RESET}"
}

enable_in_gsettings() {
    local uuid="$1"
    python3 -c "
import subprocess, ast
try:
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']).decode().strip()
    lst = ast.literal_eval(out)
    if '$uuid' not in lst:
        lst.append('$uuid')
        subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(lst)])
        print('    [+] Extensión añadida a org.gnome.shell.enabled-extensions.')
    else:
        print('    [*] La extensión ya estaba en enabled-extensions.')
except Exception as e:
    print('    [!] Advertencia modificando gsettings:', e)
"
}

install_topbar() {
    echo -e "${CYAN}${BOLD}--> Instalando Wave Top Bar ($TOPBAR_UUID)...${RESET}"
    local src="$SCRIPT_DIR/wave-topbar"
    local dest="$EXT_DIR/$TOPBAR_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: No se encontró la carpeta $src${RESET}"
        return 1
    fi

    echo "    1. Compilando esquemas GSettings..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Copiando archivos a $dest..."
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$src"/* "$dest/"

    echo "    3. Habilitando en GNOME Shell..."
    enable_in_gsettings "$TOPBAR_UUID"

    echo "    4. Recargando extensión en tiempo real..."
    gnome-extensions disable "$TOPBAR_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$TOPBAR_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ Wave Top Bar instalado y activado con éxito.${RESET}\n"
}

install_dock() {
    echo -e "${CYAN}${BOLD}--> Instalando Mac Wave Dock ($DOCK_UUID)...${RESET}"
    local src="$SCRIPT_DIR/mac-wave-dock"
    local dest="$EXT_DIR/$DOCK_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: No se encontró la carpeta $src${RESET}"
        return 1
    fi

    echo "    1. Compilando esquemas GSettings..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Copiando archivos a $dest..."
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$src/metadata.json" \
          "$src/extension.js" \
          "$src/pointerTracker.js" \
          "$src/prefs.js" \
          "$src/stylesheet.css" \
          "$src/schemas" \
          "$dest/"

    echo "    3. Habilitando en GNOME Shell..."
    enable_in_gsettings "$DOCK_UUID"

    echo "    4. Recargando extensión en tiempo real..."
    gnome-extensions disable "$DOCK_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$DOCK_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ Mac Wave Dock instalado y activado con éxito.${RESET}\n"
}

uninstall_all() {
    echo -e "${YELLOW}${BOLD}--> Desinstalando extensiones de la Suite...${RESET}"
    gnome-extensions disable "$TOPBAR_UUID" 2>/dev/null || true
    gnome-extensions disable "$DOCK_UUID" 2>/dev/null || true
    rm -rf "$EXT_DIR/$TOPBAR_UUID" "$EXT_DIR/$DOCK_UUID"
    echo -e "${GREEN}✓ Ambas extensiones han sido desinstaladas correctamente.${RESET}"
}

print_header

case "$1" in
    topbar)
        install_topbar
        ;;
    dock)
        install_dock
        ;;
    uninstall|--uninstall|-u)
        uninstall_all
        exit 0
        ;;
    all|"")
        install_topbar
        install_dock
        ;;
    *)
        echo "Uso: $0 [all|topbar|dock|uninstall]"
        echo ""
        echo "Opciones:"
        echo "  all        Instala ambas extensiones (por defecto)"
        echo "  topbar     Instala únicamente Wave Top Bar"
        echo "  dock       Instala únicamente Mac Wave Dock"
        echo "  uninstall  Desinstala ambas extensiones de ~/.local/share/gnome-shell/extensions"
        exit 1
        ;;
esac

echo -e "${GREEN}${BOLD}=========================================================="
echo "  ¡Instalación completada con éxito!"
echo -e "==========================================================${RESET}"
echo "Ambas extensiones están activas en tiempo real (NO es necesario reiniciar sesión)."
echo ""
echo "Para configurar preferencias en cualquier momento:"
echo "  gnome-extensions prefs $TOPBAR_UUID"
echo "  gnome-extensions prefs $DOCK_UUID"
echo "=========================================================="
