// Comparte posiciones entre 2 personas por un servidor MQTT público.
// Todo viaja cifrado (AES-GCM) con una clave derivada del código de sala,
// que nunca se envía. El servidor puede ver IP, horarios y actividad.
import { SERVIDOR_MQTT } from './config.js';

const ITERACIONES = 200000;
const CADA_LATIDO = 4000;    // ms
const PAREJA_PERDIDA = 30000; // ms sin mensajes = su lugar puede ocuparse
const RELOJ = 120000;         // ms de diferencia máxima aceptada
const TAMANO_MAXIMO = 2048;   // bytes
const POSICION_VIEJA = 15000; // ms

const texto = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const aBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const deBase64 = (cadena) => Uint8Array.from(atob(cadena), (c) => c.charCodeAt(0));

// Del código salen la clave y el nombre del canal; el canal no lo revela.
export async function derivar(codigo) {
  const material = await crypto.subtle.importKey('raw', texto.encode(codigo), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: texto.encode('meetme-v1'), iterations: ITERACIONES },
    material, 384,
  ));
  const clave = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { clave, canal: `meetme/v1/${hex(bits.slice(32))}` };
}

export async function cifrar({ clave, canal }, datos) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: texto.encode(canal) },
    clave, texto.encode(JSON.stringify(datos)),
  ));
  const mensaje = new Uint8Array(iv.length + cifrado.length);
  mensaje.set(iv);
  mensaje.set(cifrado, iv.length);
  return aBase64(mensaje); // viaja como texto
}

// Devuelve null si no se puede descifrar (basura, otra clave o alterado).
export async function descifrar({ clave, canal }, recibido) {
  if (recibido.length > TAMANO_MAXIMO) return null;
  try {
    const mensaje = deBase64(recibido);
    if (mensaje.length <= 12) return null;
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: mensaje.slice(0, 12), additionalData: texto.encode(canal) },
      clave, mensaje.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(claro));
  } catch {
    return null;
  }
}

// Identificador del teléfono: se conserva para recuperar el lugar al reabrir.
function miId() {
  const nuevo = () => hex(crypto.getRandomValues(new Uint8Array(8)));
  try {
    let id = localStorage.getItem('meetme-id');
    if (!id) {
      id = nuevo();
      localStorage.setItem('meetme-id', id);
    }
    return id;
  } catch {
    return nuevo();
  }
}

const enRango = (n, limite) => Number.isFinite(n) && Math.abs(n) <= limite;

function clienteNavegador() {
  if (!window.mqtt) throw new Error('sin-libreria');
  return window.mqtt.connect(SERVIDOR_MQTT, {
    clientId: `mm_${hex(crypto.getRandomValues(new Uint8Array(8)))}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    queueQoSZero: false, // no acumular posiciones viejas sin red
  });
}

export async function entrar(codigo, { alAmigo, alRed, alLlena, alExtra = () => {} }, opciones = {}) {
  const {
    crearCliente = clienteNavegador,
    id = miId(),
    ahora = () => Date.now(),
    latido = CADA_LATIDO,
    espera = 15000,
  } = opciones;
  const sala = await derivar(codigo);
  const cliente = crearCliente();

  let pareja = null;          // { id }
  const vistos = new Map();   // id -> { con, desde, visto, t, llenaDesde }
  const desdeYo = ahora();
  let posicion = null;        // { datos, momento }
  let extra = {};             // plan de reunión y avance hacia él
  let ultimoT = 0;
  let activo = true;

  // Los envíos salen en el mismo orden en que se piden.
  let salida = Promise.resolve();
  function publicar(tipo = 'estado') {
    salida = salida.then(() => enviarAhora(tipo)).catch(() => {});
    return salida;
  }

  async function enviarAhora(tipo) {
    if (!activo || !cliente.connected) return;
    ultimoT = Math.max(ahora(), ultimoT + 1);
    const fresca = posicion && ahora() - posicion.momento < POSICION_VIEJA;
    const datos = { tipo, id, desde: desdeYo, t: ultimoT, con: pareja?.id ?? null, ...(fresca ? posicion.datos : {}), x: extra };
    const mensaje = await cifrar(sala, datos);
    // Sin "retain": el servidor no debe guardar la última posición.
    cliente.publish(sala.canal, mensaje, { qos: 0, retain: false });
  }

  function cerrar() {
    activo = false;
    clearInterval(reloj);
    cliente.end();
  }

  const activa = (v) => Boolean(v) && v.visto > 0 && ahora() - v.visto < PAREJA_PERDIDA;
  const esMutua = () => {
    const v = pareja && vistos.get(pareja.id);
    return activa(v) && v.con === id;
  };

  // Regla fija para que todos coincidan: una pareja ya formada se respeta;
  // si no la hay, se elige a quien entró primero y no esté en otra pareja.
  function elegirPareja() {
    if (esMutua()) return;
    const disponibles = [...vistos].filter(([suId, v]) => {
      if (!activa(v)) return false;
      if (!v.con || v.con === id) return true;
      const tercero = vistos.get(v.con);
      return !(activa(tercero) && tercero.con === suId);
    });
    const callado = (v) => Number(ahora() - v.visto >= latido * 3);
    disponibles.sort(([a, x], [b, y]) => callado(x) - callado(y) || x.desde - y.desde || a.localeCompare(b));
    pareja = disponibles.length ? { id: disponibles[0][0] } : null;
  }

  async function recibir(bytes) {
    const m = await descifrar(sala, bytes.length > TAMANO_MAXIMO ? '' : new TextDecoder().decode(bytes));
    if (!activo || !m || typeof m.id !== 'string' || m.id === id) return;
    if (!Number.isFinite(m.t) || Math.abs(ahora() - m.t) > RELOJ) return;
    const previo = vistos.get(m.id);
    if (previo && m.t <= previo.t) return; // repetido o atrasado

    if (m.tipo === 'adios') {
      vistos.set(m.id, { con: null, visto: 0, t: m.t });
      if (pareja?.id === m.id) {
        pareja = null;
        alAmigo(null);
      }
      return;
    }

    const esNuevo = !previo || previo.visto === 0;
    const desde = Number.isFinite(m.desde) ? m.desde : m.t;
    vistos.set(m.id, { con: m.con, desde, visto: ahora(), t: m.t, llenaDesde: previo?.llenaDesde });

    const antes = pareja;
    elegirPareja();

    // Sala llena: otras dos personas llevan un rato reconociéndose entre sí.
    const quien = vistos.get(m.id);
    const otro = m.con && m.con !== id ? vistos.get(m.con) : null;
    if (!esMutua() && activa(otro) && otro.con === m.id) {
      quien.llenaDesde ??= ahora();
      if (ahora() - quien.llenaDesde >= latido * 2.5) {
        await publicar('adios'); // para que nadie lo tome como pareja
        cerrar();
        alLlena();
        return;
      }
    } else {
      quien.llenaDesde = undefined;
    }

    // Se responde al cambiar de pareja o al ver a alguien nuevo.
    if (antes?.id !== pareja?.id || esNuevo) publicar();

    // Solo se aceptan datos de la pareja confirmada.
    if (pareja?.id !== m.id || m.con !== id) return;
    if (m.x && typeof m.x === 'object') alExtra(m.x);
    if (enRango(m.lat, 90) && enRango(m.lon, 180)) {
      alAmigo({ lat: m.lat, lon: m.lon, v: Number.isFinite(m.v) && m.v >= 0 ? m.v : null });
    }
  }

  let reloj = null;
  await new Promise((resolver, rechazar) => {
    const limite = setTimeout(() => {
      cerrar();
      rechazar(new Error('sin-conexion'));
    }, espera);

    // Los mensajes se procesan en orden, uno por uno.
    let cola = Promise.resolve();
    cliente.on('message', (canal, bytes) => {
      if (canal === sala.canal) cola = cola.then(() => recibir(bytes)).catch(() => {});
    });
    cliente.on('connect', () => {
      cliente.subscribe(sala.canal, { qos: 0 }, (error) => {
        if (error || !activo) return;
        clearTimeout(limite);
        alRed(true);
        publicar();
        resolver();
      });
    });
    cliente.on('close', () => { if (activo) alRed(false); });
    cliente.on('error', () => {});
  });
  reloj = setInterval(() => publicar(), latido);

  return {
    // Se adjunta a cada mensaje; con ya = true sale de inmediato.
    compartir(datos, ya = false) {
      extra = datos;
      return ya ? publicar() : Promise.resolve();
    },
    enviar(datos) {
      posicion = { datos, momento: ahora() };
      return publicar();
    },
    async salir() {
      if (!activo) return;
      await publicar('adios');
      cerrar();
    },
  };
}
