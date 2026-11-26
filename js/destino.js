// Punto de reunión: ambos van a un mismo lugar y cada uno ve a qué ritmo ir.
import * as calc from './calculo.js';

const $ = (id) => document.getElementById(id);
const BUSCADOR = 'https://nominatim.openstreetmap.org/search';
const RUTA_CADA = 120000;  // ms entre consultas normales (el avance se calcula aquí)
const RUTA_MINIMO = 15000; // ms mínimos aun con desvío
const DESVIO = 200;        // m fuera de la ruta
const LLEGADA = 150;       // m para darlo por llegado
const VIEJO = 60000;       // ms sin datos de la otra persona
const MARGEN_MAXIMO = 600; // min

export const nuevoDestino = () => ({
  plan: { ...calc.PLAN_VACIO },
  margen: 0,
  ruta: null, rutaId: 0, consultando: false, ultima: 0, falla: false,
  ritmo: calc.crearMedidor(600000),
  avance: calc.crearMedidor(600000), // metros por segundo recorridos hacia el punto
  estable: calc.crearEstable(),
  mio: null, amigo: null, llegue: null,
  linea: null, marca: null,
});

export const hayDestino = (v) => Boolean(v?.destino.plan.dest);

export function crearDestino({ viaje, t, idioma, imperial, consultarRuta, alCambiarPlan, repintar }) {
  let borrador = null;
  let eligiendo = false;
  let ultimaBusqueda = 0;

  const texto = (clave, valores = {}) =>
    Object.entries(valores).reduce((s, [k, x]) => s.replace(`{${k}}`, x), t(clave));
  const reloj = (ms) => new Date(ms).toLocaleTimeString(idioma() === 'en' ? 'en-US' : 'es-MX', { hour: 'numeric', minute: '2-digit' });
  const duracion = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);

  function limpiarRuta(d) {
    d.linea?.remove();
    d.linea = null;
    d.ruta = null;
    d.ultima = 0;
    d.falla = false;
    d.mio = null;
    d.llegue = null;
    d.ritmo.reiniciar();
    d.avance.reiniciar();
    d.estable = calc.crearEstable();
  }

  function aplicarPlan(v, plan) {
    const d = v.destino;
    const antes = d.plan.dest;
    d.plan = plan;
    const mismoLugar = antes && plan.dest && calc.distancia(antes, plan.dest) < 1;
    if (!mismoLugar) {
      limpiarRuta(d);
      d.amigo = null;
      d.marca?.remove();
      d.marca = null;
      if (plan.dest) {
        const icono = L.divIcon({ className: '', html: '<div class="marca-destino"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
        d.marca = L.marker([plan.dest.lat, plan.dest.lon], { icon: icono, keyboard: false }).addTo(v.mapa);
      }
      v.seguir = true;
    }
    $('llegadas').hidden = !plan.dest;
    $('consejo').hidden = !plan.dest;
  }

  // Plan o avance que manda la otra persona.
  function recibir(v, extra) {
    const plan = calc.validarPlan(extra.plan, Date.now());
    if (plan && plan.rev > v.destino.plan.rev) {
      aplicarPlan(v, plan);
      v.destino.estable = calc.crearEstable();
    }
    const resumen = calc.validarResumen(extra.resumen);
    if (resumen && resumen.rev === v.destino.plan.rev) v.destino.amigo = { ...resumen, recibido: Date.now() };
  }

  function paraEnviar(v) {
    const d = v.destino;
    if (!d.plan.rev) return {};
    return { plan: d.plan, resumen: d.mio };
  }

  async function revisarRuta(v) {
    const d = v.destino;
    if (!d.plan.dest || !v.yo || d.consultando || d.llegue) return;
    const desviado = d.ruta && calc.restanteEnRuta(d.ruta, v.yo).desvio > DESVIO;
    const pasado = Date.now() - d.ultima;
    if (pasado < (desviado ? RUTA_MINIMO : d.ruta ? RUTA_CADA : 30000)) return;
    d.consultando = true;
    d.ultima = Date.now();
    const dest = d.plan.dest;
    try {
      const ruta = await consultarRuta(v.yo, dest, true);
      if (viaje() !== v || d.plan.dest !== dest) return;
      d.ruta = ruta;
      d.rutaId += 1;
      d.falla = false;
      d.linea?.remove();
      d.linea = L.polyline(ruta.puntos.map((p) => [p.lat, p.lon]), { className: 'ruta-linea', weight: 6, opacity: 0.9 }).addTo(v.mapa);
      calcular(v, true);
      alCambiarPlan(v);
      repintar();
    } catch {
      if (viaje() === v) d.falla = true;
    } finally {
      d.consultando = false;
    }
  }

  // Actualiza lo que me falta. medir = true solo con una posición nueva.
  function calcular(v, medir = false) {
    const d = v.destino;
    if (!d.plan.dest || !v.yo) return;
    const ahora = Date.now();
    if (calc.distancia(v.yo, d.plan.dest) < LLEGADA) {
      d.llegue ??= ahora;
      d.mio = { rev: d.plan.rev, m: 0, s: 0, e: d.llegue, l: null, mg: 0, fin: true };
      return;
    }
    d.llegue = null;
    if (!d.ruta) {
      d.mio = null;
      return;
    }
    const resto = calc.restanteEnRuta(d.ruta, v.yo);
    if (resto.desvio > DESVIO) return; // se conserva lo último hasta tener ruta nueva
    if (medir) {
      d.ritmo.agregar(ahora, resto.segundos, d.rutaId);
      d.avance.agregar(ahora, resto.metros, d.rutaId);
    }
    const ritmo = calc.ajustarRitmo(d.ritmo.velocidad(180000));
    d.mio = {
      rev: d.plan.rev,
      m: Math.round(resto.metros),
      s: Math.round(resto.segundos),
      ...calc.llegadas({ ahora, segundos: resto.segundos, ritmo, margen: d.margen }),
      mg: d.margen,
      fin: false,
    };
  }

  function fraseConsejo(c) {
    const velocidad = c.velocidad ? calc.formatoVelocidad(c.velocidad, imperial()) : null;
    if (c.tipo === 'tarde') return texto('cTarde', { n: duracion(c.minutos) });
    if (c.tipo === 'atrasado') {
      return velocidad ? texto('cAtrasado', { n: duracion(c.minutos), v: velocidad }) : texto('cAtrasadoSin', { n: duracion(c.minutos) });
    }
    if (c.tipo === 'sobra') return texto('cSobra', { n: duracion(c.minutos) });
    if (c.tipo === 'antes') {
      return velocidad ? texto('cAntes', { n: duracion(c.minutos), v: velocidad }) : texto('cAntesSin', { n: duracion(c.minutos) });
    }
    return velocidad ? texto('cATiempo', { v: velocidad }) : t('cATiempoSin');
  }

  function lineaPersona(nombre, r, objetivo, viejo) {
    if (!r) return `${nombre}: ${t('sinDatos')}`;
    if (r.fin) return `${nombre}: ${texto('yaLlego', { h: reloj(r.e) })}`;
    const llegada = r.l ?? r.e;
    let diferencia = '';
    if (objetivo) {
      const min = Math.round((objetivo - llegada) / 60000);
      if (Math.abs(llegada - objetivo) <= calc.TOLERANCIA) diferencia = t('enTiempo');
      else diferencia = texto(min > 0 ? 'adelantado' : 'retrasado', { n: duracion(Math.abs(min)) });
    }
    return [`${nombre}: ${reloj(llegada)}`, diferencia, viejo ? t('sinActualizar') : ''].filter(Boolean).join(' · ');
  }

  // Devuelve lo que va en el letrero y llena el consejo y las llegadas.
  function pintar(v) {
    const d = v.destino;
    const { plan, mio, amigo } = d;
    const ahora = Date.now();
    const viejo = amigo && !amigo.fin && ahora - amigo.recibido > VIEJO;
    const objetivo = calc.horaObjetivo({ modo: plan.modo, hora: plan.hora, yo: mio, amigo });

    let titulo = texto('tDestino', { lugar: plan.dest.nombre || t('puntoMarcado') });
    let tiempo = { valor: '--', unidad: '' };
    let consejo = '';
    let estado = null; // consejo basado en el ritmo real: es el que lleva color
    let medidor = null; // lo que va en grande
    let promedio = d.avance.velocidad(180000);
    // La demo avanza al ritmo de la ruta: se usa ese promedio desde el inicio.
    if (promedio === null && v.esDemo && mio?.s) promedio = mio.m / mio.s;

    if (mio?.fin) {
      titulo = t('tLlegaste');
      tiempo = { valor: '0', unidad: 'min' };
    } else if (mio) {
      tiempo = calc.formatoTiempo(((mio.l ?? mio.e) - ahora) / 1000);
      if (!objetivo) consejo = t('cEsperando');
      else {
        let actual = calc.aconsejar({
          ahora, objetivo, e: mio.e, l: mio.l, metros: mio.m, segundos: mio.s, margen: mio.mg,
        });
        // Sin ritmo reciente no hay color. La demo avanza al ritmo de la ruta.
        const gpsViejo = !v.yo || ahora - v.yo.recibido > 20000;
        if ((mio.l || v.esDemo) && !gpsViejo) {
          estado = d.estable(actual, ahora);
          actual = estado;
        }
        medidor = calc.tablero({ consejo: actual, midiendo: !estado, promedio, imperial: imperial() });
        // El texto solo acompaña cuando la cifra grande no basta.
        if (actual.tipo === 'tarde' || actual.tipo === 'sobra') consejo = fraseConsejo(actual);
      }
    } else if (v.yo) {
      consejo = t(d.falla ? 'cSinRuta' : 'cCalculando');
    }

    if (!estado) d.estable(null, ahora);
    const color = estado ? calc.COLOR_RITMO[estado.tipo] : '';
    $('viaje').dataset.ritmo = color;
    $('consejo-texto').textContent = consejo;
    pintarTablero(medidor, promedio, color);
    $('consejo').hidden = !consejo;
    $('llegadas').hidden = false;
    // La hora siempre está a la vista y al tocarla se puede cambiar.
    $('meta').textContent = objetivo
      ? texto(plan.modo === 'hora' ? 'metaHora' : 'metaJuntos', { h: reloj(objetivo) })
      : t('ponerHora');
    $('llegada-yo').textContent = lineaPersona(t('tu'), mio, objetivo, false);
    const metros = mio ? mio.m : v.yo ? calc.distancia(v.yo, plan.dest) : null;
    const actualVelocidad = v.yo && ahora - v.yo.recibido <= 20000 ? v.yo.v ?? null : null;
    $('resumen').textContent = [
      metros === null ? '' : calc.formatoDistancia(metros, imperial()),
      mio && !mio.fin ? `${tiempo.valor} ${tiempo.unidad}` : '',
      `${t('ahora')} ${calc.formatoVelocidad(actualVelocidad, imperial())}`,
    ].filter(Boolean).join(' · ');
    $('llegada-amigo').textContent = lineaPersona(t('otro'), amigo, objetivo, viejo);

    let metodo = '';
    if (mio && !mio.fin) {
      metodo = t(mio.l ? 'mRitmo' : 'mRuta');
      if (mio.mg) metodo += ` ${texto('mMargen', { n: mio.mg })}`;
      metodo += ` ${t('mAviso')}`;
    }
    return {
      titulo, tiempo, metodo,
      metros,
      rumbo: v.yo ? calc.rumbo(v.yo, plan.dest) : 0,
    };
  }

  function pintarTablero(medidor, promedio, color) {
    $('velocimetro').hidden = !medidor;
    if (!medidor) return;
    $('accion').textContent = texto(`a_${medidor.accion}`, { n: medidor.n });
    const { cifra } = medidor;
    let valor = '--';
    let unidad = '';
    if (cifra?.tipo === 'velocidad') {
      valor = String(cifra.valor);
      unidad = texto(color === 'amarillo' ? 'uLimite' : 'uPromedio', { u: imperial() ? 'mph' : 'km/h' });
    } else if (cifra) {
      valor = cifra.valor < 60 ? String(cifra.valor) : `${Math.floor(cifra.valor / 60)}:${String(cifra.valor % 60).padStart(2, '0')}`;
      unidad = texto(cifra.tipo === 'tarde' ? 'uTarde' : 'uSobra', { u: cifra.valor < 60 ? 'min' : 'h' });
    }
    $('cifra').textContent = valor;
    $('cifra-unidad').textContent = unidad;
    $('promedio').textContent = promedio === null ? t('midiendoPromedio')
      : texto('tuPromedio', { v: calc.formatoVelocidad(promedio, imperial()) });
  }

  /* ---------- Ventana para elegir el punto ---------- */
  function pintarBorrador() {
    const v = viaje();
    if (!v || !borrador) return;
    $('plan-donde').hidden = v.esDemo;
    $('plan-elegido').textContent = borrador.dest ? borrador.dest.nombre || t('puntoMarcado') : t('sinPunto');
    $('plan-fija').setAttribute('aria-pressed', String(borrador.modo === 'hora'));
    $('plan-juntos').setAttribute('aria-pressed', String(borrador.modo !== 'hora'));
    $('plan-hora-fila').hidden = borrador.modo !== 'hora';
    $('plan-quitar').hidden = !v.destino.plan.dest || v.esDemo;
  }

  function abrir() {
    const v = viaje();
    if (!v) return;
    const { plan, margen } = v.destino;
    borrador = { dest: plan.dest, modo: plan.modo };
    $('plan-hora').value = plan.hora ? new Date(plan.hora).toTimeString().slice(0, 5) : '';
    $('plan-margen').value = margen || '';
    $('plan-busqueda').value = '';
    $('plan-resultados').replaceChildren();
    $('plan-error').textContent = '';
    pintarBorrador();
    $('plan').showModal();
  }

  function guardarPlan(v, nuevo) {
    const actual = v.destino.plan;
    const cambio = JSON.stringify([nuevo.dest, nuevo.modo, nuevo.hora]) !== JSON.stringify([actual.dest, actual.modo, actual.hora]);
    if (cambio) aplicarPlan(v, { ...nuevo, rev: Math.max(Date.now(), actual.rev + 1) });
    // Un cambio hecho por la persona se refleja sin esperar.
    v.destino.estable = calc.crearEstable();
    if (v.destino.mio) v.destino.mio.rev = v.destino.plan.rev;
    calcular(v);
    alCambiarPlan(v);
    revisarRuta(v);
    repintar();
  }

  function guardar() {
    const v = viaje();
    if (!v) return;
    if (!borrador.dest) {
      $('plan-error').textContent = t('errPunto');
      return;
    }
    let hora = null;
    if (borrador.modo === 'hora') {
      const campo = $('plan-hora').value;
      const previa = v.destino.plan.hora;
      // Sin cambios en el campo se conserva la fecha ya acordada.
      hora = previa && new Date(previa).toTimeString().slice(0, 5) === campo ? previa : calc.horaAFecha(campo, Date.now());
      if (!hora) {
        $('plan-error').textContent = t('errHora');
        return;
      }
    }
    const margen = Math.round(Number($('plan-margen').value) || 0);
    v.destino.margen = Math.max(0, Math.min(MARGEN_MAXIMO, margen));
    $('plan').close();
    guardarPlan(v, { dest: borrador.dest, modo: borrador.modo, hora });
  }

  async function buscar(evento) {
    evento.preventDefault();
    const consulta = $('plan-busqueda').value.trim();
    $('plan-busqueda').blur();
    // El buscador gratuito pide como máximo una consulta por segundo.
    if (consulta.length < 3 || Date.now() - ultimaBusqueda < 1500) return;
    ultimaBusqueda = Date.now();
    $('plan-error').textContent = t('buscando');
    try {
      const parametros = new URLSearchParams({ format: 'jsonv2', limit: '5', 'accept-language': idioma(), q: consulta });
      const respuesta = await fetch(`${BUSCADOR}?${parametros}`);
      if (!respuesta.ok) throw new Error('buscador');
      const lugares = await respuesta.json();
      $('plan-error').textContent = lugares.length ? '' : t('sinResultados');
      $('plan-resultados').replaceChildren(...lugares.map((lugar) => {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'boton resultado';
        boton.textContent = lugar.display_name;
        boton.addEventListener('click', () => {
          const nombre = String(lugar.display_name).split(',').slice(0, 2).join(',').slice(0, 60);
          borrador.dest = { lat: Number(lugar.lat), lon: Number(lugar.lon), nombre };
          $('plan-resultados').replaceChildren();
          pintarBorrador();
        });
        const elemento = document.createElement('li');
        elemento.append(boton);
        return elemento;
      }));
    } catch {
      $('plan-error').textContent = t('errBuscar');
    }
  }

  function elegirEnMapa() {
    eligiendo = true;
    $('plan').close();
    repintar();
  }

  function tocarMapa(evento) {
    if (!eligiendo) return;
    eligiendo = false;
    const { lat, lng } = evento.latlng.wrap();
    borrador.dest = { lat, lon: lng, nombre: '' };
    $('plan-error').textContent = '';
    $('plan').showModal();
    pintarBorrador();
    repintar();
  }

  $('abrir-plan').addEventListener('click', abrir);
  $('plan-form').addEventListener('submit', buscar);
  $('plan-mapa').addEventListener('click', elegirEnMapa);
  const elegirModo = (modo) => {
    borrador.modo = modo;
    $('plan-error').textContent = '';
    pintarBorrador();
  };
  $('plan-fija').addEventListener('click', () => elegirModo('hora'));
  $('plan-juntos').addEventListener('click', () => elegirModo('juntos'));
  $('meta').addEventListener('click', abrir);
  $('plan-guardar').addEventListener('click', guardar);
  $('plan-cancelar').addEventListener('click', () => $('plan').close());
  $('plan-quitar').addEventListener('click', () => {
    const v = viaje();
    $('plan').close();
    guardarPlan(v, { dest: null, modo: 'juntos', hora: null });
  });

  return {
    aplicarPlan, recibir, paraEnviar, revisarRuta, calcular, pintar, pintarBorrador, tocarMapa,
    eligiendo: () => eligiendo,
    cancelarEleccion: () => { eligiendo = false; },
  };
}
