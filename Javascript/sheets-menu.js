/* ============================================================
   sheets-menu.js
   Trae los productos del menú directamente desde Google Sheets
   (una pestaña = una categoría) y los renderiza en #products-grid.

   No requiere backend ni API key: usa el endpoint público de
   Google Visualization, que expone cualquier hoja como CSV:

     https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?tqx=out:csv&sheet={NombrePestaña}

   Requisito: la hoja debe compartirse como
   "Cualquier persona con el enlace puede ver" (Archivo > Compartir).
============================================================ */

(() => {
  // ID tomado de la URL de tu Google Sheet.
  const SHEET_ID = '1BqtHK9TeUdt65qcM9dHWEwGZKJNkK__jtxom8QgJH-E';

  // Cada cuánto se vuelve a consultar la hoja de la categoría activa (ms).
  const REFRESH_MS = 30000;

  // Clave de localStorage donde se guarda el carrito (la misma que lee carrito.js).
  const CART_KEY = 'orbita_cart';

  // Relación entre el data-category de cada botón del nav y el NOMBRE
  // EXACTO de la pestaña (hoja) correspondiente en Google Sheets.
  // Si agregas/renombras una pestaña, solo actualiza este objeto
  // (y agrega el botón correspondiente en el <nav> del HTML).
  const CATEGORY_SHEETS = {
    'bebidas-calientes': 'BebidasCalientes',
    'bebidas-frias': 'BebidasFrias',
    'alimentos': 'Alimentos',
  };

  const grid = document.getElementById('products-grid');
  const nav = document.getElementById('categories-nav');

  // cache[nombreHoja] = { data: Producto[], timestamp: number }
  const cache = {};
  let currentCategory = null;
  let refreshTimer = null;

  function csvUrl(sheetName) {
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  }

  // --- Parser CSV (RFC4180 básico: soporta comillas y comas dentro de celdas) ---
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (char === '"' && next === '"') { field += '"'; i++; }
        else if (char === '"') { inQuotes = false; }
        else { field += char; }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(field); field = '';
      } else if (char === '\r') {
        // ignorar
      } else if (char === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += char;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];

    const headers = rows[0].map(h => h.trim());
    return rows.slice(1)
      .filter(r => r.some(cell => cell.trim() !== ''))
      .map(r => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
        return obj;
      });
  }

  // --- Transforma una fila cruda del sheet en un producto listo para pintar ---
  function toProduct(row) {
    const precio = parseFloat(row['Precio']) || 0;
    const descuento = parseFloat(row['Descuento']) || 0;
    const precioFinal = descuento > 0 ? precio * (1 - descuento / 100) : precio;
    const [entero, decimales = '00'] = precioFinal.toFixed(2).split('.');

    return {
      id: row['id'] || row['Producto'] || '',
      nombre: row['Producto'] || '',
      descripcion: row['Descripcion'] || '', // opcional, si agregas esa columna
      imagen: row['Imagen'] || '',
      precioOriginal: precio,
      descuento,
      precioEntero: entero,
      precioDecimales: decimales,
      stock: row['Stock'],
    };
  }

  function productCardHTML(p) {
    const agotado = p.stock !== undefined && p.stock !== '' && Number(p.stock) === 0;

    const imagenHTML = p.imagen
      ? `<img src="${p.imagen}" height="100" weight="100" alt="${escapeHTML(p.nombre)}" loading="lazy">`
      : '';

    const descuentoHTML = p.descuento > 0
      ? `<span class="product-card__discount-badge">-${p.descuento}%</span>
         <span class="product-card__price-original">$${p.precioOriginal.toFixed(2)}</span>`
      : '';

    return `
      <article class="product-card${agotado ? ' product-card--agotado' : ''}" data-product-id="${escapeHTML(p.id)}">
        <div class="product-card__image">${imagenHTML}</div>
        <div class="product-card__info">
          <h2 class="product-card__name">${escapeHTML(p.nombre)}</h2>
          ${p.descripcion ? `<p class="product-card__description">${escapeHTML(p.descripcion)}</p>` : ''}
          <div class="product-card__footer">
            ${descuentoHTML}
            <p class="product-card__price">
              $${p.precioEntero}<span class="product-card__price-decimals">.${p.precioDecimales}</span>
            </p>
            <button class="product-card__button" data-action="ordenar" data-product-id="${escapeHTML(p.id)}" ${agotado ? 'disabled' : ''}>
              ${agotado ? 'Agotado' : 'Ordenar'}
            </button>
          </div>
        </div>
      </article>`;
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Carrito en localStorage ---
  function readCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const data = raw ? JSON.parse(raw) : [];
      return Array.isArray(data) ? data : Object.values(data || {});
    } catch (e) {
      return [];
    }
  }

  function findProduct(productId) {
    for (const sheetName in cache) {
      const found = cache[sheetName].data.find(p => p.id === productId);
      if (found) return found;
    }
    return null;
  }

  // Agrega el producto al carrito; si ya existe, suma 1 a la cantidad.
  // Guarda los mismos campos que lee carrito.js: precio (original) y
  // descuento (%) por separado; el precio final lo calcula el carrito.
  function addToCart(product) {
    const cart = readCart();
    const existing = cart.find(it => it.id === product.id);

    if (existing) {
      existing.cantidad = (parseInt(existing.cantidad, 10) || 0) + 1;
    } else {
      cart.push({
        id: product.id,
        nombre: product.nombre,
        precio: product.precioOriginal,
        descuento: product.descuento,
        imagen: product.imagen,
        cantidad: 1,
      });
    }

    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
      return true;
    } catch (e) {
      console.error('No se pudo guardar el carrito:', e);
      return false;
    }
  }

  function flashButton(btn, ok) {
    const original = btn.textContent;
    btn.textContent = ok ? 'Agregado ✓' : 'Error';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 900);
  }

  function render(products) {
    if (!products.length) {
      grid.innerHTML = '<p class="products__empty">No hay productos disponibles en esta categoría.</p>';
      return;
    }
    grid.innerHTML = products.map(productCardHTML).join('');
  }

  function renderLoading() {
    grid.innerHTML = '<p class="products__loading">Cargando productos…</p>';
  }

  function renderError() {
    grid.innerHTML = `<p class="products__error">
      No se pudieron cargar los productos. Verifica que la hoja de cálculo esté
      compartida como "Cualquier persona con el enlace puede ver".
    </p>`;
  }

  async function fetchCategory(categoryKey, { showLoading = true } = {}) {
    const sheetName = CATEGORY_SHEETS[categoryKey];
    if (!sheetName) return;

    if (showLoading && !cache[sheetName]) renderLoading();

    try {
      const res = await fetch(csvUrl(sheetName), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCSV(text);
      const productos = rows.map(toProduct).filter(p => p.nombre);

      cache[sheetName] = { data: productos, timestamp: Date.now() };

      if (currentCategory === categoryKey) render(productos);
    } catch (err) {
      console.error(`Error al cargar la categoría "${categoryKey}" (hoja "${sheetName}"):`, err);
      if (currentCategory === categoryKey && !cache[sheetName]) renderError();
    }
  }

  function selectCategory(categoryKey) {
    currentCategory = categoryKey;

    nav.querySelectorAll('.categories__item').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.category === categoryKey);
    });

    // Si ya teníamos datos en caché, los mostramos de inmediato
    // mientras se refresca en segundo plano.
    const sheetName = CATEGORY_SHEETS[categoryKey];
    if (cache[sheetName]) render(cache[sheetName].data);

    fetchCategory(categoryKey);

    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => fetchCategory(categoryKey, { showLoading: false }), REFRESH_MS);
  }

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.categories__item');
    if (!btn) return;
    selectCategory(btn.dataset.category);
  });

  // Botón "Ordenar": guarda el producto en el carrito (localStorage).
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="ordenar"]');
    if (!btn || btn.disabled) return;

    const productId = btn.dataset.productId;
    const product = findProduct(productId);
    if (!product) return;

    const ok = addToCart(product);
    flashButton(btn, ok);

    // Evento por si otra parte de la página (ej. un ícono de carrito) quiere reaccionar.
    document.dispatchEvent(new CustomEvent('menu:ordenar', { detail: { productId, product } }));
  });

  function init() {
    const activeBtn = nav.querySelector('.categories__item.is-active') || nav.querySelector('.categories__item');
    if (activeBtn) selectCategory(activeBtn.dataset.category);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();