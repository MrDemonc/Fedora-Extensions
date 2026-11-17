# Mac Wave Dock — Extensión para GNOME Shell

Un dock flotante compacto al estilo de **macOS** para GNOME Shell (compatible con GNOME 45 a 51+), equipado con animación de ola (magnificación interactiva), soporte para minimizar y maximizar aplicaciones, reordenamiento, papelera y reemplazo del dash nativo de GNOME.

---

## ✨ Características Principales

1. **🌊 Animación de Ola (Wave Magnification):**
   - Los iconos se elevan y aumentan de tamaño suavemente al pasar el ratón por encima, siguiendo una curva armónica inspirada fielmente en macOS.
   - Base compacta fija en el borde inferior con expansión hacia arriba (`pivot_point: 0.5, 1.0`).
   - Tooltip flotante superior translúcido que muestra el nombre de la aplicación enfocada.

2. **🪟 Soporte para Minimizar y Maximizar:**
   - **Minimizar:** Si haces clic en una aplicación que ya está en primer plano, se minimiza instantáneamente.
   - **Maximizar / Restaurar:** Si la aplicación está minimizada o en segundo plano, se restaura y se trae al frente.
   - **Lanzar:** Si no está en ejecución, se inicia normalmente.
   - **Clic central:** Abre una ventana nueva de la aplicación.
   - **Indicadores luminosos:** Punto sutil debajo de cada icono que indica si la app está abierta o activa en primer plano.

3. **🔁 Reordenamiento, Fijar y Quitar:**
   - **Menú contextual (Clic derecho):**
     - `⬅️ Mover a la izquierda` / `➡️ Mover a la derecha` para reordenar fácilmente.
     - `Mantener en el Dock` / `Desfijar del Dock`.
     - `Nueva ventana` y `Cerrar todas las ventanas`.
   - **Sincronización nativa:** Integrado directamente con el sistema de favoritos de GNOME Shell (`AppFavorites`).

4. **🗑️ Papelera Integrada (Trash Can):**
   - Situada en el extremo derecho del dock, separada por una línea divisoria vertical idéntica a macOS.
   - Cambia su icono dinámicamente si la papelera tiene archivos o está vacía.
   - **Clic izquierdo:** Abre la papelera en Archivos (Nautilus).
   - **Clic derecho:** Menú con opción para **Vaciar la Papelera** con un clic.

5. **⚡ Reemplazo del Dock de GNOME al presionar Super:**
   - Oculta automáticamente el dock/dash nativo gigante de GNOME en el resumen de actividades.
   - Mantiene este dock compacto siempre visible tanto en el escritorio como dentro del Overview.

---

## 📁 Estructura del Proyecto

```text
mac-wave-dock/
├── metadata.json                                          # Metadatos de la extensión
├── extension.js                                           # Lógica del dock, animación de ola y eventos
├── prefs.js                                               # Ventana de configuración (Libadwaita)
├── stylesheet.css                                         # Estilos de vidrio esmerilado y puntos luminosos
├── schemas/
│   ├── org.gnome.shell.extensions.mac-wave-dock.gschema.xml
│   └── gschemas.compiled                                 # Esquema compilado GSettings
├── install.sh                                             # Script de instalación y actualización
└── README.md                                              # Documentación
```

---

## 🚀 Instalación y Activación

### 1. Ejecutar el script de instalación
```bash
./install.sh
```

El script se encarga de:
1. Compilar los esquemas con `glib-compile-schemas`.
2. Copiar los archivos a `~/.local/share/gnome-shell/extensions/mac-wave-dock@demonc`.
3. Añadir la extensión a `org.gnome.shell.enabled-extensions`.

### 2. Reiniciar la sesión (Activación por primera vez en Wayland)
- Cierra tu sesión de usuario (Log Out).
- Vuelve a iniciar sesión (Log In).

---

## ⚙️ Configuración y Preferencias

Para abrir la ventana de preferencias gráfica:
```bash
gnome-extensions prefs mac-wave-dock@demonc
```

En la ventana de preferencias puedes ajustar:
- **Tamaño base de los iconos:** de 28px a 64px (por defecto: 40px, compacto).
- **Escala de magnificación:** factor máximo de aumento en la ola (por defecto: 1.55x).
- **Radio de propagación:** distancia en la que los iconos vecinos responden al cursor.
- **Margen inferior:** separación respecto al borde de la pantalla.
- **Interruptores:** activar/desactivar la papelera, mostrar apps abiertas no fijadas y reemplazo del dash en el overview.
- **Gestor gráfico de apps fijadas:** reordenar con flechas arriba/abajo y añadir apps instaladas.
