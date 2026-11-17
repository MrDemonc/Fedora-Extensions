# Demonc Extensions Suite 🌊🖥️

Colección de extensiones modernas, elegantes y de alto rendimiento para el entorno de escritorio **GNOME Shell** (compatible con GNOME 45, 46, 47, 48, 49, 50 y 51) sobre **Wayland** y **X11**.

Esta suite transforma la experiencia de GNOME en una interfaz fluida e intuitiva inspirada en la estética y usabilidad de macOS, ofreciendo tanto una barra superior delgada con utilidades completas (**Wave Top Bar**) como un dock interactivo con efecto de ola (**Mac Wave Dock**).

---

## 📦 Extensiones Incluidas

### 1. [Wave Top Bar](wave-topbar/) (`wave-topbar@demonc`)
Barra superior minimalista y moderna con estética de cristal translúcido (acrílico).

- **Tema Automático**: Detecta instantáneamente el modo claro u oscuro del sistema (`org.gnome.desktop.interface color-scheme`), adaptando al instante los tonos de fondo, fuentes de texto, bordes e iconos.
- **Menú de Sistema**: Menú rápido con selector de icono personalizable (Fedora, Apple, GNOME, etc.).
- **Aplicación Activa**: Muestra en tiempo real el nombre y estado de la ventana en foco.
- **Auto-ocultamiento Inteligente**: Se oculta automáticamente cuando una ventana maximizada o en pantalla completa está activa y se revela al acercar el cursor al borde superior, sin saltos ni bloqueos.
- **Integración con Espacios de Trabajo**: Se retrae limpiamente al ingresar a la vista de actividades / cajón de aplicaciones de GNOME.
- **Reloj Central**: Fecha y hora con formato configurable y acceso directo al calendario nativo.
- **Spotlight Search**: Búsqueda rápida integrada accesible con `Super + Espacio` para abrir aplicaciones y archivos.
- **Controles de Hardware**: Indicadores de Wi-Fi, Bluetooth, menú de perfiles de energía y batería horizontal de alta definición dibujada con Cairo.
- **Modo Flotante**: Opción de barra superior flotante con bordes redondeados.

### 2. [Mac Wave Dock](mac-wave-dock/) (`mac-wave-dock@demonc`)
Dock inferior compacto al estilo macOS con animación interactiva fluida.

- **Efecto de Ola Fluida (Wave Magnification)**: Animación continua y reactiva al desplazar el cursor sobre las aplicaciones.
- **Tema Automático**: Fondo translúcido, contornos luminosos, puntos indicadores de apps activas y separadores adaptativos según el modo claro u oscuro del sistema.
- **Auto-ocultamiento Inteligente**: Detección de proximidad al borde inferior (`pointerTracker`) para pantallas completas y ventanas maximizadas.
- **Cajón de Aplicaciones**: Botón de inicio para desplegar la cuadrícula de aplicaciones de GNOME.
- **Apps Favoritas y en Ejecución**: Puntos indicadores de apps abiertas y en foco con soporte para cerrar, minimizar y maximizar.
- **Dispositivos y Volúmenes**: Detección automática de discos montados y memorias USB con opción de desmontaje seguro.
- **Papelera Integrada**: Estado visual de papelera vacía o llena en tiempo real con apertura directa en el gestor de archivos.
- **Reemplazo del Dash**: Sustituye limpiamente el dash predeterminado de GNOME en la vista de Overview.

---

## 🚀 Requisitos del Sistema

- **Entorno**: GNOME Shell 45 a 51 (Fedora, Arch Linux, Ubuntu 23.10+, Debian Sid, openSUSE, etc.).
- **Servidor gráfico**: Compatible tanto en **Wayland** (recomendado) como en **X11**.
- **Dependencias**:
  - `glib2` / `glib-compile-schemas` (para compilar los esquemas de GSettings).
  - `gnome-extensions` CLI (para recarga y activación en tiempo real).
  - `python3` (para manipulación de listas en GSettings).

---

## 📥 Instalación Rápida

Puedes clonar este repositorio y ejecutar el instalador unificado:

```bash
git clone https://github.com/<tu-usuario>/Demonc-extencions.git
cd Demonc-extencions
chmod +x install.sh
./install.sh
```

El script se encarga automáticamente de:
1. Compilar los esquemas de configuración GSettings.
2. Copiar cada extensión a `~/.local/share/gnome-shell/extensions/`.
3. Registrar y activar ambas extensiones en GNOME Shell.
4. Recargarlas en vivo sin necesidad de reiniciar la sesión ni el equipo.

### Opciones del Instalador

```bash
# Instalar solo la barra superior
./install.sh topbar

# Instalar solo el dock
./install.sh dock

# Instalar ambas (predeterminado)
./install.sh all

# Desinstalar ambas extensiones
./install.sh uninstall
```

---

## ⚙️ Configuración y Preferencias

Puedes abrir los paneles de configuración gráficos en cualquier momento con:

- **Preferencias de Wave Top Bar**:
  ```bash
  gnome-extensions prefs wave-topbar@demonc
  ```
- **Preferencias de Mac Wave Dock**:
  ```bash
  gnome-extensions prefs mac-wave-dock@demonc
  ```
- O también haciendo **clic derecho** directamente sobre el fondo del Dock o la barra superior.

---

## 🛠️ Estructura del Repositorio

```text
Demonc-extencions/
├── README.md              # Documentación principal de la suite
├── install.sh             # Instalador unificado interactivo
├── .gitignore             # Archivos temporales y esquemas compilados excluidos
├── wave-topbar/           # Código fuente de Wave Top Bar
│   ├── extension.js       # Lógica principal de la barra
│   ├── prefs.js           # Panel de preferencias GTK4/Adwaita
│   ├── pointerTracker.js  # Gestor de proximidad del puntero del ratón
│   ├── stylesheet.css     # Estilos CSS de la barra
│   ├── metadata.json      # Metadatos y versiones soportadas
│   ├── install.sh         # Instalador individual
│   ├── assets/            # Iconos vectoriales y logos
│   └── schemas/           # Esquema XML de GSettings
└── mac-wave-dock/         # Código fuente de Mac Wave Dock
    ├── extension.js       # Lógica principal y animación del dock
    ├── prefs.js           # Panel de preferencias GTK4/Adwaita
    ├── pointerTracker.js  # Gestor de proximidad del puntero del ratón
    ├── stylesheet.css     # Estilos CSS del dock
    ├── metadata.json      # Metadatos y versiones soportadas
    ├── install.sh         # Instalador individual
    └── schemas/           # Esquema XML de GSettings
```

---

## 👤 Autor

- **demonc**
- Repositorio: [Demonc-extencions](https://github.com/demonc/Demonc-extencions)

---

## 📄 Licencia

Este proyecto está distribuido bajo la licencia GPL-3.0 (GNU General Public License v3.0).
