# Makes the site hero, README header and social card from the generated scene and the wordmark.
# Run from this directory: uv run --with pillow python compose.py
from PIL import Image, ImageOps

REPO = "../../../.."


def snap(im, threshold=235):
    """Near white becomes white, so the art multiplies cleanly onto the page's paper."""
    im = im.convert("RGB")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            if min(px[x, y]) >= threshold:
                px[x, y] = (255, 255, 255)
    return im


def trim(im):
    return im.crop(ImageOps.invert(im).getbbox())


def fit(im, width=None, height=None):
    scale = min((width or 1e9) / im.width, (height or 1e9) / im.height)
    return im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)


def quantize(im):
    # Octree keeps the saturated orange, red and blue; median cut muddies them.
    return im.quantize(colors=48, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)


def stacked(scene, mark, size, scene_width, mark_height, gap):
    """The scene with the wordmark and tagline centred under it, the pair centred on the canvas."""
    width, height = size
    canvas = Image.new("RGB", size, "white")
    scene, mark = fit(scene, width=scene_width), fit(mark, height=mark_height)
    top = (height - scene.height - gap - mark.height) // 2
    canvas.paste(scene, ((width - scene.width) // 2, top))
    canvas.paste(mark, ((width - mark.width) // 2, top + scene.height + gap))
    return quantize(canvas)


scene = trim(snap(Image.open("01-untangle-source.png")))
mark = trim(snap(Image.open("wordmark.png")))

margin = 40
hero = Image.new("RGB", (scene.width + 2 * margin, scene.height + 2 * margin), "white")
hero.paste(scene, (margin, margin))
quantize(hero).save(f"{REPO}/.github/readme/hero.png", optimize=True)

stacked(scene, mark, (1800, 900), 1680, 200, 30).save(
    f"{REPO}/.github/readme/header.png", optimize=True
)
stacked(scene, mark, (1200, 630), 1080, 190, 6).save(f"{REPO}/apps/site/og.png", optimize=True)
