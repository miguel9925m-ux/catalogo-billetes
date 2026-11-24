const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium, devices, webkit } = require("playwright");
const { PNG } = require("pngjs");
const decodeQR = require("jsqr");

const base = "https://miguel9925m-ux.github.io/catalogo-billetes/piloto/";
const qrFiles = {
  "bil-049": "qr-nepal.png",
  "bil-073": "qr-malta.png",
};
const rateUrl = "https://raw.githubusercontent.com/miguel9925m-ux/catalogo-billetes/main/piloto/assets/exchange-rates.json";

async function read(url) {
  let error;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const result = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
      if (result.ok) return result;
      error = new Error(url + " returned " + result.status);
    } catch (failure) { error = failure; }
    if (attempt < 11) await delay(5_000);
  }
  throw error;
}

async function waitForDeployment() {
  const assets = ["pilot-data.js", "atlas.js", "map-data.js", "atlas.css"];
  const stamp = content => createHash("sha256").update(content).digest("hex").slice(0, 12);
  const expected = await Promise.all(assets.map(async filename => stamp(await readFile("piloto/assets/" + filename))));
  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      const url = base + "?verification=" + Date.now();
      const page = await (await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_000) })).text();
      const wanted = assets.filter(name => name !== "map-data.js");
      if (wanted.every(name => page.includes(name + "?v=" + expected[assets.indexOf(name)]))) {
        const responses = await Promise.all(assets.map((name, index) =>
          fetch(base + "assets/" + name + "?v=" + expected[index], {
            cache: "no-store", signal: AbortSignal.timeout(6_000),
          })));
        if (responses.every(response => response.ok)) {
          const hashes = await Promise.all(responses.map(async response => stamp(Buffer.from(await response.arrayBuffer()))));
          if (hashes.every((hash, index) => hash === expected[index])) return;
        }
      }
    } catch {
      // Pages can still be publishing the commit.
    }
    await delay(5_000);
  }
  throw new Error("The deployed Atlas assets did not match this revision.");
}

async function scanCodes() {
  const urls = {};
  for (const [id, filename] of Object.entries(qrFiles)) {
    const response = await read(new URL(filename, base));
    const image = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
    const pixels = new Uint8ClampedArray(image.data);
    const code = decodeQR(pixels, image.width, image.height);
    assert.ok(code, "QR could not be decoded for " + id);
    const expected = new URL("billetes/" + id + "/", base).href;
    assert.equal(code.data, expected);
    urls[id] = code.data;
    console.log("QR " + id.toUpperCase() + " decoded to " + expected);
  }
  return urls;
}

async function heading(page, expected) {
  const title = page.getByRole("heading", { level: 1, name: expected, exact: true });
  await title.waitFor({ state: "visible" });
}

async function gallery(page) {
  for (const photo of await page.locator(".gallery img").all()) {
    await photo.evaluate(image => image.decode());
    assert.ok(await photo.evaluate(image => image.naturalWidth > 1000));
  }
  await page.getByRole("button", { name: "Ampliar reverso", exact: true }).click();
  await page.locator("#photo-viewer[open]").waitFor();
  await page.getByRole("button", { name: "Ampliar foto", exact: true }).click();
  assert.equal(await page.locator("#zoom-value").textContent(), "150%");
  await page.getByRole("button", { name: "Cerrar foto", exact: true }).click();
}

async function countryMap(page, country, regionTitle) {
  await page.getByRole("button", { name: "Ubicar " + country, exact: true }).click();
  await page.locator("#country-map[open]").waitFor();
  const highlighted = await page.locator("canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 39 && pixels[i + 1] === 116 && pixels[i + 2] === 82) count++;
    }
    return count;
  });
  assert.ok(highlighted > 100, country + " was not highlighted");
  const region = page.getByRole("button", { name: regionTitle, exact: true });
  await region.click();
  assert.equal(await region.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Cerrar mapa", exact: true }).click();
}

async function enter(page, url, title) {
  const response = await page.goto(url, { waitUntil: "load" });
  assert.equal(response.status(), 200, url);
  await heading(page, title);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function checkCatalogue(page) {
  await enter(page, base + "?lang=es", "Catálogo de billetes");
  const filter = page.getByRole("combobox", { name: "País o región", exact: true });
  assert.equal(await page.locator(".preview-entry:visible").count(), 77);
  assert.equal(await page.locator("#catalogue-count").textContent(), "77 billetes");
  await filter.selectOption("MLT");
  assert.equal(await page.locator(".preview-entry:visible").count(), 1);
  assert.equal(await page.locator("#catalogue-count").textContent(), "1 billete");
  assert.equal(new URL(page.url()).searchParams.get("pais"), "MLT");
  await page.getByRole("link", { name: /2 liras maltesas/ }).click();
  await heading(page, "2 liras maltesas");
  assert.equal(new URL(page.url()).searchParams.get("pais"), "MLT");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await heading(page, "2 Maltese liri");
  await page.getByRole("link", { name: "Back to catalogue", exact: true }).click();
  await heading(page, "Banknote catalogue");
  const english = page.getByRole("combobox", { name: "Country or region", exact: true });
  assert.equal(await english.inputValue(), "MLT");
  const namedFilter = english.locator("option[value=MLT]");
  assert.equal(await namedFilter.textContent(), "Malta");
  assert.equal(await page.locator(".preview-entry:visible").count(), 1);
  assert.equal(await page.locator("#catalogue-count").textContent(), "1 banknote");
  await english.selectOption("");
  assert.equal(await page.locator(".preview-entry:visible").count(), 77);
  assert.equal(new URL(page.url()).searchParams.has("pais"), false);
}

async function checkNewNotes(page, rates) {
  const notes = [
    ["bil-023", "100 baht tailandeses", "Tailandia", "Sudeste Asiático", "THB", 100, "1D8688485", false],
    ["bil-044", "5 dólares estadounidenses", "Estados Unidos", "América del Norte", "USD", 5, "PE44395568A", false],
    ["bil-046", "1.000 liras italianas", "Italia", "Mediterráneo occidental", "ITL", 1000, "HD 039183 H", true],
    ["bil-048", "500 rupias indias", "India", "Asia meridional", "INR", 500, "0SR 727538", true],
    ["bil-052", "1 ringgit malasio", "Malasia", "Sudeste Asiático", "MYR", 1, "BJ8243628", true],
  ];
  for (const [id, title, country, region, currency, faceValue, series, crop] of notes) {
    await enter(page, base + "billetes/" + id + "/?lang=es", title);
    assert.equal(await page.locator(".serial").textContent(), series);
    await gallery(page);
    if (crop) {
      assert.equal(await page.locator(".gallery img").evaluateAll(images => {
        return images.every(image => getComputedStyle(image).clipPath.startsWith("polygon"));
      }), true);
    }
    await countryMap(page, country, region);
    assert.ok(await page.locator(".references a[href^='https://']").count());
    if (currency === "ITL") {
      assert.equal(await page.locator("#currency").count(), 0);
      await page.getByRole("heading", { name: "Moneda histórica", exact: true }).waitFor();
      continue;
    }
    await page.waitForFunction(date => document.querySelector("#npr-date")?.dateTime === date, rates.npr.date);
    assert.equal(await page.locator("#currency").inputValue(), "COP");
    assert.equal(await page.locator('#currency option[value="' + currency + '"]').count(), 0);
    const quote = rates.npr.rates[currency];
    const nprAmount = faceValue * quote.sell / quote.unit;
    const nprPerUsd = rates.npr.rates.USD.sell / rates.npr.rates.USD.unit;
    const cop = (currency === "USD" ? faceValue : nprAmount / nprPerUsd) * rates.cop.copPerUsd;
    const expected = new Intl.NumberFormat("es-CO", {maximumFractionDigits: 0, useGrouping: true}).format(cop);
    assert.equal(await page.locator("#converted").textContent(), "≈ " + expected + " COP");
    assert.equal(await page.locator("#npr-source").isVisible(), currency !== "USD");
  }
}

function referenceURL(approved) {
  return new URL(approved.url ?? "assets/" + approved.file, base).href;
}

async function verifySample(page, image, approved, capture, label) {
  await image.evaluate(el => el.decode());
  const actual = await image.evaluate(el => ({
    url: el.src, width: el.naturalWidth, height: el.naturalHeight,
  }));
  const intended = referenceURL(approved);
  assert.equal(actual.url, intended, label + " returned to the collection photo");
  assert.equal(actual.width, approved.width, label + " width");
  assert.equal(actual.height, approved.height, label + " height");
  assert.ok(approved.sha256, label + " must have a visually approved source");
  const response = await capture.get(intended);
  assert.ok(response, label + " must return image data");
  const fileDigest = createHash("sha256").update(response.bytes).digest("hex");
  if (fileDigest !== approved.sha256) {
    assert.ok(approved.signature, label + " returned a different image file");
    const observed = await page.evaluate(async src => {
      const bitmap = new Image();
      bitmap.src = src;
      await bitmap.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 12;
      canvas.height = 8;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 12, 8);
      ctx.drawImage(bitmap, 0, 0, 12, 8);
      const values = ctx.getImageData(0, 0, 12, 8).data;
      let rgb = "";
      for (let i = 0; i < values.length; i += 4) {
        rgb += String.fromCharCode(values[i], values[i + 1], values[i + 2]);
      }
      return btoa(rgb);
    }, "data:" + response.type + ";base64," + response.bytes.toString("base64"));
    const expected = Buffer.from(approved.signature, "base64");
    const rendered = Buffer.from(observed, "base64");
    assert.equal(rendered.length, expected.length);
    const variation = rendered.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / expected.length;
    // Different browser codecs can produce small color differences.
    assert.ok(variation <= 7, label + " pixels differ from the approved image (" + variation.toFixed(1) + ")");
  }
  return fileDigest;
}

async function checkReference(page, profile) {
  const references = profile.images.reference;
  assert.equal(await page.locator(".photo-controls a").count(), references ? 1 : 0, profile.id);
  if (!references) return 0;

  const capture = new Map();
  const urls = new Set(Object.values(references).map(referenceURL));
  const receive = response => {
    let request = response.request();
    while (request.redirectedFrom()) request = request.redirectedFrom();
    if (!urls.has(request.url()) || !response.ok() || capture.has(request.url())) return;
    capture.set(request.url(), response.body().then(bytes => ({
      bytes, type: response.headers()["content-type"]?.split(";")[0] || "image/jpeg",
    })).catch(() => null));
  };
  page.on("response", receive);
  try {
    if (references.sheet) {
      await page.locator("#reference-sheet").click();
      await page.locator("#photo-viewer[open]").waitFor();
      await verifySample(page, page.locator("#viewer-photo"), references.sheet, capture, "both faces");
      await page.locator("#photo-viewer").getByRole("button", { name: "Cerrar foto", exact: true }).click();
      return 2;
    }

    const referenceButton = page.locator("[data-photo-mode=reference]");
    await referenceButton.click();
    await page.waitForFunction(() =>
      !document.querySelector("#photo-status").textContent.startsWith("Cargando"));
    const signatures = [];
    for (const side of ["front", "back"]) {
      const face = page.locator('[data-photo="' + side + '"] img');
      if (references[side]) {
        signatures.push(await verifySample(page, face, references[side], capture, side));
      } else {
        assert.ok((await face.getAttribute("src")).endsWith("/" + profile.images.original[side].file));
      }
    }
    assert.equal(new Set(signatures).size, signatures.length, "The same image was used for both faces");
    await page.locator("[data-photo-mode=original]").click();
    assert.equal(await referenceButton.getAttribute("aria-pressed"), "false", profile.id);
    return signatures.length;
  } finally {
    page.off("response", receive);
  }
}

async function checkExamples(page) {
  await enter(page, base + "billetes/bil-001/?lang=es", "20 pesos mexicanos");
  const profile = await page.evaluate(() => window.atlasNotes["BIL-001"]);
  assert.equal(await checkReference(page, profile), 2);
  const ref = page.getByRole("button", { name: "Muestra didáctica", exact: true });
  await ref.click();
  await page.waitForFunction(() => document.querySelector("[data-photo-mode=reference]").getAttribute("aria-pressed") === "true");
  await page.getByRole("button", { name: "Ampliar reverso", exact: true }).click();
  const enlarged = page.locator("#viewer-photo");
  await enlarged.evaluate(image => image.decode());
  assert.equal(await enlarged.getAttribute("src"), referenceURL(profile.images.reference.back));
  await page.getByRole("button", { name: "Ampliar foto", exact: true }).click();
  assert.equal(await page.locator("#zoom-value").textContent(), "150%");
  await page.getByRole("button", { name: "Cerrar foto", exact: true }).click();

  const referenceURLs = new Set(Object.values(profile.images.reference).map(referenceURL));
  const matchesSample = url => referenceURLs.has(url.href);
  const placeholder = new PNG({ width: 1280, height: 720 });
  placeholder.data.fill(65);
  const unexpectedArtwork = PNG.sync.write(placeholder);
  await page.route(matchesSample, route => route.fulfill({ contentType: "image/png", body: unexpectedArtwork }));
  try {
    await page.reload();
    await ref.click();
    await page.waitForFunction(() => document.querySelector("#photo-status").textContent.includes("no pudo cargarse"));
    assert.equal(await ref.getAttribute("aria-pressed"), "false");
    for (const side of ["front", "back"]) {
      const visible = page.locator('[data-photo="' + side + '"] img');
      assert.ok((await visible.getAttribute("src")).endsWith("/" + profile.images.original[side].file));
    }
    console.log("A replacement graphic at the same URLs was rejected and both collection photos remained visible.");
  } finally {
    await page.unroute(matchesSample);
  }

  await enter(page, base + "billetes/bil-007/?lang=es", "50 dinares serbios");
  await page.getByRole("button", { name: "Ubicar Serbia", exact: true }).click();
  const map = page.locator("#region-map");
  let label = await map.getAttribute("aria-label");
  assert.match(label, /Belgrado/);
  assert.match(label, /Ruman[ií]a/);
  assert.match(label, /Bulgaria/);
  assert.match(label, /Croacia|Bosnia y Herzegovina|Hungría/);
  console.log("Serbia map in Spanish → " + label);
  await page.getByRole("button", { name: "Cerrar mapa", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Locate Serbia", exact: true }).click();
  label = await map.getAttribute("aria-label");
  assert.match(label, /Belgrade/);
  assert.match(label, /Romania/);
  assert.match(label, /Bulgaria/);
  assert.match(label, /Croatia|Bosnia and Herzegovina|Hungary/);
  await page.getByRole("button", { name: "Close map", exact: true }).click();
  console.log("Mexican reference images load in-page. Serbia, Belgrade and nearby countries are labeled in both languages.");
}

async function checkEntireCollection(context, rates) {
  const home = await context.newPage();
  try {
    await enter(home, base + "?lang=es", "Catálogo de billetes");
    const links = await home.locator(".preview-entry").evaluateAll(cards => cards.map(card => card.href));
    assert.equal(links.length, 77);
    assert.equal(new Set(links).size, 77);
    assert.equal(await home.locator("#country-filter option").count(), 51);
    assert.equal(await home.locator("#catalogue-count").textContent(), "77 billetes");

    // Check the filter can return a group of distinct issues from a single country.
    await home.locator("#country-filter").selectOption("ARG");
    assert.equal(await home.locator(".preview-entry:visible").count(), 5);
    assert.equal(await home.locator("#catalogue-count").textContent(), "5 billetes");
    await home.locator("#country-filter").selectOption("GBR");
    assert.equal(await home.locator(".preview-entry:visible").count(), 3);

    const photoReview = { paired: 0, partial: 0, originalOnly: 0 };
    const failures = [];
    const pages = await Promise.all(Array.from({ length: 6 }, () => context.newPage()));
    try {
      for (let i = 0; i < links.length; i += pages.length) {
        await Promise.all(links.slice(i, i + pages.length).map(async (link, worker) => {
          const page = pages[worker];
          const address = new URL(link);
          address.searchParams.set("lang", "es");
          const id = address.pathname.match(/bil-[0-9]{3}/)[0].toUpperCase();
          let javascriptError = null;
          const listen = error => { javascriptError = error; };
          page.on("pageerror", listen);
          try {
            const response = await page.goto(address.href, { waitUntil: "load" });
            assert.equal(response.status(), 200, id);
            const profile = await page.evaluate(() => window.atlasNotes[document.body.dataset.noteId]);
            assert.equal(profile.id, id);
            await heading(page, profile.copy.es.noteTitle);
            assert.equal(await page.locator(".serial").textContent(), profile.serial, id);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), id + " horizontal overflow");
            const photos = await page.locator(".gallery img").evaluateAll(async images => {
              return Promise.all(images.map(async image => {
                await image.decode();
                return {width: image.naturalWidth, height: image.naturalHeight, clip: getComputedStyle(image).clipPath};
              }));
            });
            assert.equal(photos.length, 2, id);
            for (const [k, original] of Object.values(profile.images.original).entries()) {
              assert.equal(photos[k].width, original.width, id);
              assert.equal(photos[k].height, original.height, id);
              if (original.outline) assert.match(photos[k].clip, /^polygon/, id);
            }
            await page.locator("#find-country").click();
            await page.locator("#country-map[open]").waitFor();
            const mapReady = await page.locator("canvas").evaluate(canvas => {
              const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
              for (let p = 0; p < image.length; p += 4)
                if (image[p] === 39 && image[p + 1] === 116 && image[p + 2] === 82) return true;
              return false;
            });
            assert.ok(mapReady, id + " map highlight");
            await page.locator("[data-map-view=region]").click();
            const mapLabel = await page.locator("#region-map").getAttribute("aria-label");
            assert.match(mapLabel, /Lugares cercanos/, "Missing nearby labels: " + mapLabel);
            await page.getByRole("button", {name:"Cerrar mapa",exact:true}).click();
            const referenceFaces = await checkReference(page, profile);
            photoReview[referenceFaces === 2 ? "paired" : referenceFaces === 1 ? "partial" : "originalOnly"]++;
            if (profile.conversion === "historical") {
              assert.equal(await page.locator("#currency").count(), 0, id);
              assert.ok(await page.locator(".historical-panel p").textContent(), id);
            } else {
              assert.equal(await page.locator("#currency").inputValue(), "COP", id);
              const origin = profile.currency;
              const quoted = rates.npr.rates[origin];
              const inUsd = profile.conversion === "usd" ? profile.amount / rates.usd[origin].perUsd
                : origin === "USD" ? profile.amount
                : (profile.amount * (quoted ? quoted.sell / quoted.unit : 1)) / rates.npr.rates.USD.sell;
              const expected = new Intl.NumberFormat("es-CO", {maximumFractionDigits:0,useGrouping:true}).format(inUsd * rates.cop.copPerUsd);
              await page.waitForFunction(output => document.querySelector("#converted")?.textContent === output,
                "≈ " + expected + " COP", { timeout: 12_000 });
            }
            await page.getByRole("button", {name:"English",exact:true}).click();
            await heading(page, profile.copy.en.noteTitle);
            assert.equal(javascriptError, null, id);
          } catch (error) {
            failures.push(id + " " + error.message);
          } finally {
            page.off("pageerror", listen);
          }
        }));
      }
    } finally {
      await Promise.all(pages.map(page => page.close()));
    }
    console.log("Reference image coverage " + JSON.stringify(photoReview));
    assert.deepEqual(failures, []);
    console.log("All 77 published URLs, 154 original images, 50 filters, title translations, labeled maps, reference images and currency sections verified.");
  } finally {
    await home.close();
  }
}

async function checkBrowser(engine, device, urls, rates) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ ...devices[device], locale: "es-CO" });
    const page = await context.newPage();
    const errors = [];
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => errors.push(error.message));
    await enter(page, urls["bil-049"], "100 rupias nepalíes");
    await page.waitForFunction(date => document.querySelector("#npr-date")?.dateTime === date, rates.npr.date);
    assert.equal(await page.locator("#currency").inputValue(), "COP");
    const expected = 100 * rates.npr.rates.USD.unit * rates.cop.copPerUsd / rates.npr.rates.USD.sell;
    const formatted = new Intl.NumberFormat("es-CO", {maximumFractionDigits: 0, useGrouping: true}).format(expected);
    assert.equal(await page.locator("#converted").textContent(), "≈ " + formatted + " COP");
    await page.locator("#currency").selectOption("EUR");
    assert.match(await page.locator("#converted").textContent(), / EUR$/);
    await gallery(page);
    await page.getByRole("button", { name: "Muestra didáctica", exact: true }).click();
    await page.locator(".gallery .specimen-mark").first().waitFor();
    assert.equal(await page.locator(".gallery img").first().evaluate(async image => {
      await image.decode();
      return image.naturalWidth;
    }), 1182);
    await countryMap(page, "Nepal", "Asia meridional");
    await context.route("**/exchange-rates.json", request => request.abort());
    await page.reload();
    assert.equal(await page.locator("#rate-status").textContent(), "Última tasa disponible");
    assert.equal(await page.locator("#npr-date").getAttribute("datetime"), rates.npr.date);
    await context.unroute("**/exchange-rates.json");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await heading(page, "100 Nepalese rupees");
    await page.getByRole("link", { name: "Back to catalogue", exact: true }).click();
    await heading(page, "Banknote catalogue");
    assert.equal(await page.locator(".preview-entry").count(), 77);
    await page.getByRole("link", { name: /2 Maltese liri/ }).click();
    await heading(page, "2 Maltese liri");
    await page.getByRole("button", { name: "Español", exact: true }).click();
    await enter(page, urls["bil-073"], "2 liras maltesas");
    assert.match(await page.locator('[data-copy="yearDetail"]').textContent(), /1997–1999/);
    assert.equal(await page.locator(".serial").textContent(), "A/16 158527");
    assert.equal(await page.locator("#currency").count(), 0);
    await page.getByRole("heading", { name: "Moneda histórica" }).waitFor();
    assert.match(await page.getByRole("link", { name: /Banco Central Europeo · billetes en liras maltesas/ }).getAttribute("href"), /ecb\.europa\.eu/);
    await gallery(page);
    await countryMap(page, "Malta", "Mediterráneo central");
    await page.getByRole("link", { name: "Volver al catálogo", exact: true }).click();
    await heading(page, "Catálogo de billetes");
    await checkCatalogue(page);
    await checkNewNotes(page, rates);
    const results = await Promise.allSettled([
      checkExamples(page),
      device === "Pixel 7" ? checkEntireCollection(context, rates) : Promise.resolve(),
    ]);
    const failed = results.filter(result => result.status === "rejected");
    for (const result of failed) console.error(result.reason);
    assert.equal(failed.length, 0, device + " has failing checks");
    assert.deepEqual(errors, []);
    console.log(device + " passed catalogue navigation, both QR codes and the representative collection cases.");
  } finally {
    await browser.close();
  }
}

(async () => {
  await waitForDeployment();
  const urls = await scanCodes();
  const rates = await (await read(rateUrl)).json();
  const browsers = await Promise.allSettled([
    checkBrowser(chromium, "Pixel 7", urls, rates),
    checkBrowser(webkit, "iPhone 13", urls, rates),
  ]);
  for (const result of browsers) {
    if (result.status === "rejected") {
      console.error(result.reason);
      process.exitCode = 1;
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
