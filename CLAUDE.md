# Meet On Time

Web app para iPhone: dos personas comparten su ubicación y ven en cuánto tiempo se encuentran. Ciudad y carretera. Proyecto personal.

## Decisiones aprobadas
- Nombre: **Meet On Time**. Eslogan: "Sync your pace, arrive together." / "Ajusta tu ritmo y lleguen juntos."
- Repositorio: https://github.com/m2aq/Meet_On_Time (respetar mayúsculas en la dirección de Pages). La carpeta local sigue siendo `meet_me`; los identificadores internos `meetme` no se cambian.
- Salas de **solo 2 personas**, con enlace o código de invitación.
- Inglés por defecto, con opción a español. Unidades ligadas al idioma: **millas en inglés, km en español**.
- Diseño: distribución "letrero de carretera" (panel grande arriba) con colores del "tablero de manejo".
- Opciones: color cian (inicial) o verde del letrero; modo oscuro (inicial) o claro. El letrero verde no cambia con el modo.
- Sello m2aq **solo al inicio**, como animación de carga llamativa, breve y que se salta con un toque.
- Mapa: Leaflet + OpenStreetMap. Rutas: servidor de demostración de OSRM (uso ligero, no comercial, sin tráfico en vivo). **Sin Google Maps** ni servicios que pidan tarjeta.
- Conexión: servidor MQTT público (EMQX), sin cuenta, con ubicaciones cifradas. **Sin Firebase** (decisión del usuario). Publicación: GitHub Pages.
- Código de sala de 12 caracteres.
- No se guarda historial de recorridos.
- **Punto de reunión** (se conserva el modo de ir uno hacia el otro): ambos van a un lugar; llegada "juntos" o a hora fija; margen manual por persona para frontera o paradas.
- **Resplandor de color** desde la orilla que se desvanece al centro (no borde sólido), con **3 pulsos suaves solo al cambiar de color** y luego fijo (sin pulso con movimiento reducido), en modo punto de reunión: verde a tiempo; rojo adelantado (no es exceso de velocidad); amarillo atrasado pero alcanzable; morado ya no alcanza. Siempre con icono y texto. Solo con ritmo reciente (la demo usa el de la ruta) y cambia si se mantiene 10 s.
- **Panel de velocidad** (punto de reunión): arriba la acción y cuánto ("Baja 20" / "Sube 8" / "Mantén"), en grande el promedio necesario; la diferencia se calcula con el promedio reciente (~3 min), nunca con la velocidad del instante. Minutos, distancia, velocidad actual y la otra persona van en pequeño.
- El consejo es un **promedio** para lo que falta. **Nunca pedir ir más rápido que el ritmo normal de la ruta** (si no alcanza, avisar que va tarde) ni ir demasiado lento (bajo 70 %, sugerir una parada).

## Estructura
- `index.html`, `css/estilos.css`, `js/script.js` (interfaz, GPS, mapa, rutas)
- `js/calculo.js` (cálculos puros), `js/textos.js` (EN/ES)
- `js/destino.js` (punto de reunión: búsqueda, ruta propia, consejo y llegadas)
- `js/conexion.js` (cifrado, MQTT y pareja de 2) + `js/config.js` (dirección del servidor)

## Notas
- GPS solo funciona con HTTPS (o localhost).
- En iPhone, la web no envía ubicación con la pantalla bloqueada o en otra app.
- La clave AES-GCM y el nombre del canal se derivan del código (PBKDF2). Quien tenga el código o enlace puede entrar. Nunca publicar mensajes con `retain`.
- El servidor es de pruebas, sin garantía; puede ver IP, horarios y actividad.
- El límite de 2 lo controla la app, no el servidor. Se rechazan mensajes con más de 2 min de diferencia de reloj.
- En "juntos" la meta la fija quien llegaría más tarde a ritmo normal, para que no se recorra cuando el otro baja la velocidad.
- Búsqueda de lugares: Nominatim (OSM), solo al tocar Buscar, sin autocompletar, máximo 1 consulta por segundo.
- MQTT.js 5.10.1 desde cdnjs con `integrity`; al cambiar versión, actualizar el hash.
- Dos pestañas del mismo navegador cuentan como la misma persona: probar con dos dispositivos.

## Estado al 2026-11-26 (para retomar en otra PC)
- Revisado por el usuario en PC: animación inicial y demo original (antes de los cambios de abajo).
- Probado solo con Node (servidor MQTT y página simulados): conexión cifrada, límite de 2, punto de reunión, colores y hora de reunión.

### Pendiente
1. Activar GitHub Pages; dirección prevista: https://m2aq.github.io/Meet_On_Time/ (respeta mayúsculas).
2. Revisar en pantalla: resplandor, pulso, elección de hora, panel en celular (¿queda suficiente mapa?), buscador de lugares y marcar en el mapa.
3. Probar el servidor MQTT real y dos iPhone (GPS, datos móviles, pérdida de señal, pantalla encendida, nombre bajo el icono).

### Para trabajar
- Servidor local, desde la carpeta del proyecto: `python -m http.server 8123 --bind 127.0.0.1` y abrir http://127.0.0.1:8123 (Ctrl+F5 tras cambios).
- La demo de punto de reunión no muestra el estado amarillo (no simula un ritmo lento).
- Las pruebas automáticas fueron archivos temporales y **no están en el repositorio**.
