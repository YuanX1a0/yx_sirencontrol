"""Generate an original compact MOVIA-D-style red LED beacon as CodeWalker XML.

No game or third-party artwork is copied. Units are metres; Z is up.
"""
from pathlib import Path
import json
import math
import struct
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent / 'build'
OUT.mkdir(exist_ok=True)


def node(parent, tag, text=None, **attrs):
    result = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        result.text = str(text)
    return result


def vec(parent, tag, p):
    return node(parent, tag, x=p[0], y=p[1], z=p[2])


def dds(name, rgba):
    # Uncompressed BGRA8 DDS with a single 4x4 mip, supported by CodeWalker.
    header = [124, 0x100F, 4, 4, 16, 0, 1] + [0] * 11
    header += [32, 0x41, 0, 32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000]
    header += [0x1000, 0, 0, 0, 0]
    r, g, b, a = rgba
    (OUT / (name + '.dds')).write_bytes(b'DDS ' + struct.pack('<31I', *header) + bytes((b, g, r, a)) * 16)


COLORS = {
    'yx_movia_rubber': (20, 22, 25, 255),
    'yx_movia_housing': (38, 41, 45, 255),
    'yx_movia_metal': (155, 164, 174, 255),
    'yx_movia_red_lens': (208, 10, 15, 145),
    'yx_movia_normal': (128, 128, 255, 255),
    'yx_movia_led_off': (83, 17, 18, 255),
    'yx_movia_glow_on': (255, 45, 28, 255),
}
for name, color in COLORS.items():
    dds(name, color)


class Mesh:
    def __init__(self, shader):
        self.shader, self.vertices, self.indices, self.lookup = shader, [], [], {}

    def tri(self, a, b, c, normals=None):
        if normals is None:
            u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            n = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
            length = math.sqrt(sum(x*x for x in n))
            if length < 1e-12:
                return
            normals = [tuple(x/length for x in n)] * 3
        for p, n in zip((a, b, c), normals):
            vertex = (*p, *n, 255, 255, 255, 255, .5, .5, 1, 0, 0, 1)
            key = tuple(round(v, 9) for v in vertex)
            if key not in self.lookup:
                self.lookup[key] = len(self.vertices)
                self.vertices.append(vertex)
            self.indices.append(self.lookup[key])

    def lathe(self, profile, segments=64, start=0, end=2*math.pi, offset=(0, 0, 0)):
        for (r0, z0), (r1, z1) in zip(profile, profile[1:]):
            dr, dz = r1-r0, z1-z0
            length = math.sqrt(dr*dr+dz*dz)
            if length < 1e-12:
                continue
            for i in range(segments):
                a, b = start+(end-start)*i/segments, start+(end-start)*(i+1)/segments
                ox, oy, oz = offset
                p0, p1 = (ox+r0*math.cos(a), oy+r0*math.sin(a), oz+z0), (ox+r0*math.cos(b), oy+r0*math.sin(b), oz+z0)
                p2, p3 = (ox+r1*math.cos(b), oy+r1*math.sin(b), oz+z1), (ox+r1*math.cos(a), oy+r1*math.sin(a), oz+z1)
                na, nb = (dz*math.cos(a)/length,dz*math.sin(a)/length,-dr/length), (dz*math.cos(b)/length,dz*math.sin(b)/length,-dr/length)
                self.tri(p0, p1, p2, (na,nb,nb))
                self.tri(p0, p2, p3, (na,nb,na))

    def radial_disc(self, angle, radius, z, disc_radius, depth, segments=12):
        # Small outward-facing optical cup/LED; fixed to the interior carrier.
        radial = (math.cos(angle), math.sin(angle), 0)
        tangent = (-math.sin(angle), math.cos(angle), 0)
        center = (radial[0]*radius, radial[1]*radius, z)
        def p(theta, r, d):
            return tuple(center[i]+radial[i]*d+tangent[i]*math.cos(theta)*r+(math.sin(theta)*r if i==2 else 0) for i in range(3))
        for i in range(segments):
            a, b = 2*math.pi*i/segments, 2*math.pi*(i+1)/segments
            tip = p(0,0,depth)
            self.tri(tip,p(a,disc_radius,depth),p(b,disc_radius,depth))
            self.tri(p(a,disc_radius*.8,0),p(b,disc_radius*.8,0),p(b,disc_radius,depth))
            self.tri(p(a,disc_radius*.8,0),p(b,disc_radius,depth),p(a,disc_radius,depth))


def shader_xml(parent, kind, texture):
    s = node(parent, 'Item')
    node(s, 'Name', kind)
    node(s, 'FileName', kind + '.sps')
    node(s, 'RenderBucket', value=1 if kind == 'glass' else 0)
    params = node(s, 'Parameters')
    node(node(params, 'Item', name='DiffuseSampler', type='Texture'), 'Name', texture)
    if kind == 'glass':
        node(node(params, 'Item', name='BumpSampler', type='Texture'), 'Name', 'yx_movia_normal')
        node(params, 'Item', name='EnvironmentSampler', type='Texture')
        values = {'specularFresnel': (0.96, 0, 0, 0), 'specularFalloffMult': (120, 0, 0, 0),
                  'specularIntensityMult': (.7, 0, 0, 0), 'bumpiness': (0, 0, 0, 0),
                  'reflectivePower': (.12, 0, 0, 0), 'useTessellation': (0, 0, 0, 0)}
    else:
        values = {'useTessellation': (0, 0, 0, 0),
                  'HardAlphaBlend': (1, 0, 0, 0), 'matMaterialColorScale': (1, 0, 0, 1),
                  'globalAnimUV0': (1, 0, 0, 0), 'globalAnimUV1': (0, 1, 0, 0)}
        if kind == 'emissive':
            values['emissiveMultiplier'] = (35, 0, 0, 0)
        else:
            values['wetnessMultiplier'] = (.4, 0, 0, 0)
    for name, v in values.items():
        node(params, 'Item', name=name, type='Vector', x=v[0], y=v[1], z=v[2], w=v[3])


def write_drawable(name, meshes, materials):
    vertices = [v for m in meshes for v in m.vertices]
    minimum = tuple(min(v[i] for v in vertices) for i in range(3))
    maximum = tuple(max(v[i] for v in vertices) for i in range(3))
    center = tuple((minimum[i]+maximum[i])/2 for i in range(3))
    radius = max(math.sqrt(sum((v[i]-center[i])**2 for i in range(3))) for v in vertices)
    root = ET.Element('Drawable')
    node(root, 'Name', name)
    vec(root, 'BoundingSphereCenter', center)
    node(root, 'BoundingSphereRadius', value=radius)
    vec(root, 'BoundingBoxMin', minimum)
    vec(root, 'BoundingBoxMax', maximum)
    for lod in ('High', 'Med', 'Low', 'Vlow'):
        node(root, 'LodDist'+lod, value=120)
        node(root, 'Flags'+lod, value=1 if lod == 'High' else 0)
    sg = node(root, 'ShaderGroup')
    td = node(sg, 'TextureDictionary')
    used = set(t for _, t in materials)
    if any(k == 'glass' for k, _ in materials):
        used.add('yx_movia_normal')
    for texture in sorted(used):
        t = node(td, 'Item')
        node(t, 'Name', texture)
        node(t, 'Unk32', value=0)
        node(t, 'Usage', 'NORMAL' if texture.endswith('normal') else 'DIFFUSE')
        node(t, 'UsageFlags', 'NOT_HALF, UNK24')
        node(t, 'ExtraFlags', value=0)
        node(t, 'Width', value=4)
        node(t, 'Height', value=4)
        node(t, 'MipLevels', value=1)
        node(t, 'Format', 'D3DFMT_A8R8G8B8')
        node(t, 'FileName', texture+'.dds')
    shaders = node(sg, 'Shaders')
    for kind, texture in materials:
        shader_xml(shaders, kind, texture)
    models = node(root, 'DrawableModelsHigh')
    model = node(models, 'Item')
    for tag, value in [('RenderMask',255), ('Flags',0), ('HasSkin',0), ('BoneIndex',0), ('Unknown1',0)]:
        node(model, tag, value=value)
    geoms = node(model, 'Geometries')
    for mesh in meshes:
        geom = node(geoms, 'Item')
        node(geom, 'ShaderIndex', value=mesh.shader)
        vec(geom, 'BoundingBoxMin', tuple(min(v[i] for v in mesh.vertices) for i in range(3)))
        vec(geom, 'BoundingBoxMax', tuple(max(v[i] for v in mesh.vertices) for i in range(3)))
        vb = node(geom, 'VertexBuffer')
        node(vb, 'Flags', value=0)
        layout = node(vb, 'Layout', type='GTAV1')
        is_glass = materials[mesh.shader][0] == 'glass'
        tags = ('Position','Normal','Colour0','TexCoord0','Tangent') if is_glass else ('Position','Normal','Colour0','TexCoord0')
        for tag in tags:
            node(layout, tag)
        node(vb, 'Data', '\n'+'\n'.join(' '.join(f'{x:.8g}' for x in (v if is_glass else v[:12])) for v in mesh.vertices)+'\n')
        node(node(geom, 'IndexBuffer'), 'Data', ' '.join(str(i) for i in mesh.indices))
    ET.indent(root)
    ET.ElementTree(root).write(OUT/(name+'.ydr.xml'), encoding='utf-8', xml_declaration=True)
    with (OUT/(name+'.obj')).open('w') as f:
        offset = 1
        for mi, mesh in enumerate(meshes):
            f.write(f'o material_{mi}\n')
            for v in mesh.vertices:
                f.write('v '+' '.join(str(x) for x in v[:3])+'\n')
            for i in range(0, len(mesh.indices), 3):
                f.write('f '+' '.join(str(j+offset) for j in mesh.indices[i:i+3])+'\n')
            offset += len(mesh.vertices)
    return {'name':name, 'min':minimum, 'max':maximum, 'center':center, 'radius':radius,
            'vertices':len(vertices), 'triangles':sum(len(m.indices)//3 for m in meshes)}


rubber, housing, metal, dormant, lens, lit = [Mesh(i) for i in range(5)] + [Mesh(0)]
# 128 mm overall diameter, 142 mm high: one-hand portable scale, origin on roof.
rubber.lathe([(0,.002),(.059,.002),(.064,.005),(.064,.010),(.060,.013),(0,.013)])
housing.lathe([(0,.010),(.060,.010),(.061,.015),(.060,.030),(.058,.033),(0,.033)])
rubber.lathe([(.056,.031),(.060,.031),(.060,.035),(.056,.036)])
# Three rubber-covered magnetic contacts, visible from below.
for i in range(3):
    angle=2*math.pi*i/3
    rubber.lathe([(0,0),(.016,0),(.019,.002),(.019,.004),(0,.004)], segments=24,
                 offset=(.040*math.cos(angle),.040*math.sin(angle),0))
# A thin lens retaining lip, screw heads and interior aluminium carrier.
housing.lathe([(.054,.033),(.058,.034),(.058,.038),(.054,.039)])
housing.lathe([(0,.034),(.033,.034),(.033,.121),(.029,.124),(0,.124)],segments=32)
for i in range(3):
    angle=2*math.pi*i/3+math.pi/6
    metal.radial_disc(angle,.060,.024,.0022,.0006,segments=12)
# Narrow, almost flat-topped polycarbonate cover with actual concentric moulded ribs.
profile=[(.0555,.035),(.057,.039),(.057,.044)]
for i in range(17):
    z=.046+i*.0049
    r=.057-(z-.044)*.050
    profile.extend([(r,z),(r+.00065,z+.001),(r+.00065,z+.0018),(r-.00012,z+.0025)])
profile.extend([(.0526,.129),(.052,.134),(.049,.138),(.043,.1405),(.028,.142),(0,.142)])
lens.lathe(profile)
# Twelve stationary dormant optical modules in two staggered rings.
for row,z in enumerate((.074,.102)):
    for i in range(6):
        angle=2*math.pi*(i+row*.5)/6
        metal.radial_disc(angle,.034,z,.0090,.0075,segments=16)
        dormant.radial_disc(angle,.0415,z,.0068,.0010,segments=16)

# The old small emissive discs sat behind the tinted cover (42.85 mm radius
# versus a 54-57 mm cover), so the visible pulse could be swallowed by the glass.
# The new pulse is the light emerging from the cover, represented by two shallow
# optical bands 0.9 mm outside it. It is a separate hidden/shown drawable; the
# detailed dark beacon body is unchanged. Bands retain the moulded rib profile.
def cover_radius(z):
    for (r0,z0),(r1,z1) in zip(profile,profile[1:]):
        if z0 <= z <= z1 and z1 > z0:
            return r0+(r1-r0)*(z-z0)/(z1-z0)
    raise ValueError(f'No cover section at height {z}')

for z_low,z_high in ((.062,.084),(.092,.114)):
    band=[(cover_radius(z_low)+.0009,z_low)]
    band.extend((r+.0009,z) for r,z in profile if z_low<z<z_high)
    band.append((cover_radius(z_high)+.0009,z_high))
    # Eight almost contiguous optical sectors make the pulse visible from all
    # directions while preserving fine separation between the lens segments.
    for i in range(8):
        angle=2*math.pi*i/8
        lit.lathe(band,segments=8,start=angle+.012,end=angle+math.pi/4-.012)
clearance=min(math.hypot(v[0],v[1])-cover_radius(v[2]) for v in lit.vertices)
assert clearance >= .00089, f'Glow intersects tinted cover: {clearance}'
assert max(math.hypot(v[0],v[1]) for v in lit.vertices) < .064
assert max(v[2] for v in lit.vertices) <= .142

stats = [write_drawable('yx_movia_d_red', [rubber,housing,metal,dormant,lens],
                        [('default','yx_movia_rubber'),('default','yx_movia_housing'),
                         ('default','yx_movia_metal'),('default','yx_movia_led_off'),('glass','yx_movia_red_lens')]),
         write_drawable('yx_movia_d_red_glow', [lit], [('emissive','yx_movia_glow_on')])]
(OUT/'geometry.json').write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
