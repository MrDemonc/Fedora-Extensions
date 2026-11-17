#!/usr/bin/env bash
# ==============================================================================
# Demonc Extensions Suite - Master Installer
# Supports local execution and remote execution via curl:
#   curl -fsSL https://raw.githubusercontent.com/demonc/Demonc-extencions/main/install.sh | bash
# ==============================================================================
set -e

# Detect script location
if [ -n "$BASH_SOURCE" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
else
    SCRIPT_DIR="$(pwd)"
fi

EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
TOPBAR_UUID="MyTopBar@demonc"
DOCK_UUID="MyDock@demonc"
OLD_TOPBAR_UUID="wave-topbar@demonc"
OLD_DOCK_UUID="mac-wave-dock@demonc"

# Colors for terminal output
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
BOLD="\033[1m"
RESET="\033[0m"

# Remote execution handler (curl ... | bash)
handle_remote_mode() {
    if [ ! -d "$SCRIPT_DIR/MyTopBar" ] || [ ! -d "$SCRIPT_DIR/MyDock" ]; then
        echo -e "${CYAN}[*] Modo remoto detectado. Descargando archivos de Demonc-extencions...${RESET}"
        TMP_DIR=$(mktemp -d /tmp/demonc-ext.XXXXXX)
        trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

        REPO_URL="https://github.com/demonc/Demonc-extencions"
        CLONED=0

        if command -v git &>/dev/null; then
            if git clone --depth 1 "$REPO_URL.git" "$TMP_DIR/repo" 2>/dev/null; then
                CLONED=1
                SCRIPT_DIR="$TMP_DIR/repo"
            fi
        fi

        if [ "$CLONED" -eq 0 ]; then
            echo -e "${CYAN}[*] Descargando archivo fuente desde GitHub...${RESET}"
            curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP_DIR"
            EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "Demonc-extencions-*" | head -n 1)
            if [ -n "$EXTRACTED_DIR" ] && [ -d "$EXTRACTED_DIR" ]; then
                SCRIPT_DIR="$EXTRACTED_DIR"
            else
                echo -e "${YELLOW}Error: No se pudieron descargar los componentes de la extensión.${RESET}"
                exit 1
            fi
        fi
        echo -e "${GREEN}[✓] Archivos descargados correctamente.${RESET}\n"
    fi
}

print_banner() {
    echo -e "${BLUE}${BOLD}"
    echo "=========================================================="
    echo "          Demonc Extensions Suite - Instalador            "
    echo "                  (MyTopBar & MyDock)                     "
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
        print('    [+] Extensión habilitada en org.gnome.shell.enabled-extensions ($uuid).')
except Exception as e:
    print('    [!] Advertencia modificando gsettings:', e)
" 2>/dev/null || true
}

remove_from_gsettings() {
    local uuid="$1"
    python3 -c "
import subprocess, ast
try:
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions']).decode().strip()
    lst = ast.literal_eval(out)
    if '$uuid' in lst:
        lst = [x for x in lst if x != '$uuid']
        subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(lst)])
except Exception:
    pass
" 2>/dev/null || true
}

install_topbar() {
    echo -e "${CYAN}${BOLD}--> Instalando MyTopBar ($TOPBAR_UUID)...${RESET}"
    local src="$SCRIPT_DIR/MyTopBar"
    local dest="$EXT_DIR/$TOPBAR_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: No se encontró el directorio $src${RESET}"
        return 1
    fi

    echo "    1. Compilando esquemas GSettings..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Instalando archivos de la extensión..."
    mkdir -p "$EXT_DIR"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$src"/* "$dest/"

    # Compatibilidad en vivo con sesión actual de Wayland
    local compat_dest="$EXT_DIR/$OLD_TOPBAR_UUID"
    rm -rf "$compat_dest"
    mkdir -p "$compat_dest"
    cp -r "$src"/* "$compat_dest/"
    sed -i "s/$TOPBAR_UUID/$OLD_TOPBAR_UUID/g" "$compat_dest/metadata.json" 2>/dev/null || true
    sed -i "s/org.gnome.shell.extensions.mytopbar/org.gnome.shell.extensions.wave-topbar/g" "$compat_dest/metadata.json" 2>/dev/null || true
    if [ -f "/home/demonc/Documentos/proyects/wave-topbar/schemas/org.gnome.shell.extensions.wave-topbar.gschema.xml" ]; then
        cp "/home/demonc/Documentos/proyects/wave-topbar/schemas/org.gnome.shell.extensions.wave-topbar.gschema.xml" "$compat_dest/schemas/"
        glib-compile-schemas "$compat_dest/schemas"
    fi

    echo "    3. Habilitando en GNOME Shell..."
    enable_in_gsettings "$TOPBAR_UUID"
    enable_in_gsettings "$OLD_TOPBAR_UUID"

    echo "    4. Recargando extensión en tiempo real..."
    gnome-extensions disable "$OLD_TOPBAR_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$OLD_TOPBAR_UUID" 2>/dev/null || true
    gnome-extensions enable "$TOPBAR_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ MyTopBar instalado y activo con éxito.${RESET}\n"
}

install_dock() {
    echo -e "${CYAN}${BOLD}--> Instalando MyDock ($DOCK_UUID)...${RESET}"
    local src="$SCRIPT_DIR/MyDock"
    local dest="$EXT_DIR/$DOCK_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: No se encontró el directorio $src${RESET}"
        return 1
    fi

    echo "    1. Compilando esquemas GSettings..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Instalando archivos de la extensión..."
    mkdir -p "$EXT_DIR"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$src/metadata.json" \
          "$src/extension.js" \
          "$src/pointerTracker.js" \
          "$src/prefs.js" \
          "$src/stylesheet.css" \
          "$src/schemas" \
          "$dest/"

    # Compatibilidad en vivo con sesión actual de Wayland
    local compat_dest="$EXT_DIR/$OLD_DOCK_UUID"
    rm -rf "$compat_dest"
    mkdir -p "$compat_dest"
    cp -r "$dest"/* "$compat_dest/"
    sed -i "s/$DOCK_UUID/$OLD_DOCK_UUID/g" "$compat_dest/metadata.json" 2>/dev/null || true
    sed -i "s/org.gnome.shell.extensions.mydock/org.gnome.shell.extensions.mac-wave-dock/g" "$compat_dest/metadata.json" 2>/dev/null || true
    if [ -f "/home/demonc/Documentos/proyects/mac-wave-dock/schemas/org.gnome.shell.extensions.mac-wave-dock.gschema.xml" ]; then
        cp "/home/demonc/Documentos/proyects/mac-wave-dock/schemas/org.gnome.shell.extensions.mac-wave-dock.gschema.xml" "$compat_dest/schemas/"
        glib-compile-schemas "$compat_dest/schemas"
    fi

    echo "    3. Habilitando en GNOME Shell..."
    enable_in_gsettings "$DOCK_UUID"
    enable_in_gsettings "$OLD_DOCK_UUID"

    echo "    4. Recargando extensión en tiempo real..."
    gnome-extensions disable "$OLD_DOCK_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$OLD_DOCK_UUID" 2>/dev/null || true
    gnome-extensions enable "$DOCK_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ MyDock instalado y activo con éxito.${RESET}\n"
}

uninstall_extensions() {
    echo -e "${YELLOW}${BOLD}--> Desinstalando extensiones...${RESET}"
    for uuid in "$TOPBAR_UUID" "$DOCK_UUID" "$OLD_TOPBAR_UUID" "$OLD_DOCK_UUID"; do
        gnome-extensions disable "$uuid" 2>/dev/null || true
        remove_from_gsettings "$uuid"
        rm -rf "$EXT_DIR/$uuid"
    done
    echo -e "${GREEN}✓ Ambas extensiones han sido desinstaladas correctamente.${RESET}"
}

# --- Main Flow ---
handle_remote_mode
print_banner

ACTION="$1"

# If no argument provided, show interactive menu
if [ -z "$ACTION" ]; then
    echo -e "${BOLD}¿Qué deseas hacer?${RESET}"
    echo "  1) Instalar ambas extensiones (MyTopBar + MyDock) [Recomendado]"
    echo "  2) Instalar únicamente MyTopBar (Barra superior)"
    echo "  3) Instalar únicamente MyDock (Dock inferior)"
    echo "  4) Desinstalar extensiones"
    echo "  5) Salir"
    echo ""

    # Read from /dev/tty if available (vital when invoked via `curl ... | bash`)
    if [ -t 0 ]; then
        read -r -p "Selecciona una opción [1-5] (por defecto 1): " USER_CHOICE
    elif [ -e /dev/tty ]; then
        read -r -p "Selecciona una opción [1-5] (por defecto 1): " USER_CHOICE < /dev/tty
    else
        USER_CHOICE="1"
    fi

    case "$USER_CHOICE" in
        2)
            ACTION="topbar"
            ;;
        3)
            ACTION="dock"
            ;;
        4)
            ACTION="uninstall"
            ;;
        5|q|Q)
            echo "Operación cancelada."
            exit 0
            ;;
        1|"")
            ACTION="all"
            ;;
        *)
            echo -e "${YELLOW}Opción no válida. Instalando ambas extensiones por defecto...${RESET}"
            ACTION="all"
            ;;
    esac
fi

case "$ACTION" in
    1|all|"")
        install_topbar
        install_dock
        ;;
    2|topbar|mytopbar|MyTopBar)
        install_topbar
        ;;
    3|dock|mydock|MyDock)
        install_dock
        ;;
    4|uninstall|--uninstall|-u)
        uninstall_extensions
        exit 0
        ;;
    *)
        echo "Uso: $0 [all|topbar|dock|uninstall]"
        echo ""
        echo "Opciones:"
        echo "  1, all        Instala ambas extensiones (MyTopBar + MyDock)"
        echo "  2, topbar     Instala únicamente MyTopBar"
        echo "  3, dock       Instala únicamente MyDock"
        echo "  4, uninstall  Desinstala ambas extensiones"
        exit 1
        ;;
esac

echo -e "${GREEN}${BOLD}=========================================================="
echo "  ¡Proceso completado con éxito!"
echo -e "==========================================================${RESET}"
echo "Ambas extensiones están activas en tiempo real (NO es necesario reiniciar sesión)."
echo ""
echo "Para abrir los paneles de configuración:"
echo "  gnome-extensions prefs $TOPBAR_UUID"
echo "  gnome-extensions prefs $DOCK_UUID"
echo "=========================================================="
