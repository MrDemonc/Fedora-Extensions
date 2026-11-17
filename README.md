# Demonc Extensions Suite 🌊🖥️

A collection of modern, elegant, and high-performance extensions for **GNOME Shell** (compatible with GNOME 45, 46, 47, 48, 49, 50, and 51) on both **Wayland** and **X11**.

This suite transforms your GNOME desktop into a fluid and intuitive workspace inspired by macOS aesthetics and workflow, providing a sleek utility-packed top bar (**MyTopBar**) and an interactive dock with a fluid wave magnification effect (**MyDock**).

---

## ⚡ Quick One-Line Installation (via curl)

Install or update the entire suite directly from your terminal **without needing to clone or download the repository manually**:

```bash
curl -fsSL https://raw.githubusercontent.com/MrDemonc/Fedora-Extensions/main/install.sh | bash
```

The installer will prompt an interactive menu in your terminal so you can choose which components to install.

---

## 📦 Included Extensions

### 1. [MyTopBar](MyTopBar/) (`MyTopBar@demonc`)
Minimalist and modern top bar with translucent acrylic glassmorphism aesthetics.

- **Automatic Theme Detection**: Automatically detects system dark or light color scheme (`org.gnome.desktop.interface color-scheme`), seamlessly updating background tint, typography contrast, borders, and icons in real time.
- **System Menu**: Sleek system menu with customizable logo selector (Fedora, Apple, GNOME, etc.).
- **Active Application**: Live window tracking displaying active app name and title.
- **Smart Auto-Hide**: Automatically hides when maximized or fullscreen windows are active and reveals when moving cursor to the top edge. Cleanly handles minimized and background windows without unexpected popups.
- **Workspace Overview Integration**: Smoothly fades out during GNOME Workspaces and Applications grid.
- **Centered Clock & Calendar**: Customizable time and date formatting with direct native calendar integration.
- **Spotlight Search**: Fast integrated file and application search accessible anytime with `Super + Space`.
- **Hardware Controls**: Interactive indicators for Wi-Fi, Bluetooth, Power Profiles, and high-definition Cairo battery graphics.
- **Floating Mode**: Optional floating top bar with rounded corners and margins.

### 2. [MyDock](MyDock/) (`MyDock@demonc`)
Compact macOS-style dock with fluid wave magnification animation.

- **Fluid Wave Effect**: Smooth, hardware-accelerated magnification wave as the mouse glides across apps.
- **Automatic Theme Detection**: Dynamic adaptation between dark and light frosted glass based on system theme.
- **Smart Auto-Hide**: Edge-triggered reveal (`pointerTracker`) when maximized or fullscreen windows are active.
- **App Drawer**: Grid button at the beginning of the dock to open GNOME's application launcher.
- **Favorite & Running Apps**: Pinned favorites and running apps with focused/running indicator dots, minimize, and restore support.
- **Mounted Volumes**: Automatic detection of external USB drives and disks with one-click unmount/eject.
- **Integrated Trash Bin**: Live empty and full trash status with direct file manager access.
- **Dash Replacement**: Cleanly replaces the default GNOME Overview dash.

---

## 🚀 System Requirements

- **Desktop Environment**: GNOME Shell 45 to 51 (Fedora, Arch Linux, Ubuntu 23.10+, Debian Sid, openSUSE, etc.).
- **Display Server**: Compatible with both **Wayland** (recommended) and **X11**.
- **Standard Dependencies**:
  - `glib2` / `glib-compile-schemas` (for compiling GSettings schemas).
  - `gnome-extensions` CLI (for real-time extension enabling and reloading).
  - `python3` (for GSettings list management).

---

## 📥 Local Installation

If you prefer to clone or download the repository locally:

```bash
git clone https://github.com/MrDemonc/Fedora-Extensions.git
cd Fedora-Extensions
./install.sh
```

### Master Installer Options (`install.sh`)

Running `./install.sh` without arguments launches an interactive selection menu:
```text
What would you like to do?
  1) Install both extensions (MyTopBar + MyDock) [Recommended]
  2) Install MyTopBar only (Top bar)
  3) Install MyDock only (Bottom dock)
  4) Uninstall extensions
  5) Exit
```

You can also pass arguments directly for automated scripts:
```bash
# Install both extensions (MyTopBar + MyDock)
./install.sh all

# Install MyTopBar only
./install.sh topbar

# Install MyDock only
./install.sh dock

# Uninstall both extensions
./install.sh uninstall
```

---

## ⚙️ Configuration & Preferences

Open the graphical settings panels anytime with:

- **MyTopBar Preferences**:
  ```bash
  gnome-extensions prefs MyTopBar@demonc
  ```
- **MyDock Preferences**:
  ```bash
  gnome-extensions prefs MyDock@demonc
  ```
- Or simply **right-click** directly on the Top Bar or Dock background to access settings.

---

## 🛠️ Repository Structure

```text
Demonc-extencions/
├── README.md              # Main suite documentation
├── install.sh             # Unified master installer (interactive / CLI / curl)
├── .gitignore             # Temporary files and compiled schemas exclusion
├── MyTopBar/              # MyTopBar source code
│   ├── extension.js       # Core top bar logic
│   ├── prefs.js           # GTK4 / Libadwaita preferences panel
│   ├── pointerTracker.js  # Cursor edge proximity tracker
│   ├── stylesheet.css     # CSS styling
│   ├── metadata.json      # Metadata and supported shell versions
│   ├── assets/            # Vector icons and distribution logos
│   └── schemas/           # GSettings XML schema (org.gnome.shell.extensions.mytopbar)
└── MyDock/                # MyDock source code
    ├── extension.js       # Core dock logic and wave physics
    ├── prefs.js           # GTK4 / Libadwaita preferences panel
    ├── pointerTracker.js  # Cursor edge proximity tracker
    ├── stylesheet.css     # CSS styling
    ├── metadata.json      # Metadata and supported shell versions
    └── schemas/           # GSettings XML schema (org.gnome.shell.extensions.mydock)
```

---

## 👤 Author

- **demonc**
- Repository: [Fedora-Extensions](https://github.com/MrDemonc/Fedora-Extensions)

---

## 📄 License

This project is licensed under the GPL-3.0 License (GNU General Public License v3.0).
