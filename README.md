# Demonc Extensions Suite 🌊🖥️

Colección de extensiones modernas, elegantes y de alto rendimiento para el entorno de escritorio **GNOME Shell** (compatible con GNOME 45, 46, 47, 48, 49, 50 y 51) sobre **Wayland** y **X11**.

Esta suite transforma la experiencia de GNOME en una interfaz fluida e intuitiva inspirada en la estética y usabilidad de macOS, ofreciendo tanto una barra superior delgada con utilidades completas (**MyTopBar**) como un dock interactivo con efecto de ola (**MyDock**).

---

## ⚡ Instalación Rápida en una sola línea (vía curl)

Puedes instalar o actualizar la suite directamente desde tu terminal **sin necesidad de clonar ni descargar el repositorio manualmente**:

```bash
curl -fsSL https://raw.githubusercontent.com/demonc/Demonc-extencions/main/install.sh | bash
```

El instalador te mostrará un menú interactivo en la terminal para que elijas qué componentes instalar.

---

## 📦 Extensiones Incluidas

### 1. [MyTopBar](MyTopBar/) (`MyTopBar@demonc`)
Barra superior minimalista y moderna con estética de cristal translúcido (acrílico).

- **Tema Automático**: Detecta instantáneamente el modo claro u oscuro del sistema (`org.gnome.desktop.interface color-scheme`), adaptando al instante los tonos de fondo, fuentes de texto, bordes e iconos.
- **Menú de Sistema**: Menú rápido con selector de icono personalizable (Fedora, Apple, GNOME, etc.).
- **Aplicación Activa**: Muestra en tiempo real el nombre y estado de la ventana en foco.
- **Auto-ocultamiento Inteligente**: Se oculta automáticamente cuando una ventana maximizada o en pantalla completa está activa y se revela al acercar el cursor al borde superior, resolviendo de forma inteligente la convivencia con ventanas minimizadas o en segundo plano.
- **Integración con Espacios de Trabajo**: Se retrae limpiamente al ingresar a la vista de actividades / cajón de aplicaciones de GNOME.
- **Reloj Central**: Fecha y hora con formato configurable y acceso directo al calendario nativo.
- **Spotlight Search**: Búsqueda rápida integrada accesible con `Super + Espacio` para abrir aplicaciones y archivos.
- **Controles de Hardware**: Indicadores de Wi-Fi, Bluetooth, menú de perfiles de energía y batería horizontal de alta definición dibujada con Cairo.
- **Modo Flotante**: Opción de barra superior flotante con bordes redondeados.

### 2. [MyDock](MyDock/) (`MyDock@demonc`)
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
- **Dependencias estándar**:
  - `glib2` / `glib-compile-schemas` (para compilar los esquemas de GSettings).
  - `gnome-extensions` CLI (para recarga y activación en tiempo real).
  - `python3` (para gestión de listas de configuración).

---

## 📥 Instalación Local

Si prefieres descargar o clonar el repositorio:

```bash
git clone https://github.com/demonc/Demonc-extencions.git
cd Demonc-extencions
./install.sh
```

### Opciones del Instalador Maestro (`install.sh`)

Al ejecutar `./install.sh` sin argumentos, se abrirá un menú interactivo:
```text
¿Qué deseas hacer?
  1) Instalar ambas extensiones (MyTopBar + MyDock) [Recomendado]
  2) Instalar únicamente MyTopBar (Barra superior)
  3) Instalar únicamente MyDock (Dock inferior)
  4) Desinstalar extensiones
  5) Salir
```

También puedes ejecutarlo directamente por argumentos:
```bash
# Instalar ambas (MyTopBar + MyDock)
./install.sh all

# Instalar únicamente MyTopBar
./install.sh topbar

# Instalar únicamente MyDock
./install.sh dock

# Desinstalar las extensiones de la suite
./install.sh uninstall
```

---

## ⚙️ Configuración y Preferencias

Puedes abrir los paneles de configuración gráficos en cualquier momento con:

- **Preferencias de MyTopBar**:
  ```bash
  gnome-extensions prefs MyTopBar@demonc
  ```
- **Preferencias de MyDock**:
  ```bash
  gnome-extensions prefs MyDock@demonc
  ```
- O también haciendo **clic derecho** directamente sobre el fondo del Dock o la barra superior.

---

## 🛠️ Estructura del Repositorio

```text
Demonc-extencions/
├── README.md              # Documentación principal de la suite
├── install.sh             # Único instalador maestro (local e interactivo / curl)
├── .gitignore             # Archivos temporales y esquemas compilados excluidos
├── MyTopBar/              # Código fuente de MyTopBar
│   ├── extension.js       # Lógica principal de la barra
│   ├── prefs.js           # Panel de preferencias GTK4/Adwaita
│   ├── pointerTracker.js  # Gestor de proximidad del puntero del ratón
│   ├── stylesheet.css     # Estilos CSS de la barra
│   ├── metadata.json      # Metadatos y versiones soportadas
│   ├── assets/            # Iconos vectoriales y logos
│   └── schemas/           # Esquema XML de GSettings (org.gnome.shell.extensions.mytopbar)
└── MyDock/                # Código fuente de MyDock
    ├── extension.js       # Lógica principal y animación del dock
    ├── prefs.js           # Panel de preferencias GTK4/Adwaita
    ├── pointerTracker.js  # Gestor de proximidad del puntero del ratón
    ├── stylesheet.css     # Estilos CSS del dock
    ├── metadata.json      # Metadatos y versiones soportadas
    └── schemas/           # Esquema XML de GSettings (org.gnome.shell.extensions.mydock)
```

---

## 👤 Autor

- **demonc**
- Repositorio: [Demonc-extencions](https://github.com/demonc/Demonc-extencions)

---

## 📄 Licencia

Este proyecto está distribuido bajo la licencia GPL-3.0 (GNU General Public License v3.0).
