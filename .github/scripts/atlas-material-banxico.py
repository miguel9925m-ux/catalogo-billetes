import base64
from io import BytesIO
from pathlib import Path
import sys

import fitz
from PIL import Image

folder = Path(sys.argv[1])
doc = fitz.open(folder / "banxico.pdf")
assert doc.page_count == 1
page = doc[0]

def export(tag, pix):
    img = Image.open(BytesIO(pix.tobytes("png")))
    target = folder / (tag + ".jpg")
    img.convert("RGB").save(target, "JPEG", quality=86, optimize=True)
    data = base64.b64encode(target.read_bytes()).decode("ascii")
    for start in range(0, len(data), 5200):
        print("ATLAS_EXPORT", tag, data[start:start+5200])

images = page.get_image_info(xrefs=True)
print("PAGE", list(page.rect))
for metadata in images:
    print("PICTURE", metadata["bbox"], metadata["width"], metadata["height"], metadata["xref"])
export("banxico-page", page.get_pixmap(matrix=fitz.Matrix(1.4,1.4),alpha=False))

for label, ratio in (("banxico-front",120/65),("banxico-back",65/120)):
    boxes = [fitz.Rect(x["bbox"]) for x in images]
    boxes = [b for b in boxes if b.get_area() > 4000 and .88*ratio < b.width/b.height < 1.12*ratio]
    if not boxes:
        print("NO_PAGE_IMAGE_MATCH", label)
        continue
    box = max(boxes,key=lambda b:b.get_area())
    factor = max(2.0,1000/max(box.width,box.height))
    pix = page.get_pixmap(matrix=fitz.Matrix(factor,factor),clip=box,alpha=False)
    print("EXTRACTED",label,pix.width,pix.height)
    export(label,pix)
