'use strict';

const banknote = window.banknoteData;
const image = document.getElementById('foto-billete');
const frame = document.getElementById('ampliar');
const dialog = document.getElementById('visor');
const enlargedFrame = document.getElementById('marco-visor');
const enlargedImage = document.getElementById('foto-ampliada');
const viewState = { side: 'front', source: 'collection' };

document.querySelectorAll('[data-field]').forEach(element => {
  element.textContent = banknote[element.dataset.field] || element.textContent;
});

function describePhoto() {
  return viewState.source === 'collection'
    ? 'Fotografía de la pieza real, con giro, encuadre y luz ajustados para su presentación.'
    : 'Referencia oficial de la misma emisión, marcada SPECIMEN. Su numeración corresponde a una pieza de muestra.';
}

function refreshGallery() {
  const photo = banknote.images[viewState.source][viewState.side];
  const faceName = viewState.side === 'front' ? 'Anverso' : 'Reverso';
  const original = viewState.source === 'collection';
  image.src = photo;
  image.alt = faceName + (original ? ' del ejemplar de la colección.' : ' de la referencia oficial, marcada SPECIMEN.');
  frame.classList.toggle('raw-photo', original);
  frame.classList.toggle('reference-photo', !original);
  frame.setAttribute('aria-label', 'Ampliar ' + image.alt);
  document.getElementById('descripcion-cara').textContent = viewState.side === 'front'
    ? banknote.anverso_descripcion : banknote.reverso_descripcion;
  document.getElementById('nota-fotografia').textContent = describePhoto();
  document.querySelectorAll('[data-side]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.side === viewState.side));
  });
  document.querySelectorAll('[data-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.view === viewState.source));
  });
}

function openImage() {
  enlargedImage.src = image.src;
  enlargedImage.alt = image.alt;
  enlargedFrame.classList.toggle('raw-photo', viewState.source === 'collection');
  enlargedFrame.classList.toggle('reference-photo', viewState.source === 'reference');
  document.getElementById('titulo-visor').textContent =
    (viewState.side === 'front' ? 'Anverso' : 'Reverso') + ' · ' + banknote.id;
  document.getElementById('nota-visor').textContent = describePhoto();
  dialog.showModal();
}

document.querySelectorAll('[data-side]').forEach(button => {
  button.addEventListener('click', () => {
    viewState.side = button.dataset.side;
    refreshGallery();
  });
});
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => {
    viewState.source = button.dataset.view;
    refreshGallery();
  });
});
document.querySelectorAll('[data-focus-side]').forEach(button => {
  button.addEventListener('click', () => {
    viewState.side = button.dataset.focusSide;
    refreshGallery();
    openImage();
  });
});
frame.addEventListener('click', openImage);
document.getElementById('cerrar-visor').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});

const amountInput = document.getElementById('importe');
const currencyInput = document.getElementById('moneda');
const result = document.getElementById('resultado');
const rateStatus = document.getElementById('estado-cambio');
const retryButton = document.getElementById('reintentar');
const cacheKey = 'billetes-cambio-NPR-v1';
const supportedCurrencies = ['COP', 'EUR', 'USD', 'MXN'];
let exchange = null;

function validRates(data) {
  return data && data.result === 'success' && data.base_code === 'NPR'
    && Number.isFinite(data.time_last_update_unix)
    && supportedCurrencies.every(currency => Number.isFinite(data.rates?.[currency]) && data.rates[currency] > 0);
}

function renderConversion() {
  const amount = amountInput.valueAsNumber;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
    result.textContent = 'Revisa el importe';
    return;
  }
  if (!exchange) return;
  const target = currencyInput.value;
  result.textContent = new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: target, currencyDisplay: 'code',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount * exchange.rates[target]);
  const updated = new Date(exchange.time_last_update_unix * 1000);
  const formatted = new Intl.DateTimeFormat('es', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(updated);
  const old = Date.now() - updated.getTime() > 48 * 60 * 60 * 1000;
  rateStatus.textContent = (old ? 'Cotización guardada del ' : 'Cotización actualizada el ') + formatted + '.';
}

async function loadRates() {
  retryButton.hidden = true;
  rateStatus.textContent = 'Consultando la cotización disponible.';
  try {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { /* La consulta continúa sin caché. */ }
    if (validRates(cached) && Number.isFinite(cached.time_next_update_unix)
        && Date.now() < cached.time_next_update_unix * 1000) {
      exchange = cached;
    } else {
      const response = await fetch('https://open.er-api.com/v6/latest/NPR', {
        signal: AbortSignal.timeout(12000), credentials: 'omit',
      });
      if (!response.ok) throw new Error('La consulta de divisas no está disponible.');
      const data = await response.json();
      if (!validRates(data)) throw new Error('La respuesta de divisas no es válida.');
      exchange = data;
      try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* La conversión sigue disponible. */ }
    }
    renderConversion();
  } catch {
    result.textContent = 'Consulta no disponible';
    rateStatus.textContent = 'Comprueba tu conexión y vuelve a consultar la cotización.';
    retryButton.hidden = false;
  }
}

amountInput.addEventListener('input', renderConversion);
currencyInput.addEventListener('change', renderConversion);
retryButton.addEventListener('click', loadRates);
refreshGallery();
loadRates();
