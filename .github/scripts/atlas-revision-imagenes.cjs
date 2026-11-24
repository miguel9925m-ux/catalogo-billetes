const {chromium, devices} = require("playwright");
const {createHash} = require("node:crypto");
const {mkdir, readFile, writeFile} = require("node:fs/promises");
const {runInNewContext} = require("node:vm");
const base = "https://miguel9925m-ux.github.io/catalogo-billetes/piloto/";
const output = process.env.RUNNER_TEMP + "/atlas-samples";
const escape = value => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
const uri = (bytes,type) => "data:" + type + ";base64," + bytes.toString("base64");
const absolute = ref => ref.url || new URL("assets/" + ref.file,base).href;

function emit(label, bytes) {
  const value = bytes.toString("base64");
  for (let i=0;i<value.length;i+=5200) console.log("ATLAS_EXPORT",label,value.slice(i,i+5200));
}

async function inspect(page, note) {
  const refs = Object.entries(note.images.reference);
  const requested = new Set(refs.map(([,ref]) => new URL(absolute(ref)).href));
  const responses = new Map();
  page.on("response", response => {
    let request = response.request();
    while (request.redirectedFrom()) request = request.redirectedFrom();
    if (!requested.has(request.url()) || !response.ok() || responses.has(request.url())) return;
    responses.set(request.url(), response.body().then(bytes => ({
      bytes, type:response.headers()["content-type"]?.split(";")[0] || "image/jpeg",
    })).catch(() => null));
  });
  await page.goto(base + "billetes/" + note.id.toLowerCase() + "/?lang=es", {waitUntil:"domcontentloaded"});
  await page.locator(note.images.reference.sheet?"#reference-sheet":"[data-photo-mode=reference]").click();
  await page.waitForFunction(() => {
    const status = document.querySelector("#photo-status");
    return status && !status.textContent.startsWith("Cargando");
  },null,{timeout:17000}).catch(() => {});
  const assets = [];
  for (const [side,ref] of refs) {
    const expected = new URL(absolute(ref)).href;
    const target = side==="sheet" ? "#photo-viewer[open] #viewer-photo" : '[data-photo="' + side + '"] img';
    const shown = await page.locator(target).evaluateAll(elements => {
      const img = elements[0];
      return img ? {url:img.src,width:img.naturalWidth,height:img.naturalHeight} : {};
    });
    const received = shown.url===expected ? await responses.get(expected) : null;
    assets.push({
      side, expected, ...shown,
      image:received && uri(received.bytes,received.type),
      sha256:received && createHash("sha256").update(received.bytes).digest("hex"),
    });
  }
  return assets;
}

async function renderBoard(browser, group, index) {
  const page = await browser.newPage({viewport:{width:835,height:920}});
  try {
    const rows = [];
    for (const {note,assets,error} of group) {
      const key = (ref) => note.id + "-" + ref.side;
      const first = assets.find(asset => asset.side==="front" || asset.side==="sheet");
      const back = assets.find(asset=>asset.side==="back");
      const figure = (name,src,key) => '<figure>'+(src?
        '<img src="' + src + '" data-key="' + key + '">':
        '<div class="empty">—</div>')+'<figcaption>'+escape(name)+'</figcaption></figure>';
      const originals = await Promise.all(["front","back"].map(side => readFile("piloto/assets/"+note.images.original[side].file)));
      rows.push('<section><header><b>' + note.id + '</b><br>' + escape(note.copy.es.noteTitle) +
       (error?'<br><small>'+escape(error.slice(0,100))+'</small>':'') + '</header>' +
       figure("Anverso original",uri(originals[0],"image/jpeg"),note.id+"-original-front") +
       figure("Reverso original",uri(originals[1],"image/jpeg"),note.id+"-original-back") +
       figure(first?.side==="sheet"?"Lámina":first?.image?"Muestra anverso":"Anverso sin muestra",first?.image,first&&key(first)) +
       figure(back?.image?"Muestra reverso":first?.side==="sheet"?"En la lámina":"Reverso sin muestra",back?.image,back&&key(back)) +
       '</section>');
    }
    await page.setContent('<meta charset="utf-8"><style>body{margin:0;font:13px Arial;color:#192b24;background:#f7f7f1}'+
      'section{display:grid;grid-template-columns:110px repeat(4,1fr);gap:7px;padding:7px 9px;border-bottom:1px solid #c9d0c7}'+
      'header{align-self:center}small{color:#9b2525}figure{margin:0;text-align:center}'+
      'img,.empty{display:block;width:100%;height:91px;object-fit:contain;background:white}'+
      '.empty{display:grid;place-items:center;color:#68786c}figcaption{font-size:11px;margin-top:3px}</style>'+rows.join(""),
      {waitUntil:"load"});
    const signatures = await page.locator("img[data-key]").evaluateAll(images => {
      const canvas = document.createElement("canvas");
      canvas.width=12; canvas.height=8;
      const ctx=canvas.getContext("2d");
      const signatures={};
      for (const img of images) {
        if (!img.naturalWidth) continue;
        ctx.fillStyle="#fff"; ctx.fillRect(0,0,12,8); ctx.drawImage(img,0,0,12,8);
        const pixels=ctx.getImageData(0,0,12,8).data;
        let rgb="";
        for (let i=0;i<pixels.length;i+=4) rgb+=String.fromCharCode(pixels[i],pixels[i+1],pixels[i+2]);
        signatures[img.dataset.key]=btoa(rgb);
      }
      return signatures;
    });
    const bytes = await page.screenshot({type:"jpeg",quality:65,fullPage:true});
    await writeFile(output+"/board-"+index+".jpg",bytes);
    emit("board-"+index,bytes);
    return signatures;
  } finally { await page.close(); }
}

(async () => {
  await mkdir(output,{recursive:true});
  const sandbox={window:{}};
  runInNewContext(await readFile("piloto/assets/pilot-data.js","utf8"),sandbox);
  const notes=Object.values(sandbox.window.atlasNotes).filter(note=>note.images.reference);
  const browser=await chromium.launch();
  try {
    const phone=await browser.newContext({...devices["Pixel 7"],locale:"es-CO"});
    const findings=new Array(notes.length);
    let cursor=0;
    await Promise.all(Array.from({length:7},async()=>{
      for (let i=cursor++;i<notes.length;i=cursor++){
        const note=notes[i];
        const page=await phone.newPage();
        page.setDefaultTimeout(22000);
        try {findings[i]={note,assets:await inspect(page,note)};}
        catch(error){findings[i]={note,assets:[],error:error.message};}
        finally{await page.close();}
      }
    }));
    const signatures={};
    for(let i=0;i<findings.length;i+=8)
      Object.assign(signatures,await renderBoard(browser,findings.slice(i,i+8),i/8+1));
    const reports=Object.fromEntries(findings.map(({note,assets,error})=>[note.id,{
      error,assets:assets.map(({image,...asset})=>({...asset,signature:signatures[note.id+"-"+asset.side]})),
    }]));
    const bytes=Buffer.from(JSON.stringify(reports));
    await writeFile(output+"/observed.json",bytes); emit("observed",bytes);
    console.log("Inspected " + notes.length + " reference galleries");
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
