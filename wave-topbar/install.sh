#!/bin/bash
set -e

UUID="wave-topbar@demonc"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "1. Compilando esquemas GSettings..."
glib-compile-schemas "$PROJECT_DIR/schemas"

echo "2. Copiando extensión a $TARGET_DIR..."
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -r "$PROJECT_DIR"/* "$TARGET_DIR/"

echo "3. Añadiendo a la lista de extensiones habilitadas..."
CURRENT_EXTS=$(gsettings get org.gnome.shell enabled-extensions)
if [[ "$CURRENT_EXTS" != *"$UUID"* ]]; then
    NEW_EXTS=$(python3 -c "
import ast
exts = ast.literal_eval('''$CURRENT_EXTS''')
if '$UUID' not in exts:
    exts.append('$UUID')
print(str(exts).replace('\"', '\''))
")
    gsettings set org.gnome.shell enabled-extensions "$NEW_EXTS"
    echo "Extensión añadida a enabled-extensions."
else
    echo "La extensión ya estaba en enabled-extensions."
fi

echo "4. Recargando extensión en tiempo real en GNOME Shell..."
gnome-extensions disable "$UUID" 2>/dev/null || true
sleep 0.5
gnome-extensions enable "$UUID" 2>/dev/null || true

echo ""
echo "=========================================================="
echo "  ¡Wave Top Bar instalado y activo en tiempo real!"
echo "=========================================================="
echo ""
echo "  Archivos instalados en: $TARGET_DIR"
echo "  Estado: La extensión se ha recargado en vivo."
echo "  NO es necesario cerrar sesión."
echo ""
echo "  Para abrir la ventana de preferencias:"
echo "    gnome-extensions prefs $UUID"
echo "=========================================================="
