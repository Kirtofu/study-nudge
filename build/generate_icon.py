from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024
ACCENT = "#C96442"
ACCENT_STRONG = "#AA4E31"
SURFACE = "#FAF9F5"


def rounded_square_layer(box: tuple[int, int, int, int], radius: int, fill: str) -> Image.Image:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box, radius=radius, fill=fill)
    return layer


def build_icon() -> Image.Image:
    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    shadow = rounded_square_layer((76, 90, 948, 962), 220, "#33241F")
    shadow.putalpha(shadow.getchannel("A").filter(ImageFilter.GaussianBlur(28)).point(lambda a: int(a * 0.22)))
    icon.alpha_composite(shadow)

    rim = rounded_square_layer((56, 56, 968, 968), 228, ACCENT_STRONG)
    icon.alpha_composite(rim)
    face = rounded_square_layer((76, 72, 948, 944), 210, ACCENT)
    icon.alpha_composite(face)

    draw = ImageDraw.Draw(icon)
    check_points = [(238, 518), (430, 698), (776, 330)]
    draw.line(check_points, fill=SURFACE, width=112, joint="curve")
    for point in check_points:
        x, y = point
        draw.ellipse((x - 56, y - 56, x + 56, y + 56), fill=SURFACE)

    # One restrained ink dot keeps the mark recognizable as Nudge at larger sizes.
    draw.ellipse((744, 690, 820, 766), fill="#F4DFD6")
    return icon


if __name__ == "__main__":
    output_directory = Path(__file__).resolve().parent
    icon = build_icon()
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(output_directory / "icon.png", optimize=True)
    icon.save(
        output_directory / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
