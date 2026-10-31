/* ==========================================================
   carrito.js  ·  Órbita
   Lee el carrito desde localStorage (clave "orbita_cart"),
   pinta los productos, calcula el total con descuento y
   registra el pedido en Google Sheets al pagar.
   ========================================================== */

(function () {
  'use strict';

  /* ---------- CONFIGURACIÓN ---------- */
  const CLAVE_CARRITO = 'orbita_cart';

  // URL de la implementación del Apps Script (Implementar > Aplicación web).
  // Termina en /exec
  const URL_PEDIDOS = 'https://script.google.com/macros/s/AKfycbzDN-BbC2UIP-R7PVi-ujGTDsOhFg6_IG-SEHbmgglmdpEuzauojxlzisWyxUIUYqOj/exec';

  // true  -> "descuento" es un porcentaje (ej. 10 = 10 %)
  // false -> "descuento" es un monto en dinero (ej. 2 = $2.00 menos)
  const DESCUENTO_ES_PORCENTAJE = true;

  const IMAGEN_POR_DEFECTO = ''; // ruta opcional si un producto no trae imagen

  /* ---------- ELEMENTOS DEL DOM ---------- */
  const $lista     = document.getElementById('carrito-lista');
  const $vacio     = document.getElementById('carrito-vacio');
  const $resumen   = document.getElementById('carrito-resumen');
  const $total     = document.getElementById('resumen-total');
  const $cantidad  = document.getElementById('resumen-cantidad');
  const $pagar     = document.querySelector('#carrito-resumen button.btn--principal');

  let enviando = false; // evita pedidos duplicados por doble clic

  /* ---------- UTILIDADES ---------- */
  const formatear = (n) =>
    '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

  const escapar = (texto) =>
    String(texto).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));

  function precioFinal(precio, descuento) {
    const p = Number(precio) || 0;
    const d = Number(descuento) || 0;
    const final = DESCUENTO_ES_PORCENTAJE ? p * (1 - d / 100) : p - d;
    return Math.max(final, 0);
  }

  /* ---------- LECTURA / ESCRITURA EN LOCALSTORAGE ---------- */
  function leerCarrito() {
    try {
      const crudo = localStorage.getItem(CLAVE_CARRITO);
      if (!crudo) return [];

      let datos = JSON.parse(crudo);
      // Acepta tanto un arreglo como un objeto { id: producto }
      if (!Array.isArray(datos)) datos = Object.values(datos || {});

      return datos
        .map((it) => ({
          ...it,
          nombre:    it.nombre ?? it.name ?? it.producto ?? 'Producto',
          precio:    Number(it.precio ?? it.price ?? 0),
          descuento: Number(it.descuento ?? it.discount ?? 0),
          imagen:    it.imagen ?? it.image ?? it.img ?? IMAGEN_POR_DEFECTO,
          cantidad:  Math.max(parseInt(it.cantidad ?? it.qty ?? 1, 10) || 1, 1)
        }))
        .filter((it) => it.nombre);
    } catch (e) {
      console.error('No se pudo leer el carrito:', e);
      return [];
    }
  }

  function guardarCarrito(carrito) {
    try {
      localStorage.setItem(CLAVE_CARRITO, JSON.stringify(carrito));
    } catch (e) {
      console.error('No se pudo guardar el carrito:', e);
    }
  }

  function vaciarCarrito() {
    try {
      localStorage.removeItem(CLAVE_CARRITO);
    } catch (e) {
      console.error('No se pudo vaciar el carrito:', e);
    }
  }

  /* ---------- RENDER ---------- */
  function crearItem(item, indice) {
    const unitario = precioFinal(item.precio, item.descuento);
    const subtotal = unitario * item.cantidad;

    const imagen = item.imagen
      ? `<img src="${escapar(item.imagen)}" alt="${escapar(item.nombre)}">`
      : '';

    return `
      <article class="item" data-indice="${indice}">
        <div class="item__imagen">${imagen}</div>

        <div class="item__info">
          <h3 class="item__nombre">${escapar(item.nombre)}</h3>
        </div>

        <div class="cantidad">
          <button class="cantidad__btn" type="button" data-accion="restar" aria-label="Disminuir cantidad">&minus;</button>
          <span class="cantidad__valor">${item.cantidad}</span>
          <button class="cantidad__btn" type="button" data-accion="sumar" aria-label="Aumentar cantidad">+</button>
        </div>

        <span class="item__precio">${formatear(unitario)}</span>
        <span class="item__total">${formatear(subtotal)}</span>
      </article>`;
  }

  function render() {
    const carrito = leerCarrito();

    // Carrito vacío: mostrar mensaje con enlace a menu.html
    if (carrito.length === 0) {
      $lista.hidden = true;
      $resumen.hidden = true;
      $vacio.hidden = false;
      return;
    }

    $vacio.hidden = true;
    $lista.hidden = false;
    $resumen.hidden = false;

    $lista.innerHTML = carrito.map(crearItem).join('');

    const total = carrito.reduce(
      (acc, it) => acc + precioFinal(it.precio, it.descuento) * it.cantidad, 0
    );
    const piezas = carrito.reduce((acc, it) => acc + it.cantidad, 0);

    $total.textContent = formatear(total);
    if ($cantidad) $cantidad.textContent = piezas;
  }

  /* ---------- PEDIDO: ENVÍO A GOOGLE SHEETS ---------- */
  // Arma el arreglo de artículos con el formato que usa el panel:
  // { id, nombre, variante, cantidad, precio }  (precio = unitario con descuento)
  function armarArticulos(carrito) {
    return carrito.map((it) => ({
      id:       it.id ?? it.sku ?? null,
      nombre:   it.nombre,
      variante: it.variante ?? it.variant ?? it.tamano ?? '',
      cantidad: it.cantidad,
      precio:   Number(precioFinal(it.precio, it.descuento).toFixed(2))
    }));
  }

  function estadoBoton(ocupado) {
    if (!$pagar) return;
    $pagar.disabled = ocupado;
    if (ocupado) {
      $pagar.dataset.textoOriginal = $pagar.textContent;
      $pagar.textContent = 'Enviando pedido…';
    } else if ($pagar.dataset.textoOriginal) {
      $pagar.textContent = $pagar.dataset.textoOriginal;
    }
  }

  async function apartarPedido() {
    if (enviando) return;

    const carrito = leerCarrito();
    if (carrito.length === 0) return;

    enviando = true;
    estadoBoton(true);

    try {
      // "text/plain" evita la petición previa (preflight) que Apps Script no admite
      const respuesta = await fetch(URL_PEDIDOS, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ articulos: armarArticulos(carrito) })
      });

      const resultado = await respuesta.json();
      if (!resultado.ok) throw new Error(resultado.error || 'Respuesta inválida del servidor');

      // Pedido registrado: carrito limpio y alerta
      vaciarCarrito();
      render();
      alert('¡Pedido apartado! Tu número de pedido es #' + resultado.no_pedido + '.');

    } catch (e) {
      console.error('No se pudo registrar el pedido:', e);
      alert('No pudimos registrar tu pedido. Tu carrito sigue intacto, intenta de nuevo.');
    } finally {
      enviando = false;
      estadoBoton(false);
    }
  }

  /* ---------- EVENTOS (sumar, restar, eliminar) ---------- */
  $lista.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-accion]');
    if (!boton) return;

    const articulo = boton.closest('.item');
    const indice = Number(articulo.dataset.indice);
    const carrito = leerCarrito();
    if (!carrito[indice]) return;

    if (boton.dataset.accion === 'sumar') {
      carrito[indice].cantidad += 1;
    } else {
      carrito[indice].cantidad -= 1;
      if (carrito[indice].cantidad <= 0) carrito.splice(indice, 1);
    }

    guardarCarrito(carrito);
    render();
  });

  // Botón "Pagar ahora"
  if ($pagar) $pagar.addEventListener('click', apartarPedido);

  // Si el carrito cambia en otra pestaña, se actualiza solo
  window.addEventListener('storage', (e) => {
    if (e.key === CLAVE_CARRITO) render();
  });

  document.addEventListener('DOMContentLoaded', render);
})();