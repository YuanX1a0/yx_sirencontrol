"""Render the actual OBJ triangles for scale/geometry review, not a GTA screenshot."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(__file__).resolve().parent / 'build'
COLORS = {
    ('yx_movia_d_red', 0): (22, 24, 28, 255),
    ('yx_movia_d_red', 1): (43, 47, 54, 255),
    ('yx_movia_d_red', 2): (174, 183, 197, 255),
    ('yx_movia_d_red', 3): (88, 20, 21, 255),
    ('yx_movia_d_red', 4): (214, 13, 21, 145),
    ('yx_movia_d_red_glow', 0): (255, 75, 48, 255),
}
FONT = Path('C:/Windows/Fonts/segoeui.ttf')
FONT_BOLD = Path('C:/Windows/Fonts/seguisb.ttf')
image = Image.new('RGB', (1200, 860), (17, 22, 30))
draw = ImageDraw.Draw(image)
draw.text((38, 24), 'MOVIA-D STYLE  /  RED LED', font=ImageFont.truetype(str(FONT_BOLD), 30), fill=(237, 239, 242))
draw.text((40, 67), 'Original compact magnetic beacon mesh  |  fixed LED optics  |  no rotating reflector',
          font=ImageFont.truetype(str(FONT), 17), fill=(152, 164, 181))

triangles = []
for name in ('yx_movia_d_red', 'yx_movia_d_red_glow'):
    vertices, material = [], 0
    for line in (BUILD / f'{name}.obj').read_text().splitlines():
        if line.startswith('o '):
            material = int(line.rsplit('_', 1)[1])
        elif line.startswith('v '):
            vertices.append(tuple(map(float, line.split()[1:])))
        elif line.startswith('f '):
            points = [vertices[int(i)-1] for i in line.split()[1:]]
            triangles.append((points, COLORS[name, material], name, material))

def render(center, scale, azimuth=-52, elevation=17, on=False, cutaway=False):
    azimuth, elevation = math.radians(azimuth), math.radians(elevation)
    def camera(v):
        x, y, z = v
        a = x*math.cos(azimuth)-y*math.sin(azimuth)
        b = x*math.sin(azimuth)+y*math.cos(azimuth)
        return (a, z*math.cos(elevation)+b*math.sin(elevation),
                -b*math.cos(elevation)+z*math.sin(elevation))
    faces = []
    for points, color, name, material in triangles:
        if name.endswith('_glow') and not on:
            continue
        if cutaway and material == 4 and name == 'yx_movia_d_red':
            continue
        transformed = [camera(v) for v in points]
        a,b,c=transformed
        u,v=[b[i]-a[i] for i in range(3)],[c[i]-a[i] for i in range(3)]
        normal=(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])
        if normal[2] < -1e-12:
            continue
        length=math.sqrt(sum(n*n for n in normal)) or 1
        brightness=.46+.54*max(0,(normal[0]*-.4+normal[1]*.65+normal[2]*.64)/length)
        if name.endswith('_glow'):
            brightness=1
        shade=tuple(min(255,round(c*brightness)) for c in color[:3])+(color[3],)
        faces.append((sum(v[2] for v in transformed)/3,transformed,shade,name.endswith('_glow')))
    painter=ImageDraw.Draw(image,'RGBA')
    glass_layer=Image.new('RGBA',image.size,(0,0,0,0))
    glass_painter=ImageDraw.Draw(glass_layer)
    for depth, points, color, is_glow in sorted(faces,key=lambda f:f[0]):
        if is_glow:
            continue
        target=glass_painter if color[3]<255 else painter
        target.polygon([(center[0]+x*scale,center[1]-y*scale) for x,y,z in points],fill=color)
    image.paste(glass_layer,(0,0),glass_layer)
    # New glow sectors are outside the glass; do not blend the cover over them.
    for depth, points, color, is_glow in sorted(faces,key=lambda f:f[0]):
        if is_glow:
            painter.polygon([(center[0]+x*scale,center[1]-y*scale) for x,y,z in points],fill=color)

draw.rounded_rectangle((30, 110, 767, 735), radius=14, fill=(25, 31, 42))
draw.ellipse((161, 627, 645, 698), fill=(12, 16, 23))
render((400,650),3300,on=False)
draw=ImageDraw.Draw(image)
small=ImageFont.truetype(str(FONT),17)
tiny=ImageFont.truetype(str(FONT),14)
draw.text((60, 133), 'RED LENS / LIGHTS OFF',font=small,fill=(183,195,210))
draw.line((688,177,688,650),fill=(152,164,181),width=2)
for y in (177,650): draw.line((679,y,697,y),fill=(152,164,181),width=2)
draw.text((702,403),'142',font=small,fill=(222,226,233))
draw.text((702,425),'mm',font=tiny,fill=(152,164,181))
draw.line((188,710,612,710),fill=(152,164,181),width=2)
for x in (188,612): draw.line((x,703,x,717),fill=(152,164,181),width=2)
draw.text((348,683),'128 mm',font=small,fill=(222,226,233))

draw.rounded_rectangle((790,110,1170,400),radius=14,fill=(25,31,42))
draw.text((815,132),'FLASH ON / OUTER OPTICAL BANDS',font=tiny,fill=(183,195,210))
render((980,365),1350,on=True)
draw=ImageDraw.Draw(image)
draw.text((815,374),'Fixed emissive surfaces outside the cover',font=tiny,fill=(152,164,181))

draw.rounded_rectangle((790,420,1170,735),radius=14,fill=(25,31,42))
draw.text((815,441),'SAME SCALE AS AN 18 cm HAND',font=tiny,fill=(183,195,210))
# Schematic hand is a declared scale guide, not an anatomical animation preview.
# The hand silhouette spans 180 mm vertically; the beacon uses the same 1050px/m.
outline=[(0,0),(-.026,.008),(-.044,.051),(-.063,.074),(-.060,.090),(-.049,.093),
         (-.030,.076),(-.034,.136),(-.030,.164),(-.020,.163),(-.018,.108),
         (-.014,.178),(-.004,.180),(.001,.171),(.001,.112),(.008,.168),
         (.018,.167),(.020,.156),(.017,.107),(.026,.143),(.036,.140),
         (.037,.122),(.036,.072),(.027,.022),(.020,0)]
draw.polygon([(898+x*1050,697-z*1050) for x,z in outline],fill=(59,71,89),outline=(137,153,176))
render((1063,697),1050,azimuth=0,elevation=0,on=False)
draw=ImageDraw.Draw(image)
draw.text((820,709),'Schematic reference; actual game size is metres.',font=ImageFont.truetype(str(FONT),12),fill=(152,164,181))
draw.text((40,770),'Geometry preview from the shipped model source. This is not a GTA V screenshot.',font=small,fill=(188,198,213))
draw.text((40,800),'Polycarbonate lens, moulded grip ribs, black base and three magnetic contacts. Game glass/bloom may differ.',
          font=ImageFont.truetype(str(FONT),15),fill=(137,153,176))
target=ROOT/'docs'/'beacon-preview.png'
image.save(target)
print(target)
