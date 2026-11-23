(() => {
  "use strict";

  const { atlasCopy, atlasNotes, atlasMap, atlasInitialRates } = window;
  const byId = id => document.getElementById(id);
  const note = atlasNotes[document.body.dataset.noteId];
  const portable = document.body.hasAttribute("data-portable");
  const preference = "atlas-de-billetes-language";
  const rateStorage = "atlas-de-billetes-rates-v2";
  const languageButtons = document.querySelectorAll("[data-language]");
  const languageLinks = document.querySelectorAll("[data-language-link]");
  const countryFilter = byId("country-filter");
  const catalogueCards = document.querySelectorAll("[data-catalogue-country]");
  const currency = byId("currency");
  const referenceCurrencies = note?.conversion === "usd"
    ? [...new Set([note.currency, "EUR", "GBP", "INR"])] : [];
  const map = byId("country-map");
  const canvas = byId("region-map");
  const viewer = byId("photo-viewer");
  const viewerPhoto = byId("viewer-photo");
  const viewerFrame = byId("viewer-frame");
  const viewport = document.querySelector(".image-viewport");
  const photoModes = document.querySelectorAll("[data-photo-mode]");
  const scaleButtons = document.querySelectorAll("[data-map-view]");
  const photos = [...document.querySelectorAll("[data-photo]")].map(button => {
    const image = button.querySelector("img");
    return { button, image, side: button.dataset.photo, originalSrc: image.src, frame: button.querySelector(".photo-window") };
  });

  const requestedCountry = new URLSearchParams(location.search).get("pais");
  const countries = new Set(Object.values(atlasNotes).map(entry => entry.map.highlight));
  let country = countries.has(requestedCountry) ? requestedCountry : "";
  let language = "es";
  let words;
  let photoMode = "original";
  let photoSide = "front";
  let mapView = "close";
  let zoom = 1;
  let rates = atlasInitialRates;
  let fromPublishedFile = false;

  function getLanguage() {
    const requested = new URLSearchParams(location.search).get("lang");
    if (Object.hasOwn(atlasCopy, requested)) return requested;
    try {
      const stored = localStorage.getItem(preference);
      if (Object.hasOwn(atlasCopy, stored)) return stored;
    } catch {
      // The URL also carries the language when browser storage is unavailable.
    }
    return "es";
  }

  function updateTitle() {
    const catalogue = !note || (portable && location.hash === "#catalogo");
    document.title = (catalogue ? words.homeTitle : words.noteTitle) + " · Atlas de Billetes";
  }

  function updateLinks() {
    for (const link of languageLinks) {
      if (link.getAttribute("href").startsWith("#")) continue;
      const url = new URL(link.href);
      url.searchParams.set("lang", language);
      if (country) url.searchParams.set("pais", country);
      else url.searchParams.delete("pais");
      link.href = url.href;
    }
  }

  function updateLocation() {
    const url = new URL(location.href);
    url.searchParams.set("lang", language);
    if (country) url.searchParams.set("pais", country);
    else url.searchParams.delete("pais");
    try { history.replaceState(null, "", url.href); } catch {}
  }

  function updateCatalogue() {
    if (!countryFilter) return;
    countryFilter.value = country;
    let visible = 0;
    for (const card of catalogueCards) {
      card.hidden = Boolean(country && card.dataset.catalogueCountry !== country);
      if (!card.hidden) visible++;
    }
    const label = visible === 1 ? words.oneBanknote : words.manyBanknotes;
    byId("catalogue-count").value = label.replace("{count}", visible);
  }

  function setLanguage(value, remember) {
    language = value;
    words = { ...atlasCopy[language], ...note?.copy[language] };
    document.documentElement.lang = language;
    for (const element of document.querySelectorAll("[data-copy]")) {
      element.textContent = words[element.dataset.copy];
    }
    for (const element of document.querySelectorAll("[data-label]")) {
      element.setAttribute("aria-label", words[element.dataset.label]);
    }
    for (const element of document.querySelectorAll("[data-alt]")) {
      element.alt = words[element.dataset.alt];
    }
    for (const title of document.querySelectorAll("[data-title-note]")) {
      title.textContent = atlasNotes[title.dataset.titleNote].copy[language].noteTitle;
    }
    for (const element of document.querySelectorAll("[data-country-note]")) {
      const copy = atlasNotes[element.dataset.countryNote].copy[language];
      element.textContent = element.tagName === "OPTION"
        ? (copy.filterCountry ?? copy.countryName) : copy.countryName;
    }
    if (countryFilter) {
      const options = [...countryFilter.querySelectorAll("[data-country-note]")];
      options.sort((first, second) => first.textContent.localeCompare(second.textContent, language));
      countryFilter.append(...options);
    }
    updateCatalogue();
    for (const button of languageButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    }
    updateLinks();
    if (remember) {
      try { localStorage.setItem(preference, language); } catch {}
      updateLocation();
    }
    updateTitle();
    if (viewer) byId("viewer-title").textContent = words[photoSide];
    if (currency) updateConversion();
    if (map?.open) drawMap();
  }

  function showPortablePage() {
    const showingCatalogue = location.hash === "#catalogo";
    byId("ficha").hidden = showingCatalogue;
    byId("catalogo").hidden = !showingCatalogue;
    document.querySelector(".skip-link").href = showingCatalogue ? "#catalogo" : "#ficha";
    updateTitle();
    window.scrollTo(0, 0);
  }

  function fitPhoto(frame, image, definition) {
    const { width, height, outline } = definition;
    const xs = outline?.map(([x]) => x) ?? [0, width];
    const ys = outline?.map(([, y]) => y) ?? [0, height];
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const croppedWidth = Math.max(...xs) - left;
    const croppedHeight = Math.max(...ys) - top;

    frame.style.aspectRatio = croppedWidth + " / " + croppedHeight;
    image.width = width;
    image.height = height;
    image.style.width = (width / croppedWidth * 100) + "%";
    image.style.left = (-left / croppedWidth * 100) + "%";
    image.style.top = (-top / croppedHeight * 100) + "%";
    image.style.clipPath = outline
      ? "polygon(" + outline.map(([x, y]) => (x / width * 100) + "% " + (y / height * 100) + "%").join(", ") + ")"
      : "none";
  }

  function showPhotos(mode) {
    photoMode = mode;
    const reference = mode === "reference";
    const credit = byId("reference-credit");
    if (credit) credit.hidden = !reference;
    for (const button of photoModes) {
      button.setAttribute("aria-pressed", String(button.dataset.photoMode === mode));
    }
    for (const { image, frame, side, originalSrc } of photos) {
      image.dataset.alt = side + (reference ? "ReferenceAlt" : "Alt");
      image.alt = words[image.dataset.alt];
      fitPhoto(frame, image, note.images[mode][side]);
      frame.querySelector(".specimen-mark").hidden = !reference;
      const url = reference ? new URL(image.dataset.reference, location.href).href : originalSrc;
      if (image.src !== url) image.src = url;
    }
  }

  function validRateSnapshot(snapshot) {
    const isDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value));
    const positive = value => Number.isFinite(value) && value > 0;
    const cop = snapshot?.cop;
    if (!isDate(cop?.validFrom) || !isDate(cop?.validThrough) ||
        cop.validFrom > cop.validThrough || !positive(cop.copPerUsd)) return false;
    if (note.conversion === "usd") {
      return referenceCurrencies.every(code =>
        isDate(snapshot.usd?.[code]?.date) && positive(snapshot.usd[code].perUsd));
    }
    const required = new Set(["EUR", "USD", "GBP", "INR"]);
    if (note.currency !== "NPR") required.add(note.currency);
    const npr = snapshot.npr;
    return isDate(npr?.date) &&
      [...required].every(code => positive(npr.rates?.[code]?.sell) && positive(npr.rates[code].unit));
  }

  function eligibleRates(snapshot) {
    if (!validRateSnapshot(snapshot) || snapshot.cop.validFrom < rates.cop.validFrom) return false;
    if (note.conversion === "usd") {
      return referenceCurrencies.every(code => snapshot.usd[code].date >= rates.usd[code].date);
    }
    return snapshot.npr.date >= rates.npr.date;
  }

  function todayIn(timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts();
    const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return fields.year + "-" + fields.month + "-" + fields.day;
  }

  function updateConversion() {
    const code = currency.value;
    const toCop = code === "COP";
    const usdToCop = note.currency === "USD" && toCop;
    const usdReference = note.conversion === "usd";
    const locale = language === "es" ? "es-CO" : "en-GB";
    const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    const readDate = value => format.format(new Date(value + "T00:00:00Z"));
    let amount;
    let currencyDateIsCurrent;

    if (usdReference) {
      const source = rates.usd[note.currency];
      const target = toCop || code === "USD" ? null : rates.usd[code];
      const amountUsd = note.amount / source.perUsd;
      amount = toCop ? amountUsd * rates.cop.copPerUsd : amountUsd * (target?.perUsd ?? 1);
      const sourceDate = target && target.date !== source.date
        ? note.currency + " " + readDate(source.date) + " · " + code + " " + readDate(target.date)
        : readDate(source.date);
      byId("reference-date").textContent = sourceDate;
      const utcToday = todayIn("UTC");
      currencyDateIsCurrent = source.date === utcToday && (!target || target.date === utcToday);
    } else {
      const source = rates.npr.rates[note.currency];
      const amountNpr = source ? note.amount * source.sell / source.unit : note.amount;
      const target = rates.npr.rates[toCop ? "USD" : code];
      const exchanged = amountNpr * target.unit / target.sell;
      amount = toCop ? (usdToCop ? note.amount : exchanged) * rates.cop.copPerUsd : exchanged;
      const sourceDate = byId("npr-date");
      sourceDate.dateTime = rates.npr.date;
      sourceDate.textContent = readDate(rates.npr.date);
      currencyDateIsCurrent = usdToCop || rates.npr.date === todayIn("Asia/Kathmandu");
    }
    const precision = toCop ? 0 : 2;
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits: precision, maximumFractionDigits: precision, useGrouping: true,
    }).format(amount);
    byId("converted").value = "≈ " + number + " " + code;
    byId("reference-source").hidden = !usdReference;
    byId("npr-source").hidden = usdToCop || usdReference;
    byId("cop-source").hidden = !toCop;
    const copToday = todayIn("America/Bogota");
    const copValid = rates.cop.validFrom <= copToday && copToday <= rates.cop.validThrough;
    const upToDate = fromPublishedFile && currencyDateIsCurrent && (!toCop || copValid);
    byId("rate-status").textContent = upToDate ? words.rateStatus : words.rateFallback;
    if (toCop) {
      const start = readDate(rates.cop.validFrom);
      byId("cop-date").textContent = rates.cop.validFrom === rates.cop.validThrough
        ? start
        : words.trmFrom.replace("{from}", start).replace("{through}", readDate(rates.cop.validThrough));
    }
  }

  async function loadPublishedRates() {
    if (!document.body.dataset.rateUrl || !["http:", "https:"].includes(location.protocol)) return;
    try {
      const saved = JSON.parse(localStorage.getItem(rateStorage));
      if (eligibleRates(saved)) rates = saved;
    } catch {}
    updateConversion();
    try {
      const response = await fetch(document.body.dataset.rateUrl, { cache: "no-cache" });
      if (!response.ok) return;
      const snapshot = await response.json();
      if (!eligibleRates(snapshot)) return;
      rates = snapshot;
      fromPublishedFile = true;
      updateConversion();
      try { localStorage.setItem(rateStorage, JSON.stringify(rates)); } catch {}
    } catch {
      // Keep the most recent validated snapshot and its source dates.
    }
  }

  function setMapView(value) {
    mapView = value;
    for (const button of scaleButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.mapView === mapView));
    }
    drawMap();
  }

  function drawMap() {
    const { width, height } = canvas.getBoundingClientRect();
    const density = Math.min(devicePixelRatio, 2);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    const ctx = canvas.getContext("2d");
    ctx.scale(density, density);

    const definition = note.map;
    const view = definition.views[mapView];
    const [west, east, south, north] = view.bounds;
    const project = ([lon, lat]) => [
      (lon - west) * width / (east - west),
      (north - lat) * height / (north - south),
    ];

    ctx.fillStyle = "#e3eeeb";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#cbdad2";
    ctx.lineWidth = 0.75;
    for (const lon of view.meridians) {
      const [x] = project([lon, south]);
      line(ctx, [x, 0], [x, height]);
    }
    for (const lat of view.parallels) {
      const [, y] = project([west, lat]);
      line(ctx, [0, y], [width, y]);
    }

    for (const code of definition.shapes) {
      const shape = atlasMap[code];
      const polygons = shape.type === "Polygon" ? [shape.coordinates] : shape.coordinates;
      ctx.beginPath();
      for (const polygon of polygons) {
        for (const ring of polygon) {
          ctx.moveTo(...project(ring[0]));
          for (const point of ring.slice(1)) ctx.lineTo(...project(point));
          ctx.closePath();
        }
      }
      const highlighted = code === definition.highlight;
      ctx.fillStyle = highlighted ? "#277452" : "#e9e8d9";
      ctx.strokeStyle = highlighted ? "#f7fff1" : "#abbbad";
      ctx.lineWidth = highlighted ? 1.5 : 0.8;
      ctx.fill("evenodd");
      ctx.stroke();
    }

    const labelSize = width < 430 ? 12 : 16;
    ctx.font = "600 " + labelSize + "px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#3e5d4d";
    for (const [label, lon, lat] of view.labels) ctx.fillText(words[label], ...project([lon, lat]));

    const anchor = project(view.anchor);
    const label = project(view.label);
    if (view.locator) {
      ctx.beginPath();
      ctx.arc(...anchor, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#277452";
      ctx.fill();
      ctx.strokeStyle = "#f7fff1";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.strokeStyle = "#1c4f38";
    ctx.lineWidth = 1.3;
    line(ctx, anchor, label);
    drawLabel(ctx, words.mapLabel ?? words.countryName, label, labelSize + 10, "#163c2d", "#ffffff");

    if (view.capitalLabel) {
      const city = project(definition.capital);
      const text = project(view.capitalLabel);
      ctx.strokeStyle = "#75432b";
      ctx.lineWidth = 1.15;
      line(ctx, city, text);
      point(ctx, city, 4.5, "#fffdfa");
      point(ctx, city, 2.8, "#a55021");
      drawLabel(ctx, words.mapCapital, text, labelSize + 4, "#fffdf5", "#75432b");
    }
  }

  function line(ctx, from, to) {
    ctx.beginPath();
    ctx.moveTo(...from);
    ctx.lineTo(...to);
    ctx.stroke();
  }

  function point(ctx, position, radius, fill) {
    ctx.beginPath();
    ctx.arc(...position, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawLabel(ctx, label, [x, y], height, background, foreground) {
    const width = ctx.measureText(label).width + 14;
    ctx.fillStyle = background;
    ctx.fillRect(x - width / 2, y - height / 2, width, height);
    ctx.fillStyle = foreground;
    ctx.fillText(label, x, y);
  }

  function applyZoom(next) {
    const left = (viewport.scrollLeft + viewport.clientWidth / 2) / zoom;
    const top = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
    zoom = next;
    viewerFrame.style.width = (zoom * 100) + "%";
    viewport.scrollTo({
      left: left * zoom - viewport.clientWidth / 2,
      top: top * zoom - viewport.clientHeight / 2,
    });
    byId("zoom-value").value = (zoom * 100) + "%";
    byId("zoom-out").disabled = zoom <= 1;
    byId("zoom-in").disabled = zoom >= 3;
  }

  setLanguage(getLanguage(), false);
  if (countryFilter) {
    byId("catalogue-controls").hidden = false;
    countryFilter.addEventListener("change", () => {
      country = countryFilter.value;
      updateCatalogue();
      updateLinks();
      updateLocation();
    });
  }
  for (const button of languageButtons) {
    button.addEventListener("click", () => setLanguage(button.dataset.language, true));
  }
  for (const frame of document.querySelectorAll("[data-home-photo]")) {
    fitPhoto(frame, frame.querySelector("img"), atlasNotes[frame.dataset.homePhoto].images.original.front);
  }

  if (note) {
    if (portable) {
      window.addEventListener("hashchange", showPortablePage);
      showPortablePage();
    }
    for (const button of photoModes) {
      button.addEventListener("click", () => showPhotos(button.dataset.photoMode));
    }
    showPhotos("original");
    byId("find-country").addEventListener("click", () => {
      map.showModal();
      setMapView("close");
    });
    for (const button of scaleButtons) {
      button.addEventListener("click", () => setMapView(button.dataset.mapView));
    }
    window.addEventListener("resize", () => { if (map.open) drawMap(); });
    for (const { button, side, image } of photos) {
      button.addEventListener("click", () => {
        photoSide = side;
        viewerPhoto.src = image.src;
        viewerPhoto.alt = image.alt;
        fitPhoto(viewerFrame, viewerPhoto, note.images[photoMode][side]);
        viewerFrame.querySelector(".specimen-mark").hidden = photoMode !== "reference";
        byId("viewer-title").textContent = words[side];
        viewer.showModal();
        applyZoom(1);
        viewport.scrollTo(0, 0);
      });
    }
    byId("zoom-out").addEventListener("click", () => applyZoom(Math.max(1, zoom - 0.5)));
    byId("zoom-in").addEventListener("click", () => applyZoom(Math.min(3, zoom + 0.5)));
    for (const button of document.querySelectorAll("[data-close-dialog]")) {
      button.addEventListener("click", () => button.closest("dialog").close());
    }
    if (currency) {
      currency.addEventListener("change", updateConversion);
      loadPublishedRates();
    }
  }
})();
