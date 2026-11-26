// Cálculos puros (sin DOM) para poder probarlos con Node.
const RADIO_TIERRA = 6371000;
const rad = (g) => (g * Math.PI) / 180;

// Puntos como { lat, lon }. Devuelve metros en línea recta.
export function distancia(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA * Math.asin(Math.sqrt(h));
}

// Rumbo de a hacia b en grados (0 = norte, 90 = este).
export function rumbo(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Prepara una ruta: puntos [{lat, lon}] con la distancia acumulada de cada uno.
export function prepararRuta(puntos) {
  const acumulado = [0];
  for (let i = 1; i < puntos.length; i++) {
    acumulado.push(acumulado[i - 1] + distancia(puntos[i - 1], puntos[i]));
  }
  return { puntos, acumulado, largo: acumulado[acumulado.length - 1] };
}

// Proyecta un punto sobre la ruta: avance desde el inicio y separación, en metros.
export function proyectar(ruta, p) {
  const escalaX = Math.cos(rad(p.lat)) * rad(1) * RADIO_TIERRA;
  const escalaY = rad(1) * RADIO_TIERRA;
  let mejor = { avance: 0, separacion: Infinity };
  for (let i = 1; i < ruta.puntos.length; i++) {
    const a = ruta.puntos[i - 1];
    const b = ruta.puntos[i];
    const ax = (a.lon - p.lon) * escalaX;
    const ay = (a.lat - p.lat) * escalaY;
    const dx = (b.lon - a.lon) * escalaX;
    const dy = (b.lat - a.lat) * escalaY;
    const largo2 = dx * dx + dy * dy;
    const t = largo2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / largo2)) : 0;
    const separacion = Math.hypot(ax + t * dx, ay + t * dy);
    if (separacion < mejor.separacion) {
      const tramo = ruta.acumulado[i] - ruta.acumulado[i - 1];
      mejor = { avance: ruta.acumulado[i - 1] + t * tramo, separacion };
    }
  }
  return mejor;
}

// Promedia qué tan rápido se acorta la distancia durante la última ventana.
// Solo compara lecturas del mismo origen (misma ruta), para que un recálculo
// de ruta no parezca un salto de velocidad.
export function crearMedidor(ventana = 60000) {
  let tramos = [];
  let previo = null;
  return {
    agregar(t, metros, origen) {
      if (previo && previo.origen === origen && t > previo.t) {
        tramos.push({ t, dt: t - previo.t, delta: previo.metros - metros });
      }
      previo = { t, metros, origen };
      tramos = tramos.filter((x) => t - x.t <= ventana);
    },
    // m/s (positivo = se acercan). null si aún no hay datos suficientes.
    velocidad(minimo = 15000) {
      const tiempo = tramos.reduce((s, x) => s + x.dt, 0);
      if (tiempo < minimo) return null;
      return tramos.reduce((s, x) => s + x.delta, 0) / (tiempo / 1000);
    },
    reiniciar() { tramos = []; previo = null; },
  };
}

export const UMBRAL_QUIETO = 0.6; // m/s
export const UMBRAL_LLEGADA = 50; // m

// Decide qué tiempo mostrar.
//  cierre: m/s de acercamiento (o null); restante: metros por recorrer;
//  segundosRuta: tiempo estimado por el servicio de rutas para lo restante (o null).
export function estimar({ cierre, restante, segundosRuta }) {
  if (cierre !== null && cierre < -UMBRAL_QUIETO) return { segundos: null, metodo: 'alejando' };
  if (cierre !== null && cierre > UMBRAL_QUIETO) return { segundos: restante / cierre, metodo: 'enVivo' };
  if (segundosRuta !== null) {
    return { segundos: segundosRuta, metodo: cierre === null ? 'midiendo' : 'detenidos' };
  }
  return { segundos: null, metodo: cierre === null ? 'midiendo' : 'detenidos' };
}

export function formatoTiempo(segundos) {
  if (segundos === null || !Number.isFinite(segundos)) return { valor: '--', unidad: '' };
  const minutos = Math.max(1, Math.round(segundos / 60));
  if (minutos < 60) return { valor: String(minutos), unidad: 'min' };
  if (minutos >= 6000) return { valor: '--', unidad: '' };
  return { valor: `${Math.floor(minutos / 60)}:${String(minutos % 60).padStart(2, '0')}`, unidad: 'h' };
}

// imperial = millas (idioma inglés); si no, kilómetros.
export function formatoDistancia(metros, imperial) {
  if (imperial) {
    const millas = metros / 1609.344;
    if (millas < 0.2) return `${Math.round(metros * 3.28084)} ft`;
    return `${millas < 10 ? millas.toFixed(1) : Math.round(millas)} mi`;
  }
  if (metros < 1000) return `${Math.round(metros)} m`;
  const km = metros / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatoVelocidad(ms, imperial) {
  const unidad = imperial ? 'mph' : 'km/h';
  if (ms === null) return `-- ${unidad}`;
  return `${Math.round(ms * (imperial ? 2.236936 : 3.6))} ${unidad}`;
}

/* ---------- Punto de reunión ---------- */
export const TOLERANCIA = 180000;      // ms: diferencia que se considera "a tiempo"
export const SIN_CONSEJO = 3000;       // m: tan cerca ya no se sugiere velocidad
const RITMO_MINIMO = 0.7;              // no sugerir ir a menos del 70 % del ritmo normal

// Agrega a una ruta el tiempo acumulado en cada punto.
// tramos: segundos de cada segmento (si faltan, se reparte según la distancia).
export function agregarTiempos(ruta, segundos, tramos) {
  const validos = Array.isArray(tramos) && tramos.length === ruta.puntos.length - 1;
  let tiempos;
  if (validos) {
    tiempos = [0];
    for (const s of tramos) tiempos.push(tiempos[tiempos.length - 1] + s);
  } else {
    tiempos = ruta.acumulado;
  }
  const total = tiempos[tiempos.length - 1] || 1;
  return { ...ruta, segundos, tiempos: tiempos.map((x) => (x / total) * segundos) };
}

function interpolar(desde, hasta, x) {
  let i = 1;
  while (i < desde.length - 1 && desde[i] < x) i++;
  const tramo = desde[i] - desde[i - 1];
  const f = tramo ? Math.max(0, Math.min(1, (x - desde[i - 1]) / tramo)) : 0;
  return { i, f, valor: hasta[i - 1] + (hasta[i] - hasta[i - 1]) * f };
}

// Lo que falta desde un punto hasta el final de la ruta.
export function restanteEnRuta(ruta, p) {
  const { avance, separacion } = proyectar(ruta, p);
  const consumido = interpolar(ruta.acumulado, ruta.tiempos, avance).valor;
  const escala = ruta.largo ? ruta.metros / ruta.largo : 1;
  return {
    metros: Math.max(0, ruta.largo - avance) * escala,
    segundos: Math.max(0, ruta.segundos - consumido),
    desvio: separacion,
  };
}

// Posición tras cierto tiempo de ruta (para la demo).
export function puntoEnTiempo(ruta, segundos) {
  const { i, f } = interpolar(ruta.tiempos, ruta.tiempos, segundos);
  const a = ruta.puntos[i - 1];
  const b = ruta.puntos[i];
  const duracion = ruta.tiempos[i] - ruta.tiempos[i - 1];
  const terminado = segundos >= ruta.segundos;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    v: terminado || !duracion ? 0 : (ruta.acumulado[i] - ruta.acumulado[i - 1]) / duracion,
  };
}

// Ritmo real frente al normal de la ruta (1 = igual). null si está detenido.
export function ajustarRitmo(factor) {
  if (factor === null || factor < 0.3) return null;
  return Math.max(0.5, Math.min(1.5, factor));
}

// e: llegada a ritmo normal de ruta; l: llegada a tu ritmo real (o null).
export function llegadas({ ahora, segundos, ritmo, margen }) {
  const extra = margen * 60000;
  return {
    e: ahora + segundos * 1000 + extra,
    l: ritmo ? ahora + (segundos / ritmo) * 1000 + extra : null,
  };
}

// Hora a la que deben llegar. En "juntos" manda quien llegaría más tarde a
// ritmo normal; así, quien baja la velocidad no recorre la meta de ambos.
export function horaObjetivo({ modo, hora, yo, amigo }) {
  if (modo === 'hora') return hora;
  if (!yo || !amigo) return null;
  const referencia = yo.e >= amigo.e ? yo : amigo;
  return Math.max(referencia.e, referencia.l ?? referencia.e);
}

// Qué decirle a una persona. Nunca sugiere ir más rápido que el ritmo normal.
//  margen: minutos de espera extra; velocidad: promedio necesario en m/s.
export function aconsejar({ ahora, objetivo, e, l, metros, segundos, margen }) {
  const llegada = l ?? e;
  const disponible = (objetivo - ahora) / 1000 - margen * 60;
  const minutos = (ms) => Math.max(1, Math.round(ms / 60000));

  if (disponible < segundos - TOLERANCIA / 1000) {
    return { tipo: 'tarde', minutos: minutos(Math.max(e, llegada) - objetivo) };
  }
  if (llegada - objetivo > TOLERANCIA) {
    const necesaria = metros >= SIN_CONSEJO && disponible > 60 ? metros / disponible : null;
    return { tipo: 'atrasado', minutos: minutos(llegada - objetivo), velocidad: necesaria };
  }
  if (metros < SIN_CONSEJO) return { tipo: 'aTiempo', velocidad: null };
  if (disponible > segundos / RITMO_MINIMO && disponible - segundos > 600) {
    return { tipo: 'sobra', minutos: minutos((disponible - segundos) * 1000) };
  }
  const velocidad = disponible > 60 ? metros / disponible : null;
  if (objetivo - llegada > TOLERANCIA) return { tipo: 'antes', minutos: minutos(objetivo - llegada), velocidad };
  return { tipo: 'aTiempo', velocidad };
}

// Color del contorno. Rojo = llegarías antes, no exceso de velocidad.
export const COLOR_RITMO = { aTiempo: 'verde', antes: 'rojo', sobra: 'rojo', atrasado: 'amarillo', tarde: 'morado' };

// Cambia de color solo si la nueva situación se mantiene unos segundos.
// Sin datos (null) se quita de inmediato.
export function crearEstable(espera = 10000) {
  let actual = null;
  let pendiente = null;
  let desde = 0;
  return (consejo, ahora) => {
    const color = consejo && COLOR_RITMO[consejo.tipo];
    if (!consejo || !actual || color === COLOR_RITMO[actual.tipo]) {
      actual = consejo;
      pendiente = null;
    } else if (pendiente !== color) {
      pendiente = color;
      desde = ahora;
    } else if (ahora - desde >= espera) {
      actual = consejo;
      pendiente = null;
    }
    return actual;
  };
}

// Qué se muestra en grande: la acción, cuánto cambiar y la cifra principal.
//  promedio: tu velocidad promedio reciente en m/s (null si aún se mide).
export function tablero({ consejo, midiendo, promedio, imperial }) {
  const factor = imperial ? 2.236936 : 3.6;
  const necesaria = consejo.velocidad ? Math.round(consejo.velocidad * factor) : null;
  const velocidad = necesaria === null ? null : { tipo: 'velocidad', valor: necesaria };

  if (consejo.tipo === 'tarde') return { accion: 'tarde', n: null, cifra: { tipo: 'tarde', valor: consejo.minutos } };
  if (midiendo) return { accion: 'midiendo', n: null, cifra: velocidad };
  if (consejo.tipo === 'sobra') return { accion: 'pausa', n: null, cifra: { tipo: 'sobra', valor: consejo.minutos } };
  if (consejo.tipo === 'aTiempo') return { accion: 'mantener', n: null, cifra: velocidad };

  const bajar = consejo.tipo === 'antes';
  // Se restan las cifras ya redondeadas para que cuadren con lo que se ve.
  const diferencia = necesaria === null || promedio === null ? null
    : (Math.round(promedio * factor) - necesaria) * (bajar ? 1 : -1);
  if (diferencia !== null && diferencia >= 1) {
    return { accion: bajar ? 'bajar' : 'subir', n: diferencia, cifra: velocidad };
  }
  // Si el promedio no explica la diferencia (cambian los tramos), no se da un número.
  return { accion: bajar ? 'adelantado' : 'atrasado', n: null, cifra: velocidad };
}

// Hora "HH:MM" del teléfono convertida a fecha: hoy, o mañana si ya pasó.
export function horaAFecha(hhmm, ahora) {
  const partes = /^(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (!partes) return null;
  const fecha = new Date(ahora);
  fecha.setHours(Number(partes[1]), Number(partes[2]), 0, 0);
  if (fecha.getTime() < ahora - 60000) fecha.setDate(fecha.getDate() + 1);
  return fecha.getTime();
}

/* ---------- Datos que llegan de la otra persona ---------- */
export const PLAN_VACIO = { rev: 0, dest: null, modo: 'juntos', hora: null };

export function validarPlan(p, ahora) {
  if (!p || !Number.isFinite(p.rev) || p.rev <= 0 || p.rev > ahora + 120000) return null;
  let dest = null;
  if (p.dest) {
    const { lat, lon, nombre } = p.dest;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
    dest = { lat, lon, nombre: String(nombre ?? '').slice(0, 60) };
  }
  const modo = p.modo === 'hora' ? 'hora' : 'juntos';
  if (modo === 'hora' && !Number.isFinite(p.hora)) return null;
  return { rev: p.rev, dest, modo, hora: modo === 'hora' ? p.hora : null };
}

export function validarResumen(x) {
  if (!x || ![x.rev, x.m, x.s, x.e, x.mg].every(Number.isFinite)) return null;
  if (x.m < 0 || x.s < 0 || x.mg < 0) return null;
  return { rev: x.rev, m: x.m, s: x.s, e: x.e, mg: x.mg, l: Number.isFinite(x.l) ? x.l : null, fin: x.fin === true };
}
