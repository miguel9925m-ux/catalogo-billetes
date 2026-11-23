const assert = require("node:assert/strict");
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
  const filter = page.getByRole("combobox", { name: "País", exact: true });
  assert.equal(await page.locator(".preview-entry:visible").count(), 7);
  assert.equal(await page.locator("#catalogue-count").textContent(), "7 billetes");
  await filter.selectOption("THA");
  assert.equal(await page.locator(".preview-entry:visible").count(), 1);
  assert.equal(await page.locator("#catalogue-count").textContent(), "1 billete");
  assert.equal(new URL(page.url()).searchParams.get("pais"), "THA");
  await page.getByRole("link", { name: /100 baht tailandeses/ }).click();
  await heading(page, "100 baht tailandeses");
  assert.equal(new URL(page.url()).searchParams.get("pais"), "THA");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await heading(page, "100 Thai baht");
  await page.getByRole("link", { name: "Back to catalogue", exact: true }).click();
  await heading(page, "Banknote catalogue");
  const english = page.getByRole("combobox", { name: "Country", exact: true });
  assert.equal(await english.inputValue(), "THA");
  const namedFilter = english.locator("option[value=THA]");
  assert.equal(await namedFilter.textContent(), "Thailand");
  assert.equal(await page.locator(".preview-entry:visible").count(), 1);
  assert.equal(await page.locator("#catalogue-count").textContent(), "1 banknote");
  await english.selectOption("");
  assert.equal(await page.locator(".preview-entry:visible").count(), 7);
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
    await page.locator("a.reference-link[href^='https://']").waitFor();
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
    await page.getByRole("button", { name: "Muestra oficial", exact: true }).click();
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
    assert.equal(await page.locator(".preview-entry").count(), 7);
    await page.getByRole("link", { name: /2 Maltese liri/ }).click();
    await heading(page, "2 Maltese liri");
    await page.getByRole("button", { name: "Español", exact: true }).click();
    await enter(page, urls["bil-073"], "2 liras maltesas");
    assert.match(await page.locator('[data-copy="yearDetail"]').textContent(), /1997–1999/);
    assert.equal(await page.locator(".serial").textContent(), "A/16 158527");
    assert.equal(await page.locator("#currency").count(), 0);
    await page.getByRole("heading", { name: "Moneda histórica" }).waitFor();
    assert.match(await page.getByRole("link", { name: /imágenes de referencia del BCE/ }).getAttribute("href"), /ecb\.europa\.eu/);
    await gallery(page);
    await countryMap(page, "Malta", "Mediterráneo central");
    await page.getByRole("link", { name: "Volver al catálogo", exact: true }).click();
    await heading(page, "Catálogo de billetes");
    await checkCatalogue(page);
    await checkNewNotes(page, rates);
    assert.deepEqual(errors, []);
    console.log(device + " passed for the country filter, all seven notes and both QR codes.");
  } finally {
    await browser.close();
  }
}

(async () => {
  const urls = await scanCodes();
  const rates = await (await read(rateUrl)).json();
  await Promise.all([
    checkBrowser(chromium, "Pixel 7", urls, rates),
    checkBrowser(webkit, "iPhone 13", urls, rates),
  ]);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
