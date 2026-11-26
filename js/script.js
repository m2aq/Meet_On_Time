import * as calc from './calculo.js';
import { TEXTOS } from './textos.js';
import { entrar } from './conexion.js';
import { crearDestino, nuevoDestino, hayDestino } from './destino.js';

const $ = (id) => document.getElementById(id);
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODIGO_VALIDO = new RegExp(`^[${LETRAS}]{12}$`);

// OSRM de demostración: sin cuenta, uso ligero y no comercial.
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const RUTA_CADA = 30000;        // ms mínimos entre consultas normales
const RUTA_MINIMO = 10000;      // ms mínimos aun con desvío
const DESVIO = 150;             // m fuera de la ruta
const MOVIMIENTO = 50;          // m para que valga la pena recalcular
const VIEJO = 20000;            // ms sin datos = ubicación detenida

/* ---------- Preferencias ---------- */
const ajustes = { color: 'cian', modo: 'oscuro', idioma: 'en' };
try {
  Object.assign(ajustes, JSON.parse(localStorage.getItem('meetme-ajustes')) || {});
} catch { /* sin almacenamiento: se usan los valores iniciales */ }
if (!TEXTOS[ajustes.idioma]) ajustes.idioma = 'en';

const t = (clave) => TEXTOS[ajustes.idioma][clave];
const imperial = () => ajustes.idioma === 'en';

function aplicarAjustes() {
  const raiz = document.documentElement;
  raiz.dataset.color = ajustes.color;
  raiz.dataset.modo = ajustes.modo;
  raiz.lang = ajustes.idioma;
  document.querySelector('meta[name="theme-color"]').content = ajustes.modo === 'oscuro' ? '#0d1117' : '#e8e9e4';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ayuda]').forEach((el) => { el.placeholder = t(el.dataset.i18nAyuda); });
  $('cambiar-color').textContent = t(ajustes.color);
  $('cambiar-modo').textContent = t(ajustes.modo);
  $('cambiar-idioma').textContent = t('nombreIdioma');
  $('compartir').textContent = t('invitar');
  mostrarError(viajeError);
  destino.pintarBorrador();
  pintar();
}

function cambiar(clave, a, b) {
  ajustes[clave] = ajustes[clave] === a ? b : a;
  try { localStorage.setItem('meetme-ajustes', JSON.stringify(ajustes)); } catch { /* opcional */ }
  aplicarAjustes();
}

/* ---------- Estado del viaje ---------- */
let viaje = null;
let viajeError = '';

function nuevoViaje(codigo, esDemo) {
  return {
    codigo, esDemo,
    yo: null, amigo: null,
    conectado: true,
    sala: null, vigilancia: null, reloj: null,
    ruta: null, rutaId: 0, consultando: false, ultimaConsulta: 0, desde: null, falloRuta: false,
    medidor: calc.crearMedidor(),
    medidorYo: calc.crearMedidor(),
    medidorAmigo: calc.crearMedidor(),
    mapa: null, marcas: {}, linea: null, seguir: true,
    ultimoEnvio: 0,
    destino: nuevoDestino(),
  };
}

function mostrarError(clave) {
  viajeError = clave;
  $('error-inicio').textContent = clave ? t(clave) : '';
}

/* ---------- Mapa ---------- */
function crearMapa() {
  const mapa = L.map('mapa', { zoomControl: false }).setView([23.6, -102.5], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> | <a href="https://project-osrm.org" target="_blank" rel="noopener">OSRM</a>',
  }).addTo(mapa);
  mapa.on('click', (e) => destino.tocarMapa(e));
  mapa.on('dragstart', () => { viaje.seguir = false; });
  mapa.on('zoomstart', () => { if (!viaje.ajustando) viaje.seguir = false; });
  return mapa;
}

function ponerMarca(quien, pos, vieja) {
  if (!pos) {
    viaje.marcas[quien]?.remove();
    delete viaje.marcas[quien];
    return;
  }
  if (!viaje.marcas[quien]) {
    const icono = L.divIcon({ className: '', html: `<div class="marca marca-${quien}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    viaje.marcas[quien] = L.marker([pos.lat, pos.lon], { icon: icono, keyboard: false }).addTo(viaje.mapa);
  }
  viaje.marcas[quien].setLatLng([pos.lat, pos.lon]);
  viaje.marcas[quien].getElement()?.firstChild.classList.toggle('marca-vieja', vieja);
}

function encuadrar() {
  const puntos = [viaje.yo, viaje.amigo, viaje.destino.plan.dest].filter(Boolean).map((p) => [p.lat, p.lon]);
  if (!puntos.length) return;
  viaje.ajustando = true;
  if (puntos.length === 1) viaje.mapa.setView(puntos[0], 15, { animate: false });
  else viaje.mapa.fitBounds(puntos, { padding: [40, 40], maxZoom: 16, animate: false });
  viaje.ajustando = false;
}

/* ---------- Rutas ---------- */
// conTiempos: pide la duración de cada tramo (punto de reunión y demo).
async function consultarRuta(a, b, conTiempos = false) {
  const control = new AbortController();
  const limite = setTimeout(() => control.abort(), conTiempos ? 20000 : 8000);
  try {
    const url = `${OSRM}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson${conTiempos ? '&annotations=duration' : ''}`;
    const respuesta = await fetch(url, { signal: control.signal });
    if (!respuesta.ok) throw new Error('osrm');
    const datos = await respuesta.json();
    const r = datos.routes?.[0];
    if (datos.code !== 'Ok' || !r) throw new Error('osrm');
    const base = calc.prepararRuta(r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })));
    const ruta = { ...base, metros: r.distance, segundos: r.duration };
    return conTiempos ? calc.agregarTiempos(ruta, r.duration, r.legs?.[0]?.annotation?.duration) : ruta;
  } finally {
    clearTimeout(limite);
  }
}

// Metros restantes entre ambos, medidos sobre la ruta actual.
function sobreRuta() {
  const { ruta, yo, amigo } = viaje;
  if (!ruta || !ruta.largo) return null;
  const a = calc.proyectar(ruta, yo);
  const b = calc.proyectar(ruta, amigo);
  const escala = ruta.metros / ruta.largo;
  return {
    restante: Math.max(0, b.avance - a.avance) * escala,
    avanceYo: a.avance * escala,
    avanceAmigo: b.avance * escala,
    desvio: Math.max(a.separacion, b.separacion),
  };
}

async function revisarRuta() {
  const v = viaje;
  if (!v.yo || !v.amigo || v.consultando || hayDestino(v)) return;
  if (calc.distancia(v.yo, v.amigo) < calc.UMBRAL_LLEGADA) return;
  const pasado = Date.now() - v.ultimaConsulta;
  const medida = sobreRuta();
  const desviado = medida && medida.desvio > DESVIO;
  if (pasado < (desviado ? RUTA_MINIMO : RUTA_CADA)) return;
  const quietos = v.desde &&
    calc.distancia(v.desde.yo, v.yo) < MOVIMIENTO &&
    calc.distancia(v.desde.amigo, v.amigo) < MOVIMIENTO;
  if (v.ruta && quietos) return;

  v.consultando = true;
  v.ultimaConsulta = Date.now();
  const desde = { yo: v.yo, amigo: v.amigo };
  try {
    const ruta = await consultarRuta(desde.yo, desde.amigo);
    if (viaje !== v || hayDestino(v)) return;
    v.ruta = ruta;
    v.rutaId += 1;
    v.desde = desde;
    v.falloRuta = false;
    v.linea?.remove();
    v.linea = L.polyline(ruta.puntos.map((p) => [p.lat, p.lon]), { className: 'ruta-linea', weight: 6, opacity: 0.9 }).addTo(v.mapa);
    medir();
    pintar();
  } catch {
    // Sin ruta nueva: se conserva la anterior solo si todavía sirve.
    if (viaje === v && (!v.ruta || desviado)) {
      v.falloRuta = true;
      v.ruta = null;
      v.linea?.remove();
    }
  } finally {
    v.consultando = false;
  }
}

// Guarda una lectura para calcular la velocidad de acercamiento.
function medir() {
  const v = viaje;
  if (!v.yo || !v.amigo) return;
  const ahora = Date.now();
  const medida = sobreRuta();
  if (medida && medida.desvio <= DESVIO) {
    v.medidor.agregar(ahora, medida.restante, v.rutaId);
    // Quién se está moviendo: avance de cada uno hacia el otro.
    v.medidorYo.agregar(ahora, -medida.avanceYo, v.rutaId);
    v.medidorAmigo.agregar(ahora, medida.avanceAmigo, v.rutaId);
  } else if (!v.ruta) {
    v.medidor.agregar(ahora, calc.distancia(v.yo, v.amigo), 'recta');
  }
}

/* ---------- Pantalla ---------- */
function pintar() {
  const v = viaje;
  if (!v || !v.mapa) return;
  const ahora = Date.now();
  const yoViejo = v.yo && ahora - v.yo.recibido > VIEJO;
  const amigoViejo = v.amigo && ahora - v.amigo.recibido > VIEJO;

  ponerMarca('yo', v.yo, yoViejo);
  ponerMarca('amigo', v.amigo, amigoViejo);

  $('velocidad').textContent = calc.formatoVelocidad(v.yo && !yoViejo ? v.yo.v ?? null : null, imperial());

  let titulo = t('tEspera');
  let tiempo = { valor: '--', unidad: '' };
  let metros = null;
  let metodo = '';

  if (hayDestino(v)) {
    // La línea entre ambos no aplica cuando van a un mismo lugar.
    v.linea?.remove();
    v.ruta = null;
    let rumbo;
    ({ titulo, tiempo, metros, metodo, rumbo } = destino.pintar(v));
    $('flecha').style.transform = `rotate(${rumbo}deg)`;
  } else if (v.yo && v.amigo) {
    $('viaje').dataset.ritmo = '';
    $('consejo').hidden = true;
    $('llegadas').hidden = true;
    const recta = calc.distancia(v.yo, v.amigo);
    const medida = sobreRuta();
    const valida = medida && medida.desvio <= DESVIO;
    metros = valida ? medida.restante : recta;
    $('flecha').style.transform = `rotate(${calc.rumbo(v.yo, v.amigo)}deg)`;

    if (amigoViejo || yoViejo) {
      titulo = t('tEspera');
    } else if (recta < calc.UMBRAL_LLEGADA) {
      titulo = t('tJuntos');
      tiempo = { valor: '0', unidad: 'min' };
    } else {
      const cierre = v.medidor.velocidad();
      const segundosRuta = valida && v.ruta.metros ? v.ruta.segundos * (medida.restante / v.ruta.metros) : null;
      const r = calc.estimar({ cierre, restante: metros, segundosRuta });
      tiempo = calc.formatoTiempo(r.segundos);

      if (r.metodo === 'alejando') titulo = t('tAlejando');
      else if (r.metodo === 'enVivo') {
        const yoMuevo = (v.medidorYo.velocidad() ?? 0) > calc.UMBRAL_QUIETO;
        const amigoMueve = (v.medidorAmigo.velocidad() ?? 0) > calc.UMBRAL_QUIETO;
        titulo = t(yoMuevo && !amigoMueve ? 'tTuLlegas' : amigoMueve && !yoMuevo ? 'tLlega' : 'tEncuentro');
        metodo = t('mEnVivo');
      } else {
        titulo = t('tTrayecto');
        const sin = segundosRuta === null ? 'Sin' : '';
        metodo = t((r.metodo === 'midiendo' ? 'mMidiendo' : 'mDetenidos') + sin);
      }
    }
    if (!valida && v.falloRuta) metodo = t('mRecta');
  } else {
    $('viaje').dataset.ritmo = '';
    $('consejo').hidden = true;
    $('llegadas').hidden = true;
    $('flecha').style.transform = 'rotate(0deg)';
  }

  $('titulo').textContent = titulo;
  $('tiempo').textContent = tiempo.valor;
  $('tiempo-unidad').textContent = tiempo.unidad;
  $('distancia').textContent = metros === null ? '--' : calc.formatoDistancia(metros, imperial());
  $('metodo').textContent = v.esDemo ? `${t('mDemo')}. ${metodo}` : metodo;

  let estado = '';
  if (destino.eligiendo()) estado = t('eTocaMapa');
  else if (!v.conectado) estado = t('eSinRed');
  else if (!v.yo) estado = t('eGps');
  else if (yoViejo) estado = t('eViejoYo');
  else if (!v.amigo) estado = t('eAmigo');
  else if (amigoViejo) estado = t('eViejo').replace('{s}', Math.round((ahora - v.amigo.recibido) / 1000));
  else if (v.yo.p > 100) estado = t('ePrecision').replace('{m}', calc.formatoDistancia(v.yo.p, imperial()));
  $('estado').textContent = estado;
  $('estado').hidden = !estado;
}

function actualizar(miPosicion = false) {
  medir();
  destino.calcular(viaje, miPosicion);
  pintar();
  if (viaje.seguir) encuadrar();
  revisarRuta();
  destino.revisarRuta(viaje);
}

/* ---------- GPS ---------- */
function alPosicion(p) {
  const v = viaje;
  if (!v) return;
  const nueva = { lat: p.coords.latitude, lon: p.coords.longitude, p: p.coords.accuracy, recibido: Date.now(), v: null };
  if (Number.isFinite(p.coords.speed) && p.coords.speed >= 0) {
    nueva.v = p.coords.speed;
  } else if (v.yo) {
    // Si el teléfono no da velocidad, se calcula con la posición anterior.
    const segundos = (nueva.recibido - v.yo.recibido) / 1000;
    if (segundos >= 1 && segundos < 15) {
      const recorrido = calc.distancia(v.yo, nueva);
      nueva.v = recorrido > Math.min(nueva.p, 20) ? recorrido / segundos : 0;
    }
  }
  v.yo = nueva;
  actualizar(true);
  enviar();
}

function enviar() {
  const v = viaje;
  if (!v.sala || !v.yo || Date.now() - v.ultimoEnvio < 2000) return;
  v.ultimoEnvio = Date.now();
  v.sala.compartir(destino.paraEnviar(v));
  const datos = { lat: v.yo.lat, lon: v.yo.lon, p: Math.round(v.yo.p) };
  if (v.yo.v !== null) datos.v = v.yo.v;
  v.sala.enviar(datos);
}

const destino = crearDestino({
  viaje: () => viaje,
  t,
  idioma: () => ajustes.idioma,
  imperial,
  consultarRuta,
  alCambiarPlan: (v) => v.sala?.compartir(destino.paraEnviar(v), true),
  repintar: () => { pintar(); if (viaje?.seguir) encuadrar(); },
});

function alErrorGps(error) {
  // Solo se sale si se negó el permiso; lo demás es temporal.
  if (error.code === 1) terminar('errPermiso');
}

/* ---------- Pantalla encendida ---------- */
let candado = null;
async function mantenerPantalla() {
  if (!viaje || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try { candado = await navigator.wakeLock.request('screen'); } catch { candado = null; }
}
function soltarPantalla() {
  candado?.release().catch(() => {});
  candado = null;
}
document.addEventListener('visibilitychange', mantenerPantalla);

/* ---------- Entrar y salir ---------- */
function mostrarViaje(esDemo, planEnDemo = false) {
  $('inicio').hidden = true;
  $('viaje').hidden = false;
  $('compartir').disabled = esDemo;
  $('abrir-plan').disabled = esDemo && !planEnDemo;
  $('viaje').dataset.ritmo = '';
  $('consejo').hidden = true;
  $('llegadas').hidden = true;
  viaje.mapa = crearMapa();
  viaje.reloj = setInterval(() => {
    destino.calcular(viaje);
    pintar();
    revisarRuta();
    destino.revisarRuta(viaje);
    // Detenidos, el GPS puede dejar de avisar: se le pide una lectura nueva.
    if (!viaje.esDemo && viaje.yo && Date.now() - viaje.yo.recibido > 8000) {
      navigator.geolocation.getCurrentPosition(alPosicion, () => {}, { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 });
    }
  }, 2000);
  mantenerPantalla();
  pintar();
}

async function iniciarSala(codigo) {
  mostrarError('');
  if (!navigator.geolocation) return mostrarError('errSinGps');

  const v = nuevoViaje(codigo, false);
  viaje = v;
  history.replaceState(null, '', `#r=${codigo}`);
  mostrarViaje(false);

  v.vigilancia = navigator.geolocation.watchPosition(alPosicion, alErrorGps, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });

  try {
    const sala = await entrar(codigo, {
      alAmigo(datos) {
        if (viaje !== v) return;
        if (!datos) {
          // Se desconectó: se conserva su último punto, marcado como viejo.
          if (v.amigo) v.amigo.recibido = Math.min(v.amigo.recibido, Date.now() - VIEJO - 1);
          return pintar();
        }
        v.amigo = { lat: datos.lat, lon: datos.lon, v: datos.v ?? null, recibido: Date.now() };
        actualizar();
      },
      alExtra(extra) {
        if (viaje !== v) return;
        destino.recibir(v, extra);
        actualizar();
      },
      alLlena() {
        if (viaje === v) terminar('errLlena');
      },
      alRed(conectado) {
        if (viaje !== v) return;
        v.conectado = conectado;
        pintar();
      },
    });
    if (viaje !== v) return sala.salir();
    v.sala = sala;
    sala.compartir(destino.paraEnviar(v), true);
    enviar();
  } catch (error) {
    if (viaje === v) terminar(error.message === 'sala-llena' ? 'errLlena' : 'errConexion');
  }
}

// Demo: dos puntos simulados que avanzan uno hacia el otro a 50 km/h.
async function iniciarDemo() {
  mostrarError('');
  const v = nuevoViaje('', true);
  viaje = v;
  mostrarViaje(true);

  const a = { lat: 29.0729, lon: -110.9559 };
  const b = { lat: 29.1250, lon: -111.0100 };
  let camino;
  try {
    camino = await consultarRuta(a, b);
  } catch {
    camino = calc.prepararRuta([a, b]);
  }
  if (viaje !== v) return;

  const puntoEn = (metros) => {
    let i = 1;
    while (i < camino.acumulado.length - 1 && camino.acumulado[i] < metros) i++;
    const tramo = camino.acumulado[i] - camino.acumulado[i - 1] || 1;
    const f = Math.max(0, Math.min(1, (metros - camino.acumulado[i - 1]) / tramo));
    const p = camino.puntos[i - 1];
    const q = camino.puntos[i];
    return { lat: p.lat + (q.lat - p.lat) * f, lon: p.lon + (q.lon - p.lon) * f };
  };

  const inicio = Date.now();
  const paso = () => {
    if (viaje !== v) return;
    const recorrido = Math.min(((Date.now() - inicio) / 1000) * (50 / 3.6), camino.largo / 2);
    const llegaron = recorrido >= camino.largo / 2;
    const velocidad = llegaron ? 0 : 50 / 3.6;
    const ahora = Date.now();
    v.yo = { ...puntoEn(recorrido), v: velocidad, p: 5, recibido: ahora };
    v.amigo = { ...puntoEn(camino.largo - recorrido), v: velocidad, recibido: ahora };
    actualizar();
  };
  v.vigilancia = setInterval(paso, 1000);
  paso();
}

// Demo: uno sale de Hermosillo y otro de Phoenix hacia Nogales, Sonora.
async function iniciarDemoReunion() {
  mostrarError('');
  const v = nuevoViaje('', true);
  viaje = v;
  mostrarViaje(true, true);

  const nogales = { lat: 31.3086, lon: -110.9420, nombre: 'Nogales, Sonora' };
  let mia;
  let suya;
  try {
    [mia, suya] = await Promise.all([
      consultarRuta({ lat: 29.0729, lon: -110.9559 }, nogales, true),
      consultarRuta({ lat: 33.4484, lon: -112.0740 }, nogales, true),
    ]);
  } catch {
    if (viaje === v) terminar('errConexion');
    return;
  }
  if (viaje !== v) return;

  // Meta de ejemplo: 33 minutos después de mi llegada a ritmo normal.
  const hora = Date.now() + (mia.segundos + 33 * 60) * 1000;
  destino.aplicarPlan(v, { rev: Date.now(), dest: nogales, modo: 'hora', hora });

  const inicio = Date.now();
  const paso = () => {
    if (viaje !== v) return;
    const ahora = Date.now();
    const pasado = (ahora - inicio) / 1000;
    v.yo = { ...calc.puntoEnTiempo(mia, pasado), p: 5, recibido: ahora };
    v.amigo = { ...calc.puntoEnTiempo(suya, pasado), recibido: ahora };
    const resto = calc.restanteEnRuta(suya, v.amigo);
    v.destino.amigo = {
      rev: v.destino.plan.rev, m: resto.metros, s: resto.segundos, mg: 0, fin: false, recibido: ahora,
      ...calc.llegadas({ ahora, segundos: resto.segundos, ritmo: null, margen: 0 }),
    };
    actualizar(true);
  };
  v.vigilancia = setInterval(paso, 1000);
  paso();
}

function terminar(error = '') {
  const v = viaje;
  if (!v) return;
  viaje = null;
  destino.cancelarEleccion();
  if ($('plan').open) $('plan').close();
  clearInterval(v.reloj);
  if (v.esDemo) clearInterval(v.vigilancia);
  else if (v.vigilancia !== null) navigator.geolocation.clearWatch(v.vigilancia);
  v.sala?.salir();
  v.mapa?.remove();
  soltarPantalla();
  history.replaceState(null, '', location.pathname + location.search);
  $('aviso-invitacion').hidden = true;
  $('codigo').value = '';
  $('viaje').hidden = true;
  $('inicio').hidden = false;
  mostrarError(error);
}

function codigoNuevo() {
  const azar = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(azar, (n) => LETRAS[n % LETRAS.length]).join('');
}

async function compartir() {
  const url = `${location.origin}${location.pathname}#r=${viaje.codigo}`;
  const texto = `${t('mensaje')} ${viaje.codigo}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Meet On Time', text: texto, url });
    } else {
      await navigator.clipboard.writeText(`${texto}\n${url}`);
      $('compartir').textContent = t('copiado');
      setTimeout(() => { $('compartir').textContent = t('invitar'); }, 2000);
    }
  } catch { /* la persona canceló */ }
}

/* ---------- Eventos ---------- */
$('crear').addEventListener('click', () => iniciarSala(codigoNuevo()));
$('demo').addEventListener('click', iniciarDemo);
$('demo-reunion').addEventListener('click', iniciarDemoReunion);
$('form-unirse').addEventListener('submit', (e) => {
  e.preventDefault();
  const codigo = $('codigo').value.trim().toUpperCase();
  $('codigo').blur();
  if (!CODIGO_VALIDO.test(codigo)) return mostrarError('errCodigo');
  iniciarSala(codigo);
});
$('codigo').addEventListener('input', () => mostrarError(''));
$('salir').addEventListener('click', () => terminar());
$('centrar').addEventListener('click', () => { viaje.seguir = true; encuadrar(); });
$('compartir').addEventListener('click', compartir);
document.querySelectorAll('[data-accion="ajustes"]').forEach((b) => b.addEventListener('click', () => $('ajustes').showModal()));
$('cambiar-color').addEventListener('click', () => cambiar('color', 'cian', 'verde'));
$('cambiar-modo').addEventListener('click', () => cambiar('modo', 'oscuro', 'claro'));
$('cambiar-idioma').addEventListener('click', () => cambiar('idioma', 'en', 'es'));

function leerInvitacion() {
  const codigo = new URLSearchParams(location.hash.slice(1)).get('r')?.toUpperCase();
  if (!codigo || !CODIGO_VALIDO.test(codigo)) return;
  $('codigo').value = codigo;
  $('aviso-invitacion').hidden = false;
}
window.addEventListener('hashchange', () => { if (!viaje) leerInvitacion(); });

// Intro: breve y se salta con un toque.
const intro = $('intro');
function cerrarIntro() {
  if (intro.classList.contains('intro-fuera')) return;
  intro.classList.add('intro-fuera');
  setTimeout(() => intro.remove(), 500);
}
intro.addEventListener('click', cerrarIntro);
intro.addEventListener('keydown', cerrarIntro);
setTimeout(cerrarIntro, matchMedia('(prefers-reduced-motion: reduce)').matches ? 1000 : 2900);
$('anio').textContent = new Date().getFullYear();

leerInvitacion();
aplicarAjustes();
