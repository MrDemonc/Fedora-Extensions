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
        echo -e "${CYAN}[*] Remote execution detected. Fetching Demonc-extencions source files...${RESET}"
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
            echo -e "${CYAN}[*] Downloading source tarball from GitHub...${RESET}"
            curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP_DIR"
            EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "Demonc-extencions-*" | head -n 1)
            if [ -n "$EXTRACTED_DIR" ] && [ -d "$EXTRACTED_DIR" ]; then
                SCRIPT_DIR="$EXTRACTED_DIR"
            else
                echo -e "${YELLOW}Error: Could not download extension components from repository.${RESET}"
                exit 1
            fi
        fi
        echo -e "${GREEN}[✓] Source files downloaded successfully.${RESET}\n"
    fi
}

print_banner() {
    echo -e "${BLUE}${BOLD}"
    echo "=========================================================="
    echo "          Demonc Extensions Suite - Installer             "
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
        print('    [+] Extension enabled in org.gnome.shell.enabled-extensions ($uuid).')
    else:
        print('    [*] Extension was already enabled in enabled-extensions.')
except Exception as e:
    print('    [!] Warning updating gsettings:', e)
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
    echo -e "${CYAN}${BOLD}--> Installing MyTopBar ($TOPBAR_UUID)...${RESET}"
    local src="$SCRIPT_DIR/MyTopBar"
    local dest="$EXT_DIR/$TOPBAR_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: Directory not found: $src${RESET}"
        return 1
    fi

    echo "    1. Compiling GSettings schemas..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Installing extension files to $dest..."
    mkdir -p "$EXT_DIR"
    rm -rf "$dest"
    mkdir -p "$dest"
    cp -r "$src"/* "$dest/"

    # Hot compatibility with active Wayland session
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

    echo "    3. Enabling in GNOME Shell..."
    enable_in_gsettings "$TOPBAR_UUID"
    enable_in_gsettings "$OLD_TOPBAR_UUID"

    echo "    4. Reloading extension in real time..."
    gnome-extensions disable "$OLD_TOPBAR_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$OLD_TOPBAR_UUID" 2>/dev/null || true
    gnome-extensions enable "$TOPBAR_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ MyTopBar successfully installed and activated.${RESET}\n"
}

install_dock() {
    echo -e "${CYAN}${BOLD}--> Installing MyDock ($DOCK_UUID)...${RESET}"
    local src="$SCRIPT_DIR/MyDock"
    local dest="$EXT_DIR/$DOCK_UUID"

    if [ ! -d "$src" ]; then
        echo -e "${YELLOW}Error: Directory not found: $src${RESET}"
        return 1
    fi

    echo "    1. Compiling GSettings schemas..."
    glib-compile-schemas "$src/schemas"

    echo "    2. Installing extension files to $dest..."
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

    # Hot compatibility with active Wayland session
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

    echo "    3. Enabling in GNOME Shell..."
    enable_in_gsettings "$DOCK_UUID"
    enable_in_gsettings "$OLD_DOCK_UUID"

    echo "    4. Reloading extension in real time..."
    gnome-extensions disable "$OLD_DOCK_UUID" 2>/dev/null || true
    sleep 0.5
    gnome-extensions enable "$OLD_DOCK_UUID" 2>/dev/null || true
    gnome-extensions enable "$DOCK_UUID" 2>/dev/null || true

    echo -e "${GREEN}    ✓ MyDock successfully installed and activated.${RESET}\n"
}

uninstall_extensions() {
    echo -e "${YELLOW}${BOLD}--> Uninstalling extensions...${RESET}"
    for uuid in "$TOPBAR_UUID" "$DOCK_UUID" "$OLD_TOPBAR_UUID" "$OLD_DOCK_UUID"; do
        gnome-extensions disable "$uuid" 2>/dev/null || true
        remove_from_gsettings "$uuid"
        rm -rf "$EXT_DIR/$uuid"
    done
    echo -e "${GREEN}✓ Both extensions have been successfully uninstalled.${RESET}"
}

# --- Main Flow ---
handle_remote_mode
print_banner

ACTION="$1"

# If no argument provided, show interactive menu
if [ -z "$ACTION" ]; then
    echo -e "${BOLD}What would you like to do?${RESET}"
    echo "  1) Install both extensions (MyTopBar + MyDock) [Recommended]"
    echo "  2) Install MyTopBar only (Top bar)"
    echo "  3) Install MyDock only (Bottom dock)"
    echo "  4) Uninstall extensions"
    echo "  5) Exit"
    echo ""

    # Read from /dev/tty if available (vital when invoked via `curl ... | bash`)
    if [ -t 0 ]; then
        read -r -p "Select an option [1-5] (default 1): " USER_CHOICE
    elif [ -e /dev/tty ]; then
        read -r -p "Select an option [1-5] (default 1): " USER_CHOICE < /dev/tty
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
            echo "Operation cancelled."
            exit 0
            ;;
        1|"")
            ACTION="all"
            ;;
        *)
            echo -e "${YELLOW}Invalid option. Installing both extensions by default...${RESET}"
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
        echo "Usage: $0 [all|topbar|dock|uninstall]"
        echo ""
        echo "Options:"
        echo "  1, all        Install both extensions (MyTopBar + MyDock)"
        echo "  2, topbar     Install MyTopBar only"
        echo "  3, dock       Install MyDock only"
        echo "  4, uninstall  Uninstall both extensions"
        exit 1
        ;;
esac

echo -e "${GREEN}${BOLD}=========================================================="
echo "  Installation completed successfully!"
echo -e "==========================================================${RESET}"
echo "Both extensions are active in real time (NO need to log out)."
echo ""
echo "To open preferences anytime:"
echo "  gnome-extensions prefs $TOPBAR_UUID"
echo "  gnome-extensions prefs $DOCK_UUID"
echo "=========================================================="
